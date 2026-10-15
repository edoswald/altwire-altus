/**
 * Agent-facing documentation for the core Altus tools: title, description,
 * and MCP annotations. Applied at registration (scopedRegister in index.js),
 * overriding the legacy Hal-era descriptions inline in index.js.
 *
 * Descriptions say what the tool returns, its date/window semantics, and when
 * to prefer it over a sibling tool. Annotations let MCP clients (Claude in
 * Slack, Managed Agents) auto-run reads and confirm writes.
 */

// Annotation presets.
// openWorldHint: the tool calls an external system (Matomo, GSC, WordPress, an LLM).
const READ_EXTERNAL = { readOnlyHint: true, openWorldHint: true };
const READ_LOCAL = { readOnlyHint: true, openWorldHint: false };
const WRITE_LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const GSC_DATES = 'Dates are YYYY-MM-DD. Search Console data lags about 3 days, so end_date should be at least 3 days ago (a later end date just returns partial data).';
const MATOMO_PERIOD = 'period is day | week | month | year; date is YYYY-MM-DD or "yesterday"/"today" and selects the day, or the week/month/year containing it (default: yesterday).';

export const SERVER_INSTRUCTIONS = `Altus is the data layer for AltWire (altwire.net), an independent music publication covering rock, alternative, emerging artists, live music, and music gear/plugins. It exposes AltWire's article archive, Matomo site analytics, Google Search Console (GSC) data, and editorial planning tools.

Choosing tools:
- Broad status ("how are we doing", "what moved this week"): start with get_altwire_morning_digest — it already combines week-over-week traffic, search movers, Google News, recent articles, and story opportunities.
- On-site traffic (Matomo): get_altwire_site_analytics (totals), get_altwire_traffic_sources (referrers), get_altwire_top_pages, get_altwire_site_search (what readers search for on AltWire).
- Google search visibility (queries, clicks, impressions, position): get_altwire_search_performance; narrower views are get_altwire_search_opportunities (high impressions, low CTR), get_altwire_opportunity_zone_queries (positions 5–30), get_altwire_page_performance (one URL), and get_altwire_news_search_performance (Google News).
- Traffic and search together with a written analysis: get_altwire_combined_analytics.
- Seasonal planning (holiday gift guides, year-end lists): get_altwire_seasonal_comparison shows what worked last season and which of those pages to refresh; find_gift_guide_candidates lists the best-rated products and albums AltWire has reviewed.
- How a new post did: get_article_performance (first 3/7/30 days vs the typical article).
- "What should we write?": get_story_opportunities first, then analyze_coverage_gaps or search_altwire_archive to check what AltWire already has on a topic.
- Finding or quoting past AltWire coverage: search_altwire_archive (semantic search, returns articles) or get_content_by_url (one known article).

Conventions: GSC data lags ~3 days. Matomo and GSC numbers can differ (on-site visits vs. search clicks) — say which source a figure comes from. Tools that change things (story opportunity status, SEO fields, re-ingest) are marked as writes; confirm intent before update_altwire_seo_fields, which edits the live site.`;

