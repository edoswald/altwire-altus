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
 *   ALTUS_RUN_CRONS=daily_ingest,… — run only the named jobs (comma-separated).
 *   ALTUS_SKIP_CRONS=daily_ingest,… — never run the named jobs on this instance.
 *
 *   ALTUS_INGEST_CRON              — schedule for daily_ingest (default
 *                                    "0 3 * * *", UTC).
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
  'get_altwire_seasonal_comparison',
  'get_article_performance',
  'get_altwire_seo_state',
  'update_altwire_seo_fields',
  'find_altwire_seo_candidates',
  'get_altwire_seo_queue',
  'update_altwire_seo_queue_item',
  'queue_altwire_seo_item',
  'get_altwire_seo_results',
  // Story ideas / editorial intelligence
  'get_story_opportunities',
  'update_story_opportunity',
  'get_altwire_morning_digest',
  // Gift guides / roundups
  'find_gift_guide_candidates',
]);

// Background jobs that only exist to serve the Hal runtime.
export const LEGACY_ONLY_CRONS = new Set([
  // Hal-era reflection and synthesis; core uses analytics_history instead.
  'altwire_reflection',
  'synthesis_batch_early',
  'synthesis_batch_late',
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

function cronList(value) {
  return new Set(String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** The ALTUS_RUN_CRONS setting: 'all', 'none', or a Set of job names. */
function runCronsSetting(env) {
  const raw = String(env.ALTUS_RUN_CRONS ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'true') return 'all';
  if (raw === 'false') return 'none';
  return cronList(raw);
}

/** Whether any background job may run on this instance. */
export function shouldRunCrons(env = process.env) {
  return runCronsSetting(env) !== 'none';
}

/** Whether a named background job should be scheduled on this instance. */
export function isCronEnabled(cronName, env = process.env) {
  const name = cronName.toLowerCase();
  const setting = runCronsSetting(env);
  if (setting === 'none') return false;
  if (setting !== 'all' && !setting.has(name)) return false;
  if (cronList(env.ALTUS_SKIP_CRONS).has(name)) return false;
  return !(isCoreProfile(env) && LEGACY_ONLY_CRONS.has(cronName));
}

/** Whether an HTTP path is served on this instance. */
export function isPathEnabled(pathname, env = process.env) {
  if (!isCoreProfile(env)) return true;
  return !LEGACY_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
