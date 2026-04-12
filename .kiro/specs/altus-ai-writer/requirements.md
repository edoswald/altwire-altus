# Requirements Document

## Introduction

Add a multi-step AI Writer pipeline to the Altus MCP server, enabling Derek to assign article topics through Hal and have AI generate researched, outlined, drafted, fact-checked, and WordPress-posted content. The pipeline introduces two new database tables (`altus_assignments`, `altus_editorial_decisions`), one new handler module (`handlers/altus-writer.js`), one new abstraction module (`lib/writer-client.js`), nine new MCP tools, two updated REST endpoints, and a markdown-to-HTML converter — all following established Altus patterns (ESM, Zod schemas, `safeToolHandler`, `TEST_MODE` intercepts, `DATABASE_URL` guards, `altus_` table prefix). All AI generation calls route through `lib/writer-client.js` which supports both Anthropic and OpenAI models, controlled by the `ALTUS_WRITER_MODEL` environment variable (default: `claude-sonnet-4-5`). Cost tracking is handled internally by Writer_Client after every `generate()` call. Web research uses the provider-appropriate web search tool (Anthropic or OpenAI, selected automatically by Writer_Client). Archive research calls `searchAltwireArchive()` directly. The pipeline enforces human-in-the-loop approval at the outline stage and posts only WordPress drafts — never published content.

## Glossary

- **Altus**: The AltWire MCP server (`altwire-altus`), exposing tools for AltWire content and editorial operations
- **Writer_Handler**: The handler module (`handlers/altus-writer.js`) containing all AI Writer pipeline business logic
- **Writer_Client**: The `lib/writer-client.js` module providing a unified `generate()` function that routes AI calls to either Anthropic or OpenAI based on `ALTUS_WRITER_MODEL`. The handler never calls Anthropic or OpenAI SDKs directly — it always calls `writerClient.generate()`
- **ALTUS_WRITER_MODEL**: Environment variable controlling which AI model and provider is used for content generation. Default: `claude-sonnet-4-5`. Prefix-based detection: `gpt-*`, `o1`, `o3` → OpenAI; all others → Anthropic. One-line swap: setting `ALTUS_WRITER_MODEL=gpt-4o` switches to OpenAI with no code changes
- **Tool_Registry**: The `index.js` file where MCP tools are registered via `server.registerTool()` and wrapped in `safeToolHandler()`
- **Assignment**: A row in the `altus_assignments` table representing a content assignment progressing through the pipeline
- **Assignment_Pipeline**: The ordered status progression for assignments: `researching` → `outline_ready` → `outline_approved` → `drafting` → `draft_ready` → `fact_checking` → `needs_revision` → `ready_to_post` → `posted` → `cancelled`
- **Editorial_Decision**: A row in the `altus_editorial_decisions` table recording Derek's accept, reject, modify, or cancel decision at a pipeline stage
- **Outline**: A structured JSONB object stored on the assignment with shape `{ title_suggestion, sections: [{ title, points[] }], angle, estimated_words }`
- **Web_Search_Tool**: The provider-appropriate web search tool, handled internally by Writer_Client. Anthropic: `{ type: 'web_search_20250305', name: 'web_search' }`. OpenAI: `{ type: 'web_search_preview' }`. The handler simply passes `webSearch: true` to `writerClient.generate()` and Writer_Client selects the correct tool syntax
- **Archive_Search**: The internal `searchAltwireArchive()` function from `handlers/altus-search.js`, called directly (not via MCP tool) for archive research during assignment creation
- **Fact_Check_Results**: A JSONB object stored on the assignment with shape `{ passed: bool, issues: [{ section, issue, severity }] }`
- **Review_Notes**: Notes from the `altus_review_notes` table linked to an assignment via `review_notes_id` referencing `altus_reviews`, fetched to provide product context during draft generation
- **AI_Cost_Tracker**: The `lib/ai-cost-tracker.js` module that logs AI API calls to the `ai_usage` table via `logAiUsage(toolName, model, inputTokens, outputTokens)`. Cost logging is handled inside Writer_Client after every `generate()` call — the handler does not call `logAiUsage()` directly for generation calls
- **Pool**: The shared PostgreSQL connection pool exported from `lib/altus-db.js`
- **Markdown_Converter**: A simple regex-based function within Writer_Handler that converts markdown draft content to HTML at WordPress post time, with no external library dependency

