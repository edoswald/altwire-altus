# Requirements Document

## Introduction

Add review assignment tracking, loaner item management, and structured review note-taking to the Altus MCP server. This gives Derek a persistent, queryable record of what's being reviewed, who has loaner gear, and what deadlines are approaching — all accessible through Hal. The feature introduces three new database tables (`altus_reviews`, `altus_loaners`, `altus_review_notes`), one new handler module (`handlers/review-tracker-handler.js`), 16 new MCP tools, and a combined editorial digest — all following established Altus patterns (ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `DATABASE_URL` guards, `altus_` table prefix). Review notes include AI-powered auto-categorization via Claude Haiku with cost tracking, and the notes schema is designed as a bridge to a future AI Writer feature.

## Glossary

- **Altus**: The AltWire MCP server (`altwire-altus`), exposing tools for AltWire content and editorial operations
- **Review_Tracker_Handler**: The handler module (`handlers/review-tracker-handler.js`) containing all review, loaner, and review note business logic
- **Tool_Registry**: The `index.js` file where MCP tools are registered via `server.registerTool()` and wrapped in `safeToolHandler()`
- **Review**: A row in the `altus_reviews` table representing a product or topic review assignment with status, reviewer, due date, and optional WordPress post link
- **Review_Pipeline**: The ordered status progression for reviews: `assigned` → `in_progress` → `submitted` → `editing` → `scheduled` → `published` → `cancelled`
- **Loaner**: A row in the `altus_loaners` table representing a piece of gear loaned out (or kept) for review purposes, optionally linked to a review via foreign key
- **Loaner_Status**: One of `out`, `kept`, `returned`, `overdue`, `lost` — representing the current state of a loaner item
- **Review_Note**: A row in the `altus_review_notes` table representing an incremental check-in note for a review, categorized as `pro`, `con`, `observation`, or `uncategorized`
- **Auto_Categorization**: A lightweight Claude Haiku API call that classifies a review note's text into `pro`, `con`, or `observation` — never blocks note creation on failure
- **Editorial_Digest**: A combined summary aggregating review pipeline status, upcoming deadlines, and overdue loaners into a single response
- **AI_Cost_Tracker**: The `lib/ai-cost-tracker.js` module that logs all Anthropic API calls to the `ai_usage` table for cost monitoring
- **Haiku**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`), used for low-cost note auto-categorization calls
- **Pool**: The shared PostgreSQL connection pool exported from `lib/altus-db.js`

## Requirements

### Requirement 1: Reviews Database Table

**User Story:** As a developer, I want a dedicated table for review assignments, so that review pipeline state is stored persistently and queryable.

#### Acceptance Criteria

1. THE Review_Tracker_Handler SHALL export an async function `initReviewTrackerSchema` that creates the `altus_reviews` table with columns: `id` (SERIAL PRIMARY KEY), `title` (TEXT NOT NULL), `product` (TEXT), `reviewer` (TEXT NOT NULL DEFAULT 'Derek'), `status` (TEXT NOT NULL DEFAULT 'assigned'), `due_date` (DATE), `assigned_date` (DATE DEFAULT CURRENT_DATE), `wp_post_id` (INTEGER), `notes` (TEXT), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW())
2. THE `altus_reviews` table `status` column SHALL only accept values from the Review_Pipeline: `assigned`, `in_progress`, `submitted`, `editing`, `scheduled`, `published`, `cancelled`
3. THE `initReviewTrackerSchema` function SHALL use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` patterns consistent with existing Altus schema initialization
4. THE `altus_reviews` table SHALL have an index on `status` for efficient pipeline filtering
5. THE `altus_reviews` table SHALL have an index on `due_date` for efficient deadline queries
6. THE `initReviewTrackerSchema` function SHALL be called at server startup in `index.js` when `DATABASE_URL` is set, alongside existing `initSchema` and `initAiUsageSchema` calls


### Requirement 2: Loaners Database Table

**User Story:** As a developer, I want a dedicated table for loaner items, so that gear loan status and return dates are tracked persistently.

#### Acceptance Criteria

