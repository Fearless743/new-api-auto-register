import "./env-bootstrap.mjs";
import {
  ensureStoreFile,
  readStore,
  setBalanceSnapshotInStore,
  updateStore,
  upsertAccountInStore,
} from "./storage.mjs";

const CONFIG = {
  baseUrl: process.env.BASE_URL || "https://open.lxcloud.dev",
  storePath: process.env.STORE_PATH || "./data/store.json",
  requestDelayMs: Number(process.env.QUERY_DELAY_MS || 1000),
  extraCookies: process.env.EXTRA_COOKIES || "",
  defaultNewApiUser: process.env.NEW_API_USER || "",
};

const SELF_URL = `${CONFIG.baseUrl}/api/user/self`;
const LOGIN_URL = `${CONFIG.baseUrl}/api/user/login?turnstile=`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePossibleUserId(response) {
  const candidates = [
    response?.data?.id,
    response?.data?.user_id,
    response?.data?.uid,
    response?.id,
    response?.user_id,
    response?.uid,
  ];

  for (const c of candidates) {
    if (c == null || c === "") {
      continue;
    }
    return String(c);
  }
  return "";
}

function parseResponseToJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function isApiSuccess(httpOk, body) {
  if (!httpOk) {
    return false;
  }
  if (body && typeof body === "object" && "success" in body) {
    return body.success === true;
  }
  return true;
}

function extractSessionFromSetCookie(rawSetCookie) {
  if (!rawSetCookie) {
    return "";
  }
  const match = String(rawSetCookie).match(/(?:^|[;,\s])session=([^;\s,]+)/);
  if (!match) {
    return "";
  }
  return `session=${match[1]}`;
}

function combineCookies(sessionCookie) {
  if (sessionCookie && CONFIG.extraCookies) {
    return `${CONFIG.extraCookies}; ${sessionCookie}`;
  }
  return sessionCookie || CONFIG.extraCookies;
}

async function loginAndGetSession(username, password) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Origin: CONFIG.baseUrl,
    Referer: `${CONFIG.baseUrl}/login`,
    Connection: "keep-alive",
    ...(CONFIG.defaultNewApiUser
      ? { "New-API-User": String(CONFIG.defaultNewApiUser) }
      : {}),
    ...(CONFIG.extraCookies ? { Cookie: CONFIG.extraCookies } : {}),
  };

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password }),
  });

  const body = parseResponseToJson(await res.text());
  const ok = isApiSuccess(res.ok, body);
  if (!ok) {
    return {
      ok: false,
      status: res.status,
      message: body?.message || "login failed",
      session: "",
    };
  }

  const setCookieRaw = res.headers.get("set-cookie") || "";
  const session = extractSessionFromSetCookie(setCookieRaw);

  return {
    ok: Boolean(session),
    status: res.status,
    message: session ? "ok" : "login success but no session cookie",
    session,
    newApiUser: parsePossibleUserId(body) || CONFIG.defaultNewApiUser || "",
  };
}

async function saveAccountPatch(username, patch) {
  await updateStore(CONFIG.storePath, (store) => {
    upsertAccountInStore(store, { username, ...patch });
    return store;
  });
}

