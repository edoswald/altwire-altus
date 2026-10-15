/**
 * get_archive_stats handler.
 * Returns health and coverage statistics for the AltWire content archive.
 */

import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';

/**
 * @returns {Promise<object>}
 */
export async function getArchiveStats() {
  if (!hasDbConfig()) {
    return { error: 'Database not configured' };
  }

  try {
    const [contentResult, logResult, yearResult, categoryResult] = await Promise.all([
      pool.query(`
        SELECT
          content_type,
          COUNT(*) AS count,
          COUNT(embedding) AS embedded_count,
          MIN(published_at) AS oldest,
          MAX(published_at) AS newest,
          MAX(ingested_at) AS last_ingested
        FROM altus_content
        GROUP BY content_type
        ORDER BY content_type
      `),
      pool.query(`
        SELECT *
        FROM altus_ingest_log
        ORDER BY run_at DESC
        LIMIT 1
      `),
      pool.query(`
        SELECT EXTRACT(YEAR FROM published_at)::int AS year, COUNT(*)::int AS count
        FROM altus_content
        WHERE published_at IS NOT NULL
        GROUP BY 1
        ORDER BY 1
      `),
      pool.query(`
        SELECT c AS category, COUNT(*)::int AS count
        FROM altus_content, unnest(categories) c
        GROUP BY 1
        ORDER BY 2 DESC, 1
        LIMIT 60
      `),
    ]);

    const byType = {};
    let totalDocuments = 0;
    let indexHealthy = true;

    for (const row of contentResult.rows) {
      const count = parseInt(row.count, 10);
      const embedded = parseInt(row.embedded_count, 10);
      totalDocuments += count;

      if (embedded < count) indexHealthy = false;

      byType[row.content_type] = {
        count,
        embedded,
        oldest_published: row.oldest ? new Date(row.oldest).toISOString() : null,
        newest_published: row.newest ? new Date(row.newest).toISOString() : null,
        last_ingested: row.last_ingested ? new Date(row.last_ingested).toISOString() : null,
      };
    }

    const lastLog = logResult.rows[0] ?? null;
    const lastIngestRun = lastLog
      ? {
          run_at: new Date(lastLog.run_at).toISOString(),
          mode: lastLog.mode,
          posts_ingested: lastLog.posts_ingested,
          galleries_ingested: lastLog.galleries_ingested,
          errors: lastLog.errors,
          duration_ms: lastLog.duration_ms,
        }
      : null;

    logger.info('Archive stats retrieved', { total_documents: totalDocuments });

    return {
      total_documents: totalDocuments,
      by_type: byType,
      last_ingest_run: lastIngestRun,
      index_healthy: indexHealthy,
      by_year: Object.fromEntries((yearResult?.rows ?? []).map((r) => [r.year, r.count])),
      categories: (categoryResult?.rows ?? []).map((r) => ({ name: r.category, count: r.count })),
    };
  } catch (err) {
    logger.error('get_archive_stats failed', { error: err.message });
    return { error: 'Stats query failed — database error' };
  }
}
