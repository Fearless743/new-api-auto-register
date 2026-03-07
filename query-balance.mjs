import { access, appendFile, readFile, writeFile } from "node:fs/promises";

const CONFIG = {
  selfUrl: process.env.SELF_URL || "https://open.lxcloud.dev/api/user/self",
  loginUrl:
    process.env.LOGIN_URL || "https://open.lxcloud.dev/api/user/login?turnstile=",
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  sessionCsvPath: process.env.SESSION_CSV_PATH || "./sessions.csv",
  balanceCsvPath: process.env.BALANCE_CSV_PATH || "./balances.csv",
  userIdCsvPath: process.env.USER_ID_CSV_PATH || "./user-ids.csv",
  requestDelayMs: Number(process.env.QUERY_DELAY_MS || 1000),
  extraCookies: process.env.EXTRA_COOKIES || "",
  defaultNewApiUser: process.env.NEW_API_USER || "",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureCsvHeader(filePath, headerLine) {
  try {
    await access(filePath);
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) {
      await writeFile(filePath, `${headerLine}\n`, "utf8");
      return;
    }
    if (!content.startsWith(`${headerLine}\n`) && content !== headerLine) {
      await writeFile(filePath, `${headerLine}\n${content}`, "utf8");
    }
  } catch {
    await writeFile(filePath, `${headerLine}\n`, "utf8");
  }
}

