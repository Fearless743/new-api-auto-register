import "./env-bootstrap.mjs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { retryAccountWorkflow, runBatchRegister } from "./batch-register.mjs";
import {
  manualCheckin,
  refreshAccountCheckinStatus,
  runCheckin,
  runCheckinStatusRefresh,
} from "./checkin.mjs";
import { runBalanceRefresh } from "./query-balance.mjs";
import { ensureStoreFile, readStore } from "./storage.mjs";
import { runUploadTokens } from "./upload-tokens.mjs";

const CONFIG = {
  storePath: process.env.STORE_PATH || "./data/store.json",
  apiPort: Number(process.env.API_PORT || 3000),
  adminApiKey: process.env.ADMIN_API_KEY || "",
  balanceCronExpr: process.env.BALANCE_REFRESH_CRON_EXPR || "*/10 * * * *",
  balanceCronTz:
    process.env.BALANCE_REFRESH_CRON_TZ ||
    process.env.CHECKIN_CRON_TZ ||
    "Asia/Shanghai",
  checkinCronExpr: process.env.CHECKIN_CRON_EXPR || "0 0 * * *",
  checkinCronTz: process.env.CHECKIN_CRON_TZ || "Asia/Shanghai",
  runCheckinOnStart:
    String(process.env.CHECKIN_RUN_ON_START || "false").toLowerCase() === "true",
  runBalanceOnStart:
    String(process.env.BALANCE_REFRESH_RUN_ON_START || "true").toLowerCase() === "true",
};

const API_HOST = "0.0.0.0";
const API_PREFIX = "/api";
const MANAGEMENT_PAGE_URL = new URL("./management.html", import.meta.url);
const MANAGEMENT_BUNDLE_URL = new URL("./public/management.bundle.js", import.meta.url);
const MANAGEMENT_STYLE_URL = new URL("./public/management.bundle.css", import.meta.url);
const ADMIN_SESSION_COOKIE = "admin_session";

let checkinRunning = false;
let balanceRunning = false;
let registerRunning = false;
let uploadTokensRunning = false;
let checkinLastStartedAt = null;
let checkinLastFinishedAt = null;
let checkinLastError = "";
let balanceLastStartedAt = null;
let balanceLastFinishedAt = null;
let balanceLastError = "";
let registerLastRequestedCount = 0;
let registerLastStartedAt = null;
let registerLastFinishedAt = null;
let registerLastSummary = null;
let registerLastError = "";

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function html(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(payload);
}

function serializeAccount(account) {
  return {
    username: account.username,
    password: account.password,
    session: account.session,
    token: account.token,
    newApiUser: account.newApiUser,
    workflow: account.workflow,
    checkinStatus: account.checkinStatus,
    updatedAt: account.updatedAt,
    lastBalanceAt: account.lastBalanceAt,
    lastBalanceQuota: account.lastBalanceQuota,
    lastBalance: account.lastBalance,
    lastUsedQuota: account.lastUsedQuota,
    lastUsedBalance: account.lastUsedBalance,
    lastCheckinAt: account.lastCheckinAt,
    lastCheckin: account.lastCheckin,
  };
}

function filterAccounts(accounts, filters) {
  const keyword = String(filters.keyword || "").trim().toLowerCase();
  const statusMode = filters.statusMode || "all";
  const selectedStep = filters.step || "all";
  const workflowSteps = ["register", "login", "tokenCreate", "tokenList"];

  return accounts.filter((account) => {
    const haystack = [account.username, account.token, account.newApiUser, account.session]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (keyword && !haystack.includes(keyword)) {
      return false;
    }

    const workflow = account.workflow || {};

    const steps = selectedStep === "all" ? workflowSteps : [selectedStep];
    const hasFailed = steps.some((step) => workflow[step] && workflow[step].status === "failed");
    const hasIdle = steps.some((step) => !workflow[step] || workflow[step].status === "idle");
    const allSuccess = steps.every((step) => workflow[step] && workflow[step].status === "success");

    if (statusMode === "failed-only") return hasFailed;
    if (statusMode === "success-only") return allSuccess;
    if (statusMode === "idle-only") return hasIdle;
    return true;
  });
}

