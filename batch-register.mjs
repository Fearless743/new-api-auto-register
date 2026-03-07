import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const CONFIG = {
  baseUrl:
    process.env.REGISTER_URL ||
    "https://open.lxcloud.dev/api/user/register?turnstile=",
  loginUrl:
    process.env.LOGIN_URL ||
    "https://open.lxcloud.dev/api/user/login?turnstile=",
  tokenCreateUrl:
    process.env.TOKEN_CREATE_URL || "https://open.lxcloud.dev/api/token/",
  tokenListUrl:
    process.env.TOKEN_LIST_URL ||
    "https://open.lxcloud.dev/api/token/?p=1&size=10",
  count: Number(process.env.COUNT || 10),
  requestDelayMs: Number(process.env.DELAY_MS || 5000),
  operationDelayMs: Number(process.env.OP_DELAY_MS || 1000),
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  tokenRawPath: process.env.TOKEN_TXT_PATH || "./tokens.txt",
  sessionCsvPath: process.env.SESSION_CSV_PATH || "./sessions.csv",
  userIdCsvPath: process.env.USER_ID_CSV_PATH || "./user-ids.csv",
  tokenNamePrefix: process.env.TOKEN_NAME_PREFIX || "autotoken",
  usernamePrefix: process.env.USERNAME_PREFIX || "u",
  usernameMaxLen: Number(process.env.USERNAME_MAX_LEN || 12),
  passwordLen: Number(process.env.PASSWORD_LEN || 12),
  registerMaxRetries: Number(process.env.REGISTER_MAX_RETRIES || 4),
  rateLimitRetryDelayMs: Number(process.env.RATE_LIMIT_RETRY_DELAY_MS || 30000),
  extraCookies: process.env.EXTRA_COOKIES || "",
  defaultNewApiUser: process.env.NEW_API_USER || "",
  staticAccessToken: process.env.ACCESS_TOKEN || "",
};

function asBool(value, defaultValue) {
  if (value == null || value === "") {
    return defaultValue;
  }
  return String(value).toLowerCase() === "true";
}

function asNumber(value, defaultValue) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

const TOKEN_CONFIG = {
  remainQuota: asNumber(process.env.TOKEN_REMAIN_QUOTA, 0),
  expiredTime: asNumber(process.env.TOKEN_EXPIRED_TIME, -1),
  unlimitedQuota: asBool(process.env.TOKEN_UNLIMITED_QUOTA, true),
  modelLimitsEnabled: asBool(process.env.TOKEN_MODEL_LIMITS_ENABLED, false),
  modelLimits: process.env.TOKEN_MODEL_LIMITS || "",
  crossGroupRetry: asBool(process.env.TOKEN_CROSS_GROUP_RETRY, false),
  group: process.env.TOKEN_GROUP || "",
  allowIps: process.env.TOKEN_ALLOW_IPS || "",
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

async function ensureFileExists(filePath) {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, "", "utf8");
  }
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

function randomText(len = 10) {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

function randomAlnum(len = 10) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generateCredential(index) {
  const maxLen = Math.max(3, CONFIG.usernameMaxLen);
  const safePrefix =
    (CONFIG.usernamePrefix || "u")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, Math.max(1, maxLen - 1)) || "u";

  const bodyLen = Math.max(1, maxLen - safePrefix.length);
  const timeHint = (Date.now() + index).toString(36).slice(-3);
  const randomCoreLen = Math.max(1, bodyLen - Math.min(3, bodyLen));
  const randomCore = randomAlnum(randomCoreLen);
  const username = `${safePrefix}${randomCore}${timeHint}`.slice(0, maxLen);
  const password = `P@${randomText(Math.max(8, CONFIG.passwordLen))}`;
  return { username, password };
}

function buildHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language":
      "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Origin: "https://open.lxcloud.dev",
    Referer: `https://open.lxcloud.dev/register`,
    Connection: "keep-alive",
  };

  if (CONFIG.extraCookies) {
    headers.Cookie = CONFIG.extraCookies;
  }
  if (CONFIG.defaultNewApiUser) {
    headers["New-API-User"] = String(CONFIG.defaultNewApiUser);
  }

  return headers;
}

function buildLoginHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language":
      "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Origin: "https://open.lxcloud.dev",
    Referer: "https://open.lxcloud.dev/login",
    Connection: "keep-alive",
  };

  if (CONFIG.extraCookies) {
    headers.Cookie = CONFIG.extraCookies;
  }
  if (CONFIG.defaultNewApiUser) {
    headers["New-API-User"] = String(CONFIG.defaultNewApiUser);
  }

  return headers;
}

function readSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") {
    const all = headers.getSetCookie();
    if (Array.isArray(all) && all.length > 0) {
      return all;
    }
  }

  const single = headers.get("set-cookie");
  if (!single) {
    return [];
  }

  const parsed = [];
  const regex = /(?:^|,\s*)([!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;,\r\n]*)/g;
  let match = regex.exec(single);
  while (match) {
    parsed.push(match[1]);
    match = regex.exec(single);
  }

  if (parsed.length > 0) {
    return parsed;
  }

  return [single];
}

function extractCookiePairs(setCookies) {
  const pairs = [];

  for (const line of setCookies) {
    const chunks = String(line).split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g);
    for (const chunk of chunks) {
      const first = chunk.split(";")[0]?.trim();
      if (first && first.includes("=")) {
        pairs.push(first);
      }
    }
  }

  return Array.from(new Set(pairs));
}

function pickSessionCookie(cookiePairs) {
  return cookiePairs.find((item) => item.startsWith("session=")) || "";
}

function extractSessionFromHeaderText(text) {
  if (!text) {
    return "";
  }
  const match = String(text).match(/(?:^|[;,\s])session=([^;\s,]+)/);
  if (!match) {
    return "";
  }
  return `session=${match[1]}`;
}

function readSessionFallback(headers) {
  const direct = extractSessionFromHeaderText(headers.get("set-cookie"));
  if (direct) {
    return direct;
  }

  for (const [key, value] of headers.entries()) {
    if (String(key).toLowerCase().includes("cookie")) {
      const maybe = extractSessionFromHeaderText(value);
      if (maybe) {
        return maybe;
      }
    }
  }

  return "";
}

function buildCookieHeader(setCookies) {
  const cookiePairs = extractCookiePairs(setCookies);
  const sessionCookie = pickSessionCookie(cookiePairs);
  const dynamicCookies = sessionCookie || cookiePairs.join("; ");

  if (dynamicCookies && CONFIG.extraCookies) {
    return `${CONFIG.extraCookies}; ${dynamicCookies}`;
  }
  return dynamicCookies || CONFIG.extraCookies;
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

  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    return String(candidate);
  }

  return "";
}

function tokenApiHeaders(cookieHeader, newApiUser, includeBody) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language":
      "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cache-Control": "no-store",
    Origin: "https://open.lxcloud.dev",
    Referer: "https://open.lxcloud.dev/console/token",
    Connection: "keep-alive",
  };

  if (includeBody) {
    headers["Content-Type"] = "application/json";
  }
  if (newApiUser || CONFIG.defaultNewApiUser) {
    headers["New-API-User"] = String(newApiUser || CONFIG.defaultNewApiUser);
  }
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  return headers;
}

function parsePossibleAccessToken(response) {
  const candidates = [
    response?.data?.access_token,
    response?.data?.accessToken,
    response?.data?.token,
    response?.access_token,
    response?.accessToken,
    response?.token,
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    return String(candidate);
  }
  return "";
}

async function parseResponseBody(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function parseRetryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return 0;
  }

  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric * 1000;
  }

  const dateTs = Date.parse(retryAfter);
  if (Number.isFinite(dateTs)) {
    return Math.max(0, dateTs - Date.now());
  }

  return 0;
}