1. THE `initReviewTrackerSchema` function SHALL create the `altus_loaners` table with columns: `id` (SERIAL PRIMARY KEY), `item_name` (TEXT NOT NULL), `brand` (TEXT), `borrower` (TEXT NOT NULL DEFAULT 'Derek'), `is_loaner` (BOOLEAN NOT NULL DEFAULT true), `status` (TEXT NOT NULL DEFAULT 'out'), `loaned_date` (DATE DEFAULT CURRENT_DATE), `expected_return_date` (DATE), `actual_return_date` (DATE), `review_id` (INTEGER REFERENCES altus_reviews(id) ON DELETE SET NULL), `notes` (TEXT), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW())
2. THE `altus_loaners` table `status` column SHALL only accept values: `out`, `kept`, `returned`, `overdue`, `lost`
3. THE `altus_loaners` table SHALL have an index on `status` for efficient status filtering
4. THE `altus_loaners` table SHALL have an index on `expected_return_date` for efficient deadline queries
5. THE `altus_loaners` table SHALL have a foreign key from `review_id` to `altus_reviews(id)` with `ON DELETE SET NULL` behavior, so that deleting a review does not cascade-delete loaner records but instead clears the link

### Requirement 3: Review Notes Database Table

**User Story:** As a developer, I want a dedicated table for incremental review notes, so that Derek's check-in observations are stored with category metadata for future AI Writer integration.

#### Acceptance Criteria

1. THE `initReviewTrackerSchema` function SHALL create the `altus_review_notes` table with columns: `id` (SERIAL PRIMARY KEY), `review_id` (INTEGER NOT NULL REFERENCES altus_reviews(id) ON DELETE CASCADE), `note_text` (TEXT NOT NULL), `category` (TEXT NOT NULL DEFAULT 'uncategorized'), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW())
2. THE `altus_review_notes` table `category` column SHALL only accept values: `pro`, `con`, `observation`, `uncategorized`
3. THE `altus_review_notes` table SHALL have an index on `review_id` for efficient per-review note retrieval
4. THE `altus_review_notes` table SHALL have an index on `category` for efficient category-based filtering
5. THE `altus_review_notes` table SHALL use `ON DELETE CASCADE` on the `review_id` foreign key, so that deleting a review automatically removes all associated notes

### Requirement 4: Date Field Format Convention

**User Story:** As a developer, I want all date fields in the review tracker tables to use the DATE type and return ISO YYYY-MM-DD strings, so that date handling is consistent and timezone-agnostic for editorial scheduling.

#### Acceptance Criteria

1. THE `altus_reviews` table `due_date` and `assigned_date` columns SHALL use the PostgreSQL DATE type, not TIMESTAMPTZ
2. THE `altus_loaners` table `loaned_date`, `expected_return_date`, and `actual_return_date` columns SHALL use the PostgreSQL DATE type, not TIMESTAMPTZ
3. WHEN the Review_Tracker_Handler returns date values in tool responses, THE handler SHALL format DATE columns as ISO YYYY-MM-DD strings

### Requirement 5: Create Review Tool

**User Story:** As Derek using Hal, I want to create a new review assignment, so that I can track what products and topics are in the review pipeline.

#### Acceptance Criteria

1. WHEN the `altus_create_review` tool is called with a `title` parameter, THE Review_Tracker_Handler SHALL insert a new row into `altus_reviews` and return the created review record
2. THE `altus_create_review` tool SHALL accept optional parameters: `product` (TEXT), `reviewer` (TEXT), `status` (TEXT), `due_date` (TEXT — ISO date string), `wp_post_id` (INTEGER), `notes` (TEXT)
3. WHEN the `reviewer` parameter is not provided, THE Review_Tracker_Handler SHALL default the reviewer to `'Derek'`
4. WHEN the `status` parameter is not provided, THE Review_Tracker_Handler SHALL default the status to `'assigned'`
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_create_review` tool SHALL return representative mock data without making database writes
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_create_review` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `altus_create_review` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper


### Requirement 6: Update Review Tool

**User Story:** As Derek using Hal, I want to update a review's status, due date, or other fields, so that I can advance reviews through the pipeline and adjust deadlines.

#### Acceptance Criteria

