package server

import (
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"

	"new-api-auto-register/internal/storage"
	"new-api-auto-register/internal/tasks"
)

var ManagementPageURL = "./management.html"
var ManagementBundleURL = "./public/management.bundle.js"
var ManagementStyleURL = "./public/management.bundle.css"

type Handlers struct {
	StorePath      string
	AdminAPIKey    string
	APIPrefix      string
	mu             sync.Mutex
	CheckinStatus  RunStatus
	BalanceStatus  RunStatus
	RegisterStatus RegisterRunStatus
}

type RunStatus struct {
	Running    bool
	StartedAt  *string
	FinishedAt *string
	Error      string
}

type RegisterRunStatus struct {
	Running        bool
	RequestedCount int
	StartedAt      *string
	FinishedAt     *string
	Summary        interface{}
	Error          string
}

func (h *Handlers) buildPath(pathname string) string {
	prefix := h.APIPrefix
	if strings.HasSuffix(prefix, "/") {
		prefix = prefix[:len(prefix)-1]
	}
	return prefix + pathname
}

func nowStringPtr() *string {
	now := string(storage.NowISO())
	return &now
}

func (h *Handlers) startCheckinRun() map[string]interface{} {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.CheckinStatus.Running {
		return map[string]interface{}{
			"ok":             true,
			"started":        false,
			"alreadyRunning": true,
			"running":        h.CheckinStatus.Running,
			"startedAt":      h.CheckinStatus.StartedAt,
			"finishedAt":     h.CheckinStatus.FinishedAt,
			"error":          emptyStringToNil(h.CheckinStatus.Error),
		}
	}

	h.CheckinStatus.Running = true
	h.CheckinStatus.StartedAt = nowStringPtr()
	h.CheckinStatus.FinishedAt = nil
	h.CheckinStatus.Error = ""

	go func() {
		err := tasks.RunCheckin(h.StorePath)
		h.mu.Lock()
		h.CheckinStatus.Running = false
		h.CheckinStatus.FinishedAt = nowStringPtr()
		if err != nil {
			h.CheckinStatus.Error = err.Error()
		}
		h.mu.Unlock()
	}()

	return map[string]interface{}{
		"ok":             true,
		"started":        true,
		"alreadyRunning": false,
		"running":        true,
		"startedAt":      h.CheckinStatus.StartedAt,
		"finishedAt":     h.CheckinStatus.FinishedAt,
		"error":          emptyStringToNil(h.CheckinStatus.Error),
	}
}

func (h *Handlers) startBalanceRun() map[string]interface{} {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.BalanceStatus.Running {
		return map[string]interface{}{
			"ok":             true,
			"started":        false,
			"alreadyRunning": true,
			"running":        h.BalanceStatus.Running,
			"startedAt":      h.BalanceStatus.StartedAt,
			"finishedAt":     h.BalanceStatus.FinishedAt,
			"error":          emptyStringToNil(h.BalanceStatus.Error),
		}
	}

	h.BalanceStatus.Running = true
	h.BalanceStatus.StartedAt = nowStringPtr()
	h.BalanceStatus.FinishedAt = nil
	h.BalanceStatus.Error = ""

	go func() {
		err := tasks.RunBalanceRefresh(h.StorePath, "")
		h.mu.Lock()
		h.BalanceStatus.Running = false
		h.BalanceStatus.FinishedAt = nowStringPtr()
		if err != nil {
			h.BalanceStatus.Error = err.Error()
		}
		h.mu.Unlock()
	}()

	return map[string]interface{}{
		"ok":             true,
		"started":        true,
		"alreadyRunning": false,
		"running":        true,
		"startedAt":      h.BalanceStatus.StartedAt,
		"finishedAt":     h.BalanceStatus.FinishedAt,
		"error":          emptyStringToNil(h.BalanceStatus.Error),
	}
}

