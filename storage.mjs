import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_STORE = {
  accounts: [],
  checkins: [],
  balanceSnapshot: {
    updatedAt: null,
    totalQuota: 0,
    totalBalance: "$0.00",
    totalUsedQuota: 0,
    totalUsedBalance: "$0.00",
    accounts: [],
  },
  metadata: {
    version: 2,
    createdAt: null,
    updatedAt: null,
  },
  settings: {
    baseUrl: "",
  },
};

function cloneDefaultStore() {
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
}

function normalizeAccount(account = {}) {
  return {
    username: String(account.username || "").trim(),
    password: String(account.password || "").trim(),
    token: String(account.token || "").trim(),
    session: String(account.session || "").trim(),
    newApiUser: String(account.newApiUser || account.new_api_user || "").trim(),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    lastLoginAt: account.lastLoginAt || null,
    lastCheckinAt: account.lastCheckinAt || null,
    lastCheckin: account.lastCheckin || null,
    checkinStatus: normalizeCheckinStatus(account.checkinStatus),
    lastBalanceAt: account.lastBalanceAt || null,
    lastBalanceQuota:
      account.lastBalanceQuota == null || account.lastBalanceQuota === ""
        ? null
        : Number(account.lastBalanceQuota),
    lastBalance: account.lastBalance || null,
    lastUsedQuota:
      account.lastUsedQuota == null || account.lastUsedQuota === ""
        ? null
        : Number(account.lastUsedQuota),
    lastUsedBalance: account.lastUsedBalance || null,
    lastBalanceStatus:
      account.lastBalanceStatus == null || account.lastBalanceStatus === ""
        ? null
        : Number(account.lastBalanceStatus),
    workflow: normalizeWorkflow(account.workflow),
    notes: Array.isArray(account.notes) ? account.notes : [],
  };
}

function normalizeCheckinStatus(status = {}) {
  return {
    month: String(status.month || "").trim(),
    checkedInToday: Boolean(status.checkedInToday),
    checkinCount:
      status.checkinCount == null || status.checkinCount === "" ? 0 : Number(status.checkinCount),
    totalCheckins:
      status.totalCheckins == null || status.totalCheckins === ""
        ? 0
        : Number(status.totalCheckins),
    totalQuota:
      status.totalQuota == null || status.totalQuota === "" ? 0 : Number(status.totalQuota),
    records: Array.isArray(status.records)
      ? status.records.map((record) => ({
          checkinDate: String(record.checkinDate || record.checkin_date || "").trim(),
          quotaAwarded:
            record.quotaAwarded == null || record.quotaAwarded === ""
              ? 0
              : Number(record.quotaAwarded || record.quota_awarded),
        }))
      : [],
    updatedAt: status.updatedAt || null,
  };
}

function normalizeWorkflowStep(step = {}) {
  return {
    status: String(step.status || "idle").trim() || "idle",
    lastRunAt: step.lastRunAt || null,
    httpStatus:
      step.httpStatus == null || step.httpStatus === "" ? null : Number(step.httpStatus),
    message: String(step.message || "").trim(),
    requestUrl: String(step.requestUrl || "").trim(),
    attempt: step.attempt == null || step.attempt === "" ? null : Number(step.attempt),
  };
}

function normalizeWorkflow(workflow = {}) {
  return {
    register: normalizeWorkflowStep(workflow.register),
    login: normalizeWorkflowStep(workflow.login),
    tokenCreate: normalizeWorkflowStep(workflow.tokenCreate),
    tokenList: normalizeWorkflowStep(workflow.tokenList),
  };
}

function normalizeCheckinEntry(entry = {}) {
  return {
    time: entry.time || new Date().toISOString(),
    username: String(entry.username || "").trim(),
    newApiUser: String(entry.newApiUser || entry.new_api_user || "").trim(),
    status: Number(entry.status || 0),
    success: Boolean(entry.success),
    message: String(entry.message || "").trim(),
    checkinDate: String(entry.checkinDate || entry.checkin_date || "").trim(),
    quotaAwarded:
      entry.quotaAwarded == null || entry.quotaAwarded === ""
        ? null
        : Number(entry.quotaAwarded),
  };
}