1. WHEN the `altus_update_review` tool is called with a `review_id` parameter and one or more update fields, THE Review_Tracker_Handler SHALL update the matching row in `altus_reviews` and return the updated review record
2. THE `altus_update_review` tool SHALL accept optional update parameters: `title` (TEXT), `product` (TEXT), `reviewer` (TEXT), `status` (TEXT), `due_date` (TEXT — ISO date string), `wp_post_id` (INTEGER), `notes` (TEXT)
3. WHEN the `status` parameter is provided, THE Review_Tracker_Handler SHALL validate that the value is one of the Review_Pipeline statuses before updating
4. THE Review_Tracker_Handler SHALL set the `updated_at` column to `NOW()` on every update
5. IF no review exists with the specified `review_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'review_not_found', review_id: <id> }`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_update_review` tool SHALL return representative mock data without making database writes
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_update_review` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `altus_update_review` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 7: Get Review Tool

**User Story:** As Derek using Hal, I want to retrieve a specific review by ID, so that I can check its current status and details.

#### Acceptance Criteria

1. WHEN the `altus_get_review` tool is called with a `review_id` parameter, THE Review_Tracker_Handler SHALL return the matching row from `altus_reviews` including all columns
2. IF no review exists with the specified `review_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'review_not_found', review_id: <id> }`
3. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_get_review` tool SHALL return representative mock data without making database queries
4. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_get_review` tool SHALL return `{ error: 'Database not configured' }`
5. THE Tool_Registry SHALL register `altus_get_review` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 8: List Reviews Tool

**User Story:** As Derek using Hal, I want to list reviews with optional filtering by status and reviewer, so that I can see the full pipeline or focus on a specific stage.

#### Acceptance Criteria

1. WHEN the `altus_list_reviews` tool is called, THE Review_Tracker_Handler SHALL return all rows from `altus_reviews` ordered by `due_date` ascending with nulls last
2. THE `altus_list_reviews` tool SHALL accept optional filter parameters: `status` (TEXT), `reviewer` (TEXT)
3. WHEN the `status` parameter is provided, THE Review_Tracker_Handler SHALL filter results to only reviews matching that status
4. WHEN the `reviewer` parameter is provided, THE Review_Tracker_Handler SHALL filter results to only reviews assigned to that reviewer
5. IF no reviews match the filter criteria, THEN THE Review_Tracker_Handler SHALL return `{ reviews: [], count: 0 }`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_list_reviews` tool SHALL return representative mock data without making database queries
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_list_reviews` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `altus_list_reviews` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 9: Get Upcoming Review Deadlines Tool

**User Story:** As Derek using Hal, I want to see which reviews have deadlines approaching in the next N days, so that I can prioritize work and avoid missing due dates.

#### Acceptance Criteria

1. WHEN the `altus_get_upcoming_review_deadlines` tool is called, THE Review_Tracker_Handler SHALL return all reviews with a `due_date` within the next N days (default 7) that are not in `published` or `cancelled` status
2. THE `altus_get_upcoming_review_deadlines` tool SHALL accept an optional `days` parameter (INTEGER, default 7) to control the lookahead window
3. THE Review_Tracker_Handler SHALL order results by `due_date` ascending so the most urgent deadlines appear first
4. THE Review_Tracker_Handler SHALL include reviews where `due_date` is today or in the past (overdue) in the results, clearly distinguishable by date comparison
5. IF no reviews have upcoming deadlines within the specified window, THEN THE Review_Tracker_Handler SHALL return `{ reviews: [], count: 0, note: 'No review deadlines in the next N days' }`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_get_upcoming_review_deadlines` tool SHALL return representative mock data without making database queries
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_get_upcoming_review_deadlines` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `altus_get_upcoming_review_deadlines` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper


### Requirement 10: Log Loaner Tool

**User Story:** As Derek using Hal, I want to log a piece of gear as loaned out or kept, so that I have a persistent record of what gear is where.

#### Acceptance Criteria