func (h *Handlers) startRegisterRun(count int, baseUrl string) map[string]interface{} {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.RegisterStatus.Running {
		return map[string]interface{}{
			"ok":             true,
			"started":        false,
			"alreadyRunning": true,
			"running":        h.RegisterStatus.Running,
			"requestedCount": h.RegisterStatus.RequestedCount,
			"startedAt":      h.RegisterStatus.StartedAt,
			"finishedAt":     h.RegisterStatus.FinishedAt,
			"summary":        h.RegisterStatus.Summary,
			"error":          emptyStringToNil(h.RegisterStatus.Error),
		}
	}

	if count < 1 {
		count = 1
	}
	h.RegisterStatus.Running = true
	h.RegisterStatus.RequestedCount = count
	h.RegisterStatus.StartedAt = nowStringPtr()
	h.RegisterStatus.FinishedAt = nil
	h.RegisterStatus.Summary = nil
	h.RegisterStatus.Error = ""

	go func(requestedCount int, customBaseURL string) {
		summary, err := tasks.RunBatchRegister(h.StorePath, requestedCount, customBaseURL)
		h.mu.Lock()
		defer h.mu.Unlock()
		h.RegisterStatus.Running = false
		h.RegisterStatus.FinishedAt = nowStringPtr()
		if err != nil {
			h.RegisterStatus.Error = err.Error()
		}
		h.RegisterStatus.Summary = summary
	}(count, baseUrl)

	return map[string]interface{}{
		"ok":             true,
		"started":        true,
		"alreadyRunning": false,
		"running":        true,
		"requestedCount": h.RegisterStatus.RequestedCount,
		"startedAt":      h.RegisterStatus.StartedAt,
		"finishedAt":     h.RegisterStatus.FinishedAt,
		"summary":        h.RegisterStatus.Summary,
		"error":          emptyStringToNil(h.RegisterStatus.Error),
	}
}

func (h *Handlers) HandleHealthz(w http.ResponseWriter, r *http.Request) {
	RespondJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handlers) HandleGetBalances(w http.ResponseWriter, r *http.Request) {
	store, err := storage.ReadStore(h.StorePath)
	if err != nil {
		RespondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to read store"})
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{
		"updatedAt":        store.BalanceSnapshot.UpdatedAt,
		"totalQuota":       store.BalanceSnapshot.TotalQuota,
		"totalBalance":     store.BalanceSnapshot.TotalBalance,
		"totalUsedQuota":   store.BalanceSnapshot.TotalUsedQuota,
		"totalUsedBalance": store.BalanceSnapshot.TotalUsedBalance,
		"accounts":         store.BalanceSnapshot.Accounts,
	})
}

func (h *Handlers) HandleGetAccounts(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	store, err := storage.ReadStore(h.StorePath)
	if err != nil {
		RespondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to read store"})
		return
	}

	pageStr := r.URL.Query().Get("page")
	pageSizeStr := r.URL.Query().Get("pageSize")
	keyword := r.URL.Query().Get("keyword")
	statusMode := r.URL.Query().Get("statusMode")
	step := r.URL.Query().Get("step")

	page := 1
	if p, err := strconv.Atoi(pageStr); err == nil && p > 0 {
		page = p
	}

	pageSize := 20
	if ps, err := strconv.Atoi(pageSizeStr); err == nil && ps > 0 && ps <= 200 {
		pageSize = ps
	}

	filtered := filterAccounts(store.Accounts, keyword, statusMode, step)

	start := (page - 1) * pageSize
	end := start + pageSize
	if start > len(filtered) {
		start = len(filtered)
	}
	if end > len(filtered) {
		end = len(filtered)
	}
	paged := filtered[start:end]

	serialized := make([]map[string]interface{}, 0, len(paged))
	for _, account := range paged {
		serialized = append(serialized, serializeAccount(account))
	}

	RespondJSON(w, http.StatusOK, map[string]interface{}{
		"count":    len(filtered),
		"total":    len(filtered),
		"page":     page,
		"pageSize": pageSize,
		"summary":  buildAccountsSummary(store.Accounts, filtered),
		"accounts": serialized,
	})
}

func (h *Handlers) HandleGetRegisterStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{
		"ok":             true,
		"running":        h.RegisterStatus.Running,
		"requestedCount": h.RegisterStatus.RequestedCount,
		"startedAt":      h.RegisterStatus.StartedAt,
		"finishedAt":     h.RegisterStatus.FinishedAt,
		"summary":        h.RegisterStatus.Summary,
		"error":          emptyStringToNil(h.RegisterStatus.Error),
	})
}

func (h *Handlers) HandleGetCheckinStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"running":    h.CheckinStatus.Running,
		"startedAt":  h.CheckinStatus.StartedAt,
		"finishedAt": h.CheckinStatus.FinishedAt,
		"error":      emptyStringToNil(h.CheckinStatus.Error),
	})
}

