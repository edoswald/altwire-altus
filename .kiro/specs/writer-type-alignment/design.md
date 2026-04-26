# Writer Type Alignment Bugfix Design

## Overview

The `hal-chat-ui` frontend writer module was built speculatively before the `altwire-altus` backend was finalized, producing a systematic type mismatch across the entire writer feature. The `WriterAssignment` interface expects fields that don't exist (`headline`, `headline_options`, `word_count`, `source_query`, `sections`), uses phantom statuses (`assigned`, `abandoned`), and is missing three real statuses (`needs_revision`, `ready_to_post`, `cancelled`). The backend list endpoint also omits `title_suggestion` from the `outline` JSONB column, leaving the frontend with no headline-quality string even when one exists in the database.

The fix is a clean break: restructure the frontend types to match the actual backend schema, update all 6+ components that reference stale field names, expand the status union and constant maps to cover all 10 real statuses, and add `title_suggestion` extraction to the backend list query. No backward compatibility is needed since the old types never worked against real data.

## Glossary

- **Bug_Condition (C)**: The structural type mismatch between the frontend `WriterAssignment` interface and the actual backend `altus_assignments` table columns — every assignment response triggers the bug because field names, status values, and available fields diverge
- **Property (P)**: After the fix, every field on the frontend type corresponds to an actual backend column (or a derived field like `title_suggestion`), all 10 real statuses are representable, and all status constant maps return defined values for every valid status
- **Preservation**: Polling cadence, sort/filter logic, expanded card behavior, error/loading/empty states, fact-check display, section editing, detail endpoint, and response shape must remain identical
- **`WriterAssignment`**: The TypeScript interface in `hal-chat-ui/src/types/writer.ts` that models a single assignment from the backend
- **`AssignmentStatus`**: The TypeScript string union in `hal-chat-ui/src/types/writer.ts` that enumerates valid assignment statuses
- **`altus_assignments`**: The PostgreSQL table in `altwire-altus` that stores writer assignments with a CHECK constraint on the `status` column
- **`title_suggestion`**: A string field inside the `outline` JSONB column, generated during outline creation, suitable as a display headline

## Bug Details

### Bug Condition

The bug manifests for every assignment returned by `GET /hal/writer/assignments`. The frontend `WriterAssignment` type expects fields (`headline`, `headline_options`, `word_count`, `source_query`, `sections`) that the backend never returns on the list endpoint, uses status values (`assigned`, `abandoned`) the backend never produces, and is missing three statuses (`needs_revision`, `ready_to_post`, `cancelled`) that the backend does produce. Additionally, the backend list query omits `title_suggestion` from the `outline` JSONB column.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type BackendAssignmentResponse
  OUTPUT: boolean

  // Structural mismatch — every response triggers the bug:
  //   1. Backend returns 'topic', frontend expects 'headline'
  //   2. Backend returns 'draft_word_count', frontend expects 'word_count'
  //   3. Backend never returns 'headline_options' or 'source_query'
  //   4. Backend may return status IN {'needs_revision','ready_to_post','cancelled'}
  //      which are not in the frontend AssignmentStatus union
  //   5. Backend list query omits outline->title_suggestion

  RETURN TRUE
