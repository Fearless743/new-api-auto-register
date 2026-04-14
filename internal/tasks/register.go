package tasks

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"new-api-auto-register/internal/storage"
)

type registerResult struct {
	OK            bool
	HTTPStatus    int
	Attempt       int
	Username      string
	Password      string
	RequestURL    string
	Response      map[string]any
	SessionCookie string
	NewAPIUser    string
	AccessToken   string
	TokenName     string
	TokenID       string
	TokenValue    string
}

func RunBatchRegister(storePath string, count int) (map[string]any, error) {
	config := LoadConfig()
	config.StorePath = storePath
	if count < 1 {
		count = 1
	}

	if err := storage.UpdateStore(storePath, func(store *storage.Store) error {
		storage.SetBaseURLInStore(store, config.BaseURL)
		return nil
	}); err != nil {
		return nil, err
	}

	registerSuccess := 0
	registerFailed := 0
	loginSuccess := 0
	loginFailed := 0
	tokenCreateSuccess := 0
	tokenCreateFailed := 0
	tokenListSuccess := 0
	tokenListFailed := 0

	for i := 0; i < count; i++ {
		username, password := generateCredential(config, i+1)
		log.Printf("[register] [%d/%d] registering %s password=%s", i+1, count, username, password)
		regResult := registerWithCredential(config, username, password)
		log.Printf("[register] [%d/%d] register result: ok=%v status=%d response=%v", i+1, count, regResult.OK, regResult.HTTPStatus, regResult.Response)
		_ = saveWorkflowStep(storePath, username, password, "register", regResult, storage.Account{BaseURL: config.BaseURL})
		if !regResult.OK {
			registerFailed++
			log.Printf("[register] [%d/%d] FAILED %s (status=%d)", i+1, count, username, regResult.HTTPStatus)
			if i < count-1 {
				sleep(config.RequestDelayMs)
			}
			continue
		}
		registerSuccess++
		log.Printf("[register] [%d/%d] SUCCESS %s", i+1, count, username)

		if config.OperationDelayMs > 0 {
			sleep(config.OperationDelayMs)
		}

		log.Printf("[register] [%d/%d] logging in %s", i+1, count, username)
		loginResult := loginOne(config, username, password)
		_ = saveWorkflowStep(storePath, username, password, "login", loginResult, storage.Account{
			Session:     loginResult.SessionCookie,
			NewAPIUser:  loginResult.NewAPIUser,
			LastLoginAt: timePtrIf(loginResult.OK),
		})
		if !loginResult.OK {
			loginFailed++
			log.Printf("[register] [%d/%d] login FAILED %s (status=%d)", i+1, count, username, loginResult.HTTPStatus)
			if i < count-1 {
				sleep(config.RequestDelayMs)
			}
			continue
		}
		loginSuccess++
		log.Printf("[register] [%d/%d] login SUCCESS %s", i+1, count, username)

		if config.OperationDelayMs > 0 {
			sleep(config.OperationDelayMs)
		}

		log.Printf("[register] [%d/%d] creating token for %s", i+1, count, username)
		tokenCreateResult := createTokenOne(config, loginResult)
		_ = saveWorkflowStep(storePath, username, password, "tokenCreate", tokenCreateResult, storage.Account{})
		if !tokenCreateResult.OK {
			tokenCreateFailed++
			log.Printf("[register] [%d/%d] token create FAILED %s (status=%d)", i+1, count, username, tokenCreateResult.HTTPStatus)
			if i < count-1 {
				sleep(config.RequestDelayMs)
			}
			continue
		}
		tokenCreateSuccess++
		log.Printf("[register] [%d/%d] token create SUCCESS %s", i+1, count, username)

		if config.OperationDelayMs > 0 {
			sleep(config.OperationDelayMs)
		}

		log.Printf("[register] [%d/%d] fetching token for %s", i+1, count, username)
		tokenListResult, finalToken := finalizeTokenValue(config, loginResult, tokenCreateResult, "")
		_ = saveWorkflowStep(storePath, username, password, "tokenList", tokenListResult, storage.Account{
			Token:      finalToken,
			Session:    loginResult.SessionCookie,
			NewAPIUser: loginResult.NewAPIUser,
		})
		if !tokenListResult.OK {
			tokenListFailed++
			log.Printf("[register] [%d/%d] token list FAILED %s (status=%d)", i+1, count, username, tokenListResult.HTTPStatus)
			if i < count-1 {
				sleep(config.RequestDelayMs)
			}
			continue
		}
		tokenListSuccess++
		log.Printf("[register] [%d/%d] token list SUCCESS %s", i+1, count, username)

		if i < count-1 {
			sleep(config.RequestDelayMs)
		}
	}

	log.Printf("完成：注册 成功%d/失败%d，登录 成功%d/失败%d，创建令牌 成功%d/失败%d，查询令牌 成功%d/失败%d",
		registerSuccess, registerFailed, loginSuccess, loginFailed, tokenCreateSuccess, tokenCreateFailed, tokenListSuccess, tokenListFailed)

	return map[string]any{
		"requestedCount": count,
		"register":       map[string]int{"success": registerSuccess, "failed": registerFailed},
		"login":          map[string]int{"success": loginSuccess, "failed": loginFailed},
		"tokenCreate":    map[string]int{"success": tokenCreateSuccess, "failed": tokenCreateFailed},
		"tokenList":      map[string]int{"success": tokenListSuccess, "failed": tokenListFailed},
	}, nil
}

