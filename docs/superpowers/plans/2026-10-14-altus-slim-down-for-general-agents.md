# Altus Slim-Down: From Hal Backend to General-Purpose AltWire MCP

**Date:** 2026-10-14
**Status:** Proposed
**Goal:** Turn Altus from "Hal's backend" into a small, well-described MCP server that any agent can use (Claude in Slack / Claude Tag, a Managed Agent, Claude Desktop/Code), keeping the **RAG archive**, **Matomo + GSC analytics**, and **story ideas / editorial intelligence**. Remove the agent-runtime pieces that Claude now provides for us.

---

## 1. Where we are

| Surface | Today | Notes |
|---|---|---|
| MCP tools | ~115 registered in `index.js` (4,217 lines) | Header says 91; it's drifted |
| Crons | 17 schedules in `index.js` + `lib/ingest-cron.js` | Several exist only to feed Hal (heartbeat, reflection, audit batches, mountaineering) |
| HTTP surfaces | `/mcp`, OAuth (`/authorize`, `/oauth/*`, DCR), Hal UI (`/hal/*`, `/events/*`), `/altwire/*` digest, `/slack/events` | |
| Agent runtime | `hal-harness.js`, `/hal/chat` agentic loop, chat history, chat presence, SSE event bus, onboarding/perch, soul/memory, commitments, autonomy notes | **This is the part Claude-in-Slack / Managed Agents replace** |
| Slack | Own Bolt bot (`handlers/slack-altus.js`, 975 lines) + 12 Slack tools | Would collide with Claude in Slack (two bots, same channels) |
| Cross-service | `X-Agent-Context` (`altwire`/`weather`/`nimbus`), `HAL_SESSION_SECRET` shared with Nimbus, `NIMBUS_SLACK_WEBHOOK_URL` | |

The keeper features are only lightly coupled to Hal. The coupling that does exist:

1. **`agent_memory` `hal:altwire:*` keys.** `altus-combined-analytics.js` reads the 16‑ and 18‑month historical baselines (`hal:altwire:gsc:summary_16m`, `hal:altwire:analytics:*`) and writes `hal:altwire:combined_synthesis`. Those keys are useful data, not Hal state, so we keep them.
2. **`altus-combined-analytics.js` → `altus-reflection.js#proposeEditorialActionItems`.** The batch-collection path writes Hal action items.
3. **`altus-opportunity-queue.js` → `altus-writer.js#createAssignment`.** Approving a story opportunity creates a Writer assignment.
4. **`altus-digest.js` → `altus-monitoring.js` + AI cost tracker.** The digest pulls in Better Stack uptime data and cost data.
5. Tool descriptions that refer to "Hal" (12 of them).

## 2. Target shape

```
Claude in Slack ─┐
Managed Agent ───┼──► Altus MCP (/mcp, OAuth or bearer) ──► Postgres (pgvector) / WP / Matomo / GSC / Voyage / Anthropic
Claude Desktop ──┘                   │
                                     └── background jobs: ingest, news monitor, story refresh, perf snapshot, nightly analytics snapshot
```

- **One job:** answer questions about AltWire content and performance, and surface story ideas.
- **No agent loop, persona, memory system, or Slack bot of its own.** The calling agent owns conversation, memory, scheduling and delivery.
- **About 30 tools** with clear names and Hal-free descriptions, MCP tool annotations (`readOnlyHint` / `destructiveHint`), and a server `instructions` string that explains AltWire and when to use each tool group.
- **Two auth paths:** OAuth with a real consent step, for claude.ai connectors (which is how Claude in Slack reaches MCPs), and static bearer tokens (`OAUTH_CLIENT_SECRET_*`) for Managed Agents and CI.

## 3. Keep / Drop / Decide

### Keep: RAG archive
| Tool | Notes |
|---|---|
| `search_altwire_archive` | Core semantic search |
| `search_altwire` | Public hybrid search. Keep if the WP site search still calls it; otherwise merge into the tool above |
| `get_content_by_url` | |
| `get_archive_stats` | |
| `analyze_coverage_gaps` | |
| `reingest_altwire_archive` | Admin. Mark `destructiveHint`, and gate it with an allowlist if needed |

