import { access, appendFile, readFile, writeFile } from "node:fs/promises";

const CONFIG = {
  checkinUrl: process.env.CHECKIN_URL || "https://open.lxcloud.dev/api/user/checkin",
  loginUrl:
    process.env.LOGIN_URL || "https://open.lxcloud.dev/api/user/login?turnstile=",
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  sessionCsvPath: process.env.SESSION_CSV_PATH || "./sessions.csv",
  userIdCsvPath: process.env.USER_ID_CSV_PATH || "./user-ids.csv",
  checkinResultCsvPath:
    process.env.CHECKIN_RESULT_CSV_PATH || "./checkin-results.csv",
  requestDelayMs: Number(process.env.CHECKIN_DELAY_MS || 1000),
  maxRetries: Number(process.env.CHECKIN_MAX_RETRIES || 4),
  retryDelayMs: Number(process.env.CHECKIN_RETRY_DELAY_MS || 300000),
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

async function appendSession(username, password, newApiUser, session) {
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
    Origin: "https://open.lxcloud.dev",
    Referer: "https://open.lxcloud.dev/console/personal",
    Connection: "keep-alive",
    ...((account.newApiUser || CONFIG.defaultNewApiUser)
      ? { "New-API-User": String(account.newApiUser || CONFIG.defaultNewApiUser) }
      : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  const res = await fetch(CONFIG.checkinUrl, {
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
        await appendSession(
          account.username,
          account.password,
          account.newApiUser,
          account.session,
        );
        if (account.newApiUser) {
          await upsertUserId(account.username, account.newApiUser);
        }
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
  await ensureCsvHeader(CONFIG.sessionCsvPath, "username,password,new_api_user,session");
  await normalizeSessionsCsv();
  await ensureCsvHeader(CONFIG.userIdCsvPath, "username,new_api_user");
  await ensureCsvHeader(
    CONFIG.checkinResultCsvPath,
    "time,username,new_api_user,status,success,message,checkin_date,quota_awarded",
  );

  const tokenRows = await readCsvRows(CONFIG.tokenCsvPath);
  const sessionRows = await readCsvRows(CONFIG.sessionCsvPath);
  const userIdRows = await readCsvRows(CONFIG.userIdCsvPath);
  const accounts = Array.from(toAccountMap(tokenRows, sessionRows, userIdRows).values());

  if (accounts.length === 0) {
    throw new Error("未找到可用账号，请先准备 tokens.csv 或 sessions.csv");
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
      await appendSession(acc.username, acc.password, acc.newApiUser, acc.session);
      if (acc.newApiUser) {
        await upsertUserId(acc.username, acc.newApiUser);
      }
      if (CONFIG.requestDelayMs > 0) {
        await sleep(CONFIG.requestDelayMs);
      }
    }

    const result = await checkinWithRetry(acc, i + 1, accounts.length);
    const now = new Date().toISOString();
    const message = String(result?.body?.message || "").replace(/,/g, " ");
    const checkinDate = result?.body?.data?.checkin_date || "";
    const quotaAwarded = result?.body?.data?.quota_awarded ?? "";

    await appendFile(
      CONFIG.checkinResultCsvPath,
      `${now},${acc.username},${acc.newApiUser || ""},${result.status},${result.ok},${message},${checkinDate},${quotaAwarded}\n`,
      "utf8",
    );

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
