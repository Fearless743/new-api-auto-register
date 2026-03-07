import "./env-bootstrap.mjs";
import { readFile } from "node:fs/promises";
import { ensureStoreFile, updateStore, upsertAccountInStore } from "./storage.mjs";

const CONFIG = {
  storePath: process.env.STORE_PATH || "./data/store.json",
  tokenCsvPath: "./tokens.csv",
  sessionCsvPath: "./sessions.csv",
  userIdCsvPath: "./user-ids.csv",
};

async function readCsvRows(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) {
      return [];
    }

    const header = lines[0].split(",").map((item) => item.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const values = lines[i].split(",");
      const row = {};
      for (let j = 0; j < header.length; j += 1) {
        row[header[j]] = (values[j] || "").trim();
      }

      if (Object.values(row).some((value) => String(value).trim() !== "")) {
        rows.push(row);
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function mergeRows(tokenRows, sessionRows, userIdRows) {
  const map = new Map();

  for (const row of tokenRows) {
    const username = String(row.username || "").trim();
    if (!username || username.toLowerCase() === "username") {
      continue;
    }
    map.set(username, {
      username,
      password: String(row.password || "").trim(),
      token: String(row.token || "").trim(),
    });
  }

  for (const row of sessionRows) {
    const username = String(row.username || "").trim();
    if (!username || username.toLowerCase() === "username") {
      continue;
    }
    const prev = map.get(username) || { username };
    map.set(username, {
      ...prev,
      password: prev.password || String(row.password || "").trim(),
      session: String(row.session || "").trim(),
      newApiUser: String(row.new_api_user || "").trim(),
    });
  }

  for (const row of userIdRows) {
    const username = String(row.username || "").trim();
    if (!username || username.toLowerCase() === "username") {
      continue;
    }
    const prev = map.get(username) || { username };
    map.set(username, {
      ...prev,
      newApiUser: prev.newApiUser || String(row.new_api_user || "").trim(),
    });
  }

  return Array.from(map.values());
}

async function main() {
  await ensureStoreFile(CONFIG.storePath);

  const tokenRows = await readCsvRows(CONFIG.tokenCsvPath);
  const sessionRows = await readCsvRows(CONFIG.sessionCsvPath);
  const userIdRows = await readCsvRows(CONFIG.userIdCsvPath);
  const accounts = mergeRows(tokenRows, sessionRows, userIdRows);

  if (accounts.length === 0) {
    throw new Error("No legacy accounts found in tokens.csv, sessions.csv, or user-ids.csv");
  }

  await updateStore(CONFIG.storePath, (store) => {
    for (const account of accounts) {
      upsertAccountInStore(store, account);
    }
    return store;
  });

  console.log(`Imported ${accounts.length} accounts into ${CONFIG.storePath}`);
}

main().catch((error) => {
  console.error("Legacy import failed:", error?.message || error);
  process.exit(1);
});