1. WHEN the `altus_log_loaner` tool is called with an `item_name` parameter, THE Review_Tracker_Handler SHALL insert a new row into `altus_loaners` and return the created loaner record
2. THE `altus_log_loaner` tool SHALL accept optional parameters: `brand` (TEXT), `borrower` (TEXT), `is_loaner` (BOOLEAN), `expected_return_date` (TEXT — ISO date string), `review_id` (INTEGER), `notes` (TEXT)
3. WHEN the `borrower` parameter is not provided, THE Review_Tracker_Handler SHALL default the borrower to `'Derek'`
4. WHEN `is_loaner` is set to `false`, THE Review_Tracker_Handler SHALL set the status to `'kept'` and set `expected_return_date` to NULL regardless of any provided value
5. WHEN `is_loaner` is set to `true` or not provided, THE Review_Tracker_Handler SHALL set the status to `'out'`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_log_loaner` tool SHALL return representative mock data without making database writes
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_log_loaner` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `altus_log_loaner` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 11: Update Loaner Tool

**User Story:** As Derek using Hal, I want to update a loaner's status, return date, or other fields, so that I can record returns, mark items as lost, or change keeper status.

#### Acceptance Criteria

1. WHEN the `altus_update_loaner` tool is called with a `loaner_id` parameter and one or more update fields, THE Review_Tracker_Handler SHALL update the matching row in `altus_loaners` and return the updated loaner record
2. THE `altus_update_loaner` tool SHALL accept optional update parameters: `item_name` (TEXT), `brand` (TEXT), `borrower` (TEXT), `is_loaner` (BOOLEAN), `status` (TEXT), `expected_return_date` (TEXT — ISO date string), `actual_return_date` (TEXT — ISO date string), `review_id` (INTEGER), `notes` (TEXT)
3. WHEN the `status` parameter is set to `'returned'` and `actual_return_date` is not provided, THE Review_Tracker_Handler SHALL auto-set `actual_return_date` to the current date
4. WHEN `is_loaner` is set to `false`, THE Review_Tracker_Handler SHALL set the status to `'kept'` and clear `expected_return_date` to NULL
5. THE Review_Tracker_Handler SHALL set the `updated_at` column to `NOW()` on every update
6. IF no loaner exists with the specified `loaner_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'loaner_not_found', loaner_id: <id> }`
7. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_update_loaner` tool SHALL return representative mock data without making database writes
8. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_update_loaner` tool SHALL return `{ error: 'Database not configured' }`
9. THE Tool_Registry SHALL register `altus_update_loaner` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 12: Get Loaner Tool

**User Story:** As Derek using Hal, I want to retrieve a specific loaner by ID, so that I can check its current status and details.

#### Acceptance Criteria

1. WHEN the `altus_get_loaner` tool is called with a `loaner_id` parameter, THE Review_Tracker_Handler SHALL return the matching row from `altus_loaners` including all columns
2. IF no loaner exists with the specified `loaner_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'loaner_not_found', loaner_id: <id> }`
3. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_get_loaner` tool SHALL return representative mock data without making database queries
4. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_get_loaner` tool SHALL return `{ error: 'Database not configured' }`
5. THE Tool_Registry SHALL register `altus_get_loaner` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 13: List Loaners Tool

**User Story:** As Derek using Hal, I want to list loaners with optional filtering by status, so that I can see all outstanding gear or focus on a specific status.

#### Acceptance Criteria

1. WHEN the `altus_list_loaners` tool is called, THE Review_Tracker_Handler SHALL return all rows from `altus_loaners` ordered by `loaned_date` descending
2. THE `altus_list_loaners` tool SHALL accept optional filter parameters: `status` (TEXT), `borrower` (TEXT)
3. WHEN the `status` parameter is provided, THE Review_Tracker_Handler SHALL filter results to only loaners matching that status
4. WHEN the `borrower` parameter is provided, THE Review_Tracker_Handler SHALL filter results to only loaners assigned to that borrower
5. IF no loaners match the filter criteria, THEN THE Review_Tracker_Handler SHALL return `{ loaners: [], count: 0 }`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_list_loaners` tool SHALL return representative mock data without making database queries
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_list_loaners` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `altus_list_loaners` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper


### Requirement 14: Get Overdue Loaners Tool

**User Story:** As Derek using Hal, I want to see which loaner items are past their expected return date, so that I can follow up on outstanding gear.

#### Acceptance Criteria

