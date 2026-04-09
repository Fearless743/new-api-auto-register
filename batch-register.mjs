import "./env-bootstrap.mjs";
import { randomBytes } from "node:crypto";
import {
  ensureStoreFile,
  findAccount,
  getBaseUrlFromStore,
  readStore,
  setBaseUrlInStore,
  updateStore,
  upsertAccountInStore,
} from "./storage.mjs";

const CONFIG = {
  baseUrl: process.env.BASE_URL || "https://ai.xem8k5.top",
  enableEmail: asBool(process.env.ENABLE_EMAIL, false),
  count: Number(process.env.COUNT || 10),
  requestDelayMs: Number(process.env.DELAY_MS || 5000),
  operationDelayMs: Number(process.env.OP_DELAY_MS || 1000),
  storePath: process.env.STORE_PATH || "./data/store.json",
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

const REGISTER_URL = `${CONFIG.baseUrl}/api/user/register?turnstile=`;
const LOGIN_URL = `${CONFIG.baseUrl}/api/user/login?turnstile=`;
const TOKEN_CREATE_URL = `${CONFIG.baseUrl}/api/token/`;
const TOKEN_LIST_URL = `${CONFIG.baseUrl}/api/token/?p=1&size=10`;
const VERIFY_EMAIL_URL = `${CONFIG.baseUrl}/api/verification`;

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
  remainQuota: 0,
  expiredTime: -1,
  unlimitedQuota: true,
  modelLimitsEnabled: false,
  modelLimits: "",
  crossGroupRetry: false,
  group: "",
  allowIps: "",
};

