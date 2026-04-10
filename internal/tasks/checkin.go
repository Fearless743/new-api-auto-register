package tasks

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"new-api-auto-register/internal/storage"
)

func checkinOnce(config Config, account storage.Account) (apiResult, error) {
	url := strings.TrimRight(config.BaseURL, "/") + "/api/user/checkin"
	headers := commonHeaders(config.BaseURL)
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/console/personal"
	if account.NewAPIUser != "" || config.DefaultNewAPIUser != "" {
		headers["New-API-User"] = firstNonEmpty(account.NewAPIUser, config.DefaultNewAPIUser)
	}
	if cookies := combineCookies(config.ExtraCookies, account.Session); cookies != "" {
		headers["Cookie"] = cookies
	}

	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return apiResult{}, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return apiResult{}, err
	}
	defer res.Body.Close()
	bodyBytes, _ := io.ReadAll(res.Body)
	body := parseResponseToJSON(bodyBytes)
	return apiResult{OK: isAPISuccess(res.StatusCode >= 200 && res.StatusCode < 300, body), Status: res.StatusCode, Body: body}, nil
}

func ensureAccountSession(config Config, storePath string, account *storage.Account) error {
	if account == nil {
		return errors.New("Account not found")
	}
	if account.Password == "" {
		return errors.New("Account password is required")
	}
	if account.Session != "" {
		return nil
	}

	loginResult, err := loginAndGetSession(config, account.Username, account.Password)
	if err != nil {
		return err
	}
	if !loginResult.OK {
		return errors.New("Login failed: " + loginResult.Message)
	}
	account.Session = loginResult.Session
	account.NewAPIUser = firstNonEmpty(loginResult.NewAPIUser, account.NewAPIUser)
	now := storage.NowISO()
	return saveAccountPatch(storePath, account.Username, storage.Account{
		Password:    account.Password,
		NewAPIUser:  account.NewAPIUser,
		Session:     account.Session,
		LastLoginAt: &now,
	})
}

func checkinWithRetry(config Config, storePath string, account *storage.Account) (apiResult, error) {
	for attempt := 1; attempt <= config.CheckinMaxRetries+1; attempt++ {
		result, err := checkinOnce(config, *account)
		if err != nil {
			return apiResult{}, err
		}
		if result.OK {
			return result, nil
		}

		if result.Status == http.StatusUnauthorized {
			account.Session = ""
			if err := ensureAccountSession(config, storePath, account); err != nil {
				return apiResult{OK: false, Status: http.StatusUnauthorized, Body: map[string]any{"message": "relogin failed: " + err.Error(), "success": false}}, nil
			}
			sleep(config.RequestDelayMs)
			continue
		}

		if result.Status == http.StatusTooManyRequests && attempt <= config.CheckinMaxRetries {
			sleep(config.CheckinRetryDelay)
			continue
		}

		return result, nil
	}

	return apiResult{OK: false, Status: http.StatusTooManyRequests, Body: map[string]any{"message": "checkin retry exhausted", "success": false}}, nil
}

func ManualCheckin(storePath, username string) (map[string]any, error) {
	config := LoadConfig()
	config.StorePath = storePath

	store, err := storage.ReadStore(storePath)
	if err != nil {
		return nil, err
	}
	account := storage.FindAccount(&store, username)
	if account == nil {
		return nil, errors.New("Account not found")
	}

	working := *account
	if err := ensureAccountSession(config, storePath, &working); err != nil {
		return nil, err
	}

	result, err := checkinWithRetry(config, storePath, &working)
	if err != nil {
		return nil, err
	}
	if err := persistCheckinResult(storePath, &working, result); err != nil {
		return nil, err
	}
	_, _ = RefreshAccountCheckinStatus(storePath, username, currentMonth())

	return map[string]any{"ok": result.OK, "status": result.Status, "body": result.Body}, nil
}

func RunCheckin(storePath string) error {
	config := LoadConfig()
	config.StorePath = storePath

	store, err := storage.ReadStore(storePath)
	if err != nil {
		return err
	}
	accounts := make([]storage.Account, 0, len(store.Accounts))
	for _, account := range store.Accounts {
		if strings.TrimSpace(account.Username) != "" {
			accounts = append(accounts, account)
		}
	}
	if len(accounts) == 0 {
		return errors.New("未找到可用账号，请先准备 store.json 中的 accounts")
	}

	for i := range accounts {
		working := accounts[i]
		if working.Password == "" {
			continue
		}
		if err := ensureAccountSession(config, storePath, &working); err != nil {
			continue
		}
		result, err := checkinWithRetry(config, storePath, &working)
		if err == nil {
			_ = persistCheckinResult(storePath, &working, result)
		}
		if i < len(accounts)-1 {
			sleep(config.RequestDelayMs)
		}
	}
	return nil
}

func RunCheckinStatusRefresh(storePath, month string) error {
	if month == "" {
		month = currentMonth()
	}
	store, err := storage.ReadStore(storePath)
	if err != nil {
		return err
	}
	accounts := make([]storage.Account, 0, len(store.Accounts))
	for _, account := range store.Accounts {
		if strings.TrimSpace(account.Username) != "" {
			accounts = append(accounts, account)
		}
	}
	if len(accounts) == 0 {
		return errors.New("未找到可用账号，请先准备 store.json 中的 accounts")
	}
	config := LoadConfig()
	for i := range accounts {
		if accounts[i].Password != "" {
			_, _ = RefreshAccountCheckinStatus(storePath, accounts[i].Username, month)
		}
		if i < len(accounts)-1 {
			sleep(config.RequestDelayMs)
		}
	}
	return nil
}

func persistCheckinResult(storePath string, account *storage.Account, result apiResult) error {
	now := storage.NowISO()
	message := strings.ReplaceAll(stringValue(result.Body["message"]), ",", " ")
	data := asMap(result.Body["data"])
	checkinDate := stringValue(data["checkin_date"])
	quotaAwardedValue := floatValue(data["quota_awarded"])
	var quotaAwarded *float64
	if stringValue(data["quota_awarded"]) != "" {
		quotaAwarded = storage.Ptr(quotaAwardedValue)
	}

	return storage.UpdateStore(storePath, func(store *storage.Store) error {
		storage.UpsertAccountInStore(store, storage.Account{
			Username:      account.Username,
			Password:      account.Password,
			NewAPIUser:    account.NewAPIUser,
			Session:       account.Session,
			LastCheckinAt: &now,
			LastCheckin: &storage.LastCheckinResult{
				Status:       result.Status,
				Success:      result.OK,
				Message:      message,
				CheckinDate:  checkinDate,
				QuotaAwarded: quotaAwarded,
				Time:         &now,
			},
		})
		storage.AppendCheckinInStore(store, storage.CheckinEntry{
			Time:         now,
			Username:     account.Username,
			NewAPIUser:   account.NewAPIUser,
			Status:       result.Status,
			Success:      result.OK,
			Message:      message,
			CheckinDate:  checkinDate,
			QuotaAwarded: quotaAwarded,
		})
		return nil
	})
}
