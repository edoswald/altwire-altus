# Requirements Document

## Introduction

This feature adds three new MCP tools to the altwire-altus service for site health monitoring and a daily operational briefing. The `get_altwire_uptime` tool reports live status of AltWire's two Better Stack monitors (site and wp_cron). The `get_altwire_incidents` tool surfaces open incidents on those monitors. The `get_altwire_morning_digest` tool aggregates data from seven sources — uptime, incidents, news alerts, story opportunities, review deadlines, overdue loaners, and yesterday's traffic — into a single daily briefing for the editorial team.

## Glossary

- **Monitoring_Handler**: The `handlers/altus-monitoring.js` module responsible for fetching uptime status and open incidents from the Better Stack API.
- **Digest_Handler**: The `handlers/altus-digest.js` module responsible for aggregating data from all available sources into a morning digest.
- **Better_Stack_API**: The Better Stack Uptime API at `https://uptime.betterstack.com/api/v2`, authenticated via Bearer token.
- **Monitor_ID**: A hardcoded Better Stack monitor identifier. Site monitor: `1881007`, wp_cron monitor: `2836297`.
- **Agent_Memory**: The shared `agent_memory` PostgreSQL table with columns `agent`, `key`, `value`, `created_at`, `updated_at`, keyed by composite `(agent, key)`.
- **Pool**: The shared PostgreSQL connection pool exported as default from `lib/altus-db.js`.
- **MCP_Server**: The Model Context Protocol server instance created by `createMcpServer()` in `index.js`.
- **Safe_Tool_Handler**: The `safeToolHandler` wrapper from `lib/safe-tool-handler.js` that catches unexpected exceptions and returns structured error responses.
- **TEST_MODE**: An environment variable (`process.env.TEST_MODE`) that, when set to `'true'`, causes handlers to return canned responses instead of making live API calls.
- **Matomo_Client**: The `handlers/altwire-matomo-client.js` module; its `getTrafficSummary` export provides site traffic data.
- **BETTER_STACK_TOKEN**: An environment variable holding the read-only Better Stack API token.
- **Digest_Section**: One of the seven data sections within the morning digest response, each fetched independently and tolerant of individual failure.

## Requirements

### Requirement 1: Uptime Status Retrieval

**User Story:** As an editor, I want to check the live uptime status of AltWire's site and wp_cron monitors, so that I can quickly assess whether the site is healthy.

#### Acceptance Criteria

1. WHEN the `get_altwire_uptime` tool is invoked, THE Monitoring_Handler SHALL fetch the current status of Monitor_ID `1881007` (site) and Monitor_ID `2836297` (wp_cron) from the Better_Stack_API using `GET /monitors/{id}`.
2. THE Monitoring_Handler SHALL authenticate all Better_Stack_API requests using the `Authorization: Bearer ${BETTER_STACK_TOKEN}` header.
3. WHEN both monitors respond successfully, THE Monitoring_Handler SHALL return a JSON object containing the status, last_checked_at, and url for each monitor keyed by a human-readable label (`site` and `wp_cron`).
4. IF the BETTER_STACK_TOKEN environment variable is missing, THEN THE Monitoring_Handler SHALL return a JSON object with an `error` field describing the missing token instead of throwing an exception.
5. IF a Better_Stack_API request fails, THEN THE Monitoring_Handler SHALL return a JSON object with an `error` field containing the failure reason instead of throwing an exception.
6. WHILE TEST_MODE is set to `'true'`, THE Monitoring_Handler SHALL return a canned response with `test_mode: true` and skip all live Better_Stack_API calls.

### Requirement 2: Open Incidents Retrieval

**User Story:** As an editor, I want to see any open incidents on AltWire's monitors, so that I can understand active problems affecting the site.

#### Acceptance Criteria

