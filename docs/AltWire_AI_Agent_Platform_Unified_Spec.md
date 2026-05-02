# AltWire AI Agent Platform
## Unified Specification — Altus MCP Server
## April 13, 2026 — v0.4

---

## Component Status

| Component | Description | Status |
|---|---|---|
| Altus MCP Server | AltWire-dedicated MCP server on Railway — 45 tools | LIVE at altwire-altus-production.up.railway.app |
| PostgreSQL | Shared Railway instance — `altus_` table prefix | LIVE |
| RAG Archive | Semantic search over AltWire's ~1,566 post archive | LIVE |
| Analytics Layer | Matomo + GSC tools for editorial performance | LIVE |
| Editorial Intelligence | Topic discovery, news monitoring, performance tracking | LIVE |
| Review & Loaner Tracker | Review pipeline, loaner log, pro/con notes — 16 tools | LIVE |
| Watch List | News monitor watch list management — 3 tools | LIVE |
| AI Writer | Topic → outline → draft → fact-check → WordPress pipeline — 10 tools | LIVE |
| WordPress Plugin | Altus RAG Gallery Endpoint — NextGEN metadata REST API | LIVE |
| Editorial Decisions Log | Tracks Derek's accept/reject decisions across the AI Writer pipeline | LIVE — part of AI Writer |

---

# 1. System Overview

Altus is AltWire's dedicated AI operations server. It runs independently from Cirrusly Weather's infrastructure (although all MCPs share a common database for now) — AltWire tools belong on AltWire infrastructure and grow without touching the weather store's operational layer.

A Latin adjective meaning "high," "tall," "lofty,", "deep," or "profound," the selection of Altus is also a nod to the potentially business-changing nature of this project for AltWire's future and competitiveness in an saturated vertical.

Multiple news organizations have tried over the years with AI-assisted newswriting, most of them  failing. The issue was context: those LLMs knew only of the task at hand, but little about the topic, the site it was writing for, or the style expected. Hal and Altus are a different concept.

Hal is the orchestrator: Altus is the ground truth that provides context to the AI at the right time. It is a set of specialized tools for a variety of common editorial functions. The LLM no longer has to guess what AltWire writers and admins want.

Hal's persistent layer changes everything - and in theory, should result in more specific recommendations, and better AI-generated content.

We don't suggest that the "AltWire way" is the correct way to use AI within newswriting; merely that a stateful agent has never been used in an editorial setting to our knowledge. This is novel.

Hal connects to Altus the same way it connects to other services. From Derek's perspective, it's just Hal responding to requests about AltWire. The server handles everything: content archive search, analytics, editorial tracking, AI-assisted writing, and WordPress posting.

**Core architectural principle:** Altus is the single source of truth for all AltWire AI capabilities. No AltWire-specific tools live in Nimbus or the Cirrusly monolith.

**Relationship to Hal Framework Architecture:** Altus is the greenfield reference implementation for the domain-aware system prompt architecture (see `hal_framework_architecture.md`). When the four-layer prompt assembly is built, Altus gets it first before Nimbus is backported.

## 1.1 GitHub Repository

| Repo | URL | Notes |
|---|---|---|
| altwire-altus | github.com/edoswald/altwire-altus | Altus MCP server — index.js, 45 tools |

---

# 2. Infrastructure

| Item | Value |
|---|---|
| Railway service | `altwire-altus-production` |
| MCP endpoint | `https://altwire-altus-production.up.railway.app` |
| Health endpoint | `GET /health` — returns `{ status: 'ok', service: 'altus' }` |
| Database | Shared Railway PostgreSQL — `altus_` table prefix |
| Embeddings | Voyage AI `voyage-3-lite` (512 dimensions) |
| AI model (lightweight) | `claude-haiku-4-5-20251001` |
| AI model (writer) | Configurable via `ALTUS_WRITER_MODEL` — default `claude-sonnet-4-5` |
| Transport | `StreamableHTTPServerTransport`, stateless (`sessionIdGenerator: undefined`) |
| Auth | Per-client API key — same pattern as Nimbus |
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

## 2.2 Writer REST Endpoints

