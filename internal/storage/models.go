package storage

import (
	"time"
)

// ISOTime represents a standard ISO8601 string time.
type ISOTime string

// CheckinRecord represents a single check-in record
type CheckinRecord struct {
	CheckinDate  string  `json:"checkinDate"`
	QuotaAwarded float64 `json:"quotaAwarded"`
}

// LastCheckinResult stores the latest manual or batch check-in result on the account.
type LastCheckinResult struct {
	Status       int      `json:"status"`
	Success      bool     `json:"success"`
	Message      string   `json:"message"`
	CheckinDate  string   `json:"checkinDate"`
	QuotaAwarded *float64 `json:"quotaAwarded"`
	Time         *ISOTime `json:"time"`
}

// CheckinStatus represents the overall check-in status of an account
type CheckinStatus struct {
	Month          string          `json:"month"`
	CheckedInToday bool            `json:"checkedInToday"`
	CheckinCount   int             `json:"checkinCount"`
	TotalCheckins  int             `json:"totalCheckins"`
	TotalQuota     float64         `json:"totalQuota"`
	Records        []CheckinRecord `json:"records"`
	UpdatedAt      *ISOTime        `json:"updatedAt"`
}

// WorkflowStep represents the state of a single workflow step
type WorkflowStep struct {
	Status     string   `json:"status"` // "idle", "success", "failed"
	LastRunAt  *ISOTime `json:"lastRunAt"`
	HTTPStatus *int     `json:"httpStatus"`
	Message    string   `json:"message"`
	RequestURL string   `json:"requestUrl"`
	Attempt    *int     `json:"attempt"`
}

// Workflow represents the various registration workflow steps
// Can be either map[string]string (simple) or map[string]WorkflowStep (detailed)
type Workflow map[string]string

// Account represents a user account
type Account struct {
	Username          string             `json:"username"`
	Password          string             `json:"password"`
	Token             string             `json:"token"`
	Session           string             `json:"session"`
	NewAPIUser        string             `json:"newApiUser"`
	BaseURL           string             `json:"baseUrl"`
	CreatedAt         *ISOTime           `json:"createdAt"`
	UpdatedAt         *ISOTime           `json:"updatedAt"`
	LastLoginAt       *ISOTime           `json:"lastLoginAt"`
	LastCheckinAt     *ISOTime           `json:"lastCheckinAt"`
	LastCheckin       *LastCheckinResult `json:"lastCheckin"`
	CheckinStatus     CheckinStatus      `json:"checkinStatus"`
	LastBalanceAt     *ISOTime           `json:"lastBalanceAt"`
	LastBalanceQuota  *float64           `json:"lastBalanceQuota"`
	LastBalance       *string            `json:"lastBalance"`
	LastUsedQuota     *float64           `json:"lastUsedQuota"`
	LastUsedBalance   *string            `json:"lastUsedBalance"`
	LastBalanceStatus *int               `json:"lastBalanceStatus"`
	Workflow          Workflow           `json:"workflow"`
	Notes             []string           `json:"notes"`
}

// CheckinEntry represents a global check-in log entry
type CheckinEntry struct {
	Time         ISOTime  `json:"time"`
	Username     string   `json:"username"`
	NewAPIUser   string   `json:"newApiUser"`
	Status       int      `json:"status"`
	Success      bool     `json:"success"`
	Message      string   `json:"message"`
	CheckinDate  string   `json:"checkinDate"`
	QuotaAwarded *float64 `json:"quotaAwarded"`
}

// BalanceAccount represents an account snapshot in the balance summary
type BalanceAccount struct {
	Username    string   `json:"username"`
	Quota       float64  `json:"quota"`
	Balance     string   `json:"balance"`
	UsedQuota   float64  `json:"usedQuota"`
	UsedBalance string   `json:"usedBalance"`
	UpdatedAt   *ISOTime `json:"updatedAt"`
	Status      *int     `json:"status"`
	NewAPIUser  string   `json:"newApiUser"`
}

// BalanceSnapshot represents the system-wide balance overview
type BalanceSnapshot struct {
	UpdatedAt        *ISOTime         `json:"updatedAt"`
	TotalQuota       float64          `json:"totalQuota"`
	TotalBalance     string           `json:"totalBalance"`
	TotalUsedQuota   float64          `json:"totalUsedQuota"`
	TotalUsedBalance string           `json:"totalUsedBalance"`
	Accounts         []BalanceAccount `json:"accounts"`
}

// Metadata represents the store metadata
type Metadata struct {
	Version   int     `json:"version"`
	CreatedAt ISOTime `json:"createdAt"`
	UpdatedAt ISOTime `json:"updatedAt"`
}

// Settings represents global settings
type Settings struct {
	BaseURL string `json:"baseUrl"`
}

// Store represents the entire database schema
type Store struct {
	Accounts        []Account       `json:"accounts"`
	Checkins        []CheckinEntry  `json:"checkins"`
	BalanceSnapshot BalanceSnapshot `json:"balanceSnapshot"`
	Metadata        Metadata        `json:"metadata"`
	Settings        Settings        `json:"settings"`
}

// NowISO returns the current time in ISO8601 string format
func NowISO() ISOTime {
	return ISOTime(time.Now().UTC().Format(time.RFC3339))
}

// Ptr returns a pointer to the given value
func Ptr[T any](v T) *T {
	return &v
}