func (h *Handlers) HandleGetBalanceStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"running":    h.BalanceStatus.Running,
		"startedAt":  h.BalanceStatus.StartedAt,
		"finishedAt": h.BalanceStatus.FinishedAt,
		"error":      emptyStringToNil(h.BalanceStatus.Error),
	})
}

func (h *Handlers) HandlePostRegister(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	var body struct {
		Count   int    `json:"count"`
		BaseURL string `json:"baseUrl"`
	}
	if err := readJSONBody(r, &body); err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON body"})
		return
	}
	RespondJSON(w, http.StatusAccepted, h.startRegisterRun(body.Count, body.BaseURL))
}

func (h *Handlers) HandlePostCheckin(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusAccepted, h.startCheckinRun())
}

func (h *Handlers) HandlePostBalanceRefresh(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusAccepted, h.startBalanceRun())
}

func (h *Handlers) HandlePostTokenUpload(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	result, err := tasks.RunTokenUpload(h.StorePath)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "result": result})
}

func (h *Handlers) HandleGetTokenExport(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	store, err := storage.ReadStore(h.StorePath)
	if err != nil {
		RespondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token export failed"})
		return
	}

	tokens := storage.ListUniqueTokens(&store)
	RespondText(w, http.StatusOK, strings.Join(tokens, "\n"), "text/plain; charset=utf-8")
}

func (h *Handlers) HandlePostAccountRetry(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	username := strings.TrimPrefix(r.URL.Path, h.buildPath("/accounts/"))
	username = strings.TrimSuffix(username, "/retry")
	username = strings.TrimSpace(username)
	if username == "" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}

	username, err := url.PathUnescape(username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid username"})
		return
	}

	var body struct {
		Step string `json:"step"`
	}
	if err := readJSONBody(r, &body); err != nil && err.Error() != "EOF" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON body"})
		return
	}

	step := body.Step
	if step == "" {
		step = "login"
	}

	result, err := tasks.RetryAccountWorkflow(h.StorePath, username, step)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "result": result})
}

func (h *Handlers) HandlePostAccountCheckinStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	username := strings.TrimPrefix(r.URL.Path, h.buildPath("/accounts/"))
	username = strings.TrimSuffix(username, "/checkin-status")
	username = strings.TrimSpace(username)
	if username == "" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}

	username, err := url.PathUnescape(username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid username"})
		return
	}

	var body struct {
		Month string `json:"month"`
	}
	if err := readJSONBody(r, &body); err != nil && err.Error() != "EOF" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON body"})
		return
	}

	result, err := tasks.RefreshAccountCheckinStatus(h.StorePath, username, body.Month)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "result": result})
}

func (h *Handlers) HandlePostAccountCheckin(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	username := strings.TrimPrefix(r.URL.Path, h.buildPath("/accounts/"))
	username = strings.TrimSuffix(username, "/checkin")
	username = strings.TrimSpace(username)
	if username == "" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}

	username, err := url.PathUnescape(username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid username"})
		return
	}

	result, err := tasks.ManualCheckin(h.StorePath, username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "result": result})
}

func (h *Handlers) HandlePostAccountBalance(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	username := strings.TrimPrefix(r.URL.Path, h.buildPath("/accounts/"))
	username = strings.TrimSuffix(username, "/balance")
	username = strings.TrimSpace(username)
	if username == "" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}

	username, err := url.PathUnescape(username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid username"})
		return
	}

	account, err := tasks.RefreshAccountBalance(h.StorePath, username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "account": serializeAccount(*account)})
}