function buildAccountsSummary(accounts, filteredAccounts) {
  const workflowSteps = ["register", "login", "tokenCreate", "tokenList"];
  const failed = accounts.filter((account) =>
    Object.values(account.workflow || {}).some((step) => step.status === "failed"),
  ).length;
  const success = accounts.filter((account) =>
    workflowSteps.every((step) => account.workflow && account.workflow[step] && account.workflow[step].status === "success"),
  ).length;
  const updated = accounts.reduce((latest, account) => {
    const timestamps = [
      account.workflow?.register?.lastRunAt,
      account.workflow?.login?.lastRunAt,
      account.workflow?.tokenCreate?.lastRunAt,
      account.workflow?.tokenList?.lastRunAt,
      account.updatedAt,
    ].filter(Boolean);
    const current = timestamps.sort().slice(-1)[0] || null;
    return !latest || (current && current > latest) ? current : latest;
  }, null);

  return {
    all: {
      total: accounts.length,
      failed,
      success,
      updated,
    },
    filtered: {
      total: filteredAccounts.length,
    },
  };
}

function text(res, statusCode, payload, contentType) {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
}

function unauthorized(res) {
  return json(res, 401, { error: "Unauthorized" });
}

function parseAdminKey(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  const headerKey = req.headers["x-admin-key"];
  return String(Array.isArray(headerKey) ? headerKey[0] || "" : headerKey || "").trim();
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "").trim();
  if (!raw) {
    return {};
  }

  return raw.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.split("=");
    const name = String(key || "").trim();
    if (!name) {
      return acc;
    }
    acc[name] = rest.join("=").trim();
    return acc;
  }, {});
}

function isAdminAuthorized(req) {
  if (!CONFIG.adminApiKey) {
    return false;
  }

  if (parseAdminKey(req) === CONFIG.adminApiKey) {
    return true;
  }

  const cookies = parseCookies(req);
  return cookies[ADMIN_SESSION_COOKIE] === CONFIG.adminApiKey;
}

