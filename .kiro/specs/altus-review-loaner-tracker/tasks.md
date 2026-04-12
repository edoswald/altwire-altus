# Implementation Plan: Altus Review & Loaner Tracker

## Overview

Additive feature introducing three PostgreSQL tables, one handler module (`handlers/review-tracker-handler.js`), and 16 new MCP tools for review assignment tracking, loaner item management, and structured review note-taking with AI auto-categorization. All code follows established Altus patterns: ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `DATABASE_URL` guards, `altus_` table prefix. No existing tools, tables, or dependencies are modified.

## Tasks

- [x] 1. Create handler module with schema initialization and review CRUD
  - [x] 1.1 Create `handlers/review-tracker-handler.js` with imports, constants, and `initReviewTrackerSchema`
    - Create the handler file with ESM imports: `pool` from `lib/altus-db.js`, `logAiUsage` from `lib/ai-cost-tracker.js`, `Anthropic` from `@anthropic-ai/sdk`, `logger` from `logger.js`
    - Define `VALID_REVIEW_STATUSES` and `VALID_LOANER_STATUSES` and `VALID_NOTE_CATEGORIES` constants
    - Implement `initReviewTrackerSchema()` with `CREATE TABLE IF NOT EXISTS` for `altus_reviews`, `altus_loaners`, `altus_review_notes` using the exact DDL from the design document
    - Include all CHECK constraints, indexes, and foreign keys as specified
    - Export `initReviewTrackerSchema`
    - _Requirements: 1.1–1.5, 2.1–2.5, 3.1–3.5, 4.1–4.2, 25.1–25.3_

  - [x] 1.2 Implement `createReview` and `getReview` functions
    - `createReview({ title, product, reviewer, status, due_date, wp_post_id, notes })` — INSERT into `altus_reviews` with defaults (`reviewer='Derek'`, `status='assigned'`), return `{ review: <row> }`
    - `getReview({ review_id })` — SELECT by id, return `{ review: <row> }` or `{ error: 'review_not_found', review_id }`
    - Format DATE columns as ISO YYYY-MM-DD strings in responses
    - _Requirements: 5.1–5.4, 7.1–7.2, 4.3_

  - [x] 1.3 Implement `updateReview` function
    - `updateReview({ review_id, ...fields })` — dynamic UPDATE with only provided fields, set `updated_at = NOW()`
    - Validate status against `VALID_REVIEW_STATUSES` before updating
    - Return `{ review: <row> }` or `{ error: 'review_not_found', review_id }`
    - _Requirements: 6.1–6.5_

  - [x] 1.4 Implement `listReviews` and `getUpcomingReviewDeadlines` functions
    - `listReviews({ status, reviewer })` — SELECT with optional WHERE clauses, ORDER BY `due_date ASC NULLS LAST`, return `{ reviews, count }`
    - `getUpcomingReviewDeadlines({ days = 7 })` — SELECT where `due_date <= CURRENT_DATE + days` AND status NOT IN (`published`, `cancelled`), ORDER BY `due_date ASC`, return `{ reviews, count }` with optional `note` when empty
    - _Requirements: 8.1–8.5, 9.1–9.5_

  - [ ]* 1.5 Write property tests for review creation defaults and list ordering
    - **Property 1: Review creation preserves input and applies defaults**
    - **Validates: Requirements 5.1, 5.3, 5.4**
    - **Property 5: List reviews filtering invariant**
    - **Validates: Requirements 8.3, 8.4**
    - **Property 6: List reviews ordering**
    - **Validates: Requirements 8.1**
    - File: `tests/review-tracker.property.test.js`

