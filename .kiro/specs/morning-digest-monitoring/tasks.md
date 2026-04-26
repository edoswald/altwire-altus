# Implementation Plan: Morning Digest & Monitoring

## Overview

Add three new MCP tools to altwire-altus: `get_altwire_uptime`, `get_altwire_incidents`, and `get_altwire_morning_digest`. Implementation creates two new handler files (`handlers/altus-monitoring.js`, `handlers/altus-digest.js`) and modifies three existing files (`index.js`, `hal-labels.js`, `.env.example`). All code is ESM-only, uses `safeToolHandler` wrapping, `TEST_MODE` guards, and graceful degradation. The digest aggregates 7 data sources via `Promise.allSettled` so individual failures never block the briefing.

## Tasks

- [x] 1. Create the monitoring handler (`handlers/altus-monitoring.js`)
  - [x] 1.1 Implement `getAltwireUptime()` with Better Stack API integration
    - Import `logger` from `../logger.js`
    - Define constants: `BETTER_STACK_BASE = 'https://uptime.betterstack.com/api/v2'`, `MONITORS = { site: '1881007', wp_cron: '2836297' }`
    - Add `TEST_MODE` guard returning canned response with `test_mode: true`
    - Add missing `BETTER_STACK_TOKEN` guard returning `{ error: 'BETTER_STACK_TOKEN not configured' }`
    - Fetch `GET /monitors/{id}` for both monitors in parallel via `Promise.all`
    - Authenticate with `Authorization: Bearer ${BETTER_STACK_TOKEN}` header
    - Map each response to `{ status, last_checked_at, url }` from `data.attributes`
    - Wrap all fetch calls in try/catch — return `{ error: <reason> }` on any failure, never throw
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.3, 9.4_

  - [x] 1.2 Implement `getAltwireIncidents()` with Better Stack API integration
    - Same guards as uptime (`TEST_MODE`, missing token)
    - Fetch `GET /incidents?monitor_id={id}&resolved=false&per_page=5` for each monitor in parallel
    - Map each incident to `{ name, started_at, cause }` from `attributes`
    - Return empty array when no incidents exist for a monitor
    - Wrap all fetch calls in try/catch — return `{ error: <reason> }` on any failure, never throw
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.1, 9.3, 9.4_

  - [ ]* 1.3 Write property test for uptime response mapping (Property 1)
    - **Property 1: Uptime response mapping preserves required fields**
    - Generate arbitrary Better Stack monitor API responses with `status`, `last_checked_at`, `url` attributes
    - Assert the mapped output preserves all three fields with original values for both `site` and `wp_cron` keys
    - Test file: `tests/monitoring-response-mapping.property.test.js`
    - **Validates: Requirements 1.3**

  - [ ]* 1.4 Write property test for Better Stack error handling (Property 2)
    - **Property 2: Better Stack error handling never throws**
    - Generate arbitrary fetch failures (network errors, HTTP 4xx/5xx, malformed JSON)
    - Assert both `getAltwireUptime` and `getAltwireIncidents` return an object with `error` field and never throw
    - Test file: `tests/monitoring-error-handling.property.test.js`
    - **Validates: Requirements 1.5, 2.5**

  - [ ]* 1.5 Write property test for incidents response mapping (Property 3)
    - **Property 3: Incidents response mapping preserves required fields**
    - Generate arbitrary arrays of Better Stack incident objects with `name`, `started_at`, `cause` attributes
    - Assert mapped output preserves all three fields; empty source arrays produce empty result arrays
    - Add to test file: `tests/monitoring-response-mapping.property.test.js`
    - **Validates: Requirements 2.2, 2.3**

