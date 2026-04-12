# Implementation Plan: Altus Topic Discovery & News Intelligence

## Overview

Incrementally build three connected editorial intelligence capabilities — Topic Discovery, Google News Monitoring, and Post-Publish Performance Tracking — as additive extensions to the existing Altus MCP server. Each task builds on the previous, starting with shared infrastructure (URL normalization, DB schema, AI cost tracker), then GSC client extensions, then handler modules, then tool/cron registrations, and finally wiring everything together.

## Tasks

- [x] 1. Add URL normalization utility and database schema extensions
  - [x] 1.1 Add `normalizeUrl` export to `handlers/altwire-gsc-client.js`
    - Export `normalizeUrl(url)` that strips trailing slashes from URL strings
    - Non-string inputs returned as-is
    - _Requirements: 15.1, 15.2, 15.3_
  - [x] 1.2 Write property test for URL normalization (Property 1)
    - **Property 1: URL normalization idempotence and equivalence**
    - Test that `normalizeUrl(url)` never ends with `/`, that `normalizeUrl(url + '/')` equals `normalizeUrl(url)`, and that applying it twice equals applying it once
    - Create `tests/url-normalize.property.test.js`
    - **Validates: Requirements 3.3, 8.4, 12.4, 15.1, 15.2**
  - [x] 1.3 Extend `initSchema` in `lib/altus-db.js` with new tables
    - Add `CREATE TABLE IF NOT EXISTS altus_article_performance` with all columns per design (id, article_url, wp_post_id, published_at, snapshot_type, snapshot_taken_at, clicks, impressions, ctr, avg_position, top_queries, source_query) and `UNIQUE(article_url, snapshot_type)` constraint
    - Add `CREATE INDEX IF NOT EXISTS altus_article_perf_published_idx ON altus_article_performance (published_at)`
    - Add `CREATE TABLE IF NOT EXISTS altus_article_assignments` with columns per design (id, article_url, wp_post_id, assigned_at, status, source_query)
    - Add `ALTER TABLE altus_article_assignments ADD COLUMN IF NOT EXISTS source_query TEXT` for safe column addition
    - Do NOT modify existing `altus_content` or `altus_ingest_log` DDL
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 17.4_

- [x] 2. Create AI cost tracker module
  - [x] 2.1 Create `lib/ai-cost-tracker.js`
    - Follow the exact pattern from `cirrusly-mcp-server/ai-cost-tracker.js`
    - Import `pool` from `./altus-db.js` and `logger` from `../logger.js`
    - Export `initAiUsageSchema()` — creates `ai_usage` table with `CREATE TABLE IF NOT EXISTS`
    - Export `logAiUsage(toolName, model, usage)` — inserts row with tool_name, model, input_tokens, output_tokens, estimated_cost_usd
    - Export `getAiCostSummary()` — returns recent usage summary
    - `logAiUsage` must be non-throwing — errors logged but never propagated
    - Missing `DATABASE_URL` → silently skip (no log write, no error)
    - Include pricing table for Claude Haiku 4.5
    - _Requirements: 14.1, 14.2, 14.3_
  - [x] 2.2 Write unit tests for AI cost tracker
    - Create `tests/ai-cost-tracker.unit.test.js`
    - Test graceful handling when DATABASE_URL is missing
    - Test that logAiUsage never throws
    - _Requirements: 14.3_

