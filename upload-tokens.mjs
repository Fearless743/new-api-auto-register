import { readFile } from "node:fs/promises";

const CONFIG = {
  tokenTxtPath: process.env.TOKEN_TXT_PATH || "./tokens.txt",
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  managementUrl: process.env.MANAGEMENT_OPENAI_COMPAT_URL || "",
  managementBearer: process.env.MANAGEMENT_BEARER || "",
  providerName: process.env.MANAGEMENT_PROVIDER_NAME || "lxcloud",
  providerBaseUrl:
    process.env.MANAGEMENT_PROVIDER_BASE_URL || "https://open.lxcloud.dev/v1",
  models:
    process.env.MANAGEMENT_MODELS ||
    "gpt-5.2-codex,gpt-5.4,gpt-5.3-codex,gpt-5.2,gpt-5-codex-mini,gpt-5.1-codex-mini,gpt-5,gpt-5.1,gpt-5.1-codex-max,gpt-5.1-codex,gpt-5-codex",
  priority: Number(process.env.MANAGEMENT_PRIORITY || 10),
  testModel: process.env.MANAGEMENT_TEST_MODEL || "gpt-5.2-codex",
  existingTokens: process.env.MANAGEMENT_EXISTING_TOKENS || "",
};

function parseModels(raw) {
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

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
      name: CONFIG.providerName,
      "base-url": CONFIG.providerBaseUrl,
      "api-key-entries": tokens.map((token) => ({ "api-key": token })),
      models: parseModels(CONFIG.models),
      priority: CONFIG.priority,
      "test-model": CONFIG.testModel,
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
  if (!CONFIG.managementUrl) {
    throw new Error("MANAGEMENT_OPENAI_COMPAT_URL is required");
  }

  if (!CONFIG.managementBearer) {
    throw new Error("MANAGEMENT_BEARER is required");
  }

  const txtTokens = await readTokensFromTxt(CONFIG.tokenTxtPath);
  const csvTokens = await readTokensFromCsv(CONFIG.tokenCsvPath);
  const existingTokens = parseTokenList(CONFIG.existingTokens);
  const tokens = uniqueTokens([...existingTokens, ...txtTokens, ...csvTokens]);

  if (tokens.length === 0) {
    throw new Error("No tokens found in tokens.txt or tokens.csv");
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
    console.error(`Upload failed: HTTP ${res.status}`);
    console.error(body);
    process.exitCode = 1;
    return;
  }

  console.log(`Uploaded ${tokens.length} unique tokens to ${CONFIG.managementUrl}`);
  console.log(body);
}

main().catch((err) => {
  console.error("Token upload script failed:", err?.message || err);
  process.exitCode = 1;
});
