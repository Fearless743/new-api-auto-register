import { readFile } from "node:fs/promises";
import "./env-bootstrap.mjs";
import { readStore } from "./storage.mjs";

const CONFIG = {
  tokenTxtPath: process.env.TOKEN_TXT_PATH || "./tokens.txt",
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  storePath: process.env.STORE_PATH || "./data/store.json",
  existingTokens: process.env.MANAGEMENT_EXISTING_TOKENS || "",
  baseUrl: process.env.BASE_URL || "",
};

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

function parseTokenList(raw) {
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x.startsWith("sk-"));
}

export async function runExportTokens() {
  const groups = {};

  function addToken(url, token) {
    if (!token || !token.startsWith("sk-")) return;
    const key = url || "default";
    if (!groups[key]) {
      groups[key] = new Set();
    }
    groups[key].add(token);
  }

  // 1. Store
  const store = await readStore(CONFIG.storePath).catch(() => ({ accounts: [] }));
  for (const acc of store.accounts) {
    addToken(acc.baseUrl || CONFIG.baseUrl, acc.token);
  }

  // 2. Txt & CSV & Existing Tokens (assumed to belong to default/global config)
  const defaultUrl = CONFIG.baseUrl || "default";
  
  const txtTokens = await readTokensFromTxt(CONFIG.tokenTxtPath);
  for (const t of txtTokens) addToken(defaultUrl, t);

  const csvTokens = await readTokensFromCsv(CONFIG.tokenCsvPath);
  for (const t of csvTokens) addToken(defaultUrl, t);

  const existingTokens = parseTokenList(CONFIG.existingTokens);
  for (const t of existingTokens) addToken(defaultUrl, t);

  // Convert Set to Array
  const result = {};
  for (const [url, tokensSet] of Object.entries(groups)) {
    result[url] = Array.from(tokensSet);
  }

  return result;
}
