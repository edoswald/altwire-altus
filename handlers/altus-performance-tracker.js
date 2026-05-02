/**
 * Performance Tracker handler — collects and queries post-publish GSC
 * performance snapshots at 72h, 7d, and 30d intervals.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { getPagePerformance, getNewsSearchPerformance, normalizeUrl } from './altwire-gsc-client.js';

/**
 * Determine which snapshot types an article is eligible for.
 * @param {Date|string} publishedAt — article publish timestamp
 * @param {string[]} existingSnapshots — snapshot types already collected (e.g. ['72h'])
 * @param {Date} effectiveDate — today minus GSC freshness lag (2 days)
 * @returns {string[]} — missing snapshot types the article is eligible for
 */
export function getSnapshotEligibility(publishedAt, existingSnapshots, effectiveDate) {
  const pubDate = new Date(publishedAt);
  const effective = new Date(effectiveDate);
  const missing = [];

  const thresholds = [
    { type: '72h', days: 3 },
    { type: '7d', days: 7 },
    { type: '30d', days: 30 },
  ];

  for (const { type, days } of thresholds) {
    if (existingSnapshots.includes(type)) continue;
    const threshold = new Date(effective);
    threshold.setDate(threshold.getDate() - days);
    if (pubDate <= threshold) {
      missing.push(type);
    }
  }

  return missing;
}

/**
 * Get article performance snapshots.
 * @param {{ article_url?: string, snapshot_type?: string }} params
 * @returns {Promise<object>}
 */