func RetryAccountWorkflow(storePath, username, step string) (map[string]any, error) {
	allowed := map[string]bool{"register": true, "login": true, "tokenCreate": true, "tokenList": true, "tokenRefresh": true}
	if !allowed[step] {
		return nil, errors.New("Invalid workflow step")
	}

	store, err := storage.ReadStore(storePath)
	if err != nil {
		return nil, err
	}
	account := storage.FindAccount(&store, username)
	if account == nil {
		return nil, errors.New("Account not found")
	}
	if strings.TrimSpace(account.Password) == "" {
		return nil, errors.New("Account username and password are required")
	}

	config := LoadConfig()
	config.StorePath = storePath
	current := *account

	if step == "register" {
		regResult := registerWithCredential(config, current.Username, current.Password)
		_ = saveWorkflowStep(storePath, current.Username, current.Password, "register", regResult, storage.Account{})
		if !regResult.OK {
			return map[string]any{"username": current.Username, "step": step, "result": buildRetryResult(regResult)}, nil
		}
	}

	var loginResult registerResult
	if step == "login" || step == "tokenCreate" || step == "tokenList" || step == "tokenRefresh" {
		loginResult = loginOne(config, current.Username, current.Password)
		_ = saveWorkflowStep(storePath, current.Username, current.Password, "login", loginResult, storage.Account{
			Session:     firstNonEmpty(loginResult.SessionCookie, current.Session),
			NewAPIUser:  firstNonEmpty(loginResult.NewAPIUser, current.NewAPIUser),
			LastLoginAt: timePtrIf(loginResult.OK),
		})
		if !loginResult.OK {
			return map[string]any{"username": current.Username, "step": "login", "result": buildRetryResult(loginResult)}, nil
		}
	}

	if step == "tokenCreate" || step == "tokenList" {
		tokenCreateResult := createTokenOne(config, loginResult)
		_ = saveWorkflowStep(storePath, current.Username, current.Password, "tokenCreate", tokenCreateResult, storage.Account{})
		if !tokenCreateResult.OK {
			return map[string]any{"username": current.Username, "step": "tokenCreate", "result": buildRetryResult(tokenCreateResult)}, nil
		}

		tokenListResult, finalToken := finalizeTokenValue(config, loginResult, tokenCreateResult, current.Token)
		_ = saveWorkflowStep(storePath, current.Username, current.Password, "tokenList", tokenListResult, storage.Account{
			Token:      firstNonEmpty(finalToken, current.Token),
			Session:    firstNonEmpty(loginResult.SessionCookie, current.Session),
			NewAPIUser: firstNonEmpty(loginResult.NewAPIUser, current.NewAPIUser),
		})
		if !tokenListResult.OK {
			return map[string]any{"username": current.Username, "step": "tokenList", "result": buildRetryResult(tokenListResult)}, nil
		}
	}

	if step == "tokenRefresh" {
		refreshResult, finalToken := refreshTokenForAccount(config, loginResult, current)
		_ = saveWorkflowStep(storePath, current.Username, current.Password, "tokenRefresh", refreshResult, storage.Account{
			Token:      firstNonEmpty(finalToken, current.Token),
			Session:    firstNonEmpty(loginResult.SessionCookie, current.Session),
			NewAPIUser: firstNonEmpty(loginResult.NewAPIUser, current.NewAPIUser),
		})
		if !refreshResult.OK {
			return map[string]any{"username": current.Username, "step": "tokenRefresh", "result": buildRetryResult(refreshResult)}, nil
		}
	}

	return map[string]any{"username": current.Username, "step": step, "ok": true}, nil
}