async function fetchSelf(account) {
  const cookieHeader = combineCookies(account.session);
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    Referer: `${CONFIG.baseUrl}/console/topup`,
    ...((account.newApiUser || CONFIG.defaultNewApiUser)
      ? { "New-API-User": String(account.newApiUser || CONFIG.defaultNewApiUser) }
      : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const res = await fetch(SELF_URL, { method: "GET", headers });
  const body = parseResponseToJson(await res.text());
  const ok = isApiSuccess(res.ok, body);

  return {
    ok,
    status: res.status,
    body,
  };
}

function quotaToUsd(quota) {
  const n = Number(quota || 0);
  if (!Number.isFinite(n)) {
    return "$0.00";
  }
  const usd = (n * 2) / 1_000_000;
  return `$${usd.toFixed(2)}`;
}

export async function runBalanceRefresh() {
  await ensureStoreFile(CONFIG.storePath);
  const store = await readStore(CONFIG.storePath);
  const accounts = store.accounts.filter((account) => account.username && account.password);

  if (accounts.length === 0) {
    throw new Error("未找到可用账号，请先准备 store.json 中的 accounts");
  }

  let totalQuota = 0;
  let totalUsedQuota = 0;
  const snapshotAccounts = [];

  for (let i = 0; i < accounts.length; i += 1) {
    const acc = accounts[i];

    if (!acc.newApiUser && acc.password) {
      const loginForUserId = await loginAndGetSession(acc.username, acc.password);
      if (loginForUserId.ok && loginForUserId.newApiUser) {
        acc.newApiUser = loginForUserId.newApiUser;
        acc.session = loginForUserId.session || acc.session;
        await saveAccountPatch(acc.username, {
          password: acc.password,
          newApiUser: acc.newApiUser,
          session: acc.session,
          lastLoginAt: new Date().toISOString(),
        });
        if (CONFIG.requestDelayMs > 0) {
          await sleep(CONFIG.requestDelayMs);
        }
      }
    }

    if (!acc.session) {
      const loginResult = await loginAndGetSession(acc.username, acc.password);
      if (loginResult.ok) {
        acc.session = loginResult.session;
        acc.newApiUser = loginResult.newApiUser || acc.newApiUser;
        await saveAccountPatch(acc.username, {
          password: acc.password,
          newApiUser: acc.newApiUser,
          session: acc.session,
          lastLoginAt: new Date().toISOString(),
        });
      } else {
        snapshotAccounts.push({
          username: acc.username,
          quota: 0,
          balance: "$0.00",
          usedQuota: 0,
          usedBalance: "$0.00",
          updatedAt: new Date().toISOString(),
          status: loginResult.status,
          newApiUser: acc.newApiUser || "",
        });
        if (CONFIG.requestDelayMs > 0) {
          await sleep(CONFIG.requestDelayMs);
        }
        continue;
      }
    }

    let selfResult = await fetchSelf(acc);

    if (!selfResult.ok && selfResult.status === 401) {
      const relogin = await loginAndGetSession(acc.username, acc.password);
      if (relogin.ok) {
        acc.session = relogin.session;
        acc.newApiUser = relogin.newApiUser || acc.newApiUser;
        await saveAccountPatch(acc.username, {
          password: acc.password,
          newApiUser: acc.newApiUser,
          session: acc.session,
          lastLoginAt: new Date().toISOString(),
        });
        if (CONFIG.requestDelayMs > 0) {
          await sleep(CONFIG.requestDelayMs);
        }
        selfResult = await fetchSelf(acc);
      }
    }

    if (selfResult.ok) {
      const quota = selfResult.body?.data?.quota ?? 0;
      const usedQuota = selfResult.body?.data?.used_quota ?? 0;
      const balance = quotaToUsd(quota);
      const usedBalance = quotaToUsd(usedQuota);
      totalQuota += Number(quota) || 0;
      totalUsedQuota += Number(usedQuota) || 0;
      const updatedAt = new Date().toISOString();
      snapshotAccounts.push({
        username: acc.username,
        quota: Number(quota) || 0,
        balance,
        usedQuota: Number(usedQuota) || 0,
        usedBalance,
        updatedAt,
        status: selfResult.status,
        newApiUser: acc.newApiUser || "",
      });
      await saveAccountPatch(acc.username, {
        password: acc.password,
        newApiUser: acc.newApiUser,
        session: acc.session,
        lastBalanceAt: updatedAt,
        lastBalanceQuota: Number(quota) || 0,
        lastBalance: balance,
        lastUsedQuota: Number(usedQuota) || 0,
        lastUsedBalance: usedBalance,
        lastBalanceStatus: selfResult.status,
      });
      console.log(`${acc.username}: ${balance}`);
    } else {
      totalUsedQuota += Number(acc.lastUsedQuota || 0);
      snapshotAccounts.push({
        username: acc.username,
        quota: Number(acc.lastBalanceQuota || 0),
        balance: acc.lastBalance || quotaToUsd(acc.lastBalanceQuota || 0),
        usedQuota: Number(acc.lastUsedQuota || 0),
        usedBalance: acc.lastUsedBalance || quotaToUsd(acc.lastUsedQuota || 0),
        updatedAt: new Date().toISOString(),
        status: selfResult.status,
        newApiUser: acc.newApiUser || "",
      });
    }

    if (CONFIG.requestDelayMs > 0 && i < accounts.length - 1) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  console.log(`总余额: ${quotaToUsd(totalQuota)}`);
  console.log(`总已使用余额: ${quotaToUsd(totalUsedQuota)}`);

  await updateStore(CONFIG.storePath, (latestStore) => {
    setBalanceSnapshotInStore(latestStore, {
      updatedAt: new Date().toISOString(),
      totalQuota,
      totalBalance: quotaToUsd(totalQuota),
      totalUsedQuota,
      totalUsedBalance: quotaToUsd(totalUsedQuota),
      accounts: snapshotAccounts,
    });
    return latestStore;
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runBalanceRefresh().catch((err) => {
    console.error("运行失败:", err);
    process.exit(1);
  });
}
