import "./env-bootstrap.mjs";
import { listUniqueTokens, readStore } from "./storage.mjs";

const CONFIG = {
  tokenTxtPath: process.env.TOKEN_TXT_PATH || "./tokens.txt",
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  storePath: process.env.STORE_PATH || "./data/store.json",
  managementUrl: process.env.MANAGEMENT_OPENAI_COMPAT_URL || "",
  managementBearer: process.env.MANAGEMENT_BEARER || "",
  existingTokens: process.env.MANAGEMENT_EXISTING_TOKENS || "",
};

const PROVIDER_NAME = "lxcloud";
const PROVIDER_BASE_URL = "https://open.lxcloud.dev/v1";
const PROVIDER_MODELS = [
  "gpt-5.2-codex",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5-codex-mini",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5-codex",
];
const PROVIDER_PRIORITY = 10;
const PROVIDER_TEST_MODEL = "gpt-5.2-codex";

async function readTokensFromTxt(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.startsWith("sk-"));
  } catch {
    return [];
  }
}

async function readTokensFromCsv(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      return [];
    }

    const header = lines[0].split(",").map((x) => x.trim().toLowerCase());
    const tokenIndex = header.indexOf("token");
    if (tokenIndex < 0) {
      return [];
    }

    const tokens = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(",");
      const token = (cols[tokenIndex] || "").trim();
      if (token && token.startsWith("sk-")) {
        tokens.push(token);
      }
    }

    return tokens;
  } catch {
    return [];
  }
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function parseTokenList(raw) {
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x.startsWith("sk-"));
}

function buildPayload(tokens) {
  return [
    {
      name: PROVIDER_NAME,
      "base-url": PROVIDER_BASE_URL,
      "api-key-entries": tokens.map((token) => ({ "api-key": token })),
      models: PROVIDER_MODELS.map((name) => ({ name })),
      priority: PROVIDER_PRIORITY,
      "test-model": PROVIDER_TEST_MODEL,
    },
  ];
}

function toOrigin(urlText) {
  try {
    return new URL(urlText).origin;
  } catch {
    return "";
  }
}

async function main() {
  const result = await runUploadTokens();
  console.log(`Uploaded ${result.tokenCount} unique tokens to ${CONFIG.managementUrl}`);
  console.log(result.body);
}

export async function runUploadTokens() {
  if (!CONFIG.managementUrl) {
    throw new Error("MANAGEMENT_OPENAI_COMPAT_URL is required");
  }

  if (!CONFIG.managementBearer) {
    throw new Error("MANAGEMENT_BEARER is required");
  }

  const txtTokens = await readTokensFromTxt(CONFIG.tokenTxtPath);
  const csvTokens = await readTokensFromCsv(CONFIG.tokenCsvPath);
  const store = await readStore(CONFIG.storePath).catch(() => ({ accounts: [] }));
  const storeTokens = listUniqueTokens(store);
  const existingTokens = parseTokenList(CONFIG.existingTokens);
  const tokens = uniqueTokens([...existingTokens, ...storeTokens, ...txtTokens, ...csvTokens]);

  if (tokens.length === 0) {
    throw new Error("No tokens found in store.json, tokens.txt, or tokens.csv");
  }

  const payload = buildPayload(tokens);
  const origin = toOrigin(CONFIG.managementUrl);
  const res = await fetch(CONFIG.managementUrl, {
    method: "PUT",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.managementBearer}`,
      ...(origin ? { Origin: origin, Referer: `${origin}/management.html` } : {}),
      Connection: "keep-alive",
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }

  if (!res.ok) {
    throw new Error(
      `Upload failed: HTTP ${res.status}${typeof body === "string" ? ` ${body}` : ""}`,
    );
  }

  return {
    tokenCount: tokens.length,
    body,
    managementUrl: CONFIG.managementUrl,
  };
}

main().catch((err) => {
  console.error("Token upload script failed:", err?.message || err);
  process.exitCode = 1;
});
