# AltWire AI Agent Platform
## Unified Specification — Altus MCP Server
## May 5, 2026 — v1.1

---

## Component Status

| Component | Description | Status |
|---|---|---|
| Altus MCP Server | AltWire-dedicated MCP server on Railway — 65 tools | LIVE at altwire-altus-production.up.railway.app |
| PostgreSQL | Shared Railway instance — `altus_` table prefix | LIVE |
| RAG Archive | Semantic search over AltWire's ~1,566 post archive | LIVE |
| Analytics Layer | Matomo + GSC tools for editorial performance | LIVE |
| Editorial Intelligence | Topic discovery, news monitoring, performance tracking | LIVE |
| Review & Loaner Tracker | Review pipeline, loaner log, pro/con notes — 16 tools | LIVE |
| Watch List | News monitor watch list management — 3 tools | LIVE |
| AI Writer | Topic → outline → draft → fact-check → WordPress pipeline — 10 tools | LIVE |
| WordPress Plugin | Altus RAG Gallery Endpoint — NextGEN metadata REST API | LIVE |
| Editorial Decisions Log | Tracks Derek's accept/reject decisions across the AI Writer pipeline | LIVE — part of AI Writer |
| Morning Digest | Aggregated daily briefing from 7 data sources | LIVE |
| Better Stack Monitoring | Uptime and incident monitoring for altwire.net and WP Cron | LIVE |
| Slack Integration | Hal-initiated Slack status posts with channel routing | LIVE |
| Hal Agent Memory | Read/write/list/delete for Hal soul and editorial context | LIVE |
| Chart Generation | Inline chart spec generator for Hal Chat UI | LIVE |

---

# 1. System Overview

Altus is AltWire's dedicated AI operations server. It runs independently from Cirrusly Weather's infrastructure (although all MCPs share a common database for now) — AltWire tools belong on AltWire infrastructure and grow without touching the weather store's operational layer.

A Latin adjective meaning "high," "tall," "lofty,", "deep," or "profound," the selection of Altus is also a nod to the potentially business-changing nature of this project for AltWire's future and competitiveness in an saturated vertical.

Multiple news organizations have tried over the years with AI-assisted newswriting, most of them failing. The issue was context: those LLMs knew only of the task at hand, but little about the topic, the site it was writing for, or the style expected. Hal and Altus are a different concept.

Hal is the orchestrator: Altus is the ground truth that provides context to the AI at the right time. It is a set of specialized tools for a variety of common editorial functions. The LLM no longer has to guess what AltWire writers and admins want.

Hal's persistent layer changes everything - and in theory, should result in more specific recommendations, and better AI-generated content.

We don't suggest that the "AltWire way" is the correct way to use AI within newswriting; merely that a stateful agent has never been used in an editorial setting to our knowledge. This is novel.

Hal connects to Altus the same way it connects to other services. From Derek's perspective, it's just Hal responding to requests about AltWire. The server handles everything: content archive search, analytics, editorial tracking, AI-assisted writing, and WordPress posting.

**Core architectural principle:** Altus is the single source of truth for all AltWire AI capabilities. No AltWire-specific tools live in Nimbus or the Cirrusly monolith. Admin authentication does pass through Nimbus, as well as some core Hal functionality.

**Relationship to Hal Framework Architecture:** Altus is the greenfield reference implementation for the domain-aware system prompt architecture. When the four-layer prompt assembly is built, Altus gets it first before Nimbus is backported.

## 1.1 GitHub Repository

| Repo | URL | Notes |
|---|---|---|
| altwire-altus | github.com/edoswald/altwire-altus | Altus MCP server — index.js, 57 tools |

---

# 2. Infrastructure

| Item | Value |
|---|---|
| Railway service | `altwire-altus-production` |
| MCP endpoint | `https://altwire-altus-production.up.railway.app` |
| Health endpoint | `GET /health` — returns `{ status: 'ok', service: 'altus' }` |
| Database | Shared Railway PostgreSQL — `altus_` table prefix |
| Database URL env | `ALTWIRE_DATABASE_URL` (preferred) or `DATABASE_URL` (fallback) |
| Embeddings | Voyage AI `voyage-3-lite` (512 dimensions) |
| AI model (lightweight) | `claude-haiku-4-5-20251001` |
| AI model (writer) | Configurable via `ALTUS_WRITER_MODEL` — default `claude-sonnet-4-5` |
| Transport | `StreamableHTTPServerTransport`, stateless (`sessionIdGenerator: undefined`) |
| Auth | OAuth 2.0 + PKCE with SHA-256 challenge — per-client tool allowlists |
| Node.js | ≥ 20.0.0 (Nixpacks `nodejs_22`) |
| Build | Nixpacks via `nixpacks.toml` — `npm install --no-audit` |
| Start command | `node --no-deprecation index.js` |
| Restart policy | `on_failure`, max 3 retries |

## 2.1 MCP Server Factory

Altus uses a per-request server factory pattern — each incoming POST to `/` or `/mcp` creates a fresh `McpServer` instance and `StreamableHTTPServerTransport`. This is the stateless pattern required for Claude.ai compatibility and Retell Streamable HTTP.

```javascript
const server = createMcpServer();
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
});
await server.connect(transport);
await transport.handleRequest(req, res);
```

## 2.2 REST Endpoints

Altus exposes authenticated REST endpoints for the AI Writer UI under `/hal/writer/*`, search feedback under `/hal/*`, a morning digest endpoint under `/altwire/digest`, and OAuth 2.0 endpoints under `/oauth/*`. Writer endpoints require `Authorization: Bearer <ALTUS_ADMIN_TOKEN>`. CORS enabled on writer routes.

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | None | OAuth 2.0 discovery endpoint — returns issuer, endpoints, supported grant types |
| `/authorize` | GET | None (validates client_id + redirect_uri) | OAuth 2.0 authorization endpoint — initiates PKCE flow |
| `/oauth/token` | POST | None (validates client_secret) | OAuth 2.0 token endpoint — issues access and refresh tokens |
| `/hal/writer/assignments` | GET | Bearer ALTUS_ADMIN_TOKEN | List all article assignments from `altus_assignments` — supports `?status=` and `?article_type=` filters |
| `/hal/writer/assignments/:id` | GET | Bearer ALTUS_ADMIN_TOKEN | Single assignment detail with joined `altus_editorial_decisions` |
| `/hal/writer/opportunities` | GET | Bearer ALTUS_ADMIN_TOKEN | Story opportunities (delegates to `getStoryOpportunities`) |
| `/hal/writer/news-alerts` | GET | Bearer ALTUS_ADMIN_TOKEN | Today's news monitor alerts from `agent_memory` |
| `/hal/feedback` | POST | None | Log reader search feedback (thumbs up/down) from public AI search |
| `/hal/search-feedback` | GET | None | Retrieve search feedback entries — supports `?rating=`, `?since=`, `?limit=` filters |
| `/events/:sessionId` | GET | Session ID in URL | SSE event stream — streams tool_start/tool_done/thinking_done events to Chat UI |
| `/altwire/digest` | GET | Bearer any HAL_KEY | Full morning digest — site uptime, incidents, news alerts, story opportunities, review deadlines, overdue loaners, yesterday's traffic |
| `/slack/events` | POST | Slack signature | Slack event callback endpoint — handles url_verification and event_callback payloads |

## 2.3 OAuth 2.0 Authorization Server

Altus implements a full RFC 6749 + PKCE OAuth 2.0 authorization server. Clients are discovered at startup by scanning `OAUTH_CLIENT_ID_*` env vars. Each client pairs with `OAUTH_CLIENT_SECRET_<OPERATOR>`.

**Client configuration format:**
- `OAUTH_CLIENT_ID_<OPERATOR>=<clientId>` — public client identifier
- `OAUTH_CLIENT_SECRET_<OPERATOR>=<secret>` — client secret (hashed at runtime)

**Supported flows:**
- Authorization Code + PKCE (primary for web/mobile clients)
- Refresh token rotation for session persistence

**Token lifetimes:** Auth codes: 10 min | Access tokens: 1 hr | Refresh tokens: 30 days

**Per-client tool allowlists:** `OAUTH_CLIENT_TOOLS="clientId1:tool1,tool2;clientId2:tool1"` — clients not listed get full tool access. Tool scoping is enforced via `X-Agent-Context` header and `TOOL_CONTEXTS` map.

**Session-scoped event context:** MCP requests with a `session_id` in the request body subscribe the session to a live SSE event bus. Events (tool_start, tool_done, thinking_done) are streamed to `GET /events/:sessionId`.

## 2.4 Rate Limiting

| Limiter | Window | Max requests | Scope |
|---|---|---|---|
| Global | 15 minutes | 200 | Per IP |
| Auth | 15 minutes | 30 | Per IP |

Rate limiters use sliding window cleanup and set standard `RateLimit-*` response headers. Exceeded limits return HTTP 429 with `Retry-After`.

## 2.5 MCP Endpoint Auth Flow

1. Client submits Bearer token in `Authorization` header
2. Server computes `SHA-256(token)` and compares against all `OAUTH_CLIENT_SECRET_*` env var hashes (timing-safe)
3. On match, `clientId` is extracted from the corresponding env var name
4. `allowedTools` are loaded from `OAUTH_CLIENT_TOOLS` (if present)
5. `agentContext` is read from `X-Agent-Context` header (`altwire`, `weather`, `nimbus`, or `null`)
6. `scopedRegister()` only registers tools where `TOOL_CONTEXTS[toolName]` is empty (no restriction) or contains the current `agentContext`

---

# 3. Database Schema

