import "./env-bootstrap.mjs";
import {
  appendCheckinInStore,
  ensureStoreFile,
  readStore,
  updateStore,
  upsertAccountInStore,
} from "./storage.mjs";

const CONFIG = {
  baseUrl: process.env.BASE_URL || "https://open.lxcloud.dev",
  storePath: process.env.STORE_PATH || "./data/store.json",
  requestDelayMs: Number(process.env.CHECKIN_DELAY_MS || 1000),
  maxRetries: Number(process.env.CHECKIN_MAX_RETRIES || 4),
  retryDelayMs: Number(process.env.CHECKIN_RETRY_DELAY_MS || 300000),
  extraCookies: process.env.EXTRA_COOKIES || "",
  defaultNewApiUser: process.env.NEW_API_USER || "",
};

const CHECKIN_URL = `${CONFIG.baseUrl}/api/user/checkin`;
const LOGIN_URL = `${CONFIG.baseUrl}/api/user/login?turnstile=`;

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

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

async function saveAccountPatch(username, patch) {
  await updateStore(CONFIG.storePath, (store) => {
    upsertAccountInStore(store, { username, ...patch });
    return store;
  });
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
      newApiUser: "",
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

async function checkinOnce(account) {
  const cookieHeader = combineCookies(account.session);
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cache-Control": "no-store",
    Origin: CONFIG.baseUrl,
    Referer: `${CONFIG.baseUrl}/console/personal`,
    Connection: "keep-alive",
    ...((account.newApiUser || CONFIG.defaultNewApiUser)
      ? { "New-API-User": String(account.newApiUser || CONFIG.defaultNewApiUser) }
      : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const res = await fetch(CHECKIN_URL, {
    method: "POST",
    headers,
  });

  const body = parseResponseToJson(await res.text());
  const ok = isApiSuccess(res.ok, body);

  return {
    ok,
    status: res.status,
    body,
  };
}

export async function queryCheckinStatus(account, month = currentMonth()) {
  const cookieHeader = combineCookies(account.session);
  const url = `${CHECKIN_URL}?month=${encodeURIComponent(month)}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cache-Control": "no-store",
    Origin: CONFIG.baseUrl,
    Referer: `${CONFIG.baseUrl}/console/personal`,
    Connection: "keep-alive",
    ...((account.newApiUser || CONFIG.defaultNewApiUser)
      ? { "New-API-User": String(account.newApiUser || CONFIG.defaultNewApiUser) }
      : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const res = await fetch(url, {
    method: "GET",
    headers,
  });

  const body = parseResponseToJson(await res.text());
  const ok = isApiSuccess(res.ok, body);
  const stats = body?.data?.stats || {};

  return {
    ok,
    status: res.status,
    body,
    checkinStatus: {
      month,
      checkedInToday: Boolean(stats.checked_in_today),
      checkinCount: Number(stats.checkin_count || 0),
      totalCheckins: Number(stats.total_checkins || 0),
      totalQuota: Number(stats.total_quota || 0),
      records: Array.isArray(stats.records)
        ? stats.records.map((record) => ({
            checkinDate: String(record.checkin_date || "").trim(),
            quotaAwarded: Number(record.quota_awarded || 0),
          }))
        : [],
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function refreshAccountCheckinStatus(username, month = currentMonth()) {
  const store = await readStore(CONFIG.storePath);
  const account = store.accounts.find((item) => item.username === username);
  if (!account) {
    throw new Error("Account not found");
  }

  if (!account.password) {
    throw new Error("Account password is required");
  }

  if (!account.session) {
    const loginResult = await loginAndGetSession(account.username, account.password);
    if (!loginResult.ok) {
      throw new Error(`Login failed: ${loginResult.message}`);
    }
    account.session = loginResult.session;
    account.newApiUser = loginResult.newApiUser || account.newApiUser;
    await saveAccountPatch(account.username, {
      password: account.password,
      newApiUser: account.newApiUser,
      session: account.session,
      lastLoginAt: new Date().toISOString(),
    });
  }

  const result = await queryCheckinStatus(account, month);
  await saveAccountPatch(account.username, {
    password: account.password,
    newApiUser: account.newApiUser,
    session: account.session,
    checkinStatus: result.checkinStatus,
  });
  return result;
}

export async function runCheckinStatusRefresh(month = currentMonth()) {
  await ensureStoreFile(CONFIG.storePath);
  const store = await readStore(CONFIG.storePath);
  const accounts = store.accounts.filter((account) => account.username);

  if (accounts.length === 0) {
    throw new Error("未找到可用账号，请先准备 store.json 中的 accounts");
  }

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];

    if (!account.password) {
      console.log(`[${i + 1}/${accounts.length}] 跳过签到状态刷新：${account.username} 缺少密码`);
      failCount += 1;
      continue;
    }

    try {
      await refreshAccountCheckinStatus(account.username, month);
      okCount += 1;
      console.log(`[${i + 1}/${accounts.length}] 签到状态刷新成功 ${account.username}`);
    } catch (error) {
      failCount += 1;
      console.log(
        `[${i + 1}/${accounts.length}] 签到状态刷新失败 ${account.username} ${error?.message || "unknown error"}`,
      );
    }

    if (CONFIG.requestDelayMs > 0 && i < accounts.length - 1) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  console.log(`签到状态刷新完成：成功${okCount}，失败${failCount}`);
}

export async function manualCheckin(username) {
  const store = await readStore(CONFIG.storePath);
  const account = store.accounts.find((item) => item.username === username);
  if (!account) {
    throw new Error("Account not found");
  }

  if (!account.password) {
    throw new Error("Account password is required");
  }

  if (!account.session) {
    const loginResult = await loginAndGetSession(account.username, account.password);
    if (!loginResult.ok) {
      throw new Error(`Login failed: ${loginResult.message}`);
    }
    account.session = loginResult.session;
    account.newApiUser = loginResult.newApiUser || account.newApiUser;
    await saveAccountPatch(account.username, {
      password: account.password,
      newApiUser: account.newApiUser,
      session: account.session,
      lastLoginAt: new Date().toISOString(),
    });
  }

  const result = await checkinWithRetry(account, 1, 1);
  const now = new Date().toISOString();
  const message = String(result?.body?.message || "").replace(/,/g, " ");
  const checkinDate = result?.body?.data?.checkin_date || "";
  const quotaAwarded = result?.body?.data?.quota_awarded ?? "";

  await updateStore(CONFIG.storePath, (latestStore) => {
    upsertAccountInStore(latestStore, {
      username: account.username,
      password: account.password,
      newApiUser: account.newApiUser,
      session: account.session,
      lastCheckinAt: now,
      lastCheckin: {
        status: result.status,
        success: result.ok,
        message,
        checkinDate,
        quotaAwarded,
        time: now,
      },
      checkinStatus: {
        month: currentMonth(),
        checkedInToday: Boolean(result.ok),
        checkinCount: 1,
        totalCheckins: 1,
        totalQuota: Number(quotaAwarded || 0),
        records: checkinDate ? [{ checkinDate, quotaAwarded: Number(quotaAwarded || 0) }] : [],
        updatedAt: now,
      },
    });
    appendCheckinInStore(latestStore, {
      time: now,
      username: account.username,
      newApiUser: account.newApiUser || "",
      status: result.status,
      success: result.ok,
      message,
      checkinDate,
      quotaAwarded,
    });
    return latestStore;
  });

  try {
    await refreshAccountCheckinStatus(account.username, currentMonth());
  } catch {
    // keep manual check-in result even if status refresh fails
  }

  return result;
}

async function checkinWithRetry(account, index, total) {
  for (let attempt = 1; attempt <= CONFIG.maxRetries + 1; attempt += 1) {
    const result = await checkinOnce(account);

    if (result.ok) {
      return result;
    }

    if (result.status === 401) {
        const relogin = await loginAndGetSession(account.username, account.password);
        if (relogin.ok) {
          account.session = relogin.session;
          account.newApiUser = relogin.newApiUser || account.newApiUser;
          await saveAccountPatch(account.username, {
            password: account.password,
            newApiUser: account.newApiUser,
            session: account.session,
            lastLoginAt: new Date().toISOString(),
          });
          if (CONFIG.requestDelayMs > 0) {
            await sleep(CONFIG.requestDelayMs);
          }
        continue;
      }
      return {
        ok: false,
        status: 401,
        body: {
          message: `relogin failed: ${relogin.message}`,
          success: false,
        },
      };
    }

    if (result.status === 429 && attempt <= CONFIG.maxRetries) {
      console.log(
        `[${index}/${total}] 签到限流(429)，5分钟后重试(${attempt}/${CONFIG.maxRetries}) ${account.username}`,
      );
      await sleep(CONFIG.retryDelayMs);
      continue;
    }

    return result;
  }

  return {
    ok: false,
    status: 429,
    body: {
      message: "checkin retry exhausted",
      success: false,
    },
  };
}

export async function runCheckin() {
  await ensureStoreFile(CONFIG.storePath);
  const store = await readStore(CONFIG.storePath);
  const accounts = store.accounts.filter((account) => account.username);

  if (accounts.length === 0) {
    throw new Error("未找到可用账号，请先准备 store.json 中的 accounts");
  }

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < accounts.length; i += 1) {
    const acc = accounts[i];

    if (!acc.password) {
      console.log(`[${i + 1}/${accounts.length}] 跳过：${acc.username} 缺少密码`);
      failCount += 1;
      continue;
    }

    if (!acc.session) {
      const loginResult = await loginAndGetSession(acc.username, acc.password);
      if (!loginResult.ok) {
        console.log(
          `[${i + 1}/${accounts.length}] 登录失败 ${acc.username} ${loginResult.status} ${loginResult.message}`,
        );
        failCount += 1;
        if (CONFIG.requestDelayMs > 0) {
          await sleep(CONFIG.requestDelayMs);
        }
        continue;
      }

      acc.session = loginResult.session;
      acc.newApiUser = loginResult.newApiUser || acc.newApiUser;
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

    const result = await checkinWithRetry(acc, i + 1, accounts.length);
    const now = new Date().toISOString();
    const message = String(result?.body?.message || "").replace(/,/g, " ");
    const checkinDate = result?.body?.data?.checkin_date || "";
    const quotaAwarded = result?.body?.data?.quota_awarded ?? "";

    await updateStore(CONFIG.storePath, (latestStore) => {
      upsertAccountInStore(latestStore, {
        username: acc.username,
        password: acc.password,
        newApiUser: acc.newApiUser,
        session: acc.session,
        lastCheckinAt: now,
        lastCheckin: {
          status: result.status,
          success: result.ok,
          message,
          checkinDate,
          quotaAwarded,
          time: now,
        },
      });
      appendCheckinInStore(latestStore, {
        time: now,
        username: acc.username,
        newApiUser: acc.newApiUser || "",
        status: result.status,
        success: result.ok,
        message,
        checkinDate,
        quotaAwarded,
      });
      return latestStore;
    });

    if (result.ok) {
      okCount += 1;
      console.log(
        `[${i + 1}/${accounts.length}] 签到成功 ${acc.username} ${checkinDate} +${quotaAwarded}`,
      );
    } else {
      failCount += 1;
      console.log(
        `[${i + 1}/${accounts.length}] 签到失败 ${acc.username} ${result.status} ${result?.body?.message || ""}`,
      );
    }

    if (CONFIG.requestDelayMs > 0 && i < accounts.length - 1) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  console.log(`签到完成：成功${okCount}，失败${failCount}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runCheckin().catch((err) => {
    console.error("运行失败:", err);
    process.exit(1);
  });
}
