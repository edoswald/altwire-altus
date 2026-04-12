# Implementation Plan: Altus AI Writer Pipeline

## Overview

Multi-step AI Writer pipeline adding a unified AI generation abstraction (`lib/writer-client.js`), a pipeline handler (`handlers/altus-writer.js`) with 9 exported functions + `initWriterSchema` + `markdownToHtml` helper, 9 MCP tools, 2 REST endpoint migrations, and an `openai` optional dependency. All code follows established Altus patterns: ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `DATABASE_URL` guards, `server.registerTool()`, `altus_` table prefix. Implementation order respects dependency chain: schema → writer-client → handler → tool registrations → REST endpoints → tests.

## Tasks

- [x] 1. Create Writer Client abstraction layer (`lib/writer-client.js`)
  - [x] 1.1 Create `lib/writer-client.js` with provider detection and Anthropic path
    - Create the module with ESM imports: `Anthropic` from `@anthropic-ai/sdk`, `logAiUsage` from `./ai-cost-tracker.js`, `logger` from `../logger.js`
    - Export `async function generate({ toolName, system, prompt, maxTokens = 4000, webSearch = false, jsonMode = false })`
    - Read `ALTUS_WRITER_MODEL` env var, default to `claude-sonnet-4-5`
    - Provider detection: model starts with `gpt-`, `o1`, or `o3` → OpenAI; all else → Anthropic
    - Anthropic path: call `anthropic.messages.create()` with model, system, messages, max_tokens
    - When `webSearch` is true: include `tools: [{ type: 'web_search_20250305', name: 'web_search' }]`
    - When `jsonMode` is true: append `"\n\nRespond with valid JSON only."` to system prompt
    - Extract text from `response.content[0].text`, return as plain string
    - After success: call `logAiUsage(toolName, response.model, { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens })` — catch and log failures, never propagate
    - On API error: `throw new Error('writer-client [anthropic]: ${err.message}')`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.10, 15.11, 15.12, 15.13_

  - [x] 1.2 Add OpenAI lazy-import path to `generate()`
    - Inside the OpenAI branch of `generate()`: `const { default: OpenAI } = await import('openai')`
    - Instantiate `new OpenAI()` inside the function — never at module top level
    - Call `openai.chat.completions.create()` with model, messages (system + user), max_tokens
    - When `webSearch` is true: include `tools: [{ type: 'web_search_preview' }]`
    - When `jsonMode` is true: set `response_format: { type: 'json_object' }`
    - Extract text from `response.choices[0].message.content`, return as plain string
    - Normalize OpenAI tokens: `{ input_tokens: response.usage.prompt_tokens, output_tokens: response.usage.completion_tokens }` before calling `logAiUsage`
    - On API error: `throw new Error('writer-client [openai]: ${err.message}')`
    - _Requirements: 15.7, 15.8, 15.9, 15.10, 15.11, 15.12, 16.1, 16.2_

  - [ ]* 1.3 Write property tests for provider detection and generate return type
    - **Property 2: Provider detection routes correctly by model name**
    - **Validates: Requirements 15.2, 15.3**
    - **Property 3: Writer_Client generate returns plain string and logs cost**
    - **Validates: Requirements 15.10, 15.11, 16.1, 16.2**
    - **Property 4: Writer_Client error shape is consistent**
    - **Validates: Requirements 15.12**
    - File: `tests/altus-writer.property.test.js`

- [x] 2. Add `openai` optional dependency to `package.json`
  - Add `"openai": "^4.0.0"` to `dependencies` in `package.json`
  - Run `npm install` to update `package-lock.json`
  - _Requirements: 15.7_

