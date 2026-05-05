# Changelog

All notable changes to altwire-altus will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Laminar deep integration** (instrumentModules + Laminar.patch + hal-signals.js):
  - Added `instrumentModules: { anthropic: Anthropic }` to `Laminar.initialize()` in `index.js` — auto-instruments all 5 `new Anthropic()` instantiation sites across the codebase
  - Added `Laminar.patch({ anthropic: Anthropic })` after initialization — instruments already-instantiated module-level Anthropic clients
  - `sanitizeToolParams()`: New function in `tracing.js` — strips PII fields (`email`, `phone`, `order_id`, `phone_number`, `billing_phone`) and any key containing `password` before they reach Laminar traces
  - Session metadata attached to `@observe` spans: `runAltusHeartbeat` now passes `metadata: { session_type: 'heartbeat' }`
  - **`hal-signals.js`** (new): Registers 5 Laminar Signals on startup — `altus_agent_loop_detected`, `altus_session_error`, `altus_tool_failure`, `altus_high_token_session`, `altus_long_running_session` — each with structured output schemas for SQL Editor queries

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

- **Slack extended capabilities** (`handlers/slack-altus.js` + `index.js`):
  - `add_slack_reaction` — add emoji reactions to messages
  - `list_slack_reactions` — read reactions on any message (uses `reactions.get`)
  - `get_slack_dnd_status` — read a user's Do Not Disturb status for context-awareness
  - `upload_slack_file` — upload files to Slack, optionally post to channels
  - `list_slack_channel_files` — list recent files in a channel
  - `share_slack_file_public` — generate a public share URL for a Slack file
  - `send_slack_dm` — proactively send a DM to any Slack user
  - `open_slack_dm` — open a DM conversation (returns channel ID for threading)
  - `search_slack_messages` — search past messages by keyword across all channels
  - `schedule_slack_message` — schedule a message for future delivery to a channel
  - All helpers use existing `slackApp` client with proper error handling and graceful degradation when Slack is uninitialized
  - Labels added to `hal-labels.js` for all 10 new tools

  - **New `/hal orders` slash command** — routed to nimbus for contextual order summaries from within Slack:
    - `/hal orders summary` — brief 3-5 sentence ops summary of recent order activity
    - `/hal orders search <query>` — search order records and customer history for a term
    - Falls back to general nimbus routing for any other `/hal ...` input

  **Required Slack OAuth scopes** (add to the AltWire Slack app in api.slack.com → OAuth & Permissions → Bot Token Scopes):
  - `reactions:write` — for `add_slack_reaction`
  - `reactions:read` — for `list_slack_reactions` (via `reactions.get`)
  - `dnd:read` — for `get_slack_dnd_status` (via `dnd.info`)
  - `files:read` — for `list_slack_channel_files` and `files.getPermalink`
  - `files:write` — for `upload_slack_file` and `share_slack_file_public` (via `files.sharedPublicURL`)
  - `channels:write` — for `conversations.open` (DMs)
  - `chat:write` — for `send_slack_dm`, `open_slack_dm`, and `schedule_slack_message` (already likely present)
  - `search:read.public` — for `search_slack_messages` (bot token; extend with `search:read.private` for private channels)

### Changed

- `safe-tool-handler.js` — enhanced to emit SSE tool events and log to `altus_events`. Now emits `tool_start` before handler execution and `tool_done` after completion (success or error), with `duration_ms` and error message on failure.
- `lib/altus-db.js` — `initSchema` now also creates `altus_events`, `altus_audit_batches`, `altus_heartbeat_log`, and `altus_scheduled_tasks` tables via `initAltusEventLogSchema` and `initHeartbeatSchema`.
- `index.js` startup — now initializes event log and heartbeat schemas alongside existing schema init calls.

### Fixed

- `altus-search.js` — tool name in error responses now correctly reflects the calling tool instead of returning generic error text.