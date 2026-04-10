package server

import (
	"encoding/json"
	"net/http"
	"strings"
)

func RespondJSON(w http.ResponseWriter, statusCode int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	if payload != nil {
		json.NewEncoder(w).Encode(payload)
	}
}

func RespondHTML(w http.ResponseWriter, statusCode int, payload string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(statusCode)
	w.Write([]byte(payload))
}

func RespondText(w http.ResponseWriter, statusCode int, payload, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(statusCode)
	w.Write([]byte(payload))
}

func Unauthorized(w http.ResponseWriter) {
	RespondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
}

func ParseAdminKey(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimSpace(auth[7:])
	}

	headerKey := strings.TrimSpace(r.Header.Get("X-Admin-Key"))
	return headerKey
}

func ParseCookies(r *http.Request) map[string]string {
	cookies := make(map[string]string)
	raw := strings.TrimSpace(r.Header.Get("Cookie"))
	if raw == "" {
		return cookies
	}

	parts := strings.Split(raw, ";")
	for _, part := range parts {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) > 0 {
			name := strings.TrimSpace(kv[0])
			if name == "" {
				continue
			}
			val := ""
			if len(kv) > 1 {
				val = strings.TrimSpace(kv[1])
			}
			cookies[name] = val
		}
	}
	return cookies
}