- [x] 3. Checkpoint — Verify Writer Client
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Create handler module with schema init and core pipeline functions
  - [x] 4.1 Create `handlers/altus-writer.js` with imports, constants, and `initWriterSchema`
    - Create the handler file with ESM imports: `pool` from `../lib/altus-db.js`, `logger` from `../logger.js`, `{ generate }` from `../lib/writer-client.js`, `{ searchAltwireArchive }` from `./altus-search.js`, `{ buildAuthHeader }` from `../lib/wp-client.js`
    - Implement `initWriterSchema()` with `CREATE TABLE IF NOT EXISTS` for `altus_assignments` and `altus_editorial_decisions` using the exact DDL from the design document
    - Include all CHECK constraints, indexes (`altus_assignments_status_idx`, `altus_assignments_created_idx`, `altus_editorial_decisions_assignment_idx`), and foreign keys as specified
    - Export `initWriterSchema`
    - _Requirements: 1.1–1.7, 2.1–2.5, 20.1–20.9_

  - [x] 4.2 Implement `createAssignment` function
    - `createAssignment({ topic, article_type, review_notes_id })` — INSERT into `altus_assignments` with status `researching`, defaults (`article_type='article'`)
    - Run archive research (`searchAltwireArchive({ query: topic, limit: 10, content_type: 'all' })`) and web research (`generate({ toolName: 'create_article_assignment', webSearch: true, ... })`) in parallel using `Promise.allSettled`
    - Store fulfilled results in `archive_research` / `web_research` columns; store `null` for rejected promises, log errors via `logger.error`
    - Update assignment status to `outline_ready` and `updated_at = NOW()` after both settle
    - Return the full assignment record
    - _Requirements: 3.1–3.10, 14.1–14.6_

  - [x] 4.3 Implement `generateOutline` function
    - `generateOutline({ assignment_id })` — fetch assignment, validate status is `outline_ready`
    - Return `{ error: 'assignment_not_found' }` or `{ error: 'assignment_not_ready_for_outline' }` as appropriate
    - When assignment has `review_notes_id`: fetch associated review notes from `altus_review_notes` and include in prompt context
    - Call `generate({ toolName: 'generate_article_outline', jsonMode: true, ... })` with topic, article_type, archive_research, web_research, and review notes in prompt
    - Parse JSON response, store in `outline` JSONB column (shape: `{ title_suggestion, sections: [{ title, points[] }], angle, estimated_words }`)
    - Return updated assignment record
    - _Requirements: 4.1–4.9_

  - [x] 4.4 Implement `approveOutline` function
    - `approveOutline({ assignment_id, decision, feedback })` — fetch assignment, validate status is `outline_ready`
    - Decision mapping: `approved` → status `outline_approved`; `rejected` → status `cancelled`; `modified` → store feedback in `outline_notes`, keep status `outline_ready`
    - Insert row into `altus_editorial_decisions` with `stage='outline'`, the decision, feedback, and assignment's `topic` and `article_type`
    - Return updated assignment record
    - _Requirements: 5.1–5.11_

  - [x] 4.5 Implement `generateDraft` function
    - `generateDraft({ assignment_id })` — fetch assignment, validate status is `outline_approved`
    - When assignment has `review_notes_id`: fetch review notes and include as product observations in prompt
    - Call `generate({ toolName: 'generate_article_draft', maxTokens: 6000, ... })` with outline, archive_research, web_research, topic, article_type, outline_notes
    - Store markdown draft in `draft_content`, compute word count (`draft.split(/\s+/).filter(Boolean).length`), store in `draft_word_count`
    - Update status to `draft_ready`
    - Return updated assignment record
    - _Requirements: 6.1–6.12_

  - [ ]* 4.6 Write property tests for status guards, approveOutline mapping, and word count
    - **Property 5: Status guards reject wrong-state calls**
    - **Validates: Requirements 4.6, 5.7, 6.8, 7.8, 8.8**
    - **Property 6: approveOutline decision maps to correct status**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - **Property 9: Word count matches draft content**
    - **Validates: Requirements 6.5**
    - **Property 13: createAssignment transitions through researching to outline_ready**
    - **Validates: Requirements 3.1, 3.6, 14.1, 14.6**
    - File: `tests/altus-writer.property.test.js`