Background jobs: `lib/ingest-cron.js` and `lib/ingest-pipeline.js` (keep `batch-client.js`; ingest uses it).

### Keep: Analytics and GSC
| Tool | Notes |
|---|---|
| `get_altwire_site_analytics`, `get_altwire_traffic_sources`, `get_altwire_top_pages`, `get_altwire_site_search` | Matomo |
| `get_altwire_search_performance`, `get_altwire_search_opportunities`, `get_altwire_opportunity_zone_queries`, `get_altwire_page_performance`, `get_altwire_news_search_performance`, `get_altwire_sitemap_health` | GSC |
| `get_altwire_combined_analytics` | Synthesis. Decouple from action items (see Phase 3) |
| `get_article_performance`, `get_news_performance_patterns`, `altus_register_article_tracking` | Performance tracker |

Background jobs: `runPerformanceSnapshotCron`, plus a reduced **nightly analytics snapshot** (replaces `altus-reflection.js`; see Phase 3) and its synthesis batch collection.

### Keep: Story ideas and editorial intelligence
| Tool | Notes |
|---|---|
| `get_story_opportunities` | Reads `altus_story_opportunities` queue |
| `get_news_opportunities` | |
| `altus_topic_synthesis` | |
| `altus_add_watch_subject`, `altus_remove_watch_subject`, `altus_list_watch_subjects` | Feeds the news monitor |
| `add_content_idea`, `get_content_ideas`, `track_article`, `list_tracked_articles` | Lightweight editorial tools |
| `get_altwire_morning_digest` | Keep as a **read** tool ("what's on deck today"). It's the natural thing to ask Claude in Slack each morning |

Background jobs: `runNewsMonitorCron` (4:30 AM) and `refreshOpportunityQueue` (5:00 AM weekdays).

### Drop (replaced by Claude in Slack or a Managed Agent)
| Area | Files / tools |
|---|---|
| Hal chat runtime | `/hal/auth`, `/hal/chat`, `/hal/chat-sessions*`, `/events/*` SSE, `/hal/feedback`; `hal-harness.js`, `lib/altus-chat-history.js`, `lib/anthropic-message-stream.js`, `lib/altus-event-bus.js`, `lib/hal-ui-rate-limit.js`, `lib/altus-auth-compat.js` (web keys / `HAL_SESSION_SECRET`) |
| Presence / onboarding / persona | `handlers/altus-chat-presence.js`, `handlers/altus-onboarding.js` (6 tools incl. perch agenda), `handlers/altus-memory-scope.js`, `scripts/seed-hal-soul-altwire.js` |
| Agent memory tools | `hal_read_memory`, `hal_write_memory`, `hal_list_memory`. The table stays (Phase 3); the tools go |
| Commitments / autonomy | `handlers/altus-commitments.js` (7 tools), `altus_record_autonomy_note` |
| Proactive loop | `handlers/altus-heartbeat.js` + scheduled tasks, `handlers/altus-action-items.js` (3 tools), Hal parts of `handlers/altus-reflection.js` |
| Self-optimization | `handlers/altus-mountaineering.js` (7 tools + seed + batch cron), `handlers/altus-skill-library.js` |
| Own Slack bot | `handlers/slack-altus.js`, `/slack/events`, 12 Slack tools, `hal_slack_posts`, `NIMBUS_SLACK_WEBHOOK_URL` forwarding |
| Observability-about-Hal | `query_altus_events`, `get_altus_audit_log`, `altus_get_session_trace`, `altus_get_data_health`, audit batch cron, `hal-signals.js`. Keep `altus-event-log.js` internally for cron logging, and keep Laminar tracing as optional |
| Redundant with Claude built-ins | `altus_web_research` (Claude has web search/fetch), `generate_chart` + `hal-chart.js` (Claude renders charts), `altus_search_skills` |
| Docs store | `altus_list_documents` / `get_document` / `save_document` (Claude/Slack canvases cover this) |
| Multi-agent scoping | `X-Agent-Context`, `TOOL_CONTEXTS`, `nimbus`/`weather` contexts. Replace with the per-client allowlist that already exists (`OAUTH_CLIENT_TOOLS`) |

