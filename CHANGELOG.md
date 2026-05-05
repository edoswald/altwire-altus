# Changelog

All notable changes to altwire-altus will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Multi-admin onboarding** (`handlers/altus-onboarding.js`):
  - Five-phase calibration: workload → tracking → checkins → communication → perch
  - `altus_check_onboarding_status` — check onboarding phase for an admin
  - `altus_save_onboarding_response` — save phase response, advances to next phase
  - `altus_get_onboarding_preferences` — retrieve stored preferences per admin
  - `altus_get_perch_agenda` — read shared monitoring agenda
  - `altus_update_perch_agenda` — update per-admin monitoring topics
  - `altus_reset_onboarding` — reset admin to start onboarding over
  - Soul evolution via Haiku on onboarding completion

- **Scoped memory for Altus** (`handlers/altus-memory-scope.js`):
  - Key classification: shared (altus:soul, altus:perch_agenda, etc.) vs admin-scoped
  - Admin-scoped keys stored as `altus:mem:{admin_id}:{key}`
  - `scopedWriteMemory`, `scopedReadMemory`, `scopedDeleteMemory`, `scopedReadAllMemory`

- **WP plugin editorial endpoints** (`wordpress/altus-galleries/altus-galleries.php` v1.1.0):
  - `POST /wp-json/altus/v1/posts` — create post with Altus metadata (assignment_id, article_type, source_query)
  - `GET /wp-json/altus/v1/posts` — lookup posts by assignment_id, status, or author
  - `PATCH /wp-json/altus/v1/posts/:id` — update post status, publish, categories, tags
  - `GET /wp-json/altus/v1/authors` — list authors for byline attribution

- **AI cost summary tool**:
  - `get_altus_ai_cost_summary` — cost breakdown by model, by tool, by period (today/7d/30d)
  - Morning digest (`get_altwire_morning_digest`) now includes `ai_costs` section

- **Observability infrastructure** (`tracing.js`, `altus-event-log.js`, `batch-client.js`):
  - New `tracing.js` — Laminar `@observe` decorator wrapper with graceful fallback. Mirrors the pattern from `cirrusly-nimbus/tracing.js`. Auto-instruments Anthropic API calls when `LMNR_PROJECT_API_KEY` is set.
  - New `altus-event-log.js` — Unified event log with `logAltusEvent`, `queryAltusEvents`, `synthesizeAudit`, `runAuditBatchCollection`, `runRetentionCron`. Writes to `altus_events` and `altus_audit_batches` tables. Direct Haiku synthesis for ≤24h windows; batch API for longer.
  - New `batch-client.js` — Thin wrapper around Anthropic Batch API (`submitBatch`, `collectBatch`, `logBatchUsage`). Adapted from `cirrusly-nimbus/batch-client.js`.
  - `safe-tool-handler.js` now emits `tool_start` / `tool_done` SSE events and logs all tool calls to `altus_events` (fire-and-forget, non-blocking).

- **Better Stack incident management** (`handlers/altus-incident-handler.js`):
  - `altus_get_incident_comments` — retrieve comments from a Better Stack incident
  - `altus_post_incident_comment` — post attributed comments to Better Stack incidents
  - `altus_get_status_updates` — retrieve status page updates for a Better Stack status report
  - `altus_post_status_update` — post public status page updates

- **Event log tools** (registered in `index.js`):
  - `query_altus_events` — query Altus event log with filters (event_type, tool_name, session_id, last_n_hours, limit)
  - `get_altus_audit_log` — synthesize plain-English audit narrative from event logs

- **Altus heartbeat** (`handlers/altus-heartbeat.js`):
  - New `initHeartbeatSchema` — creates `altus_heartbeat_log` and `altus_scheduled_tasks` tables
  - New `runAltusHeartbeat()` — autonomous 2-hour loop with condition checks, 6-hour alert dedup, stale item queuing
  - New `scheduleAltusTask`, `listScheduledTasks`, `cancelScheduledTask` — scheduled task CRUD
  - `altus:heartbeat:alert_dedup` memory key for alert deduplication
  - Heartbeat crons registered for every 2 hours in `index.js` startup

- **Altus action items** (`handlers/altus-heartbeat.js`):
  - `initActionItemsSchema` — creates `altus_action_items` table
  - Categories: marketing, operations, pricing, quality, infrastructure, editorial
  - Lifecycle: proposed → accepted → completed / dismissed
  - `altus:heartbeat:last_run` memory key for session visibility

### Changed

- `safe-tool-handler.js` — enhanced to emit SSE tool events and log to `altus_events`. Now emits `tool_start` before handler execution and `tool_done` after completion (success or error), with `duration_ms` and error message on failure.
- `lib/altus-db.js` — `initSchema` now also creates `altus_events`, `altus_audit_batches`, `altus_heartbeat_log`, and `altus_scheduled_tasks` tables via `initAltusEventLogSchema` and `initHeartbeatSchema`.
- `index.js` startup — now initializes event log and heartbeat schemas alongside existing schema init calls.

### Fixed

- `altus-search.js` — tool name in error responses now correctly reflects the calling tool instead of returning generic error text.