- [x] 3. Checkpoint — Ensure schema and shared infrastructure tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add GSC client extensions
  - [x] 4.1 Add `getNewsSearchPerformance` to `handlers/altwire-gsc-client.js`
    - New async export that queries GSC Search Analytics API with `searchType: 'news'`
    - Accepts `startDate`, `endDate`, and optional `{ rowLimit, dimensions }` — dimensions default to `['query']`
    - Reuses existing `getConfig()` helper
    - Returns `{ startDate, endDate, rows: [...] }` on success
    - Returns `{ startDate, endDate, rows: [], note: '...' }` on zero rows
    - Returns `{ error: 'gsc_not_configured' }` when env vars missing
    - Returns `{ error: 'gsc_api_error', message }` on API failure
    - Do NOT modify existing `getSearchPerformance`, `getSearchOpportunities`, `getSitemapHealth`, or `normalizeDimensions`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 17.3_
  - [x] 4.2 Add `getOpportunityZoneQueries` to `handlers/altwire-gsc-client.js`
    - New async export that queries GSC with `dimensionFilterGroups` for position >= 5 AND <= 30
    - Uses dimensions `['query', 'page']`, ordered by impressions descending, row limit 100
    - Same error-return pattern as above
    - Returns `{ startDate, endDate, rows: [], note: '...' }` on zero rows
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 17.3_
  - [x] 4.3 Add `getPagePerformance` to `handlers/altwire-gsc-client.js`
    - New async export that queries GSC filtered to a specific page URL
    - Normalizes `pageUrl` via `normalizeUrl()` before comparison
    - Returns aggregate clicks, impressions, CTR, average position
    - Returns `{ pageUrl, clicks: 0, impressions: 0, ctr: 0, position: null, note: '...' }` on zero rows
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 17.3_
  - [x] 4.4 Write property tests for GSC response mapping and position filtering (Properties 9, 12)
    - **Property 9: GSC response field mapping completeness** — verify all five fields preserved through mapping
    - **Property 12: Opportunity zone position filtering** — verify only rows with 5 <= position <= 30 returned, sorted by impressions descending
    - Create `tests/gsc-response-mapping.property.test.js`
    - **Validates: Requirements 1.2, 2.1, 2.2, 3.2**

- [x] 5. Add synthesizer extension for editorial pitches
  - [x] 5.1 Add `synthesizePitches` export to `lib/synthesizer.js`
    - New async function that takes an array of scored opportunity objects and generates 3–5 editorial pitches via Haiku
    - Returns `{ pitches: string, model: string, usage: object }` so caller can pass to `logAiUsage()`
    - Never throws — returns fallback text on any error
    - Adjusts pitch count to match available data (fewer than 3 opportunities → fewer pitches)
    - _Requirements: 6.4, 16.4_

- [x] 6. Implement Topic Discovery handler
  - [x] 6.1 Create `handlers/altus-topic-discovery.js`
    - Export `getStoryOpportunities({ days = 28 })` async function
    - Check `agent_memory` for same-day cache key `altus:story_opportunities:{YYYY-MM-DD}` — return cached result if found
    - Call `getOpportunityZoneQueries()` for computed date range
    - For each query, call `searchAltwareArchive()` to check coverage (gap if top `weighted_score < 0.50`)
    - Score opportunities: `impressions * (1 - (position - 5) / 25) * gapMultiplier`
    - Gap multiplier: 1.5 (no coverage, score < 0.25), 1.2 (weak, 0.25–0.49), 1.0 (covered, >= 0.50)
    - Sort by score descending, take top 10
    - Call `synthesizePitches()` with top opportunities
    - Log Haiku call via `logAiUsage()`
    - Cache result in `agent_memory` with upsert
    - Handle `TEST_MODE` → return mock data, `!DATABASE_URL` → return error
    - Return `{ opportunities: [], note: '...' }` when GSC returns zero rows
    - If Haiku fails, return opportunities without AI pitches (log warning)
    - _Requirements: 6.1–6.11, 13.1–13.4, 14.1, 16.1, 16.4_
  - [x] 6.2 Write property tests for scoring and classification (Properties 2, 3)
    - **Property 2: Opportunity scoring formula correctness** — verify score = impressions × positionProximity × gapMultiplier, non-negative, monotonic in impressions
    - **Property 3: Coverage gap classification threshold** — verify correct classification and multiplier for all weighted_score ranges
    - Create `tests/topic-discovery.property.test.js`
    - **Validates: Requirements 6.2, 6.3**
  - [x] 6.3 Write unit tests for Topic Discovery handler
    - Create `tests/topic-discovery.unit.test.js`
    - Test TEST_MODE returns mock data
    - Test missing DATABASE_URL returns error
    - Test cache hit returns cached result without API calls
    - Test zero GSC rows returns empty opportunities with note
    - Test Haiku failure still returns opportunities
    - _Requirements: 6.7, 6.8, 6.9, 6.10_

