# Implementation Plan: Altus Analytics

## Overview

Add 7 MCP analytics tools (4 Matomo + 3 GSC) to the Altus server by creating two new handler modules adapted from cirrusly-nimbus, registering all tools in `index.js`, adding the `googleapis` dependency, updating `.env.example`, and creating an editorial interpretation context document. Matomo tools are implemented first (no blockers), GSC tools second.

## Tasks

- [x] 1. Add dependencies and environment variable configuration
  - [x] 1.1 Add `googleapis` production dependency and `fast-check` dev dependency to `package.json`
    - Add `"googleapis": "^146.0.0"` to `dependencies`
    - Add `"fast-check": "^4.1.0"` to `devDependencies`
    - _Requirements: 10.1, 10.2_

  - [x] 1.2 Update `.env.example` with all new analytics environment variables
    - Add `ALTWIRE_MATOMO_URL`, `ALTWIRE_MATOMO_TOKEN_AUTH`, `ALTWIRE_MATOMO_SITE_ID` with descriptive comments
    - Add `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON`, `ALTWIRE_GSC_SITE_URL` with descriptive comments
    - _Requirements: 11.1, 11.2_

- [x] 2. Implement Matomo client handler and tools
  - [x] 2.1 Create `handlers/altwire-matomo-client.js`
    - Adapt from `cirrusly-nimbus/matomo-client.js` — change env var names to `ALTWIRE_MATOMO_URL`, `ALTWIRE_MATOMO_TOKEN_AUTH`, `ALTWIRE_MATOMO_SITE_ID`
    - Change logger import to `../logger.js`
    - Export `getTrafficSummary`, `getReferrerBreakdown`, `getTopPages`, `getSiteSearch`
    - Internal `getConfig()` returns `{ error: 'matomo_not_configured' }` when any env var is missing
    - Internal `callApi()` sends `token_auth` via POST body, handles non-200/non-JSON/network errors
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 15.1_

  - [x] 2.2 Register 4 Matomo tools in `index.js`
    - Import `getTrafficSummary`, `getReferrerBreakdown`, `getTopPages`, `getSiteSearch` from `./handlers/altwire-matomo-client.js`
    - Register `get_altwire_site_analytics` — params: `period` (enum), `date` (string) — calls `getTrafficSummary`
    - Register `get_altwire_traffic_sources` — params: `period`, `date` — calls `getReferrerBreakdown`
    - Register `get_altwire_top_pages` — params: `period`, `date` — calls `getTopPages`
    - Register `get_altwire_site_search` — params: `period`, `date` — calls `getSiteSearch`
    - All use `server.registerTool()` with Zod schemas, wrapped in `safeToolHandler()`
    - All return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 13.1, 13.2, 13.3, 13.4, 14.1_

  - [ ]* 2.3 Write property tests for Matomo env var isolation (Property 1)
    - **Property 1: Matomo env var isolation and graceful degradation**
    - Generate random subsets of ALTWIRE_ Matomo env vars + unprefixed vars; verify all 4 functions return `{ error: 'matomo_not_configured' }` when any required var is missing; verify unprefixed vars have no effect
    - File: `tests/altus-analytics.property.test.js`
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 2.4 Write property tests for Matomo error handling (Property 2)
    - **Property 2: Matomo API error handling never throws**
    - Generate random HTTP status codes (4xx/5xx), random non-JSON strings, random error messages; mock fetch for each failure mode; verify structured error object returned, no exceptions thrown
    - File: `tests/altus-analytics.property.test.js`
    - **Validates: Requirements 1.5, 1.6, 1.7**

  - [ ]* 2.5 Write unit tests for Matomo client
    - Test `getTrafficSummary` returns expected shape with mocked fetch
    - Test `callApi` sends `token_auth` in POST body, not query string
    - Test module exports exactly 4 functions
    - File: `tests/altus-analytics.unit.test.js`
    - _Requirements: 1.1, 1.4, 2.4_

