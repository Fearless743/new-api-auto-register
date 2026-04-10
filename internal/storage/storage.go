package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

var (
	storeMu sync.RWMutex
)

// DefaultStore returns a fresh default store
func DefaultStore() Store {
	now := NowISO()
	return Store{
		Accounts: []Account{},
		Checkins: []CheckinEntry{},
		BalanceSnapshot: BalanceSnapshot{
			TotalBalance:     "$0.00",
			TotalUsedBalance: "$0.00",
			Accounts:         []BalanceAccount{},
		},
		Metadata: Metadata{
			Version:   2,
			CreatedAt: now,
			UpdatedAt: now,
		},
		Settings: Settings{},
	}
}

// EnsureStoreFile checks if the store exists, if not creates it with DefaultStore
func EnsureStoreFile(storePath string) error {
	return ensureStoreFile(storePath)
}

// ensureStoreFile checks if the store exists, if not creates it with DefaultStore
func ensureStoreFile(storePath string) error {
	if err := os.MkdirAll(filepath.Dir(storePath), 0755); err != nil {
		return err
	}

	_, err := os.Stat(storePath)
	if os.IsNotExist(err) {
		initial := DefaultStore()
		data, err := json.MarshalIndent(initial, "", "  ")
		if err != nil {
			return err
		}
		// Write with trailing newline as per node convention
		return os.WriteFile(storePath, append(data, '\n'), 0644)
	}
	return err
}

// ReadStore reads and parses the JSON store file safely
func ReadStore(storePath string) (Store, error) {
	storeMu.RLock()
	defer storeMu.RUnlock()

	if err := ensureStoreFile(storePath); err != nil {
		return DefaultStore(), err
	}

	data, err := os.ReadFile(storePath)
	if err != nil {
		return DefaultStore(), err
	}

	if len(data) == 0 {
		return DefaultStore(), nil
	}

	store, err := normalizeStoreAny(data)
	if err != nil {
		// Fallback to default if corrupted, matching node behavior
		return DefaultStore(), nil
	}

	return store, nil
}

// WriteStore writes the store back to the JSON file safely
func WriteStore(storePath string, store Store) (Store, error) {
	storeMu.Lock()
	defer storeMu.Unlock()

	store.Metadata.UpdatedAt = NowISO()
	if store.Metadata.CreatedAt == "" {
		store.Metadata.CreatedAt = store.Metadata.UpdatedAt
	}
	store = normalizeStoreStruct(store)

	if err := os.MkdirAll(filepath.Dir(storePath), 0755); err != nil {
		return store, err
	}

	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return store, err
	}

	if err := os.WriteFile(storePath, append(data, '\n'), 0644); err != nil {
		return store, err
	}

	return store, nil
}

// UpdateStore is a thread-safe update wrapper mimicking updateStore from node
func UpdateStore(storePath string, updater func(*Store) error) error {
	storeMu.Lock()
	defer storeMu.Unlock()

	// Internal unsafe read since lock is already held
	if err := ensureStoreFile(storePath); err != nil {
		return err
	}
	data, err := os.ReadFile(storePath)
	if err != nil {
		return err
	}
	store := DefaultStore()
	if len(data) > 0 {
		normalized, err := normalizeStoreAny(data)
		if err == nil {
			store = normalized
		}
	}

	if err := updater(&store); err != nil {
		return err // Don't write if updater failed
	}

	store.Metadata.UpdatedAt = NowISO()
	if store.Metadata.CreatedAt == "" {
		store.Metadata.CreatedAt = store.Metadata.UpdatedAt
	}
	store = normalizeStoreStruct(store)

	outData, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(storePath, append(outData, '\n'), 0644)
}

// FindAccount returns the matching account or nil.
func FindAccount(store *Store, username string) *Account {
	if store == nil {
		return nil
	}

	for i := range store.Accounts {
		if store.Accounts[i].Username == username {
			return &store.Accounts[i]
		}
	}

	return nil
}