async function readCsvRows(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) {
      return [];
    }
    const header = lines[0].split(",").map((x) => x.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const values = lines[i].split(",");
      const row = {};
      for (let j = 0; j < header.length; j += 1) {
        row[header[j]] = (values[j] || "").trim();
      }

      const hasAnyValue = header.some((key) => String(row[key] || "").trim() !== "");
      if (!hasAnyValue) {
        continue;
      }

      const isDuplicateHeader = header.every(
        (key) => String(row[key] || "").toLowerCase() === String(key).toLowerCase(),
      );
      if (isDuplicateHeader) {
        continue;
      }

      rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

function toAccountMap(tokenRows, sessionRows, userIdRows) {
  const map = new Map();

  const isPlaceholder = (value, expected) =>
    String(value || "").trim().toLowerCase() === expected;

  for (const row of tokenRows) {
    const username = row.username || "";
    const password = row.password || "";
    if (isPlaceholder(username, "username") || isPlaceholder(password, "password")) {
      continue;
    }
    if (!username || !password) {
      continue;
    }
    map.set(username, {
      username,
      password,
      newApiUser: "",
      session: "",
    });
  }

  for (const row of sessionRows) {
    const username = row.username || "";
    const password = row.password || "";
    if (isPlaceholder(username, "username") || isPlaceholder(password, "password")) {
      continue;
    }
    if (!username) {
      continue;
    }
    const prev = map.get(username) || {
      username,
      password: row.password || "",
      newApiUser: "",
      session: "",
    };
    prev.password = prev.password || row.password || "";
    prev.newApiUser = row.new_api_user || prev.newApiUser || "";
    prev.session = row.session || prev.session || "";
    map.set(username, prev);
  }

  for (const row of userIdRows) {
    const username = row.username || "";
    if (isPlaceholder(username, "username")) {
      continue;
    }
    if (!username) {
      continue;
    }
    const prev = map.get(username) || {
      username,
      password: row.password || "",
      newApiUser: "",
      session: "",
    };
    prev.newApiUser = row.new_api_user || prev.newApiUser || "";
    map.set(username, prev);
  }

  return map;
}

async function upsertUserId(username, newApiUser) {
  if (!username || !newApiUser) {
    return;
  }

  await ensureCsvHeader(CONFIG.userIdCsvPath, "username,new_api_user");

  const content = await readFile(CONFIG.userIdCsvPath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const header = lines[0] || "username,new_api_user";
  const rows = lines.slice(1);

  const filtered = rows.filter((line) => {
    const first = line.split(",")[0]?.trim();
    return first !== username;
  });

  filtered.push(`${username},${newApiUser}`);
  await writeFile(CONFIG.userIdCsvPath, `${header}\n${filtered.join("\n")}\n`, "utf8");
}

async function upsertSession(username, password, newApiUser, session) {
  if (!username) {
    return;
  }

  await ensureCsvHeader(CONFIG.sessionCsvPath, "username,password,new_api_user,session");

  const content = await readFile(CONFIG.sessionCsvPath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const header = lines[0] || "username,password,new_api_user,session";
  const rows = lines.slice(1);

  const filtered = rows.filter((line) => {
    const first = line.split(",")[0]?.trim();
    return first !== username;
  });

  filtered.push(`${username},${password || ""},${newApiUser || ""},${session || ""}`);
  await writeFile(CONFIG.sessionCsvPath, `${header}\n${filtered.join("\n")}\n`, "utf8");
}

async function normalizeSessionsCsv() {
  await ensureCsvHeader(CONFIG.sessionCsvPath, "username,password,new_api_user,session");

  const content = await readFile(CONFIG.sessionCsvPath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  const header = lines[0] || "username,password,new_api_user,session";
  const rows = lines.slice(1);

  const seen = new Set();
  const latestRows = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const username = row.split(",")[0]?.trim();
    if (!username || seen.has(username)) {
      continue;
    }
    seen.add(username);
    latestRows.unshift(row);
  }

  await writeFile(
    CONFIG.sessionCsvPath,
    `${header}${latestRows.length ? `\n${latestRows.join("\n")}` : ""}\n`,
    "utf8",
  );
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
    Origin: "https://open.lxcloud.dev",
    Referer: "https://open.lxcloud.dev/login",
    Connection: "keep-alive",
    ...(CONFIG.defaultNewApiUser
      ? { "New-API-User": String(CONFIG.defaultNewApiUser) }
      : {}),
    ...(CONFIG.extraCookies ? { Cookie: CONFIG.extraCookies } : {}),
  };

  const res = await fetch(CONFIG.loginUrl, {
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

async function fetchSelf(account) {
  const cookieHeader = combineCookies(account.session);
  const headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    Referer: "https://open.lxcloud.dev/console/topup",
    ...((account.newApiUser || CONFIG.defaultNewApiUser)
      ? { "New-API-User": String(account.newApiUser || CONFIG.defaultNewApiUser) }
      : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const res = await fetch(CONFIG.selfUrl, { method: "GET", headers });
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

async function main() {
  await ensureCsvHeader(CONFIG.sessionCsvPath, "username,password,new_api_user,session");
  await normalizeSessionsCsv();
  await ensureCsvHeader(CONFIG.balanceCsvPath, "username,quota,balance");
  await ensureCsvHeader(CONFIG.userIdCsvPath, "username,new_api_user");

  const tokenRows = await readCsvRows(CONFIG.tokenCsvPath);
  const sessionRows = await readCsvRows(CONFIG.sessionCsvPath);
  const userIdRows = await readCsvRows(CONFIG.userIdCsvPath);
  const accounts = Array.from(toAccountMap(tokenRows, sessionRows, userIdRows).values());

  if (accounts.length === 0) {
    throw new Error("未找到可用账号，请先准备 tokens.csv 或 sessions.csv");
  }

  let totalQuota = 0;

  for (let i = 0; i < accounts.length; i += 1) {
    const acc = accounts[i];

    if (!acc.newApiUser && acc.password) {
      const loginForUserId = await loginAndGetSession(acc.username, acc.password);
      if (loginForUserId.ok && loginForUserId.newApiUser) {
        acc.newApiUser = loginForUserId.newApiUser;
        acc.session = loginForUserId.session || acc.session;
        await upsertUserId(acc.username, acc.newApiUser);
        await upsertSession(acc.username, acc.password, acc.newApiUser, acc.session);
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
        if (acc.newApiUser) {
          await upsertUserId(acc.username, acc.newApiUser);
        }
        await upsertSession(acc.username, acc.password, acc.newApiUser, acc.session);
      } else {
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
        if (acc.newApiUser) {
          await upsertUserId(acc.username, acc.newApiUser);
        }
        await upsertSession(acc.username, acc.password, acc.newApiUser, acc.session);
        if (CONFIG.requestDelayMs > 0) {
          await sleep(CONFIG.requestDelayMs);
        }
        selfResult = await fetchSelf(acc);
      }
    }

    if (selfResult.ok) {
      const quota = selfResult.body?.data?.quota ?? 0;
      const balance = quotaToUsd(quota);
      totalQuota += Number(quota) || 0;
      await appendFile(
        CONFIG.balanceCsvPath,
        `${acc.username},${quota},${balance}\n`,
        "utf8",
      );
      console.log(`${acc.username}: ${balance}`);
    }

    if (CONFIG.requestDelayMs > 0 && i < accounts.length - 1) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  console.log(`总余额: ${quotaToUsd(totalQuota)}`);
}

main().catch((err) => {
  console.error("运行失败:", err);
  process.exit(1);
});
