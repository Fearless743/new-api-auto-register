# AGENTS Guide

## Purpose

This repository automates account registration, sign-in/check-in workflows, and status refreshes for a New API-compatible service.
It also exposes a small admin API and a browser-based management page.

This file is written for coding agents working inside this repo.
Prefer precise, minimal changes that preserve the current storage model and API behavior.

## Rule Files

- No `.cursor/rules/` directory exists in this repository.
- No `.cursorrules` file exists in this repository.
- No `.github/copilot-instructions.md` file exists in this repository.
- Therefore, the guidance in this `AGENTS.md` file is the primary repo-specific instruction source.

## Tech Stack

- Runtime: Node.js with native ESM (`"type": "module"` in `package.json`).
- Backend: plain Node HTTP server in `service.mjs`.
- Scheduling: `node-cron`.
- Frontend: React + Ant Design, bundled with `esbuild`.
- Config: `.env` loaded via `dotenv`.
- Persistence: JSON file storage in `data/store.json` through helpers in `storage.mjs`.

## Important Entry Points

- `service.mjs`: API server, cron startup, and management page hosting.
- `batch-register.mjs`: batch registration workflow.
- `checkin.mjs`: check-in execution and check-in status refresh.
- `query-balance.mjs`: balance refresh for stored accounts.
- `storage.mjs`: canonical store normalization and read/write helpers.
- `src/management-app.jsx`: management UI source.

## Build, Run, and Validation Commands

Use `npm` unless there is a strong reason to call `node` directly.

### Install

```bash
npm install
```

### Start the API service

```bash
npm run service
```

Equivalent: `node service.mjs`

### Build the management frontend

```bash
npm run build:management
```

Equivalent: `node build-management.mjs`

### Run workflow scripts manually

```bash
npm run register
npm run checkin
npm run query:balance
npm run import:legacy
npm run upload:tokens
```

### Syntax checks

There is no formal lint script, so syntax validation is done with Node directly:

```bash
node --check service.mjs
node --check checkin.mjs
node --check batch-register.mjs
```

### Tests

- There is currently no `npm test` script in `package.json`.
- There are no repository test files matching common `*.test.*` or `*.spec.*` patterns.
- There is no dedicated lint or format script either.

Because of that, the practical validation strategy is:

```bash
node --check <changed-file>.mjs
npm run build:management
```

If you changed API behavior, also run:

```bash
npm run service
```

Then exercise the relevant endpoint manually.

### Running a single test

- There is no single-test command today because the repo does not include a test runner or test suite.
- If you add tests in the future, update this file with the exact single-test invocation.

## Environment and Local Data

The main environment template is `.env.example`.

Important variables:

- `STORE_PATH`: JSON data store path, usually `./data/store.json`.
- `BASE_URL`: upstream site root.
- `API_PORT`: local API port.
- `ADMIN_API_KEY`: protects admin endpoints.
- `CHECKIN_CRON_EXPR` / `CHECKIN_CRON_TZ`: daily check-in schedule.
- `BALANCE_REFRESH_CRON_EXPR` / `BALANCE_REFRESH_CRON_TZ`: periodic status refresh schedule.
- `EXTRA_COOKIES`, `NEW_API_USER`: optional upstream request helpers.

Do not hardcode secrets, tokens, sessions, or API keys in source files.

## Storage Rules

- Treat `data/store.json` as the source of truth for accounts, workflows, check-ins, and cached balances.
- Do not hand-roll store file writes in business modules.
- Use helpers from `storage.mjs` such as `readStore`, `writeStore`, `updateStore`, and account patch helpers.
- Preserve the normalized shape produced by `normalizeStore` and related helpers.
- Keep JSON formatting at 2-space indentation with a trailing newline.
- Prefer `null`, `""`, `0`, or `[]` over leaving fields `undefined` in persisted data.
- Use ISO timestamps via `new Date().toISOString()`.

## Code Style

### Imports

- Use ESM imports only.
- Keep imports at the top of the file.
- Group built-in or third-party imports before local relative imports.
- Prefer named imports when a module already exports stable helpers.

### Formatting

- Use double quotes.
- Use semicolons.
- Use 2-space indentation.
- Keep files ASCII unless an existing file already uses Chinese copy or another non-ASCII string for user-facing text.

### Naming

- Use `camelCase` for variables and functions.
- Use `UPPER_SNAKE_CASE` for true constants.
- Use descriptive verb-based names for side-effecting functions, such as `runCheckin`, `refreshAccountCheckinStatus`, or `saveAccountPatch`.
- Name request helpers with `requestXxx` in the frontend.
- Keep historical names if a broad rename would create unnecessary churn, unless the task explicitly asks for cleanup.

### Types and Data Shaping

- This repo is plain JavaScript, not TypeScript.
- Emulate type safety with normalization, guard clauses, and explicit coercion.
- Convert env vars explicitly with helpers like `Number(...)` or boolean comparisons against `"true"`.
- Sanitize strings with patterns like `String(value || "").trim()` when reading loose input.
- Use `Array.isArray(...)` and optional chaining defensively.

### Function Design

- Prefer small helper functions for parsing, normalization, and HTTP formatting.
- Prefer guard clauses and early returns over deep nesting.
- Keep business workflows readable and step-oriented.
- Return structured objects for multi-step network operations when the caller needs status, HTTP code, retries, or messages.

### Error Handling

- Throw `Error` when a single-item operation cannot proceed, for example missing account credentials.
- In batch workflows, prefer catching per-account failures, logging them, and continuing with the next account.
- For API handlers, return JSON errors rather than raw text whenever possible.
- Preserve useful failure context such as `status`, `message`, `requestUrl`, or upstream response bodies.
- On background tasks, record failure state in the existing task-status variables instead of crashing the server.

### Logging

- Follow existing log style with prefixes like `[service]` where appropriate.
- Keep logs concise and operational.
- Chinese user-facing logs are acceptable because the repo already uses them extensively.
- Do not log secrets, bearer tokens, raw session cookies, or admin keys.

## Backend Conventions

- Keep config centralized in a top-level `CONFIG` object near the top of each script.
- Reuse existing response helpers in `service.mjs` instead of ad hoc response formatting.
- Preserve admin authentication behavior using `Authorization: Bearer <key>` or `X-Admin-Key`.
- When adding routes, follow the existing `if (req.method === ... && url.pathname === ...)` pattern.
- Prefer compatibility aliases when renaming live API paths.

## Frontend Conventions

- Edit `src/management-app.jsx`, not `public/management.bundle.js`, unless absolutely necessary.
- Rebuild the bundle after frontend source changes.
- Keep UI text consistent with current product terminology.
- Use existing request wrappers and Ant Design patterns.
- Prefer derived helper functions for status badges, labels, and formatting.

## Agent Workflow Expectations

- Before editing, inspect surrounding code and match the local style.
- Make the smallest safe change that solves the requested problem.
- If you touch frontend source, rebuild the bundle before finishing.
- If you touch Node scripts, run `node --check` on changed files.
- If behavior changes affect README-documented endpoints or semantics, consider updating `README.md` too.
- Do not overwrite user data in `data/store.json` unless the task explicitly requires data mutation.
- Never commit secrets from `.env` or copied production data.

## When Unsure

- Prefer compatibility over cleanup.
- Prefer store/helper reuse over new persistence code.
- Prefer explicit data normalization over implicit assumptions.
- Prefer manual validation steps in your final note when no automated tests exist.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
