# Spec: go-migration-spec

Scope: feature

# Go Migration Technical Specification

## 1. Core Principles
- **Parity**: Maintain 100% compatibility with existing `data/store.json` schema and current API endpoints.
- **Minimalism**: Use standard library features where possible, mirroring the plain Node HTTP server approach of the original codebase.

## 2. Recommended Technology Stack
- **HTTP Server**: Go standard library `net/http` (plus `http.ServeMux` from Go 1.22+ for path routing if applicable).
- **Scheduling**: `github.com/robfig/cron/v3` (A robust, widely-used cron library for Go) to replace `node-cron`.
- **JSON Handling**: Standard `encoding/json`.
- **Environment Variables**: `github.com/joho/godotenv` to load `.env` files identically to the Node `dotenv` package.
- **Frontend Serving**: `http.FileServer` to serve the React built bundle from the `public` directory.

## 3. Architecture & Data Structures
- **Storage Layer (`storage.go`)**: 
  - Define explicit Go structs for `Store`, `Account`, `CheckinStatus`, `WorkflowState`, etc., aligning exactly with the `normalizeStore` schema.
  - **Concurrency Control**: Introduce `sync.RWMutex` to protect JSON reads and writes. (Node is single-threaded, but Go handlers run concurrently, requiring thread-safe file I/O).
- **Service Layer (`service.go`)**:
  - Implement handlers matching `GET /api/status`, `POST /api/login`, `POST /api/batch-register`, etc.
  - Implement the Admin API Key middleware using the same `Authorization: Bearer <key>` and `X-Admin-Key` logic.

## 4. Background Tasks
- `checkin.go`, `batch-register.go`, and `query-balance.go` will be converted to Go functions.
- These will be scheduled on application startup via the cron library, using the existing `.env` variables (`CHECKIN_CRON_EXPR`, etc.).

## 5. Build and Execution
- Go code will be compiled to a single static binary.
- `package.json` scripts will be updated to act as wrappers (e.g., `npm run service` -> `go run main.go` or execute the binary), or shell scripts will replace them to maintain backward compatibility for users.