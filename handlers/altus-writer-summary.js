import pool from '../lib/altus-db.js';

function countPositionBuckets(opportunities) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const opportunity of opportunities ?? []) {
    if (opportunity.position >= 5 && opportunity.position <= 10) counts.high++;
    else if (opportunity.position >= 11 && opportunity.position <= 20) counts.medium++;
    else counts.low++;
  }
  return counts;
}

export async function buildWriterSummary({
  getTrafficSummary,
  getSearchOpportunities,
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

  let opportunities = { high: 0, medium: 0, low: 0 };
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const oppData = await getSearchOpportunities?.(thirtyDaysAgo, new Date().toISOString().slice(0, 10));
    opportunities = countPositionBuckets(oppData?.opportunities);
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
