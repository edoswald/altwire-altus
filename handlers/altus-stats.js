/**
 * get_archive_stats handler.
 * Returns health and coverage statistics for the AltWire content archive.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';

/**
 * @returns {Promise<object>}
 */
export async function getArchiveStats() {
  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  try {
    const [contentResult, logResult] = await Promise.all([
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
    };
  } catch (err) {
    logger.error('get_archive_stats failed', { error: err.message });
    return { error: 'Stats query failed — database error' };
  }
}
