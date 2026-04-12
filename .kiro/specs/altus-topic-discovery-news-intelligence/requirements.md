# Requirements Document

## Introduction

Add proactive editorial intelligence to the Altus MCP server across three connected capabilities: Topic Discovery (cross-referencing GSC search demand against AltWire archive coverage gaps to surface story opportunities), Google News Monitoring (tracking News search type data and cross-referencing with Derek's watch list for coverage alerts), and Post-Publish Performance Tracking (measuring article GSC performance at 72h, 7d, and 30d snapshots to close the editorial feedback loop). The feature introduces four new MCP tools, two scheduled crons, one new database table, one table extension, and extensions to the existing GSC client — all following established Altus patterns (ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `ALTWIRE_`-prefixed env vars).

## Glossary

- **Altus**: The AltWire MCP server (`altwire-altus`), exposing tools for AltWire content and editorial operations
- **GSC_Client**: The handler module (`handlers/altwire-gsc-client.js`) that communicates with the Google Search Console API using `ALTWIRE_`-prefixed environment variables
- **Topic_Discovery_Handler**: The handler module (`handlers/altus-topic-discovery.js`) that fetches GSC opportunity-zone queries, checks archive coverage, scores opportunities, and uses Haiku to synthesize editorial pitches
- **News_Monitor_Handler**: The handler module (`handlers/altus-news-monitor.js`) that fetches GSC News search type data, cross-references with the watch list, and stores alerts
- **Performance_Tracker_Handler**: The handler module (`handlers/altus-performance-tracker.js`) that collects and queries post-publish GSC performance snapshots
- **Tool_Registry**: The `index.js` file where MCP tools are registered via `server.registerTool()` and wrapped in `safeToolHandler()`
- **Opportunity_Zone**: GSC queries where AltWire ranks at position 5–30 — close enough to page one to be actionable but not yet dominant
- **Watch_List**: The `altus_watch_list` table (existing from V1) containing artist names and topics Derek monitors for coverage opportunities
- **Performance_Snapshot**: A row in `altus_article_performance` capturing GSC metrics (clicks, impressions, CTR, position) for a specific article URL at a specific time interval (72h, 7d, or 30d)
- **News_Search_Type**: The `news` value for the GSC `searchType` parameter, returning queries and pages that appeared in Google News results
- **Agent_Memory**: The shared `agent_memory` PostgreSQL table used for caching and cross-agent data persistence, keyed by `agent` and `key` columns
- **Haiku**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`), used for low-cost AI synthesis calls
- **AI_Cost_Tracker**: The `ai-cost-tracker.js` module that logs all Anthropic API calls to the `ai_usage` table for cost monitoring

## Requirements

### Requirement 1: GSC Client News Search Type Extension

**User Story:** As a developer, I want the GSC client to support the News search type, so that Topic Discovery and News Monitoring handlers can query Google News performance data.

#### Acceptance Criteria

1. THE GSC_Client SHALL export a new async function `getNewsSearchPerformance` that queries the GSC Search Analytics API with `searchType: 'news'`
2. WHEN `getNewsSearchPerformance` is called with `startDate`, `endDate`, and optional `rowLimit` and `dimensions` parameters, THE GSC_Client SHALL return rows containing `keys`, `clicks`, `impressions`, `ctr`, and `position` fields
3. IF the GSC API returns zero rows for the News search type, THEN THE GSC_Client SHALL return `{ startDate, endDate, rows: [], note: 'No Google News data for this period — News coverage may be sparse initially' }`
4. IF any required GSC environment variable is missing, THEN THE `getNewsSearchPerformance` function SHALL return `{ error: 'gsc_not_configured' }` without making API calls
5. IF the GSC API call fails, THEN THE `getNewsSearchPerformance` function SHALL return `{ error: 'gsc_api_error', message: <error_detail> }`

### Requirement 2: GSC Client Opportunity Zone Query Function

**User Story:** As a developer, I want the GSC client to fetch queries in the position 5–30 range, so that Topic Discovery can identify actionable ranking opportunities.

#### Acceptance Criteria

1. THE GSC_Client SHALL export a new async function `getOpportunityZoneQueries` that queries the GSC Search Analytics API filtered to average position between 5 and 30
2. WHEN `getOpportunityZoneQueries` is called with `startDate` and `endDate` parameters, THE GSC_Client SHALL return rows sorted by impressions descending with a default row limit of 100
3. THE `getOpportunityZoneQueries` function SHALL use dimensions `['query', 'page']` to return both the search query and the ranking page URL
4. IF the GSC API returns zero rows in the opportunity zone, THEN THE `getOpportunityZoneQueries` function SHALL return `{ startDate, endDate, rows: [], note: 'No queries found in position 5-30 range' }`
5. IF any required GSC environment variable is missing, THEN THE `getOpportunityZoneQueries` function SHALL return `{ error: 'gsc_not_configured' }` without making API calls

### Requirement 3: GSC Client Page Performance Query Function

**User Story:** As a developer, I want the GSC client to fetch performance data for a specific page URL, so that the Performance Tracker can collect snapshots for individual articles.

#### Acceptance Criteria

1. THE GSC_Client SHALL export a new async function `getPagePerformance` that queries the GSC Search Analytics API filtered to a specific page URL
2. WHEN `getPagePerformance` is called with `pageUrl`, `startDate`, and `endDate` parameters, THE GSC_Client SHALL return aggregate clicks, impressions, CTR, and average position for that page
3. THE `getPagePerformance` function SHALL normalize the `pageUrl` parameter by stripping trailing slashes before comparison to handle URL format inconsistencies
4. IF the GSC API returns zero rows for the specified page, THEN THE `getPagePerformance` function SHALL return `{ pageUrl, clicks: 0, impressions: 0, ctr: 0, position: null, note: 'No GSC data for this URL in the specified period' }`
5. IF any required GSC environment variable is missing, THEN THE `getPagePerformance` function SHALL return `{ error: 'gsc_not_configured' }` without making API calls

### Requirement 4: Article Performance Database Table

**User Story:** As a developer, I want a dedicated table for article performance snapshots, so that post-publish GSC metrics are stored persistently for trend analysis.

#### Acceptance Criteria

1. THE `initSchema` function in `altus-db.js` SHALL create the `altus_article_performance` table with columns: `id` (SERIAL PRIMARY KEY), `article_url` (TEXT NOT NULL), `wp_post_id` (INTEGER), `published_at` (TIMESTAMPTZ), `snapshot_type` (TEXT NOT NULL — one of '72h', '7d', '30d'), `snapshot_taken_at` (TIMESTAMPTZ DEFAULT NOW()), `clicks` (INTEGER DEFAULT 0), `impressions` (INTEGER DEFAULT 0), `ctr` (NUMERIC(5,4) DEFAULT 0), `avg_position` (NUMERIC(6,2)), `top_queries` (JSONB DEFAULT '[]'), `source_query` (TEXT)
2. THE `altus_article_performance` table SHALL have a unique constraint on `(article_url, snapshot_type)` to prevent duplicate snapshots for the same article and interval
3. THE `initSchema` function SHALL use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` patterns consistent with existing Altus schema initialization
4. THE `altus_article_performance` table SHALL have an index on `published_at` for efficient date-range queries

### Requirement 5: Article Assignments Table Extension

**User Story:** As a developer, I want the article assignments table extended with a source query column, so that articles can be traced back to the GSC query that inspired them.

#### Acceptance Criteria

1. THE `initSchema` function in `altus-db.js` SHALL create the `altus_article_assignments` table with `CREATE TABLE IF NOT EXISTS` if the table does not already exist, including columns: `id` (SERIAL PRIMARY KEY), `article_url` (TEXT), `wp_post_id` (INTEGER), `assigned_at` (TIMESTAMPTZ DEFAULT NOW()), `status` (TEXT DEFAULT 'draft'), `source_query` (TEXT)
2. IF the `altus_article_assignments` table already exists, THEN THE `initSchema` function SHALL add the `source_query` column using `ALTER TABLE altus_article_assignments ADD COLUMN IF NOT EXISTS source_query TEXT`

### Requirement 6: Topic Discovery Tool (get_story_opportunities)

**User Story:** As Derek using Hal, I want Hal to proactively surface story opportunities by cross-referencing search demand against coverage gaps, so that I can prioritize articles with proven audience interest.

#### Acceptance Criteria

1. WHEN the `get_story_opportunities` tool is called, THE Topic_Discovery_Handler SHALL fetch opportunity-zone queries (position 5–30) from GSC for the last 28 days
2. THE Topic_Discovery_Handler SHALL check each opportunity-zone query against the AltWire archive using `searchAltwareArchive` to identify coverage gaps (queries with no strong archive match at weighted_score >= 0.50)
3. THE Topic_Discovery_Handler SHALL score each opportunity using a composite of GSC impressions, position proximity to page one, and coverage gap severity
4. THE Topic_Discovery_Handler SHALL call Haiku to synthesize the top-scored opportunities into 3–5 editorial pitches with suggested angles
5. THE Topic_Discovery_Handler SHALL log the Haiku API call via AI_Cost_Tracker
6. WHEN results are generated, THE Topic_Discovery_Handler SHALL cache the result in Agent_Memory with key `altus:story_opportunities:{YYYY-MM-DD}` for same-day reuse
7. WHEN the `get_story_opportunities` tool is called and a cached result exists for the current date, THE Topic_Discovery_Handler SHALL return the cached result without making GSC or Haiku API calls
8. IF GSC returns zero opportunity-zone queries, THEN THE Topic_Discovery_Handler SHALL return `{ opportunities: [], note: 'No queries found in the opportunity zone (position 5-30) for the last 28 days' }`
9. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `get_story_opportunities` tool SHALL return representative mock data without making API calls
10. IF the `DATABASE_URL` environment variable is not set, THEN THE `get_story_opportunities` tool SHALL return `{ error: 'Database not configured' }`
11. THE Tool_Registry SHALL register `get_story_opportunities` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 7: News Opportunities Tool (get_news_opportunities)

**User Story:** As Derek using Hal, I want to see which AltWire content is getting Google News pickup and which watch list topics have News search demand, so that I can capitalize on News visibility.

#### Acceptance Criteria

1. WHEN the `get_news_opportunities` tool is called, THE News_Monitor_Handler SHALL fetch Google News search type data from GSC for the last 7 days
2. THE News_Monitor_Handler SHALL cross-reference News queries against the Watch_List using case-insensitive substring matching to identify watch list topics with News activity
3. THE News_Monitor_Handler SHALL identify which AltWire pages appeared in Google News results by querying GSC News data with `page` dimension
4. IF GSC returns zero News search type rows, THEN THE News_Monitor_Handler SHALL return `{ news_queries: [], watch_list_matches: [], news_pages: [], note: 'No Google News data available — News coverage may be sparse initially' }`
5. IF the Watch_List table is empty or does not exist, THEN THE News_Monitor_Handler SHALL skip watch list cross-referencing and return `watch_list_matches: []` with a note
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `get_news_opportunities` tool SHALL return representative mock data without making API calls
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `get_news_opportunities` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `get_news_opportunities` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 8: Article Performance Tool (get_article_performance)

**User Story:** As Derek using Hal, I want to check how published articles are performing in Google Search, so that I can understand which content resonates and refine editorial strategy.

#### Acceptance Criteria

1. WHEN the `get_article_performance` tool is called with an `article_url` parameter, THE Performance_Tracker_Handler SHALL return all performance snapshots for that article from the `altus_article_performance` table
2. WHEN the `get_article_performance` tool is called without an `article_url` parameter, THE Performance_Tracker_Handler SHALL return aggregate performance data for the most recent 20 articles with snapshots
3. THE `get_article_performance` tool SHALL accept an optional `snapshot_type` parameter to filter results to a specific interval ('72h', '7d', or '30d')
4. THE Performance_Tracker_Handler SHALL normalize the `article_url` parameter by stripping trailing slashes before querying
5. IF no performance snapshots exist for the specified article, THEN THE Performance_Tracker_Handler SHALL return `{ article_url, snapshots: [], note: 'No performance data yet — snapshots are collected at 72h, 7d, and 30d after publish' }`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `get_article_performance` tool SHALL return representative mock data without making database queries
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `get_article_performance` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `get_article_performance` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 9: News Performance Patterns Tool (get_news_performance_patterns)

**User Story:** As Derek using Hal, I want to analyze what types of content get Google News pickup, so that I can optimize future articles for News visibility.

#### Acceptance Criteria

1. WHEN the `get_news_performance_patterns` tool is called, THE Performance_Tracker_Handler SHALL query GSC News search type data for the last 30 days with `page` dimension to identify which AltWire URLs appeared in News results
2. THE Performance_Tracker_Handler SHALL cross-reference News-appearing URLs against the `altus_content` table to enrich results with article titles, categories, tags, and publish dates
3. THE Performance_Tracker_Handler SHALL group results by content category and tag to identify patterns in what content types get News pickup
4. IF GSC returns zero News search type rows, THEN THE Performance_Tracker_Handler SHALL return `{ patterns: [], note: 'No Google News data available for the last 30 days — News coverage may be sparse initially' }`
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `get_news_performance_patterns` tool SHALL return representative mock data without making API calls
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `get_news_performance_patterns` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `get_news_performance_patterns` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 10: Daily News Monitor Cron (9 AM ET)

**User Story:** As Derek, I want Hal to automatically check Google News data every morning, so that I receive timely alerts about News coverage opportunities without manually requesting them.

#### Acceptance Criteria

1. THE Altus server SHALL schedule a cron job that runs daily at 9:00 AM Eastern Time using `node-cron` with timezone `'America/New_York'`
2. WHEN the News Monitor cron fires, THE cron handler SHALL fetch GSC News search type data for the previous 7 days
3. THE cron handler SHALL cross-reference News queries against the Watch_List using case-insensitive substring matching
4. WHEN watch list matches or notable News activity are found, THE cron handler SHALL store an alert in Agent_Memory with key `altus:news_alert:{YYYY-MM-DD}` containing the matched queries, News-appearing pages, and watch list hits
5. IF GSC returns zero News rows, THEN THE cron handler SHALL store a minimal alert noting no News activity detected
6. IF the `DATABASE_URL` environment variable is not set, THEN THE cron handler SHALL skip execution and log a warning
7. THE cron handler SHALL log execution start, completion, and any errors via the logger

### Requirement 11: Daily Performance Snapshot Cron (6 AM ET)

**User Story:** As a developer, I want automated performance snapshot collection, so that article GSC metrics are captured at consistent intervals without manual intervention.

#### Acceptance Criteria

1. THE Altus server SHALL schedule a cron job that runs daily at 6:00 AM Eastern Time using `node-cron` with timezone `'America/New_York'`
2. WHEN the Performance Snapshot cron fires, THE cron handler SHALL query the `altus_article_performance` table and `altus_article_assignments` table to identify articles that need a snapshot (published 72h ago without a '72h' snapshot, 7 days ago without a '7d' snapshot, or 30 days ago without a '30d' snapshot)
3. FOR EACH article needing a snapshot, THE cron handler SHALL call `GSC_Client.getPagePerformance` to fetch current metrics and insert a row into `altus_article_performance`
4. THE cron handler SHALL account for the 2–3 day GSC data freshness lag by using date ranges that end 2 days before the current date
5. IF `getPagePerformance` returns zero data for an article (partial data scenario), THEN THE cron handler SHALL still insert a snapshot row with zero values and a note indicating partial data
6. IF the `DATABASE_URL` environment variable is not set, THEN THE cron handler SHALL skip execution and log a warning
7. THE cron handler SHALL log execution start, number of snapshots collected, and any errors via the logger

### Requirement 12: Post-Publish Performance Tracking Row Insertion

**User Story:** As a developer, I want a performance tracking row created when an article is published to WordPress, so that the Performance Snapshot cron knows which articles to monitor.

#### Acceptance Criteria

1. THE Performance_Tracker_Handler SHALL export an async function `registerArticleForTracking` that inserts a row into `altus_article_assignments` with the article URL, WordPress post ID, publish timestamp, and optional source query
2. WHEN `registerArticleForTracking` is called, THE function SHALL use `ON CONFLICT` handling to avoid duplicate entries for the same article URL
3. IF the `DATABASE_URL` environment variable is not set, THEN THE `registerArticleForTracking` function SHALL return `{ error: 'Database not configured' }`
4. THE `registerArticleForTracking` function SHALL normalize the article URL by stripping trailing slashes before insertion

### Requirement 13: Agent Memory Caching Pattern

**User Story:** As a developer, I want a consistent caching pattern for editorial intelligence results, so that expensive GSC + Haiku calls are not repeated within the same day.

#### Acceptance Criteria

1. THE Topic_Discovery_Handler SHALL read from and write to the shared `agent_memory` table using agent value `'altus'` and date-stamped keys
2. WHEN writing a cache entry, THE handler SHALL use `INSERT ... ON CONFLICT (agent, key) DO UPDATE` to upsert the cached value
3. WHEN reading a cache entry, THE handler SHALL check for a key matching the current UTC date and return the cached value if found
4. THE cached value SHALL be stored as a JSON string in the `agent_memory.value` column
5. THE News Monitor cron SHALL write alerts to Agent_Memory using agent value `'altus'` and key pattern `altus:news_alert:{YYYY-MM-DD}`

### Requirement 14: AI Cost Tracking for Haiku Calls

**User Story:** As a developer, I want all Haiku synthesis calls logged for cost tracking, so that editorial intelligence AI costs are visible and auditable.

#### Acceptance Criteria

1. THE Topic_Discovery_Handler SHALL log each Haiku API call to the `ai_usage` table via AI_Cost_Tracker, recording the model name, input tokens, output tokens, and purpose
2. IF the `ai-cost-tracker.js` module does not yet exist in altwire-altus, THEN THE implementation SHALL create it following the same pattern as `cirrusly-mcp-server/ai-cost-tracker.js`
3. THE AI_Cost_Tracker SHALL gracefully handle missing `DATABASE_URL` by skipping the log write without throwing

### Requirement 15: URL Normalization Consistency

**User Story:** As a developer, I want consistent URL normalization across all handlers, so that trailing slash differences between GSC data and WordPress URLs do not cause matching failures.

#### Acceptance Criteria

1. THE GSC_Client, Performance_Tracker_Handler, and Topic_Discovery_Handler SHALL normalize URLs by stripping trailing slashes before any comparison or storage operation
2. THE URL normalization SHALL handle both `https://altwire.net/slug/` and `https://altwire.net/slug` formats, treating them as equivalent
3. THE `ALTWIRE_GSC_SITE_URL` environment variable SHALL be accepted in both `sc-domain:altwire.net` and `https://altwire.net/` formats without requiring normalization by the operator

### Requirement 16: Thin Data Graceful Handling

**User Story:** As Derek using Hal, I want all editorial intelligence tools to handle sparse GSC data gracefully, so that tools remain useful even when Google News data is limited or GSC freshness lag affects results.

#### Acceptance Criteria

1. WHEN any editorial intelligence tool encounters zero GSC rows, THE tool SHALL return a structured response with an empty results array and a human-readable note explaining the data gap
2. THE Performance Snapshot cron SHALL treat partial GSC data (due to the 2–3 day freshness lag) as valid and insert snapshot rows with available data rather than skipping the article
3. THE News Monitor cron SHALL store an alert even when zero News rows are found, noting the absence of News activity for that day
4. THE Topic_Discovery_Handler SHALL return a meaningful response even when fewer than 3 opportunities are found, adjusting the Haiku pitch count to match available data

### Requirement 17: Source Isolation and V1 Tool Preservation

**User Story:** As a developer, I want the new editorial intelligence features to be additive without modifying existing V1 tools, so that the stable foundation is preserved.

#### Acceptance Criteria

1. THE implementation SHALL NOT modify the handler logic of existing V1 tools: `search_altwire_archive`, `reingest_altwire_archive`, `get_archive_stats`, `get_content_by_url`, `analyze_coverage_gaps`
2. THE implementation SHALL NOT modify the handler logic of existing analytics tools: `get_altwire_site_analytics`, `get_altwire_traffic_sources`, `get_altwire_top_pages`, `get_altwire_site_search`, `get_altwire_search_performance`, `get_altwire_search_opportunities`, `get_altwire_sitemap_health`
3. THE implementation SHALL add new exports to `altwire-gsc-client.js` without modifying the signatures or behavior of existing exported functions (`getSearchPerformance`, `getSearchOpportunities`, `getSitemapHealth`, `normalizeDimensions`)
4. THE implementation SHALL add new DDL statements to `initSchema` in `altus-db.js` without modifying existing table definitions

### Requirement 18: Environment Variable Convention

**User Story:** As a developer deploying Altus, I want all new environment variables to follow the established `ALTWIRE_` prefix convention, so that configuration is consistent and discoverable.

#### Acceptance Criteria

1. THE implementation SHALL NOT introduce any new environment variables with an `AW_` prefix — all AltWire-specific configuration SHALL use the `ALTWIRE_` prefix
2. THE `.env.example` file SHALL be updated to document any new environment variables required by the editorial intelligence features
3. THE implementation SHALL reuse existing environment variables (`ALTWIRE_GSC_SERVICE_ACCOUNT_JSON`, `ALTWIRE_GSC_SITE_URL`, `ANTHROPIC_API_KEY`, `DATABASE_URL`) rather than introducing duplicates
