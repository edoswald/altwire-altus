# Bugfix Requirements Document

## Introduction

The `hal-chat-ui` frontend `WriterAssignment` TypeScript type, `AssignmentStatus` union, status constant maps, and several writer components were built speculatively before the `altwire-altus` backend endpoints were finalized. The result is a systematic mismatch: the frontend expects fields that don't exist (`headline`, `headline_options`, `word_count`, `source_query`, `sections`), uses phantom status values (`assigned`, `abandoned`) that the backend never produces, and is missing three real statuses (`needs_revision`, `ready_to_post`, `cancelled`). This causes assignment cards to render with undefined headlines, status dots to fall through to defaults, and the `filterActionNeeded` utility to miss actionable states. Additionally, the backend list endpoint omits `title_suggestion` from the outline JSONB column, which could serve as a display headline when available.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the frontend receives an assignment from `GET /hal/writer/assignments` THEN the system maps the response to a `WriterAssignment` type that expects a `headline` field, but the backend returns `topic` instead — `assignment.headline` is always `undefined`.

1.2 WHEN `WriterAssignmentCard` renders the collapsed row THEN the system displays `assignment.headline_options?.[0] ?? assignment.headline` as the primary label, which resolves to `undefined` because neither `headline_options` nor `headline` exist in the backend response.

1.3 WHEN `WriterStatusBar` renders the action-needed banner THEN the system displays `current.headline` as the assignment label, which is `undefined`.

1.4 WHEN `DraftPreviewPanel` renders the header THEN the system displays `assignment.headline` as the title, which is `undefined`.

1.5 WHEN `DraftPreviewSheet` renders the sticky header THEN the system displays `assignment.headline` as the `<h2>` text, which is `undefined`.

1.6 WHEN `OutlineEditorCard` initializes headline state THEN the system reads `assignment.headline_options?.[0] ?? assignment.headline`, both of which are `undefined`.

1.7 WHEN the frontend `WriterAssignment` type declares `word_count?: number` THEN the system expects a field named `word_count`, but the backend returns `draft_word_count` — word count displays in `OutlineEditorCard` and `DraftPreviewSheet` show nothing.

1.8 WHEN the backend returns an assignment with status `needs_revision`, `ready_to_post`, or `cancelled` THEN the system cannot assign it to the `AssignmentStatus` type because those values are missing from the union.

1.9 WHEN `STATUS_PRIORITY`, `STATUS_COLORS`, or `STATUS_DESCRIPTIONS` are indexed with a real backend status like `needs_revision`, `ready_to_post`, or `cancelled` THEN the system returns `undefined` because those keys don't exist in the maps.

1.10 WHEN `STATUS_PRIORITY`, `STATUS_COLORS`, or `STATUS_DESCRIPTIONS` include entries for `assigned` and `abandoned` THEN the system carries dead entries for statuses the backend never produces.

1.11 WHEN the backend `GET /hal/writer/assignments` endpoint returns results THEN the system does not include `title_suggestion` extracted from the `outline` JSONB column, so the frontend has no headline-quality string to display even when one exists in the database.

### Expected Behavior (Correct)

2.1 WHEN the frontend receives an assignment from `GET /hal/writer/assignments` THEN the system SHALL map the response to a `WriterAssignment` type whose fields match the actual backend columns: `id`, `topic`, `article_type`, `status`, `draft_word_count`, `wp_post_url`, `created_at`, `updated_at`, plus `title_suggestion` when returned.

2.2 WHEN `WriterAssignmentCard` renders the collapsed row THEN the system SHALL display `assignment.title_suggestion ?? assignment.topic` as the primary label.

2.3 WHEN `WriterStatusBar` renders the action-needed banner THEN the system SHALL display `assignment.title_suggestion ?? assignment.topic` as the assignment label.

2.4 WHEN `DraftPreviewPanel` renders the header THEN the system SHALL display `assignment.title_suggestion ?? assignment.topic` as the title.

2.5 WHEN `DraftPreviewSheet` renders the sticky header THEN the system SHALL display `assignment.title_suggestion ?? assignment.topic` as the `<h2>` text.

2.6 WHEN `OutlineEditorCard` initializes THEN the system SHALL use `assignment.topic` as the topic label and SHALL NOT reference `headline_options` or `headline`.

2.7 WHEN the frontend `WriterAssignment` type declares a word count field THEN the system SHALL use the field name `draft_word_count` to match the backend response, and all components displaying word count SHALL reference `draft_word_count`.