Altus exposes authenticated REST endpoints for the AI Writer UI under `/hal/writer/*`. All require `Authorization: Bearer <ALTUS_ADMIN_TOKEN>`. CORS enabled.

| Endpoint | Method | Description |
|---|---|---|
| `/hal/writer/assignments` | GET | List all article assignments from `altus_assignments` — supports `?status=` and `?article_type=` filters |
| `/hal/writer/assignments/:id` | GET | Single assignment detail with joined `altus_editorial_decisions` |
| `/hal/writer/opportunities` | GET | Story opportunities (delegates to `getStoryOpportunities`) |
| `/hal/writer/news-alerts` | GET | Today's news monitor alerts from `agent_memory` |

---

# 3. Database Schema

All tables use `altus_` prefix. Auto-created at server startup via `initSchema()`, `initAiUsageSchema()`, `initReviewTrackerSchema()`, `initWatchListSchema()`, and `initWriterSchema()` — no manual migration needed. All DDL uses `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.

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

Used for caching story opportunities, news alerts, and writer assignments. Keyed by `agent='altus'`.

| Key Pattern | Description |
|---|---|
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

---

# 4. Tool Catalog

All tools live in `index.js` on altwire-altus. All use `safeToolHandler` wrapper. All `DATABASE_URL` guarded where they require PostgreSQL. Tool registration uses `server.registerTool()` with Zod input schemas.

## 4.1 RAG Archive Tools

Handlers: `handlers/altus-search.js`, `handlers/altus-coverage.js`, `handlers/altus-reingest.js`, `handlers/altus-stats.js`, `handlers/altus-fetch.js`

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

---

# 5. Tool Count Summary

| Section | Status | Count |
|---|---|---|
| RAG Archive | LIVE | 5 |
| Matomo Analytics | LIVE | 4 |
| Google Search Console | LIVE | 3 |
| Editorial Intelligence | LIVE | 4 |
| Review & Loaner Tracker | LIVE | 16 |
| Watch List | LIVE | 3 |
| AI Writer | LIVE | 10 |
| **Total live** | | **45** |

---

# 6. Cron Jobs

All cron jobs are registered at startup in `index.js`, gated by `DATABASE_URL` presence. Uses `node-cron`.

| Schedule | Timezone | Job | Handler |
|---|---|---|---|
| `0 3 * * *` | UTC | Daily content ingest | `lib/ingest-cron.js` → spawns `scripts/ingest.js` as child process |
| `0 6 * * *` | America/New_York | Performance snapshot collection | `handlers/altus-performance-tracker.js` → `runPerformanceSnapshotCron()` |
| `0 9 * * *` | America/New_York | News monitor check | `handlers/altus-news-monitor.js` → `runNewsMonitorCron()` |

## 6.1 Daily Content Ingest (03:00 UTC)

Spawns `scripts/ingest.js` as a child process. Pulls all published posts via WordPress REST API and all galleries via the custom `altus/v1/galleries` endpoint. Generates Voyage AI embeddings and upserts to `altus_content`. Gallery descriptions are synthesized via Claude Haiku when metadata is sparse. Logs results to `altus_ingest_log`.

Required env vars: `DATABASE_URL`, `ALTWIRE_WP_URL`, `ALTWIRE_WP_USER`, `ALTWIRE_WP_APP_PASSWORD`, `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`.

## 6.2 Performance Snapshot Collection (06:00 ET)

Iterates over all articles in `altus_article_assignments`. For each article, determines which snapshot types (72h, 7d, 30d) are eligible but not yet collected, accounting for a 2-day GSC freshness lag. Fetches per-page GSC performance data and upserts to `altus_article_performance`.

**Snapshot eligibility logic:** An article is eligible for a snapshot type when `(effectiveDate - publishedAt) >= threshold_days` and that snapshot type hasn't been collected yet. Effective date = today minus 2 days (GSC data lag).

## 6.3 News Monitor Check (09:00 ET)

Runs `getNewsOpportunities()` and stores the result in `agent_memory` under key `altus:news_alert:{today}`. Surfaces watch list matches for Derek's morning review. Never throws — errors are logged but don't crash the server.

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

## 8.2 Domain Context (for future prompt assembly)

When the four-layer Hal framework prompt assembly is implemented (see `hal_framework_architecture.md`), the AltWire domain context belongs in `domains/altwire/domain-context.md`. Key contents:

- Vocabulary map: "articles" not "pages", "readers" not "customers", "editorial pipeline" not "order pipeline", "commission" for assignments, "byline" not "author field"
- Metric interpretation rules (bounce rate, Discover, social traffic — see §4.2)
- Reflection analyst context: interpret data through editorial/audience lens, not e-commerce lens

## 8.3 Better Stack Monitors

| Monitor ID | What it watches |
|---|---|
| `1881007` | altwire.net uptime |
| `2836297` | AltWire WP Cron |

---

# 9. Project Structure

```
altwire-altus/
├── index.js                           # Tool registry — 45 tools, HTTP server, cron registration
├── logger.js                          # Structured JSON logger (stderr only)
├── hal-labels.js                      # AI Writer tool display labels for UI
│
├── handlers/
│   ├── altus-search.js                # search_altwire_archive — semantic search with recency weighting
│   ├── altus-coverage.js              # analyze_coverage_gaps — coverage assessment with Haiku synthesis
│   ├── altus-reingest.js              # reingest_altwire_archive — full/recent ingest pipeline
│   ├── altus-stats.js                 # get_archive_stats — health and coverage statistics
│   ├── altus-fetch.js                 # get_content_by_url — URL/slug lookup
│   ├── altus-topic-discovery.js       # get_story_opportunities — GSC × archive cross-reference
│   ├── altus-news-monitor.js          # get_news_opportunities — GSC News × watch list
│   ├── altus-performance-tracker.js   # get_article_performance, get_news_performance_patterns, cron
│   ├── altwire-matomo-client.js       # Matomo Reporting API — 4 analytics tools
│   ├── altwire-gsc-client.js         # Google Search Console API — search, opportunities, sitemap, news
│   ├── review-tracker-handler.js      # Review, loaner, note CRUD + editorial digest — 16 tools
│   ├── altus-watch-list.js            # Watch list CRUD — 3 tools
│   └── altus-writer.js               # AI Writer pipeline — 10 tools (assignment → outline → draft → post)
│
├── lib/
│   ├── altus-db.js                    # PostgreSQL pool (singleton), schema init, upsertContent
│   ├── ai-cost-tracker.js             # AI usage cost tracking (ai_usage table)
│   ├── safe-tool-handler.js           # safeToolHandler wrapper — try/catch with structured error
│   ├── synthesizer.js                 # Claude Haiku synthesis — galleries, coverage, pitches
│   ├── voyage.js                      # Voyage AI embedding — embedDocuments, embedQuery
│   ├── recency.js                     # Time decay weighting for search results
│   ├── ingest-cron.js                 # Daily ingest scheduler (03:00 UTC)
│   ├── wp-client.js                   # WordPress REST API client + buildAuthHeader
│   ├── writer-client.js              # Unified AI generation abstraction (Anthropic/OpenAI routing)
│   └── markdown.js                    # Shared markdown-to-HTML converter (regex-based, no deps)
│
├── scripts/
│   └── ingest.js                      # Standalone ingest script (spawned by cron)
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
├── package.json                       # ESM, Node ≥ 20, vitest + fast-check
├── railway.toml                       # Railway deployment config
└── nixpacks.toml                      # Build config — nodejs_22, npm-10_x
```

---

# 10. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js ≥ 20 (ESM — all files use `import`/`export`) |
| MCP SDK | `@modelcontextprotocol/sdk` — McpServer, StreamableHTTPServerTransport |
| Database | PostgreSQL via `pg` pool — `DATABASE_URL` env var |
| Vector search | pgvector extension — `vector(512)`, IVFFlat cosine index |
| Validation | Zod for all tool input schemas |
| HTTP | Native `node:http` createServer for both MCP transport and writer REST endpoints |
| Scheduling | `node-cron` for all timed jobs |
| AI calls (lightweight) | Anthropic SDK — `claude-haiku-4-5-20251001` for synthesis and classification |
| AI calls (writer) | `lib/writer-client.js` — routes to Anthropic or OpenAI based on `ALTUS_WRITER_MODEL` (default: `claude-sonnet-4-5`) |
| AI cost tracking | All AI calls logged to `ai_usage` table via `lib/ai-cost-tracker.js` |
| Embeddings | Voyage AI `voyage-3-lite` via REST API |
| Analytics | Google Search Console via `googleapis`, Matomo via Reporting API |
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
| `DATABASE_URL` | Shared Railway PostgreSQL connection string |
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

## 11.4 Optional

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Railway sets this automatically |
| `TEST_MODE` | false | Set true to skip live API calls in tests |
| `LOG_LEVEL` | info | Minimum log level (`debug`, `info`, `warn`, `error`) |
| `ALTUS_ADMIN_TOKEN` | — | Bearer token for writer REST endpoints (`/hal/writer/*`) |
| `ALTUS_WRITER_MODEL` | `claude-sonnet-4-5` | AI model for writer pipeline. Prefix-based provider detection: `gpt-*`, `o1*`, `o3*` → OpenAI; all else → Anthropic |
| `OPENAI_API_KEY` | — | Required only when `ALTUS_WRITER_MODEL` is set to an OpenAI model |

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
| `.kiro/specs/altus-ai-writer/` | AI Writer spec — 9 pipeline tools, 2 tables, writer-client abstraction |
| `.kiro/specs/altus-html-export/` | HTML export spec — `get_draft_as_html` tool, shared markdown converter |

---

# 14. Known Gotchas & Operational Notes

- **`reingest_altwire_archive` full mode** causes MCP timeout in Claude.ai (takes 3–5 min). Always verify completion via `get_archive_stats` checking `last_ingest_run` timestamp rather than waiting for tool response.
- **`ngg_shortcode_placeholder`** appearing in `raw_text` fields is a NextGEN Gallery embed artifact — not a data error.
- **Table prefix is mandatory** — all new tables must use `altus_` prefix (shared Railway PostgreSQL namespace). Exception: `ai_usage` and `agent_memory` are shared tables.
- **Stateless transport** — `sessionIdGenerator: undefined` in `StreamableHTTPServerTransport`. Do not revert to stateful mode.
- **Haiku model string** — `claude-haiku-4-5-20251001` (correct as of April 2026). Hardcoded in `lib/synthesizer.js`.
- **Writer model string** — `claude-sonnet-4-5` default in `lib/writer-client.js`. Configurable via `ALTUS_WRITER_MODEL`.
- **`ANTHROPIC_API_KEY` is already present** — do not add as a new env var in specs.
- **Embedding dimension is 512** — the `altus_content.embedding` column is `vector(512)`, not 1024 as in the original draft. This matches the `voyage-3-lite` model output.
- **GSC freshness lag** — GSC data has a ~2 day processing delay. The performance snapshot cron accounts for this by using `effectiveDate = today - 2 days`.
- **Story opportunity caching** — `get_story_opportunities` caches results daily in `agent_memory`. Subsequent calls on the same day return cached data with `cached: true`.
- **Watch list table** — `altus_watch_list` is now live and auto-created at startup. The news monitor cross-references it automatically. Soft-delete via `active=false` preserves historical data.
- **URL normalization** — all article URLs are normalized by stripping trailing slashes via `normalizeUrl()` before storage and comparison.
- **AI Writer pipeline is human-in-the-loop** — `approve_outline` must be called with `decision='approved'` before any draft is generated. `post_to_wordpress` creates WordPress drafts only, never published posts.
- **Writer fact-check loop** — maximum one regeneration cycle. Initial check → regenerate flagged sections → re-check → stop. Status set to `ready_to_post` regardless of second pass result.
- **`openai` package** — listed as a dependency in `package.json` for OpenAI provider support. Only loaded when `ALTUS_WRITER_MODEL` is set to an OpenAI model (lazy import).
- **Writer REST endpoints** — `/hal/writer/assignments` and `/hal/writer/assignments/:id` now read from `altus_assignments` table (not `agent_memory`). Require `ALTUS_ADMIN_TOKEN` bearer auth.

---

*This document should be updated whenever new tools are added, specs are completed, or infrastructure changes. It is the AltWire equivalent of the Cirrusly Weather AI Agent Platform Unified Spec.*