func saveWorkflowStep(storePath, username, password, step string, result registerResult, extraPatch storage.Account) error {
	workflowStep := workflowStateFromResult(result, "")
	return storage.UpdateStore(storePath, func(store *storage.Store) error {
		existing := storage.FindAccount(store, username)
		patch := extraPatch
		patch.Username = username
		if password != "" {
			patch.Password = password
		}
		workflow := storage.Workflow{}
		if existing != nil {
			workflow = existing.Workflow
		}
		switch step {
		case "register":
			workflow.Register = workflowStep
		case "login":
			workflow.Login = workflowStep
		case "tokenCreate":
			workflow.TokenCreate = workflowStep
		case "tokenList":
			workflow.TokenList = workflowStep
		case "tokenRefresh":
			workflow.TokenRefresh = workflowStep
		}
		patch.Workflow = workflow
		storage.UpsertAccountInStore(store, patch)
		return nil
	})
}

func workflowStateFromResult(result registerResult, fallbackMessage string) storage.WorkflowStep {
	status := "failed"
	if result.OK {
		status = "success"
	}
	message := strings.TrimSpace(firstNonEmpty(stringValue(result.Response["message"]), stringValue(result.Response["error"]), stringValue(result.Response["raw"]), fallbackMessage))
	now := storage.NowISO()
	return storage.WorkflowStep{
		Status:     status,
		LastRunAt:  &now,
		HTTPStatus: storage.Ptr(result.HTTPStatus),
		Message:    message,
		RequestURL: result.RequestURL,
		Attempt:    storage.Ptr(result.Attempt),
	}
}

func generateCredential(config Config, index int) (string, string) {
	maxLen := config.UsernameMaxLen
	if maxLen < 3 {
		maxLen = 3
	}
	prefix := sanitizeAlphaNum(strings.ToLower(config.UsernamePrefix))
	if prefix == "" {
		prefix = "u"
	}
	if len(prefix) > maxLen-1 {
		prefix = prefix[:maxLen-1]
	}
	bodyLen := maxLen - len(prefix)
	if bodyLen < 1 {
		bodyLen = 1
	}
	timeHint := strings.ToLower(fmt.Sprintf("%x", time.Now().UnixNano()+int64(index)))
	if len(timeHint) > 3 {
		timeHint = timeHint[len(timeHint)-3:]
	}
	randomCoreLen := bodyLen - len(timeHint)
	if randomCoreLen < 1 {
		randomCoreLen = 1
	}
	username := prefix + randomAlnum(randomCoreLen) + timeHint
	if len(username) > maxLen {
		username = username[:maxLen]
	}
	passwordLen := config.PasswordLen
	if passwordLen < 8 {
		passwordLen = 8
	}
	password := "P@" + randomHex(passwordLen)
	if len(password) > passwordLen+2 {
		password = password[:passwordLen+2]
	}
	return username, password
}

func registerWithCredential(config Config, username, password string) registerResult {
	payload := map[string]string{
		"username":                 username,
		"password":                 password,
		"password2":                password,
		"email":                    "",
		"verification_code":        "",
		"wechat_verification_code": "",
		"aff_code":                 "",
	}
	requestURL := strings.TrimRight(config.BaseURL, "/") + "/api/user/register?turnstile="
	headers := commonHeaders(config.BaseURL)
	headers["Content-Type"] = "application/json"
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/register"
	if config.DefaultNewAPIUser != "" {
		headers["New-API-User"] = config.DefaultNewAPIUser
	}
	if config.ExtraCookies != "" {
		headers["Cookie"] = config.ExtraCookies
	}

	body, _ := json.Marshal(payload)
	for attempt := 1; attempt <= config.RegisterMaxRetries+1; attempt++ {
		result := doJSONRequest(http.MethodPost, requestURL, headers, body)
		result.Username = username
		result.Password = password
		result.Attempt = attempt
		if result.HTTPStatus == http.StatusTooManyRequests && attempt <= config.RegisterMaxRetries {
			sleep(config.RateLimitRetryDelayMs)
			continue
		}
		return result
	}
	return registerResult{OK: false, HTTPStatus: -1, Attempt: config.RegisterMaxRetries + 1, Username: username, Password: password, RequestURL: requestURL, Response: map[string]any{"error": "register attempts exhausted"}}
}

