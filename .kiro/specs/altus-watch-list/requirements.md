# Requirements Document

## Introduction

Add a watch list management feature to the Altus MCP server so Derek can maintain a list of artists and topics for the news monitor cron to track. The existing `get_news_opportunities` tool already queries `altus_watch_list WHERE active = true` and handles gracefully when the table does not exist — once the table is created and populated, cross-referencing activates automatically. This feature introduces one new database table (`altus_watch_list`), one new handler module (`handlers/altus-watch-list.js`), three new MCP tools, and a schema initialization function — all following established Altus patterns (ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `DATABASE_URL` guards, `server.registerTool()`, `altus_` table prefix). No changes to existing handlers, cron logic, or dependencies are required.

## Glossary

- **Altus**: The AltWire MCP server (`altwire-altus`), exposing tools for AltWire content and editorial operations
- **Watch_List_Handler**: The handler module (`handlers/altus-watch-list.js`) containing all watch list business logic and schema initialization
- **Tool_Registry**: The `index.js` file where MCP tools are registered via `server.registerTool()` and wrapped in `safeToolHandler()`
- **Watch_Subject**: A row in the `altus_watch_list` table representing an artist name or topic that the news monitor tracks
- **News_Monitor**: The existing `handlers/altus-news-monitor.js` module that queries `altus_watch_list` for active subjects and performs case-insensitive substring matching against GSC News data
- **Soft_Delete**: Setting the `active` column to `false` rather than removing the row from the database, preserving historical data
- **Pool**: The shared PostgreSQL connection pool exported from `lib/altus-db.js`
- **Case_Preserved**: Names are stored exactly as provided by the user without normalization; duplicate detection uses `LOWER()` comparison at the application level
- **ILIKE**: PostgreSQL case-insensitive pattern matching operator used by the News_Monitor for watch list cross-referencing and by the remove function for name-based lookups

## Requirements

### Requirement 1: Watch List Database Table

**User Story:** As a developer, I want a dedicated table for watch list subjects, so that the news monitor can cross-reference tracked artists and topics against GSC News data.

#### Acceptance Criteria