// UpsertAccountInStore inserts or updates an account and keeps username ordering stable.
func UpsertAccountInStore(store *Store, accountPatch Account) {
	if store == nil {
		return
	}

	username := strings.TrimSpace(accountPatch.Username)
	if username == "" {
		return
	}

	now := NowISO()
	existing := FindAccount(store, username)
	merged := accountPatch
	merged.Username = username
	merged.UpdatedAt = Ptr(now)

	if existing != nil {
		if merged.CreatedAt == nil {
			merged.CreatedAt = existing.CreatedAt
		}
	} else if merged.CreatedAt == nil {
		merged.CreatedAt = Ptr(now)
	}

	accounts := make([]Account, 0, len(store.Accounts)+1)
	for _, account := range store.Accounts {
		if account.Username != username {
			accounts = append(accounts, account)
		}
	}
	accounts = append(accounts, merged)
	sort.Slice(accounts, func(i, j int) bool {
		return accounts[i].Username < accounts[j].Username
	})
	store.Accounts = accounts
}

// AppendCheckinInStore appends a check-in entry and caps history.
func AppendCheckinInStore(store *Store, entry CheckinEntry) {
	if store == nil {
		return
	}

	store.Checkins = append(store.Checkins, entry)
	if len(store.Checkins) > 5000 {
		store.Checkins = store.Checkins[len(store.Checkins)-5000:]
	}
}

// SetBalanceSnapshotInStore replaces the current balance snapshot.
func SetBalanceSnapshotInStore(store *Store, snapshot BalanceSnapshot) {
	if store == nil {
		return
	}
	store.BalanceSnapshot = snapshot
}

// SetBaseURLInStore updates the persisted base URL setting.
func SetBaseURLInStore(store *Store, baseURL string) {
	if store == nil {
		return
	}
	store.Settings.BaseURL = strings.TrimSpace(baseURL)
}

// GetBaseURLFromStore returns the configured base URL.
func GetBaseURLFromStore(store *Store) string {
	if store == nil {
		return ""
	}
	return strings.TrimSpace(store.Settings.BaseURL)
}

// ListUniqueTokens returns distinct sk- tokens from accounts.
func ListUniqueTokens(store *Store) []string {
	if store == nil {
		return []string{}
	}

	seen := make(map[string]struct{})
	tokens := make([]string, 0, len(store.Accounts))
	for _, account := range store.Accounts {
		token := strings.TrimSpace(account.Token)
		if !strings.HasPrefix(token, "sk-") {
			continue
		}
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		tokens = append(tokens, token)
	}

	return tokens
}

func normalizeStoreStruct(store Store) Store {
	normalized, err := normalizeStoreAny(store)
	if err != nil {
		return store
	}
	return normalized
}

func normalizeStoreAny(value any) (Store, error) {
	var raw map[string]any
	switch v := value.(type) {
	case []byte:
		if err := json.Unmarshal(v, &raw); err != nil {
			return Store{}, err
		}
	case map[string]any:
		raw = v
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return Store{}, err
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			return Store{}, err
		}
	}

	now := NowISO()
	store := DefaultStore()
	store.Accounts = normalizeAccounts(raw["accounts"])
	store.Checkins = normalizeCheckinEntries(raw["checkins"])
	store.BalanceSnapshot = normalizeBalanceSnapshot(raw["balanceSnapshot"])
	store.Settings = normalizeSettings(raw["settings"])

	metadata := asMap(raw["metadata"])
	store.Metadata.Version = 2
	store.Metadata.CreatedAt = isoValueOr(metadata["createdAt"], now)
	store.Metadata.UpdatedAt = isoValueOr(metadata["updatedAt"], now)
	return store, nil
}

func normalizeAccounts(value any) []Account {
	items := asSlice(value)
	accounts := make([]Account, 0, len(items))
	for _, item := range items {
		accounts = append(accounts, normalizeAccount(item))
	}
	return accounts
}

