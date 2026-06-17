# Altus Phase 1-3 Tool Routing Patch Checklist

Use this checklist after deploying the patch that adds AltWire tool freshness
guidance and `/hal/chat` session-context propagation. These prompts are scoped
to this patch only; they verify that Hal calls the intended tools and does not
answer from cached analytics memory when a live tool result is expected.

For each item, watch the chat UI tool indicator or query `query_altus_events`
afterward. A pass requires the expected tool call and an answer anchored to that
tool result.

## A. Phase 1 Coverage Routing

| # | Prompt | Expected tool behavior | Expected response |
|---|---|---|---|
| A.1 | "Where are our biggest coverage gaps right now?" | Calls `get_story_opportunities` first. Should not start with `get_altwire_combined_analytics` or `search_altwire_archive`. | Lists current story/coverage opportunities from the queue or GSC opportunity-zone analysis, including why each is a gap. If no rows exist, says no current story opportunities were returned. |
| A.2 | "Analyze our coverage gap for Paramore." | Calls `analyze_coverage_gaps` because a specific subject was named. | Summarizes existing direct/related coverage, last coverage timing, and concrete editorial opportunities for Paramore. |

## B. Phase 2 Fresh Analytics Routing

| # | Prompt | Expected tool behavior | Expected response |
|---|---|---|---|
| B.1 | "What are our top pages this week?" | Calls `get_altwire_top_pages` with a week-sized period/date. | Returns ranked pages with pageviews or clearly states the tool returned no rows. |
| B.2 | "Where is our traffic coming from?" | Calls `get_altwire_traffic_sources`. | Returns direct/search/social/referral breakdown from Matomo. |
| B.3 | "What are people searching for on the site?" | Calls `get_altwire_site_search`. | Returns internal site-search terms from Matomo. |
| B.4 | "How are we doing in Google Search -- show search performance for the last 28 days, by query and page." | Calls `get_altwire_search_performance` with dimensions `["query","page"]`. | Returns GSC rows grouped by query and page with clicks, impressions, CTR, and position. |
| B.5 | "What SEO opportunities should we chase?" | Calls `get_altwire_search_opportunities` or `get_altwire_opportunity_zone_queries`. | Returns opportunity-zone or high-impression/low-CTR queries with recommended next actions. |
| B.6 | "Is our sitemap healthy?" | Calls `get_altwire_sitemap_health`. | Returns sitemap fetch/status summary, not a cached general SEO answer. |

## C. Phase 3 Editorial Intelligence Routing

| # | Prompt | Expected tool behavior | Expected response |
|---|---|---|---|
| C.1 | "What story opportunities do we have right now?" | Calls `get_story_opportunities`. | Returns current candidate topics or states that the tool returned no current opportunities. |
| C.2 | "Any breaking news opportunities from the monitor?" | Calls `get_news_opportunities`. Should not substitute only `get_altwire_news_search_performance` or combined analytics. | Reports watch-list/news-monitor matches if present. If none, says the monitor returned no current breaking/watch-list matches and may add limited context from the tool result. |
| C.3 | "Which past articles performed best, and what's the pattern?" | Calls `get_article_performance` first, then `get_news_performance_patterns` for pattern analysis. | Uses tracked article snapshots for best performers when available, plus pattern insight from News pickup/categories/tags. If snapshots are empty, says so before offering any adjacent analytics. |

## D. Audit/Visibility Checks

| # | Check | Expected result |
|---|---|---|
| D.1 | After running one prompt with a visible tool call, ask Hal to query recent `tool_call` events. | The event log includes the tool name used by the chat prompt with the active chat `session_id` when the UI supplies one. |
| D.2 | During a streamed answer with a tool call, watch the UI tool activity indicator. | `tool_start` and `tool_done` events appear for the called tool, and the final response still streams normally. |

## E. Postgres Data-Plane Health

| # | Prompt | Expected tool behavior | Expected response |
|---|---|---|---|
| E.1 | "Is there anything in Postgres for the Phase 1-3 opportunity checks?" | Calls `altus_get_data_health`. | Reports counts/freshness for `altus_story_opportunities`, active `altus_watch_list` subjects, `altus_article_assignments`, `altus_article_performance`, and latest `altus:story_opportunities:*` cache. If any are empty, explains which feature will appear empty and why. |
| E.2 | "Refresh the story opportunity queue right now, including News opportunities." | Calls `get_writer_summary` or the `/altwire/opportunities` path if available; the server-side refresh must run `refreshOpportunityQueue({ days: 28, includeNews: true })`. | Reports story and News queue activity. If GSC returns zero story rows, the latest `altus:story_opportunities:*` cache should still exist with zero opportunities and a note. |
| E.3 | "Register https://altwire.net/example-published-article for performance tracking with WordPress post ID 12345." | Calls `altus_register_article_tracking` with `article_url` and `wp_post_id`. | Returns success with the normalized article URL. A follow-up `altus_get_data_health` should show `altus_article_assignments` count above zero even before `altus_article_performance` snapshots exist. |