## Requirements

### Requirement 1: Assignments Database Table

**User Story:** As a developer, I want a dedicated table for article assignments, so that pipeline state, research, outlines, and drafts are stored persistently and queryable.

#### Acceptance Criteria

1. THE Writer_Handler SHALL export an async function `initWriterSchema` that creates the `altus_assignments` table with columns: `id` (SERIAL PRIMARY KEY), `topic` (TEXT NOT NULL), `article_type` (TEXT NOT NULL DEFAULT 'article'), `status` (TEXT NOT NULL DEFAULT 'researching'), `archive_research` (JSONB), `web_research` (TEXT), `review_notes_id` (INTEGER REFERENCES altus_reviews(id) ON DELETE SET NULL), `outline` (JSONB), `outline_notes` (TEXT), `draft_content` (TEXT), `draft_word_count` (INTEGER), `fact_check_results` (JSONB), `wp_post_id` (INTEGER), `wp_post_url` (TEXT), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW())
2. THE `altus_assignments` table `article_type` column SHALL only accept values: `article`, `review`, `interview`, `feature`
3. THE `altus_assignments` table `status` column SHALL only accept values from the Assignment_Pipeline: `researching`, `outline_ready`, `outline_approved`, `drafting`, `draft_ready`, `fact_checking`, `needs_revision`, `ready_to_post`, `posted`, `cancelled`
4. THE `initWriterSchema` function SHALL use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` patterns consistent with existing Altus schema initialization
5. THE `altus_assignments` table SHALL have an index on `status` for efficient pipeline filtering
6. THE `altus_assignments` table SHALL have an index on `created_at` for efficient chronological listing
7. THE `initWriterSchema` function SHALL be called at server startup in `index.js` when `DATABASE_URL` is set, alongside existing schema init calls

### Requirement 2: Editorial Decisions Database Table

**User Story:** As a developer, I want a dedicated table for editorial decisions, so that Derek's approval, rejection, modification, and cancellation actions are logged with full context for audit and pattern analysis.

#### Acceptance Criteria

1. THE `initWriterSchema` function SHALL create the `altus_editorial_decisions` table with columns: `id` (SERIAL PRIMARY KEY), `assignment_id` (INTEGER REFERENCES altus_assignments(id) ON DELETE SET NULL), `stage` (TEXT NOT NULL), `decision` (TEXT NOT NULL), `feedback` (TEXT), `article_type` (TEXT), `topic` (TEXT), `created_at` (TIMESTAMPTZ DEFAULT NOW())
2. THE `altus_editorial_decisions` table `stage` column SHALL only accept values: `outline`, `draft`, `post`, `feedback`
3. THE `altus_editorial_decisions` table `decision` column SHALL only accept values: `approved`, `rejected`, `modified`, `cancelled`
4. THE `altus_editorial_decisions` table SHALL have an index on `assignment_id` for efficient per-assignment decision retrieval
5. THE `altus_editorial_decisions` table `assignment_id` foreign key SHALL use `ON DELETE SET NULL` behavior, so that deleting an assignment preserves the decision history

### Requirement 3: Create Article Assignment Tool

**User Story:** As Derek using Hal, I want to assign a topic for an article, so that AI research begins immediately with parallel archive and web searches.

#### Acceptance Criteria

1. WHEN the `create_article_assignment` tool is called with `topic` and optional `article_type` and `review_notes_id` parameters, THE Writer_Handler SHALL insert a new row into `altus_assignments` with status `researching` and return the created assignment record
2. THE Writer_Handler SHALL run archive research via `searchAltwireArchive({ query: topic, limit: 10, content_type: 'all' })` and web research via `writerClient.generate({ toolName: 'create_article_assignment', webSearch: true, ... })` in parallel using `Promise.allSettled`
3. IF the archive research call succeeds, THEN THE Writer_Handler SHALL store the results in the `archive_research` JSONB column
4. IF the web research call succeeds, THEN THE Writer_Handler SHALL store the text content in the `web_research` TEXT column
5. IF either research call fails, THEN THE Writer_Handler SHALL store `null` for the failed research column and continue without error
6. WHEN both research calls have settled, THE Writer_Handler SHALL update the assignment status to `outline_ready`
7. AI cost logging for the web research call is handled internally by Writer_Client — the handler does not call `logAiUsage()` directly
8. THE `create_article_assignment` tool SHALL accept an optional `review_notes_id` parameter (INTEGER) that references an `altus_reviews` row, linking the assignment to existing review notes
9. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `create_article_assignment` tool SHALL return representative mock data without making database writes or API calls
10. IF the `DATABASE_URL` environment variable is not set, THEN THE `create_article_assignment` tool SHALL return `{ error: 'Database not configured' }`
11. THE Tool_Registry SHALL register `create_article_assignment` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 4: Generate Article Outline Tool

**User Story:** As Derek using Hal, I want AI to generate a structured outline from the research, so that I can review the proposed article structure before committing to a full draft.

#### Acceptance Criteria

1. WHEN the `generate_article_outline` tool is called with an `assignment_id` parameter, THE Writer_Handler SHALL retrieve the assignment and generate a structured outline via `writerClient.generate({ toolName: 'generate_article_outline', jsonMode: true, ... })`
2. THE Writer_Handler SHALL include the assignment's `archive_research`, `web_research`, `topic`, and `article_type` in the prompt context
3. WHEN the assignment has a `review_notes_id`, THE Writer_Handler SHALL fetch the associated review notes from `altus_review_notes` and include them in the prompt context
4. THE Writer_Handler SHALL store the generated outline in the `outline` JSONB column with shape: `{ title_suggestion, sections: [{ title, points[] }], angle, estimated_words }`
5. AI cost logging for the outline generation call is handled internally by Writer_Client — the handler does not call `logAiUsage()` directly
6. IF the assignment status is not `outline_ready`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_ready_for_outline', status: <current_status> }`
7. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
8. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `generate_article_outline` tool SHALL return representative mock data without making database writes or API calls
9. IF the `DATABASE_URL` environment variable is not set, THEN THE `generate_article_outline` tool SHALL return `{ error: 'Database not configured' }`
10. THE Tool_Registry SHALL register `generate_article_outline` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper


### Requirement 5: Approve Outline Tool

**User Story:** As Derek using Hal, I want to approve, reject, or request modifications to a generated outline, so that I maintain editorial control before any full draft is written.

#### Acceptance Criteria

1. WHEN the `approve_outline` tool is called with `assignment_id` and `decision` parameters, THE Writer_Handler SHALL update the assignment status based on the decision and log an editorial decision
2. WHEN the `decision` parameter is `approved`, THE Writer_Handler SHALL set the assignment status to `outline_approved`
3. WHEN the `decision` parameter is `rejected`, THE Writer_Handler SHALL set the assignment status to `cancelled`
4. WHEN the `decision` parameter is `modified`, THE Writer_Handler SHALL store the `feedback` text in the `outline_notes` column and set the assignment status to `outline_ready` so a new outline can be generated
5. THE `approve_outline` tool SHALL accept a required `decision` parameter (one of `approved`, `rejected`, `modified`) and an optional `feedback` parameter (TEXT)
6. THE Writer_Handler SHALL insert a row into `altus_editorial_decisions` with `stage` set to `outline`, the provided `decision`, `feedback`, and the assignment's `topic` and `article_type`
7. IF the assignment status is not `outline_ready`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_ready_for_approval', status: <current_status> }`
8. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
9. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `approve_outline` tool SHALL return representative mock data without making database writes
10. IF the `DATABASE_URL` environment variable is not set, THEN THE `approve_outline` tool SHALL return `{ error: 'Database not configured' }`
11. THE Tool_Registry SHALL register `approve_outline` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 6: Generate Article Draft Tool