func normalizeAccount(value any) Account {
	raw := asMap(value)
	return Account{
		Username:          stringValue(raw["username"]),
		Password:          stringValue(raw["password"]),
		Token:             stringValue(raw["token"]),
		Session:           stringValue(raw["session"]),
		NewAPIUser:        firstString(raw, "newApiUser", "new_api_user"),
		BaseURL:           firstString(raw, "baseUrl", "base_url"),
		CreatedAt:         isoPtr(raw["createdAt"]),
		UpdatedAt:         isoPtr(raw["updatedAt"]),
		LastLoginAt:       isoPtr(raw["lastLoginAt"]),
		LastCheckinAt:     isoPtr(raw["lastCheckinAt"]),
		LastCheckin:       normalizeLastCheckinResult(raw["lastCheckin"]),
		CheckinStatus:     normalizeCheckinStatus(raw["checkinStatus"]),
		LastBalanceAt:     isoPtr(raw["lastBalanceAt"]),
		LastBalanceQuota:  floatPtr(raw["lastBalanceQuota"]),
		LastBalance:       stringPtr(raw["lastBalance"]),
		LastUsedQuota:     floatPtr(raw["lastUsedQuota"]),
		LastUsedBalance:   stringPtr(raw["lastUsedBalance"]),
		LastBalanceStatus: intPtr(raw["lastBalanceStatus"]),
		Workflow:          normalizeWorkflow(raw["workflow"]),
		Notes:             stringSlice(raw["notes"]),
	}
}

func normalizeCheckinStatus(value any) CheckinStatus {
	raw := asMap(value)
	recordsRaw := asSlice(raw["records"])
	records := make([]CheckinRecord, 0, len(recordsRaw))
	for _, item := range recordsRaw {
		record := asMap(item)
		records = append(records, CheckinRecord{
			CheckinDate:  firstString(record, "checkinDate", "checkin_date"),
			QuotaAwarded: floatValue(firstValue(record, "quotaAwarded", "quota_awarded")),
		})
	}

	return CheckinStatus{
		Month:          stringValue(raw["month"]),
		CheckedInToday: boolValue(raw["checkedInToday"]),
		CheckinCount:   intValue(raw["checkinCount"]),
		TotalCheckins:  intValue(raw["totalCheckins"]),
		TotalQuota:     floatValue(raw["totalQuota"]),
		Records:        records,
		UpdatedAt:      isoPtr(raw["updatedAt"]),
	}
}

func normalizeLastCheckinResult(value any) *LastCheckinResult {
	raw := asMap(value)
	if len(raw) == 0 {
		return nil
	}

	result := &LastCheckinResult{
		Status:       intValue(raw["status"]),
		Success:      boolValue(raw["success"]),
		Message:      stringValue(raw["message"]),
		CheckinDate:  firstString(raw, "checkinDate", "checkin_date"),
		QuotaAwarded: floatPtr(firstValue(raw, "quotaAwarded", "quota_awarded")),
		Time:         isoPtr(raw["time"]),
	}

	return result
}

func normalizeWorkflow(value any) Workflow {
	raw := asMap(value)
	return Workflow{
		Register:    normalizeWorkflowStep(raw["register"]),
		Login:       normalizeWorkflowStep(raw["login"]),
		TokenCreate: normalizeWorkflowStep(raw["tokenCreate"]),
		TokenList:   normalizeWorkflowStep(raw["tokenList"]),
	}
}

func normalizeWorkflowStep(value any) WorkflowStep {
	raw := asMap(value)
	status := stringValue(raw["status"])
	if status == "" {
		status = "idle"
	}
	return WorkflowStep{
		Status:     status,
		LastRunAt:  isoPtr(raw["lastRunAt"]),
		HTTPStatus: intPtr(raw["httpStatus"]),
		Message:    stringValue(raw["message"]),
		RequestURL: stringValue(raw["requestUrl"]),
		Attempt:    intPtr(raw["attempt"]),
	}
}