- [x] 2. Checkpoint — Verify monitoring handler
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Create the digest handler (`handlers/altus-digest.js`)
  - [x] 3.1 Implement `getAltwireMorningDigest()` with 7-source aggregation
    - Import `pool` (default) from `../lib/altus-db.js`, `logger` from `../logger.js`
    - Import `getAltwireUptime`, `getAltwireIncidents` from `./altus-monitoring.js`
    - Verify Matomo export name: import `getTrafficSummary` from `./altwire-matomo-client.js`
    - Add `TEST_MODE` guard returning canned digest with `test_mode: true`
    - Derive `today` using `new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })`
    - Fire all 7 fetches via `Promise.allSettled`:
      1. `getAltwireUptime()`
      2. `getAltwireIncidents()`
      3. `pool.query(...)` for `agent_memory` key `altus:news_alert:{today}` with `agent = 'altus'`
      4. `pool.query(...)` for `agent_memory` key `altus:story_opportunities:{today}` with `agent = 'altus'`
      5. `pool.query(...)` for `altus_reviews` — `due_date IS NOT NULL AND due_date <= CURRENT_DATE + INTERVAL '7 days' AND status NOT IN ('published', 'cancelled')` ordered by `due_date ASC`
      6. `pool.query(...)` for `altus_loaners` — `expected_return_date < CURRENT_DATE AND actual_return_date IS NULL AND status NOT IN ('returned', 'kept', 'lost')` ordered by `expected_return_date ASC`
      7. `getTrafficSummary('day', 'yesterday')`
    - For each settled result: `fulfilled` → extract/transform value; `rejected` → section `null` + `{section}_warning` string
    - Parse agent memory `value` column as JSON; if no row found, section `null` with note
    - If Matomo result contains `error` field, treat as failure (section `null` + warning)
    - Return aggregate with `date`, `generated_at` (ISO timestamp), and all 7 sections
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 9.1, 9.2, 9.3_

  - [ ]* 3.2 Write property test for digest section failure isolation (Property 4)
    - **Property 4: Digest section failure isolation**
    - Generate random subsets of the 7 data sources that fail (throw/reject/return error)
    - Mock `pool.query`, `getAltwireUptime`, `getAltwireIncidents`, `getTrafficSummary`
    - Assert failed sections are `null` with `_warning` string; non-failed sections contain expected data
    - Test file: `tests/digest-section-isolation.property.test.js`
    - **Validates: Requirements 3.1, 3.3**

  - [ ]* 3.3 Write property test for agent memory JSON parse round-trip (Property 5)
    - **Property 5: Agent memory value JSON parse round-trip**
    - Generate arbitrary JSON-serializable objects, stringify them, then parse
    - Assert parsed result equals the original object
    - Test file: `tests/digest-agent-memory-parse.property.test.js`
    - **Validates: Requirements 4.4**

  - [ ]* 3.4 Write property test for review deadline filter correctness (Property 6)
    - **Property 6: Review deadline filter correctness**
    - Generate random sets of review records with varying `due_date` and `status` values
    - Apply the filter logic: `due_date IS NOT NULL`, within 7 days of today, `status NOT IN ('published', 'cancelled')`
    - Assert the filter returns exactly the matching subset, ordered by `due_date ASC`
    - Test file: `tests/digest-review-loaner-filter.property.test.js`
    - **Validates: Requirements 5.1, 5.3**

  - [ ]* 3.5 Write property test for overdue loaner filter correctness (Property 7)
    - **Property 7: Overdue loaner filter correctness**
    - Generate random sets of loaner records with varying `expected_return_date`, `actual_return_date`, and `status` values
    - Apply the filter logic: `expected_return_date < today`, `actual_return_date IS NULL`, `status NOT IN ('returned', 'kept', 'lost')`
    - Assert the filter returns exactly the matching subset, ordered by `expected_return_date ASC`
    - Add to test file: `tests/digest-review-loaner-filter.property.test.js`
    - **Validates: Requirements 5.2, 5.4**

- [x] 4. Checkpoint — Verify digest handler
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Register tools in `index.js` and update supporting files
  - [x] 5.1 Register three new MCP tools in `index.js`
    - Make `createMcpServer()` async to support `await import()`
    - Add dynamic imports inside `createMcpServer()`: `const { getAltwireUptime, getAltwireIncidents } = await import('./handlers/altus-monitoring.js')` and `const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js')`
    - Register `get_altwire_uptime` — no input parameters, descriptive description, wrapped with `safeToolHandler`
    - Register `get_altwire_incidents` — no input parameters, descriptive description, wrapped with `safeToolHandler`
    - Register `get_altwire_morning_digest` — no input parameters, descriptive description, wrapped with `safeToolHandler`
    - Each handler returns `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
    - _Requirements: 7.1, 7.2, 7.3, 10.2_

  - [x] 5.2 Add display labels to `hal-labels.js`
    - Add `get_altwire_uptime: 'Checking site uptime'` to `LABEL_MAP`
    - Add `get_altwire_incidents: 'Checking open incidents'` to `LABEL_MAP`
    - Add `get_altwire_morning_digest: 'Generating morning digest'` to `LABEL_MAP`
    - _Requirements: 7.4_

  - [x] 5.3 Add `BETTER_STACK_TOKEN` to `.env.example`
    - Add a `# Better Stack Monitoring` section header
    - Add `BETTER_STACK_TOKEN=` with comment: `# Read-only Better Stack API token for uptime monitoring`
    - _Requirements: 8.1_

  - [ ]* 5.4 Write unit tests for monitoring handler
    - Test `TEST_MODE` guard returns canned response with `test_mode: true`
    - Test missing `BETTER_STACK_TOKEN` returns `{ error: 'BETTER_STACK_TOKEN not configured' }`
    - Test successful uptime and incidents responses with mocked fetch
    - Test file: `tests/altus-monitoring.unit.test.js`
    - _Requirements: 1.4, 1.5, 1.6, 2.4, 2.5, 2.6_

  - [ ]* 5.5 Write unit tests for digest handler
    - Test `TEST_MODE` guard returns canned digest with `test_mode: true`
    - Test all-sections-present smoke test with fully mocked dependencies
    - Test `date` format matches `YYYY-MM-DD` and `generated_at` is valid ISO timestamp
    - Test Matomo error propagation sets traffic section to `null` with warning
    - Test file: `tests/altus-digest.unit.test.js`
    - _Requirements: 3.4, 3.5, 3.6, 6.2_

- [x] 6. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All new code must be ESM-only (`import`/`export`, no `require()`)
- Never modify existing handler files, lib files, or test files (Requirement 10.3)
- fast-check v4.1 and vitest v4.1 are already in devDependencies
