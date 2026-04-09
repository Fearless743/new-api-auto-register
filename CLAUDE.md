# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview (What is this?)

`new-api-auto-register` is an automation utility designed for self-owned or third-party API platforms (typically New API or OpenAI-compatible endpoint managers). 
It automates the lifecycle of API accounts: creating accounts, obtaining access tokens, executing daily scheduled check-ins (to earn quotas), and continuously monitoring account balances and statuses.

## Primary Use Cases (What is it used for?)

- **Account Lifecycle Automation**: Automatically registers multiple accounts, logs in, and provisions API tokens, avoiding manual operations.
- **Quota Harvesting**: Automates daily check-ins (reward mechanisms) to accumulate API quotas.
- **Upstream Protection & Caching**: It periodically syncs actual balance and status data from the upstream API and stores it in a local JSON database. It exposes its own local HTTP API (`/api/balances`, etc.) so downstream applications can read cached balance data without hitting the upstream platform's rate limits.
- **Token Management**: Allows deduplicating and uploading tokens to a centralized management service.

## Implementation Details (How is it implemented?)

- **Runtime & Storage**: Written in Node.js (ESM). All state (accounts, tokens, check-in history, balance snapshots) is stored locally in a single file database at `data/store.json`. The `storage.mjs` module serves as the ORM to manage reads, writes, and deduplication safely.
- **Background Tasks**: The daemon service (`service.mjs`) uses `node-cron` to schedule automated routines. 
  - *Check-ins*: Runs daily to trigger the upstream check-in endpoint for all active accounts.
  - *Balance Refresh*: Runs periodically (e.g., every 10 minutes) to fetch the latest quota from the upstream API and updates the local cache snapshot.
- **HTTP Interactions**: Modules like `batch-register.mjs`, `checkin.mjs`, and `query-balance.mjs` use the native `fetch` API to interact with the upstream platform, managing cookies, rate-limit retries, and session headers.
- **Local Web Server**: `service.mjs` spins up a native `node:http` server to expose:
  - Read-only endpoints for downstream systems (`/api/balances`).
  - Admin endpoints (`/api/registers`, `/api/accounts/:username/retry`) protected by `ADMIN_API_KEY`.
- **Management UI**: A React/Ant Design frontend (`src/management-app.jsx`) bundled into vanilla JS/CSS via `esbuild` (`build-management.mjs`). It is injected into `management.html` to provide a visual dashboard for retrying failed workflows and checking statuses.

## Commands

- **Start main service**: `npm run service` (Starts HTTP API, management UI, and cron jobs for check-ins/balances)
- **Build management UI**: `npm run build:management` (Bundles React/Antd app using esbuild to `public/`)
- **Run batch registration**: `npm run register` (Executes `batch-register.mjs`)
- **Run manual check-in**: `npm run checkin` (Executes `checkin.mjs`)
- **Run manual balance refresh**: `npm run query:balance` (Executes `query-balance.mjs`)
- **Upload tokens to management backend**: `npm run upload:tokens` (Executes `upload-tokens.mjs`)
- **Import legacy CSV data**: `npm run import:legacy`

## Development Guidelines

- **Storage**: Never write directly to `data/store.json` using raw `fs` in concurrent workflows. Always use `readStore()`, `updateStore()`, and `upsertAccountInStore()` from `storage.mjs`.
- **Environment config**: `.env` parsing is centralized in `env-bootstrap.mjs`. When adding new env variables, provide fallbacks and update `.env.example`.