function requireAdminKey(req, res) {
  if (!CONFIG.adminApiKey) {
    json(res, 503, { error: "ADMIN_API_KEY is not configured" });
    return false;
  }

  if (!isAdminAuthorized(req)) {
    unauthorized(res);
    return false;
  }

  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function buildPath(pathname) {
  const prefix = API_PREFIX.endsWith("/") ? API_PREFIX.slice(0, -1) : API_PREFIX;
  return `${prefix}${pathname}`;
}

function getCheckinStatusBody() {
  return {
    running: checkinRunning,
    startedAt: checkinLastStartedAt,
    finishedAt: checkinLastFinishedAt,
    error: checkinLastError || null,
  };
}

function getBalanceStatusBody() {
  return {
    running: balanceRunning,
    startedAt: balanceLastStartedAt,
    finishedAt: balanceLastFinishedAt,
    error: balanceLastError || null,
  };
}

function runCheckinSafely(reason) {
  if (checkinRunning) {
    console.log(`[service] skip checkin (${reason}), previous run still active`);
    return {
      ok: true,
      statusCode: 200,
      body: {
        ok: true,
        started: false,
        alreadyRunning: true,
        ...getCheckinStatusBody(),
      },
    };
  }

  checkinRunning = true;
  checkinLastStartedAt = new Date().toISOString();
  checkinLastFinishedAt = null;
  checkinLastError = "";
  console.log(`[service] start checkin (${reason})`);
  void runCheckin()
    .then(() => {
      console.log("[service] checkin finished");
    })
    .catch((error) => {
      checkinLastError = error?.message || "Batch check-in failed";
      console.error("[service] checkin failed:", error);
    })
    .finally(() => {
      checkinRunning = false;
      checkinLastFinishedAt = new Date().toISOString();
    });

  return {
    ok: true,
    statusCode: 202,
    body: {
      ok: true,
      started: true,
      alreadyRunning: false,
      ...getCheckinStatusBody(),
    },
  };
}

function runBalanceSafely(reason) {
  if (balanceRunning) {
    console.log(`[service] skip status refresh (${reason}), previous run still active`);
    return {
      ok: true,
      statusCode: 200,
      body: {
        ok: true,
        started: false,
        alreadyRunning: true,
        ...getBalanceStatusBody(),
      },
    };
  }

  balanceRunning = true;
  balanceLastStartedAt = new Date().toISOString();
  balanceLastFinishedAt = null;
  balanceLastError = "";
  console.log(`[service] start status refresh (${reason})`);
  void (async () => {
    // 移除自动刷新额度，改为用户手动触发，或保留？需求是：获取账户余额需要去管理后台点击对应账号的获取余额才获取对应账号的余额。
    // 但是这里是 batch status refresh，如果是管理后台单独获取，应该在单独的 API 里。
    // 先注释掉自动跑所有账号额度
    // await runBalanceRefresh();
    await runCheckinStatusRefresh();
  })()
    .then(() => {
      console.log("[service] status refresh finished");
    })
    .catch((error) => {
      balanceLastError = error?.message || "Status refresh failed";
      console.error("[service] status refresh failed:", error);
    })
    .finally(() => {
      balanceRunning = false;
      balanceLastFinishedAt = new Date().toISOString();
    });

  return {
    ok: true,
    statusCode: 202,
    body: {
      ok: true,
      started: true,
      alreadyRunning: false,
      ...getBalanceStatusBody(),
    },
  };
}


function getRegisterStatusBody() {
  return {
    running: registerRunning,
    requestedCount: registerLastRequestedCount,
    startedAt: registerLastStartedAt,
    finishedAt: registerLastFinishedAt,
    summary: registerLastSummary,
    error: registerLastError || null,
  };
}

function runRegisterSafely(reason, count) {
  if (registerRunning) {
    return {
      ok: true,
      statusCode: 200,
      body: {
        ok: true,
        started: false,
        alreadyRunning: true,
        ...getRegisterStatusBody(),
      },
    };
  }

  const resolvedCount = Math.max(1, Number.parseInt(String(count ?? "1"), 10) || 1);
  registerRunning = true;
  registerLastRequestedCount = resolvedCount;
  registerLastStartedAt = new Date().toISOString();
  registerLastFinishedAt = null;
  registerLastSummary = null;
  registerLastError = "";

  console.log(`[service] start batch register (${reason}) count=${resolvedCount}`);
  void runBatchRegister(resolvedCount)
    .then((summary) => {
      registerLastSummary = summary;
      console.log("[service] batch register finished");
    })
    .catch((error) => {
      registerLastError = error?.message || "Batch register failed";
      console.error("[service] batch register failed:", error);
    })
    .finally(() => {
      registerRunning = false;
      registerLastFinishedAt = new Date().toISOString();
    });

  return {
    ok: true,
    statusCode: 202,
    body: {
      ok: true,
      started: true,
      alreadyRunning: false,
      ...getRegisterStatusBody(),
    },
  };
}

async function runUploadTokensSafely() {
  if (uploadTokensRunning) {
    return {
      ok: false,
      statusCode: 409,
      body: { error: "Token upload is already running" },
    };
  }

  uploadTokensRunning = true;
  console.log("[service] start token upload");
  try {
    const result = await runUploadTokens();
    console.log("[service] token upload finished");
    return {
      ok: true,
      statusCode: 200,
      body: { ok: true, result },
    };
  } catch (error) {
    console.error("[service] token upload failed:", error);
    return {
      ok: false,
      statusCode: 500,
      body: { error: error?.message || "Token upload failed" },
    };
  } finally {
    uploadTokensRunning = false;
  }
}

async function renderManagementPage() {
  return readFile(MANAGEMENT_PAGE_URL, "utf8");
}

async function renderManagementBundle() {
  return readFile(MANAGEMENT_BUNDLE_URL, "utf8");
}

async function renderManagementStyle() {
  return readFile(MANAGEMENT_STYLE_URL, "utf8");
}

function renderManagementLoginPage(errorMessage = "") {
  const errorBlock = errorMessage
    ? `<div class="error">${errorMessage.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理页验证</title>
  <style>
    :root {
      --bg: #f6efe5;
      --panel: rgba(255,255,255,0.88);
      --ink: #201814;
      --muted: #70645a;
      --line: rgba(32,24,20,0.12);
      --accent: #201814;
      --bad: #bf4d3a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(184,144,78,0.18), transparent 30%),
        linear-gradient(180deg, #faf5ef 0%, #ede1d3 100%);
      color: var(--ink);
      font-family: "Noto Serif SC", "Source Han Serif SC", serif;
    }
    .panel {
      width: min(480px, calc(100vw - 32px));
      padding: 28px;
      border-radius: 28px;
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.6);
      box-shadow: 0 30px 80px rgba(57, 42, 31, 0.16);
    }
    .eyebrow {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      color: var(--muted);
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 42px;
      line-height: 0.98;
    }
    p {
      margin: 0 0 18px;
      color: var(--muted);
      line-height: 1.7;
    }
    form {
      display: grid;
      gap: 12px;
    }
    input, button {
      width: 100%;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 14px 16px;
      font: inherit;
    }
    button {
      background: var(--accent);
      color: #f7efe5;
      cursor: pointer;
    }
    .error {
      margin-bottom: 14px;
      color: var(--bad);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="eyebrow">Admin Gate</div>
    <h1>输入管理员密钥</h1>
    <p>只有通过管理员密钥验证后，才可以进入账户管理页面并查看敏感账号状态。</p>
    ${errorBlock}
    <form method="post" action="/management/login">
      <input type="password" name="adminKey" placeholder="管理员密钥" required>
      <button type="submit">进入管理页</button>
    </form>
  </div>
</body>
</html>`;
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return new URLSearchParams(raw);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === buildPath("/balances")) {
    const store = await readStore(CONFIG.storePath);
    return json(res, 200, {
      updatedAt: store.balanceSnapshot.updatedAt,
      totalQuota: store.balanceSnapshot.totalQuota,
      totalBalance: store.balanceSnapshot.totalBalance,
      totalUsedQuota: store.balanceSnapshot.totalUsedQuota,
      totalUsedBalance: store.balanceSnapshot.totalUsedBalance,
      accounts: store.balanceSnapshot.accounts,
    });
  }

  if (req.method === "GET" && url.pathname === buildPath("/accounts")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const store = await readStore(CONFIG.storePath);
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    const filters = {
      keyword: url.searchParams.get("keyword") || "",
      statusMode: url.searchParams.get("statusMode") || "all",
      step: url.searchParams.get("step") || "all",
    };
    const filteredAccounts = filterAccounts(store.accounts, filters);
    const start = (page - 1) * pageSize;
    const pagedAccounts = filteredAccounts.slice(start, start + pageSize);

    return json(res, 200, {
      count: filteredAccounts.length,
      total: filteredAccounts.length,
      page,
      pageSize,
      summary: buildAccountsSummary(store.accounts, filteredAccounts),
      accounts: pagedAccounts.map((account) => serializeAccount(account)),
    });
  }

  if (req.method === "GET" && url.pathname === buildPath("/registers/status")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    return json(res, 200, {
      ok: true,
      ...getRegisterStatusBody(),
    });
  }

  if (req.method === "GET" && url.pathname === buildPath("/checkins/status")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    return json(res, 200, {
      ok: true,
      ...getCheckinStatusBody(),
    });
  }

  if (
    req.method === "GET" &&
    (url.pathname === buildPath("/status") || url.pathname === buildPath("/balances/status"))
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    return json(res, 200, {
      ok: true,
      ...getBalanceStatusBody(),
    });
  }

  if (req.method === "GET" && url.pathname === "/management.html") {
    if (!CONFIG.adminApiKey) {
      return html(res, 503, renderManagementLoginPage("ADMIN_API_KEY 尚未配置，管理页不可用。"));
    }

    if (!isAdminAuthorized(req)) {
      return html(res, 401, renderManagementLoginPage());
    }

    const page = await renderManagementPage();
    return html(res, 200, page);
  }

  if (req.method === "GET" && url.pathname === "/management.bundle.js") {
    if (!CONFIG.adminApiKey) {
      return text(res, 503, "ADMIN_API_KEY is not configured", "text/plain; charset=utf-8");
    }

    if (!isAdminAuthorized(req)) {
      return text(res, 401, "Unauthorized", "text/plain; charset=utf-8");
    }

    try {
      const bundle = await renderManagementBundle();
      return text(res, 200, bundle, "application/javascript; charset=utf-8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return text(res, 503, "management bundle not built", "text/plain; charset=utf-8");
      }
      throw error;
    }
  }

  if (req.method === "GET" && url.pathname === "/management.bundle.css") {
    if (!CONFIG.adminApiKey) {
      return text(res, 503, "ADMIN_API_KEY is not configured", "text/plain; charset=utf-8");
    }

    if (!isAdminAuthorized(req)) {
      return text(res, 401, "Unauthorized", "text/plain; charset=utf-8");
    }

    try {
      const stylesheet = await renderManagementStyle();
      return text(res, 200, stylesheet, "text/css; charset=utf-8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return text(res, 503, "management stylesheet not built", "text/plain; charset=utf-8");
      }
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/management/login") {
    if (!CONFIG.adminApiKey) {
      return html(res, 503, renderManagementLoginPage("ADMIN_API_KEY 尚未配置，管理页不可用。"));
    }

    const form = await readFormBody(req);
    const submittedKey = String(form.get("adminKey") || "").trim();
    if (submittedKey !== CONFIG.adminApiKey) {
      return html(res, 401, renderManagementLoginPage("管理员密钥错误，请重试。"));
    }

    res.writeHead(302, {
      Location: "/management.html",
      "Set-Cookie": `${ADMIN_SESSION_COOKIE}=${CONFIG.adminApiKey}; HttpOnly; Path=/; SameSite=Lax`,
    });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/management/logout") {
    res.writeHead(302, {
      Location: "/management.html",
      "Set-Cookie": `${ADMIN_SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
    });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === buildPath("/registers")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const result = runRegisterSafely("api", body.count);
    return json(res, result.statusCode, result.body);
  }

  if (req.method === "POST" && url.pathname === buildPath("/checkins")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const result = runCheckinSafely("api");
    return json(res, result.statusCode, result.body);
  }

  if (
    req.method === "POST" &&
    (url.pathname === buildPath("/status/refresh") || url.pathname === buildPath("/balances/refresh"))
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const result = runBalanceSafely("api");
    return json(res, result.statusCode, result.body);
  }

  if (req.method === "POST" && url.pathname === buildPath("/tokens/upload")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const result = await runUploadTokensSafely();
    return json(res, result.statusCode, result.body);
  }

  if (req.method === "GET" && url.pathname === buildPath("/tokens/export")) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    try {
      const tokens = await runExportTokens();
      return text(res, 200, tokens.join("\n"), "text/plain; charset=utf-8");
    } catch (error) {
      console.error("[service] token export failed:", error);
      return json(res, 500, { error: error?.message || "Token export failed" });
    }
  }

  if (
    req.method === "POST" &&
    url.pathname.startsWith(buildPath("/accounts/")) &&
    url.pathname.endsWith("/retry")
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const base = buildPath("/accounts/").length;
    const username = decodeURIComponent(url.pathname.slice(base, -"/retry".length));

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    if (!body.step) {
      return json(res, 400, { error: "step is required" });
    }

    try {
      const result = await retryAccountWorkflow(username, body.step);
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { error: error?.message || "Retry failed" });
    }
  }

  if (
    req.method === "POST" &&
    url.pathname.startsWith(buildPath("/accounts/")) &&
    url.pathname.endsWith("/checkin-status")
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const base = buildPath("/accounts/").length;
    const username = decodeURIComponent(url.pathname.slice(base, -"/checkin-status".length));

    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    try {
      const result = await refreshAccountCheckinStatus(username, body.month);
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { error: error?.message || "Check-in status refresh failed" });
    }
  }

  if (
    req.method === "POST" &&
    url.pathname.startsWith(buildPath("/accounts/")) &&
    url.pathname.endsWith("/checkin")
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const base = buildPath("/accounts/").length;
    const username = decodeURIComponent(url.pathname.slice(base, -"/checkin".length));

    try {
      const result = await manualCheckin(username);
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { error: error?.message || "Manual check-in failed" });
    }
  }

  if (
    req.method === "POST" &&
    url.pathname.startsWith(buildPath("/accounts/")) &&
    url.pathname.endsWith("/balance")
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const base = buildPath("/accounts/").length;
    const username = decodeURIComponent(url.pathname.slice(base, -"/balance".length));

    try {
      await runBalanceRefresh(username);
      const store = await readStore(CONFIG.storePath);
      const account = store.accounts.find((a) => a.username === username);
      return json(res, 200, { ok: true, account: serializeAccount(account) });
    } catch (error) {
      return json(res, 400, { error: error?.message || "Balance refresh failed" });
    }
  }

  if (
    req.method === "DELETE" &&
    url.pathname.startsWith(buildPath("/accounts/"))
  ) {
    if (!requireAdminKey(req, res)) {
      return;
    }

    const base = buildPath("/accounts/").length;
    const username = decodeURIComponent(url.pathname.slice(base));

    try {
      const { updateStore } = await import("./storage.mjs");
      await updateStore(CONFIG.storePath, (store) => {
        store.accounts = store.accounts.filter(a => a.username !== username);
        return store;
      });
      return json(res, 200, { ok: true, message: `Account ${username} deleted` });
    } catch (error) {
      return json(res, 500, { error: error?.message || "Delete failed" });
    }
  }

  return json(res, 404, { error: "Not Found" });
}

async function main() {
  await ensureStoreFile(CONFIG.storePath);

  cron.schedule(
    CONFIG.checkinCronExpr,
    () => {
      void runCheckinSafely("scheduled");
    },
    { timezone: CONFIG.checkinCronTz },
  );

  cron.schedule(
    CONFIG.balanceCronExpr,
    () => {
      void runBalanceSafely("scheduled");
    },
    { timezone: CONFIG.balanceCronTz },
  );

  if (CONFIG.runBalanceOnStart) {
    void runBalanceSafely("startup");
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("[service] request failed:", error);
      json(res, 500, { error: "Internal Server Error" });
    });
  });

  server.listen(CONFIG.apiPort, API_HOST, () => {
    console.log(`[service] listening on http://${API_HOST}:${CONFIG.apiPort}${API_PREFIX}`);
    console.log(
      `[service] checkin cron='${CONFIG.checkinCronExpr}' tz='${CONFIG.checkinCronTz}', status cron='${CONFIG.balanceCronExpr}' tz='${CONFIG.balanceCronTz}'`,
    );
  });
}

main().catch((error) => {
  console.error("[service] startup failed:", error);
  process.exit(1);
});