1. WHEN the `altus_get_overdue_loaners` tool is called, THE Review_Tracker_Handler SHALL return all loaners where `expected_return_date` is before the current date AND `actual_return_date` IS NULL AND `status` is not `'returned'`, `'kept'`, or `'lost'`
2. THE Review_Tracker_Handler SHALL compute overdue status dynamically from the `expected_return_date` and `actual_return_date` columns rather than relying on the `status` field
3. THE Review_Tracker_Handler SHALL order results by `expected_return_date` ascending so the most overdue items appear first
4. IF no loaners are overdue, THEN THE Review_Tracker_Handler SHALL return `{ loaners: [], count: 0, note: 'No overdue loaners' }`
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_get_overdue_loaners` tool SHALL return representative mock data without making database queries
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_get_overdue_loaners` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `altus_get_overdue_loaners` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 15: Get Upcoming Loaner Returns Tool

**User Story:** As Derek using Hal, I want to see which loaner items have return dates approaching in the next N days, so that I can plan returns proactively.

#### Acceptance Criteria

1. WHEN the `altus_get_upcoming_loaner_returns` tool is called, THE Review_Tracker_Handler SHALL return all loaners with an `expected_return_date` within the next N days (default 14) that have not been returned (`actual_return_date` IS NULL) and are not in `'kept'` or `'lost'` status
2. THE `altus_get_upcoming_loaner_returns` tool SHALL accept an optional `days` parameter (INTEGER, default 14) to control the lookahead window
3. THE Review_Tracker_Handler SHALL order results by `expected_return_date` ascending so the soonest returns appear first
4. IF no loaners have upcoming returns within the specified window, THEN THE Review_Tracker_Handler SHALL return `{ loaners: [], count: 0, note: 'No loaner returns due in the next N days' }`
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_get_upcoming_loaner_returns` tool SHALL return representative mock data without making database queries
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_get_upcoming_loaner_returns` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `altus_get_upcoming_loaner_returns` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 16: Add Review Note Tool

**User Story:** As Derek using Hal, I want to add incremental check-in notes to a review with automatic categorization, so that my observations are structured for future AI Writer integration.

#### Acceptance Criteria

1. WHEN the `altus_add_review_note` tool is called with `review_id` and `note_text` parameters, THE Review_Tracker_Handler SHALL insert a new row into `altus_review_notes` and return the created note record
2. THE `altus_add_review_note` tool SHALL accept an optional `category` parameter (TEXT) to manually override auto-categorization
3. WHEN the `category` parameter is not provided, THE Review_Tracker_Handler SHALL call the Anthropic API using Haiku (`claude-haiku-4-5-20251001`) to classify the note text as `pro`, `con`, or `observation`
4. IF the Anthropic auto-categorization API call fails for any reason, THEN THE Review_Tracker_Handler SHALL set the category to `'uncategorized'` and proceed with note creation without error
5. THE Review_Tracker_Handler SHALL log each Haiku auto-categorization API call via AI_Cost_Tracker, recording the tool name as `'altus_add_review_note'`
6. IF no review exists with the specified `review_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'review_not_found', review_id: <id> }`
7. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_add_review_note` tool SHALL return representative mock data without making database writes or API calls
8. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_add_review_note` tool SHALL return `{ error: 'Database not configured' }`
9. THE Tool_Registry SHALL register `altus_add_review_note` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 17: Update Review Note Tool

**User Story:** As Derek using Hal, I want to update an existing review note's text or category, so that I can correct or reclassify notes after creation.

#### Acceptance Criteria

1. WHEN the `altus_update_review_note` tool is called with a `note_id` parameter and one or more update fields, THE Review_Tracker_Handler SHALL update the matching row in `altus_review_notes` and return the updated note record
2. THE `altus_update_review_note` tool SHALL accept optional update parameters: `note_text` (TEXT), `category` (TEXT)
3. THE Review_Tracker_Handler SHALL set the `updated_at` column to `NOW()` on every update
4. IF no review note exists with the specified `note_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'note_not_found', note_id: <id> }`
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_update_review_note` tool SHALL return representative mock data without making database writes
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_update_review_note` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `altus_update_review_note` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper


### Requirement 18: List Review Notes Tool

**User Story:** As Derek using Hal, I want to list all notes for a specific review with optional category filtering, so that I can review my accumulated observations or pull just the pros/cons for a draft.

#### Acceptance Criteria

