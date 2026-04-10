# Requirements Document

## Introduction

Add Matomo web analytics and Google Search Console (GSC) tools to the Altus MCP server, giving Hal visibility into AltWire's traffic, audience behavior, search performance, and editorial opportunities. The implementation copies proven handler patterns from cirrusly-nimbus, adapts them with ALTWIRE_-prefixed environment variables, registers 7 new MCP tools (4 Matomo + 3 GSC), and includes editorial interpretation context so Hal presents analytics through a music publication lens rather than an e-commerce lens.

## Glossary

- **Altus**: The AltWire MCP server (`altwire-altus`), exposing tools for AltWire content operations
- **Matomo_Client**: The handler module (`handlers/altwire-matomo-client.js`) that communicates with the Matomo Reporting API using ALTWIRE_-prefixed environment variables
- **GSC_Client**: The handler module (`handlers/altwire-gsc-client.js`) that communicates with the Google Search Console API using ALTWIRE_-prefixed environment variables
- **Tool_Registry**: The `index.js` file where MCP tools are registered via `server.registerTool()` and wrapped in `safeToolHandler()`
- **Matomo**: Self-hosted web analytics platform at matomo.ozmediaservices.com tracking AltWire visitor behavior
- **GSC**: Google Search Console — provides search query performance, impressions, clicks, CTR, and sitemap health data for altwire.net
- **Editorial_Context**: Interpretation guidelines stored in a steering file that instruct Hal to present analytics data through a music publication lens
- **Sitemap_Health**: GSC Sitemaps API data showing fetch status, error counts, and last download timestamps for altwire.net sitemaps

## Requirements

### Requirement 1: Matomo Client Handler

**User Story:** As a developer, I want a Matomo client handler adapted for AltWire, so that Altus can query AltWire's Matomo instance using ALTWIRE_-prefixed environment variables.

#### Acceptance Criteria

1. THE Matomo_Client SHALL export four async functions: `getTrafficSummary`, `getReferrerBreakdown`, `getTopPages`, and `getSiteSearch`
2. THE Matomo_Client SHALL read configuration from `ALTWIRE_MATOMO_URL`, `ALTWIRE_MATOMO_TOKEN_AUTH`, and `ALTWIRE_MATOMO_SITE_ID` environment variables
3. IF any required Matomo environment variable is missing, THEN THE Matomo_Client SHALL return `{ error: 'matomo_not_configured' }` without making API calls
4. THE Matomo_Client SHALL send the `token_auth` via POST body (not query string) to support Matomo's secure-request-only token setting
5. IF the Matomo API returns a non-200 response, THEN THE Matomo_Client SHALL return a structured error object containing the HTTP status code
6. IF the Matomo API returns non-JSON content, THEN THE Matomo_Client SHALL return `{ error: 'matomo_invalid_response' }`
7. IF a network request to the Matomo API fails, THEN THE Matomo_Client SHALL return `{ error: 'matomo_request_failed', message: <error_detail> }`

### Requirement 2: Matomo Traffic Summary Tool

**User Story:** As an admin using Hal, I want to retrieve AltWire traffic summaries, so that I can understand visitor volume and engagement trends.

#### Acceptance Criteria

1. WHEN the `get_altwire_site_analytics` tool is called with `period` and `date` parameters, THE Tool_Registry SHALL invoke `Matomo_Client.getTrafficSummary` and return the result as JSON text content
2. THE `get_altwire_site_analytics` tool SHALL accept a `period` parameter (one of 'day', 'week', 'month', 'year') and a `date` parameter (ISO date string or Matomo keyword such as 'yesterday' or 'today')
3. THE Tool_Registry SHALL wrap the `get_altwire_site_analytics` handler in `safeToolHandler()`
4. THE `get_altwire_site_analytics` tool SHALL return visits, unique visitors, pageviews, and bounce rate data from the Matomo VisitsSummary API

### Requirement 3: Matomo Traffic Sources Tool

**User Story:** As an admin using Hal, I want to see where AltWire traffic comes from, so that I can evaluate referral channels and campaign effectiveness.

#### Acceptance Criteria

1. WHEN the `get_altwire_traffic_sources` tool is called with `period` and `date` parameters, THE Tool_Registry SHALL invoke `Matomo_Client.getReferrerBreakdown` and return the result as JSON text content
2. THE `get_altwire_traffic_sources` tool SHALL return referrer type breakdown, top referring websites, and campaign data
3. THE Tool_Registry SHALL wrap the `get_altwire_traffic_sources` handler in `safeToolHandler()`