func normalizeCheckinEntries(value any) []CheckinEntry {
	items := asSlice(value)
	entries := make([]CheckinEntry, 0, len(items))
	for _, item := range items {
		raw := asMap(item)
		timeValue := isoValueOr(firstValue(raw, "time"), NowISO())
		entries = append(entries, CheckinEntry{
			Time:         timeValue,
			Username:     stringValue(raw["username"]),
			NewAPIUser:   firstString(raw, "newApiUser", "new_api_user"),
			Status:       intValue(raw["status"]),
			Success:      boolValue(raw["success"]),
			Message:      stringValue(raw["message"]),
			CheckinDate:  firstString(raw, "checkinDate", "checkin_date"),
			QuotaAwarded: floatPtr(raw["quotaAwarded"]),
		})
	}
	return entries
}

func normalizeBalanceSnapshot(value any) BalanceSnapshot {
	raw := asMap(value)
	accountsRaw := asSlice(raw["accounts"])
	accounts := make([]BalanceAccount, 0, len(accountsRaw))
	for _, item := range accountsRaw {
		account := asMap(item)
		accounts = append(accounts, BalanceAccount{
			Username:    stringValue(account["username"]),
			Quota:       floatValue(account["quota"]),
			Balance:     stringValueOr(account["balance"], "$0.00"),
			UsedQuota:   floatValue(account["usedQuota"]),
			UsedBalance: stringValueOr(account["usedBalance"], "$0.00"),
			UpdatedAt:   isoPtr(account["updatedAt"]),
			Status:      intPtr(account["status"]),
			NewAPIUser:  firstString(account, "newApiUser", "new_api_user"),
		})
	}

	return BalanceSnapshot{
		UpdatedAt:        isoPtr(raw["updatedAt"]),
		TotalQuota:       floatValue(raw["totalQuota"]),
		TotalBalance:     stringValueOr(raw["totalBalance"], "$0.00"),
		TotalUsedQuota:   floatValue(raw["totalUsedQuota"]),
		TotalUsedBalance: stringValueOr(raw["totalUsedBalance"], "$0.00"),
		Accounts:         accounts,
	}
}

func normalizeSettings(value any) Settings {
	raw := asMap(value)
	return Settings{BaseURL: firstString(raw, "baseUrl", "base_url")}
}

func asMap(value any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	m, ok := value.(map[string]any)
	if ok {
		return m
	}
	return map[string]any{}
}

func asSlice(value any) []any {
	if value == nil {
		return []any{}
	}
	items, ok := value.([]any)
	if ok {
		return items
	}
	return []any{}
}

func firstValue(raw map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			return value
		}
	}
	return nil
}

func firstString(raw map[string]any, keys ...string) string {
	return stringValue(firstValue(raw, keys...))
}

func stringSlice(value any) []string {
	items := asSlice(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, stringValue(item))
	}
	return result
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func stringValueOr(value any, fallback string) string {
	result := stringValue(value)
	if result == "" {
		return fallback
	}
	return result
}

func stringPtr(value any) *string {
	result := stringValue(value)
	if result == "" {
		return nil
	}
	return Ptr(result)
}

func boolValue(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(v))
		return err == nil && parsed
	case float64:
		return v != 0
	case int:
		return v != 0
	default:
		return false
	}
}

func intValue(value any) int {
	switch v := value.(type) {
	case nil:
		return 0
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}

func intPtr(value any) *int {
	if value == nil || stringValue(value) == "" {
		return nil
	}
	result := intValue(value)
	return Ptr(result)
}

func floatValue(value any) float64 {
	switch v := value.(type) {
	case nil:
		return 0
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		n, _ := v.Float64()
		return n
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return 0
		}
		return n
	default:
		return 0
	}
}

func floatPtr(value any) *float64 {
	if value == nil || stringValue(value) == "" {
		return nil
	}
	result := floatValue(value)
	return Ptr(result)
}

func isoPtr(value any) *ISOTime {
	text := stringValue(value)
	if text == "" {
		return nil
	}
	iso := ISOTime(text)
	return &iso
}

func isoValueOr(value any, fallback ISOTime) ISOTime {
	text := stringValue(value)
	if text == "" {
		return fallback
	}
	return ISOTime(text)
}