export const TOOL_DOCS = {
  // ---------------------------------------------------------------- Briefing
  get_altwire_morning_digest: {
    title: 'Morning analytics briefing',
    annotations: READ_EXTERNAL,
    // description lives inline in index.js (already rewritten for the analytics digest)
  },

  // ---------------------------------------------------------------- Archive
  search_altwire_archive: {
    title: 'Search the AltWire archive',
    description: 'Searches every AltWire article and photo gallery (~1,600 items back to 2012) by meaning and by exact words together, then reranks the combined matches. Returns the best matches (type, title, URL, publish date, categories, tags, a text snippet, relevance scores, and match: semantic, keyword, or both). Works for themes ("festival coverage in the rain") and for exact names (a band, album, product model, or person); for names, a short query of just the name works best. Narrow with published_after / published_before (YYYY-MM-DD), categories, and tags; a date range turns off the usual small boost for recent pieces. Omit query to browse instead: everything matching the filters in date order with total_matching and next_offset for paging, e.g. all Reviews from 2014 or everything published in December 2019. get_archive_stats lists category names and counts per year. Prefer this over search_altwire when you will reason over the results yourself.',
    annotations: READ_EXTERNAL,
  },
  search_altwire: {
    title: 'Ask the AltWire archive (AI answer)',
    description: 'Runs the same archive search as search_altwire_archive, then has a separate model write a short answer citing AltWire articles. Returns { answer, citations, results }. Use when you want a ready-made reader-style answer; for analysis, use search_altwire_archive and synthesize yourself.',
    annotations: READ_EXTERNAL,
  },
  get_content_by_url: {
    title: 'Get an article by URL',
    description: 'Fetches one archived AltWire article or gallery by full URL or slug: type, title, URL, publish date, categories, tags, and full text. An ambiguous slug returns the candidate matches instead. Use when you already know which piece you need (e.g. a URL from analytics output); use search_altwire_archive to find pieces by topic.',
    annotations: READ_LOCAL,
  },
  get_archive_stats: {
    title: 'Archive index status',
    description: 'Size and shape of the archive: document counts by type, items per year, categories with counts, oldest/newest publish dates, last ingest time, and errors from the last ingest run. Use to learn the category names for search_altwire_archive filters, to see how coverage is spread across years, or to check whether a recently published article should already be searchable.',
    annotations: READ_LOCAL,
  },
  analyze_coverage_gaps: {
    title: 'Coverage check for an artist or topic',
    description: 'Assesses how thoroughly AltWire has covered one artist or topic: what exists (written pieces vs. photo galleries, how recent), what is missing, and suggested angles (e.g. "gallery only — no review yet", "nothing in 18 months"). Uses archive search plus a short model-written assessment. Use when evaluating a pitch or a story opportunity.',
    annotations: READ_EXTERNAL,
  },
  reingest_altwire_archive: {
    title: 'Re-index the archive from WordPress',
    description: 'Pulls published posts and galleries from WordPress, re-embeds them, and upserts them into the archive index. mode=recent (default) covers the last 30 days and is usually all you need; mode=full re-processes everything and takes several minutes. A nightly job already does this — run it only when a just-published piece is missing from search. Use dry_run to preview.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },

  // ---------------------------------------------------------------- Matomo
  get_altwire_site_analytics: {
    title: 'Site traffic totals (Matomo)',
    description: `On-site traffic totals from Matomo for one period: visits, unique visitors, pageviews, actions, bounce rate, average time on site. ${MATOMO_PERIOD} For comparisons, call it twice (e.g. two weeks) or use get_altwire_morning_digest, which already compares the last 7 days with the prior 7.`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_traffic_sources: {
    title: 'Traffic sources (Matomo)',
    description: `Where visits came from for one period (Matomo): visits by channel type (search engines, direct entry, websites, social networks, campaigns), plus the top referring websites and campaigns. ${MATOMO_PERIOD}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_top_pages: {
    title: 'Most-viewed pages (Matomo)',
    description: `Most-viewed AltWire URLs for one period (Matomo), with pageviews (nb_hits), visits, and per-page engagement metrics. Each row carries the article's published title and an is_article flag; rows with is_article=false are section or listing pages (/news/, /author/, year archives) and can usually be ignored. ${MATOMO_PERIOD}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_site_search: {
    title: 'On-site search terms (Matomo)',
    description: `What readers typed into AltWire's own search box for one period (Matomo), with search counts per term. A strong signal of reader demand the site is not meeting. ${MATOMO_PERIOD}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_seasonal_comparison: {
    title: 'Last season vs. now (search + traffic)',
    description: 'Looks back at a past season, by default the most recent November-December holiday season, in Google Search Console and Matomo. Returns top_queries and seasonal_queries (gift, holiday, Black Friday, best-of and similar terms) with clicks, impressions, CTR and position; top_pages and seasonal_pages with season clicks, season pageviews, title, publish date, and the same page\'s clicks and position over the last 28 days; and refresh_candidates: seasonal articles that earned real traffic last season and are worth updating before this one. Use year, start_md and end_md (MM-DD) for other seasons, and query_contains to narrow to a theme such as "vinyl". Search Console keeps about 16 months, so only the most recent season has search data; notes says when data is missing.',
    annotations: READ_EXTERNAL,
  },
  find_gift_guide_candidates: {
    title: 'Gift guide candidates from reviews',
    description: 'Best-rated products and albums AltWire has reviewed, for gift guides and roundups. Each candidate has title, URL, publish date, product_type (hardware, software, recording, live, accessory, service, album, single, other), an overall 1-10 rating, per-subcategory ratings (e.g. Sound, Build, Value), and top pros and cons. Filter by product_types, min_overall, one subcategory threshold (min_rating_subcategory + min_rating_value, e.g. Value >= 8 for budget picks), publish date range, or title text. Ratings are inferred from the review text, not scores printed in the review, and there are no prices: check current prices and availability before recommending. coverage reports how many archive reviews have scores and when scoring last ran.',
    annotations: READ_LOCAL,
  },
  get_altwire_combined_analytics: {
    title: 'Traffic + search analysis',
    description: 'Joins Matomo pageviews with Google Search Console data for a window (default: 28 days ending 3 days ago) and returns: articles strong in both, articles popular on-site but weak in search, search-driven share of traffic, positions 5–30 queries paired with on-site interest, and content gaps where search demand exists but AltWire ranks poorly. With synthesize=true (default) it adds a model-written editorial recommendation, which takes longer; pass synthesize=false for raw numbers only.',
    annotations: READ_EXTERNAL,
  },

  // ---------------------------------------------------------------- GSC
  get_altwire_search_performance: {
    title: 'Google search performance (GSC)',
    description: `Google Search Console rows for a date range: clicks, impressions, CTR, and average position, grouped by dimensions (default ["query"]; also "page", "country", "device", "date", or combinations like ["query","page"]). row_limit caps rows (default 25, max 1000), sorted by clicks. Use for "which queries/pages bring search traffic". ${GSC_DATES}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_search_opportunities: {
    title: 'High-impression, low-CTR queries (GSC)',
    description: `Queries where AltWire shows up often in Google but is rarely clicked: among the top 100 queries by impressions, those with above-median impressions and below-median CTR. Usually fixed with a better title/meta description (see update_altwire_seo_fields) rather than a new article. ${GSC_DATES}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_opportunity_zone_queries: {
    title: 'Queries ranking 5–30 (GSC)',
    description: `Query + page pairs where AltWire ranks in positions 5–30 — close to (or on the edge of) page one — sorted by impressions. These are the cheapest ranking wins: refresh or expand the ranking page, or publish a focused follow-up. ${GSC_DATES}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_page_performance: {
    title: 'Search performance for one URL (GSC)',
    description: `Total clicks, impressions, CTR, and average position for a single AltWire URL over a date range. Use to check how one article is doing in Google over any period; for a new post's first 3/7/30 days, get_article_performance already has the checkpoints with Matomo views. ${GSC_DATES}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_news_search_performance: {
    title: 'Google News performance (GSC)',
    description: `Search Console data for Google News only (searchType=news): clicks, impressions, CTR, and position grouped by "query" (default) or "page". Translated AltWire pages (/de/, /es/, /ru/ …) often appear here. Returns a note instead of rows when News had no data. ${GSC_DATES}`,
    annotations: READ_EXTERNAL,
  },
  get_altwire_sitemap_health: {
    title: 'Sitemap status (GSC)',
    description: 'Status of each sitemap Google Search Console knows for altwire.net: path, last submitted and last downloaded times, pending flag, and error/warning counts. Use when new articles are slow to appear in Google.',
    annotations: READ_EXTERNAL,
  },

  // ---------------------------------------------------------------- Google News / story ideas
  get_story_opportunities: {
    title: 'Story opportunities',
    description: 'The story-opportunity queue: Google searches where AltWire ranks in positions 5-30 and a new or refreshed piece could move up. Each item has the query; suggestion (new_story | expand | refresh | optimize | check_coverage); a one-line reason; the ranking AltWire page with title and publish date; Search Console impressions, clicks and position for the last 28 days (lagging about 3 days) with the previous 28 days for trend; coverage (dedicated | partial | none | unknown) with the best-matching archive article; status; and first/last seen dates. Refreshed every weekday morning; items not seen for 14 days expire. refresh=true rescans now (about a minute). Best starting point for "what should we write next?"; mark items with update_story_opportunity once acted on.',
    annotations: READ_EXTERNAL,
  },
  update_story_opportunity: {
    title: 'Update a story opportunity',
    description: 'Marks a story opportunity done (written or refreshed) or dismissed (not worth doing), or reopens it, with an optional note such as the published URL or the reason. Done and dismissed items stay closed when later scans see them again.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },

  // ---------------------------------------------------------------- Article performance
  get_article_performance: {
    title: 'How new posts performed',
    description: 'How each AltWire post did in its first 3, 7, and 30 days after publication: Matomo pageviews and visits, Google web search clicks, impressions, position and top queries, and Google News clicks and impressions. Each checkpoint has vs_typical: the median for AltWire articles at the same checkpoint and this article\'s percentile. Every post is tracked automatically (no registration); a checkpoint appears about 3 days after its window ends, because of the Search Console lag, and next_checkpoint says when the next one is due. Pass url for one article, or omit it for every post published in the last `days` days (default 30). Covers posts published since tracking began in October 2026; for older articles or other periods, use get_altwire_page_performance.',
    annotations: READ_LOCAL,
  },

  // ---------------------------------------------------------------- SEO (writes to the live site)
  get_altwire_seo_state: {
    title: 'Read SEO fields',
    description: 'Current SEO fields for a WordPress post, page, or term on altwire.net (via the cirrusly-seo plugin): SEO title, meta description, canonical, focus keyword, noindex/nofollow, social title/description/image. Needs the WordPress object ID. Always read before calling update_altwire_seo_fields.',
    annotations: READ_EXTERNAL,
  },
  update_altwire_seo_fields: {
    title: 'Update SEO fields (live site)',
    description: 'Changes SEO fields on the live altwire.net site for one post, page, or term: SEO title, meta description, canonical, focus keyword, noindex/nofollow, social title/description/image. Only the fields you pass are changed. Read the current values with get_altwire_seo_state first, show the user the before/after, and include a short reason. Setting noindex removes the page from Google — only do that when explicitly asked.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
};

/**
 * Merge agent-facing docs into a tool's registration config.
 * Tools without an entry are returned unchanged.
 */
export function applyToolDocs(toolName, config = {}) {
  const docs = TOOL_DOCS[toolName];
  if (!docs) return config;
  return {
    ...config,
    ...(docs.title && { title: docs.title }),
    ...(docs.description && { description: docs.description }),
    ...(docs.annotations && { annotations: { title: docs.title, ...docs.annotations } }),
  };
}
