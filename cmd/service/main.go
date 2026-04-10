package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/robfig/cron/v3"
	"new-api-auto-register/internal/server"
	"new-api-auto-register/internal/storage"
)

func main() {
	// Load .env file if exists
	_ = godotenv.Load()

	// Configuration from environment
	storePath := getEnv("STORE_PATH", "./data/store.json")
	apiPort := getEnvInt("API_PORT", 3000)
	adminAPIKey := getEnv("ADMIN_API_KEY", "")
	balanceCronExpr := getEnv("BALANCE_REFRESH_CRON_EXPR", "*/10 * * * *")
	balanceCronTz := getEnv("BALANCE_REFRESH_CRON_TZ", getEnv("CHECKIN_CRON_TZ", "Asia/Shanghai"))
	checkinCronExpr := getEnv("CHECKIN_CRON_EXPR", "0 0 * * *")
	checkinCronTz := getEnv("CHECKIN_CRON_TZ", "Asia/Shanghai")
	runBalanceOnStart := getEnv("BALANCE_REFRESH_RUN_ON_START", "true") == "true"

	// Ensure store file exists
	if err := storage.EnsureStoreFile(storePath); err != nil {
		log.Fatalf("Failed to ensure store file: %v", err)
	}

	// Initialize handlers
	handlers := &server.Handlers{
		StorePath:   storePath,
		AdminAPIKey: adminAPIKey,
		APIPrefix:   "/api",
	}

	// Initialize router with Go 1.22+ pattern
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("/healthz", handlers.HandleHealthz)

	// Public API endpoints
	mux.HandleFunc("/api/balances", handlers.HandleGetBalances)

	// Admin API endpoints (wrapped with admin check)
	mux.HandleFunc("/api/accounts", handlers.HandleGetAccounts)
	mux.HandleFunc("/api/registers/status", handlers.HandleGetRegisterStatus)
	mux.HandleFunc("/api/checkins/status", handlers.HandleGetCheckinStatus)
	mux.HandleFunc("/api/status", handlers.HandleGetBalanceStatus)
	mux.HandleFunc("/api/balances/status", handlers.HandleGetBalanceStatus)

	// POST endpoints
	mux.HandleFunc("/api/registers", handlers.HandlePostRegister)
	mux.HandleFunc("/api/checkins", handlers.HandlePostCheckin)
	mux.HandleFunc("/api/status/refresh", handlers.HandlePostBalanceRefresh)
	mux.HandleFunc("/api/balances/refresh", handlers.HandlePostBalanceRefresh)
	mux.HandleFunc("/api/tokens/upload", handlers.HandlePostTokenUpload)
	mux.HandleFunc("/api/tokens/export", handlers.HandleGetTokenExport)

	// Account-level endpoints
	mux.HandleFunc("/api/accounts/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasSuffix(path, "/retry") {
			handlers.HandlePostAccountRetry(w, r)
		} else if strings.HasSuffix(path, "/checkin-status") {
			handlers.HandlePostAccountCheckinStatus(w, r)
		} else if strings.HasSuffix(path, "/checkin") {
			handlers.HandlePostAccountCheckin(w, r)
		} else if strings.HasSuffix(path, "/balance") {
			handlers.HandlePostAccountBalance(w, r)
		} else if r.Method == http.MethodDelete {
			handlers.HandleDeleteAccount(w, r)
		} else {
			http.NotFound(w, r)
		}
	})

	// Management page endpoints
	mux.HandleFunc("/management.html", handlers.HandleManagementPage)
	mux.HandleFunc("/management/login", handlers.HandleManagementLogin)
	mux.HandleFunc("/management/logout", handlers.HandleManagementLogout)
	mux.HandleFunc("/management.bundle.js", handlers.HandleManagementBundleJS)
	mux.HandleFunc("/management.bundle.css", handlers.HandleManagementBundleCSS)

	// Serve static files from public folder
	publicDir := http.Dir("./public")
	mux.Handle("/", http.FileServer(publicDir))

	// Start cron jobs with timezone
	loc, _ := time.LoadLocation(checkinCronTz)
	c := cron.New(cron.WithLocation(loc))
	_, _ = c.AddFunc(checkinCronExpr, func() {
		log.Println("[service] scheduled checkin triggered")
	})

	balanceLoc, _ := time.LoadLocation(balanceCronTz)
	c2 := cron.New(cron.WithLocation(balanceLoc))
	_, _ = c2.AddFunc(balanceCronExpr, func() {
		log.Println("[service] scheduled balance refresh triggered")
	})

	c.Start()
	c2.Start()

	if runBalanceOnStart {
		log.Println("[service] running initial balance refresh on startup")
	}

	// Start server
	addr := fmt.Sprintf("0.0.0.0:%d", apiPort)
	log.Printf("[service] listening on http://%s", addr)
	log.Printf("[service] checkin cron='%s' tz='%s', balance cron='%s' tz='%s'", checkinCronExpr, checkinCronTz, balanceCronExpr, balanceCronTz)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[service] server failed: %v", err)
	}
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := fmt.Sscanf(v, "%d", &defaultValue); err == nil && n > 0 {
			return defaultValue
		}
	}
	return defaultValue
}