**User Story:** As Derek using Hal, I want AI to generate a full article draft from the approved outline, optionally incorporating review notes, so that I get a complete draft ready for fact-checking.

#### Acceptance Criteria

1. WHEN the `generate_article_draft` tool is called with an `assignment_id` parameter, THE Writer_Handler SHALL retrieve the assignment and generate a full markdown draft via `writerClient.generate({ toolName: 'generate_article_draft', maxTokens: 6000, ... })`
2. THE Writer_Handler SHALL include the assignment's `outline`, `archive_research`, `web_research`, `topic`, `article_type`, and `outline_notes` in the prompt context
3. WHEN the assignment has a `review_notes_id`, THE Writer_Handler SHALL fetch the associated review notes from `altus_review_notes` and include them in the prompt context as product observations
4. THE Writer_Handler SHALL store the generated draft in the `draft_content` TEXT column as markdown
5. THE Writer_Handler SHALL compute and store the word count of the generated draft in the `draft_word_count` INTEGER column
6. WHEN the draft is generated, THE Writer_Handler SHALL update the assignment status to `draft_ready`
7. AI cost logging for the draft generation call is handled internally by Writer_Client — the handler does not call `logAiUsage()` directly
8. IF the assignment status is not `outline_approved`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_ready_for_draft', status: <current_status> }`
9. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
10. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `generate_article_draft` tool SHALL return representative mock data without making database writes or API calls
11. IF the `DATABASE_URL` environment variable is not set, THEN THE `generate_article_draft` tool SHALL return `{ error: 'Database not configured' }`
12. THE Tool_Registry SHALL register `generate_article_draft` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 7: Fact Check Draft Tool

**User Story:** As Derek using Hal, I want AI to fact-check the draft and automatically regenerate only the flagged sections, so that factual accuracy is verified without rewriting the entire article.

#### Acceptance Criteria

1. WHEN the `fact_check_draft` tool is called with an `assignment_id` parameter, THE Writer_Handler SHALL retrieve the assignment and run a fact-check pass via `writerClient.generate({ toolName: 'fact_check_draft', webSearch: true, jsonMode: true, ... })`
2. THE Writer_Handler SHALL store the fact-check results in the `fact_check_results` JSONB column with shape: `{ passed: bool, issues: [{ section, issue, severity }] }`
3. WHEN the fact check passes with no issues, THE Writer_Handler SHALL update the assignment status to `ready_to_post`
4. WHEN the fact check identifies issues, THE Writer_Handler SHALL regenerate only the flagged sections using `writerClient.generate()`, update `draft_content` with the corrected text, run one additional fact-check pass, and then set the status to `ready_to_post` regardless of the second pass result
5. THE Writer_Handler SHALL run the fact-check-then-regenerate loop at most once — one initial check, one regeneration of flagged sections, one re-check, then stop
6. THE Writer_Handler SHALL update the `fact_check_results` column with the final fact-check results after any regeneration
7. AI cost logging for each generation call (initial check, regeneration, re-check) is handled internally by Writer_Client — the handler does not call `logAiUsage()` directly
8. IF the assignment status is not `draft_ready` and not `needs_revision`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_ready_for_fact_check', status: <current_status> }`
9. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
10. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `fact_check_draft` tool SHALL return representative mock data without making database writes or API calls
11. IF the `DATABASE_URL` environment variable is not set, THEN THE `fact_check_draft` tool SHALL return `{ error: 'Database not configured' }`
12. THE Tool_Registry SHALL register `fact_check_draft` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 8: Post to WordPress Tool

**User Story:** As Derek using Hal, I want to post the finished draft to WordPress as a draft post, so that the article is ready for final human review in the WordPress editor.

#### Acceptance Criteria

