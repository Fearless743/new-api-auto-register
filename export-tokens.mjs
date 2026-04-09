import { readFile } from "node:fs/promises";
import "./env-bootstrap.mjs";
import { listUniqueTokens, readStore } from "./storage.mjs";

const CONFIG = {
  tokenTxtPath: process.env.TOKEN_TXT_PATH || "./tokens.txt",
  tokenCsvPath: process.env.TOKEN_CSV_PATH || "./tokens.csv",
  storePath: process.env.STORE_PATH || "./data/store.json",
  existingTokens: process.env.MANAGEMENT_EXISTING_TOKENS || "",
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

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function parseTokenList(raw) {
  return String(raw)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x.startsWith("sk-"));
}

export async function runExportTokens() {
  const txtTokens = await readTokensFromTxt(CONFIG.tokenTxtPath);
  const csvTokens = await readTokensFromCsv(CONFIG.tokenCsvPath);
  const store = await readStore(CONFIG.storePath).catch(() => ({ accounts: [] }));
  const storeTokens = listUniqueTokens(store);
  const existingTokens = parseTokenList(CONFIG.existingTokens);
  
  return uniqueTokens([...existingTokens, ...storeTokens, ...txtTokens, ...csvTokens]);
}
