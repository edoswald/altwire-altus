# Implementation Plan: Altus HTML Export

## Overview

Extract the inline `markdownToHtml` helper from `handlers/altus-writer.js` into `lib/markdown.js`, add a `getDraftAsHtml` export to the writer handler, and register `get_draft_as_html` as a new MCP tool in `index.js`. Three files touched, no new dependencies, no schema changes. Implementation order: shared module → handler refactor → tool registration → tests.

## Tasks

- [x] 1. Extract `markdownToHtml` into shared module
  - [x] 1.1 Create `lib/markdown.js` with the extracted function
    - Create `lib/markdown.js` as an ESM module
    - Copy the `markdownToHtml(md)` function verbatim from `handlers/altus-writer.js` (lines ~499–545)
    - Export it as a named export: `export function markdownToHtml(md)`
    - The function handles: `#`/`##`/`###` headings, `**bold**`, `*italic*`, `[links](url)`, `- ` unordered lists, `1. ` ordered lists, paragraph wrapping, and null/empty input → `''`
    - No external dependencies — pure regex-based conversion
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [x] 1.2 Refactor `handlers/altus-writer.js` to use the shared module
    - Add `import { markdownToHtml } from '../lib/markdown.js';` to the import block
    - Delete the inline `markdownToHtml` function definition (lines ~495–545, including the comment block)
    - Verify `postToWordPress` still calls `markdownToHtml(assignment.draft_content)` — no call-site changes needed
    - _Requirements: 1.10, 1.11, 1.12_

- [x] 2. Add `getDraftAsHtml` handler and tool registration
  - [x] 2.1 Add `getDraftAsHtml` export to `handlers/altus-writer.js`
    - Add a new exported async function `getDraftAsHtml({ assignment_id })`
    - Fetch assignment via `fetchAssignment(assignment_id)` — return `{ error: 'assignment_not_found' }` if missing
    - If `draft_content` is null, return `{ error: 'no_draft_content', assignment_id, message: '...' }`
    - Parse `outline` JSONB for `title_suggestion`
    - Return `{ success, assignment_id, topic, title_suggestion, html, word_count, instructions }`
    - No status gating — any assignment with a draft is eligible
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 2.2 Register `get_draft_as_html` tool in `index.js`
    - Add `getDraftAsHtml` to the existing writer import block from `./handlers/altus-writer.js`
    - Register via `server.registerTool('get_draft_as_html', ...)` with Zod schema: `assignment_id: z.number().int().positive()`
    - Include `TEST_MODE` mock intercept before `DATABASE_URL` guard, matching existing writer tool pattern
    - Wrap in `safeToolHandler`, return `JSON.stringify(result)` in content array
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Checkpoint — Verify extraction and tool registration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Tests
  - [x]* 4.1 Write property test: markdown-to-HTML tag preservation
    - **Property 1: Markdown-to-HTML tag preservation**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**
    - Use fast-check to generate random markdown with headings, bold, italic, links, and list items
    - Assert output contains corresponding `<h2>`, `<strong>`, `<em>`, `<a href>`, `<ul><li>` tags with original text preserved
    - File: `tests/altus-html-export.property.test.js`

  - [x]* 4.2 Write property test: null and empty input safety
    - **Property 2: Null and empty input safety**
    - **Validates: Requirements 1.9**
    - Generate null, undefined, and empty string inputs via fast-check
    - Assert `markdownToHtml` returns `''` for all
    - File: `tests/altus-html-export.property.test.js`

  - [x]* 4.3 Write property test: extraction equivalence
    - **Property 3: Extraction equivalence (no-regression)**
    - **Validates: Requirements 1.12, 4.3, 4.4**
    - Snapshot the original inline function output for random markdown inputs
    - Assert `lib/markdown.js` output is byte-identical
    - File: `tests/altus-html-export.property.test.js`

  - [x]* 4.4 Write property test: getDraftAsHtml response shape
    - **Property 4: getDraftAsHtml response shape completeness**
    - **Validates: Requirements 2.3**
    - Mock `fetchAssignment` to return assignment objects with non-null `draft_content`
    - Assert response contains all required fields with correct types
    - File: `tests/altus-html-export.property.test.js`

  - [x]* 4.5 Write property test: no status gating
    - **Property 5: No status gating on HTML export**
    - **Validates: Requirements 2.5**
    - Generate all valid assignment statuses via fast-check `constantFrom`
    - Assert `getDraftAsHtml` returns success for each when `draft_content` is non-null
    - File: `tests/altus-html-export.property.test.js`

  - [x]* 4.6 Write unit tests for edge cases and error paths
    - Test `getDraftAsHtml` with null `draft_content` → `no_draft_content` error
    - Test `getDraftAsHtml` with nonexistent `assignment_id` → `assignment_not_found` error
    - Test `markdownToHtml` with a known markdown document → expected HTML snapshot
    - Test `TEST_MODE` mock response shape for `get_draft_as_html`
    - Test `DATABASE_URL` guard returns error
    - File: `tests/altus-html-export.unit.test.js`
    - _Requirements: 2.4, 2.6, 2.7, 2.8, 4.1, 4.2_

- [x] 5. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Three files modified: `lib/markdown.js` (new), `handlers/altus-writer.js` (refactor + new export), `index.js` (new import + tool registration)
- No new npm dependencies, no schema changes, no behavioral changes to existing functions
- Property tests use fast-check with minimum 100 iterations, tagged `Feature: altus-html-export, Property N: description`