2.8 WHEN the backend returns an assignment with any of the 10 valid statuses (`researching`, `outline_ready`, `outline_approved`, `drafting`, `draft_ready`, `fact_checking`, `needs_revision`, `ready_to_post`, `posted`, `cancelled`) THEN the system SHALL accept it as a valid `AssignmentStatus` value.

2.9 WHEN `STATUS_PRIORITY`, `STATUS_COLORS`, and `STATUS_DESCRIPTIONS` are indexed with any valid backend status THEN the system SHALL return a defined value for all 10 statuses.

2.10 WHEN `STATUS_PRIORITY`, `STATUS_COLORS`, and `STATUS_DESCRIPTIONS` are defined THEN the system SHALL NOT contain entries for phantom statuses `assigned` or `abandoned`.

2.11 WHEN the backend `GET /hal/writer/assignments` endpoint returns results THEN the system SHALL include a `title_suggestion` field extracted from `outline->'title_suggestion'` in the SELECT, returning `null` when no outline or title_suggestion exists.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN assignments are fetched via `useWriterAssignments` THEN the system SHALL CONTINUE TO poll every 30 seconds, pause on document hidden, and resume on document visible.

3.2 WHEN `sortAssignments` is called THEN the system SHALL CONTINUE TO sort by status priority first, then by `updated_at` descending within the same priority.

3.3 WHEN `filterActionNeeded` is called THEN the system SHALL CONTINUE TO return assignments with `outline_ready` or `draft_ready` status.

3.4 WHEN `WriterAssignmentCard` is expanded THEN the system SHALL CONTINUE TO show status description text and action buttons for `outline_ready` and `draft_ready` statuses.

3.5 WHEN `WriterTab` renders the assignment list THEN the system SHALL CONTINUE TO show error, loading, and empty states with the same behavior.

3.6 WHEN `DraftPreviewPanel` renders fact-check results THEN the system SHALL CONTINUE TO display the collapsible fact-check section with verified/unverified/disputed badges.

3.7 WHEN `OutlineEditorCard` renders sections THEN the system SHALL CONTINUE TO support reordering, editing, adding, and deleting sections.

3.8 WHEN the backend `GET /hal/writer/assignments/:id` detail endpoint is called THEN the system SHALL CONTINUE TO return `SELECT *` with editorial decisions unchanged.

3.9 WHEN the `WriterAssignmentsResponse` interface is used THEN the system SHALL CONTINUE TO expect `{ assignments: WriterAssignment[], count: number }` as the response shape.

---

## Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type BackendAssignmentResponse
  OUTPUT: boolean
  
  // The bug manifests for ALL assignments because the type mismatch
  // is structural — every response uses field names the frontend
  // doesn't expect. Additionally, assignments with statuses
  // needs_revision, ready_to_post, or cancelled are completely
  // unrepresentable in the current frontend type.
  RETURN TRUE
  // Every backend response triggers the bug because:
  //   - X has 'topic' but frontend expects 'headline'
  //   - X has 'draft_word_count' but frontend expects 'word_count'
  //   - X never has 'headline_options' or 'source_query'
  //   - X.status may be 'needs_revision' | 'ready_to_post' | 'cancelled'
  //     which are not in AssignmentStatus
END FUNCTION
```

```pascal
// Property: Fix Checking — Type Alignment
FOR ALL X WHERE isBugCondition(X) DO
  frontendType ← mapToWriterAssignment(X)
  ASSERT frontendType.topic = X.topic
  ASSERT frontendType.draft_word_count = X.draft_word_count
  ASSERT frontendType.title_suggestion = X.outline->title_suggestion OR NULL
  ASSERT frontendType.status IN {researching, outline_ready, outline_approved,
    drafting, draft_ready, fact_checking, needs_revision, ready_to_post,
    posted, cancelled}
  ASSERT displayLabel(frontendType) = (frontendType.title_suggestion ?? frontendType.topic)
  ASSERT STATUS_COLORS[frontendType.status] IS DEFINED
  ASSERT STATUS_PRIORITY[frontendType.status] IS DEFINED
END FOR
```

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
// Note: Since isBugCondition returns TRUE for all inputs (structural mismatch),
// preservation is verified through regression prevention clauses 3.1–3.9 above,
// ensuring that behavioral contracts (polling, sorting, filtering, UI states)
// remain identical after the type realignment.
```
