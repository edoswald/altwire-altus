# Changelog

All notable changes to altwire-altus will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **SEO optimization work** (`handlers/altus-seo-work.js`, Cirrusly SEO 1.11.0+): `find_altwire_seo_candidates` ranks AltWire articles by the Google clicks their titles and descriptions are costing, from Search Console page totals for 28 days joined with each article's stored and rendered SEO fields (bulk-read from the plugin), with plain issues (missing description, low CTR for the position, titles or descriptions too long or short) and the searches each page shows up for. `get_altwire_seo_queue` / `update_altwire_seo_queue_item` read and close what people queued in WordPress (SEO Workflow → Add to queue). `update_altwire_seo_fields` now logs every change in `altus_seo_changes` with the values before and after, a required reason, and a 28-day Search Console baseline; `get_altwire_seo_results` compares the 28 days after each change with that baseline once the data is in. New skill `agent-skills/altwire-seo-refresh`.
- **`queue_altwire_seo_item`**: the agent can add a search and article to the SEO queue in WordPress (shown under SEO Workflow → Queued for Work as queued by the agent, Cirrusly SEO 1.12.0+), for example the proposals someone wants to keep for later. The skill says when to queue and when to propose directly.
- **Slack bridge progress**: while the agent works, the "Working on it…" placeholder becomes a live checklist of its steps in plain words (✓ "Searched the archive for “deftones”", ⏳ "Checking Google search performance"), edited at most every 1.5 seconds; the answer replaces it. Repeated steps collapse ("Read SEO fields ×3") and only the last 8 show.
- **Slack bridge**: replies in the thread of a scheduled job's post continue that job's session, so people can answer it (for example, approve a proposed SEO batch) with its context.

- **Monthly history** (`handlers/altus-history.js`, daily cron `analytics_history` at 4:40 ET): Matomo visits and pageviews per calendar month (25 months) and Search Console web clicks, impressions, CTR and impression-weighted position per month (16 months, final data), with the last complete month vs. the month before and a year earlier, the last 3 months vs. a year earlier, and the best months. No model; search comparisons are null when either month is incomplete. Stored in a new `altus_kv` table; a failed source keeps the last build. In core it replaces the Hal-era 18-month summaries (built from overlapping weekly data) in the digest (`history`) and in `get_altwire_combined_analytics`. The reflection and synthesis crons are now legacy-only.

- **Article checkpoints** (`handlers/altus-article-snapshots.js`, daily cron `article_snapshots` at 6:15 ET): every post published in the last 40 days gets snapshots of its first 3, 7, and 30 days (Matomo pageviews and visits, Search Console web clicks, impressions, position and top queries, Google News clicks and impressions), taken once the 3-day Search Console lag has passed; no registration step. A source error skips the checkpoint until the next run instead of storing zeros. In core, `get_article_performance` (`url` or `days`) returns each article's checkpoints with the median and percentile for AltWire articles at the same checkpoint, and the digest's `recent_articles` shows the latest checkpoint. Core drops `altus_register_article_tracking`, `track_article`, `list_tracked_articles`, and `get_news_performance_patterns`.

- **Story opportunities rebuilt** (`handlers/altus-story-scan.js`, weekday cron `story_scan` at 5:00 ET): Search Console positions 5-30 for the last 28 days with the previous 28 for trend, one row per query, ranked by impressions x closeness to the top x coverage gap, where coverage comes from the hybrid archive search and reranker (a failed search is "unknown", not a gap). Results go to a new `altus_story_queue` with a suggestion (new_story, expand, refresh, optimize), a plain reason, the ranking page's title and date, first/last seen, and status; items unseen for 14 days expire. `get_story_opportunities` reads the queue (`refresh=true` scans now) and the new `update_story_opportunity` marks items done or dismissed. No LLM pitch step.

- **CI** (`.github/workflows/test.yml`): the test suite runs on every push to `main` and every pull request; Railway waits for it before deploying.
- **`scripts/oauth-clients.js`**: list registered OAuth clients with token counts, or delete clients (and their codes and tokens) by name.

- **Agent-written daily digest** (`slack-bridge`, `agent-skills/altwire-digest`): scheduled jobs can email a detailed digest (Markdown → HTML through SES) and route short Slack action items to several channels from one run, with a preview mode and an admin `run <job>` DM command. Replaces the legacy service's code-built digest email once enabled.

- **Slack bridge memory**: a shared team memory store (`BRIDGE_MEMORY_STORE_ID`; read-write in channels and scheduled jobs, read-only in DMs by default) seeded with a 2026 holiday tracker and a decisions file, and a personal store per Slack user, created on first DM and mounted only in their DMs. New DM command `memory`.