function computeRateLimitDelay(attempt, headers) {
  void attempt;
  void headers;
  return CONFIG.rateLimitRetryDelayMs;
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

async function registerOne(index) {
  const { username, password } = generateCredential(index);
  const payload = {
    username,
    password,
    password2: password,
    email: "",
    verification_code: "",
    wechat_verification_code: "",
    aff_code: "",
  };

  const startedAt = new Date().toISOString();
  const requestHeaders = buildHeaders();

  for (
    let attempt = 1;
    attempt <= CONFIG.registerMaxRetries + 1;
    attempt += 1
  ) {
    try {
      const res = await fetch(CONFIG.baseUrl, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });

      const parsed = await parseResponseBody(res);
      const ok = isApiSuccess(res.ok, parsed);

      if (res.status === 429 && attempt <= CONFIG.registerMaxRetries) {
        const waitMs = computeRateLimitDelay(attempt, res.headers);
        console.log(
          `[${index}] 注册限流(429)，30秒后重试(${attempt}/${CONFIG.registerMaxRetries}) 用户=${username}`,
        );
        await sleep(waitMs);
        continue;
      }

      return {
        ok,
        httpOk: res.ok,
        status: res.status,
        attempt,
        startedAt,
        username,
        password,
        requestUrl: CONFIG.baseUrl,
        requestHeaders,
        response: parsed,
      };
    } catch (error) {
      if (attempt <= CONFIG.registerMaxRetries) {
        const waitMs = computeRateLimitDelay(attempt, new Headers());
        await sleep(waitMs);
        continue;
      }

      return {
        ok: false,
        status: -1,
        attempt,
        startedAt,
        username,
        password,
        requestUrl: CONFIG.baseUrl,
        requestHeaders,
        response: { error: String(error?.message || error) },
      };
    }
  }

  return {
    ok: false,
    status: -1,
    attempt: CONFIG.registerMaxRetries + 1,
    startedAt,
    username,
    password,
    requestUrl: CONFIG.baseUrl,
    requestHeaders,
    response: { error: "register attempts exhausted" },
  };
}

async function loginOne(username, password) {
  const payload = { username, password };
  const startedAt = new Date().toISOString();

  try {
    const requestHeaders = buildLoginHeaders();
    const res = await fetch(CONFIG.loginUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(payload),
    });

    const parsed = await parseResponseBody(res);
    const ok = isApiSuccess(res.ok, parsed);

    const setCookies = readSetCookie(res.headers);
    const fallbackSession = readSessionFallback(res.headers);
    if (
      fallbackSession &&
      !setCookies.some((item) => String(item).startsWith("session="))
    ) {
      setCookies.push(fallbackSession);
    }
    const cookieHeader = buildCookieHeader(setCookies);
    const newApiUser = parsePossibleUserId(parsed) || CONFIG.defaultNewApiUser || "";
    const accessToken =
      parsePossibleAccessToken(parsed) || CONFIG.staticAccessToken;

    return {
      ok,
      httpOk: res.ok,
      status: res.status,
      startedAt,
      username,
      requestUrl: CONFIG.loginUrl,
      requestHeaders,
      responseSetCookieRaw: res.headers.get("set-cookie") || "",
      response: parsed,
      setCookies,
      cookieHeader,
      newApiUser,
      accessToken,
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      startedAt,
      username,
      requestUrl: CONFIG.loginUrl,
      requestHeaders: buildLoginHeaders(),
      responseSetCookieRaw: "",
      response: { error: String(error?.message || error) },
      setCookies: [],
      cookieHeader: "",
      newApiUser: CONFIG.defaultNewApiUser || "",
      accessToken: CONFIG.staticAccessToken,
    };
  }
}

function buildTokenName(username) {
  return `${CONFIG.tokenNamePrefix}-${username}`;
}

function extractTokenValue(response) {
  const candidates = [
    response?.data?.key,
    response?.data?.token,
    response?.data?.value,
    response?.key,
    response?.token,
    response?.value,
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    return String(candidate);
  }
  return "";
}

function extractTokenId(response) {
  const candidates = [
    response?.data?.id,
    response?.data?.token_id,
    response?.id,
    response?.token_id,
  ];

  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    return String(candidate);
  }
  return "";
}

