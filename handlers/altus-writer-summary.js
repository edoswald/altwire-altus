import pool from '../lib/altus-db.js';

function summarizeQueuedOpportunities(opportunities, refreshResult) {
  const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
  const bySource = { google_news: 0, gsc_opportunity_zone: 0, other: 0 };
  let pending = 0;
  let watchListMatches = 0;

  for (const opportunity of opportunities ?? []) {
    const priority = opportunity.priority;
    if (Object.hasOwn(byPriority, priority)) byPriority[priority]++;
    else byPriority.low++;

    if (opportunity.status === 'pending') pending++;

    if (opportunity.source === 'Google News' || opportunity.source === 'google_news') bySource.google_news++;
    else if (opportunity.source === 'GSC opportunity zone' || opportunity.source === 'gsc_opportunity_zone') bySource.gsc_opportunity_zone++;
    else bySource.other++;

    if (opportunity.coverage_status === 'watch_list_match') watchListMatches++;
  }

  const total = opportunities?.length ?? 0;
  return {
    high: pending,
    medium: total,
    low: 0,
    pending,
    active: total,
    total,
    by_priority: byPriority,
    by_source: bySource,
    watch_list_matches: watchListMatches,
    refreshed: {
      story_upserted: refreshResult?.story?.upserted ?? 0,
      news_upserted: refreshResult?.news?.upserted ?? 0,
      news_matches: refreshResult?.news?.matches ?? 0,
      warnings: refreshResult?.warnings ?? [],
    },
    top: (opportunities ?? []).slice(0, 5),
  };
}

export async function buildWriterSummary({
  getTrafficSummary,
  refreshOpportunityQueue,
  listStoryOpportunityQueue,
  getAltwireMorningDigest,
} = {}) {
  const { rows: activeRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM altus_assignments WHERE status NOT IN ('posted', 'cancelled')`
  );
  const { rows: actionRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM altus_assignments WHERE status IN ('outline_ready', 'draft_ready')`
  );
  const { rows: readyRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM altus_assignments WHERE status = 'ready_to_post'`
  );

  const warnings = [];

  let digest = null;
  try {
    digest = await getAltwireMorningDigest?.();
  } catch (error) {
    warnings.push({ source: 'digest', error: error.message });
  }

  let analytics = { pageviews_today: 0, top_article: null };
  try {
    const matomoData = await getTrafficSummary?.('day', 'today');
    analytics = {
      pageviews_today: matomoData?.pageviews ?? 0,
      top_article: matomoData?.top_article_title ?? null,
    };
  } catch (error) {
    warnings.push({ source: 'analytics', error: error.message });
  }

  let opportunities = summarizeQueuedOpportunities([], null);
  let refreshResult = null;
  try {
    refreshResult = await refreshOpportunityQueue?.({ days: 28, includeNews: true });
    if (refreshResult?.warnings?.length) {
      for (const warning of refreshResult.warnings) {
        warnings.push({ source: `opportunities_${warning.source ?? 'refresh'}`, error: warning.error, message: warning.message ?? null });
      }
    }
  } catch (error) {
    warnings.push({ source: 'opportunities_refresh', error: error.message });
  }

  try {
    const queueResult = await listStoryOpportunityQueue?.({ status: 'active', limit: 25 });
    if (queueResult?.error) {
      warnings.push({ source: 'opportunities', error: queueResult.error });
    } else {
      opportunities = summarizeQueuedOpportunities(queueResult?.opportunities, refreshResult);
    }
  } catch (error) {
    warnings.push({ source: 'opportunities', error: error.message });
  }

  return {
    success: true,
    degraded: warnings.length > 0,
    warnings,
    writer: {
      active: parseInt(activeRows[0]?.count || 0, 10),
      action_needed: parseInt(actionRows[0]?.count || 0, 10),
      ready_to_post: parseInt(readyRows[0]?.count || 0, 10),
    },
    digest: {
      last_updated: digest?.generated_at || null,
      warning_count: digest?.warnings?.length || 0,
    },
    opportunities,
    analytics,
  };
}