- **Archive filters and browse** (`search_altwire_archive`, `get_archive_stats`): `published_after` / `published_before`, `categories`, and `tags` filters (case-insensitive, applied to both semantic and keyword search; a date range drops the recency boost), `sort` (relevance, newest, oldest), and a browse mode with no query that lists matching items in date order with `total_matching` and `next_offset`. `get_archive_stats` adds item counts per year and category names with counts.
- **Hybrid keyword + semantic archive search** (`handlers/altus-search.js`): `search_altwire_archive` adds Postgres full-text matches (new generated `altus_content.search_tsv` column with a GIN index; title and tags use the `simple` config so names like "The Who" survive, the body uses `english` stemming) to the vector matches. Each result reports `match`: semantic, keyword, or both. If reranking fails, the two lists are combined by reciprocal-rank fusion.
- **Archive search reranking** (`handlers/altus-search.js`, `lib/voyage.js`): `search_altwire_archive` reranks its top 40 vector matches with Voyage `rerank-2.5` (override with `VOYAGE_RERANK_MODEL`) before the recency weighting, and falls back to vector similarity if reranking fails. Fan-out callers that pass a precomputed embedding skip it.
- **`scripts/reembed.js`**: re-embeds archive rows whose vectors came from another model, using the text already in the database (no WordPress fetch, no gallery re-synthesis). Resumable; `--dry-run` reports rows and tokens. `altus_content.embedding_model` now records the model and dimension of every vector.
- **`find_gift_guide_candidates`** (`lib/review-scores.js`): best-rated reviewed products and albums, filtered by product type, overall or subcategory rating, publish date, and title. Backed by a new `altus_review_scores` table.
- **Review scores in Postgres**: `scripts/score-reviews.js` now writes to `altus_review_scores` and only rescores reviews that are new, edited (content hash), or previously errored; `--limit` and `--export` added. The nightly ingest scores up to 40 new or changed reviews. Fixes direct (non-batch) mode, which called a missing `scoreReview`.
- **`get_altwire_seasonal_comparison`** (`handlers/altus-seasonal.js`): a past season (default: last November–December) in Search Console and Matomo, with seasonal queries and pages, current 28-day search performance for the same pages, and refresh candidates.
- **`agent-skills/altwire-gift-guide/SKILL.md`**: a gift-guide skill for the managed agent (workflow, structure, voice, disclosure, 2026 holiday dates).
- **`ALTUS_PROFILE=core`** (`lib/altus-profile.js`): 34-tool AltWire MCP (archive RAG, Matomo + GSC analytics, story ideas) for Claude in Slack and other agents. Serves only MCP, OAuth and health routes; no Slack bot or Hal-only crons. The default `legacy` profile is unchanged.
- **`ALTUS_RUN_CRONS=false`** disables all background jobs, so two services can share one database without double-running crons. It also accepts a comma-separated list of job names to run only those (e.g. `daily_ingest`), and `ALTUS_SKIP_CRONS` never runs the named jobs.
- **Nightly ingest is now a named job (`daily_ingest`)** with a configurable schedule (`ALTUS_INGEST_CRON`, default `0 3 * * *` UTC). If a clean ingest already ran in the last 6 hours (another service on the same database), the run only scores new or edited reviews. `scripts/ingest.js` accepts `ALTWIRE_DATABASE_URL` as well as `DATABASE_URL`.

### Security

- **OAuth consent required** (`lib/oauth-consent.js`): `/authorize` now shows a consent page and issues a code only after `ALTUS_OAUTH_CONSENT_PASSPHRASE` is entered (503 when unset). Dynamic Client Registration only accepts Claude hosted callbacks, loopback, or `OAUTH_ALLOWED_REDIRECT_URIS`.

### Removed

- **From the core profile**: `get_news_opportunities`, the watch-list tools (`altus_add_watch_subject`, `altus_remove_watch_subject`, `altus_list_watch_subjects`), and content ideas (`add_content_idea`, `get_content_ideas`). Unused; the digest covers Google News performance directly.

- **Laminar tracing**: removed `tracing.js`, `hal-signals.js`, `lib/laminar-integration.js`, the `@lmnr-ai/lmnr` dependency, and every `observe()` span wrapper. `LMNR_PROJECT_API_KEY` is no longer read.

### Fixed