1. WHEN the `altus_list_review_notes` tool is called with a `review_id` parameter, THE Review_Tracker_Handler SHALL return all rows from `altus_review_notes` matching that review, ordered by `created_at` ascending
2. THE `altus_list_review_notes` tool SHALL accept an optional `category` parameter (TEXT) to filter notes by category
3. WHEN the `category` parameter is provided, THE Review_Tracker_Handler SHALL filter results to only notes matching that category
4. IF no notes exist for the specified review, THEN THE Review_Tracker_Handler SHALL return `{ notes: [], count: 0 }`
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_list_review_notes` tool SHALL return representative mock data without making database queries
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_list_review_notes` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `altus_list_review_notes` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 19: Delete Review Note Tool

**User Story:** As Derek using Hal, I want to delete a specific review note, so that I can remove incorrect or irrelevant observations.

#### Acceptance Criteria

1. WHEN the `altus_delete_review_note` tool is called with a `note_id` parameter, THE Review_Tracker_Handler SHALL delete the matching row from `altus_review_notes` and return a confirmation
2. IF no review note exists with the specified `note_id`, THEN THE Review_Tracker_Handler SHALL return `{ error: 'note_not_found', note_id: <id> }`
3. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_delete_review_note` tool SHALL return representative mock data without making database deletes
4. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_delete_review_note` tool SHALL return `{ error: 'Database not configured' }`
5. THE Tool_Registry SHALL register `altus_delete_review_note` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 20: Editorial Digest Tool

**User Story:** As Derek using Hal, I want a single combined digest of review pipeline status, upcoming deadlines, and overdue loaners, so that I get a complete editorial snapshot in one call.

#### Acceptance Criteria

1. WHEN the `altus_get_editorial_digest` tool is called, THE Review_Tracker_Handler SHALL return a combined response containing: a count of reviews grouped by status, a list of reviews with deadlines in the next 7 days, a list of overdue loaners, and a count of loaners grouped by status
2. THE Review_Tracker_Handler SHALL compute the digest using direct database queries rather than calling other tool handlers, to minimize query overhead
3. THE editorial digest SHALL include a `generated_at` timestamp in the response
4. IF no reviews or loaners exist, THEN THE Review_Tracker_Handler SHALL return the digest structure with empty arrays and zero counts
5. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `altus_get_editorial_digest` tool SHALL return representative mock data without making database queries
6. IF the `DATABASE_URL` environment variable is not set, THEN THE `altus_get_editorial_digest` tool SHALL return `{ error: 'Database not configured' }`
7. THE Tool_Registry SHALL register `altus_get_editorial_digest` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 21: Auto-Categorization via Anthropic API

**User Story:** As a developer, I want review note auto-categorization to use a lightweight Haiku call with graceful failure handling, so that notes are enriched without blocking creation.

#### Acceptance Criteria

1. THE Review_Tracker_Handler SHALL call the Anthropic API using model `claude-haiku-4-5-20251001` with a system prompt instructing classification of the note text into exactly one of: `pro`, `con`, `observation`
2. THE auto-categorization prompt SHALL instruct Haiku to respond with only the category word — no explanation or additional text
3. IF the Anthropic API response does not contain a valid category (`pro`, `con`, or `observation`), THEN THE Review_Tracker_Handler SHALL fall back to `'uncategorized'`
4. IF the Anthropic API call throws an error or times out, THEN THE Review_Tracker_Handler SHALL fall back to `'uncategorized'` and log the error via the logger
5. THE Review_Tracker_Handler SHALL log every Anthropic API call (successful or failed) via AI_Cost_Tracker with tool name `'altus_add_review_note'`
6. THE auto-categorization call SHALL use the `ANTHROPIC_API_KEY` environment variable already present in the Altus deployment — no new environment variables are required

### Requirement 22: Loaner Keeper Business Rules

**User Story:** As a developer, I want consistent business rules for keeper items, so that the loaner status and return date fields stay coherent when gear is marked as kept.

#### Acceptance Criteria

1. WHEN a loaner is created with `is_loaner` set to `false`, THE Review_Tracker_Handler SHALL set `status` to `'kept'` and `expected_return_date` to NULL
2. WHEN an existing loaner is updated with `is_loaner` set to `false`, THE Review_Tracker_Handler SHALL set `status` to `'kept'` and clear `expected_return_date` to NULL
3. WHEN an existing loaner is updated with `status` set to `'returned'` and `actual_return_date` is not provided, THE Review_Tracker_Handler SHALL auto-set `actual_return_date` to the current date (CURRENT_DATE)