function resolveCount(inputCount) {
  if (inputCount == null || inputCount === "") {
    return CONFIG.count;
  }

  const parsed = Number(inputCount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("COUNT 必须是大于 0 的数字");
  }

  return Math.floor(parsed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveAccountPatch(username, patch) {
  await updateStore(CONFIG.storePath, (store) => {
    upsertAccountInStore(store, { username, ...patch });
    return store;
  });
}

async function syncBaseUrlToStore() {
  await updateStore(CONFIG.storePath, (store) => setBaseUrlInStore(store, CONFIG.baseUrl));
}

async function resolveBaseUrl() {
  const store = await readStore(CONFIG.storePath);
  const storedBaseUrl = getBaseUrlFromStore(store);
  if (storedBaseUrl) {
    CONFIG.baseUrl = storedBaseUrl;
  }
  return CONFIG.baseUrl;
}

function workflowStateFromResult(result, fallbackMessage) {
  return {
    status: result?.ok ? "success" : "failed",
    lastRunAt: new Date().toISOString(),
    httpStatus: result?.status ?? null,
    message: String(
      result?.response?.message ||
        result?.response?.error ||
        result?.response?.raw ||
        fallbackMessage ||
        "",
    ).trim(),
    requestUrl: result?.requestUrl || "",
    attempt: result?.attempt ?? null,
  };
}

async function saveWorkflowStep(
  username,
  password,
  step,
  result,
  extraPatch = {},
) {
  await saveAccountPatch(username, {
    ...(password ? { password } : {}),
    workflow: {
      [step]: workflowStateFromResult(result),
    },
    ...extraPatch,
  });
}

async function registerWithCredential(username, password) {
  let payload = {
    username,
    password,
    password2: password,
    email: "",
    verification_code: "",
    wechat_verification_code: "",
    aff_code: "",
  };
  if (CONFIG.enableEmail) {
    // Emailnator 方案实现
    const emailnatorHeaders = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: "https://www.emailnator.com",
      Referer: "https://www.emailnator.com/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
    };

    // 1. 获取初始 Session 和 XSRF Token
    const initRes = await fetch("https://www.emailnator.com/");
    const initCookies = readSetCookie(initRes.headers);
    let xsrfToken =
      extractCookiePairs(initCookies)
        .find((c) => c.startsWith("XSRF-TOKEN="))
        ?.split("=")[1]
        ?.replace(/%3D/g, "=") || "";
    let sessionToken =
      extractCookiePairs(initCookies)
        .find((c) => c.startsWith("gmailnator_session="))
        ?.split("=")[1] || "";

    const updateAuthHeaders = (cookies) => {
      const pairs = extractCookiePairs(cookies);
      const newXsrf = pairs
        .find((c) => c.startsWith("XSRF-TOKEN="))
        ?.split("=")[1]
        ?.replace(/%3D/g, "=");
      const newSesh = pairs
        .find((c) => c.startsWith("gmailnator_session="))
        ?.split("=")[1];
      if (newXsrf) xsrfToken = newXsrf;
      if (newSesh) sessionToken = newSesh;

      emailnatorHeaders["X-Xsrf-Token"] = xsrfToken;
      emailnatorHeaders["Cookie"] =
        `XSRF-TOKEN=${xsrfToken.replace(/=/g, "%3D")}; gmailnator_session=${sessionToken};`;
    };

    updateAuthHeaders(initCookies);

    // 2. 生成邮箱
    console.log("正在通过 Emailnator 生成临时邮箱...");
    const genRes = await fetch("https://www.emailnator.com/generate-email", {
      method: "POST",
      headers: emailnatorHeaders,
      body: JSON.stringify({ email: ["plusGmail", "dotGmail"] }),
    });
    updateAuthHeaders(readSetCookie(genRes.headers));
    const genData = await genRes.json();
    payload.email = genData.email[0];
    console.log(`获取到 Emailnator 邮箱: ${payload.email}`);

    // 3. 验证邮件发送 (原有逻辑保持，仅替换邮件接收部分)
    console.log(`正在发送验证邮件... email=${payload.email}`);
    await fetch(VERIFY_EMAIL_URL + "?email=" + payload.email + "&turnstile=");

    const maxRetries = 30;
    let retries = 0;
    while (payload.verification_code == "" && retries < maxRetries) {
      retries++;
      await sleep(10000);
      console.log(
        `[${retries}/${maxRetries}] 正在 Emailnator 检查新邮件... email=${payload.email}`,
      );

      try {
        updateAuthHeaders([]); // 保持当前的 Cookie 状态
        const listRes = await fetch("https://www.emailnator.com/message-list", {
          method: "POST",
          headers: emailnatorHeaders,
          body: JSON.stringify({ email: payload.email }),
        });

        if (listRes.status === 429) {
          console.warn(
            `[${retries}/${maxRetries}] Emailnator 限流(429)，等待 10 秒...`,
          );
          await sleep(10000);
          continue;
        }

        updateAuthHeaders(readSetCookie(listRes.headers));
        const listText = await listRes.text();
        let listData;
        try {
          listData = JSON.parse(listText);
        } catch (e) {
          console.warn(
            `[${retries}/${maxRetries}] Emailnator 响应解析失败 (可能被限流或 HTML 报错):`,
            listText.slice(0, 100),
          );
          continue;
        }
        console.log(listData);
        const message = listData.messageData?.find(
          (m) => m.messageID !== "ADSVPN",
        );

        if (message) {
          // 如果 messageID 看起来像是非法的（比如 ADSVPN 这种干扰项），我们可以根据长度或格式过滤
          if (!message.messageID || message.messageID.length < 5) {
            console.log(`跳过疑似无效的 MessageID: ${message.messageID}`);
            continue;
          }
          console.log(`发现匹配邮件，ID: ${message.messageID}`);
          const msgRes = await fetch(
            "https://www.emailnator.com/message-list",
            {
              method: "POST",
              headers: emailnatorHeaders,
              body: JSON.stringify({
                email: payload.email,
                messageID: message.messageID,
              }),
            },
          );
          updateAuthHeaders(readSetCookie(msgRes.headers));
          const msgContent = await msgRes.text();
          const codeMatch =
            msgContent.match(/<strong>(\w+)<\/strong>/) ||
            msgContent.match(/(\d{6})/); // 兼容不同格式
          if (codeMatch) {
            payload.verification_code = codeMatch[1];
            console.log(`成功获取验证码: ${payload.verification_code}`);
          }
        } else {
          console.log(`[${retries}/${maxRetries}] 暂未发现目标邮件...`);
        }
      } catch (e) {
        console.warn(
          `[${retries}/${maxRetries}] Emailnator 接口请求失败:`,
          e.message,
        );
      }
    }

    if (payload.verification_code == "") {
      console.error(`[${username}] 最终未获取到验证码，放弃本次注册`);
      return {
        ok: false,
        status: -1,
        startedAt: new Date().toISOString(),
        username,
        password,
        requestUrl: "email-timeout",
        requestHeaders: {},
        response: { error: "Timed out waiting for verification code" },
      };
    }
  }

  const startedAt = new Date().toISOString();
  const requestHeaders = buildHeaders();

  console.log(`[${username}] 正在提交注册请求...`);
  for (
    let attempt = 1;
    attempt <= CONFIG.registerMaxRetries + 1;
    attempt += 1
  ) {
    try {
      const res = await fetch(REGISTER_URL, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });

      const parsed = await parseResponseBody(res);
      const ok = isApiSuccess(res.ok, parsed);
      console.log(`[${username}] 注册响应: status=${res.status} ok=${ok}`);

      if (res.status === 429 && attempt <= CONFIG.registerMaxRetries) {
        const waitMs = computeRateLimitDelay(attempt, res.headers);
        console.log(
          `注册限流(429)，30秒后重试(${attempt}/${CONFIG.registerMaxRetries}) 用户=${username}`,
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
        requestUrl: REGISTER_URL,
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
        requestUrl: REGISTER_URL,
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
    requestUrl: REGISTER_URL,
    requestHeaders,
    response: { error: "register attempts exhausted" },
  };
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
    Origin: CONFIG.baseUrl,
    Referer: `${CONFIG.baseUrl}/register`,
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
    Origin: CONFIG.baseUrl,
    Referer: `${CONFIG.baseUrl}/login`,
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
    Origin: CONFIG.baseUrl,
    Referer: `${CONFIG.baseUrl}/console/token`,
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
  return registerWithCredential(username, password);
}

async function loginOne(username, password) {
  const payload = { username, password };
  const startedAt = new Date().toISOString();

  try {
    const requestHeaders = buildLoginHeaders();
    const res = await fetch(LOGIN_URL, {
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
    const newApiUser =
      parsePossibleUserId(parsed) || CONFIG.defaultNewApiUser || "";
    const accessToken =
      parsePossibleAccessToken(parsed) || CONFIG.staticAccessToken;

    return {
      ok,
      httpOk: res.ok,
      status: res.status,
      startedAt,
      username,
      requestUrl: LOGIN_URL,
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
      requestUrl: LOGIN_URL,
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
      ...tokenApiHeaders(
        loginResult.cookieHeader,
        loginResult.newApiUser,
        true,
      ),
      ...(loginResult.accessToken
        ? { Authorization: `Bearer ${loginResult.accessToken}` }
        : {}),
    };

    const res = await fetch(TOKEN_CREATE_URL, {
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
      requestUrl: TOKEN_CREATE_URL,
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
      requestUrl: TOKEN_CREATE_URL,
      requestHeaders: {
        ...tokenApiHeaders(
          loginResult.cookieHeader,
          loginResult.newApiUser,
          true,
        ),
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

async function createTokenByIdOne(loginResult, tokenId) {
  const startedAt = new Date().toISOString();
  const requestHeaders = {
    ...tokenApiHeaders(loginResult.cookieHeader, loginResult.newApiUser, false),
    ...(loginResult.accessToken
      ? { Authorization: `Bearer ${loginResult.accessToken}` }
      : {}),
  };

  const res = await fetch(`${CONFIG.baseUrl}/api/token/${tokenId}/key`, {
    method: "POST",
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
    requestUrl: `${CONFIG.baseUrl}/api/token/${tokenId}/key`,
    requestHeaders,
    response: parsed,
    tokenValue: extractTokenValue(parsed),
  };
}

async function listTokensOne(loginResult) {
  const startedAt = new Date().toISOString();

  try {
    const requestHeaders = {
      ...tokenApiHeaders(
        loginResult.cookieHeader,
        loginResult.newApiUser,
        false,
      ),
      ...(loginResult.accessToken
        ? { Authorization: `Bearer ${loginResult.accessToken}` }
        : {}),
    };

    const res = await fetch(TOKEN_LIST_URL, {
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
      requestUrl: TOKEN_LIST_URL,
      requestHeaders,
      response: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      startedAt,
      username: loginResult.username,
      requestUrl: TOKEN_LIST_URL,
      requestHeaders: {
        ...tokenApiHeaders(
          loginResult.cookieHeader,
          loginResult.newApiUser,
          false,
        ),
        ...(loginResult.accessToken
          ? { Authorization: `Bearer ${loginResult.accessToken}` }
          : {}),
      },
      response: { error: String(error?.message || error) },
    };
  }
}

export async function runBatchRegister(inputCount) {
  const targetCount = resolveCount(inputCount);
  await ensureStoreFile(CONFIG.storePath);
  await syncBaseUrlToStore();

  let success = 0;
  let failed = 0;
  let loginSuccess = 0;
  let loginFailed = 0;
  let tokenCreateSuccess = 0;
  let tokenCreateFailed = 0;
  let tokenListSuccess = 0;
  let tokenListFailed = 0;

  for (let i = 0; i < targetCount; i += 1) {
    let registerResult;
    try {
      registerResult = await registerOne(i + 1);
    } catch (e) {
      console.error(`[${i + 1}/${targetCount}] registerOne 抛出异常:`, e);
      failed += 1;
      continue;
    }

    if (!registerResult) {
      console.error(`[${i + 1}/${targetCount}] registerOne 返回空值`);
      failed += 1;
      continue;
    }

    await saveWorkflowStep(
      registerResult.username,
      registerResult.password,
      "register",
      registerResult,
    );

    if (!registerResult.ok) {
      failed += 1;
      console.log(
        `[${i + 1}/${targetCount}] 注册失败(${registerResult.status}) ${registerResult.username}`,
      );

      if (i < targetCount - 1 && CONFIG.requestDelayMs > 0) {
        await sleep(CONFIG.requestDelayMs);
      }
      continue;
    }

    success += 1;
    console.log(
      `[${i + 1}/${targetCount}] 注册成功(${registerResult.status}) ${registerResult.username}`,
    );

    if (CONFIG.operationDelayMs > 0) {
      await sleep(CONFIG.operationDelayMs);
    }

    const loginResult = await loginOne(
      registerResult.username,
      registerResult.password,
    );
    const sessionCookie = pickSessionCookie(
      extractCookiePairs(loginResult.setCookies),
    );
    await saveWorkflowStep(
      registerResult.username,
      registerResult.password,
      "login",
      loginResult,
      {
        newApiUser: loginResult.newApiUser,
        session: sessionCookie,
        lastLoginAt: loginResult.ok ? new Date().toISOString() : null,
      },
    );

    if (!loginResult.ok) {
      loginFailed += 1;
      const reason = loginResult?.response?.message
        ? ` - ${loginResult.response.message}`
        : "";
      console.log(
        `[${i + 1}/${targetCount}] 登录失败(${loginResult.status}) ${registerResult.username}${reason}`,
      );

      if (i < targetCount - 1 && CONFIG.requestDelayMs > 0) {
        await sleep(CONFIG.requestDelayMs);
      }
      continue;
    }

    loginSuccess += 1;
    console.log(
      `[${i + 1}/${targetCount}] 登录成功(${loginResult.status}) ${registerResult.username}`,
    );

    if (CONFIG.operationDelayMs > 0) {
      await sleep(CONFIG.operationDelayMs);
    }

    const tokenCreateResult = await createTokenOne(loginResult);
    await saveWorkflowStep(
      registerResult.username,
      registerResult.password,
      "tokenCreate",
      tokenCreateResult,
    );

    if (!tokenCreateResult.ok) {
      tokenCreateFailed += 1;
      console.log(
        `[${i + 1}/${targetCount}] 创建令牌失败(${tokenCreateResult.status}) ${registerResult.username}`,
      );

      if (i < targetCount - 1 && CONFIG.requestDelayMs > 0) {
        await sleep(CONFIG.requestDelayMs);
      }
      continue;
    }

    tokenCreateSuccess += 1;
    console.log(
      `[${i + 1}/${targetCount}] 创建令牌成功(${tokenCreateResult.status}) ${registerResult.username}`,
    );

    if (CONFIG.operationDelayMs > 0) {
      await sleep(CONFIG.operationDelayMs);
    }

    const tokenListResult = await listTokensOne(loginResult);
    const tokenFromList = tokenListResult.ok
      ? extractTokenFromList(
          tokenListResult.response,
          tokenCreateResult.tokenName,
        )
      : "";
    const finalTokenValue = `sk-${tokenCreateResult.tokenValue || tokenFromList}`;

    await saveWorkflowStep(
      registerResult.username,
      registerResult.password,
      "tokenList",
      tokenListResult,
      {
        token: tokenListResult.ok ? finalTokenValue : "",
        session: sessionCookie,
        newApiUser: loginResult.newApiUser,
      },
    );

    if (!tokenListResult.ok) {
      tokenListFailed += 1;
      console.log(
        `[${i + 1}/${targetCount}] 令牌列表失败(${tokenListResult.status}) ${registerResult.username}`,
      );

      if (i < targetCount - 1 && CONFIG.requestDelayMs > 0) {
        await sleep(CONFIG.requestDelayMs);
      }
      continue;
    }

    tokenListSuccess += 1;
    console.log(
      `[${i + 1}/${targetCount}] 令牌列表成功(${tokenListResult.status}) ${registerResult.username}`,
    );

    if (i < targetCount - 1 && CONFIG.requestDelayMs > 0) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  const summary = {
    requestedCount: targetCount,
    register: { success, failed },
    login: { success: loginSuccess, failed: loginFailed },
    tokenCreate: { success: tokenCreateSuccess, failed: tokenCreateFailed },
    tokenList: { success: tokenListSuccess, failed: tokenListFailed },
  };

  console.log(
    `完成：注册 成功${success}/失败${failed}，登录 成功${loginSuccess}/失败${loginFailed}，创建令牌 成功${tokenCreateSuccess}/失败${tokenCreateFailed}，查询令牌 成功${tokenListSuccess}/失败${tokenListFailed}`,
  );

  return summary;
}

export async function retryAccountWorkflow(username, step) {
  await resolveBaseUrl();
  const allowedSteps = new Set([
    "register",
    "login",
    "tokenCreate",
    "tokenList",
  ]);
  if (!allowedSteps.has(step)) {
    throw new Error("Invalid workflow step");
  }

  const store = await readStore(CONFIG.storePath);
  const account = findAccount(store, username);
  if (!account) {
    throw new Error("Account not found");
  }

  let currentUsername = account.username;
  let currentPassword = account.password;
  let loginResult = null;

  if (step === "register") {
    if (!currentUsername || !currentPassword) {
      throw new Error(
        "Account username and password are required for register retry",
      );
    }

    const registerResult = await registerWithCredential(
      currentUsername,
      currentPassword,
    );
    await saveWorkflowStep(
      currentUsername,
      currentPassword,
      "register",
      registerResult,
    );
    if (!registerResult.ok) {
      return { username: currentUsername, step, result: registerResult };
    }
  }

  if (["login", "tokenCreate", "tokenList"].includes(step)) {
    if (!currentUsername || !currentPassword) {
      throw new Error(
        "Account username and password are required for login retry",
      );
    }

    loginResult = await loginOne(currentUsername, currentPassword);
    const sessionCookie = pickSessionCookie(
      extractCookiePairs(loginResult.setCookies),
    );
    await saveWorkflowStep(
      currentUsername,
      currentPassword,
      "login",
      loginResult,
      {
        newApiUser: loginResult.newApiUser || account.newApiUser,
        session: sessionCookie || account.session,
        lastLoginAt: loginResult.ok
          ? new Date().toISOString()
          : account.lastLoginAt,
      },
    );

    if (!loginResult.ok) {
      return { username: currentUsername, step: "login", result: loginResult };
    }
  }

  if (["tokenCreate", "tokenList"].includes(step)) {
    const tokenCreateResult = await createTokenOne(loginResult);
    await saveWorkflowStep(
      currentUsername,
      currentPassword,
      "tokenCreate",
      tokenCreateResult,
    );
    if (!tokenCreateResult.ok) {
      return {
        username: currentUsername,
        step: "tokenCreate",
        result: tokenCreateResult,
      };
    }

    const tokenListResult = await listTokensOne(loginResult);
    const tokenFromList = tokenListResult.ok
      ? extractTokenFromList(
          tokenListResult.response,
          tokenCreateResult.tokenName,
        )
      : "";
    const finalTokenValue = tokenCreateResult.ok
      ? `sk-${tokenCreateResult.tokenValue || tokenFromList}`
      : account.token;

    await saveWorkflowStep(
      currentUsername,
      currentPassword,
      "tokenList",
      tokenListResult,
      {
        token: finalTokenValue || account.token,
        session: loginResult.cookieHeader || account.session,
        newApiUser: loginResult.newApiUser || account.newApiUser,
      },
    );

    if (!tokenListResult.ok) {
      return {
        username: currentUsername,
        step: "tokenList",
        result: tokenListResult,
      };
    }
  }

  return { username: currentUsername, step, ok: true };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runBatchRegister().catch((err) => {
    console.error("运行失败:", err);
    process.exit(1);
  });
}