1. WHEN the `get_altwire_incidents` tool is invoked, THE Monitoring_Handler SHALL fetch open incidents for Monitor_ID `1881007` and Monitor_ID `2836297` from the Better_Stack_API using `GET /incidents?monitor_id={id}&resolved=false&per_page=5`.
2. WHEN incidents are returned, THE Monitoring_Handler SHALL return a JSON object containing an array of incidents for each monitor keyed by label (`site` and `wp_cron`), with each incident including at minimum the incident name, started_at, and cause.
3. WHEN no open incidents exist for a monitor, THE Monitoring_Handler SHALL return an empty array for that monitor's key.
4. IF the BETTER_STACK_TOKEN environment variable is missing, THEN THE Monitoring_Handler SHALL return a JSON object with an `error` field describing the missing token instead of throwing an exception.
5. IF a Better_Stack_API request fails, THEN THE Monitoring_Handler SHALL return a JSON object with an `error` field containing the failure reason instead of throwing an exception.
6. WHILE TEST_MODE is set to `'true'`, THE Monitoring_Handler SHALL return a canned response with `test_mode: true` and skip all live Better_Stack_API calls.

### Requirement 3: Morning Digest Aggregation

**User Story:** As an editor, I want a single daily briefing that pulls together uptime, incidents, news alerts, story opportunities, review deadlines, overdue loaners, and yesterday's traffic, so that I can start the day with a complete operational picture.

#### Acceptance Criteria

1. WHEN the `get_altwire_morning_digest` tool is invoked, THE Digest_Handler SHALL fetch all seven Digest_Sections in parallel using `Promise.allSettled`.
2. THE Digest_Handler SHALL include the following Digest_Sections: uptime status (from `getAltwireUptime`), open incidents (from `getAltwireIncidents`), news alerts (from Agent_Memory key `altus:news_alert:{today}`), story opportunities (from Agent_Memory key `altus:story_opportunities:{today}`), upcoming review deadlines (from `altus_reviews` table, due within 7 days, excluding `published` and `cancelled` statuses), overdue loaners (from `altus_loaners` table, `expected_return_date < today` and `actual_return_date IS NULL`, excluding `returned` and `kept` statuses), and yesterday's traffic (from `getTrafficSummary`).
3. IF any single Digest_Section fetch fails, THEN THE Digest_Handler SHALL set that section's value to `null` and include a `warning` field describing the failure, while all other sections continue to return their data.
4. THE Digest_Handler SHALL include a `generated_at` ISO timestamp and a `date` field (formatted as `YYYY-MM-DD` in the `America/New_York` timezone) in the response.
5. THE Digest_Handler SHALL derive the `today` date string using `toLocaleDateString('en-CA', { timeZone: 'America/New_York' })` as the fallback when `date-fns-tz` is not available in `package.json`.
6. WHILE TEST_MODE is set to `'true'`, THE Digest_Handler SHALL return a canned digest response with `test_mode: true` and skip all live API and database calls.

### Requirement 4: Agent Memory Reads for Digest

**User Story:** As an editor, I want the morning digest to include today's news alerts and story opportunities from the agent memory cache, so that the briefing reflects the latest editorial intelligence.

#### Acceptance Criteria

1. WHEN fetching news alerts for the digest, THE Digest_Handler SHALL query Agent_Memory using `pool.query` with `agent = 'altus'` and `key = 'altus:news_alert:{today}'` where `{today}` is the `YYYY-MM-DD` date string.
2. WHEN fetching story opportunities for the digest, THE Digest_Handler SHALL query Agent_Memory using `pool.query` with `agent = 'altus'` and `key = 'altus:story_opportunities:{today}'` where `{today}` is the `YYYY-MM-DD` date string.
3. WHEN an Agent_Memory key has no matching row, THE Digest_Handler SHALL return `null` for that Digest_Section with a note indicating no data is available for today.
4. THE Digest_Handler SHALL parse the `value` column from Agent_Memory as JSON before including the data in the digest response.

### Requirement 5: Review and Loaner Digest Sections

**User Story:** As an editor, I want the morning digest to surface upcoming review deadlines and overdue loaners, so that I can track editorial commitments without checking separate tools.

#### Acceptance Criteria

