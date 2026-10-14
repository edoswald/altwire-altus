/**
 * Altus deployment profile.
 *
 *   ALTUS_PROFILE=legacy (default) — everything: Hal UI, Slack bot, all tools/crons.
 *   ALTUS_PROFILE=core             — general-purpose AltWire MCP for Claude in
 *                                    Slack / Managed Agents: archive RAG,
 *                                    analytics + GSC, story ideas. No Hal
 *                                    runtime, no Slack bot, no Hal-only crons.
 *
 *   ALTUS_RUN_CRONS=false          — disable every background job on this
 *                                    instance. Only one service sharing a DB
 *                                    should run crons.
 *
 * See docs/superpowers/plans/2026-10-14-altus-slim-down-for-general-agents.md.
 */

export const CORE_TOOLS = new Set([
  // Archive RAG
  'search_altwire_archive',
  'search_altwire',
  'get_content_by_url',
  'get_archive_stats',
  'analyze_coverage_gaps',
  'reingest_altwire_archive',
  // Matomo
  'get_altwire_site_analytics',
  'get_altwire_traffic_sources',
  'get_altwire_top_pages',
  'get_altwire_site_search',
  // Google Search Console
  'get_altwire_search_performance',
  'get_altwire_search_opportunities',
  'get_altwire_opportunity_zone_queries',
  'get_altwire_page_performance',
  'get_altwire_news_search_performance',
  'get_altwire_sitemap_health',
  // Synthesis, performance, SEO
  'get_altwire_combined_analytics',
  'get_article_performance',
  'get_news_performance_patterns',
  'altus_register_article_tracking',
  'get_altwire_seo_state',
  'update_altwire_seo_fields',
  // Story ideas / editorial intelligence
  'get_story_opportunities',
  'get_news_opportunities',
  'altus_topic_synthesis',
  'altus_add_watch_subject',
  'altus_remove_watch_subject',
  'altus_list_watch_subjects',
  'add_content_idea',
  'get_content_ideas',
  'track_article',
  'list_tracked_articles',
  'get_altwire_morning_digest',
]);

// Background jobs that only exist to serve the Hal runtime.
export const LEGACY_ONLY_CRONS = new Set([
  'altus_heartbeat',
  'chat_presence_cleanup',
  'mountaineering_batch',
]);

// HTTP surfaces served only in the legacy profile (Hal UI, Slack bot, Hal REST).
const LEGACY_ONLY_PATH_PREFIXES = ['/hal/', '/events/', '/slack/', '/altwire/'];

export function getAltusProfile(env = process.env) {
  return String(env.ALTUS_PROFILE || '').trim().toLowerCase() === 'core' ? 'core' : 'legacy';
}

export function isCoreProfile(env = process.env) {
  return getAltusProfile(env) === 'core';
}

export function isToolEnabled(toolName, env = process.env) {
  return !isCoreProfile(env) || CORE_TOOLS.has(toolName);
}

export function shouldRunCrons(env = process.env) {
  return String(env.ALTUS_RUN_CRONS ?? '').trim().toLowerCase() !== 'false';
}

/** Whether a named background job should be scheduled on this instance. */
export function isCronEnabled(cronName, env = process.env) {
  if (!shouldRunCrons(env)) return false;
  return !(isCoreProfile(env) && LEGACY_ONLY_CRONS.has(cronName));
}

/** Whether an HTTP path is served on this instance. */
export function isPathEnabled(pathname, env = process.env) {
  if (!isCoreProfile(env)) return true;
  return !LEGACY_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
