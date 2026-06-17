import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';

async function tableExists(tableName) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS table_name', [tableName]);
  return Boolean(rows[0]?.table_name);
}

async function tableStats(tableName, countSql, freshnessSql = null) {
  if (!(await tableExists(tableName))) {
    return { exists: false, count: 0, latest_at: null };
  }

  const countResult = await pool.query(countSql);
  const freshnessResult = freshnessSql ? await pool.query(freshnessSql) : { rows: [] };
  return {
    exists: true,
    count: Number(countResult.rows[0]?.count ?? 0),
    latest_at: freshnessResult.rows[0]?.latest_at ?? null,
  };
}

function parseStoryCache(row) {
  if (!row?.value) return { latest_at: row?.updated_at ?? null, opportunities: null, cached: false };
  try {
    const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    return {
      latest_at: row.updated_at ?? null,
      opportunities: Array.isArray(parsed.opportunities) ? parsed.opportunities.length : null,
      cached: true,
    };
  } catch {
    return { latest_at: row.updated_at ?? null, opportunities: null, cached: true, parse_error: true };
  }
}

function buildWarnings({ storyQueue, activeWatchSubjects, articleTrackingAssignments, articlePerformance, storyCache }) {
  const warnings = [];
  if (!storyQueue.exists || storyQueue.count === 0) {
    warnings.push('altus_story_opportunities is empty; prompt-page and queue-backed story opportunities will have nothing durable to list.');
  }
  if (!activeWatchSubjects.exists || activeWatchSubjects.count === 0) {
    warnings.push('altus_watch_list has no active subjects; news monitor can return Google News data but cannot produce watch-list matches.');
  }
  if (!articleTrackingAssignments.exists || articleTrackingAssignments.count === 0) {
    warnings.push('altus_article_assignments is empty; performance snapshot cron has no tracked published articles to evaluate.');
  }
  if (!articlePerformance.exists || articlePerformance.count === 0) {
    warnings.push('altus_article_performance is empty; post-publish 72h/7d/30d performance snapshots are not available yet.');
  }
  if (!storyCache.cached) {
    warnings.push('No altus:story_opportunities cache exists in agent_memory; the story discovery cron or refresh path has not produced a cached result.');
  } else if (storyCache.opportunities === 0) {
    warnings.push('Latest altus:story_opportunities cache contains zero opportunities.');
  }
  return warnings;
}

export async function getAltusDataHealth() {
  if (!hasDbConfig()) return { error: 'Database not configured' };

  try {
    const storyQueue = await tableStats(
      'altus_story_opportunities',
      'SELECT COUNT(*)::int AS count FROM altus_story_opportunities',
      'SELECT MAX(updated_at) AS latest_at FROM altus_story_opportunities',
    );
    const activeWatchSubjects = await tableStats(
      'altus_watch_list',
      'SELECT COUNT(*)::int AS count FROM altus_watch_list WHERE active = true',
      'SELECT MAX(updated_at) AS latest_at FROM altus_watch_list',
    );
    const articlePerformance = await tableStats(
      'altus_article_performance',
      'SELECT COUNT(*)::int AS count FROM altus_article_performance',
      'SELECT MAX(snapshot_taken_at) AS latest_at FROM altus_article_performance',
    );
    const articleTrackingAssignments = await tableStats(
      'altus_article_assignments',
      'SELECT COUNT(*)::int AS count FROM altus_article_assignments',
      'SELECT MAX(assigned_at) AS latest_at FROM altus_article_assignments',
    );

    let storyCache = { latest_at: null, opportunities: null, cached: false };
    if (await tableExists('agent_memory')) {
      const { rows } = await pool.query(
        `SELECT value, updated_at
         FROM agent_memory
         WHERE agent = 'altus' AND key LIKE 'altus:story_opportunities:%'
         ORDER BY updated_at DESC
         LIMIT 1`,
      );
      storyCache = parseStoryCache(rows[0]);
    }

    const result = {
      success: true,
      checks: {
        story_queue: storyQueue,
        active_watch_subjects: activeWatchSubjects,
        article_tracking_assignments: articleTrackingAssignments,
        article_performance: articlePerformance,
        story_opportunities_cache: storyCache,
      },
    };
    result.warnings = buildWarnings({
      storyQueue,
      activeWatchSubjects,
      articleTrackingAssignments,
      articlePerformance,
      storyCache,
    });
    result.ok = result.warnings.length === 0;
    return result;
  } catch (err) {
    logger.error('Altus data health check failed', { error: err.message });
    return { error: 'data_health_failed', message: err.message };
  }
}