1. WHEN fetching upcoming review deadlines for the digest, THE Digest_Handler SHALL query the `altus_reviews` table for rows where `due_date` is within 7 days of today, `due_date IS NOT NULL`, and `status NOT IN ('published', 'cancelled')`, ordered by `due_date ASC`.
2. WHEN fetching overdue loaners for the digest, THE Digest_Handler SHALL query the `altus_loaners` table for rows where `expected_return_date < today`, `actual_return_date IS NULL`, and `status NOT IN ('returned', 'kept', 'lost')`, ordered by `expected_return_date ASC`.
3. WHEN no upcoming review deadlines exist, THE Digest_Handler SHALL return an empty array with a count of `0` for the review deadlines section.
4. WHEN no overdue loaners exist, THE Digest_Handler SHALL return an empty array with a count of `0` for the overdue loaners section.

### Requirement 6: Traffic Digest Section

**User Story:** As an editor, I want yesterday's site traffic included in the morning digest, so that I can spot traffic anomalies early.

#### Acceptance Criteria

1. WHEN fetching yesterday's traffic for the digest, THE Digest_Handler SHALL call `getTrafficSummary('day', 'yesterday')` from the Matomo_Client module.
2. IF the Matomo_Client returns an error object (containing an `error` field), THEN THE Digest_Handler SHALL set the traffic section to `null` with a warning describing the Matomo error.

### Requirement 7: MCP Tool Registration

**User Story:** As a developer, I want the three new tools registered in the MCP server with proper schemas and labels, so that they are discoverable and usable by AI agents.

#### Acceptance Criteria

1. THE MCP_Server SHALL register `get_altwire_uptime`, `get_altwire_incidents`, and `get_altwire_morning_digest` as tools with descriptive `description` fields and appropriate `inputSchema` definitions.
2. THE MCP_Server SHALL wrap each tool handler with Safe_Tool_Handler to ensure unexpected exceptions return structured error responses.
3. THE MCP_Server SHALL import the handler modules using dynamic `await import()` syntax in `index.js`.
4. WHEN the `hal-labels.js` file is loaded, THE LABEL_MAP SHALL include display labels for `get_altwire_uptime`, `get_altwire_incidents`, and `get_altwire_morning_digest`.

### Requirement 8: Environment Configuration

**User Story:** As a developer, I want the `BETTER_STACK_TOKEN` documented in `.env.example`, so that new deployments know which credentials are required.

#### Acceptance Criteria

1. THE `.env.example` file SHALL include a `BETTER_STACK_TOKEN` entry with a descriptive comment indicating it is a read-only Better Stack API token.

### Requirement 9: Module Conventions

**User Story:** As a developer, I want the new handler files to follow the existing ESM and coding conventions, so that the codebase remains consistent.

#### Acceptance Criteria

1. THE Monitoring_Handler and Digest_Handler SHALL use ESM `import`/`export` syntax exclusively, with no `require()` calls.
2. THE Monitoring_Handler and Digest_Handler SHALL import the Pool from `../lib/altus-db.js` using the default export.
3. THE Monitoring_Handler and Digest_Handler SHALL import the logger from `../logger.js`.
4. THE Monitoring_Handler SHALL hardcode Monitor_IDs (`1881007` for site, `2836297` for wp_cron) as constants rather than reading them from environment variables.

### Requirement 10: File Boundary Constraints

**User Story:** As a developer, I want clear boundaries on which files are created and modified, so that existing functionality is not disrupted.

#### Acceptance Criteria

1. THE implementation SHALL create exactly two new handler files: `handlers/altus-monitoring.js` and `handlers/altus-digest.js`.
2. THE implementation SHALL modify only `index.js`, `hal-labels.js`, and `.env.example` among existing files.
3. THE implementation SHALL leave all existing handler files, `lib/altus-db.js`, `lib/safe-tool-handler.js`, `lib/ai-cost-tracker.js`, `lib/voyage.js`, `scripts/ingest.js`, and all existing test files unmodified.