### Requirement 4: Matomo Top Pages Tool

**User Story:** As an admin using Hal, I want to see which AltWire articles get the most traffic, so that I can identify high-performing content and editorial patterns.

#### Acceptance Criteria

1. WHEN the `get_altwire_top_pages` tool is called with `period` and `date` parameters, THE Tool_Registry SHALL invoke `Matomo_Client.getTopPages` and return the result as JSON text content
2. THE `get_altwire_top_pages` tool SHALL return most-viewed page URLs, entry pages, and exit pages
3. THE Tool_Registry SHALL wrap the `get_altwire_top_pages` handler in `safeToolHandler()`

### Requirement 5: Matomo Site Search Tool

**User Story:** As an admin using Hal, I want to see what visitors search for on AltWire, so that I can identify content gaps and reader demand signals.

#### Acceptance Criteria

1. WHEN the `get_altwire_site_search` tool is called with `period` and `date` parameters, THE Tool_Registry SHALL invoke `Matomo_Client.getSiteSearch` and return the result as JSON text content
2. THE `get_altwire_site_search` tool SHALL return both successful search keywords and no-result keywords
3. THE Tool_Registry SHALL wrap the `get_altwire_site_search` handler in `safeToolHandler()`

### Requirement 6: GSC Client Handler

**User Story:** As a developer, I want a GSC client handler adapted for AltWire, so that Altus can query Google Search Console data using ALTWIRE_-prefixed environment variables.

#### Acceptance Criteria

1. THE GSC_Client SHALL export three async functions: `getSearchPerformance`, `getSearchOpportunities`, and `getSitemapHealth`
2. THE GSC_Client SHALL read configuration from `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON` and `ALTWIRE_GSC_SITE_URL` environment variables
3. IF any required GSC environment variable is missing, THEN THE GSC_Client SHALL return `{ error: 'gsc_not_configured' }` without making API calls
4. IF `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON` contains invalid JSON, THEN THE GSC_Client SHALL log the parse error and return `{ error: 'gsc_not_configured' }`
5. THE GSC_Client SHALL authenticate using a Google service account with `webmasters.readonly` scope
6. IF a GSC API call fails, THEN THE GSC_Client SHALL return `{ error: 'gsc_api_error', message: <error_detail> }`
7. THE GSC_Client SHALL also export a `normalizeDimensions` utility function that converts string, array, or falsy dimension inputs into a valid string array (defaulting to `['query']`)

### Requirement 7: GSC Search Performance Tool

**User Story:** As an admin using Hal, I want to see how AltWire articles perform in Google Search, so that I can track organic visibility and click-through rates.

#### Acceptance Criteria

1. WHEN the `get_altwire_search_performance` tool is called with `start_date` and `end_date` parameters, THE Tool_Registry SHALL invoke `GSC_Client.getSearchPerformance` and return the result as JSON text content
2. THE `get_altwire_search_performance` tool SHALL accept optional `row_limit` (default 25) and `dimensions` (default `['query']`) parameters
3. THE `get_altwire_search_performance` tool SHALL return queries, impressions, clicks, CTR, and average position data
4. THE Tool_Registry SHALL wrap the `get_altwire_search_performance` handler in `safeToolHandler()`

### Requirement 8: GSC Search Opportunities Tool

**User Story:** As an admin using Hal, I want to identify high-impression, low-CTR search queries, so that I can find editorial opportunities where AltWire has visibility but low engagement.

#### Acceptance Criteria

1. WHEN the `get_altwire_search_opportunities` tool is called with `start_date` and `end_date` parameters, THE Tool_Registry SHALL invoke `GSC_Client.getSearchOpportunities` and return the result as JSON text content
2. THE `get_altwire_search_opportunities` tool SHALL return queries where impressions are above median and CTR is below median, representing optimization opportunities
3. THE Tool_Registry SHALL wrap the `get_altwire_search_opportunities` handler in `safeToolHandler()`

### Requirement 9: GSC Sitemap Health Tool

**User Story:** As an admin using Hal, I want to check the health of AltWire's sitemaps in Google Search Console, so that I can verify Google is successfully crawling the site.

#### Acceptance Criteria

