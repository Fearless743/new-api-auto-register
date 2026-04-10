package server

import (
	"log"
	"net/http"
	"time"
)

// Config represents the application configuration
type Config struct {
	StorePath         string
	APIPort           int
	AdminAPIKey       string
	BalanceCronExpr   string
	BalanceCronTz     string
	CheckinCronExpr   string
	CheckinCronTz     string
	RunCheckinOnStart bool
	RunBalanceOnStart bool
}

func LoggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
	}
}

func (h *Handlers) RequireAdminKey(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.AdminAPIKey == "" {
			RespondJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ADMIN_API_KEY is not configured"})
			return
		}

		if !h.isAdminAuthorized(r) {
			Unauthorized(w)
			return
		}

		next.ServeHTTP(w, r)
	}
}

func (h *Handlers) isAdminAuthorized(r *http.Request) bool {
	if h.AdminAPIKey == "" {
		return false
	}

	if ParseAdminKey(r) == h.AdminAPIKey {
		return true
	}

	cookies := ParseCookies(r)
	return cookies["admin_session"] == h.AdminAPIKey
}