function extractTokenFromList(response, tokenName) {
  const items = response?.data?.items;
  if (!Array.isArray(items)) {
    return "";
  }

  const byName = tokenName
    ? items.find((item) => item?.name === tokenName)
    : null;
  const target = byName || items[0];
  const key = target?.key;
  return key == null || key === "" ? "" : String(key);
}

async function createTokenOne(loginResult) {
  const startedAt = new Date().toISOString();
  const name = buildTokenName(loginResult.username);
  const payload = {
    remain_quota: TOKEN_CONFIG.remainQuota,
    expired_time: TOKEN_CONFIG.expiredTime,
    unlimited_quota: TOKEN_CONFIG.unlimitedQuota,
    model_limits_enabled: TOKEN_CONFIG.modelLimitsEnabled,
    model_limits: TOKEN_CONFIG.modelLimits,
    cross_group_retry: TOKEN_CONFIG.crossGroupRetry,
    name,
    group: TOKEN_CONFIG.group,
    allow_ips: TOKEN_CONFIG.allowIps,
  };

  try {
    const requestHeaders = {
      ...tokenApiHeaders(loginResult.cookieHeader, loginResult.newApiUser, true),
      ...(loginResult.accessToken
        ? { Authorization: `Bearer ${loginResult.accessToken}` }
        : {}),
    };

    const res = await fetch(CONFIG.tokenCreateUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(payload),
    });

    const parsed = await parseResponseBody(res);
    const ok = isApiSuccess(res.ok, parsed);

    return {
      ok,
      httpOk: res.ok,
      status: res.status,
      startedAt,
      username: loginResult.username,
      requestUrl: CONFIG.tokenCreateUrl,
      requestHeaders,
      tokenName: name,
      tokenId: extractTokenId(parsed),
      tokenValue: extractTokenValue(parsed),
      response: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      startedAt,
      username: loginResult.username,
      requestUrl: CONFIG.tokenCreateUrl,
      requestHeaders: {
        ...tokenApiHeaders(loginResult.cookieHeader, loginResult.newApiUser, true),
        ...(loginResult.accessToken
          ? { Authorization: `Bearer ${loginResult.accessToken}` }
          : {}),
      },
      tokenName: name,
      tokenId: "",
      tokenValue: "",
      response: { error: String(error?.message || error) },
    };
  }
}

async function listTokensOne(loginResult) {
  const startedAt = new Date().toISOString();

  try {
    const requestHeaders = {
      ...tokenApiHeaders(loginResult.cookieHeader, loginResult.newApiUser, false),
      ...(loginResult.accessToken
        ? { Authorization: `Bearer ${loginResult.accessToken}` }
          : {}),
    };

    const res = await fetch(CONFIG.tokenListUrl, {
      method: "GET",
      headers: requestHeaders,
    });

    const parsed = await parseResponseBody(res);
    const ok = isApiSuccess(res.ok, parsed);

    return {
      ok,
      httpOk: res.ok,
      status: res.status,
      startedAt,
      username: loginResult.username,
      requestUrl: CONFIG.tokenListUrl,
      requestHeaders,
      response: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      startedAt,
      username: loginResult.username,
      requestUrl: CONFIG.tokenListUrl,
      requestHeaders: {
        ...tokenApiHeaders(loginResult.cookieHeader, loginResult.newApiUser, false),
        ...(loginResult.accessToken
          ? { Authorization: `Bearer ${loginResult.accessToken}` }
          : {}),
      },
      response: { error: String(error?.message || error) },
    };
  }
}