1. THE Watch_List_Handler SHALL export an async function `initWatchListSchema` that creates the `altus_watch_list` table with columns: `id` (SERIAL PRIMARY KEY), `name` (TEXT NOT NULL UNIQUE), `active` (BOOLEAN NOT NULL DEFAULT TRUE), `added_at` (TIMESTAMPTZ DEFAULT NOW()), `notes` (TEXT)
2. THE `altus_watch_list` table SHALL enforce a UNIQUE constraint on the `name` column at the database level
3. THE `initWatchListSchema` function SHALL create an index on the `active` column named `idx_altus_watch_list_active` for efficient filtering of active subjects
4. THE `initWatchListSchema` function SHALL use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` patterns consistent with existing Altus schema initialization
5. THE `initWatchListSchema` function SHALL be called at server startup in `index.js` when `DATABASE_URL` is set, alongside existing `initSchema`, `initAiUsageSchema`, and `initReviewTrackerSchema` calls

### Requirement 2: Case-Preserved Storage with Case-Insensitive Duplicate Detection

**User Story:** As Derek using Hal, I want watch list names stored exactly as I provide them while preventing duplicates regardless of casing, so that "Paramore", "paramore", and "PARAMORE" are treated as the same entry.

#### Acceptance Criteria

1. WHEN a new Watch_Subject is added, THE Watch_List_Handler SHALL store the `name` value exactly as provided without lowercasing or other normalization
2. WHEN a new Watch_Subject is added, THE Watch_List_Handler SHALL perform a pre-insert duplicate check using `LOWER(name)` comparison against the provided name lowercased
3. IF a case-insensitive duplicate is found during the pre-insert check, THEN THE Watch_List_Handler SHALL return a descriptive error including the `existing_id` of the matching row and the existing name, without inserting a new row
4. THE Watch_List_Handler SHALL rely on application-level `LOWER()` comparison for case-insensitive duplicate detection rather than a database-level case-insensitive unique constraint

### Requirement 3: Add Watch Subject Tool

**User Story:** As Derek using Hal, I want to add an artist or topic to the news monitor watch list, so that the daily news cron starts tracking coverage opportunities for that subject.

#### Acceptance Criteria

1. WHEN the `altus_add_watch_subject` tool is called with a `name` parameter, THE Watch_List_Handler SHALL insert a new row into `altus_watch_list` and return the created Watch_Subject record
2. THE `altus_add_watch_subject` tool SHALL accept an optional `notes` parameter (TEXT) for context such as "touring in summer 2026"
3. WHEN the `name` parameter matches an existing active or inactive Watch_Subject by case-insensitive comparison, THE Watch_List_Handler SHALL return a friendly error with the `existing_id` and existing `name` without inserting a duplicate
4. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_add_watch_subject` tool SHALL return representative mock data without making database writes
5. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_add_watch_subject` tool SHALL return `{ error: 'Database not configured' }`
6. THE Tool_Registry SHALL register `altus_add_watch_subject` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 4: Remove Watch Subject Tool

**User Story:** As Derek using Hal, I want to remove a subject from the watch list by name or ID, so that the news monitor stops tracking subjects that are no longer relevant.

#### Acceptance Criteria

1. WHEN the `altus_remove_watch_subject` tool is called, THE Watch_List_Handler SHALL perform a Soft_Delete by setting `active = false` on matching rows rather than deleting them
2. THE `altus_remove_watch_subject` tool SHALL accept an optional `id` parameter (INTEGER) and an optional `name` parameter (TEXT), requiring at least one to be provided
3. IF neither `id` nor `name` is provided, THEN THE Watch_List_Handler SHALL return `{ error: 'Either id or name must be provided' }`
4. WHEN the `name` parameter is provided, THE Watch_List_Handler SHALL use case-insensitive ILIKE matching to find the Watch_Subject to deactivate
5. WHEN the `id` parameter is provided, THE Watch_List_Handler SHALL match by exact `id` value
6. THE Watch_List_Handler SHALL return the count of deactivated subjects and the deactivated subject records in the response
7. IF no matching active Watch_Subject is found, THEN THE Watch_List_Handler SHALL return `{ deactivated_count: 0, subjects: [], note: 'No matching active subjects found' }`
8. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_remove_watch_subject` tool SHALL return representative mock data without making database writes
9. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_remove_watch_subject` tool SHALL return `{ error: 'Database not configured' }`
10. THE Tool_Registry SHALL register `altus_remove_watch_subject` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 5: List Watch Subjects Tool

**User Story:** As Derek using Hal, I want to view the current news monitor watch list, so that I can see what artists and topics are being tracked and manage the list.

#### Acceptance Criteria

1. WHEN the `altus_list_watch_subjects` tool is called, THE Watch_List_Handler SHALL return all active Watch_Subject rows from `altus_watch_list` ordered by `active` descending then `added_at` descending
2. THE `altus_list_watch_subjects` tool SHALL accept an optional `include_inactive` parameter (BOOLEAN, default false)
3. WHEN `include_inactive` is set to `true`, THE Watch_List_Handler SHALL return all Watch_Subject rows including deactivated entries
4. WHEN `include_inactive` is set to `false` or not provided, THE Watch_List_Handler SHALL return only rows where `active = true`
5. THE Watch_List_Handler SHALL include `total` count and `active_count` in the response alongside the `subjects` array
6. IF no Watch_Subjects exist matching the filter, THEN THE Watch_List_Handler SHALL return `{ subjects: [], total: 0, active_count: 0 }`
7. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_list_watch_subjects` tool SHALL return representative mock data without making database queries
8. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_list_watch_subjects` tool SHALL return `{ error: 'Database not configured' }`
9. THE Tool_Registry SHALL register `altus_list_watch_subjects` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 6: No Modification of Existing Handlers

**User Story:** As a developer, I want the watch list feature to be entirely self-contained, so that existing news monitor, analytics, and editorial handlers remain untouched and stable.

#### Acceptance Criteria

1. THE Watch_List_Handler SHALL NOT modify `handlers/altus-news-monitor.js` or its cron scheduling logic
2. THE Watch_List_Handler SHALL NOT modify any existing RAG, analytics, GSC, or editorial handler modules
3. THE Watch_List_Handler SHALL NOT introduce new npm dependencies beyond what is already installed in the project
4. THE Watch_List_Handler SHALL import the shared Pool from `lib/altus-db.js` rather than creating a separate database connection pool
5. THE Watch_List_Handler SHALL use the `altus_` table prefix consistent with all other Altus tables