- **SEO tools reached endpoints that don't exist**: `get_altwire_seo_state` and `update_altwire_seo_fields` called `/cirrusly/v1/seo/state` and `/seo/update-fields`; they now use the Cirrusly Agent API (`/cirrusly/v1/agent/seo-meta`) and its field names. Unsupported fields (nofollow, social) were removed from the tool.
- **Opportunity-zone queries were always empty** (`getOpportunityZoneQueries`): the request filtered on `query notContains ""`, which excludes every row because every string contains the empty string, so story opportunities and the digest's new positions 5-30 entries never had data. The filter is gone, and the request pulls 5,000 [query, page] rows (Search Console can't filter by position) and filters and sorts them here. It also dropped `orderBy`, which isn't a Search Console field. The story scan uses the full pool.

- **Page performance returned nothing**: `getPagePerformance` (used by `get_altwire_page_performance` and the article snapshots) stripped the trailing slash and asked Search Console for an exact match, but Search Console stores WordPress permalinks with it. It now matches the URL with or without the slash.
- **Digest (core) inputs**: the stored 18-month Matomo history (built from weekly data counted about seven times over) and the watch-list news alerts are no longer served; site-search terms are computed live for the last 7 days instead of read from the nightly reflection, which overwrote them with errors when Matomo failed.

- **Archive vector search recall**: dropped the ivfflat index (lists=50, default probes=1, so each query searched about 2% of the archive, with centroids built from pre-voyage-4 vectors). Search is now exact, which at archive scale takes tens of milliseconds.
- **Embeddings covered only the opening of each article**: post embed text was cut at 3,000 characters (about 500 words); it is now 12,000. The stored article text was always complete.
- **Nightly sync missed edits to older posts**: the WordPress query combined `after` with `modified_after`, which WordPress ANDs together, so only posts published in the window were fetched. It now uses `modified_after` alone.

- **`get_altwire_combined_analytics` top_articles label fallback** (`handlers/altus-combined-analytics.js`): Changed `label: a.label ?? a.url` to `label: a.label ?? a.title ?? a.url` — `normalizeTopArticles()` returns objects with `title` (not `label`), so synthesis payload was always receiving URLs instead of human-readable article titles.

### Added

- **Current Time block in system prompt** (`hal-harness.js`): `assembleSystemPrompt()` now injects a `## Current Time` section in every session (interactive, task, autonomous). Uses `Intl.DateTimeFormat` with `America/New_York` timezone. Block format:
  ```
  ## Current Time
  Day: Friday, May 8, 2026
  Time: 2:04 PM (America/New_York / EDT)
  Relative: today, Friday
  ```
  This ensures Altus always has current date/time in context.

- **Google Search Console — full integration into Hal's memory** (`scripts/seed-altwire-historical-gsc.js`):
  - New seed script pulls ~16 months of GSC history (queries, pages, opportunity-zone, News search) and writes 7 LLM-summarized memory keys under `hal:altwire:gsc:*` — `summary_16m`, `top_queries_16m`, `top_pages_16m`, `opportunities_16m`, `news_performance_16m`, `monthly_breakdown`, `last_refreshed`.
  - Idempotent — skips if `last_refreshed` is < 30 days old; supports `--force` and `--no-llm` flags.
  - Sonnet (claude-sonnet-4-6) used for summary/insight passes; raw rollups still produced under `--no-llm`.
- **GSC MCP tools — completed surface**:
  - `get_altwire_news_search_performance` — Google News search type performance.
  - `get_altwire_opportunity_zone_queries` — queries in position 5–30.
  - `get_altwire_page_performance` — per-URL clicks/impressions/CTR/position.
- **Combined Matomo + GSC synthesis** (`handlers/altus-combined-analytics.js`):
  - New MCP tool `get_altwire_combined_analytics` cross-references Matomo top articles with GSC page performance, finds search-demand gaps (opportunity-zone queries with no internal-search signal), estimates search-driven traffic share, and runs a Sonnet synthesis pass for narrative editorial recommendation.
  - Loads historical GSC + Matomo memory keys for context.
- **Nightly reflection — GSC + combined synthesis**:
  - `handlers/altus-reflection.js` now writes `hal:altwire:gsc:fresh_summary` (7d/28d), `hal:altwire:gsc:fresh_opportunities` (28d), and `hal:altwire:combined_synthesis` (28d).
  - Independent monthly historical re-seed for GSC alongside Matomo.
- **Digest endpoint — provider config flags**:
  - `/altwire/digest` now returns `providers.{matomo,gsc}.{configured,reachable}` based on env-var presence rather than transient call success — fixes Chat UI mis-labeling configured Matomo as "not configured" during transient API errors.
  - Includes `historical.gsc_summary_16m` and `historical.combined_synthesis` for the Settings drawer.

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