/**
 * Archive title lookup for analytics output.
 *
 * Matomo reports every URL (listing pages, /author/, /page/2, year archives)
 * and labels pages by slug. Membership in altus_content identifies a real
 * article and supplies its published headline.
 */

import pool from './altus-db.js';

const normalize = (url) => (typeof url === 'string' ? url.replace(/\/+$/, '') : null);

/**
 * @param {string[]} urls
 * @returns {Promise<Map<string, string>>} normalized URL → title
 */
export async function lookupArchiveTitles(urls) {
  const normalized = [...new Set(urls.map(normalize).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await pool.query(
    `SELECT rtrim(url, '/') AS url, title FROM altus_content WHERE rtrim(url, '/') = ANY($1)`,
    [normalized],
  );
  return new Map(rows.map((r) => [r.url, r.title]));
}

/**
 * Add `title` and `is_article` to Matomo page rows. If the lookup fails the
 * rows are returned unchanged, so analytics still work without the archive.
 */
export async function annotatePagesWithTitles(pages) {
  if (!Array.isArray(pages) || !pages.length) return pages;
  let titles;
  try {
    titles = await lookupArchiveTitles(pages.map((p) => p.url));
  } catch {
    return pages;
  }
  return pages.map((p) => {
    const title = titles.get(normalize(p.url)) ?? null;
    return { ...p, title, is_article: Boolean(title) };
  });
}
