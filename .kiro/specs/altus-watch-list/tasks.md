# Implementation Plan: Altus Watch List

## Overview

Additive feature introducing one PostgreSQL table (`altus_watch_list`), one handler module (`handlers/altus-watch-list.js`), and three new MCP tools for watch list management. All code follows established Altus patterns: ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `DATABASE_URL` guards, `server.registerTool()`, `altus_` table prefix. The existing news monitor already queries `altus_watch_list WHERE active = true` and handles the table's absence gracefully — once this feature creates and populates the table, cross-referencing activates automatically with zero changes to existing handlers.

## Tasks

- [x] 1. Create handler module with schema initialization and addWatchSubject
  - [x] 1.1 Create `handlers/altus-watch-list.js` with imports, constants, and `initWatchListSchema`
    - Create the handler file with ESM imports: `pool` from `../lib/altus-db.js`, `logger` from `../logger.js`
    - Implement `initWatchListSchema()` with `CREATE TABLE IF NOT EXISTS altus_watch_list` using the exact DDL from the design document: `id` (SERIAL PRIMARY KEY), `name` (TEXT NOT NULL UNIQUE), `active` (BOOLEAN NOT NULL DEFAULT TRUE), `added_at` (TIMESTAMPTZ DEFAULT NOW()), `notes` (TEXT)
    - Create index `idx_altus_watch_list_active` on the `active` column using `CREATE INDEX IF NOT EXISTS`
    - Export `initWatchListSchema`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Implement `addWatchSubject` function
    - `addWatchSubject({ name, notes })` — perform pre-insert duplicate check using `SELECT id, name FROM altus_watch_list WHERE LOWER(name) = LOWER($1)`
    - If case-insensitive duplicate found (active or inactive), return `{ error: 'duplicate', existing_id, existing_name }` without inserting
    - Otherwise INSERT into `altus_watch_list` and return `{ subject: { id, name, active, added_at, notes } }`
    - Store `name` exactly as provided (case-preserved), no lowercasing or normalization
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3_

  - [ ]* 1.3 Write property tests for add subject round-trip and duplicate detection
    - **Property 1: Add subject round-trip preserves data**
    - **Validates: Requirements 2.1, 3.1, 3.2**
    - **Property 2: Case-insensitive duplicate rejection**
    - **Validates: Requirements 2.2, 2.3, 3.3**
    - File: `tests/altus-watch-list.property.test.js`

- [x] 2. Implement removeWatchSubject and listWatchSubjects
  - [x] 2.1 Implement `removeWatchSubject` function
    - `removeWatchSubject({ id, name })` — validate at least one of `id` or `name` is provided, return `{ error: 'Either id or name must be provided' }` if neither
    - If `id` provided: `UPDATE altus_watch_list SET active = false WHERE id = $1 AND active = true RETURNING *`
    - If `name` provided: `UPDATE altus_watch_list SET active = false WHERE name ILIKE $1 AND active = true RETURNING *`
    - Return `{ deactivated_count, subjects }` with the deactivated records, or `{ deactivated_count: 0, subjects: [], note: 'No matching active subjects found' }` when no match
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 2.2 Implement `listWatchSubjects` function
    - `listWatchSubjects({ include_inactive })` — when `include_inactive` is true: `SELECT * FROM altus_watch_list ORDER BY active DESC, added_at DESC`
    - When false/omitted: `SELECT * FROM altus_watch_list WHERE active = true ORDER BY added_at DESC`
    - Return `{ subjects, total, active_count }` where `total = subjects.length` and `active_count` = count of subjects where `active === true`
    - Return `{ subjects: [], total: 0, active_count: 0 }` when no matching subjects exist
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 2.3 Write property tests for soft delete, remove matching, and list filtering
    - **Property 3: Soft delete preserves row with active=false**
    - **Validates: Requirements 4.1, 4.6**
    - **Property 4: Remove by name uses case-insensitive matching**
    - **Validates: Requirements 4.4**
    - **Property 5: Remove by id matches exactly**
    - **Validates: Requirements 4.5**
    - **Property 6: List filter correctness**
    - **Validates: Requirements 5.2, 5.3, 5.4**
    - File: `tests/altus-watch-list.property.test.js`