All tables use `altus_` prefix unless noted otherwise. Auto-created at server startup via `initSchema()`, `initAiUsageSchema()`, `initReviewTrackerSchema()`, `initWatchListSchema()`, `initWriterSchema()`, and `initSlackAltusSchema()` — no manual migration needed. All DDL uses `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.

## 3.1 `altus_content`

Core RAG table. Stores all indexed AltWire posts and galleries with Voyage AI embeddings.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| wp_id | INTEGER NOT NULL | WordPress post ID |
| content_type | TEXT NOT NULL | `post` or `gallery` |
| title | TEXT NOT NULL | Article/gallery title |
| slug | TEXT | URL slug |
| url | TEXT | Full article URL |
| published_at | TIMESTAMPTZ | Publish date |
| author | TEXT | Byline |
| categories | TEXT[] | WordPress categories |
| tags | TEXT[] | WordPress tags |
| raw_text | TEXT | Full indexed content |
| embedding | vector(512) | Voyage AI `voyage-3-lite` embedding |
| ingested_at | TIMESTAMPTZ | Last ingest timestamp |

**Constraints:** `UNIQUE(wp_id, content_type)`

**Indexes:**
- `altus_content_embedding_idx` — IVFFlat cosine ops, 50 lists
- `altus_content_type_idx` — B-tree on `content_type`

## 3.2 `altus_ingest_log`

Tracks each ingest pipeline run for health monitoring.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| run_at | TIMESTAMPTZ | When the run started |
| mode | TEXT | `full` or `recent` |
| posts_ingested | INTEGER | Posts processed |
| galleries_ingested | INTEGER | Galleries processed |
| errors | INTEGER | Error count |
| duration_ms | INTEGER | Total run time |
| notes | TEXT | Optional notes |

## 3.3 `altus_article_performance`

Post-publish GSC performance snapshots at 72h, 7d, and 30d intervals. Populated by the daily performance snapshot cron.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| article_url | TEXT NOT NULL | Full article URL (normalized — trailing slashes stripped) |
| wp_post_id | INTEGER | WordPress post ID |
| published_at | TIMESTAMPTZ | Article publish date |
| snapshot_type | TEXT NOT NULL | `72h`, `7d`, or `30d` |
| snapshot_taken_at | TIMESTAMPTZ | When this snapshot was collected |
| clicks | INTEGER | GSC clicks |
| impressions | INTEGER | GSC impressions |
| ctr | NUMERIC(5,4) | Click-through rate |
| avg_position | NUMERIC(6,2) | Average ranking position |
| top_queries | JSONB | Top queries driving traffic (default `[]`) |
| source_query | TEXT | Original query that prompted tracking |

**Constraints:** `UNIQUE(article_url, snapshot_type)`

**Indexes:** `altus_article_perf_published_idx` on `published_at`

## 3.4 `altus_article_assignments`

Articles registered for post-publish performance tracking.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| article_url | TEXT UNIQUE | Full article URL |
| wp_post_id | INTEGER | WordPress post ID |
| assigned_at | TIMESTAMPTZ | When tracking started |
| status | TEXT | Default: `draft` |
| source_query | TEXT | GSC query that surfaced this opportunity |

## 3.5 `ai_usage`

AI API cost tracking — shared table (no `altus_` prefix). Wired into all Anthropic calls via `logAiUsage()`.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| tool_name | VARCHAR(100) NOT NULL | MCP tool that triggered the call |
| model | VARCHAR(100) NOT NULL | Anthropic model ID |
| input_tokens | INTEGER | Input token count |
| output_tokens | INTEGER | Output token count |
| estimated_cost_usd | NUMERIC(12,8) | Estimated cost in USD |
| created_at | TIMESTAMPTZ | |

**Indexes:** `ai_usage_tool_idx` on `tool_name`, `ai_usage_ts_idx` on `created_at`

## 3.6 `agent_memory` *(shared table)*

Key/value store for Hal agent identity, soul blocks, onboarding state, editorial context, story opportunity cache, and news alert cache. Keyed by `agent='hal'` or `agent='altus'`.

| Key Pattern | Description |
|---|---|
| `hal:soul:altwire` | Initial Hal soul for AltWire editorial context (access_count=999 sentinel) |
| `hal:altwire:editorial_context` | Corpus analysis output — editorial identity, tone, article types, subjects, headline patterns |
| `hal:altwire:derek_author_profile` | Derek's author profile from corpus analysis |
| `altus:story_opportunities:{date}` | Cached daily story opportunity results |
| `altus:news_alert:{date}` | Daily news monitor cron output |

## 3.7 `altus_reviews`

Review assignment and status tracking. Created by `initReviewTrackerSchema()` at startup.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| title | TEXT NOT NULL | Review title |
| product | TEXT | Product or topic being reviewed |
| reviewer | TEXT NOT NULL | Default: `'Derek'` |
| status | TEXT NOT NULL | CHECK: `assigned` / `in_progress` / `submitted` / `editing` / `scheduled` / `published` / `cancelled` |
| due_date | DATE | Optional deadline |
| assigned_date | DATE | Default: CURRENT_DATE |
| wp_post_id | INTEGER | WordPress post ID when published |
| notes | TEXT | Internal editorial notes |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `altus_reviews_status_idx`, `altus_reviews_due_date_idx`

## 3.8 `altus_loaners`

Gear loaned to reviewers or kept permanently. Created by `initReviewTrackerSchema()` at startup.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| item_name | TEXT NOT NULL | e.g. "Fender Telecaster Player II" |
| brand | TEXT | Manufacturer |
| borrower | TEXT NOT NULL | Default: `'Derek'` |
| is_loaner | BOOLEAN NOT NULL | Default: true. `false` = keeper |
| status | TEXT NOT NULL | CHECK: `out` / `kept` / `returned` / `overdue` / `lost` |
| loaned_date | DATE | Default: CURRENT_DATE |
| expected_return_date | DATE | NULL if keeper or no deadline |
| actual_return_date | DATE | NULL = not yet returned |
| review_id | INTEGER FK → altus_reviews(id) ON DELETE SET NULL | Optional association |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `altus_loaners_status_idx`, `altus_loaners_return_date_idx`

**Business rules:**
- `is_loaner=false` → `status='kept'`, `expected_return_date=NULL`
- `status='returned'` without `actual_return_date` → auto-set to CURRENT_DATE
- Overdue computed dynamically: `expected_return_date < CURRENT_DATE AND actual_return_date IS NULL`

## 3.9 `altus_review_notes`

Incremental check-in notes per review. Primary input for AI Writer draft generation when linked via `review_notes_id`. Created by `initReviewTrackerSchema()` at startup.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| review_id | INTEGER NOT NULL FK → altus_reviews(id) ON DELETE CASCADE | |
| note_text | TEXT NOT NULL | Raw note text as spoken/typed |
| category | TEXT NOT NULL | CHECK: `pro` / `con` / `observation` / `uncategorized` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `altus_review_notes_review_idx`, `altus_review_notes_category_idx`

**Auto-categorization:** When no category is provided, Claude Haiku classifies the note as `pro`, `con`, or `observation`. Falls back to `uncategorized` on any failure. Cost logged via `logAiUsage('altus_add_review_note', ...)`.

## 3.10 `altus_watch_list`

Artists and topics Derek wants to monitor for breaking news. Cross-referenced by the news monitor cron. Created by `initWatchListSchema()` at startup.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| name | TEXT NOT NULL UNIQUE | Artist name or topic (case-preserved) |
| active | BOOLEAN NOT NULL | Default: true. Soft-delete sets to false |
| added_at | TIMESTAMPTZ | Default: NOW() |
| notes | TEXT | Optional context, e.g. "touring in summer 2026" |

**Indexes:** `idx_altus_watch_list_active`

**Duplicate detection:** Application-level `LOWER(name)` comparison prevents case-insensitive duplicates. Database UNIQUE constraint on `name` catches exact-case duplicates as safety net.

## 3.11 `altus_assignments`

AI Writer pipeline state. Stores research, outlines, drafts, and fact-check results for each article assignment. Created by `initWriterSchema()` at startup.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| topic | TEXT NOT NULL | What to cover — as Derek described it |
| article_type | TEXT NOT NULL | CHECK: `article` / `review` / `interview` / `feature`. Default: `article` |
| status | TEXT NOT NULL | CHECK: `researching` / `outline_ready` / `outline_approved` / `drafting` / `draft_ready` / `fact_checking` / `needs_revision` / `ready_to_post` / `posted` / `cancelled`. Default: `researching` |
| archive_research | JSONB | RAG archive search results from assignment creation |
| web_research | TEXT | Web search synthesis from assignment creation |
| review_notes_id | INTEGER FK → altus_reviews(id) ON DELETE SET NULL | Optional link to review notes for product reviews |
| outline | JSONB | Structured outline: `{ title_suggestion, sections: [{ title, points[] }], angle, estimated_words }` |
| outline_notes | TEXT | Derek's modification feedback (stored when decision = `modified`) |
| draft_content | TEXT | Full article draft in markdown |
| draft_word_count | INTEGER | Word count of the generated draft |
| fact_check_results | JSONB | `{ passed: bool, issues: [{ section, issue, severity }] }` |
| wp_post_id | INTEGER | WordPress post ID when posted |
| wp_post_url | TEXT | WordPress draft URL |
| created_at | TIMESTAMPTZ | Default: NOW() |
| updated_at | TIMESTAMPTZ | Default: NOW() |

**Indexes:** `altus_assignments_status_idx`, `altus_assignments_created_idx`

**Pipeline status progression:** `researching` → `outline_ready` → `outline_approved` → `drafting` → `draft_ready` → `fact_checking` → `needs_revision` → `ready_to_post` → `posted` → `cancelled`

## 3.12 `altus_editorial_decisions`

Derek's accept/reject/modify decisions across the AI Writer pipeline. Accumulates over time for editorial pattern analysis.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| assignment_id | INTEGER FK → altus_assignments(id) ON DELETE SET NULL | |
| stage | TEXT NOT NULL | CHECK: `outline` / `draft` / `post` / `feedback` |
| decision | TEXT NOT NULL | CHECK: `approved` / `rejected` / `modified` / `cancelled` |
| feedback | TEXT | Derek's feedback if provided |
| article_type | TEXT | Denormalized from assignment for pattern queries |
| topic | TEXT | Denormalized from assignment for pattern queries |
| created_at | TIMESTAMPTZ | Default: NOW() |

**Indexes:** `altus_editorial_decisions_assignment_idx`

## 3.13 `hal_slack_posts`

Record of Hal-initiated Slack status posts. Created by `initSlackAltusSchema()` at startup. Used by `getSlackPostHistory` to query recent posts.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| channel_id | VARCHAR(255) NOT NULL | Slack channel ID |
| message_ts | VARCHAR(255) NOT NULL | Slack message timestamp |
| severity | VARCHAR(20) NOT NULL | `normal` or `urgent` |
| message_text | TEXT | Plain text of the posted message |
| processed_reply_ts | TEXT[] NOT NULL | Timestamps of threaded replies (for future use) |
| metadata | JSONB | Optional structured metadata |
| created_at | TIMESTAMPTZ | Default: NOW() |

**Constraints:** `UNIQUE(channel_id, message_ts)`

**Indexes:** `idx_hal_slack_posts_channel_ts` on `(channel_id, message_ts)`

## 3.14 `altus_search_queries`

Analytics log for public AI search queries. Written by `searchAltwirePublic()` on every search. Enables search trend analysis and query volume tracking.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| query | TEXT NOT NULL | Search query text |
| mode | TEXT NOT NULL | `ai` (always `ai` for MiniMax synthesis) |
| result_count | INTEGER | Number of results returned |
| response_time_ms | INTEGER | Response time in milliseconds |
| created_at | TIMESTAMPTZ | Default: NOW() |

**Indexes:** `altus_search_queries_created_idx` on `created_at DESC`

## 3.15 `altus_search_feedback`

Reader feedback on AI search results — thumbs up/down from the public search beta. Written by `POST /hal/feedback`, read by `getSearchFeedback`.

| Column | Type | Description |
|---|---|---|
| id | SERIAL PK | |
| query | TEXT NOT NULL | Original search query |
| rating | INTEGER NOT NULL | `1` = thumbs down, `2` = thumbs up |
| comment | TEXT | Optional free-text comment |
| answer_excerpt | TEXT | AI-generated answer snippet (for context) |
| results_shown | TEXT[] | URLs of articles shown in results |
| ip_address | TEXT | Anonymized IP for abuse detection |
| user_agent | TEXT | Browser user agent |
| created_at | TIMESTAMPTZ | Default: NOW() |

**Indexes:** `altus_search_feedback_created_idx` on `created_at DESC`

## 3.16 OAuth Tables

Created by `initOAuthSchema()` at startup. Persist OAuth 2.0 authorization state across deploys.

### `oauth_auth_codes`

| Column | Type | Description |
|---|---|---|
| code | VARCHAR(255) PK | Auth code value |
| client_id | VARCHAR(255) NOT NULL | OAuth client ID |
| redirect_uri | TEXT NOT NULL | Redirect URI used in authorization request |
| scope | VARCHAR(255) NOT NULL | Default: `read` |
| state | TEXT | CSRF state parameter |
| code_challenge | TEXT | PKCE challenge (S256 method) |
| code_challenge_method | VARCHAR(10) | `S256` |
| created_at | TIMESTAMPTZ | Default: NOW() |
| expires_at | TIMESTAMPTZ NOT NULL | 10-minute TTL |

### `oauth_access_tokens`

| Column | Type | Description |
|---|---|---|
| token | VARCHAR(255) PK | Access token value |
| client_id | VARCHAR(255) NOT NULL | OAuth client ID |
| scope | VARCHAR(255) NOT NULL | Default: `read` |
| created_at | TIMESTAMPTZ | Default: NOW() |
| expires_at | TIMESTAMPTZ NOT NULL | 1-hour TTL |

**Indexes:** `idx_oauth_access_tokens_expires` on `expires_at`

### `oauth_refresh_tokens`

| Column | Type | Description |
|---|---|---|
| token | VARCHAR(255) PK | Refresh token value |
| client_id | VARCHAR(255) NOT NULL | OAuth client ID |
| scope | VARCHAR(255) | Token scope |
| created_at | TIMESTAMPTZ | Default: NOW() |
| expires_at | TIMESTAMPTZ | 30-day TTL (backfilled for existing rows) |

---

# 4. Tool Catalog

All tools live in `index.js` on altwire-altus. All use `safeToolHandler` wrapper. All database-guarded tools check `DATABASE_URL` before executing. Tool registration uses `server.registerTool()` with Zod input schemas.

## 4.1 RAG Archive Tools

Handlers: `handlers/altus-search.js`, `handlers/altus-coverage.js`, `handlers/altus-reingest.js`, `handlers/altus-stats.js`, `handlers/altus-fetch.js`, `handlers/altwire-search.js`

### search_altwire (Public AI Search)

Public-facing AI-powered search for AltWire readers. Embeds the query via Voyage AI `voyage-3-lite`, searches `altus_content` for relevant posts using cosine similarity, and synthesizes a plain-language answer via MiniMax-2.7 with cited sources. Falls back to a ranked result list if the synthesis service is unavailable.

| Parameter | Type | Default | Description |
|---|---|---|---|
| query | string | required | The search query — artist name, topic, concept, or question |
| limit | integer | 10 | Max archive results to retrieve (max 20) |

Returns: `{ answer, citations[], results[], error? }`. Results include `title`, `url`, `excerpt`, `score`.

**Note:** Does NOT use recency weighting (unlike `search_altwire_archive`). Uses minimum score threshold `ALTWIRE_SEARCH_MIN_SCORE` (default 0.70).

### get_search_feedback

Retrieves search feedback submitted by readers during the AI search beta. Useful for reviewing what users are saying about search quality, accuracy, and relevance.

| Parameter | Type | Default | Description |
|---|---|---|---|
| rating | integer | optional | Filter by rating — `1` = thumbs down, `2` = thumbs up |
| since | string | optional | Return feedback created after this ISO date |
| limit | integer | 50 | Max entries to return (max 200) |

Returns: `{ feedback[], count, error? }`.

### search_altwire_archive

Searches the AltWire content archive using semantic similarity. Embeds the query via Voyage AI `voyage-3-lite`, runs cosine similarity search over `altus_content`, applies recency weighting, and re-sorts before returning. Over-fetches 3× the requested limit so recency re-sort can promote recent candidates.

| Parameter | Type | Default | Description |
|---|---|---|---|
| query | string | required | Artist name, topic, or concept |
| content_type | enum `post\|gallery\|all` | `all` | Filter by content type |
| limit | integer | 5 | Results to return (max 20) |

Returns: `{ results[], total_searched, query }`. Each result includes `type`, `title`, `slug`, `url`, `published_at`, `categories`, `tags`, `snippet` (first 300 chars), `similarity` (raw cosine), `weighted_score` (recency-adjusted).

**Recency weighting formula:** `weighted_score = similarity × (1 / (1 + 0.15 × age_years))`. Galleries without a publish date use a 3-year fallback age.

### analyze_coverage_gaps

Analyzes how thoroughly AltWire has covered a specific artist or topic. Uses a fixed internal search depth of at least 20 results regardless of the user's `limit` parameter — the limit controls output array sizes, not evaluation depth. Calls Claude Haiku to synthesize a plain-English coverage assessment.

| Parameter | Type | Default | Description |
|---|---|---|---|
| subject | string | required | Artist name, band name, or topic |
| limit | integer | 10 | Max archive results to analyze (max 20) |

Returns: `{ subject, coverage_status, top_similarity, direct_coverage_count, related_coverage_count, has_written_coverage, has_photo_coverage, months_since_last_post, direct_coverage[], related_coverage[], assessment, editorial_opportunities[] }`.

**Coverage status classification** (based on `weighted_score`):
- `none` — top score < 0.25
- `gallery_only` — direct gallery hits but no direct post hits
- `written_only` — direct post hits but no direct gallery hits
- `full` — both direct posts and galleries
- `indirect` — some related coverage but nothing direct (weighted_score 0.25–0.49)

**Similarity thresholds:**
- ≥ 0.50 weighted = direct coverage
- 0.35–0.49 weighted = related coverage
- < 0.25 weighted = no meaningful coverage

### get_archive_stats

Returns health and coverage statistics for the AltWire content archive — total documents indexed, breakdown by type, last ingest run, and any errors. No parameters.

### reingest_altwire_archive

Re-runs the AltWire content ingestion pipeline. Pulls all published posts and galleries from WordPress, regenerates Voyage AI embeddings, and upserts to `altus_content`. Gallery descriptions are synthesized via Claude Haiku when the gallery lacks a meaningful description.

| Parameter | Type | Default | Description |
|---|---|---|---|
| mode | enum `full\|recent` | `recent` | `full` = all 1500+ documents; `recent` = last 30 days only |
| dry_run | boolean | false | If true, fetches and processes but does not write to database |

**Warning:** Full mode takes 3–5 minutes. Do not call in full mode from Claude.ai (MCP timeout). Verify completion via `get_archive_stats` checking `last_ingest_run` timestamp.

### get_content_by_url

Retrieves a specific piece of content from the AltWire archive by its URL or slug. Use when a specific article or gallery is referenced by name or link rather than by topic.

| Parameter | Type | Default | Description |
|---|---|---|---|
| url | string | optional | Full URL, e.g. `https://altwire.net/my-chemical-romance-philadelphia/` |
| slug | string | optional | URL slug only, e.g. `my-chemical-romance-philadelphia` |

