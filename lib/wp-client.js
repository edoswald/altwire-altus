/**
 * WordPress REST API client for AltWire content ingestion.
 *
 * buildAuthHeader()    — Basic auth header from env vars
 * decodeHtmlEntities() — Decode HTML entities to Unicode characters
 * stripHtml(html)      — Remove HTML tags, collapse whitespace
 * fetchTaxonomies()    — Returns { categoryCache, tagCache } (Maps of id -> name)
 * fetchPosts(caches)   — Paginated fetch of all published posts
 * fetchAllPosts()      — Convenience: fetchTaxonomies then fetchPosts
 * fetchGalleries()     — Paginated fetch of all NGG galleries via /altus/v1/galleries
 * fetchAllGalleries()  — Alias for fetchGalleries
 */

import { logger } from '../logger.js';

/**
 * Build the Basic auth header. Spaces in app password are preserved — WP requires them.
 */
export function buildAuthHeader() {
  const user = process.env.ALTWIRE_WP_USER ?? '';
  const pass = process.env.ALTWIRE_WP_APP_PASSWORD ?? '';
  const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Decode HTML entities to their Unicode equivalents.
 * Handles named entities, curly quotes, dashes, ellipsis, and numeric entities.
 *
 * @param {string|null|undefined} str
 * @returns {string|null|undefined}
 */
export function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&#8230;/g, '\u2026')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&[a-z]+;/gi, '');
}

/**
 * Strip HTML tags, replacing them with spaces, then collapse whitespace.
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function base() {
  return (process.env.ALTWIRE_WP_URL ?? '').replace(/\/$/, '');
}

async function wpFetch(path) {
  const url = `${base()}/wp-json${path}`;
  const res = await fetch(url, {
    headers: { Authorization: buildAuthHeader() },
  });
  if (!res.ok) {
    throw new Error(`WP fetch failed: ${res.status} ${url}`);
  }
  return res.json();
}

/**
 * Fetch all WP categories and tags, returning in-memory Maps.
 * Note: capped at 100 per taxonomy. If AltWire ever exceeds 100 categories or tags,
 * IDs beyond the first 100 will fall back to String(id) in post metadata.
 * @returns {Promise<{ categoryCache: Map<number,string>, tagCache: Map<number,string> }>}
 */
export async function fetchTaxonomies() {
  const [cats, tags] = await Promise.all([
    wpFetch('/wp/v2/categories?per_page=100'),
    wpFetch('/wp/v2/tags?per_page=100'),
  ]);
  const categoryCache = new Map(cats.map((c) => [c.id, c.name]));
  const tagCache = new Map(tags.map((t) => [t.id, t.name]));
  logger.info('Taxonomy cache loaded', {
    categories: categoryCache.size,
    tags: tagCache.size,
  });
  return { categoryCache, tagCache };
}

/**
 * Fetch all published posts, paginated.
 * @param {{ categoryCache: Map<number,string>, tagCache: Map<number,string> }} caches
 * @param {string|null} afterDate - ISO date string; when set, only fetch posts published after this date
 * @returns {Promise<Array>}
 */
export async function fetchPosts({ categoryCache, tagCache }, afterDate = null) {
  const all = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    let endpoint = `/wp/v2/posts?per_page=${perPage}&page=${page}&status=publish&_fields=id,slug,link,date,author,title,content,excerpt,categories,tags`;
    if (afterDate !== null) {
      endpoint += `&after=${encodeURIComponent(afterDate)}`;
    }
    const items = await wpFetch(endpoint);
    for (const item of items) {
      const rawContent = decodeHtmlEntities(stripHtml(item.content?.rendered ?? ''));
      const rawExcerpt = decodeHtmlEntities(stripHtml(item.excerpt?.rendered ?? ''));
      const raw_text = rawContent.length < 200
        ? `${rawExcerpt}\n\n${rawContent}`.trim()
        : rawContent;

      all.push({
        wp_id: item.id,
        content_type: 'post',
        title: decodeHtmlEntities(stripHtml(item.title?.rendered ?? '')),
        slug: item.slug,
        url: item.link,
        published_at: item.date,
        author: typeof item.author === 'number' ? String(item.author) : (item.author ?? null),
        categories: (item.categories ?? []).map((id) => categoryCache.get(id) ?? String(id)),
        tags: (item.tags ?? []).map((id) => tagCache.get(id) ?? String(id)),
        raw_text,
      });
    }
    logger.info(`Fetched posts page ${page}`, { count: items.length });
    if (items.length < perPage) break;
    page++;
  }

  return all;
}

/**
 * Convenience wrapper: fetch taxonomies then posts.
 * @param {string|null} afterDate - ISO date string or null for all posts
 * @returns {Promise<Array>}
 */
export async function fetchAllPosts(afterDate = null) {
  const caches = await fetchTaxonomies();
  return fetchPosts(caches, afterDate);
}

/**
 * Fetch all NGG galleries via the custom /altus/v1/galleries endpoint.
 * @returns {Promise<Array>}
 */
export async function fetchGalleries() {
  const all = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const items = await wpFetch(`/altus/v1/galleries?page=${page}&per_page=${perPage}`);
    all.push(...items);
    logger.info(`Fetched galleries page ${page}`, { count: items.length });
    if (items.length < perPage) break;
    page++;
  }

  return all;
}

export { fetchGalleries as fetchAllGalleries };