1. WHEN the `post_to_wordpress` tool is called with an `assignment_id` parameter, THE Writer_Handler SHALL retrieve the assignment, convert the `draft_content` from markdown to HTML, and create a WordPress draft post via the WordPress REST API
2. THE Markdown_Converter SHALL convert markdown headings (`#`, `##`, `###`), bold (`**`), italic (`*`), unordered lists (`-`), ordered lists (`1.`), links (`[text](url)`), and paragraphs (double newlines) to their HTML equivalents using regex — no external library dependency
3. THE Writer_Handler SHALL use the `buildAuthHeader()` function from `lib/wp-client.js` for WordPress API authentication
4. THE Writer_Handler SHALL create the WordPress post with `status: 'draft'` — the tool SHALL never publish content directly
5. THE Writer_Handler SHALL store the returned `wp_post_id` and `wp_post_url` on the assignment record
6. WHEN the WordPress post is created, THE Writer_Handler SHALL update the assignment status to `posted`
7. THE Writer_Handler SHALL insert a row into `altus_editorial_decisions` with `stage` set to `post`, `decision` set to `approved`, and the assignment's `topic` and `article_type`
8. IF the assignment status is not `ready_to_post`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_ready_to_post', status: <current_status> }`
9. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
10. IF the WordPress API call fails, THEN THE Writer_Handler SHALL return `{ error: 'wordpress_post_failed', message: <error_message> }` without changing the assignment status
11. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `post_to_wordpress` tool SHALL return representative mock data without making database writes or WordPress API calls
12. IF the `DATABASE_URL` environment variable is not set, THEN THE `post_to_wordpress` tool SHALL return `{ error: 'Database not configured' }`
13. THE Tool_Registry SHALL register `post_to_wordpress` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper


### Requirement 9: Log Editorial Decision Tool

**User Story:** As Derek using Hal, I want to record editorial decisions at any pipeline stage, so that approval and rejection patterns are tracked for future editorial analysis.

#### Acceptance Criteria

1. WHEN the `log_editorial_decision` tool is called with `assignment_id`, `stage`, and `decision` parameters, THE Writer_Handler SHALL insert a row into `altus_editorial_decisions` and return the created decision record
2. THE `log_editorial_decision` tool SHALL accept required parameters: `assignment_id` (INTEGER), `stage` (one of `outline`, `draft`, `post`, `feedback`), `decision` (one of `approved`, `rejected`, `modified`, `cancelled`)
3. THE `log_editorial_decision` tool SHALL accept an optional `feedback` parameter (TEXT) for recording Derek's reasoning
4. THE Writer_Handler SHALL populate the `article_type` and `topic` columns on the decision record from the referenced assignment
5. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
6. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `log_editorial_decision` tool SHALL return representative mock data without making database writes
7. IF the `DATABASE_URL` environment variable is not set, THEN THE `log_editorial_decision` tool SHALL return `{ error: 'Database not configured' }`
8. THE Tool_Registry SHALL register `log_editorial_decision` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 10: Get Article Assignment Tool

**User Story:** As Derek using Hal, I want to retrieve a specific assignment by ID with its editorial decisions, so that I can review the full pipeline state and decision history.

#### Acceptance Criteria

1. WHEN the `get_article_assignment` tool is called with an `assignment_id` parameter, THE Writer_Handler SHALL return the matching row from `altus_assignments` including all columns, joined with all associated rows from `altus_editorial_decisions` ordered by `created_at` ascending
2. THE Writer_Handler SHALL include the editorial decisions as a `decisions` array on the response object
3. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
4. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `get_article_assignment` tool SHALL return representative mock data without making database queries
5. IF the `DATABASE_URL` environment variable is not set, THEN THE `get_article_assignment` tool SHALL return `{ error: 'Database not configured' }`
6. THE Tool_Registry SHALL register `get_article_assignment` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 11: List Article Assignments Tool

**User Story:** As Derek using Hal, I want to list assignments with optional filtering by status and article type, so that I can see the full pipeline or focus on a specific stage.

#### Acceptance Criteria