At least one of `url` or `slug` must be provided.

---

## 4.2 Analytics Tools — Matomo

Handler: `handlers/altwire-matomo-client.js`

All tools require `period` (`day`, `week`, `month`, `year`) and `date` (ISO date or Matomo keyword like `yesterday`, `today`). Uses the Matomo Reporting API with `ALTWIRE_MATOMO_URL`, `ALTWIRE_MATOMO_TOKEN_AUTH`, and `ALTWIRE_MATOMO_SITE_ID`.

### get_altwire_site_analytics

AltWire traffic summary for a period — visits, unique visitors, pageviews, bounce rate. Use to assess overall site health and content performance trends.

| Parameter | Type | Description |
|---|---|---|
| period | enum `day\|week\|month\|year` | Time period |
| date | string | Matomo date — ISO date or keyword like `yesterday`, `today` |

### get_altwire_top_pages

AltWire most-viewed articles, entry pages, and exit pages for a period. Use to identify best-performing content and high-exit pages that may need improvement.

| Parameter | Type | Description |
|---|---|---|
| period | enum `day\|week\|month\|year` | Time period |
| date | string | Matomo date |

### get_altwire_traffic_sources

AltWire referrer breakdown — where readers are coming from. Includes social media, organic search, direct, and campaign referrers. Use to understand content distribution channel performance.

| Parameter | Type | Description |
|---|---|---|
| period | enum `day\|week\|month\|year` | Time period |
| date | string | Matomo date |

### get_altwire_site_search

AltWire internal search terms — what readers are searching for on the site. Useful for identifying content gaps and topics with reader demand.

| Parameter | Type | Description |
|---|---|---|
| period | enum `day\|week\|month\|year` | Time period |
| date | string | Matomo date |

**Metric interpretation context (editorial, not e-commerce):**
- **Bounce rate 70–90%** is normal for a news publication — readers finish an article and leave. Do not flag unless avg time-on-page is under 60 seconds.
- **Social amplification** (X, Instagram, Reddit) is the primary distribution channel.
- **Google Discover** is high-value for entertainment/music content — flag when Discover traffic spikes.
- **Site search queries** are content gap signals, not UX issues.
- See `docs/analytics-editorial-context.md` for the full editorial interpretation guide.

---