func (h *Handlers) HandleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}

	username := strings.TrimPrefix(r.URL.Path, h.buildPath("/accounts/"))
	username = strings.TrimSpace(username)
	if username == "" {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}

	username, err := url.PathUnescape(username)
	if err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid username"})
		return
	}

	err = storage.UpdateStore(h.StorePath, func(store *storage.Store) error {
		accounts := make([]storage.Account, 0, len(store.Accounts))
		for _, account := range store.Accounts {
			if account.Username != username {
				accounts = append(accounts, account)
			}
		}
		store.Accounts = accounts

		balanceAccounts := make([]storage.BalanceAccount, 0, len(store.BalanceSnapshot.Accounts))
		var totalQuota float64
		var totalUsedQuota float64
		for _, account := range store.BalanceSnapshot.Accounts {
			if account.Username == username {
				continue
			}
			balanceAccounts = append(balanceAccounts, account)
			totalQuota += account.Quota
			totalUsedQuota += account.UsedQuota
		}
		store.BalanceSnapshot.Accounts = balanceAccounts
		store.BalanceSnapshot.TotalQuota = totalQuota
		store.BalanceSnapshot.TotalUsedQuota = totalUsedQuota
		store.BalanceSnapshot.TotalBalance = quotaToUSD(totalQuota)
		store.BalanceSnapshot.TotalUsedBalance = quotaToUSD(totalUsedQuota)
		return nil
	})
	if err != nil {
		RespondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Delete failed"})
		return
	}

	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "message": "Account " + username + " deleted"})
}

func (h *Handlers) HandleManagementLogin(w http.ResponseWriter, r *http.Request) {
	if h.AdminAPIKey == "" {
		RespondHTML(w, http.StatusServiceUnavailable, renderManagementLoginPage("ADMIN_API_KEY 尚未配置，管理页不可用。"))
		return
	}

	if r.Method == http.MethodGet {
		RespondHTML(w, http.StatusOK, renderManagementLoginPage(""))
		return
	}

	if err := r.ParseForm(); err != nil {
		RespondHTML(w, http.StatusBadRequest, renderManagementLoginPage("表单解析失败"))
		return
	}

	submittedKey := strings.TrimSpace(r.Form.Get("adminKey"))
	if submittedKey != h.AdminAPIKey {
		RespondHTML(w, http.StatusUnauthorized, renderManagementLoginPage("管理员密钥错误，请重试。"))
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    h.AdminAPIKey,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/management.html", http.StatusFound)
}

func (h *Handlers) HandleManagementLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	http.Redirect(w, r, "/management.html", http.StatusFound)
}

func readJSONBody(r *http.Request, dest interface{}) error {
	defer r.Body.Close()
	return decodeJSON(r.Body, dest)
}

func (h *Handlers) HandleManagementPage(w http.ResponseWriter, r *http.Request) {
	if h.AdminAPIKey == "" {
		RespondHTML(w, http.StatusServiceUnavailable, renderManagementLoginPage("ADMIN_API_KEY 尚未配置，管理页不可用。"))
		return
	}
	if !h.isAdminAuthorized(r) {
		RespondHTML(w, http.StatusUnauthorized, renderManagementLoginPage(""))
		return
	}
	data, err := os.ReadFile(ManagementPageURL)
	if err != nil {
		RespondText(w, http.StatusServiceUnavailable, "management page not found", "text/plain; charset=utf-8")
		return
	}
	RespondHTML(w, http.StatusOK, string(data))
}

func (h *Handlers) HandleManagementBundleJS(w http.ResponseWriter, r *http.Request) {
	if h.AdminAPIKey == "" {
		RespondText(w, http.StatusServiceUnavailable, "ADMIN_API_KEY is not configured", "text/plain; charset=utf-8")
		return
	}
	if !h.isAdminAuthorized(r) {
		RespondText(w, http.StatusUnauthorized, "Unauthorized", "text/plain; charset=utf-8")
		return
	}
	data, err := os.ReadFile(ManagementBundleURL)
	if err != nil {
		RespondText(w, http.StatusServiceUnavailable, "management bundle not built", "text/plain; charset=utf-8")
		return
	}
	RespondText(w, http.StatusOK, string(data), "application/javascript; charset=utf-8")
}

func (h *Handlers) HandleManagementBundleCSS(w http.ResponseWriter, r *http.Request) {
	if h.AdminAPIKey == "" {
		RespondText(w, http.StatusServiceUnavailable, "ADMIN_API_KEY is not configured", "text/plain; charset=utf-8")
		return
	}
	if !h.isAdminAuthorized(r) {
		RespondText(w, http.StatusUnauthorized, "Unauthorized", "text/plain; charset=utf-8")
		return
	}
	data, err := os.ReadFile(ManagementStyleURL)
	if err != nil {
		RespondText(w, http.StatusServiceUnavailable, "management stylesheet not built", "text/plain; charset=utf-8")
		return
	}
	RespondText(w, http.StatusOK, string(data), "text/css; charset=utf-8")
}
