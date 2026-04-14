package tasks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"new-api-auto-register/internal/storage"
)

var sessionCookieRegexp = regexp.MustCompile(`(?:^|[;,\s])session=([^;\s,]+)`)

type Config struct {
	BaseURL                string
	StorePath              string
	RequestDelayMs         int
	ExtraCookies           string
	DefaultNewAPIUser      string
	CheckinMaxRetries      int
	CheckinRetryDelay      int
	RegisterMaxRetries     int
	RateLimitRetryDelayMs  int
	UsernamePrefix         string
	UsernameMaxLen         int
	PasswordLen            int
	OperationDelayMs       int
	TokenNamePrefix        string
	StaticAccessToken      string
	ManagementURL          string
	ManagementBearer       string
	ManagementExistingKeys string
	TokenTxtPath           string
	TokenCSVPath           string
}

type loginResult struct {
	OK         bool
	Status     int
	Message    string
	Session    string
	NewAPIUser string
}

type apiResult struct {
	OK     bool
	Status int
	Body   map[string]any
}

func LoadConfig() Config {
	return Config{
		BaseURL:                envOr("BASE_URL", "https://open.lxcloud.dev"),
		StorePath:              envOr("STORE_PATH", "./data/store.json"),
		RequestDelayMs:         envInt("QUERY_DELAY_MS", 1000),
		ExtraCookies:           os.Getenv("EXTRA_COOKIES"),
		DefaultNewAPIUser:      os.Getenv("NEW_API_USER"),
		CheckinMaxRetries:      envInt("CHECKIN_MAX_RETRIES", 4),
		CheckinRetryDelay:      envInt("CHECKIN_RETRY_DELAY_MS", 300000),
		RegisterMaxRetries:     envInt("REGISTER_MAX_RETRIES", 4),
		RateLimitRetryDelayMs:  envInt("RATE_LIMIT_RETRY_DELAY_MS", 30000),
		UsernamePrefix:         envOr("USERNAME_PREFIX", "u"),
		UsernameMaxLen:         envInt("USERNAME_MAX_LEN", 12),
		PasswordLen:            envInt("PASSWORD_LEN", 12),
		OperationDelayMs:       envInt("OP_DELAY_MS", 1000),
		TokenNamePrefix:        envOr("TOKEN_NAME_PREFIX", "autotoken"),
		StaticAccessToken:      os.Getenv("ACCESS_TOKEN"),
		ManagementURL:          os.Getenv("MANAGEMENT_OPENAI_COMPAT_URL"),
		ManagementBearer:       os.Getenv("MANAGEMENT_BEARER"),
		ManagementExistingKeys: os.Getenv("MANAGEMENT_EXISTING_TOKENS"),
		TokenTxtPath:           envOr("TOKEN_TXT_PATH", "./tokens.txt"),
		TokenCSVPath:           envOr("TOKEN_CSV_PATH", "./tokens.csv"),
	}
}

func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	var result int
	if _, err := fmt.Sscanf(value, "%d", &result); err != nil {
		return fallback
	}
	return result
}

func parsePossibleUserID(response map[string]any) string {
	data := asMap(response["data"])
	candidates := []any{data["id"], data["user_id"], data["uid"], response["id"], response["user_id"], response["uid"]}
	for _, candidate := range candidates {
		text := strings.TrimSpace(fmt.Sprintf("%v", candidate))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func parseResponseToJSON(raw []byte) map[string]any {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return map[string]any{"raw": string(raw)}
	}
	return body
}

func isAPISuccess(httpOK bool, body map[string]any) bool {
	if !httpOK {
		return false
	}
	if success, ok := body["success"]; ok {
		return boolValue(success)
	}
	return true
}

func extractSessionFromSetCookie(raw string) string {
	match := sessionCookieRegexp.FindStringSubmatch(raw)
	if len(match) < 2 {
		return ""
	}
	return "session=" + match[1]
}

func combineCookies(extraCookies, sessionCookie string) string {
	if sessionCookie != "" && extraCookies != "" {
		return extraCookies + "; " + sessionCookie
	}
	if sessionCookie != "" {
		return sessionCookie
	}
	return extraCookies
}

func commonHeaders(baseURL string) map[string]string {
	return map[string]string{
		"User-Agent":      "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
		"Accept-Encoding": "gzip, deflate, br, zstd",
		"Cache-Control":   "no-store",
		"Connection":      "keep-alive",
		"Origin":          baseURL,
	}
}

func loginAndGetSession(config Config, username, password string) (loginResult, error) {
	url := strings.TrimRight(config.BaseURL, "/") + "/api/user/login?turnstile="
	headers := commonHeaders(config.BaseURL)
	headers["Content-Type"] = "application/json"
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/login"
	if config.DefaultNewAPIUser != "" {
		headers["New-API-User"] = config.DefaultNewAPIUser
	}
	if config.ExtraCookies != "" {
		headers["Cookie"] = config.ExtraCookies
	}

	payload, _ := json.Marshal(map[string]string{"username": username, "password": password})
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return loginResult{}, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return loginResult{}, err
	}
	defer res.Body.Close()
	bodyBytes, _ := io.ReadAll(res.Body)
	body := parseResponseToJSON(bodyBytes)
	ok := isAPISuccess(res.StatusCode >= 200 && res.StatusCode < 300, body)
	if !ok {
		return loginResult{OK: false, Status: res.StatusCode, Message: stringValue(body["message"])}, nil
	}

	session := extractSessionFromSetCookie(res.Header.Get("Set-Cookie"))
	message := "ok"
	if session == "" {
		message = "login success but no session cookie"
	}
	return loginResult{
		OK:         session != "",
		Status:     res.StatusCode,
		Message:    message,
		Session:    session,
		NewAPIUser: firstNonEmpty(parsePossibleUserID(body), config.DefaultNewAPIUser),
	}, nil
}