## 4.3 Analytics Tools — Google Search Console

Handler: `handlers/altwire-gsc-client.js`

Uses the `googleapis` npm package with service account authentication. Reads `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON` and `ALTWIRE_GSC_SITE_URL` from environment. All functions return structured objects, never throw. The `normalizeDimensions()` helper defensively normalizes the `dimensions` parameter — handles string, JSON-stringified array, plain array, and undefined inputs.

### get_altwire_search_performance

AltWire Google Search Console data — queries driving organic traffic, impressions, clicks, CTR, and average position. Use to identify which content is ranking and where there's room to improve.

| Parameter | Type | Default | Description |
|---|---|---|---|
| start_date | string | required | ISO date e.g. `2024-06-01` |
| end_date | string | required | ISO date e.g. `2024-06-30` |
| dimensions | string | `query` | Dimensions to group by — e.g. `query`, `page`, `country` |
| row_limit | integer | 25 | Max rows (max 1000) |

### get_altwire_search_opportunities

AltWire high-impression, low-CTR search queries — topics where AltWire appears in results but readers aren't clicking. Fetches top 100 queries by impressions, computes median CTR and median impressions, then filters to queries with impressions above median AND CTR below median.

| Parameter | Type | Default | Description |
|---|---|---|---|
| start_date | string | required | ISO date |
| end_date | string | required | ISO date |

Returns: `{ startDate, endDate, medianCtr, opportunities[] }`.

### get_altwire_sitemap_health

Check GSC sitemap fetch status for altwire.net. Returns per-sitemap health: path, lastDownloaded, lastSubmitted, isPending, errors, warnings. Alerts if sitemap is stale or unfetchable. No parameters.

---

## 4.4 Editorial Intelligence Tools

Three handler files: `handlers/altus-topic-discovery.js` (story opportunities), `handlers/altus-news-monitor.js` (news monitoring), `handlers/altus-performance-tracker.js` (post-publish tracking).

### get_story_opportunities

Cross-references GSC opportunity-zone queries (position 5–30) against the AltWire archive to surface story opportunities where search demand exists but coverage is thin. Uses Claude Haiku to synthesize editorial pitches. Results are cached daily in `agent_memory`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| days | integer | 28 | GSC lookback window (7–90) |

Returns: `{ opportunities[], pitches, total_evaluated, date_range, cached }`.

**Opportunity scoring formula:** `score = impressions × positionProximity × gapMultiplier`
- `positionProximity = 1 - (position - 5) / 25`
- `gapMultiplier`: 1.5 (no_coverage, weighted_score < 0.25), 1.2 (weak_coverage, 0.25–0.49), 1.0 (covered, ≥ 0.50)

Top 10 opportunities by score are sent to Claude Haiku for editorial pitch synthesis. AI usage is logged via `logAiUsage()`.

### get_news_opportunities

Tracks GSC News search type data and cross-references with the watch list (`altus_watch_list` table) to surface News coverage opportunities and alert on watch list activity. Fetches both News queries and News pages for the last 7 days.

| Parameter | Type | Default | Description |
|---|---|---|---|
| days | integer | 7 | GSC News lookback window (1–30) |

Returns: `{ news_queries[], watch_list_matches[], news_pages[], watch_list_note? }`.

**Watch list matching:** Case-insensitive substring match — if a News query contains a watch list item name, it's flagged as a match. Graceful handling if `altus_watch_list` table doesn't exist yet.

### get_article_performance

Returns post-publish GSC performance snapshots (72h, 7d, 30d) for tracked articles. Pass `article_url` for a specific article or omit for aggregate of the most recent 20 articles.

| Parameter | Type | Default | Description |
|---|---|---|---|
| article_url | string | omit for aggregate | Full article URL |
| snapshot_type | enum `72h\|7d\|30d` | all | Filter to specific snapshot interval |

### get_news_performance_patterns

Analyzes which content types get Google News pickup — groups News-appearing articles by category and tag to identify patterns for optimizing News visibility. Cross-references GSC News page data against `altus_content` for enrichment with categories, tags, and publish dates.

| Parameter | Type | Default | Description |
|---|---|---|---|
| days | integer | 30 | Lookback window (7–90) |

Returns: `{ patterns: { by_category[], by_tag[] }, enriched_articles[], total_news_pages }`.

---

## 4.5 Review & Loaner Tracker Tools

Handler: `handlers/review-tracker-handler.js`

Full spec: `.kiro/specs/altus-review-loaner-tracker/`

### Review Management

| Tool | Description |
|---|---|
| `altus_create_review` | Create a new review assignment. Reviewer defaults to Derek. Status defaults to `assigned`. |
| `altus_update_review` | Update status, reassign, update due date, add editorial notes, record WordPress post ID. Validates status against pipeline values. |
| `altus_get_review` | Fetch full review details by ID. |
| `altus_list_reviews` | List reviews with optional filters: status, reviewer. Ordered by `due_date` ASC, nulls last. |
| `altus_get_upcoming_review_deadlines` | Reviews due within the next N days (default 7), excluding published/cancelled. |

### Loaner / Keeper Management

| Tool | Description |
|---|---|
| `altus_log_loaner` | Log a review item received. Records whether it's a loaner (with optional return deadline) or a keeper. Keeper rule: `is_loaner=false` → `status='kept'`, `expected_return_date=NULL`. |
| `altus_update_loaner` | Mark returned, convert to keeper, change return date, update status. Auto-sets `actual_return_date` on return. |
| `altus_get_loaner` | Fetch full details of a specific loaner item. |
| `altus_list_loaners` | List loaner items with optional filters: status, borrower. Ordered by `loaned_date` DESC. |
| `altus_get_overdue_loaners` | All loaner items past their expected return date — computed dynamically, not from status field. |
| `altus_get_upcoming_loaner_returns` | Loaner items expected back within the next N days (default 14). |

### Review Notes

| Tool | Description |
|---|---|
| `altus_add_review_note` | Add a check-in note to a review. Auto-classifies as pro/con/observation via Haiku if category not specified. Never blocks on classification failure. |
| `altus_update_review_note` | Correct a note's text or category. |
| `altus_list_review_notes` | Fetch all notes for a review, optionally filtered by category. Ordered by `created_at` ASC. |
| `altus_delete_review_note` | Delete a note by ID. |

### Digest

| Tool | Description |
|---|---|
| `altus_get_editorial_digest` | Full editorial status: review pipeline counts by status, upcoming deadlines (7 days), overdue loaners, loaner summary by status. Direct DB queries — does not call other handler functions. |

---

## 4.6 Watch List Tools

Handler: `handlers/altus-watch-list.js`

Full spec: `.kiro/specs/altus-watch-list/`

The existing `getNewsOpportunities` function in `altus-news-monitor.js` already queries `altus_watch_list WHERE active = true` and handles the table's absence gracefully. Once the table is populated, cross-referencing activates automatically with zero changes to the news monitor.

### altus_add_watch_subject

Add an artist or topic to the news monitor watch list. Case-preserved storage with application-level case-insensitive duplicate detection via `LOWER(name)` comparison.

| Parameter | Type | Default | Description |
|---|---|---|---|
| name | string | required | Artist name or topic |
| notes | string | optional | Context, e.g. "touring in summer 2026" |

Returns: `{ subject: { id, name, active, added_at, notes } }` or `{ error: 'duplicate', existing_id, existing_name }`.

### altus_remove_watch_subject

Remove a subject from the watch list by soft-deleting (sets `active=false`). Accepts `id` or `name` (at least one required). Name matching uses case-insensitive ILIKE.

| Parameter | Type | Default | Description |
|---|---|---|---|
| id | integer | optional | Watch subject ID |
| name | string | optional | Artist name (ILIKE match) |

Returns: `{ deactivated_count, subjects[] }`.

### altus_list_watch_subjects

View the current news monitor watch list. Returns active subjects by default, ordered by `active` DESC then `added_at` DESC.

| Parameter | Type | Default | Description |
|---|---|---|---|
| include_inactive | boolean | false | Include deactivated entries |

Returns: `{ subjects[], total, active_count }`.

---

## 4.7 AI Writer Tools

Handler: `handlers/altus-writer.js`
AI generation abstraction: `lib/writer-client.js`
Markdown converter: `lib/markdown.js`
UI labels: `hal-labels.js`

Full spec: `.kiro/specs/altus-ai-writer/`, `.kiro/specs/altus-html-export/`

The AI Writer is a multi-step content generation pipeline: assignment → outline → approval → draft → fact-check → WordPress post. All AI generation calls route through `lib/writer-client.js` which supports both Anthropic and OpenAI models, controlled by the `ALTUS_WRITER_MODEL` environment variable (default: `claude-sonnet-4-5`). The pipeline enforces human-in-the-loop approval at the outline stage and posts only WordPress drafts — never published content.

### Writer Client (`lib/writer-client.js`)

Unified AI generation abstraction. The handler never calls Anthropic or OpenAI SDKs directly — always through `generate()`.

- **Provider detection:** Model names starting with `gpt-`, `o1`, or `o3` route to OpenAI; all others route to Anthropic
- **Default model:** `claude-sonnet-4-5` (via `ALTUS_WRITER_MODEL` env var)
- **Web search:** Anthropic uses `{ type: 'web_search_20250305', name: 'web_search' }`; OpenAI uses `{ type: 'web_search_preview' }`
- **JSON mode:** Anthropic appends system prompt instruction; OpenAI uses `response_format: { type: 'json_object' }`
- **Cost logging:** Handled internally after every `generate()` call via `logAiUsage()` — the handler never calls `logAiUsage()` directly for generation calls

```javascript
generate({ toolName, system, prompt, maxTokens, webSearch, jsonMode })
```

### Markdown Converter (`lib/markdown.js`)

Shared regex-based markdown-to-HTML converter used by both `postToWordPress` and `getDraftAsHtml`. No external dependencies. Converts headings (`#`, `##`, `###`), bold, italic, links, unordered lists, ordered lists, and paragraphs.

### create_article_assignment

Start a new AI Writer assignment. Runs archive research (via `searchAltwireArchive`) and web research (via `generate()` with `webSearch: true`) in parallel using `Promise.allSettled`. Either research source failing does not block the other. Returns when research is complete and status is `outline_ready`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| topic | string | required | What to cover — as Derek described it |
| article_type | enum `article\|review\|interview\|feature` | `article` | Content type |
| review_notes_id | integer | optional | ID of an `altus_reviews` entry to pull pro/con notes from |

