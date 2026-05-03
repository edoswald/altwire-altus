/**
 * handlers/altus-editorial-tools.js
 *
 * Editorial tracking tools for AltWire:
 *   track_article     — track an article by URL for performance monitoring
 *   list_tracked_articles — list all tracked articles
 *   add_content_idea  — add a content idea
 *   get_content_ideas — retrieve content ideas by status
 *
 * Stored in agent_memory with keys:
 *   altwire:article:{slug}
 *   altwire:idea:{id}
 */

import { readAgentMemory, writeAgentMemory, pool } from '../lib/altus-db.js';
import { logger } from '../logger.js';
import crypto from 'node:crypto';

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
  } catch {
    return url.slice(0, 80).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }
}

/**
 * Track an article for performance monitoring.
 * @param {{ url: string, title: string, category: string, notes?: string }} params
 * @returns {Promise<{ success: boolean, key: string, slug: string }>}
 */
export async function trackArticle({ url, title, category, notes = null }) {
  const slug = slugFromUrl(url);
  const key = `altwire:article:${slug}`;
  const value = JSON.stringify({
    url,
    title,
    category,
    notes,
    tracked_at: new Date().toISOString(),
  });
  await writeAgentMemory('hal', key, value);
  logger.info('altus-editorial: article tracked', { key, title });
  return { success: true, key, slug };
}

/**
 * List all tracked articles.
 * @param {{ limit?: number }} params
 * @returns {Promise<{ success: boolean, articles: Array, total: number }>}
 */
export async function listTrackedArticles({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT key, value, updated_at FROM agent_memory
     WHERE agent = 'hal' AND key LIKE 'altwire:article:%'
     ORDER BY (value::jsonb->>'tracked_at') DESC
     LIMIT $1`,
    [limit]
  );
  const articles = rows.map((r) => {
    try {
      return { key: r.key, ...JSON.parse(r.value) };
    } catch {
      return { key: r.key, raw: r.value };
    }
  });
  return { success: true, articles, total: rows.length };
}

/**
 * Add a content idea.
 * @param {{ topic: string, angle?: string, status?: string, notes?: string }} params
 * @returns {Promise<{ success: boolean, id: string, key: string }>}
 */
export async function addContentIdea({ topic, angle = null, status = 'idea', notes = null }) {
  const id = crypto.randomUUID();
  const key = `altwire:idea:${id}`;
  const value = JSON.stringify({
    topic,
    angle,
    status,
    notes,
    created_at: new Date().toISOString(),
  });
  await writeAgentMemory('hal', key, value);
  logger.info('altus-editorial: content idea added', { key, topic });
  return { success: true, id, key };
}

/**
 * Get content ideas by status.
 * @param {{ status?: string, limit?: number }} params
 * @returns {Promise<{ success: boolean, ideas: Array, total: number }>}
 */
export async function getContentIdeas({ status = null, limit = 50 } = {}) {
  let query = `SELECT key, value FROM agent_memory
    WHERE agent = 'hal' AND key LIKE 'altwire:idea:%'`;
  const params = [];

  if (status) {
    query += ` AND (value::jsonb->>'status') = $1`;
    params.push(status);
  }

  query += ` ORDER BY (value::jsonb->>'created_at') DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(query, params);
  const ideas = rows.map((r) => {
    try {
      return { key: r.key, ...JSON.parse(r.value) };
    } catch {
      return { key: r.key, raw: r.value };
    }
  });
  return { success: true, ideas, total: rows.length };
}