END FUNCTION
```

### Examples

- **Assignment with `topic = "Radiohead reissue"` and no outline**: Frontend renders `undefined` as the card label because it reads `assignment.headline` which doesn't exist. After fix: renders `"Radiohead reissue"` via `assignment.topic`.
- **Assignment with `outline.title_suggestion = "Inside Radiohead's Kid A Reissue"`**: Frontend still renders `undefined` because the list endpoint doesn't return `title_suggestion` and the type doesn't have the field. After fix: backend returns `title_suggestion`, frontend renders `"Inside Radiohead's Kid A Reissue"` via `assignment.title_suggestion ?? assignment.topic`.
- **Assignment with `status = "needs_revision"`**: Frontend TypeScript compiler rejects the value (not in `AssignmentStatus` union), status dot color falls through to undefined, `STATUS_PRIORITY` returns undefined breaking sort order. After fix: `needs_revision` is a valid status with defined color and priority.
- **Assignment with `draft_word_count = 1200`**: Frontend reads `assignment.word_count` which is `undefined`, so `DraftPreviewSheet` and `OutlineEditorCard` show no word count. After fix: reads `assignment.draft_word_count` correctly.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `useWriterAssignments` polling every 30 seconds, pausing on document hidden, resuming on visible
- `sortAssignments` sorting by status priority first, then `updated_at` descending
- `filterActionNeeded` returning only `outline_ready` and `draft_ready` assignments
- `WriterAssignmentCard` expanded view showing status description and action buttons
- `WriterTab` error, loading, and empty states rendering identically
- `DraftPreviewPanel` collapsible fact-check section with verified/unverified/disputed badges
- `OutlineEditorCard` section reordering, editing, adding, and deleting
- `GET /hal/writer/assignments/:id` detail endpoint returning `SELECT *` unchanged
- `WriterAssignmentsResponse` shape: `{ assignments: WriterAssignment[], count: number }`

**Scope:**
All behaviors not related to field name mapping, status union completeness, or status constant map coverage should be completely unaffected. This includes:
- Fetch URL, headers, timeout, and error handling in `useWriterAssignments`
- All mouse/touch interactions on writer components
- Draft content rendering via ReactMarkdown
- Outline approval and regeneration message formatting
- Editorial decision logging on the backend

## Hypothesized Root Cause

Based on the bug analysis, the root causes are:

1. **Speculative Frontend Types**: The `WriterAssignment` interface was written before the backend schema was finalized. Fields like `headline`, `headline_options`, `source_query`, and `sections` were assumed but never materialized in the backend list endpoint response.

2. **Field Name Divergence**: The backend uses `draft_word_count` (matching the DB column) while the frontend assumed `word_count`. The backend uses `topic` as the primary text field while the frontend assumed `headline`.

3. **Incomplete Status Union**: The frontend `AssignmentStatus` union includes `assigned` and `abandoned` (never produced by the backend) and omits `needs_revision`, `ready_to_post`, and `cancelled` (produced by the backend's CHECK constraint).

4. **Missing JSONB Extraction in List Query**: The backend list endpoint (`GET /hal/writer/assignments`) uses a fixed SELECT of scalar columns and does not extract `title_suggestion` from the `outline` JSONB column, even though `generateOutline` stores it there and `getDraftAsHtml` already reads it.

## Correctness Properties

Property 1: Bug Condition - Type Field Alignment

_For any_ backend assignment response, the fixed `WriterAssignment` interface SHALL contain only fields that exist in the backend response (`id`, `topic`, `article_type`, `status`, `draft_word_count`, `wp_post_url`, `created_at`, `updated_at`, `title_suggestion`), and all display components SHALL render `title_suggestion ?? topic` as the primary label instead of `headline`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**

Property 2: Bug Condition - Status Completeness

_For any_ assignment with a status value from the backend's CHECK constraint (`researching`, `outline_ready`, `outline_approved`, `drafting`, `draft_ready`, `fact_checking`, `needs_revision`, `ready_to_post`, `posted`, `cancelled`), the fixed `AssignmentStatus` union SHALL accept the value, and `STATUS_PRIORITY`, `STATUS_COLORS`, and all status maps SHALL return a defined value.

**Validates: Requirements 2.8, 2.9, 2.10**

Property 3: Preservation - Sort and Filter Behavior

_For any_ array of assignments with valid statuses, the fixed `sortAssignments` function SHALL produce the same relative ordering (by priority then `updated_at`) and `filterActionNeeded` SHALL return the same subset (only `outline_ready` and `draft_ready`) as the original functions would for the same input.

**Validates: Requirements 3.2, 3.3**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `altwire-altus/index.js`

**Endpoint**: `GET /hal/writer/assignments`

**Specific Changes**:
1. **Add `title_suggestion` extraction**: Modify the SELECT to include `outline->'title_suggestion' AS title_suggestion` so the list endpoint returns a headline-quality string when available. This uses the JSONB `->` operator which returns a JSON value (text in this case) or `null` if the key doesn't exist.

---

**File**: `hal-chat-ui/src/types/writer.ts`

**Type**: `AssignmentStatus`, `WriterAssignment`, constant maps

**Specific Changes**:
1. **Update `AssignmentStatus` union**: Remove `assigned` and `abandoned`. Add `needs_revision`, `ready_to_post`, and `cancelled`. Final union: `researching | outline_ready | outline_approved | drafting | draft_ready | fact_checking | needs_revision | ready_to_post | posted | cancelled`.
2. **Restructure `WriterAssignment` interface**: Remove `headline`, `headline_options`, `source_query`, `sections`, `word_count`. Add `title_suggestion?: string | null`, `article_type: string`, `wp_post_url?: string | null`. Rename `word_count` to `draft_word_count`. Keep `draft_content` and `fact_check_results` (returned by detail endpoint).
3. **Update `STATUS_PRIORITY`**: Remove `assigned` (6) and `abandoned` (8). Add `needs_revision: 2`, `ready_to_post: 6`, `cancelled: 9`. Renumber to maintain logical ordering.
4. **Update `STATUS_COLORS`**: Remove `assigned` and `abandoned`. Add `needs_revision: 'bg-amber-500'`, `ready_to_post: 'bg-green-500'`, `cancelled: 'bg-red-500'`.
5. **Remove `OutlineSection` interface**: No longer needed since `sections` is removed from `WriterAssignment` (sections come from the detail endpoint's full `outline` JSONB, not the list endpoint).

---

**File**: `hal-chat-ui/src/components/writer/WriterAssignmentCard.tsx`

**Specific Changes**:
1. **Fix primary label**: Replace `assignment.headline_options?.[0] ?? assignment.headline` with `assignment.title_suggestion ?? assignment.topic`.
2. **Update `STATUS_DESCRIPTIONS`**: Remove `assigned` and `abandoned` entries. Add `needs_revision: 'Needs revision'`, `ready_to_post: 'Ready to post'`, `cancelled: 'Cancelled'`.
3. **Remove headline_options rendering**: Delete the expanded section that iterates `assignment.headline_options`.
4. **Remove sections rendering**: Delete the expanded section that iterates `assignment.sections` (this data isn't on the list response).

---

**File**: `hal-chat-ui/src/components/writer/WriterStatusBar.tsx`

**Specific Changes**:
1. **Fix label**: Replace `current.headline` with `current.title_suggestion ?? current.topic`.

---

**File**: `hal-chat-ui/src/components/writer/DraftPreviewPanel.tsx`

**Specific Changes**:
1. **Fix header title**: Replace `assignment.headline` with `assignment.title_suggestion ?? assignment.topic`.
2. **Fix word count**: Replace `assignment.word_count` with `assignment.draft_word_count`.
3. **Fix action button text**: Replace `assignment.headline` references in `onSend` calls with `assignment.title_suggestion ?? assignment.topic`.

---

**File**: `hal-chat-ui/src/components/writer/DraftPreviewSheet.tsx`

**Specific Changes**:
1. **Fix header title**: Replace `assignment.headline` with `assignment.title_suggestion ?? assignment.topic`.
2. **Fix word count**: Replace `assignment.word_count` with `assignment.draft_word_count`.

---

**File**: `hal-chat-ui/src/components/writer/OutlineEditorCard.tsx`

**Specific Changes**:
1. **Fix headline initialization**: Replace `assignment.headline_options?.[0] ?? assignment.headline` with `assignment.topic` (outline editor works with the topic, not a display headline).
2. **Fix word count**: Replace `assignment.word_count` with `assignment.draft_word_count`.
3. **Remove headline radio buttons**: The `headlines` array and radio fieldset reference `headline_options` which no longer exists. Remove or replace with a simple topic display.
4. **Fix reject/regenerate messages**: Replace `assignment.headline` references with `assignment.topic`.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior. Because `isBugCondition` returns `TRUE` for all inputs (structural mismatch), preservation is verified through behavioral regression tests on sort, filter, polling, and UI state logic.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that create mock backend responses matching the actual `altus_assignments` schema and pass them through the current frontend type system and components. Run these tests on the UNFIXED code to observe failures.

**Test Cases**:
1. **Field Mapping Test**: Create a backend response with `topic: "Test"` and no `headline` field, pass to `WriterAssignmentCard` — observe that the label renders as `undefined` (will fail on unfixed code)
2. **Word Count Test**: Create a response with `draft_word_count: 1200` and no `word_count`, render `DraftPreviewSheet` — observe word count displays nothing (will fail on unfixed code)
3. **Unknown Status Test**: Create a response with `status: "needs_revision"`, pass through `STATUS_PRIORITY` — observe `undefined` return (will fail on unfixed code)
4. **Title Suggestion Test**: Query `GET /hal/writer/assignments` for an assignment with an outline containing `title_suggestion` — observe the field is absent from the response (will fail on unfixed code)

**Expected Counterexamples**:
- Components render `undefined` for headline/label text
- `STATUS_PRIORITY["needs_revision"]` returns `undefined`, breaking sort
- `STATUS_COLORS["needs_revision"]` returns `undefined`, breaking status dot rendering
- Backend response lacks `title_suggestion` even when outline JSONB contains it

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds (all inputs), the fixed types and components produce correct behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  frontendType := mapToWriterAssignment(input)
  ASSERT frontendType.topic = input.topic
  ASSERT frontendType.draft_word_count = input.draft_word_count
  ASSERT frontendType.title_suggestion = input.outline->title_suggestion OR NULL
  ASSERT frontendType.status IN ALL_10_VALID_STATUSES
  ASSERT STATUS_COLORS[frontendType.status] IS DEFINED
  ASSERT STATUS_PRIORITY[frontendType.status] IS DEFINED
  ASSERT displayLabel(frontendType) = (frontendType.title_suggestion ?? frontendType.topic)
END FOR
```