1. WHEN the `get_altwire_sitemap_health` tool is called, THE Tool_Registry SHALL invoke `GSC_Client.getSitemapHealth` and return the result as JSON text content
2. THE `get_altwire_sitemap_health` tool SHALL return sitemap URLs, last download timestamps, submission status, error counts, and warning counts for all sitemaps registered in GSC for altwire.net
3. THE Tool_Registry SHALL wrap the `get_altwire_sitemap_health` handler in `safeToolHandler()`
4. IF no sitemaps are registered in GSC, THEN THE GSC_Client SHALL return an empty sitemaps array rather than an error
5. THE GSC_Client SHALL use the GSC Sitemaps API (`webmasters.sitemaps.list`) to retrieve sitemap data

### Requirement 10: googleapis Dependency

**User Story:** As a developer, I want the `googleapis` npm package added to Altus dependencies, so that the GSC client can authenticate and query the Google Search Console API.

#### Acceptance Criteria

1. THE Altus `package.json` SHALL include `googleapis` as a production dependency
2. THE `googleapis` dependency SHALL use a caret version range (e.g., `^146.0.0`) to allow compatible minor and patch updates

### Requirement 11: Environment Variable Configuration

**User Story:** As a developer deploying Altus, I want all new analytics environment variables documented in `.env.example`, so that the deployment configuration is clear.

#### Acceptance Criteria

1. THE `.env.example` file SHALL include entries for `ALTWIRE_MATOMO_URL`, `ALTWIRE_MATOMO_TOKEN_AUTH`, `ALTWIRE_MATOMO_SITE_ID`, `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON`, and `ALTWIRE_GSC_SITE_URL`
2. THE `.env.example` file SHALL include descriptive comments for each new environment variable

### Requirement 12: Editorial Interpretation Context

**User Story:** As an admin using Hal, I want analytics data presented through a music publication lens, so that metrics like bounce rate and top pages are interpreted in the context of editorial content rather than e-commerce conversion.

#### Acceptance Criteria

1. THE Altus server SHALL include an editorial interpretation context file (e.g., `docs/analytics-editorial-context.md`) accessible to Hal
2. THE Editorial_Context SHALL reframe bounce rate as a content engagement signal rather than a conversion failure indicator (high bounce rate on a long-form review may indicate readers consumed the full article)
3. THE Editorial_Context SHALL interpret top pages as editorial resonance indicators, identifying which artists, genres, or coverage types drive the most reader interest
4. THE Editorial_Context SHALL interpret traffic sources through a music publication lens (e.g., social referrals from music communities, organic search for artist names, direct traffic from loyal readers)
5. THE Editorial_Context SHALL interpret site search terms as reader demand signals for coverage topics and artists
6. THE Editorial_Context SHALL interpret GSC search opportunities as editorial gaps where AltWire has search visibility but content may need strengthening or updating

### Requirement 13: Tool Registration Pattern Compliance

**User Story:** As a developer, I want all new analytics tools to follow the existing Altus registration pattern, so that the codebase remains consistent and maintainable.

#### Acceptance Criteria

1. THE Tool_Registry SHALL register all 7 analytics tools using the `server.registerTool()` method (not `server.tool()`)
2. THE Tool_Registry SHALL define input schemas using Zod for all tool parameters
3. THE Tool_Registry SHALL wrap all tool results in `{ content: [{ type: 'text', text: JSON.stringify(result) }] }` format
4. THE Tool_Registry SHALL import handler functions from their respective handler modules (`altwire-matomo-client.js` and `altwire-gsc-client.js`)

### Requirement 14: Implementation Ordering

**User Story:** As a developer, I want Matomo tools implemented before GSC tools, so that the analytics feature can ship incrementally without blocking on GSC service account access verification.

#### Acceptance Criteria

1. THE Matomo_Client and its 4 associated tools SHALL have no external blockers and be implementable immediately
2. THE GSC_Client and its 3 associated tools SHALL be implemented after Matomo, acknowledging the dependency on confirming the service account has access to the altwire.net GSC property

### Requirement 15: Source Isolation

**User Story:** As a developer, I want the Altus analytics implementation to be fully independent from Nimbus source files, so that changes to one server do not affect the other.

#### Acceptance Criteria

1. THE Matomo_Client SHALL be a standalone file in `handlers/altwire-matomo-client.js` that does not import from cirrusly-nimbus
2. THE GSC_Client SHALL be a standalone file in `handlers/altwire-gsc-client.js` that does not import from cirrusly-nimbus
3. THE implementation SHALL NOT modify any files in the cirrusly-nimbus or cirrusly-mcp-server directories