- [x] 3. Checkpoint — Verify handler module core logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Register MCP tools and schema init in index.js
  - [x] 4.1 Add imports and schema init call to `index.js`
    - Import `initWatchListSchema`, `addWatchSubject`, `removeWatchSubject`, `listWatchSubjects` from `./handlers/altus-watch-list.js`
    - Add `initWatchListSchema().catch((err) => { logger.error('Watch list schema init failed', { error: err.message }); });` in the `DATABASE_URL` startup block alongside existing `initSchema`, `initAiUsageSchema`, and `initReviewTrackerSchema` calls
    - _Requirements: 1.5, 6.4_

  - [x] 4.2 Register `altus_add_watch_subject` tool
    - Use `server.registerTool()` with Zod input schema: `name` as `z.string()`, `notes` as `z.string().optional()`
    - Include `TEST_MODE` mock data intercept returning representative subject data
    - Include `DATABASE_URL` guard returning `{ error: 'Database not configured' }`
    - Wrap handler in `safeToolHandler()`, delegate to `addWatchSubject(params)`
    - Return result wrapped in MCP content format: `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
    - _Requirements: 3.4, 3.5, 3.6_

  - [x] 4.3 Register `altus_remove_watch_subject` tool
    - Use `server.registerTool()` with Zod input schema: `id` as `z.number().int().positive().optional()`, `name` as `z.string().optional()`
    - Include `TEST_MODE` mock data intercept returning representative deactivation data
    - Include `DATABASE_URL` guard returning `{ error: 'Database not configured' }`
    - Wrap handler in `safeToolHandler()`, delegate to `removeWatchSubject(params)`
    - _Requirements: 4.8, 4.9, 4.10_

  - [x] 4.4 Register `altus_list_watch_subjects` tool
    - Use `server.registerTool()` with Zod input schema: `include_inactive` as `z.boolean().default(false).optional()`
    - Include `TEST_MODE` mock data intercept returning representative list data with `subjects`, `total`, `active_count`
    - Include `DATABASE_URL` guard returning `{ error: 'Database not configured' }`
    - Wrap handler in `safeToolHandler()`, delegate to `listWatchSubjects(params)`
    - _Requirements: 5.7, 5.8, 5.9_

- [x] 5. Write unit tests
  - [ ]* 5.1 Write unit tests for handler functions
    - Test `addWatchSubject` — verify INSERT query with correct parameters, verify response shape
    - Test `addWatchSubject` duplicate — mock SELECT to return existing row, verify error response with `existing_id` and `existing_name`
    - Test `removeWatchSubject` by id — verify UPDATE query sets `active = false` with correct WHERE clause
    - Test `removeWatchSubject` by name — verify ILIKE matching in UPDATE query
    - Test `removeWatchSubject` with neither id nor name — verify error response
    - Test `removeWatchSubject` with no match — verify `deactivated_count: 0` response
    - Test `listWatchSubjects` active only — verify WHERE clause includes `active = true`
    - Test `listWatchSubjects` with inactive — verify no active filter in query
    - Test `listWatchSubjects` empty — verify `{ subjects: [], total: 0, active_count: 0 }` response
    - File: `tests/altus-watch-list.unit.test.js`
    - _Requirements: 2.1–2.4, 3.1–3.3, 4.1–4.7, 5.1–5.6_

  - [ ]* 5.2 Write unit tests for TEST_MODE and DATABASE_URL guards
    - Test that each of the 3 tools returns mock data when `TEST_MODE=true`
    - Test that each tool returns `{ error: 'Database not configured' }` when `DATABASE_URL` is unset
    - File: `tests/altus-watch-list.unit.test.js`
    - _Requirements: 3.4–3.5, 4.8–4.9, 5.7–5.8_

- [x] 6. Write remaining property tests for list counts and ordering
  - [ ]* 6.1 Write property tests for list counts consistency and ordering
    - **Property 7: List counts consistency**
    - **Validates: Requirements 5.5**
    - **Property 8: List ordering**
    - **Validates: Requirements 5.1**
    - File: `tests/altus-watch-list.property.test.js`

- [x] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 8 correctness properties from the design document
- Unit tests validate handler logic, TEST_MODE, and DATABASE_URL guards
- No existing tools, tables, or handler modules are modified (Requirement 6)
- The handler module uses the Altus `server.registerTool()` pattern (not `server.tool()`)
- The existing news monitor already queries `altus_watch_list WHERE active = true` — once the table exists, cross-referencing activates automatically