Returns: `{ success, assignment: { id, topic, article_type, status, archive_hits, web_research_summary, has_review_notes } }`.

### generate_article_outline

Generate a structured outline from an assignment's research. Includes archive research, web research, topic, article type, and review notes (if linked) in the prompt context. Uses `jsonMode: true` for structured output.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |

Returns: `{ success, assignment_id, outline: { title_suggestion, sections: [{ title, points[] }], angle, estimated_words } }`.

**Precondition:** Assignment status must be `outline_ready`.

### approve_outline

Record Derek's approval or rejection of an outline. Nothing is written until this is called with `decision='approved'`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |
| decision | enum `approved\|rejected\|modified` | required | Editorial decision |
| feedback | string | optional | Derek's notes or modification instructions |

**Status transitions:**
- `approved` → status becomes `outline_approved`
- `rejected` → status becomes `cancelled`
- `modified` → feedback stored in `outline_notes`, status reset to `outline_ready` for regeneration

Logs an editorial decision with `stage='outline'`.

### generate_article_draft

Generate the full article draft from an approved outline. Uses web research, archive voice reference, and review notes if present. Draft stored as markdown in `draft_content`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |

Returns: `{ success, assignment_id, status: 'draft_ready', word_count, draft_preview }`.

**Precondition:** Assignment status must be `outline_approved`.

### fact_check_draft

Run a fact-checking pass on a completed draft. Verifies specific factual claims via web search. If issues are found, regenerates only the flagged sections (preserving clean sections), then runs one additional check. Maximum one regeneration cycle.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |

Returns: `{ success, assignment_id, passed, issues_found, status }`.

**Precondition:** Assignment status must be `draft_ready` or `needs_revision`.

**Fact-check loop:** Initial check → if issues found, regenerate flagged sections → re-check → set status to `ready_to_post` regardless of second pass result.

### post_to_wordpress

Post a clean draft to WordPress as a draft post. Never publishes directly. Converts markdown to HTML via `lib/markdown.js`. Uses `buildAuthHeader()` from `lib/wp-client.js` for authentication.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |
| title | string | optional | Override the outline title suggestion |
| categories | string[] | optional | WordPress category names |
| tags | string[] | optional | WordPress tag names |

Returns: `{ success, assignment_id, wp_post_id, wp_post_url, status: 'posted' }`.

**Precondition:** Assignment status must be `ready_to_post`.

Logs an editorial decision with `stage='post'`, `decision='approved'`.

### get_draft_as_html

Returns the article draft as clean HTML for copy-pasting into WordPress's Text/Code editor. Does not post to WordPress — just converts and returns the HTML. Available once a draft exists, regardless of pipeline status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |

Returns: `{ success, assignment_id, topic, title_suggestion, html, word_count, instructions }`.

**No status precondition** — available at any post-draft stage.

### log_editorial_decision

Record Derek's feedback or decision on any stage of the pipeline. Use for explicit feedback, cancellations, or supplemental decisions. Populates `article_type` and `topic` from the referenced assignment.

| Parameter | Type | Default | Description |
|---|---|---|---|
| assignment_id | integer | required | Assignment ID |
| stage | enum `outline\|draft\|post\|feedback` | required | Pipeline stage |
| decision | enum `approved\|rejected\|modified\|cancelled` | required | Editorial decision |
| feedback | string | optional | Derek's notes |

### get_article_assignment

Fetch full details of a specific assignment including research context, outline, draft status, and decision history.

| Parameter | Type | Default | Description |
|---|---|---|---|
| id | integer | required | Assignment ID |

Returns: Full assignment record with `decisions[]` array of editorial decisions ordered by `created_at` ASC.

### list_article_assignments

List active assignments with optional filters by status or type. Returns summary fields (omits large fields like `archive_research`, `web_research`, `outline`, `draft_content`, `fact_check_results`).

| Parameter | Type | Default | Description |
|---|---|---|---|
| status | string | optional | Filter by pipeline status |
| article_type | enum `article\|review\|interview\|feature` | optional | Filter by article type |
| limit | integer | 20 | Results per page (max 50) |
| offset | integer | 0 | Pagination offset |

Returns: `{ assignments[], count, total }`.

### get_writer_summary

Aggregated writer stats for the prompt page context card — active assignments, action needed count, ready to post count, last digest time, search opportunities, and today's Matomo pageviews. All data fetched in parallel via `Promise.allSettled` so individual failures don't block the response.

Returns: `{ success: true, writer: { active, action_needed, ready_to_post }, digest: { last_updated, warning_count }, opportunities: { high, medium, low }, analytics: { pageviews_today, top_article } }`.

---

## 4.8 Chart Generation Tool

Handler: `hal-chart.js`

Pure function — no database, no async. Validates and structures chart data for rendering by the ChartArtifact component in hal-chat-ui.

### generate_chart

Render a chart inline in the Chat UI using data already in context. Use ONLY after fetching the underlying data — do not call this tool without data to chart. Supported types: `line` (trends over time), `bar` (category comparisons), `pie` (proportions, max 6 segments).

| Parameter | Type | Default | Description |
|---|---|---|---|
| chart_type | enum `line\|bar\|pie` | required | Chart type |
| title | string | required | Chart title (max 120 chars) |
| description | string | optional | Subtitle or context note (max 240 chars) |
| x_label | string | optional | X-axis label (line and bar only, max 60 chars) |
| y_label | string | optional | Y-axis label (line and bar only, max 60 chars) |
| series | string[] | optional | Series names for multi-series charts (max 4) |
| data | array | required | Data array. Single-series: `[{x, value}]`. Multi-series: `[{x, seriesName1, seriesName2}]`. Pie: `[{name, value}]`. Max 200 points. |

Returns: `{ success, chart_spec: true, chart_type, title, description, x_label, y_label, series, data }` or `{ success: false, exit_reason: 'validation_error', message }`.

---

## 4.9 Better Stack Monitoring Tools

Handler: `handlers/altus-monitoring.js`

Uses Better Stack API (read-only token). Fetches live uptime and incident data for AltWire's monitors.

| Monitor ID | What it watches |
|---|---|
| `1881007` | altwire.net uptime |
| `2836297` | AltWire WP Cron |

### get_altwire_uptime

Live status of AltWire's uptime monitors — altwire.net and WP Cron. Returns overall health and per-monitor status.

Returns: `{ site: { status, last_checked_at, url }, wp_cron: { status, last_checked_at, url } }`.

### get_altwire_incidents

Open (unresolved) incidents on AltWire's Better Stack monitors. Returns empty list when all is well.

Returns: `{ site: [{ name, started_at, cause }], wp_cron: [{ name, started_at, cause }] }`.

---

## 4.10 Morning Digest Tool

Handler: `handlers/altus-digest.js`

Aggregates 7 data sources into a single daily briefing. Uses `Promise.allSettled` so individual source failures never block the digest.

### get_altwire_morning_digest

Full AltWire morning briefing — site uptime, open incidents, today's news alerts, story opportunities, upcoming review deadlines, overdue loaners, and yesterday's traffic. Use at the start of a session or when Derek asks for a status overview. Results are not cached — always fetches fresh data.

Returns: `{ date, generated_at, uptime: { site, wp_cron }, incidents: { site, wp_cron }, news_alerts, story_opportunities: { count, top[] }, review_deadlines: { reviews[], count }, overdue_loaners: { loaners[], count }, traffic, warnings[] }`.

---

## 4.11 Slack Integration Tools

Handler: `handlers/slack-altus.js`

Provides outbound status posting from Hal to Slack. Uses `@slack/bolt` with a no-op receiver and manual HTTP request processing via `handleSlackRequest`. Does NOT bridge incoming Slack events into the agent — that requires hal-harness.js which is nimbus-specific.

Channel routing is automatic by `post_type`:
- `status_update`, `alert`, `incident_resolved`, `task_complete`, `observation` → `#admin-announcements`
- `dave_digest` → `#bug-reports`
- `channel_override` bypasses routing

### post_slack_status

Post a status update to Slack. Channel routing is automatic by post_type. Posts are recorded in `hal_slack_posts` for audit.

| Parameter | Type | Default | Description |
|---|---|---|---|
| text | string | required | Status update text to post |
| post_type | enum `status_update\|alert\|incident_resolved\|task_complete\|observation\|dave_digest` | `status_update` | Determines routing |
| emoji | string | `:information_source:` | Lead emoji. `:white_check_mark:` resolved, `:warning:` alert, `:hammer_and_wrench:` task, `:bar_chart:` digest |
| severity | enum `normal\|urgent` | `normal` | Urgent posts bypass quiet hours |
| channel_override | string | optional | Post directly to a channel ID |

Returns: `{ posted, ts, channel }` or `{ posted: false, reason }`.

### get_slack_post_history

Query recent Hal-initiated Slack status posts from the `hal_slack_posts` table.

| Parameter | Type | Default | Description |
|---|---|---|---|
| limit | integer | 10 | Number of posts to return (max 50) |
| severity_filter | enum `normal\|urgent` | optional | Filter by severity |

Returns: Array of post records ordered by `created_at` DESC.

---

## 4.12 Editorial Tracking Tools

Handler: `handlers/altus-editorial-tools.js`

Article tracking and content idea management tools for editorial planning. Stored in `agent_memory` with `altwire:article:{slug}` and `altwire:idea:{uuid}` key patterns.

### track_article

Track an article for performance monitoring. Stores URL, title, category, and optional notes in agent memory.

| Parameter | Type | Default | Description |
|---|---|---|---|
| url | string | required | Article URL — slug is derived from the URL path |
| title | string | required | Article title |
| category | string | required | Content category — e.g. review, interview, feature, news |
| notes | string | optional | Optional editorial notes |

Returns: `{ success: true, key, slug }`.

### list_tracked_articles

List all tracked articles, newest first.

| Parameter | Type | Default | Description |
|---|---|---|---|
| limit | integer | 50 | Max articles to return (max 100) |

Returns: `{ success: true, articles[], total }`.

### add_content_idea

Add a new editorial content idea.

| Parameter | Type | Default | Description |
|---|---|---|---|
| topic | string | required | The content topic or angle |
| angle | string | optional | Specific angle or take |
| status | enum `idea\|writing\|published` | `idea` | Pipeline status |
| notes | string | optional | Optional notes |

Returns: `{ success: true, id: uuid, key }`.

### get_content_ideas

Retrieve content ideas, optionally filtered by pipeline status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| status | enum `idea\|writing\|published` | optional | Filter by status |
| limit | integer | 50 | Max ideas to return (max 100) |

