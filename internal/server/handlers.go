package server

import (
	"net/http"
	"os"
	"strconv"
	"strings"

	"new-api-auto-register/internal/storage"
)

var ManagementPageURL = "./management.html"
var ManagementBundleURL = "./public/management.bundle.js"
var ManagementStyleURL = "./public/management.bundle.css"

type Handlers struct {
	StorePath   string
	AdminAPIKey string
	APIPrefix   string
}

func (h *Handlers) buildPath(pathname string) string {
	prefix := h.APIPrefix
	if strings.HasSuffix(prefix, "/") {
		prefix = prefix[:len(prefix)-1]
	}
	return prefix + pathname
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

	RespondJSON(w, http.StatusOK, map[string]interface{}{
		"count":    len(filtered),
		"total":    len(filtered),
		"page":     page,
		"pageSize": pageSize,
		"summary":  buildAccountsSummary(store.Accounts, filtered),
		"accounts": paged,
	})
}

func (h *Handlers) HandleGetRegisterStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandleGetCheckinStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandleGetBalanceStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandlePostRegister(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	var body struct {
		Count int `json:"count"`
	}
	if err := readJSONBody(r, &body); err != nil {
		RespondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON body"})
		return
	}
	RespondJSON(w, http.StatusAccepted, map[string]interface{}{"ok": true, "started": true})
}

func (h *Handlers) HandlePostCheckin(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusAccepted, map[string]interface{}{"ok": true, "started": true})
}

func (h *Handlers) HandlePostBalanceRefresh(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusAccepted, map[string]interface{}{"ok": true, "started": true})
}

func (h *Handlers) HandlePostTokenUpload(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandleGetTokenExport(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondText(w, http.StatusOK, "", "text/plain; charset=utf-8")
}

func (h *Handlers) HandlePostAccountRetry(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandlePostAccountCheckinStatus(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandlePostAccountCheckin(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandlePostAccountBalance(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *Handlers) HandleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if !h.isAdminAuthorized(r) {
		Unauthorized(w)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "message": "Account deleted"})
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
