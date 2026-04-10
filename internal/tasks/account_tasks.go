package tasks

import (
	"errors"

	"new-api-auto-register/internal/storage"
)

func RefreshAccountBalance(storePath, username string) (*storage.Account, error) {
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
	if account.Password == "" {
		return nil, errors.New("Account password is required")
	}

	working := *account
	if working.NewAPIUser == "" {
		loginForUserID, err := loginAndGetSession(config, working.Username, working.Password)
		if err != nil {
			return nil, err
		}
		if loginForUserID.OK && loginForUserID.NewAPIUser != "" {
			working.NewAPIUser = loginForUserID.NewAPIUser
			if loginForUserID.Session != "" {
				working.Session = loginForUserID.Session
			}
			now := storage.NowISO()
			err = saveAccountPatch(storePath, working.Username, storage.Account{
				Password:    working.Password,
				NewAPIUser:  working.NewAPIUser,
				Session:     working.Session,
				LastLoginAt: &now,
			})
			if err != nil {
				return nil, err
			}
			sleep(config.RequestDelayMs)
		}
	}

	if working.Session == "" {
		loginResult, err := loginAndGetSession(config, working.Username, working.Password)
		if err != nil {
			return nil, err
		}
		if !loginResult.OK {
			return nil, errors.New("Login failed: " + loginResult.Message)
		}
		working.Session = loginResult.Session
		working.NewAPIUser = firstNonEmpty(loginResult.NewAPIUser, working.NewAPIUser)
		now := storage.NowISO()
		err = saveAccountPatch(storePath, working.Username, storage.Account{
			Password:    working.Password,
			NewAPIUser:  working.NewAPIUser,
			Session:     working.Session,
			LastLoginAt: &now,
		})
		if err != nil {
			return nil, err
		}
	}

	selfResult, err := fetchSelf(config, working)
	if err != nil {
		return nil, err
	}
	if !selfResult.OK && selfResult.Status == 401 {
		relogin, err := loginAndGetSession(config, working.Username, working.Password)
		if err != nil {
			return nil, err
		}
		if relogin.OK {
			working.Session = relogin.Session
			working.NewAPIUser = firstNonEmpty(relogin.NewAPIUser, working.NewAPIUser)
			now := storage.NowISO()
			err = saveAccountPatch(storePath, working.Username, storage.Account{
				Password:    working.Password,
				NewAPIUser:  working.NewAPIUser,
				Session:     working.Session,
				LastLoginAt: &now,
			})
			if err != nil {
				return nil, err
			}
			sleep(config.RequestDelayMs)
			selfResult, err = fetchSelf(config, working)
			if err != nil {
				return nil, err
			}
		}
	}

	now := storage.NowISO()
	quota := 0.0
	usedQuota := 0.0
	balance := "$0.00"
	usedBalance := "$0.00"
	if selfResult.OK {
		data := asMap(selfResult.Body["data"])
		quota = floatValue(data["quota"])
		usedQuota = floatValue(data["used_quota"])
		balance = quotaToUSD(quota)
		usedBalance = quotaToUSD(usedQuota)
	}

	err = storage.UpdateStore(storePath, func(store *storage.Store) error {
		storage.UpsertAccountInStore(store, storage.Account{
			Username:          working.Username,
			Password:          working.Password,
			NewAPIUser:        working.NewAPIUser,
			Session:           working.Session,
			LastBalanceAt:     &now,
			LastBalanceQuota:  storage.Ptr(quota),
			LastBalance:       storage.Ptr(balance),
			LastUsedQuota:     storage.Ptr(usedQuota),
			LastUsedBalance:   storage.Ptr(usedBalance),
			LastBalanceStatus: storage.Ptr(selfResult.Status),
		})

		snapshotAccounts := make([]storage.BalanceAccount, 0, len(store.BalanceSnapshot.Accounts))
		var totalQuota float64
		var totalUsedQuota float64
		for _, item := range store.BalanceSnapshot.Accounts {
			if item.Username == working.Username {
				continue
			}
			snapshotAccounts = append(snapshotAccounts, item)
			totalQuota += item.Quota
			totalUsedQuota += item.UsedQuota
		}
		snapshotAccount := storage.BalanceAccount{
			Username:    working.Username,
			Quota:       quota,
			Balance:     balance,
			UsedQuota:   usedQuota,
			UsedBalance: usedBalance,
			UpdatedAt:   &now,
			Status:      storage.Ptr(selfResult.Status),
			NewAPIUser:  working.NewAPIUser,
		}
		snapshotAccounts = append(snapshotAccounts, snapshotAccount)
		totalQuota += quota
		totalUsedQuota += usedQuota
		storage.SetBalanceSnapshotInStore(store, storage.BalanceSnapshot{
			UpdatedAt:        &now,
			TotalQuota:       totalQuota,
			TotalBalance:     quotaToUSD(totalQuota),
			TotalUsedQuota:   totalUsedQuota,
			TotalUsedBalance: quotaToUSD(totalUsedQuota),
			Accounts:         snapshotAccounts,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	updatedStore, err := storage.ReadStore(storePath)
	if err != nil {
		return nil, err
	}
	return storage.FindAccount(&updatedStore, username), nil
}

func RefreshAccountCheckinStatus(storePath, username, month string) (map[string]any, error) {
	config := LoadConfig()
	config.StorePath = storePath
	if month == "" {
		month = currentMonth()
	}

	store, err := storage.ReadStore(storePath)
	if err != nil {
		return nil, err
	}
	account := storage.FindAccount(&store, username)
	if account == nil {
		return nil, errors.New("Account not found")
	}
	if account.Password == "" {
		return nil, errors.New("Account password is required")
	}

	working := *account
	if working.Session == "" {
		loginResult, err := loginAndGetSession(config, working.Username, working.Password)
		if err != nil {
			return nil, err
		}
		if !loginResult.OK {
			return nil, errors.New("Login failed: " + loginResult.Message)
		}
		working.Session = loginResult.Session
		working.NewAPIUser = firstNonEmpty(loginResult.NewAPIUser, working.NewAPIUser)
		now := storage.NowISO()
		err = saveAccountPatch(storePath, working.Username, storage.Account{
			Password:    working.Password,
			NewAPIUser:  working.NewAPIUser,
			Session:     working.Session,
			LastLoginAt: &now,
		})
		if err != nil {
			return nil, err
		}
	}

	result, checkinStatus, err := queryCheckinStatus(config, working, month)
	if err != nil {
		return nil, err
	}
	err = saveAccountPatch(storePath, working.Username, storage.Account{
		Password:      working.Password,
		NewAPIUser:    working.NewAPIUser,
		Session:       working.Session,
		CheckinStatus: checkinStatus,
	})
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"ok":            result.OK,
		"status":        result.Status,
		"body":          result.Body,
		"checkinStatus": checkinStatus,
	}, nil
}