1. WHEN the `list_article_assignments` tool is called, THE Writer_Handler SHALL return all rows from `altus_assignments` ordered by `created_at` descending
2. THE `list_article_assignments` tool SHALL accept optional filter parameters: `status` (TEXT), `article_type` (TEXT)
3. WHEN the `status` parameter is provided, THE Writer_Handler SHALL filter results to only assignments matching that status
4. WHEN the `article_type` parameter is provided, THE Writer_Handler SHALL filter results to only assignments matching that article type
5. THE Writer_Handler SHALL return a summary for each assignment containing `id`, `topic`, `article_type`, `status`, `draft_word_count`, `wp_post_url`, `created_at`, and `updated_at` — omitting large fields (`archive_research`, `web_research`, `outline`, `draft_content`, `fact_check_results`) from the list response
6. IF no assignments match the filter criteria, THEN THE Writer_Handler SHALL return `{ assignments: [], count: 0 }`
7. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `list_article_assignments` tool SHALL return representative mock data without making database queries
8. IF the `DATABASE_URL` environment variable is not set, THEN THE `list_article_assignments` tool SHALL return `{ error: 'Database not configured' }`
9. THE Tool_Registry SHALL register `list_article_assignments` using `server.registerTool()` with Zod input schema and `safeToolHandler()` wrapper

### Requirement 12: REST Endpoint — List Assignments

**User Story:** As a developer, I want the `GET /hal/writer/assignments` REST endpoint to read from the `altus_assignments` table instead of `agent_memory`, so that the endpoint returns structured, queryable assignment data.

#### Acceptance Criteria

1. WHEN a GET request is made to `/hal/writer/assignments` with a valid `ALTUS_ADMIN_TOKEN` bearer token, THE HTTP server SHALL query the `altus_assignments` table and return all assignments ordered by `created_at` descending
2. THE response SHALL include a summary for each assignment containing `id`, `topic`, `article_type`, `status`, `draft_word_count`, `wp_post_url`, `created_at`, and `updated_at`
3. THE response SHALL include a `count` field with the total number of assignments returned
4. THE endpoint SHALL accept optional query parameters `status` and `article_type` for filtering
5. IF the database query fails, THEN THE HTTP server SHALL return a 500 status with `{ error: 'query_failed', message: 'Writer data temporarily unavailable' }`
6. THE endpoint SHALL not modify the existing authentication, CORS, or OPTIONS preflight handling

### Requirement 13: REST Endpoint — Get Assignment by ID

**User Story:** As a developer, I want the `GET /hal/writer/assignments/:id` REST endpoint to read from the `altus_assignments` table with joined decisions instead of `agent_memory`, so that the endpoint returns the full assignment record with decision history.

#### Acceptance Criteria

1. WHEN a GET request is made to `/hal/writer/assignments/:id` with a valid `ALTUS_ADMIN_TOKEN` bearer token, THE HTTP server SHALL query the `altus_assignments` table by `id` and return the full assignment record joined with all associated `altus_editorial_decisions` rows
2. THE response SHALL include the complete assignment record with all columns and a `decisions` array containing the editorial decision history ordered by `created_at` ascending
3. IF no assignment exists with the specified `id`, THEN THE HTTP server SHALL return a 200 status with `{ assignment: null }`
4. IF the database query fails, THEN THE HTTP server SHALL return a 500 status with `{ error: 'query_failed', message: 'Writer data temporarily unavailable' }`
5. THE endpoint SHALL not modify the existing authentication, CORS, or OPTIONS preflight handling

### Requirement 14: Parallel Research with Promise.allSettled

**User Story:** As a developer, I want archive and web research to run in parallel using `Promise.allSettled`, so that one research source failing does not block the other or crash the assignment creation.

#### Acceptance Criteria

1. THE Writer_Handler SHALL execute archive research and web research concurrently using `Promise.allSettled`, not `Promise.all`
2. WHEN the archive research promise settles as `fulfilled`, THE Writer_Handler SHALL store the result value in the `archive_research` column
3. WHEN the archive research promise settles as `rejected`, THE Writer_Handler SHALL store `null` in the `archive_research` column and log the error via `logger.error`
4. WHEN the web research promise settles as `fulfilled`, THE Writer_Handler SHALL store the result value in the `web_research` column
5. WHEN the web research promise settles as `rejected`, THE Writer_Handler SHALL store `null` in the `web_research` column and log the error via `logger.error`
6. THE Writer_Handler SHALL proceed to update the assignment status to `outline_ready` regardless of individual research call outcomes

### Requirement 15: Writer Client Abstraction Layer