Returns: `{ success: true, ideas[], total }`.

## 4.13 Link Evaluator Tool

Handler: `handlers/altus-link-evaluator.js`

Pre-publication editorial fitness evaluation. Fetches the target URL, cross-references against AltWire's 18-month analytics, editorial context, and archive coverage, then returns a plain-language fit assessment.

### evaluate_link_fitness

Evaluate a URL for AltWire editorial fitness.

| Parameter | Type | Default | Description |
|---|---|---|---|
| url | string | required | The URL to evaluate |
| description | string | optional | Admin-provided context or angle hint |

Returns: `{ url, page_title, page_description, fetch_error, fit, reasoning, suggested_angle, evidence?, steps_completed[] }`.

**Fit levels:** `excellent` | `decent` | `okay` | `questionable` | `poor`

Uses MiniMax-2.7 via `MINIMAX_API_KEY` for analysis. SSE step events emitted via `emitToolEvent`.

## 4.14 Author Profile Tools

Handler: `hal-harness.js` — `getDerekAuthorProfile()`

Editorial voice profile for AI Writer. Loaded and injected into draft generation context. Stored in `agent_memory` at `hal:altwire:editorial_voice_profile`.

### get_author_profile

Returns the editorial voice profile — writing voice, tone preferences, and what to preserve in AI-generated drafts.

Returns: `{ success: true, profile: { writing_voice, what_to_preserve_in_ai_drafts, ... } }`.

### update_author_profile

Update a single field of the editorial voice profile. Valid dot-notation field paths:

| Field Path | Description |
|---|---|
| `writing_voice.tone` | Overall tone |
| `writing_voice.formality` | Formality level |
| `writing_voice.sentence_patterns` | Sentence style notes |
| `writing_voice.first_person_usage` | First-person usage preference |
| `writing_voice.emotional_candor` | Emotional candor level |
| `writing_voice.humor_style` | Humor style |
| `what_to_preserve_in_ai_drafts` | What to preserve in AI-generated drafts |

| Parameter | Type | Default | Description |
|---|---|---|---|
| field_path | string | required | Dot-notation path — e.g. `writing_voice.tone` |
| value | string | required | New value for the field |

Returns: `{ success: true, profile }`.

## 4.15 Hal Agent Memory Tools

Handler: `handlers/hal-memory.js`

Memory read/write/list tools scoped to the Hal agent. Used to access `hal:soul:altwire`, `hal:altwire:editorial_context`, and other Hal memory keys. Protected keys (`hal:soul*`, `hal:onboarding_state:*`) cannot be overwritten via `hal_write_memory`.

### hal_read_memory

Read a single Hal agent memory entry by key. Use to retrieve `hal:soul:altwire`, `hal:altwire:editorial_context`, or any other Hal memory key.

| Parameter | Type | Default | Description |
|---|---|---|---|
| key | string | required | Memory key — e.g. `hal:soul:altwire`, `hal:altwire:editorial_context` |

Returns: `{ success: true, agent, key, value, updated_at }` or `{ success: false, exit_reason: 'not_found', message }`.

### hal_write_memory

Write a Hal agent memory entry. Protected keys (`hal:soul*`, `hal:onboarding_state:*`) cannot be overwritten — use the seed script to update soul values.

| Parameter | Type | Default | Description |
|---|---|---|---|
| key | string | required | Memory key |
| value | string | required | Value to store |

Returns: `{ success: true, agent, key }` or `{ success: false, exit_reason: 'protected_key', message }`.

### hal_list_memory

List all Hal agent memory keys and values, newest first.

| Parameter | Type | Default | Description |
|---|---|---|---|
| limit | integer | 50 | Max entries to return (max 100) |

Returns: `{ success: true, entries: [{ key, value, updated_at }], total }`.

---

# 5. Tool Count Summary

| Section | Status | Count |
|---|---|---|
| RAG Archive | LIVE | 7 |
| Matomo Analytics | LIVE | 4 |
| Google Search Console | LIVE | 3 |
| Editorial Intelligence | LIVE | 4 |
| Review & Loaner Tracker | LIVE | 16 |
| Watch List | LIVE | 3 |
| AI Writer | LIVE | 13 |
| Chart Generation | LIVE | 1 |
| Better Stack Monitoring | LIVE | 2 |
| Morning Digest | LIVE | 1 |
| Slack Integration | LIVE | 2 |
| Hal Agent Memory | LIVE | 3 |
| Editorial Tools | LIVE | 4 |
| Link Evaluator | LIVE | 1 |
| **Total live** | | **65** |

---

# 6. Cron Jobs

All cron jobs are registered at startup in `index.js`, gated by `DATABASE_URL` presence. Uses `node-cron`.

| Schedule | Timezone | Job | Handler |
|---|---|---|---|
| `0 3 * * *` | UTC | Daily content ingest | `lib/ingest-cron.js` → spawns `scripts/ingest.js` as child process |
| `0 5 * * *` | America/New_York | AltWire Nightly Reflection | `handlers/altus-reflection.js` → `runAltwireReflection()` |
| `0 6 * * *` | America/New_York | Performance snapshot collection | `handlers/altus-performance-tracker.js` → `runPerformanceSnapshotCron()` |
| `0 9 * * *` | America/New_York | News monitor check | `handlers/altus-news-monitor.js` → `runNewsMonitorCron()` |

## 6.1 Daily Content Ingest (03:00 UTC)

Spawns `scripts/ingest.js` as a child process. Pulls all published posts via WordPress REST API and all galleries via the custom `altus/v1/galleries` endpoint. Generates Voyage AI embeddings and upserts to `altus_content`. Gallery descriptions are synthesized via Claude Haiku when metadata is sparse. Logs results to `altus_ingest_log`.

