package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
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

	var store Store
	if err := json.Unmarshal(data, &store); err != nil {
		// Fallback to default if corrupted, matching node behavior
		return DefaultStore(), nil
	}

	// Normalization logic could go here, but omitted for brevity
	// assuming structs with json tags handle most missing fields zero-value
	if store.Accounts == nil {
		store.Accounts = []Account{}
	}
	if store.Checkins == nil {
		store.Checkins = []CheckinEntry{}
	}
	if store.BalanceSnapshot.Accounts == nil {
		store.BalanceSnapshot.Accounts = []BalanceAccount{}
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
		_ = json.Unmarshal(data, &store)
	}

	if store.Accounts == nil {
		store.Accounts = []Account{}
	}
	if store.Checkins == nil {
		store.Checkins = []CheckinEntry{}
	}
	if store.BalanceSnapshot.Accounts == nil {
		store.BalanceSnapshot.Accounts = []BalanceAccount{}
	}

	if err := updater(&store); err != nil {
		return err // Don't write if updater failed
	}

	store.Metadata.UpdatedAt = NowISO()
	if store.Metadata.CreatedAt == "" {
		store.Metadata.CreatedAt = store.Metadata.UpdatedAt
	}

	outData, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(storePath, append(outData, '\n'), 0644)
}