async function main() {
  if (!Number.isFinite(CONFIG.count) || CONFIG.count <= 0) {
    throw new Error("COUNT 必须是大于 0 的数字");
  }

  await ensureCsvHeader(CONFIG.tokenCsvPath, "username,password,token");
  await ensureFileExists(CONFIG.tokenRawPath);
  await ensureCsvHeader(CONFIG.sessionCsvPath, "username,password,new_api_user,session");
  await ensureCsvHeader(CONFIG.userIdCsvPath, "username,new_api_user");

  let success = 0;
  let failed = 0;
  let loginSuccess = 0;
  let loginFailed = 0;
  let tokenCreateSuccess = 0;
  let tokenCreateFailed = 0;
  let tokenListSuccess = 0;
  let tokenListFailed = 0;

  for (let i = 0; i < CONFIG.count; i += 1) {
    const result = await registerOne(i + 1);

    if (result.ok) {
      success += 1;
      console.log(
        `[${i + 1}/${CONFIG.count}] 注册成功(${result.status}) ${result.username}`,
      );

      if (CONFIG.operationDelayMs > 0) {
        await sleep(CONFIG.operationDelayMs);
      }
      const loginResult = await loginOne(result.username, result.password);
      if (loginResult.ok) {
        loginSuccess += 1;
        const sessionCookie = pickSessionCookie(extractCookiePairs(loginResult.setCookies));
        await upsertSession(
          result.username,
          result.password,
          loginResult.newApiUser,
          sessionCookie,
        );
        if (loginResult.newApiUser) {
          await upsertUserId(result.username, loginResult.newApiUser);
        }
        console.log(
          `[${i + 1}/${CONFIG.count}] 登录成功(${loginResult.status}) ${result.username}`,
        );

        if (CONFIG.operationDelayMs > 0) {
          await sleep(CONFIG.operationDelayMs);
        }
        const tokenCreateResult = await createTokenOne(loginResult);

        if (tokenCreateResult.ok) {
          tokenCreateSuccess += 1;
          console.log(
            `[${i + 1}/${CONFIG.count}] 创建令牌成功(${tokenCreateResult.status}) ${result.username}`,
          );
        } else {
          tokenCreateFailed += 1;
          console.log(
            `[${i + 1}/${CONFIG.count}] 创建令牌失败(${tokenCreateResult.status}) ${result.username}`,
          );
        }

        if (CONFIG.operationDelayMs > 0) {
          await sleep(CONFIG.operationDelayMs);
        }
        const tokenListResult = await listTokensOne(loginResult);

        if (tokenListResult.ok) {
          tokenListSuccess += 1;
          console.log(
            `[${i + 1}/${CONFIG.count}] 令牌列表成功(${tokenListResult.status}) ${result.username}`,
          );
        } else {
          tokenListFailed += 1;
          console.log(
            `[${i + 1}/${CONFIG.count}] 令牌列表失败(${tokenListResult.status}) ${result.username}`,
          );
        }

        if (tokenCreateResult.ok) {
          const tokenFromList = tokenListResult.ok
            ? extractTokenFromList(
                tokenListResult.response,
                tokenCreateResult.tokenName,
              )
            : "";
          const finalTokenValue =
            "sk-" + (tokenCreateResult.tokenValue || tokenFromList);

          await appendFile(
            CONFIG.tokenCsvPath,
            `${result.username},${result.password},${finalTokenValue}\n`,
            "utf8",
          );

          if (finalTokenValue) {
            await appendFile(
              CONFIG.tokenRawPath,
              `${finalTokenValue}\n`,
              "utf8",
            );
          }
        }
      } else {
        loginFailed += 1;
        const reason = loginResult?.response?.message
          ? ` - ${loginResult.response.message}`
          : "";
        console.log(
          `[${i + 1}/${CONFIG.count}] 登录失败(${loginResult.status}) ${result.username}${reason}`,
        );
      }
    } else {
      failed += 1;
      console.log(
        `[${i + 1}/${CONFIG.count}] 注册失败(${result.status}) ${result.username}`,
      );
    }

    if (i < CONFIG.count - 1 && CONFIG.requestDelayMs > 0) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  console.log(
    `完成：注册 成功${success}/失败${failed}，登录 成功${loginSuccess}/失败${loginFailed}，创建令牌 成功${tokenCreateSuccess}/失败${tokenCreateFailed}，查询令牌 成功${tokenListSuccess}/失败${tokenListFailed}`,
  );
}

main().catch((err) => {
  console.error("运行失败:", err);
  process.exit(1);
});
