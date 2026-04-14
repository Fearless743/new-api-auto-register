package tasks

import (
	"errors"
	"strings"

	"new-api-auto-register/internal/storage"
)

func RunBalanceRefresh(storePath string, specificUsername string) error {
	config := LoadConfig()
	config.StorePath = storePath

	store, err := storage.ReadStore(storePath)
	if err != nil {
		return err
	}

	accounts := make([]storage.Account, 0, len(store.Accounts))
	for _, account := range store.Accounts {
		if strings.TrimSpace(account.Username) != "" && strings.TrimSpace(account.Password) != "" {
			accounts = append(accounts, account)
		}
	}

	if specificUsername != "" {
		filtered := []storage.Account{}
		for _, acc := range accounts {
			if acc.Username == specificUsername {
				filtered = append(filtered, acc)
				break
			}
		}
		accounts = filtered
	}

	if len(accounts) == 0 {
		return errors.New("未找到可用账号，请先准备 store.json 中的 accounts")
	}

	totalQuota := store.BalanceSnapshot.TotalQuota
	totalUsedQuota := store.BalanceSnapshot.TotalUsedQuota
	snapshotAccounts := make([]storage.BalanceAccount, 0, len(store.BalanceSnapshot.Accounts))
	for _, item := range store.BalanceSnapshot.Accounts {
		if specificUsername != "" && item.Username != specificUsername {
			continue
		}
		snapshotAccounts = append(snapshotAccounts, item)
		totalQuota += item.Quota
		totalUsedQuota += item.UsedQuota
	}

	for i := range accounts {
		acc := accounts[i]

		if acc.NewAPIUser == "" && acc.Password != "" {
			loginForUserID, _ := loginAndGetSession(config, acc.Username, acc.Password)
			if loginForUserID.OK && loginForUserID.NewAPIUser != "" {
				acc.NewAPIUser = loginForUserID.NewAPIUser
				if loginForUserID.Session != "" {
					acc.Session = loginForUserID.Session
				}
				now := storage.NowISO()
				_ = saveAccountPatch(storePath, acc.Username, storage.Account{
					Password:    acc.Password,
					NewAPIUser:  acc.NewAPIUser,
					Session:     acc.Session,
					LastLoginAt: &now,
				})
				sleep(config.RequestDelayMs)
			}
		}

		if acc.Session == "" {
			loginResult, _ := loginAndGetSession(config, acc.Username, acc.Password)
			if loginResult.OK {
				acc.Session = loginResult.Session
				acc.NewAPIUser = firstNonEmpty(loginResult.NewAPIUser, acc.NewAPIUser)
				now := storage.NowISO()
				_ = saveAccountPatch(storePath, acc.Username, storage.Account{
					Password:    acc.Password,
					NewAPIUser:  acc.NewAPIUser,
					Session:     acc.Session,
					LastLoginAt: &now,
				})
			} else {
				updateBalanceSnapshotForFailed(&snapshotAccounts, &totalQuota, &totalUsedQuota, acc, loginResult.Status)
				if config.RequestDelayMs > 0 && i < len(accounts)-1 {
					sleep(config.RequestDelayMs)
				}
				continue
			}
		}

		selfResult, _ := fetchSelf(config, acc)
		if !selfResult.OK && selfResult.Status == 401 {
			relogin, _ := loginAndGetSession(config, acc.Username, acc.Password)
			if relogin.OK {
				acc.Session = relogin.Session
				acc.NewAPIUser = firstNonEmpty(relogin.NewAPIUser, acc.NewAPIUser)
				now := storage.NowISO()
				_ = saveAccountPatch(storePath, acc.Username, storage.Account{
					Password:    acc.Password,
					NewAPIUser:  acc.NewAPIUser,
					Session:     acc.Session,
					LastLoginAt: &now,
				})
				sleep(config.RequestDelayMs)
				selfResult, _ = fetchSelf(config, acc)
			}
		}

		removeFromSnapshot(&snapshotAccounts, &totalQuota, &totalUsedQuota, acc.Username)

		if selfResult.OK {
			data := asMap(selfResult.Body["data"])
			quota := floatValue(data["quota"])
			usedQuota := floatValue(data["used_quota"])
			balance := quotaToUSD(quota)
			usedBalance := quotaToUSD(usedQuota)
			now := storage.NowISO()

			totalQuota += quota
			totalUsedQuota += usedQuota

			snapshotAccounts = append(snapshotAccounts, storage.BalanceAccount{
				Username:    acc.Username,
				Quota:       quota,
				Balance:     balance,
				UsedQuota:   usedQuota,
				UsedBalance: usedBalance,
				UpdatedAt:   &now,
				Status:      storage.Ptr(selfResult.Status),
				NewAPIUser:  acc.NewAPIUser,
			})

			_ = saveAccountPatch(storePath, acc.Username, storage.Account{
				Password:          acc.Password,
				NewAPIUser:        acc.NewAPIUser,
				Session:           acc.Session,
				LastBalanceAt:     &now,
				LastBalanceQuota:  storage.Ptr(quota),
				LastBalance:       storage.Ptr(balance),
				LastUsedQuota:     storage.Ptr(usedQuota),
				LastUsedBalance:   storage.Ptr(usedBalance),
				LastBalanceStatus: storage.Ptr(selfResult.Status),
			})
		} else {
			now := storage.NowISO()
			snapshotAccounts = append(snapshotAccounts, storage.BalanceAccount{
				Username:    acc.Username,
				Quota:       0,
				Balance:     "$0.00",
				UsedQuota:   0,
				UsedBalance: "$0.00",
				UpdatedAt:   &now,
				Status:      storage.Ptr(selfResult.Status),
				NewAPIUser:  acc.NewAPIUser,
			})

			_ = saveAccountPatch(storePath, acc.Username, storage.Account{
				LastBalanceAt:     &now,
				LastBalanceQuota:  floatPtr(0),
				LastBalance:       storage.Ptr("$0.00"),
				LastUsedQuota:     floatPtr(0),
				LastUsedBalance:   storage.Ptr("$0.00"),
				LastBalanceStatus: storage.Ptr(selfResult.Status),
			})
		}

		if config.RequestDelayMs > 0 && i < len(accounts)-1 {
			sleep(config.RequestDelayMs)
		}
	}

	return storage.UpdateStore(storePath, func(store *storage.Store) error {
		now := storage.NowISO()
		store.BalanceSnapshot = storage.BalanceSnapshot{
			UpdatedAt:        &now,
			TotalQuota:       totalQuota,
			TotalBalance:     quotaToUSD(totalQuota),
			TotalUsedQuota:   totalUsedQuota,
			TotalUsedBalance: quotaToUSD(totalUsedQuota),
			Accounts:         snapshotAccounts,
		}
		return nil
	})
}

func updateBalanceSnapshotForFailed(snapshotAccounts *[]storage.BalanceAccount, totalQuota *float64, totalUsedQuota *float64, acc storage.Account, status int) {
	removeFromSnapshot(snapshotAccounts, totalQuota, totalUsedQuota, acc.Username)
	now := storage.NowISO()
	*snapshotAccounts = append(*snapshotAccounts, storage.BalanceAccount{
		Username:    acc.Username,
		Quota:       0,
		Balance:     "$0.00",
		UsedQuota:   0,
		UsedBalance: "$0.00",
		UpdatedAt:   &now,
		Status:      storage.Ptr(status),
		NewAPIUser:  acc.NewAPIUser,
	})
}

func removeFromSnapshot(snapshotAccounts *[]storage.BalanceAccount, totalQuota *float64, totalUsedQuota *float64, username string) {
	newAccounts := []storage.BalanceAccount{}
	for _, item := range *snapshotAccounts {
		if item.Username == username {
			*totalQuota -= item.Quota
			*totalUsedQuota -= item.UsedQuota
			continue
		}
		newAccounts = append(newAccounts, item)
	}
	*snapshotAccounts = newAccounts
}