- [x] 5. Implement fact-check, WordPress posting, and remaining handler functions
  - [x] 5.1 Implement `factCheckDraft` function
    - `factCheckDraft({ assignment_id })` — fetch assignment, validate status is `draft_ready` or `needs_revision`
    - Call `generate({ toolName: 'fact_check_draft', webSearch: true, jsonMode: true, ... })` for initial fact check
    - Parse results into `{ passed: bool, issues: [{ section, issue, severity }] }`
    - If no issues: store results, set status to `ready_to_post`
    - If issues found: call `generate()` to regenerate flagged sections, update `draft_content`, call `generate()` for re-check, store final results, set status to `ready_to_post` regardless of re-check outcome
    - Bounded to at most 3 `generate()` calls total (initial check + regeneration + re-check)
    - _Requirements: 7.1–7.12, 18.1–18.4_

  - [x] 5.2 Implement `markdownToHtml` non-exported helper and `postToWordPress` function
    - `markdownToHtml(markdown)` — regex-based converter: `#`/`##`/`###` → `<h1>`–`<h3>`, `**text**` → `<strong>`, `*text*` → `<em>`, `- item` → `<ul><li>`, `1. item` → `<ol><li>`, `[text](url)` → `<a href>`, double newlines → `<p>` blocks
    - `postToWordPress({ assignment_id, title, categories, tags })` — fetch assignment, validate status is `ready_to_post`
    - Convert `draft_content` via `markdownToHtml()`, POST to WordPress REST API with `status: 'draft'` (hardcoded, never overridable), using `buildAuthHeader()` for auth
    - Store `wp_post_id` and `wp_post_url` on assignment, set status to `posted`
    - Insert editorial decision with `stage='post'`, `decision='approved'`
    - On WordPress API failure: return `{ error: 'wordpress_post_failed', message }` without changing status
    - _Requirements: 8.1–8.13, 17.1–17.8, 19.1–19.3_

  - [x] 5.3 Implement `logEditorialDecision`, `getAssignment`, and `listAssignments` functions
    - `logEditorialDecision({ assignment_id, stage, decision, feedback })` — fetch assignment for `topic` and `article_type`, INSERT into `altus_editorial_decisions`, return created record
    - `getAssignment({ id })` — SELECT from `altus_assignments` by id, LEFT JOIN `altus_editorial_decisions` ordered by `created_at ASC`, return full record with `decisions` array
    - `listAssignments({ status, article_type, limit, offset })` — SELECT summary fields (`id`, `topic`, `article_type`, `status`, `draft_word_count`, `wp_post_url`, `created_at`, `updated_at`) with optional filters, ORDER BY `created_at DESC`, omit large fields
    - Return `{ assignments: [], count: 0 }` when no matches
    - _Requirements: 9.1–9.8, 10.1–10.6, 11.1–11.9_

  - [ ]* 5.4 Write property tests for fact-check loop, WordPress draft-only, editorial decisions, list filtering, and decision ordering
    - **Property 1: Markdown to HTML conversion preserves content**
    - **Validates: Requirements 17.1–17.7**
    - **Property 7: Fact-check loop is bounded to at most 3 generate calls**
    - **Validates: Requirements 7.5, 18.1, 18.2, 18.3**
    - **Property 8: WordPress posting always creates drafts**
    - **Validates: Requirements 8.4, 19.1, 19.2**
    - **Property 10: Editorial decisions capture assignment context**
    - **Validates: Requirements 5.6, 9.1, 9.4**
    - **Property 11: listAssignments filter correctness and field exclusion**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5**
    - **Property 12: getAssignment returns decisions in chronological order**
    - **Validates: Requirements 10.1, 10.2**
    - File: `tests/altus-writer.property.test.js`

- [x] 6. Checkpoint — Verify all handler functions
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Register 9 MCP tools and schema init in `index.js`
  - [x] 7.1 Add imports and `initWriterSchema` call to `index.js`
    - Import `initWriterSchema`, `createAssignment`, `generateOutline`, `approveOutline`, `generateDraft`, `factCheckDraft`, `postToWordPress`, `logEditorialDecision`, `getAssignment`, `listAssignments` from `./handlers/altus-writer.js`
    - Add `initWriterSchema().catch((err) => { logger.error('Writer schema init failed', { error: err.message }); });` in the `DATABASE_URL` startup block alongside existing schema init calls
    - _Requirements: 1.7, 20.9_

  - [x] 7.2 Register pipeline tools: `create_article_assignment`, `generate_article_outline`, `approve_outline`, `generate_article_draft`, `fact_check_draft`
    - Each tool uses `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper
    - Each tool includes `TEST_MODE` mock data intercept and `DATABASE_URL` guard
    - Zod schemas per design: `topic` as `z.string()`, `assignment_id` as `z.number().int()`, `decision` as `z.enum(['approved','rejected','modified'])`, `feedback` as `z.string().optional()`, `article_type` as `z.enum(['article','review','interview','feature']).default('article')`, `review_notes_id` as `z.number().int().optional()`
    - _Requirements: 3.11, 4.10, 5.11, 6.12, 7.12_

  - [x] 7.3 Register utility tools: `post_to_wordpress`, `log_editorial_decision`, `get_article_assignment`, `list_article_assignments`
    - Each tool uses `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper
    - Each tool includes `TEST_MODE` mock data intercept and `DATABASE_URL` guard
    - `post_to_wordpress`: optional `title`, `categories` (array of strings), `tags` (array of strings)
    - `log_editorial_decision`: required `assignment_id`, `stage` (enum), `decision` (enum); optional `feedback`
    - `get_article_assignment`: required `id` as `z.number().int()`
    - `list_article_assignments`: optional `status`, `article_type`, `limit`, `offset`
    - _Requirements: 8.13, 9.8, 10.6, 11.9_