- [x] 7. Implement News Monitor handler
  - [x] 7.1 Create `handlers/altus-news-monitor.js`
    - Export `getNewsOpportunities()` — fetches GSC News data for last 7 days with `['query']` and `['page']` dimensions, cross-references with `altus_watch_list` using case-insensitive substring matching
    - Export `runNewsMonitorCron()` — called by daily cron, stores alert in `agent_memory` with key `altus:news_alert:{YYYY-MM-DD}`
    - Handle `TEST_MODE` → return mock data, `!DATABASE_URL` → return error
    - Gracefully handle missing/empty `altus_watch_list` table — return `watch_list_matches: []` with note
    - Return structured response with `{ news_queries, watch_list_matches, news_pages }` or empty arrays with note on zero rows
    - Cron handler: skip if no DATABASE_URL (log warning), wrap in try/catch, never throw, store alert even on zero News rows
    - _Requirements: 7.1–7.8, 10.1–10.7, 13.5, 16.1, 16.3_
  - [x] 7.2 Write property test for watch list matching (Property 4)
    - **Property 4: Case-insensitive substring watch list matching** — verify match iff lowercased query contains lowercased watch item as substring, case-invariant
    - Create `tests/watch-list-matching.property.test.js`
    - **Validates: Requirements 7.2, 10.3**
  - [x] 7.3 Write unit tests for News Monitor handler
    - Create `tests/news-monitor.unit.test.js`
    - Test TEST_MODE returns mock data
    - Test missing DATABASE_URL returns error
    - Test zero GSC News rows returns empty arrays with note
    - Test missing watch list table handled gracefully
    - Test cron stores alert in agent_memory
    - _Requirements: 7.4, 7.5, 7.6, 7.7, 10.4, 10.5_

- [x] 8. Checkpoint — Ensure all handler tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement Performance Tracker handler
  - [x] 9.1 Create `handlers/altus-performance-tracker.js`
    - Export `getArticlePerformance({ article_url, snapshot_type })` — queries `altus_article_performance` table, normalizes URL, filters by snapshot_type if provided, returns aggregate for most recent 20 articles when no article_url given
    - Export `getNewsPerformancePatterns()` — queries GSC News data for last 30 days with `page` dimension, cross-references with `altus_content` for enrichment, groups by category and tag
    - Export `registerArticleForTracking({ articleUrl, wpPostId, publishedAt, sourceQuery })` — inserts into `altus_article_assignments` with ON CONFLICT handling, normalizes URL
    - Export `runPerformanceSnapshotCron()` — identifies articles needing snapshots (72h, 7d, 30d) accounting for 2-day GSC freshness lag, calls `getPagePerformance()` for each, upserts into `altus_article_performance`, inserts zero-value rows for partial data
    - Handle `TEST_MODE` → return mock data, `!DATABASE_URL` → return error for tool functions
    - Cron handler: skip if no DATABASE_URL (log warning), wrap in try/catch, never throw
    - _Requirements: 8.1–8.8, 9.1–9.7, 11.1–11.7, 12.1–12.4, 16.1, 16.2_
  - [x] 9.2 Write property test for snapshot eligibility (Property 6)
    - **Property 6: Snapshot eligibility date arithmetic** — verify correct identification of missing snapshot types based on published_at, effectiveDate, and existing snapshots
    - Create `tests/snapshot-eligibility.property.test.js`
    - **Validates: Requirements 11.2, 11.4**
  - [x] 9.3 Write unit tests for Performance Tracker handler
    - Create `tests/performance-tracker.unit.test.js`
    - Test TEST_MODE returns mock data for all three tool functions
    - Test missing DATABASE_URL returns error
    - Test getArticlePerformance with specific article_url returns matching snapshots
    - Test getArticlePerformance without article_url returns aggregate
    - Test registerArticleForTracking idempotence (ON CONFLICT)
    - Test zero snapshots returns empty array with note
    - Test cron inserts zero-value rows for partial GSC data
    - _Requirements: 8.5, 8.6, 8.7, 9.4, 9.5, 11.5, 12.2, 12.3_