- [x] 3. Checkpoint — Matomo implementation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement GSC client handler and tools
  - [x] 4.1 Create `handlers/altwire-gsc-client.js`
    - Adapt from `cirrusly-nimbus/gsc-client.js` — change env var names to `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON`, `ALTWIRE_GSC_SITE_URL`
    - Change logger import to `../logger.js`
    - Export `normalizeDimensions`, `getSearchPerformance`, `getSearchOpportunities`, `getSitemapHealth`
    - Internal `getConfig()` returns `{ error: 'gsc_not_configured' }` when env vars missing or JSON invalid
    - `getSitemapHealth` is NEW — uses `google.webmasters({ version: 'v3' }).sitemaps.list()` to return sitemap URLs, lastDownloaded, lastSubmitted, isPending, errors, warnings; returns `{ sitemaps: [] }` when none registered
    - `normalizeDimensions` is a pure utility — NOT a tool, do not register it
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.4, 9.5, 15.2_

  - [x] 4.2 Register 3 GSC tools in `index.js`
    - Import `getSearchPerformance`, `getSearchOpportunities`, `getSitemapHealth` from `./handlers/altwire-gsc-client.js`
    - Register `get_altwire_search_performance` — params: `start_date`, `end_date`, optional `row_limit` (default 25), optional `dimensions` (default `['query']`) — calls `getSearchPerformance`
    - Register `get_altwire_search_opportunities` — params: `start_date`, `end_date` — calls `getSearchOpportunities`
    - Register `get_altwire_sitemap_health` — no params — calls `getSitemapHealth`
    - All use `server.registerTool()` with Zod schemas, wrapped in `safeToolHandler()`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 13.1, 13.2, 13.3, 13.4, 14.2_

  - [ ]* 4.3 Write property tests for GSC env var isolation (Property 3)
    - **Property 3: GSC env var isolation and graceful degradation**
    - Generate random subsets of ALTWIRE_ GSC env vars + invalid JSON strings + unprefixed vars; verify all 3 async functions return `{ error: 'gsc_not_configured' }`; verify unprefixed vars have no effect
    - File: `tests/altus-analytics.property.test.js`
    - **Validates: Requirements 6.2, 6.3, 6.4**

  - [ ]* 4.4 Write property tests for GSC error handling (Property 4)
    - **Property 4: GSC API error handling never throws**
    - Generate random error messages; mock googleapis to throw; verify structured error object returned, no exceptions thrown
    - File: `tests/altus-analytics.property.test.js`
    - **Validates: Requirements 6.6**

  - [ ]* 4.5 Write property tests for normalizeDimensions (Property 5)
    - **Property 5: normalizeDimensions always returns a string array**
    - Generate random JS values (string, array of strings, null, undefined, number, object, empty string); verify always returns non-empty string array; verify pure function behavior (same input → same output)
    - File: `tests/altus-analytics.property.test.js`
    - **Validates: Requirements 6.7**

  - [ ]* 4.6 Write property tests for search opportunities filtering (Property 6)
    - **Property 6: Search opportunities filtering invariant**
    - Generate random arrays of `{ impressions, ctr }` rows; verify returned rows have impressions ≥ median AND CTR < median; verify result is subset of input
    - File: `tests/altus-analytics.property.test.js`
    - **Validates: Requirements 8.2**

  - [ ]* 4.7 Write unit tests for GSC client
    - Test `getSitemapHealth` returns `{ sitemaps: [] }` when API returns empty list
    - Test `getSearchPerformance` passes dimensions and rowLimit to API
    - Test module exports exactly 4 functions (3 async + normalizeDimensions)
    - File: `tests/altus-analytics.unit.test.js`
    - _Requirements: 6.1, 7.2, 9.4_

- [x] 5. Checkpoint — GSC implementation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Create editorial interpretation context
  - [x] 6.1 Create `docs/analytics-editorial-context.md`
    - Reframe bounce rate as content engagement signal (not conversion failure)
    - Interpret top pages as editorial resonance indicators (artists, genres, coverage types)
    - Interpret traffic sources through music publication lens (music community referrals, artist name searches, loyal reader direct traffic)
    - Interpret site search terms as reader demand signals for coverage topics
    - Interpret GSC search opportunities as editorial gaps where search visibility exists but content needs strengthening
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

- [x] 7. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.
  - Verify no files in cirrusly-nimbus or cirrusly-mcp-server were modified
  - _Requirements: 15.3_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Matomo tools are implemented first (no blockers) per Requirement 14
- Do NOT modify any files in cirrusly-nimbus or cirrusly-mcp-server per Requirement 15.3
