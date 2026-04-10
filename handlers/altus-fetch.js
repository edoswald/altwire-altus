/**
 * get_content_by_url handler.
 * Retrieves a specific piece of content from the archive by URL or slug.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';

function extractSlug(url) {
  try {
    const path = new URL(url).pathname;
    return path.replace(/^\/|\/$/g, '');
  } catch {
    return url;
  }
}

/**
 * @param {{ url?: string, slug?: string }} params
 * @returns {Promise<object>}
 */
export async function getContentByUrl({ url, slug }) {
  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  const resolvedSlug = url ? extractSlug(url) : slug;

  try {
    // Try exact match first
    let result = await pool.query(
      `SELECT id, wp_id, content_type, title, slug, url,
              published_at, categories, tags, raw_text
       FROM altus_content
       WHERE slug = $1
       LIMIT 1`,
      [resolvedSlug]
    );

    // Fallback: LIKE query on last path segment
    if (result.rows.length === 0) {
      const lastSegment = resolvedSlug.split('/').filter(Boolean).pop() ?? resolvedSlug;
      result = await pool.query(
        `SELECT id, wp_id, content_type, title, slug, url,
                published_at, categories, tags, raw_text
         FROM altus_content
         WHERE slug LIKE '%' || $1 || '%'
         LIMIT 1`,
        [lastSegment]
      );
    }

    if (result.rows.length === 0) {
      return { found: false, content: null };
    }

    const row = result.rows[0];
    logger.info('Content fetched by URL/slug', { slug: resolvedSlug, found: true });

    return {
      found: true,
      content: {
        type: row.content_type,
        title: row.title,
        url: row.url,
        slug: row.slug,
        published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
        categories: row.categories ?? [],
        tags: row.tags ?? [],
        full_text: row.raw_text ?? '',
      },
    };
  } catch (err) {
    logger.error('get_content_by_url failed', { error: err.message });
    return { error: 'Fetch failed — database error' };
  }
}
