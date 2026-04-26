# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Writer Type Field & Status Mismatch
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the structural type mismatch between frontend and backend
  - **Scoped PBT Approach**: Generate mock backend responses matching the real `altus_assignments` schema and verify the frontend type system, constant maps, and display label logic handle them correctly
  - **Test file**: `hal-chat-ui/src/__tests__/writer-type-bug-condition.property.test.ts`
  - **Test runner**: `vitest --run` from `hal-chat-ui/`
  - **Uses**: `fast-check` (already installed in hal-chat-ui)
  - Property 1a — Field alignment: Generate backend responses with `topic` (string), `draft_word_count` (number|null), `title_suggestion` (string|null), and assert the current `WriterAssignment` type maps them correctly. On unfixed code, `headline` is undefined because backend sends `topic`, `word_count` is undefined because backend sends `draft_word_count`, and `title_suggestion` doesn't exist on the type.
  - Property 1b — Status completeness: Generate statuses from the backend's full CHECK constraint set (`researching`, `outline_ready`, `outline_approved`, `drafting`, `draft_ready`, `fact_checking`, `needs_revision`, `ready_to_post`, `posted`, `cancelled`) and assert `STATUS_PRIORITY[status]` and `STATUS_COLORS[status]` return defined values. On unfixed code, `needs_revision`, `ready_to_post`, and `cancelled` return `undefined`.
  - Property 1c — Display label: For any assignment, assert `displayLabel(assignment)` equals `title_suggestion ?? topic` and is never `undefined`. On unfixed code, components read `headline` which is always `undefined`.
  - Property 1d — No phantom statuses: Assert `STATUS_PRIORITY` and `STATUS_COLORS` do NOT contain keys `assigned` or `abandoned`. On unfixed code, both phantom statuses exist.
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Document counterexamples found (e.g., `STATUS_PRIORITY["needs_revision"]` is `undefined`, display label resolves to `undefined`)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Sort, Filter, and Response Shape Behavior
  - **IMPORTANT**: Follow observation-first methodology
  - **Test file**: `hal-chat-ui/src/__tests__/writer-type-preservation.property.test.ts`
  - **Test runner**: `vitest --run` from `hal-chat-ui/`
  - **Uses**: `fast-check` (already installed in hal-chat-ui)
  - Observe: `sortAssignments([{status:'outline_ready', updated_at:'2025-01-02'}, {status:'draft_ready', updated_at:'2025-01-01'}])` returns outline_ready first (priority 0 < 1) on unfixed code
  - Observe: `sortAssignments([{status:'drafting', updated_at:'2025-01-02'}, {status:'drafting', updated_at:'2025-01-01'}])` returns newer first within same priority on unfixed code
  - Observe: `filterActionNeeded([...mixed statuses...])` returns only `outline_ready` and `draft_ready` on unfixed code
  - Observe: `getStatusColor('outline_ready')` returns `'bg-amber-500'` on unfixed code
  - Property 2a — Sort ordering: For all arrays of assignments with the 7 statuses that exist in BOTH old and new maps (`researching`, `outline_ready`, `outline_approved`, `drafting`, `draft_ready`, `fact_checking`, `posted`), `sortAssignments` produces the same relative ordering by priority-then-date
  - Property 2b — Filter invariant: For all arrays of assignments with any status, `filterActionNeeded` returns exactly the subset where `status === 'outline_ready' || status === 'draft_ready'`
  - Property 2c — Response shape: `WriterAssignmentsResponse` expects `{ assignments: WriterAssignment[], count: number }` — verify the shape contract holds
  - Property 2d — getStatusColor determinism: For all statuses in the current union, `getStatusColor` returns a non-empty string
  - Verify tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.2, 3.3, 3.4, 3.9_