### Requirement 23: Review Cascade and Loaner Orphan Behavior

**User Story:** As a developer, I want predictable cascade behavior when a review is deleted, so that notes are cleaned up and loaners are preserved but unlinked.

#### Acceptance Criteria

1. WHEN a review is deleted from `altus_reviews`, THE database SHALL automatically delete all associated rows in `altus_review_notes` via the `ON DELETE CASCADE` foreign key constraint
2. WHEN a review is deleted from `altus_reviews`, THE database SHALL set `review_id` to NULL on all associated rows in `altus_loaners` via the `ON DELETE SET NULL` foreign key constraint
3. THE Review_Tracker_Handler SHALL NOT implement application-level cascade logic — the database foreign key constraints SHALL handle all cascade behavior


### Requirement 24: Source Isolation and Existing Tool Preservation

**User Story:** As a developer, I want the review tracker feature to be additive without modifying existing tools or tables, so that the stable Altus foundation is preserved.

#### Acceptance Criteria

1. THE implementation SHALL NOT modify the handler logic of any existing Altus tools: `search_altwire_archive`, `reingest_altwire_archive`, `get_archive_stats`, `get_content_by_url`, `analyze_coverage_gaps`, `get_altwire_site_analytics`, `get_altwire_traffic_sources`, `get_altwire_top_pages`, `get_altwire_site_search`, `get_altwire_search_performance`, `get_altwire_search_opportunities`, `get_altwire_sitemap_health`, `get_story_opportunities`, `get_news_opportunities`, `get_article_performance`, `get_news_performance_patterns`
2. THE implementation SHALL NOT modify existing database tables: `altus_content`, `altus_embeddings`, `altus_ingest_log`, `altus_article_performance`, `altus_article_assignments`
3. THE implementation SHALL introduce no new npm dependencies — the existing `@anthropic-ai/sdk`, `pg`, `zod`, and `node-cron` packages are sufficient
4. THE implementation SHALL reuse the existing Pool from `lib/altus-db.js` and the existing `safeToolHandler` from `lib/safe-tool-handler.js`
5. THE implementation SHALL reuse the existing `logAiUsage` function from `lib/ai-cost-tracker.js` for Anthropic cost tracking

### Requirement 25: Handler Module Structure

**User Story:** As a developer, I want all review tracker logic consolidated in a single handler module, so that the feature is self-contained and easy to maintain.

#### Acceptance Criteria

1. THE implementation SHALL create a single handler module at `handlers/review-tracker-handler.js` containing all review, loaner, and review note functions
2. THE handler module SHALL import Pool from `lib/altus-db.js` and `logAiUsage` from `lib/ai-cost-tracker.js`
3. THE handler module SHALL import the Anthropic SDK from `@anthropic-ai/sdk` for auto-categorization
4. THE handler module SHALL export all functions needed by the Tool_Registry: `initReviewTrackerSchema`, `createReview`, `updateReview`, `getReview`, `listReviews`, `getUpcomingReviewDeadlines`, `logLoaner`, `updateLoaner`, `getLoaner`, `listLoaners`, `getOverdueLoaners`, `getUpcomingLoanerReturns`, `addReviewNote`, `updateReviewNote`, `listReviewNotes`, `deleteReviewNote`, `getEditorialDigest`
5. THE handler module SHALL use ESM `import`/`export` syntax throughout — no `require()` calls

### Requirement 26: AI Writer Integration Readiness

**User Story:** As a developer, I want the review notes schema designed for future AI Writer consumption, so that no schema changes are needed when the AI Writer feature is built.

#### Acceptance Criteria

1. THE `altus_review_notes` table SHALL store notes with `review_id`, `note_text`, `category`, `created_at`, and `updated_at` columns sufficient for the AI Writer to retrieve and use as structured input
2. THE `altus_list_review_notes` tool SHALL support category-based filtering, so that the AI Writer can request only `pro` notes, only `con` notes, or all notes for a review
3. THE `altus_list_review_notes` tool SHALL return notes in chronological order (`created_at` ascending), so that the AI Writer receives notes in the order they were recorded