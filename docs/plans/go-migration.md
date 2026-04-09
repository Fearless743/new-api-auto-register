---
plan name: go-migration
plan description: Migrate backend from Node to Golang
plan status: active
---

## Idea
Migrate the entire backend application from Node.js (ESM) to Golang while preserving the exact same JSON file storage schema, API endpoints, HTTP behavior, and scheduling semantics. The frontend React code will remain unchanged, but will be served by the new Go backend.

## Implementation
- Review Node.js source files (service.mjs, checkin.mjs, batch-register.mjs, storage.mjs, etc) to identify all endpoints, models, and scheduled tasks.
- Initialize a new Go module (`go mod init <module_name>`) and set up the directory structure.
- Implement the storage layer in Go (`storage.go`), mirroring the JSON file operations and structure defined in `storage.mjs`.
- Implement the web server and API endpoints (`service.go`), matching all routes, request parsing, and response formatting of `service.mjs`.
- Implement the background tasks / cron jobs (`checkin.go`, `query-balance.go`, `batch-register.go`) replicating `node-cron` behavior.
- Ensure the Go web server correctly builds and serves the React management frontend.
- Update project files like README.md, Dockerfile, install.sh, and create build/run scripts for the Go backend.
- Test the new Go backend against existing `store.json` data to ensure backward compatibility and feature parity.

## Required Specs
<!-- SPECS_START -->
- go-migration-spec
<!-- SPECS_END -->