Required env vars: `DATABASE_URL` (or `ALTWIRE_DATABASE_URL`), `ALTWIRE_WP_URL`, `ALTWIRE_WP_USER`, `ALTWIRE_WP_APP_PASSWORD`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`.

## 6.2 Performance Snapshot Collection (06:00 ET)

Iterates over all articles in `altus_article_assignments`. For each article, determines which snapshot types (72h, 7d, 30d) are eligible but not yet collected, accounting for a 2-day GSC freshness lag. Fetches per-page GSC performance data and upserts to `altus_article_performance`.

**Snapshot eligibility logic:** An article is eligible for a snapshot type when `(effectiveDate - publishedAt) >= threshold_days` and that snapshot type hasn't been collected yet. Effective date = today minus 2 days (GSC data lag).

## 6.3 News Monitor Check (09:00 ET)

Runs `getNewsOpportunities()` and stores the result in `agent_memory` under key `altus:news_alert:{today}`. Surfaces watch list matches for Derek's morning review. Never throws — errors are logged but don't crash the server.

## 6.4 AltWire Nightly Reflection (05:00 ET)

Lightweight nightly editorial context refresh. Writes to `hal:altwire:traffic_summary`, `hal:altwire:top_articles`, and `hal:altwire:site_search_keywords` in agent_memory. Monthly (every 30 days), triggers `scripts/seed-altwire-historical-analytics.js` to refresh 18-month analytics memory keys. Uses `Promise.allSettled` so individual failures don't crash the job.

---

# 7. RAG Pipeline

## 7.1 Embedding Model

Voyage AI `voyage-3-lite` — 512-dimension embeddings. Two input types:
- `document` — used during ingestion for content storage
- `query` — used at search time for query embedding

Rate limiting: exponential backoff on 429 responses, max 5 retries with 15s initial delay. Batch size: 20 documents per API call with 1s inter-batch delay.

## 7.2 Content Sources

| Source | Endpoint | Auth | Content |
|---|---|---|---|
| WordPress posts | `GET /wp-json/wp/v2/posts` | Application Password | Published articles — title, content, excerpt, categories, tags |
| NextGEN galleries | `GET /wp-json/altus/v1/galleries` | Application Password | Gallery metadata — title, description, image alt text and captions |

Gallery descriptions are synthesized via Claude Haiku when the gallery's native description is empty or too sparse for meaningful embedding. The synthesis prompt instructs Haiku to write 2–3 factual sentences based on the gallery title, description, and image metadata.

## 7.3 Search Pipeline

1. Query text → Voyage AI `embedQuery()` (input_type: `query`)
2. Cosine similarity search over `altus_content` using pgvector `<=>` operator
3. Over-fetch 3× requested limit
4. Apply recency weighting to each result
5. Re-sort by `weighted_score` descending
6. Trim to requested limit

## 7.4 WordPress Plugin — Altus RAG Gallery Endpoint

Plugin: `wordpress/altus-galleries/altus-galleries.php`

Exposes NextGEN gallery metadata via `GET /wp-json/altus/v1/galleries`. Requires `edit_posts` capability. Returns gallery ID, title, description, slug, page URL, image count, and up to 50 image alt text/caption pairs per gallery. Paginated with `page` and `per_page` parameters (max 100 per page).

---

# 8. Hal Integration Notes

## 8.1 Derek's Session Context

Derek connects to Hal with `HAL_KEY_DEREK_WEB` (operational scope) or `HAL_KEY_DEREK_IOS` (operational scope). Altus tools are available in Derek's sessions.

**Derek's known preferences (from agent_memory):**
- Prefers concise summaries — lead with the headline number, offer to go deeper
- Editorial focus: indie rock, alternative, emerging artists
- Analytics preference: article-level breakdown, not site-wide averages
- Avoid long preambles
- Slack-first workflow

## 8.2 Domain Context (for future prompt assembly)

When the four-layer Hal framework prompt assembly is implemented (see `hal_framework_architecture.md`), the AltWire domain context belongs in `domains/altwire/domain-context.md`. Key contents:

- Vocabulary map: "articles" not "pages", "readers" not "customers", "editorial pipeline" not "order pipeline", "commission" for assignments, "byline" not "author field"
- Metric interpretation rules (bounce rate, Discover, social traffic — see §4.2)
- Reflection analyst context: interpret data through editorial/audience lens, not e-commerce lens

## 8.3 Soul Seeding and Editorial Context

The Hal soul for AltWire (`hal:soul:altwire`) is seeded at first deployment via `scripts/seed-hal-soul-altwire.js`. The editorial context object (`hal:altwire:editorial_context`) is generated by `scripts/analyze-rag-corpus.js` using a two-model approach (MiniMax for iterative drafts, Opus 4 for production output). The seed script is idempotent — it skips if the soul already exists.

---

# 9. Project Structure

```
altwire-altus/
├── index.js                           # Tool registry — 65 tools, HTTP server, OAuth, cron registration
├── logger.js                          # Structured JSON logger (stderr only)
├── hal-labels.js                      # AI Writer tool display labels for UI
├── hal-chart.js                       # Chart spec generator for Hal Chat UI
├── hal-harness.js                     # assembleSystemPrompt + getDerekAuthorProfile — AltWire context switching
│
├── handlers/
│   ├── altus-search.js                # search_altwire_archive — semantic search with recency weighting
│   ├── altus-coverage.js              # analyze_coverage_gaps — coverage assessment with Haiku synthesis
│   ├── altus-reingest.js              # reingest_altwire_archive — full/recent ingest pipeline
│   ├── altus-stats.js                 # get_archive_stats — health and coverage statistics
│   ├── altus-fetch.js                 # get_content_by_url — URL/slug lookup
│   ├── altwire-search.js              # search_altwire — public AI search via MiniMax-2.7 synthesis
│   ├── altus-topic-discovery.js       # get_story_opportunities — GSC × archive cross-reference
│   ├── altus-news-monitor.js          # get_news_opportunities — GSC News × watch list
│   ├── altus-performance-tracker.js   # get_article_performance, get_news_performance_patterns, cron
│   ├── altus-monitoring.js            # Better Stack uptime and incident fetchers
│   ├── altus-digest.js                # Morning digest aggregator — 7 data sources
│   ├── altus-reflection.js            # Nightly AltWire reflection — 5 AM ET + monthly historical seed
│   ├── altus-editorial-tools.js       # Article tracking, content ideas — 4 tools
│   ├── altus-link-evaluator.js        # evaluate_link_fitness — pre-publication editorial fitness
│   ├── altwire-matomo-client.js       # Matomo Reporting API — 4 analytics tools
│   ├── altwire-gsc-client.js         # Google Search Console API — search, opportunities, sitemap
│   ├── review-tracker-handler.js      # Review, loaner, note CRUD + editorial digest — 16 tools
│   ├── altus-watch-list.js            # Watch list CRUD — 3 tools
│   ├── altus-writer.js               # AI Writer pipeline — 11 tools (assignment → outline → draft → post)
│   ├── slack-altus.js                 # Slack integration — outbound status posting, hal_slack_posts
│   └── hal-memory.js                  # Hal agent memory read/write/list — 3 tools
│
├── lib/
│   ├── altus-db.js                    # PostgreSQL pool (named + default export), schema init, upsertContent
│   ├── ai-cost-tracker.js             # AI usage cost tracking (ai_usage table)
│   ├── safe-tool-handler.js           # safeToolHandler wrapper + SSE event emitter
│   ├── altus-event-bus.js             # In-memory SSE event bus per sessionId
│   ├── synthesizer.js                 # Claude Haiku synthesis — galleries, coverage, pitches
│   ├── voyage.js                      # Voyage AI embedding — embedDocuments, embedQuery
│   ├── recency.js                     # Time decay weighting for search results
│   ├── ingest-cron.js                 # Daily ingest scheduler (03:00 UTC)
│   ├── wp-client.js                   # WordPress REST API client + buildAuthHeader
│   ├── writer-client.js              # Unified AI generation abstraction (Anthropic/OpenAI routing)
│   ├── markdown.js                    # Shared markdown-to-HTML converter (regex-based, no deps)
│   ├── minimax-search.js             # MiniMax-2.7 synthesis for public search answers
│   ├── editorial-helpers.js           # loadEditorialContext, scoreEditorialAffinity — shared editorial utils
│   ├── rate-limiter.js               # Sliding-window rate limiter (global + auth)
│   └── oauth-store.js                # OAuth 2.0 token store — auth codes, access tokens, refresh tokens
│
├── scripts/
│   ├── ingest.js                      # Standalone ingest script (spawned by cron)
│   ├── analyze-rag-corpus.js         # Two-model corpus analysis → hal:altwire:editorial_context
│   ├── seed-hal-soul-altwire.js      # Initial Hal soul seeding for AltWire
│   ├── seed-altwire-historical-analytics.js  # 18-month analytics memory key seeding (monthly)
│   └── test-seed-prereqs.js          # Prerequisite validation before seeding
│
├── tests/
│   ├── *.unit.test.js                 # Vitest unit tests
│   ├── *.property.test.js             # fast-check property-based tests
│   └── *.test.js                      # General tests
│
├── wordpress/
│   └── altus-galleries/
│       └── altus-galleries.php        # WP plugin — NextGEN gallery REST endpoint
│
├── docs/
│   ├── AltWire_AI_Agent_Platform_Unified_Spec.md  # This document
│   ├── analytics-editorial-context.md              # Editorial interpretation guide
│   └── superpowers/plans/                          # Historical planning documents
│
├── .env.example                       # Reference for all required env vars
├── package.json                       # ESM, Node ≥ 20, vitest + fast-check + @slack/bolt
├── railway.toml                       # Railway deployment config
└── nixpacks.toml                      # Build config — nodejs_22, npm-10_x
```

---

# 10. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js ≥ 20 (ESM — all files use `import`/`export`) |
| MCP SDK | `@modelcontextprotocol/sdk` — McpServer, StreamableHTTPServerTransport |
| Database | PostgreSQL via `pg` pool — `ALTWIRE_DATABASE_URL` (preferred) or `DATABASE_URL` (fallback) |
| Vector search | pgvector extension — `vector(512)`, IVFFlat cosine index |
| Validation | Zod for all tool input schemas |
| HTTP | Native `node:http` createServer for both MCP transport and REST endpoints |
| Scheduling | `node-cron` for all timed jobs |
| AI calls (lightweight) | Anthropic SDK — `claude-haiku-4-5-20251001` for synthesis and classification |
| AI calls (writer) | `lib/writer-client.js` — routes to Anthropic or OpenAI based on `ALTUS_WRITER_MODEL` |
| AI cost tracking | All AI calls logged to `ai_usage` table via `lib/ai-cost-tracker.js` |
| Embeddings | Voyage AI `voyage-3-lite` via REST API |
| Analytics | Google Search Console via `googleapis`, Matomo via Reporting API |
| Monitoring | Better Stack API (uptime, incidents) |
| Slack | `@slack/bolt` — outbound status posting, no event bridging |
| OAuth 2.0 | RFC 6749 + PKCE — auth codes, access tokens, refresh tokens via `oauth-store.js` |
| Rate limiting | Sliding-window per-IP limiters — global (200/15min) and auth (30/15min) |
| Public search | MiniMax-2.7 synthesis via `minimax-search.js` — no Anthropic dependency |
| Testing | Vitest + `fast-check` for property-based testing |
| Deployment | Railway (Nixpacks builder, auto-deploy on main branch push) |

## 10.1 Key Conventions

- All async — no synchronous DB or HTTP calls
- ESM throughout — never use `require()`
- Environment variables only — no hardcoded secrets or credentials
- `TEST_MODE=true` intercepts all write operations safely
- `DATABASE_URL` guard on every tool that touches PostgreSQL
- AI cost logging via `ai-cost-tracker.js` on every Anthropic/OpenAI API call
- `safeToolHandler` wraps every tool — returns `{ exit_reason: 'tool_error' }` on unexpected exceptions
- Structured JSON logging to stderr — stdout reserved for MCP transport
- All handler functions return structured objects, never throw

---

# 11. Environment Variables

## 11.1 Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` or `ALTWIRE_DATABASE_URL` | Shared Railway PostgreSQL connection string (ALTWIRE_DATABASE_URL preferred) |
| `ALTWIRE_WP_URL` | WordPress base URL (`https://altwire.net`) |
| `ALTWIRE_WP_USER` | WordPress admin username |
| `ALTWIRE_WP_APP_PASSWORD` | WordPress Application Password (spaces kept intact) |
| `VOYAGE_API_KEY` | Voyage AI API key (`voyage-3-lite` model) |
| `ANTHROPIC_API_KEY` | Anthropic API key — gallery synthesis, coverage assessment, editorial pitches, AI Writer (when using Anthropic provider) |

## 11.2 Matomo Analytics

| Variable | Purpose |
|---|---|
| `ALTWIRE_MATOMO_URL` | Matomo server URL (e.g. `https://matomo.ozmediaservices.com/matomo/`) |
| `ALTWIRE_MATOMO_TOKEN_AUTH` | Matomo API auth token |
| `ALTWIRE_MATOMO_SITE_ID` | Matomo site ID for altwire.net |

## 11.3 Google Search Console

| Variable | Purpose |
|---|---|
| `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON` | Full JSON service account key (single line) |
| `ALTWIRE_GSC_SITE_URL` | GSC site URL (e.g. `https://altwire.net` or `sc-domain:altwire.net`) |

## 11.4 OAuth 2.0

| Variable | Purpose |
|---|---|
| `OAUTH_CLIENT_ID_<OPERATOR>` | Public client ID for named operator (scanned at startup) |
| `OAUTH_CLIENT_SECRET_<OPERATOR>` | Client secret for the operator (hashed at runtime via SHA-256) |
| `OAUTH_REDIRECT_URI` | Primary redirect URI (defaults to `<MCP_BASE_URL>/oauth/callback`) |
| `OAUTH_ALLOWED_REDIRECT_URIS` | Additional allowed redirect URIs, comma-separated |
| `OAUTH_CLIENT_TOOLS` | Per-client tool allowlists — `clientId:tool1,tool2;clientId2:tool1` |
| `MCP_BASE_URL` | Base URL for OAuth discovery endpoint (e.g. `https://altus.altwire.net`) |

## 11.5 Better Stack Monitoring

| Variable | Purpose |
|---|---|
| `BETTER_STACK_TOKEN` | Read-only Better Stack API token for uptime and incident monitoring |