export async function getArticlePerformance({ article_url, snapshot_type } = {}) {
  if (process.env.TEST_MODE === 'true') {
    return {
      success: true,
      test_mode: true,
      snapshots: [
        { article_url: 'https://altwire.net/test/', snapshot_type: '72h', clicks: 50, impressions: 500, ctr: 0.1, avg_position: 8.5 },
      ],
    };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  try {
    if (article_url) {
      const normalized = normalizeUrl(article_url);
      let sql = 'SELECT * FROM altus_article_performance WHERE article_url = $1';
      const params = [normalized];
      if (snapshot_type) {
        sql += ' AND snapshot_type = $2';
        params.push(snapshot_type);
      }
      sql += ' ORDER BY snapshot_taken_at DESC';

      const result = await pool.query(sql, params);
      if (result.rows.length === 0) {
        return {
          article_url: normalized,
          snapshots: [],
          note: 'No performance data yet — snapshots are collected at 72h, 7d, and 30d after publish',
        };
      }
      return { article_url: normalized, snapshots: result.rows };
    }

    // No article_url — return aggregate for most recent 20 articles
    let sql = 'SELECT * FROM altus_article_performance';
    const params = [];
    if (snapshot_type) {
      sql += ' WHERE snapshot_type = $1';
      params.push(snapshot_type);
    }
    sql += ' ORDER BY snapshot_taken_at DESC LIMIT 20';

    const result = await pool.query(sql, params);
    if (result.rows.length === 0) {
      return {
        snapshots: [],
        note: 'No performance data yet — snapshots are collected at 72h, 7d, and 30d after publish',
      };
    }
    return { snapshots: result.rows };
  } catch (err) {
    logger.error('getArticlePerformance failed', { error: err.message });
    return { error: 'query_failed', message: err.message };
  }
}

/**
 * Get News performance patterns — which content types get News pickup.
 * @param {object} [params]
 * @param {number} [params.days=30] — Lookback window in days (7–90)
 * @returns {Promise<object>}
 */
export async function getNewsPerformancePatterns({ days = 30 } = {}) {
  if (process.env.TEST_MODE === 'true') {
    return {
      success: true,
      test_mode: true,
      patterns: [
        { category: 'Reviews', articles: 3, total_clicks: 150, total_impressions: 2000 },
      ],
    };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  // Compute date range — last N days
  const safeDays = Math.max(7, Math.min(90, days));
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - safeDays);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const gscResult = await getNewsSearchPerformance(startStr, endStr, { dimensions: ['page'], rowLimit: 100 });
  if (gscResult.error) return gscResult;

  if (!gscResult.rows || gscResult.rows.length === 0) {
    return {
      patterns: [],
      note: 'No Google News data available for the last 30 days — News coverage may be sparse initially',
    };
  }

  // Cross-reference with altus_content for enrichment
  const enriched = [];
  try {
    for (const row of gscResult.rows) {
      const pageUrl = normalizeUrl(row.keys[0]);
      const contentResult = await pool.query(
        'SELECT title, categories, tags, published_at FROM altus_content WHERE url = $1 LIMIT 1',
        [pageUrl]
      );
      const content = contentResult.rows[0] || null;
      enriched.push({
        url: pageUrl,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        title: content?.title ?? null,
        categories: content?.categories ?? [],
        tags: content?.tags ?? [],
        published_at: content?.published_at ?? null,
      });
    }
  } catch (err) {
    logger.warn('News performance enrichment failed', { error: err.message });
  }

  // Group by category
  const categoryMap = {};
  const tagMap = {};
  for (const item of enriched) {
    for (const cat of item.categories) {
      if (!categoryMap[cat]) categoryMap[cat] = { category: cat, articles: 0, total_clicks: 0, total_impressions: 0 };
      categoryMap[cat].articles++;
      categoryMap[cat].total_clicks += item.clicks;
      categoryMap[cat].total_impressions += item.impressions;
    }
    for (const tag of item.tags) {
      if (!tagMap[tag]) tagMap[tag] = { tag, articles: 0, total_clicks: 0, total_impressions: 0 };
      tagMap[tag].articles++;
      tagMap[tag].total_clicks += item.clicks;
      tagMap[tag].total_impressions += item.impressions;
    }
  }

  return {
    patterns: {
      by_category: Object.values(categoryMap).sort((a, b) => b.total_impressions - a.total_impressions),
      by_tag: Object.values(tagMap).sort((a, b) => b.total_impressions - a.total_impressions),
    },
    enriched_articles: enriched,
    total_news_pages: gscResult.rows.length,
  };
}

/**
 * Register an article for post-publish tracking.
 * @param {{ articleUrl: string, wpPostId?: number, publishedAt?: string, sourceQuery?: string }} params
 * @returns {Promise<object>}
 */
export async function registerArticleForTracking({ articleUrl, wpPostId, publishedAt, sourceQuery }) {
  if (process.env.TEST_MODE === 'true') {
    return { success: true, test_mode: true, article_url: normalizeUrl(articleUrl) };
  }

  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  const normalized = normalizeUrl(articleUrl);

  try {
    await pool.query(
      `INSERT INTO altus_article_assignments (article_url, wp_post_id, assigned_at, status, source_query)
       VALUES ($1, $2, $3, 'tracking', $4)
       ON CONFLICT (article_url) DO UPDATE SET
         wp_post_id = COALESCE(EXCLUDED.wp_post_id, altus_article_assignments.wp_post_id),
         source_query = COALESCE(EXCLUDED.source_query, altus_article_assignments.source_query)`,
      [normalized, wpPostId ?? null, publishedAt ? new Date(publishedAt) : new Date(), sourceQuery ?? null]
    );
    return { success: true, article_url: normalized };
  } catch (err) {
    logger.error('registerArticleForTracking failed', { error: err.message });
    return { error: 'registration_failed', message: err.message };
  }
}

/**
 * Run the daily performance snapshot collection (called by cron).
 * Never throws.
 * @returns {Promise<void>}
 */
export async function runPerformanceSnapshotCron() {
  if (!process.env.DATABASE_URL) {
    logger.warn('Performance snapshot cron: DATABASE_URL not set — skipping');
    return;
  }

  logger.info('Performance snapshot cron: starting');

  try {
    // Effective date = today - 2 days (GSC freshness lag)
    const effectiveDate = new Date();
    effectiveDate.setDate(effectiveDate.getDate() - 2);

    // Find articles needing snapshots
    const assignments = await pool.query(
      'SELECT article_url, wp_post_id, assigned_at FROM altus_article_assignments'
    );

    let snapshotsCollected = 0;

    for (const article of assignments.rows) {
      // Get existing snapshots for this article
      const existing = await pool.query(
        'SELECT snapshot_type FROM altus_article_performance WHERE article_url = $1',
        [article.article_url]
      );
      const existingTypes = existing.rows.map((r) => r.snapshot_type);

      const eligible = getSnapshotEligibility(article.assigned_at, existingTypes, effectiveDate);

      for (const snapshotType of eligible) {
        // Compute date range for GSC query
        const endStr = effectiveDate.toISOString().slice(0, 10);
        const snapStart = new Date(effectiveDate);
        snapStart.setDate(snapStart.getDate() - 7); // 7-day window for all snapshot types
        const startStr = snapStart.toISOString().slice(0, 10);

        const perf = await getPagePerformance(article.article_url, startStr, endStr);

        // Upsert snapshot — insert zero-value rows for partial data
        await pool.query(
          `INSERT INTO altus_article_performance
             (article_url, wp_post_id, published_at, snapshot_type, clicks, impressions, ctr, avg_position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (article_url, snapshot_type) DO UPDATE SET
             clicks = EXCLUDED.clicks,
             impressions = EXCLUDED.impressions,
             ctr = EXCLUDED.ctr,
             avg_position = EXCLUDED.avg_position,
             snapshot_taken_at = NOW()`,
          [
            article.article_url,
            article.wp_post_id,
            article.assigned_at,
            snapshotType,
            perf.clicks ?? 0,
            perf.impressions ?? 0,
            perf.ctr ?? 0,
            perf.position ?? null,
          ]
        );
        snapshotsCollected++;
      }
    }

    logger.info('Performance snapshot cron: completed', { snapshotsCollected });
  } catch (err) {
    logger.error('Performance snapshot cron: failed', { error: err.message });
  }
}