function normalizeBalanceSnapshot(snapshot = {}) {
  return {
    updatedAt: snapshot.updatedAt || null,
    totalQuota: Number(snapshot.totalQuota || 0),
    totalBalance: String(snapshot.totalBalance || "$0.00"),
    totalUsedQuota: Number(snapshot.totalUsedQuota || 0),
    totalUsedBalance: String(snapshot.totalUsedBalance || "$0.00"),
    accounts: Array.isArray(snapshot.accounts)
      ? snapshot.accounts.map((account) => ({
          username: String(account.username || "").trim(),
          quota: Number(account.quota || 0),
          balance: String(account.balance || "$0.00"),
          usedQuota: Number(account.usedQuota || 0),
          usedBalance: String(account.usedBalance || "$0.00"),
          updatedAt: account.updatedAt || null,
          status:
            account.status == null || account.status === ""
              ? null
              : Number(account.status),
          newApiUser: String(account.newApiUser || account.new_api_user || "").trim(),
        }))
      : [],
  };
}

function normalizeSettings(settings = {}) {
  return {
    baseUrl: String(settings.baseUrl || settings.base_url || "").trim(),
  };
}

function normalizeStore(store = {}) {
  const now = new Date().toISOString();
  return {
    accounts: Array.isArray(store.accounts) ? store.accounts.map(normalizeAccount) : [],
    checkins: Array.isArray(store.checkins) ? store.checkins.map(normalizeCheckinEntry) : [],
    balanceSnapshot: normalizeBalanceSnapshot(store.balanceSnapshot),
    metadata: {
      version: 2,
      createdAt: store.metadata?.createdAt || now,
      updatedAt: store.metadata?.updatedAt || now,
    },
    settings: normalizeSettings(store.settings),
  };
}


export async function ensureStoreFile(storePath) {
  await mkdir(dirname(storePath), { recursive: true });
  try {
    await readFile(storePath, "utf8");
  } catch {
    const now = new Date().toISOString();
    const initial = cloneDefaultStore();
    initial.metadata.createdAt = now;
    initial.metadata.updatedAt = now;
    await writeFile(storePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  }
}

export async function readStore(storePath) {
  await ensureStoreFile(storePath);
  const raw = await readFile(storePath, "utf8");
  if (!raw.trim()) {
    return cloneDefaultStore();
  }

  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    return cloneDefaultStore();
  }
}

export async function writeStore(storePath, store) {
  const normalized = normalizeStore(store);
  normalized.metadata.updatedAt = new Date().toISOString();
  if (!normalized.metadata.createdAt) {
    normalized.metadata.createdAt = normalized.metadata.updatedAt;
  }
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

let storeWriteLock = Promise.resolve();

export async function updateStore(storePath, updater) {
  const next = storeWriteLock.then(async () => {
    const store = await readStore(storePath);
    const updated = (await updater(store)) || store;
    return writeStore(storePath, updated);
  });

  storeWriteLock = next.catch(() => {});
  return next;
}

export function findAccount(store, username) {
  return store.accounts.find((account) => account.username === username) || null;
}

export function upsertAccountInStore(store, accountPatch) {
  const username = String(accountPatch.username || "").trim();
  if (!username) {
    return store;
  }

  const now = new Date().toISOString();
  const existing = findAccount(store, username);
  const merged = normalizeAccount({
    ...(existing || { createdAt: now }),
    ...accountPatch,
    username,
    updatedAt: now,
  });

  const accounts = store.accounts.filter((account) => account.username !== username);
  accounts.push(merged);
  accounts.sort((a, b) => a.username.localeCompare(b.username));
  store.accounts = accounts;
  return store;
}

export function appendCheckinInStore(store, entry) {
  store.checkins.push(normalizeCheckinEntry(entry));
  if (store.checkins.length > 5000) {
    store.checkins = store.checkins.slice(-5000);
  }
  return store;
}

export function setBalanceSnapshotInStore(store, snapshot) {
  store.balanceSnapshot = normalizeBalanceSnapshot(snapshot);
  return store;
}

export function setBaseUrlInStore(store, baseUrl) {
  store.settings = normalizeSettings({ ...(store.settings || {}), baseUrl });
  return store;
}

export function getBaseUrlFromStore(store) {
  return String(store?.settings?.baseUrl || "").trim();
}