**User Story:** As a developer, I want a unified writer-client abstraction layer that routes all AI generation calls through a single `generate()` function, so that switching between Anthropic and OpenAI requires only an environment variable change with no handler code modifications.

#### Acceptance Criteria

1. THE Writer_Client SHALL be located at `lib/writer-client.js` and export a `generate(params)` function that accepts an object with properties: `toolName` (string, for cost logging), `system` (string, system prompt), `prompt` (string, user message), `maxTokens` (number, default 4000), `webSearch` (boolean, default false), `jsonMode` (boolean, default false)
2. THE Writer_Client SHALL read the `ALTUS_WRITER_MODEL` environment variable to determine the model and provider, defaulting to `claude-sonnet-4-5` when the variable is not set
3. THE Writer_Client SHALL detect the provider using prefix-based matching: model names starting with `gpt-`, `o1`, or `o3` route to OpenAI; all other model names route to Anthropic
4. WHEN the provider is Anthropic, THE Writer_Client SHALL use the `@anthropic-ai/sdk` package to make API calls
5. WHEN the provider is Anthropic and `webSearch` is true, THE Writer_Client SHALL include `tools: [{ type: 'web_search_20250305', name: 'web_search' }]` in the API request
6. WHEN the provider is Anthropic and `jsonMode` is true, THE Writer_Client SHALL append an instruction to the system prompt directing the model to return valid JSON only
7. WHEN the provider is OpenAI, THE Writer_Client SHALL lazy-import the `openai` npm package inside the `generate()` function — the OpenAI client SHALL never be instantiated at module top level, preventing startup failure when `OPENAI_API_KEY` is absent
8. WHEN the provider is OpenAI and `webSearch` is true, THE Writer_Client SHALL include `tools: [{ type: 'web_search_preview' }]` in the API request
9. WHEN the provider is OpenAI and `jsonMode` is true, THE Writer_Client SHALL set `response_format: { type: 'json_object' }` in the API request
10. THE Writer_Client `generate()` function SHALL return a plain string (the model's text response) — JSON parsing is the responsibility of the calling handler, not Writer_Client
11. THE Writer_Client SHALL call `logAiUsage(toolName, model, inputTokens, outputTokens)` after every successful generation call, normalizing token counts from both Anthropic (`response.usage.input_tokens` / `response.usage.output_tokens`) and OpenAI (`response.usage.prompt_tokens` / `response.usage.completion_tokens`) formats
12. IF the AI API call fails, THEN THE Writer_Client SHALL catch the error and rethrow with a consistent shape: `throw new Error('writer-client [${provider}]: ${err.message}')`
13. IF the `logAiUsage` call fails, THEN THE Writer_Client SHALL not propagate the error — cost tracking failures SHALL not block generation responses

### Requirement 16: AI Cost Tracking via Writer Client

**User Story:** As a developer, I want every AI generation call in the Writer pipeline to be cost-tracked automatically inside Writer_Client, so that the handler does not need to manage cost logging and both Anthropic and OpenAI token counts are normalized.

#### Acceptance Criteria

1. THE Writer_Client SHALL call `logAiUsage(toolName, model, inputTokens, outputTokens)` after every `generate()` call, passing the `toolName` from the caller's params, the model string from the API response, and the normalized token counts
2. THE Writer_Client SHALL normalize Anthropic token fields (`response.usage.input_tokens`, `response.usage.output_tokens`) and OpenAI token fields (`response.usage.prompt_tokens`, `response.usage.completion_tokens`) into a consistent `(inputTokens, outputTokens)` pair before calling `logAiUsage()`
3. THE Writer_Client SHALL log AI usage for all generation calls triggered by the following tools: `create_article_assignment` (web research), `generate_article_outline` (outline generation), `generate_article_draft` (draft generation), `fact_check_draft` (initial check, regeneration, and re-check)
4. IF the `logAiUsage` call fails, THEN THE Writer_Client SHALL not propagate the error — cost tracking failures SHALL not block pipeline operations

### Requirement 17: Markdown to HTML Conversion

**User Story:** As a developer, I want a simple regex-based markdown-to-HTML converter within the Writer_Handler, so that draft content is converted to WordPress-compatible HTML at post time without adding an external library dependency.

#### Acceptance Criteria

1. THE Markdown_Converter SHALL convert markdown headings (`# `, `## `, `### `) to their corresponding HTML heading tags (`<h1>`, `<h2>`, `<h3>`)
2. THE Markdown_Converter SHALL convert bold text (`**text**`) to `<strong>text</strong>`
3. THE Markdown_Converter SHALL convert italic text (`*text*`) to `<em>text</em>`
4. THE Markdown_Converter SHALL convert unordered list items (`- item`) to `<ul><li>item</li></ul>` blocks
5. THE Markdown_Converter SHALL convert ordered list items (`1. item`) to `<ol><li>item</li></ol>` blocks
6. THE Markdown_Converter SHALL convert markdown links (`[text](url)`) to `<a href="url">text</a>`
7. THE Markdown_Converter SHALL convert double newlines into paragraph breaks (`<p>...</p>`)
8. THE Markdown_Converter SHALL be implemented as a non-exported helper function within `handlers/altus-writer.js` — no external library dependency

### Requirement 18: Fact Check Loop Constraint

**User Story:** As a developer, I want the fact-check loop to run at most once (check → regenerate → re-check → stop), so that the pipeline does not enter an infinite regeneration cycle.

#### Acceptance Criteria

1. THE Writer_Handler SHALL run the fact-check process in at most three `writerClient.generate()` calls: one initial fact-check, one regeneration of flagged sections (only when issues are found), and one re-check of the regenerated content
2. WHEN the initial fact check finds no issues, THE Writer_Handler SHALL set the assignment status to `ready_to_post` and make no further API calls
3. WHEN the initial fact check finds issues, THE Writer_Handler SHALL regenerate only the flagged sections, run one re-check, and then set the assignment status to `ready_to_post` regardless of the re-check outcome
4. THE Writer_Handler SHALL store the final `fact_check_results` (from the re-check when regeneration occurred, or from the initial check when no issues were found) in the assignment record

### Requirement 19: WordPress Draft-Only Posting

**User Story:** As Derek, I want the AI Writer to post content only as WordPress drafts, so that no AI-generated content is published without my final review in the WordPress editor.

#### Acceptance Criteria

1. THE Writer_Handler SHALL create WordPress posts with `status: 'draft'` in every call to the WordPress REST API
2. THE Writer_Handler SHALL not accept any parameter that overrides the draft status to `publish`, `pending`, `private`, or any other WordPress post status
3. THE response from the `post_to_wordpress` tool SHALL include the `wp_post_url` linking to the WordPress editor for the created draft

### Requirement 20: Handler Module Structure

**User Story:** As a developer, I want the Writer_Handler to follow established Altus handler patterns, so that the codebase remains consistent and maintainable.

#### Acceptance Criteria

1. THE Writer_Handler SHALL be located at `handlers/altus-writer.js` and use ESM `import`/`export` syntax
2. THE Writer_Handler SHALL import the shared PostgreSQL pool from `lib/altus-db.js`
3. THE Writer_Handler SHALL import `logger` from `../logger.js` for structured logging
4. THE Writer_Handler SHALL import `writerClient` (or the `generate` function) from `lib/writer-client.js` for all AI generation calls
5. THE Writer_Handler SHALL NOT import or call Anthropic or OpenAI SDKs directly — all AI generation calls SHALL route through Writer_Client
6. THE Writer_Handler SHALL import `searchAltwireArchive` from `handlers/altus-search.js` for archive research (called as a direct function, not via MCP tool)
7. THE Writer_Handler SHALL import `buildAuthHeader` from `lib/wp-client.js` for WordPress API authentication
8. THE Writer_Handler SHALL export named functions for each pipeline step: `createAssignment`, `generateOutline`, `approveOutline`, `generateDraft`, `factCheckDraft`, `postToWordPress`, `logEditorialDecision`, `getAssignment`, `listAssignments`
9. THE Writer_Handler SHALL export `initWriterSchema` for startup schema initialization