## 11.6 Slack Integration

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN_ALTWUS` | Slack bot token for posting as the Altus app |
| `SLACK_SIGNING_SECRET_ALTWUS` | Slack signing secret for `/slack/events` request verification |
| `SLACK_CHANNEL_ALTWUS` | Default Slack channel for AltWire updates |
| `SLACK_CHANNEL_ADMIN_ANNOUNCEMENTS` | Channel for status updates, alerts, incidents |
| `SLACK_CHANNEL_BUG_REPORTS` | Channel for dave digest posts |
| `SLACK_CHANNEL_WATERCOOLER` | Watercooler channel (reserved for future use) |

## 11.7 Optional

| Variable | Default | Purpose |
|---|---|
| `PORT` | 3000 | Railway sets this automatically |
| `TEST_MODE` | false | Set true to skip live API calls in tests |
| `LOG_LEVEL` | info | Minimum log level (`debug`, `info`, `warn`, `error`) |
| `ALTUS_ADMIN_TOKEN` | — | Bearer token for writer REST endpoints (`/hal/writer/*`) |
| `ALTUS_WRITER_MODEL` | `claude-sonnet-4-5` | AI model for writer pipeline. Prefix-based provider detection: `gpt-*`, `o1*`, `o3*` → OpenAI; all else → Anthropic |
| `OPENAI_API_KEY` | — | Required only when `ALTUS_WRITER_MODEL` is set to an OpenAI model |
| `MINIMAX_API_KEY` | — | Required for public AI search synthesis and link evaluator |
| `ALTWIRE_SEARCH_MIN_SCORE` | 0.70 | Minimum similarity score for `search_altwire` (public search) |

---

# 12. Test Suite



22 test files covering unit tests, property-based tests, and integration tests.

| Test File | Type | What it covers |
|---|---|---|
| `altus-search.test.js` | Unit | Archive search handler |
| `altus-db.test.js` | Unit | Database schema and upsert |
| `ai-cost-tracker.unit.test.js` | Unit | Cost calculation and logging |
| `news-monitor.unit.test.js` | Unit | News monitor handler |
| `performance-tracker.unit.test.js` | Unit | Performance tracker handler |
| `topic-discovery.unit.test.js` | Unit | Topic discovery handler |
| `safe-tool-handler.test.js` | Unit | safeToolHandler wrapper |
| `synthesizer.test.js` | Unit | Claude Haiku synthesis functions |
| `voyage.test.js` | Unit | Voyage AI embedding client |
| `wp-client.test.js` | Unit | WordPress REST API client |
| `altus-writer.unit.test.js` | Unit | AI Writer pipeline handler |
| `altus-writer.property.test.js` | Property | AI Writer pipeline properties |
| `altus-html-export.unit.test.js` | Unit | HTML export and markdown converter |
| `altus-html-export.property.test.js` | Property | Markdown-to-HTML conversion properties |
| `topic-discovery.property.test.js` | Property | Coverage gap classification, opportunity scoring |
| `snapshot-eligibility.property.test.js` | Property | Snapshot eligibility determination |
| `watch-list-matching.property.test.js` | Property | Watch list case-insensitive matching |
| `gsc-response-mapping.property.test.js` | Property | GSC response normalization |
| `url-normalize.property.test.js` | Property | URL trailing slash normalization |
| `agent-memory-cache.property.test.js` | Property | Agent memory caching behavior |
| `unique-constraint.property.test.js` | Property | Database unique constraint handling |
| `zero-result-response.property.test.js` | Property | Empty result set handling |

---

# 13. Spec History & Related Documents

| Document | Description |
|---|---|
| `docs/analytics-editorial-context.md` | Full editorial interpretation guide for analytics data |
| `hal_framework_architecture.md` | Domain-aware prompt assembly architecture — Altus is the reference implementation |
| `.kiro/specs/altus-analytics/` | Analytics spec — Matomo + GSC tool implementation |
| `.kiro/specs/altus-topic-discovery-news-intelligence/` | Editorial intelligence spec — topic discovery, news monitor, performance tracker |
| `.kiro/specs/altus-review-loaner-tracker/` | Review & loaner tracker spec — 16 tools, 3 tables |
| `.kiro/specs/altus-watch-list/` | Watch list spec — 3 tools, 1 table |
| `.kiro/specs/altus-ai-writer/` | AI Writer spec — 10 pipeline tools, 2 tables, writer-client abstraction |
| `.kiro/specs/altus-html-export/` | HTML export spec — `get_draft_as_html` tool, shared markdown converter |

### Changelog Summary (v0.5 → v1.1)

- **OAuth 2.0 Authorization Server:** Full RFC 6749 + PKCE implementation with SHA-256 challenge, auth code/access token/refresh token flows, per-client tool allowlists, and `X-Agent-Context` header scoping. Replaces the previous API key pattern.
- **Rate Limiting:** Sliding-window global (200/15min per IP) and auth-specific (30/15min per IP) limiters with standard `RateLimit-*` response headers.
- **SSE Event Bus:** Real-time tool event streaming via `GET /events/:sessionId` — streams `tool_start`, `tool_done`, `thinking_done` events to the Chat UI.
- **Public AI Search (`search_altwire`):** MiniMax-2.7 synthesis over AltWire archive — full-text answer with cited sources. Reader feedback tracked in `altus_search_feedback` table.
- **AltWire Reflection cron (5 AM ET):** Nightly refresh of `hal:altwire:traffic_summary`, `hal:altwire:top_articles`, `hal:altwire:site_search_keywords`. Monthly historical analytics re-seed.
- **New Editorial Tools:** `track_article`, `list_tracked_articles`, `add_content_idea`, `get_content_ideas` — article tracking and content idea management in `agent_memory`.
- **Link Evaluator:** `evaluate_link_fitness` — pre-publication editorial fitness scoring via MiniMax-2.7 against 18-month analytics, editorial context, and archive coverage.
- **Author Profile Tools:** `get_author_profile`, `update_author_profile` — editorial voice profile stored at `hal:altwire:editorial_voice_profile` for AI Writer context injection.
- **Writer Summary:** `get_writer_summary` — aggregated writer stats for prompt page context card.
- **Hal Memory:** Removed `hal_delete_memory` (was not registered as a tool). Read/write/list remain.
- **New DB Tables:** `altus_search_queries`, `altus_search_feedback`, `oauth_auth_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`.
- **Tool count:** 57 → 65 tools.

### Changelog Summary (v0.4 → v0.5)

- **PR #6–#13 (Morning Digest & Monitoring):** Added Better Stack uptime/incident monitoring, morning digest aggregating 7 data sources, GET `/altwire/digest` REST endpoint, Slack integration with outbound status posting and `hal_slack_posts` table, Hal agent memory tools (read/write/list/delete) for soul and editorial context seeding, chart generation tool for Hal Chat UI.
- **PR #7 (Soul Seeding):** Added `scripts/seed-hal-soul-altwire.js` and `scripts/analyze-rag-corpus.js` for corpus-based editorial context analysis.
- **DB fix:** Pool now prefers `ALTWIRE_DATABASE_URL` over `DATABASE_URL` for connection.
- **Export fix:** Pool exported as both named and default export for ESM compatibility.
- **Tool count:** 45 → 57 tools.

---

# 14. Known Gotchas & Operational Notes

- **`reingest_altwire_archive` full mode** causes MCP timeout in Claude.ai (takes 3–5 min). Always verify completion via `get_archive_stats` checking `last_ingest_run` timestamp rather than waiting for tool response.
- **`ngg_shortcode_placeholder`** appearing in `raw_text` fields is a NextGEN Gallery embed artifact — not a data error.
- **Table prefix is mandatory** — all new tables must use `altus_` prefix (shared Railway PostgreSQL namespace). Exception: `ai_usage` and `agent_memory` are shared tables; `hal_slack_posts` uses `hal_` prefix.
- **Stateless transport** — `sessionIdGenerator: undefined` in `StreamableHTTPServerTransport`. Do not revert to stateful mode.
- **Haiku model string** — `claude-haiku-4-5-20251001` (correct as of May 2026). Hardcoded in `lib/synthesizer.js`.
- **Writer model string** — `claude-sonnet-4-5` default in `lib/writer-client.js`. Configurable via `ALTUS_WRITER_MODEL`.
- **`ANTHROPIC_API_KEY` is already present** — do not add as a new env var in specs.
- **Embedding dimension is 512** — the `altus_content.embedding` column is `vector(512)`, not 1024 as in the original draft. This matches the `voyage-3-lite` model output.
- **GSC freshness lag** — GSC data has a ~2 day processing delay. The performance snapshot cron accounts for this by using `effectiveDate = today - 2 days`.
- **Story opportunity caching** — `get_story_opportunities` caches results daily in `agent_memory`. Subsequent calls on the same day return cached data with `cached: true`.
- **Watch list table** — `altus_watch_list` is auto-created at startup. The news monitor cross-references it automatically. Soft-delete via `active=false` preserves historical data.
- **URL normalization** — all article URLs are normalized by stripping trailing slashes via `normalizeUrl()` before storage and comparison.
- **AI Writer pipeline is human-in-the-loop** — `approve_outline` must be called with `decision='approved'` before any draft is generated. `post_to_wordpress` creates WordPress drafts only, never published posts.
- **Writer fact-check loop** — maximum one regeneration cycle. Initial check → regenerate flagged sections → re-check → stop. Status set to `ready_to_post` regardless of second pass result.
- **`openai` package** — listed as a dependency in `package.json` for OpenAI provider support. Only loaded when `ALTUS_WRITER_MODEL` is set to an OpenAI model (lazy import).
- **Writer REST endpoints** — `/hal/writer/assignments` and `/hal/writer/assignments/:id` read from `altus_assignments` table. Require `ALTUS_ADMIN_TOKEN` bearer auth.
- **Database URL priority** — `ALTWIRE_DATABASE_URL` takes precedence over `DATABASE_URL` when both are set. Use `ALTWIRE_DATABASE_URL` for AltWire-specific connections.
- **Slack event handling** — `slack-altus.js` handles outbound posts only. Incoming Slack events (mentions, DMs, thread replies) require hal-harness.js which is nimbus-specific and not present in altwire-altus.
- **Protected memory keys** — `hal:soul*` and `hal:onboarding_state:*` keys cannot be overwritten via `hal_write_memory`. Use `scripts/seed-hal-soul-altwire.js` for soul updates. `hal_delete_memory` is not registered as a tool.
- **OAuth clients must be pre-registered** — clients are discovered by scanning `OAUTH_CLIENT_ID_*` env vars at startup. Adding a new client requires a restart.
- **Per-client tool allowlists** — if `OAUTH_CLIENT_TOOLS` is set, only listed tools are available to that client. Unlisted clients get full access.
- **`MINIMAX_API_KEY`** required for public AI search synthesis and link evaluator. Not required for other AltWire tools.
- **SSE event bus is in-memory** — events are not persisted across deploys. Chat UI must reconnect after restart.
- **S256 PKCE is required** — plain code verifier (no challenge) is rejected at the token endpoint.
- **`hal_delete_memory` removed** — was never registered as an MCP tool. Memory deletion is not exposed via API.

---

*This document should be updated whenever new tools are added, specs are completed, or infrastructure changes. It is the AltWire equivalent of the Cirrusly Weather AI Agent Platform Unified Spec.*