- [x] 2. Implement loaner CRUD and business rules
  - [x] 2.1 Implement `logLoaner` and `getLoaner` functions
    - `logLoaner({ item_name, brand, borrower, is_loaner, expected_return_date, review_id, notes })` — INSERT into `altus_loaners` with defaults (`borrower='Derek'`, `status='out'`)
    - Apply keeper business rule: when `is_loaner=false`, set `status='kept'` and `expected_return_date=NULL`
    - `getLoaner({ loaner_id })` — SELECT by id, return `{ loaner: <row> }` or `{ error: 'loaner_not_found', loaner_id }`
    - _Requirements: 10.1–10.5, 12.1–12.2, 22.1_

  - [x] 2.2 Implement `updateLoaner` function
    - `updateLoaner({ loaner_id, ...fields })` — dynamic UPDATE with only provided fields, set `updated_at = NOW()`
    - Apply keeper rule: `is_loaner=false` → `status='kept'`, clear `expected_return_date`
    - Apply return rule: `status='returned'` without `actual_return_date` → auto-set to `CURRENT_DATE`
    - Return `{ loaner: <row> }` or `{ error: 'loaner_not_found', loaner_id }`
    - _Requirements: 11.1–11.6, 22.2, 22.3_

  - [x] 2.3 Implement `listLoaners`, `getOverdueLoaners`, and `getUpcomingLoanerReturns` functions
    - `listLoaners({ status, borrower })` — SELECT with optional WHERE clauses, ORDER BY `loaned_date DESC`, return `{ loaners, count }`
    - `getOverdueLoaners()` — SELECT where `expected_return_date < CURRENT_DATE` AND `actual_return_date IS NULL` AND `status NOT IN ('returned','kept','lost')`, ORDER BY `expected_return_date ASC`
    - `getUpcomingLoanerReturns({ days = 14 })` — SELECT where `expected_return_date` within next N days, `actual_return_date IS NULL`, `status NOT IN ('kept','lost')`, ORDER BY `expected_return_date ASC`
    - _Requirements: 13.1–13.5, 14.1–14.4, 15.1–15.4_

  - [ ]* 2.4 Write property tests for loaner creation defaults, keeper rule, and filtering
    - **Property 2: Loaner creation defaults and keeper business rule**
    - **Validates: Requirements 10.1, 10.3, 10.4, 10.5, 22.1**
    - **Property 3: Review status validation rejects invalid values**
    - **Validates: Requirements 6.3**
    - **Property 4: Loaner returned status auto-sets actual_return_date**
    - **Validates: Requirements 11.3, 11.4, 22.2, 22.3**
    - **Property 8: List loaners filtering invariant**
    - **Validates: Requirements 13.3, 13.4**
    - **Property 9: List loaners ordering**
    - **Validates: Requirements 13.1**
    - File: `tests/review-tracker.property.test.js`

- [x] 3. Checkpoint — Verify handler module core logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement review notes with auto-categorization
  - [x] 4.1 Implement `autoCategorizNote` internal helper
    - Create the non-exported `autoCategorizNote(noteText)` function using Anthropic SDK
    - Model: `claude-haiku-4-5-20251001`, max_tokens: 10
    - System prompt: `'You are a music gear review classifier. Respond with exactly one word: pro, con, or observation.'`
    - Validate response against `VALID_NOTE_CATEGORIES` (excluding `uncategorized`), fall back to `'uncategorized'` on invalid response or any error
    - Return `{ category, model, usage }` — on failure return zero tokens
    - _Requirements: 21.1–21.4_

  - [x] 4.2 Implement `addReviewNote` function
    - `addReviewNote({ review_id, note_text, category })` — verify review exists first, then INSERT into `altus_review_notes`
    - When `category` not provided: call `autoCategorizNote()`, then `logAiUsage('altus_add_review_note', model, usage)`
    - On categorization failure: proceed with `'uncategorized'`, never block note creation
    - Return `{ note: <row> }` or `{ error: 'review_not_found', review_id }`
    - _Requirements: 16.1–16.6, 21.5_

  - [x] 4.3 Implement `updateReviewNote`, `listReviewNotes`, and `deleteReviewNote` functions
    - `updateReviewNote({ note_id, note_text, category })` — dynamic UPDATE, set `updated_at = NOW()`, return `{ note: <row> }` or `{ error: 'note_not_found', note_id }`
    - `listReviewNotes({ review_id, category })` — SELECT with optional category filter, ORDER BY `created_at ASC`, return `{ notes, count }`
    - `deleteReviewNote({ note_id })` — DELETE, return `{ deleted: true, note_id }` or `{ error: 'note_not_found', note_id }`
    - _Requirements: 17.1–17.4, 18.1–18.4, 19.1–19.2, 26.1–26.3_

  - [ ]* 4.4 Write property tests for note categorization and filtering
    - **Property 7: Upcoming review deadlines filter and ordering**
    - **Validates: Requirements 9.1, 9.3, 9.4**
    - **Property 10: Overdue loaners dynamic computation**
    - **Validates: Requirements 14.1, 14.2, 14.3**
    - **Property 11: Upcoming loaner returns filter**
    - **Validates: Requirements 15.1, 15.3**
    - **Property 12: Review notes category filter**
    - **Validates: Requirements 18.3, 26.2**
    - **Property 13: Review notes chronological ordering**
    - **Validates: Requirements 18.1, 26.3**
    - File: `tests/review-tracker.property.test.js`