- [x] 8. Update REST endpoints in `index.js` HTTP server
  - [x] 8.1 Migrate `GET /hal/writer/assignments` to query `altus_assignments`
    - Replace the existing `agent_memory` query with a direct `SELECT id, topic, article_type, status, draft_word_count, wp_post_url, created_at, updated_at FROM altus_assignments` query
    - Accept optional `status` and `article_type` query parameters for filtering
    - Return `{ assignments: [...], count: N }` with summary fields only
    - Retain existing auth, CORS, and OPTIONS preflight handling
    - _Requirements: 12.1–12.6_

  - [x] 8.2 Migrate `GET /hal/writer/assignments/:id` to query `altus_assignments` with joined decisions
    - Replace the existing `agent_memory` query with `SELECT * FROM altus_assignments WHERE id = $1` plus `SELECT * FROM altus_editorial_decisions WHERE assignment_id = $1 ORDER BY created_at ASC`
    - Return full assignment record with `decisions` array
    - Return `{ assignment: null }` when not found (matching existing pattern)
    - Retain existing auth, CORS, and OPTIONS preflight handling
    - _Requirements: 13.1–13.5_

- [ ] 9. Write unit tests
  - [ ]* 9.1 Write unit tests for Writer Client
    - Test provider detection: `claude-sonnet-4-5` → Anthropic, `gpt-4o` → OpenAI, `o1` → OpenAI, `o3-mini` → OpenAI
    - Test `generate()` returns plain string with mocked Anthropic SDK
    - Test `logAiUsage` called after successful generation
    - Test `logAiUsage` failure doesn't block `generate()` response
    - Test OpenAI lazy import (verify no top-level instantiation)
    - Test error shape: `'writer-client [anthropic]: ...'` and `'writer-client [openai]: ...'`
    - File: `tests/altus-writer.unit.test.js`
    - _Requirements: 15.1–15.13, 16.1–16.4_

  - [ ]* 9.2 Write unit tests for handler functions and tool guards
    - Test `TEST_MODE=true` returns mock data for each of the 9 tools
    - Test `DATABASE_URL` not set returns `{ error: 'Database not configured' }` for each tool
    - Test assignment not found returns correct error shape for each pipeline function
    - Test `createAssignment` with and without `review_notes_id`
    - Test `generateOutline` includes review notes in prompt when `review_notes_id` present
    - Test `generateDraft` includes review notes as product observations
    - Test `factCheckDraft` with no issues (single call, `ready_to_post`)
    - Test `factCheckDraft` with issues (regenerate + re-check flow)
    - Test `postToWordPress` stores `wp_post_id` and `wp_post_url`, logs editorial decision
    - Test WordPress API failure doesn't change assignment status
    - Test `listAssignments` with no matches returns `{ assignments: [], count: 0 }`
    - Test `markdownToHtml` converts headings, bold, italic, lists, links, paragraphs
    - File: `tests/altus-writer.unit.test.js`
    - _Requirements: 3.9–3.10, 4.7–4.8, 5.9–5.10, 6.10–6.11, 7.10–7.11, 8.11–8.12, 9.6–9.7, 10.4–10.5, 11.7–11.8, 17.1–17.8_

  - [ ]* 9.3 Write unit tests for REST endpoints
    - Test `GET /hal/writer/assignments` reads from `altus_assignments` (not `agent_memory`)
    - Test `GET /hal/writer/assignments/:id` returns full record with joined decisions
    - Test REST endpoint auth rejection (missing/invalid token)
    - Test REST endpoint assignment not found returns `{ assignment: null }`
    - Test REST endpoint database failure returns 500 with correct error shape
    - File: `tests/altus-writer.unit.test.js`
    - _Requirements: 12.1–12.6, 13.1–13.5_

- [x] 10. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 13 correctness properties from the design document
- Unit tests validate Writer Client, handler logic, TEST_MODE, DATABASE_URL guards, REST endpoints, and error handling
- The handler module uses the Altus `server.registerTool()` pattern (not `server.tool()`)
- Implementation order respects dependency chain: schema → writer-client → handler → tools → REST → tests
- The `openai` package is lazy-imported inside `generate()` — never at module top level
- All AI generation calls route through `writerClient.generate()` — the handler never touches SDKs directly
- WordPress posts are always created as drafts — the `status: 'draft'` is hardcoded and not overridable