func loginOne(config Config, username, password string) registerResult {
	requestURL := strings.TrimRight(config.BaseURL, "/") + "/api/user/login?turnstile="
	headers := commonHeaders(config.BaseURL)
	headers["Content-Type"] = "application/json"
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/login"
	if config.DefaultNewAPIUser != "" {
		headers["New-API-User"] = config.DefaultNewAPIUser
	}
	if config.ExtraCookies != "" {
		headers["Cookie"] = config.ExtraCookies
	}
	body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	result := doJSONRequest(http.MethodPost, requestURL, headers, body)
	result.Username = username
	result.Password = password
	result.NewAPIUser = firstNonEmpty(parsePossibleUserID(result.Response), config.DefaultNewAPIUser)
	result.AccessToken = firstNonEmpty(parsePossibleAccessToken(result.Response), config.StaticAccessToken)
	return result
}

func createTokenOne(config Config, loginResult registerResult) registerResult {
	requestURL := strings.TrimRight(config.BaseURL, "/") + "/api/token/"
	tokenName := buildTokenName(config, loginResult.Username)
	body, _ := json.Marshal(map[string]any{
		"remain_quota":         0,
		"expired_time":         -1,
		"unlimited_quota":      true,
		"model_limits_enabled": false,
		"model_limits":         "",
		"cross_group_retry":    false,
		"name":                 tokenName,
		"group":                "",
		"allow_ips":            "",
	})
	headers := tokenAPIHeaders(config, loginResult, true)
	result := doJSONRequest(http.MethodPost, requestURL, headers, body)
	result.Username = loginResult.Username
	result.TokenName = tokenName
	result.TokenID = extractTokenID(result.Response)
	result.TokenValue = extractTokenValue(result.Response)
	return result
}

func createTokenByIDOne(config Config, loginResult registerResult, tokenID string) registerResult {
	requestURL := strings.TrimRight(config.BaseURL, "/") + "/api/token/" + tokenID + "/key"
	headers := tokenAPIHeaders(config, loginResult, false)
	result := doJSONRequest(http.MethodPost, requestURL, headers, nil)
	result.Username = loginResult.Username
	result.TokenValue = extractTokenValue(result.Response)
	return result
}

func listTokensOne(config Config, loginResult registerResult) registerResult {
	requestURL := strings.TrimRight(config.BaseURL, "/") + "/api/token/?p=1&size=10"
	headers := tokenAPIHeaders(config, loginResult, false)
	result := doJSONRequest(http.MethodGet, requestURL, headers, nil)
	result.Username = loginResult.Username
	return result
}

func extractTokenFromList(response map[string]any, tokenName string) string {
	items := asSlice(asMap(response["data"])["items"])
	var target map[string]any
	for _, item := range items {
		entry := asMap(item)
		if tokenName != "" && stringValue(entry["name"]) == tokenName {
			target = entry
			break
		}
	}
	if len(target) == 0 && len(items) > 0 {
		target = asMap(items[0])
	}
	return stringValue(target["key"])
}

func refreshTokenForAccount(config Config, loginResult registerResult, account storage.Account) (registerResult, string) {
	tokenListResult := listTokensOne(config, loginResult)
	if !tokenListResult.OK {
		return tokenListResult, ""
	}
	items := asSlice(asMap(tokenListResult.Response["data"])["items"])
	targetName := buildTokenName(config, account.Username)
	var target map[string]any
	for _, item := range items {
		entry := asMap(item)
		if stringValue(entry["name"]) == targetName {
			target = entry
			break
		}
	}
	if len(target) == 0 && len(items) > 0 {
		target = asMap(items[0])
	}
	finalToken := ""
	tokenID := stringValue(target["id"])
	if tokenID != "" {
		keyResult := createTokenByIDOne(config, loginResult, tokenID)
		if keyResult.OK && keyResult.TokenValue != "" {
			finalToken = normalizeToken(keyResult.TokenValue)
		}
	}
	if finalToken == "" {
		finalToken = normalizeToken(stringValue(target["key"]))
	}
	return registerResult{OK: true, HTTPStatus: http.StatusOK, RequestURL: tokenListResult.RequestURL, Response: map[string]any{"message": "Token refreshed successfully"}}, finalToken
}