- [x] 5. Implement editorial digest
  - [x] 5.1 Implement `getEditorialDigest` function
    - Direct DB queries (not calling other handler functions) to build: `review_pipeline` (status counts), `upcoming_deadlines` (next 7 days), `overdue_loaners`, `loaner_summary` (status counts), `generated_at` ISO timestamp
    - Return empty arrays and zero counts when no data exists
    - _Requirements: 20.1–20.4_

  - [ ]* 5.2 Write property test for editorial digest pipeline counts
    - **Property 14: Editorial digest pipeline counts accuracy**
    - **Validates: Requirements 20.1**
    - File: `tests/review-tracker.property.test.js`

- [x] 6. Checkpoint — Verify all handler functions and property tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Register all 16 MCP tools in index.js
  - [x] 7.1 Add imports and schema init call to `index.js`
    - Import `initReviewTrackerSchema` and all 17 handler functions from `./handlers/review-tracker-handler.js`
    - Add `initReviewTrackerSchema().catch(err => logger.error('Review tracker schema init failed', { error: err.message }))` in the `DATABASE_URL` startup block alongside existing `initSchema` and `initAiUsageSchema` calls
    - _Requirements: 1.6, 24.1–24.5_

  - [x] 7.2 Register review tools: `altus_create_review`, `altus_update_review`, `altus_get_review`, `altus_list_reviews`, `altus_get_upcoming_review_deadlines`
    - Each tool uses `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper
    - Each tool includes `TEST_MODE` mock data intercept and `DATABASE_URL` guard
    - Zod schemas: `due_date` as `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`, `status` as `z.enum([...VALID_REVIEW_STATUSES])`, etc.
    - _Requirements: 5.5–5.7, 6.6–6.8, 7.3–7.5, 8.6–8.8, 9.6–9.8_

  - [x] 7.3 Register loaner tools: `altus_log_loaner`, `altus_update_loaner`, `altus_get_loaner`, `altus_list_loaners`, `altus_get_overdue_loaners`, `altus_get_upcoming_loaner_returns`
    - Each tool uses `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper
    - Each tool includes `TEST_MODE` mock data intercept and `DATABASE_URL` guard
    - _Requirements: 10.6–10.8, 11.7–11.9, 12.3–12.5, 13.6–13.8, 14.5–14.7, 15.5–15.7_

  - [x] 7.4 Register review note tools: `altus_add_review_note`, `altus_update_review_note`, `altus_list_review_notes`, `altus_delete_review_note`
    - Each tool uses `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper
    - Each tool includes `TEST_MODE` mock data intercept and `DATABASE_URL` guard
    - _Requirements: 16.7–16.9, 17.5–17.7, 18.5–18.7, 19.3–19.5_

  - [x] 7.5 Register editorial digest tool: `altus_get_editorial_digest`
    - Uses `server.registerTool()` with `safeToolHandler()` wrapper (no input schema — parameterless)
    - Includes `TEST_MODE` mock data intercept and `DATABASE_URL` guard
    - _Requirements: 20.5–20.7_

- [x] 8. Write unit tests
  - [ ]* 8.1 Write unit tests for TEST_MODE and DATABASE_URL guards
    - Test that each of the 16 tools returns mock data when `TEST_MODE=true`
    - Test that each tool returns `{ error: 'Database not configured' }` when `DATABASE_URL` is unset
    - File: `tests/review-tracker.unit.test.js`
    - _Requirements: 5.5–5.6, 6.6–6.7, 7.3–7.4, 8.6–8.7, 9.6–9.7, 10.6–10.7, 11.7–11.8, 12.3–12.4, 13.6–13.7, 14.5–14.6, 15.5–15.6, 16.7–16.8, 17.5–17.6, 18.5–18.6, 19.3–19.4, 20.5–20.6_

  - [ ]* 8.2 Write unit tests for auto-categorization and error handling
    - Test `autoCategorizNote` with mocked Anthropic SDK: valid response, invalid response, API failure
    - Test `addReviewNote` integration with auto-categorization (mocked): successful categorization, fallback to `'uncategorized'`
    - Test `logAiUsage` is called with correct tool name `'altus_add_review_note'`
    - Test not-found error responses for reviews, loaners, and notes
    - File: `tests/review-tracker.unit.test.js`
    - _Requirements: 21.1–21.5, 16.4–16.6_

- [x] 9. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 14 correctness properties from the design document
- Unit tests validate TEST_MODE, DATABASE_URL guards, auto-categorization, and error handling
- No existing tools, tables, or handler modules are modified (Requirement 24)
- The handler module uses the Altus `server.registerTool()` pattern (not `server.tool()`)