- [x] 3. Fix writer type alignment across frontend and backend

  - [x] 3.1 Add `title_suggestion` extraction to backend list endpoint
    - In `altwire-altus/index.js`, modify the `GET /hal/writer/assignments` SELECT to include `outline->'title_suggestion' AS title_suggestion`
    - This extracts the JSONB field, returning `null` when no outline or title_suggestion exists
    - Do NOT change the detail endpoint (`GET /hal/writer/assignments/:id`) — it already returns `SELECT *`
    - _Bug_Condition: isBugCondition(input) — backend list query omits title_suggestion from outline JSONB_
    - _Expected_Behavior: Backend returns title_suggestion field for every assignment_
    - _Preservation: Detail endpoint unchanged (Requirement 3.8)_
    - _Requirements: 2.11_

  - [x] 3.2 Update `AssignmentStatus` union and `WriterAssignment` interface
    - In `hal-chat-ui/src/types/writer.ts`:
    - Remove `assigned` and `abandoned` from `AssignmentStatus` union
    - Add `needs_revision`, `ready_to_post`, and `cancelled` to `AssignmentStatus` union
    - Final union: `researching | outline_ready | outline_approved | drafting | draft_ready | fact_checking | needs_revision | ready_to_post | posted | cancelled`
    - Remove fields: `headline`, `headline_options`, `source_query`, `sections`, `word_count`
    - Add fields: `title_suggestion?: string | null`, `article_type: string`, `wp_post_url?: string | null`
    - Rename: `word_count` → `draft_word_count?: number | null`
    - Keep: `draft_content`, `fact_check_results` (returned by detail endpoint)
    - Remove `OutlineSection` interface export (no longer needed on list response; OutlineEditorCard will define its own local type)
    - _Bug_Condition: Frontend type expects fields that don't exist and uses phantom statuses_
    - _Expected_Behavior: Type fields match actual backend columns; all 10 real statuses representable_
    - _Preservation: WriterAssignmentsResponse shape unchanged (Requirement 3.9)_
    - _Requirements: 2.1, 2.7, 2.8, 2.10_

  - [x] 3.3 Update `STATUS_PRIORITY`, `STATUS_COLORS`, and utility functions
    - In `hal-chat-ui/src/types/writer.ts`:
    - `STATUS_PRIORITY`: Remove `assigned` (6) and `abandoned` (8). Add `needs_revision: 2`, `ready_to_post: 6`, `cancelled: 9`. Renumber to maintain logical ordering.
    - `STATUS_COLORS`: Remove `assigned` and `abandoned`. Add `needs_revision: 'bg-amber-500'`, `ready_to_post: 'bg-green-500'`, `cancelled: 'bg-red-500'`.
    - `sortAssignments` and `filterActionNeeded` logic stays the same — only the maps they index change
    - `formatOutlineApproval`: Update parameter name from `headline` to `topic` (or keep as-is if the message format is independent)
    - _Bug_Condition: STATUS maps have phantom entries and miss real statuses_
    - _Expected_Behavior: All 10 statuses have defined priority and color; no phantom entries_
    - _Preservation: Sort and filter logic unchanged (Requirements 3.2, 3.3)_
    - _Requirements: 2.9, 2.10_

  - [x] 3.4 Update `WriterAssignmentCard` component
    - In `hal-chat-ui/src/components/writer/WriterAssignmentCard.tsx`:
    - Replace `assignment.headline_options?.[0] ?? assignment.headline` with `assignment.title_suggestion ?? assignment.topic`
    - Update `STATUS_DESCRIPTIONS`: Remove `assigned` and `abandoned`. Add `needs_revision: 'Needs revision'`, `ready_to_post: 'Ready to post'`, `cancelled: 'Cancelled'`.
    - Remove the expanded headline_options `<ul>` section
    - Remove the expanded sections `<ol>` section (sections not on list response)
    - Remove `OutlineSection` import if present
    - _Bug_Condition: Component reads headline/headline_options which are undefined_
    - _Expected_Behavior: Displays title_suggestion ?? topic as label_
    - _Preservation: Expanded view still shows status description and action buttons (Requirement 3.4)_
    - _Requirements: 2.2_

  - [x] 3.5 Update `WriterStatusBar` component
    - In `hal-chat-ui/src/components/writer/WriterStatusBar.tsx`:
    - Replace `current.headline` with `current.title_suggestion ?? current.topic`
    - _Bug_Condition: Component reads headline which is undefined_
    - _Expected_Behavior: Displays title_suggestion ?? topic as label_
    - _Requirements: 2.3_

  - [x] 3.6 Update `DraftPreviewPanel` component
    - In `hal-chat-ui/src/components/writer/DraftPreviewPanel.tsx`:
    - Replace `assignment.headline` with `assignment.title_suggestion ?? assignment.topic` in the header `<h2>`
    - Replace `assignment.word_count` with `assignment.draft_word_count` in the word count badge
    - Replace `assignment.headline` in footer button `onSend` calls with `assignment.title_suggestion ?? assignment.topic`
    - Remove `sections` usage from the regenerate mode (sections not on list response — regenerate mode may need to be gated on detail data or removed)
    - _Bug_Condition: Component reads headline and word_count which are undefined_
    - _Expected_Behavior: Displays title_suggestion ?? topic and draft_word_count_
    - _Preservation: Fact-check display unchanged (Requirement 3.6)_
    - _Requirements: 2.4, 2.7_

  - [x] 3.7 Update `DraftPreviewSheet` component
    - In `hal-chat-ui/src/components/writer/DraftPreviewSheet.tsx`:
    - Replace `assignment.headline` with `assignment.title_suggestion ?? assignment.topic` in the `<h2>`
    - Replace `assignment.word_count` with `assignment.draft_word_count` in the word count span
    - _Bug_Condition: Component reads headline and word_count which are undefined_
    - _Expected_Behavior: Displays title_suggestion ?? topic and draft_word_count_
    - _Requirements: 2.5, 2.7_

  - [x] 3.8 Update `OutlineEditorCard` component
    - In `hal-chat-ui/src/components/writer/OutlineEditorCard.tsx`:
    - Replace `assignment.headline_options?.[0] ?? assignment.headline` with `assignment.topic` for headline initialization
    - Replace `assignment.word_count` with `assignment.draft_word_count` for word count display
    - Remove headline radio button fieldset (headline_options no longer exists)
    - Replace `assignment.headline` in reject/regenerate `onSend` calls with `assignment.topic`
    - Define a local `OutlineSection` interface within the component (or import from a shared local type) since it's removed from the main writer types
    - _Bug_Condition: Component reads headline_options, headline, and word_count which are undefined_
    - _Expected_Behavior: Uses topic as label, draft_word_count for word count_
    - _Preservation: Section reordering, editing, adding, deleting unchanged (Requirement 3.7)_
    - _Requirements: 2.6, 2.7_

  - [x] 3.9 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Writer Type Field & Status Mismatch
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run `vitest --run writer-type-bug-condition` from `hal-chat-ui/`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11_

  - [x] 3.10 Verify preservation tests still pass
    - **Property 2: Preservation** - Sort, Filter, and Response Shape Behavior
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run `vitest --run writer-type-preservation` from `hal-chat-ui/`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all preservation tests still pass after fix (no regressions)
    - _Requirements: 3.2, 3.3, 3.4, 3.9_

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `vitest --run` from `hal-chat-ui/` to confirm all tests pass (bug condition + preservation + any existing tests)
  - Run `vitest --run` from `altwire-altus/` to confirm existing backend tests still pass
  - Ensure all tests pass, ask the user if questions arise.
