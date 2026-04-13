# Requirements Document

## Introduction

Add a `get_draft_as_html` MCP tool to the Altus AI Writer pipeline and extract the existing `markdownToHtml` helper from `handlers/altus-writer.js` into a shared `lib/markdown.js` module. This is a small addendum to the existing AI Writer spec (`altus-ai-writer`). The new tool lets Derek copy-paste a draft directly into WordPress's Text/Code editor without using the `post_to_wordpress` tool. The shared module ensures both `postToWordPress` and `getDraftAsHtml` use the same converter. No new npm dependencies are introduced. No existing handler functions are modified beyond swapping the inline `markdownToHtml` call for the shared import.

## Glossary

- **Writer_Handler**: The handler module (`handlers/altus-writer.js`) containing all AI Writer pipeline business logic, including the new `getDraftAsHtml` function
- **Markdown_Module**: The new shared module at `lib/markdown.js` exporting `markdownToHtml(markdown)` — extracted from the existing inline helper in Writer_Handler
- **Tool_Registry**: The `index.js` file where MCP tools are registered via `server.registerTool()` and wrapped in `safeToolHandler()`
- **Assignment**: A row in the `altus_assignments` table representing a content assignment progressing through the AI Writer pipeline
- **Pool**: The shared PostgreSQL connection pool exported from `lib/altus-db.js`

## Requirements

### Requirement 1: Shared Markdown Converter Module

**User Story:** As a developer, I want the markdown-to-HTML converter extracted into a shared module, so that both `postToWordPress` and `getDraftAsHtml` use identical conversion logic without duplication.

#### Acceptance Criteria

1. THE Markdown_Module SHALL be located at `lib/markdown.js` and export a single function `markdownToHtml(markdown)`
2. THE `markdownToHtml` function SHALL convert `##` headings to `<h2>` elements and `###` headings to `<h3>` elements
3. THE `markdownToHtml` function SHALL convert `**text**` to `<strong>` elements
4. THE `markdownToHtml` function SHALL convert `*text*` to `<em>` elements
5. THE `markdownToHtml` function SHALL convert consecutive `- item` lines into a single `<ul>` element containing `<li>` elements
6. THE `markdownToHtml` function SHALL convert blank-line-separated text blocks into `<p>` elements
7. THE `markdownToHtml` function SHALL convert `[text](url)` to `<a href="url">text</a>` elements
8. THE `markdownToHtml` function SHALL use inline regex replacements with no external npm dependency
9. WHEN the `markdown` parameter is null or empty, THE `markdownToHtml` function SHALL return an empty string
10. THE Writer_Handler `postToWordPress` function SHALL import `markdownToHtml` from `lib/markdown.js` instead of using the inline helper
11. THE Writer_Handler SHALL remove the inline `markdownToHtml` function definition after extraction
12. THE `postToWordPress` function SHALL produce identical HTML output after the extraction — no behavioral change

### Requirement 2: Get Draft as HTML Tool

**User Story:** As Derek using Hal, I want to get an article draft as clean HTML, so that I can copy-paste it directly into WordPress's Text/Code editor without using the post_to_wordpress tool.

#### Acceptance Criteria

1. WHEN the `get_draft_as_html` tool is called with an `assignment_id` parameter, THE Writer_Handler SHALL retrieve the assignment and return the draft content converted to HTML
2. THE Writer_Handler SHALL import `markdownToHtml` from `lib/markdown.js` to convert the `draft_content` field
3. THE `get_draft_as_html` tool response SHALL include: `success` (boolean), `assignment_id` (integer), `topic` (string), `title_suggestion` (string from the outline JSONB), `html` (string), `word_count` (integer from `draft_word_count`), and `instructions` (string with copy-paste guidance)
4. IF the assignment has no `draft_content` (null), THEN THE Writer_Handler SHALL return `{ error: 'no_draft_content', assignment_id: <id>, message: 'This assignment does not have a draft yet. Run generate_article_draft first.' }`
5. THE `get_draft_as_html` tool SHALL NOT require a specific assignment status — HTML export is available at any post-draft stage
6. IF no assignment exists with the specified `assignment_id`, THEN THE Writer_Handler SHALL return `{ error: 'assignment_not_found', assignment_id: <id> }`
7. IF the `TEST_MODE` environment variable is set to `'true'`, THEN THE `get_draft_as_html` tool SHALL return representative mock data without making database queries
8. IF the `DATABASE_URL` environment variable is not set, THEN THE `get_draft_as_html` tool SHALL return `{ error: 'Database not configured' }`

### Requirement 3: MCP Tool Registration

**User Story:** As a developer, I want the `get_draft_as_html` tool registered in `index.js` following established Altus patterns, so that Hal can call it like any other AI Writer tool.

#### Acceptance Criteria

1. THE Tool_Registry SHALL register `get_draft_as_html` using `server.registerTool()` with a Zod input schema and `safeToolHandler()` wrapper
2. THE Zod input schema SHALL define `assignment_id` as `z.number().int().positive()`
3. THE tool description SHALL state that the tool returns the article draft as clean HTML for copy-pasting into WordPress's Text/Code editor
4. THE tool registration SHALL include a `TEST_MODE` mock data intercept before the `DATABASE_URL` guard, consistent with existing AI Writer tool registrations
5. THE `getDraftAsHtml` function SHALL be imported from `./handlers/altus-writer.js` alongside the existing writer imports

### Requirement 4: No Modification to Other Handler Functions

**User Story:** As a developer, I want the extraction and new tool to leave all other AI Writer handler functions unchanged, so that the existing pipeline continues to work without regression.

#### Acceptance Criteria

1. THE Writer_Handler SHALL NOT modify any exported function other than `postToWordPress` (which changes only its `markdownToHtml` import source)
2. THE Writer_Handler SHALL NOT add any new npm dependency
3. THE `postToWordPress` function SHALL produce identical HTML output and identical WordPress API behavior after the `markdownToHtml` extraction
4. WHEN both `postToWordPress` and `getDraftAsHtml` convert the same markdown input, THE output HTML SHALL be identical (shared converter guarantee)