func fetchSelf(config Config, account storage.Account) (apiResult, error) {
	url := strings.TrimRight(config.BaseURL, "/") + "/api/user/self"
	headers := commonHeaders(config.BaseURL)
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/console/topup"
	if account.NewAPIUser != "" || config.DefaultNewAPIUser != "" {
		headers["New-API-User"] = firstNonEmpty(account.NewAPIUser, config.DefaultNewAPIUser)
	}
	if cookies := combineCookies(config.ExtraCookies, account.Session); cookies != "" {
		headers["Cookie"] = cookies
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
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

func queryCheckinStatus(config Config, account storage.Account, month string) (apiResult, storage.CheckinStatus, error) {
	url := strings.TrimRight(config.BaseURL, "/") + "/api/user/checkin?month=" + month
	headers := commonHeaders(config.BaseURL)
	headers["Referer"] = strings.TrimRight(config.BaseURL, "/") + "/console/personal"
	if account.NewAPIUser != "" || config.DefaultNewAPIUser != "" {
		headers["New-API-User"] = firstNonEmpty(account.NewAPIUser, config.DefaultNewAPIUser)
	}
	if cookies := combineCookies(config.ExtraCookies, account.Session); cookies != "" {
		headers["Cookie"] = cookies
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return apiResult{}, storage.CheckinStatus{}, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return apiResult{}, storage.CheckinStatus{}, err
	}
	defer res.Body.Close()
	bodyBytes, _ := io.ReadAll(res.Body)
	body := parseResponseToJSON(bodyBytes)
	stats := asMap(asMap(body["data"])["stats"])
	status := storage.CheckinStatus{
		Month:          month,
		CheckedInToday: boolValue(stats["checked_in_today"]),
		CheckinCount:   intValue(stats["checkin_count"]),
		TotalCheckins:  intValue(stats["total_checkins"]),
		TotalQuota:     floatValue(stats["total_quota"]),
		UpdatedAt:      storage.Ptr(storage.NowISO()),
		Records:        []storage.CheckinRecord{},
	}
	for _, item := range asSlice(stats["records"]) {
		record := asMap(item)
		status.Records = append(status.Records, storage.CheckinRecord{
			CheckinDate:  stringValue(record["checkin_date"]),
			QuotaAwarded: floatValue(record["quota_awarded"]),
		})
	}

	return apiResult{OK: isAPISuccess(res.StatusCode >= 200 && res.StatusCode < 300, body), Status: res.StatusCode, Body: body}, status, nil
}

func saveAccountPatch(storePath, username string, patch storage.Account) error {
	return storage.UpdateStore(storePath, func(store *storage.Store) error {
		patch.Username = username
		storage.UpsertAccountInStore(store, patch)
		return nil
	})
}

func currentMonth() string {
	return time.Now().UTC().Format("2006-01")
}

func sleep(ms int) {
	if ms <= 0 {
		return
	}
	time.Sleep(time.Duration(ms) * time.Millisecond)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func asMap(value any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func asSlice(value any) []any {
	if value == nil {
		return []any{}
	}
	if items, ok := value.([]any); ok {
		return items
	}
	return []any{}
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	text := fmt.Sprintf("%v", value)
	if text == "<nil>" {
		return ""
	}
	return strings.TrimSpace(text)
}

func boolValue(value any) bool {
	if b, ok := value.(bool); ok {
		return b
	}
	return false
}

func intValue(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		var result int
		if _, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &result); err == nil {
			return result
		}
	}
	return 0
}

func floatValue(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case string:
		var result float64
		if _, err := fmt.Sscanf(strings.TrimSpace(v), "%f", &result); err == nil {
			return result
		}
	}
	return 0
}

func floatPtr(value float64) *float64 {
	return &value
}

func quotaToUSD(quota float64) string {
	if math.IsNaN(quota) || math.IsInf(quota, 0) {
		return "$0.00"
	}
	usd := (quota * 2) / 1_000_000
	return fmt.Sprintf("$%.2f", usd)
}