### Decide (need an owner call; see §6)
| Area | Size | Default recommendation |
|---|---|---|
| **AI Writer pipeline** (12 tools, `/hal/writer/*`, author profile, `get_writer_summary`) | ~1,100 lines | **Split out**: drop from core and revisit as its own MCP later if Derek still uses it. Needs the opportunity-queue decoupling either way |
| **Review / loaner tracker** (16 tools) | 549 lines | Keep if Derek actively tracks loaners. It's self-contained CRUD and harmless |
| **SEO write-back** (`get_altwire_seo_state`, `update_altwire_seo_fields`) | small | Keep, marked `destructiveHint`. It's the analytics → action payoff |
| **Email**: morning digest mailer, weekly brief mailer, `altus_send_admin_email` | ~900 lines + SES | Drop the mailers if the team moves to "ask Claude in Slack"; otherwise keep the two crons and delete the ad-hoc email tool |
| **Better Stack** (`get_altwire_uptime`, incidents, 4 incident/status tools) | small | Drop write tools; keep the 2 read tools only if someone asks Claude about uptime |
| **AI cost** (`get_altus_ai_cost_summary`) | small | Keep the tracker internally; drop the tool |
| **Link evaluator** (`evaluate_link_fitness`) | 311 lines, uses OpenAI | Drop unless used; it's the only remaining reason for the `openai` dependency besides Writer |

## 4. Phases

Each phase ships on its own and is independently revertible.

### Phase 0: Security precondition (before exposing to more agents)
- **`/authorize` currently auto-approves every client.** Combined with open Dynamic Client Registration (`/oauth/register`), anyone who finds the URL can register, get a code, and receive a token for the full tool set, including `update_altwire_seo_fields`, `post_to_wordpress`, Slack DMs and admin email. Add a consent step that authenticates the human first (a simple admin passphrase or Google sign-in restricted to the AltWire domain), or restrict DCR to known redirect hosts (`claude.ai`, `claude.com`, loopback).
- Default dynamically registered clients to the **read-only** tool set. Write tools require an explicit allowlist entry.
- Audit `OAUTH_CLIENT_TOOLS`: unlisted clients currently get full access.

### Phase 1: Feature-flag the core profile (no deletions yet)
- Add `ALTUS_PROFILE=core|legacy` (default `legacy`). In `core`:
  - Register only the Keep tools (plus whichever Decide tools are approved).
  - Skip Hal routes, the Slack bot init, Hal-only crons (heartbeat, chat-presence cleanup, audit batch, mountaineering, weekly-brief batch if mailers are dropped), and `registerSignals()`.
- Deploy a **second Railway service** from the same image with `ALTUS_PROFILE=core`, pointed at the same DB. Connect it as a claude.ai connector and to Claude in Slack / the Managed Agent. Hal keeps running on the legacy service.
- **Only one service may run crons.** Add `ALTUS_RUN_CRONS=true|false`. Keep it on legacy until cutover.