func finalizeTokenValue(config Config, loginResult, tokenCreateResult registerResult, fallbackToken string) (registerResult, string) {
	finalToken := ""
	if tokenCreateResult.OK && tokenCreateResult.TokenID != "" {
		keyResult := createTokenByIDOne(config, loginResult, tokenCreateResult.TokenID)
		if keyResult.OK && keyResult.TokenValue != "" {
			finalToken = normalizeToken(keyResult.TokenValue)
		}
	}

	tokenListResult := registerResult{OK: true, HTTPStatus: http.StatusOK, RequestURL: strings.TrimRight(config.BaseURL, "/") + "/api/token/?p=1&size=10", Response: map[string]any{"message": "ok"}}
	if finalToken == "" || strings.Contains(finalToken, "***") {
		tokenListResult = listTokensOne(config, loginResult)
		if tokenListResult.OK {
			potentialToken := firstNonEmpty(tokenCreateResult.TokenValue, extractTokenFromList(tokenListResult.Response, tokenCreateResult.TokenName))
			if strings.Contains(potentialToken, "***") && tokenCreateResult.TokenID != "" {
				keyResult := createTokenByIDOne(config, loginResult, tokenCreateResult.TokenID)
				if keyResult.OK && keyResult.TokenValue != "" {
					finalToken = normalizeToken(keyResult.TokenValue)
				} else {
					finalToken = firstNonEmpty(fallbackToken, normalizeToken(potentialToken))
				}
			} else {
				finalToken = firstNonEmpty(normalizeToken(potentialToken), fallbackToken)
			}
		}
	}
	return tokenListResult, finalToken
}

func buildRetryResult(result registerResult) map[string]any {
	return map[string]any{
		"ok":         result.OK,
		"status":     result.HTTPStatus,
		"requestUrl": result.RequestURL,
		"response":   result.Response,
	}
}

func doJSONRequest(method, requestURL string, headers map[string]string, body []byte) registerResult {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, requestURL, reader)
	if err != nil {
		return registerResult{OK: false, HTTPStatus: -1, RequestURL: requestURL, Response: map[string]any{"error": err.Error()}}
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return registerResult{OK: false, HTTPStatus: -1, RequestURL: requestURL, Response: map[string]any{"error": err.Error()}}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	parsed := parseResponseToJSON(raw)
	sessionCookie := extractSessionFromSetCookie(res.Header.Get("Set-Cookie"))
	return registerResult{
		OK:            isAPISuccess(res.StatusCode >= 200 && res.StatusCode < 300, parsed),
		HTTPStatus:    res.StatusCode,
		RequestURL:    requestURL,
		Response:      parsed,
		SessionCookie: sessionCookie,
	}
}

func tokenAPIHeaders(config Config, loginResult registerResult, includeBody bool) map[string]string {
	headers := commonHeaders(config.BaseURL)
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/console/token"
	if includeBody {
		headers["Content-Type"] = "application/json"
	}
	if userID := firstNonEmpty(loginResult.NewAPIUser, config.DefaultNewAPIUser); userID != "" {
		headers["New-API-User"] = userID
	}
	if cookies := combineCookies(config.ExtraCookies, loginResult.SessionCookie); cookies != "" {
		headers["Cookie"] = cookies
	}
	if loginResult.AccessToken != "" {
		headers["Authorization"] = "Bearer " + loginResult.AccessToken
	}
	return headers
}

func buildTokenName(config Config, username string) string {
	return strings.TrimSpace(config.TokenNamePrefix) + "-" + strings.TrimSpace(username)
}

func extractTokenValue(response map[string]any) string {
	data := asMap(response["data"])
	for _, candidate := range []any{data["key"], data["token"], data["value"], response["key"], response["token"], response["value"]} {
		text := stringValue(candidate)
		if text != "" {
			return text
		}
	}
	return ""
}

func extractTokenID(response map[string]any) string {
	data := asMap(response["data"])
	for _, candidate := range []any{data["id"], data["token_id"], response["id"], response["token_id"]} {
		text := stringValue(candidate)
		if text != "" {
			return text
		}
	}
	return ""
}

func parsePossibleAccessToken(response map[string]any) string {
	data := asMap(response["data"])
	for _, candidate := range []any{data["access_token"], data["accessToken"], data["token"], response["access_token"], response["accessToken"], response["token"]} {
		text := stringValue(candidate)
		if text != "" {
			return text
		}
	}
	return ""
}

func normalizeToken(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "sk-") {
		return value
	}
	return "sk-" + value
}

func randomHex(length int) string {
	if length < 1 {
		length = 1
	}
	b := make([]byte, (length+1)/2)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)[:length]
}

func randomAlnum(length int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	if length < 1 {
		length = 1
	}
	b := make([]byte, length)
	_, _ = rand.Read(b)
	out := make([]byte, length)
	for i := range b {
		out[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(out)
}

func sanitizeAlphaNum(input string) string {
	var builder strings.Builder
	for _, ch := range input {
		if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') {
			builder.WriteRune(ch)
		}
	}
	return builder.String()
}

func timePtrIf(ok bool) *storage.ISOTime {
	if !ok {
		return nil
	}
	now := storage.NowISO()
	return &now
}