- [x] 10. Register MCP tools and crons in index.js
  - [x] 10.1 Register 4 new MCP tools in `index.js`
    - Import `getStoryOpportunities` from `./handlers/altus-topic-discovery.js`
    - Import `getNewsOpportunities` from `./handlers/altus-news-monitor.js`
    - Import `getArticlePerformance`, `getNewsPerformancePatterns` from `./handlers/altus-performance-tracker.js`
    - Register `get_story_opportunities` with Zod schema `{ days?: z.number().int().min(7).max(90).default(28) }`, wrapped in `safeToolHandler()`
    - Register `get_news_opportunities` with Zod schema `{ days?: z.number().int().min(1).max(30).default(7) }`, wrapped in `safeToolHandler()`
    - Register `get_article_performance` with Zod schema `{ article_url?: z.string(), snapshot_type?: z.enum(['72h','7d','30d']) }`, wrapped in `safeToolHandler()`
    - Register `get_news_performance_patterns` with Zod schema `{ days?: z.number().int().min(7).max(90).default(30) }`, wrapped in `safeToolHandler()`
    - All use `server.registerTool()` pattern consistent with existing tools
    - _Requirements: 6.11, 7.8, 8.8, 9.7_
  - [x] 10.2 Register 2 new crons in `index.js`
    - Import `runNewsMonitorCron` from `./handlers/altus-news-monitor.js`
    - Import `runPerformanceSnapshotCron` from `./handlers/altus-performance-tracker.js`
    - Add News Monitor cron: `cron.schedule('0 9 * * *', () => runNewsMonitorCron(), { timezone: 'America/New_York' })` inside the `if (process.env.DATABASE_URL)` block
    - Add Performance Snapshot cron: `cron.schedule('0 6 * * *', () => runPerformanceSnapshotCron(), { timezone: 'America/New_York' })` inside the same block
    - Import `node-cron` at top of file (add if not already imported)
    - Call `initAiUsageSchema()` from the startup block alongside `initSchema()`
    - _Requirements: 10.1, 10.7, 11.1, 11.6_
  - [x] 10.3 Update `.env.example` with documentation comments
    - Add comments noting that no new env vars are required — the feature reuses existing `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON`, `ALTWIRE_GSC_SITE_URL`, `ANTHROPIC_API_KEY`, and `DATABASE_URL`
    - _Requirements: 18.1, 18.2, 18.3_

- [x] 11. Write remaining property and integration tests
  - [x] 11.1 Write property test for agent memory cache round-trip (Property 5)
    - **Property 5: Agent memory cache round-trip** — verify write then read returns original object, upsert overwrites, different date key returns no result
    - Create `tests/agent-memory-cache.property.test.js` using mock pool
    - **Validates: Requirements 6.6, 6.7, 13.1, 13.2, 13.3, 13.4, 10.4**
  - [x] 11.2 Write property test for zero-result response structure (Property 11)
    - **Property 11: Zero-result response structure** — verify all four tools return empty results array and non-empty note string when given zero GSC rows
    - Add to `tests/topic-discovery.property.test.js` or create dedicated file
    - **Validates: Requirements 16.1**
  - [x] 11.3 Write property test for article performance unique constraint (Property 13)
    - **Property 13: Article performance unique constraint enforcement** — verify same (article_url, snapshot_type) pair rejects/upserts, different snapshot_types coexist
    - Add to `tests/performance-tracker.unit.test.js` or create dedicated file
    - **Validates: Requirements 4.2**

- [x] 12. Final checkpoint — Ensure all tests pass and V1 tools are unmodified
  - Ensure all tests pass, ask the user if questions arise.
  - Verify no existing V1 tool handler logic was modified (Requirements 17.1, 17.2, 17.3, 17.4)

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The design uses JavaScript throughout — all code examples use ESM imports/exports
- Property tests use `fast-check` (already in devDependencies) with minimum 100 iterations
- All new handlers follow the established `TEST_MODE` / `DATABASE_URL` guard pattern
- Existing V1 tools and analytics tools are never modified — all changes are additive
- Crons are registered inside the existing `if (process.env.DATABASE_URL)` block in `index.js`