### Phase 2: Make the tools good for a general agent
- Rewrite descriptions without "Hal". Say what the tool returns, its units and date window, and when to prefer it over a sibling tool.
- Add the MCP `instructions` string: what AltWire is, an editorial voice summary (from `docs/analytics-editorial-context.md`), and a decision guide (*"traffic question → Matomo tools; search demand → GSC tools; 'what should we write' → `get_story_opportunities` first"*).
- Add `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) to every tool, so Claude in Slack can auto-approve reads and confirm writes.
- Normalize inputs: consistent `days` / `start_date` / `end_date` across Matomo/GSC, and sensible defaults.
- Cap output size: paginate or summarize anything that can return more than about 20 KB (top pages, query lists).
- Consider consolidating near-duplicates once usage data exists, for example the 4 Matomo tools into `get_altwire_traffic({ view })`. Don't do this up front.
- Optionally expose MCP **prompts** for common flows ("morning editorial brief", "pitch 5 stories from this week's opportunities").

### Phase 3: Decouple the keepers from Hal
- `altus-opportunity-queue.js`: remove the `createAssignment` import (or move it behind a dynamic import that exists only if Writer is kept). "Approve" becomes a status change on `altus_story_opportunities`.
- `altus-combined-analytics.js`: drop the `proposeEditorialActionItems` call in batch collection. Keep `publishAltwireHalMemory` for now, renamed to `writeAnalyticsSnapshot` (same table, same keys).
- `altus-reflection.js`: shrink to `runNightlyAnalyticsSnapshot()`. It writes `gsc:fresh_summary`, `gsc:fresh_opportunities` and `combined_synthesis`, and does the monthly historical re-seed. Remove action items, primary-admin wins (`lib/altus-primary-reflection-memory.js`) and soul updates.
- `altus-digest.js`: make monitoring and AI cost sections optional, per the Decide outcome.
- Leave the `hal:altwire:*` key prefix alone in this phase. A key rename touches seeds, reads and a data migration, and buys nothing yet.

### Phase 4: Cutover
- Move crons to the core service (`ALTUS_RUN_CRONS=true` on core, `false` on legacy).
- Retire the Hal UI deployment and the legacy service once the team has used Claude in Slack for about 2 weeks without falling back.

### Phase 5: Delete
- Remove dropped handlers, libs, routes, scripts and their tests. Remove the `ALTUS_PROFILE` flag.
- Split `index.js` into `server/http.js` (OAuth + `/mcp` + `/health`), `server/tools/{archive,analytics,editorial}.js`, and `jobs/index.js`. Target under 600 lines per file.
- Dependencies to drop, depending on Decide outcomes: `@slack/bolt`, `@aws-sdk/client-ses` (if mailers are dropped), `openai` (if Writer and link evaluator are dropped).
- Remove env vars: `HAL_*`, `NIMBUS_SLACK_WEBHOOK_URL`, `ALTWIRE_WEBHOOK_TOKEN`, `HAL_UI_ALLOWED_ORIGINS`, `ALTUS_CHAT_MODEL`, Slack tokens. Update `.env.example` and the README.
- **DB:** don't drop tables in this phase. Write a separate, reviewed migration after a cooling-off period that archives and then drops `altus_chat_*`, `altus_commitments`, `altus_watch_items`, `altus_autonomy_notes`, `altus_climb*`, `altus_skills`, `altus_heartbeat_log`, `altus_scheduled_tasks`, `hal_slack_posts` and `altus_audit_batches`. Note that `agent_memory` may be shared with Nimbus, so check before touching it.

## 5. Testing and rollout checks
- Unit tests stay green after each phase. Delete the tests for removed modules in the same commit as the modules.
- New test: in `core` profile, the registered tool list equals an explicit allowlist. This is a snapshot test, so drift is visible in review.
- New test: `/authorize` refuses an unauthenticated consent, and a DCR client cannot call a write tool.
- Smoke test from each client type: a claude.ai connector (OAuth), a Managed Agent (bearer), and Claude Code (`claude mcp add --transport http`). Run one read per tool group.
- Cron parity: for one week on core, compare `altus_story_opportunities` upserts and `altus_article_performance` snapshots against the legacy service's history.

## 6. Open questions for Ed/Derek
1. **Writer pipeline:** is Derek still drafting through it? (It decides about 1,100 lines and the `openai` dependency.)
2. **Review/loaner tracker:** in active use?
3. **Email digests:** keep the 5:15 AM digest and the Sunday brief, or replace them with a Slack routine (a scheduled Managed Agent or a Claude routine that calls `get_altwire_morning_digest` and posts)?
4. **Nimbus:** does Nimbus still call Altus with `X-Agent-Context: nimbus`, or read `agent_memory` rows Altus writes? If yes, that contract must survive Phase 5.
5. **Which client first:** Claude in Slack (claude.ai connector, OAuth) or a Managed Agent (bearer)? Phase 0 is mandatory for the former and optional for the latter.

## 7. Rough size
| Phase | Effort | Net lines |
|---|---|---|
| 0 Security | 0.5–1 day | +150 |
| 1 Profile flag + second service | 1 day | +100 |
| 2 Tool polish | 1–2 days | ~0 |
| 3 Decouple | 1 day | −300 |
| 4 Cutover | ops | 0 |
| 5 Delete + split | 1–2 days | about −9,000 to −11,000 (depends on Decide outcomes) |