### Preservation Checking

**Goal**: Verify that behavioral contracts (sorting, filtering, polling, UI states) remain identical after the type realignment.

**Pseudocode:**
```
FOR ALL assignments WHERE status IN ALL_10_VALID_STATUSES DO
  ASSERT sortAssignments_fixed(assignments) has same relative order as sortAssignments_original(assignments)
  ASSERT filterActionNeeded_fixed(assignments) = filterActionNeeded_original(assignments)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many random assignment arrays with varied statuses and timestamps
- It catches edge cases in sort stability and filter boundary conditions
- It provides strong guarantees that sort/filter behavior is unchanged across the expanded status set

**Test Plan**: Observe behavior on UNFIXED code first for sort and filter with the 9 original statuses, then write property-based tests capturing that behavior and extending to all 10 statuses.

**Test Cases**:
1. **Sort Preservation**: Generate random assignment arrays, verify `sortAssignments` produces the same priority-then-date ordering after the status map changes
2. **Filter Preservation**: Generate random assignment arrays, verify `filterActionNeeded` still returns only `outline_ready` and `draft_ready` assignments
3. **Response Shape Preservation**: Verify `WriterAssignmentsResponse` still expects `{ assignments, count }`

### Unit Tests

- Test that `WriterAssignment` type accepts all 10 valid backend statuses and rejects invalid ones
- Test that `STATUS_PRIORITY` has entries for all 10 statuses and no phantom statuses
- Test that `STATUS_COLORS` has entries for all 10 statuses and no phantom statuses
- Test that `WriterAssignmentCard` renders `title_suggestion ?? topic` as the label
- Test that `DraftPreviewSheet` renders `draft_word_count` for word count display
- Test that the backend list query includes `title_suggestion` in the SELECT

### Property-Based Tests

- Generate random backend responses with all 10 statuses and verify every status maps to a defined priority and color
- Generate random assignment arrays and verify `sortAssignments` maintains priority-then-date ordering with the expanded status set
- Generate random assignments with/without `title_suggestion` and verify display label resolves correctly (`title_suggestion ?? topic`, never `undefined`)

### Integration Tests

- Test full fetch → render cycle: mock `GET /hal/writer/assignments` with real-shaped data, verify `WriterTab` renders assignment cards with correct labels
- Test status banner: mock assignments with `outline_ready` status, verify `WriterStatusBar` shows `title_suggestion ?? topic`
- Test draft preview flow: mock assignment with `draft_word_count` and `draft_content`, verify `DraftPreviewSheet` displays both correctly
