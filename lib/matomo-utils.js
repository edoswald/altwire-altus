/**
 * lib/matomo-utils.js
 *
 * Shared Matomo data normalization utilities.
 */

/**
 * Normalizes raw Matomo top-page rows into clean article objects.
 * Filters out non-article paths (taxonomy, language, system pages).
 * Reconstructs full URLs from slug-only entries.
 *
 * @param {Array} rawArticles - Raw array from getTopArticles()
 * @param {string} baseUrl - e.g. 'https://altwire.net'
 * @returns {Array<{url: string, title: string, pageviews: number}>}
 */
export function normalizeTopArticles(rawArticles, baseUrl) {
  if (!Array.isArray(rawArticles)) return [];

  const JUNK_PATH_PATTERNS = [
    /^[a-z]{2}$/,
    /^\/?(tag|author|category|reviews|news|index|board-review)\/?/i,
    /^\/?$/,
  ];

  const normalized = [];

  for (const row of rawArticles) {
    const rawPath = row.label ?? row.url ?? '';
    const pageviews = typeof row.nb_hits === 'number'
      ? row.nb_hits
      : (typeof row.nb_visits === 'number' ? row.nb_visits : 0);

    if (!rawPath) continue;

    const cleanPath = rawPath.replace(/^\//, '');
    if (JUNK_PATH_PATTERNS.some((re) => re.test(cleanPath))) continue;

    let fullUrl;
    if (rawPath.startsWith('http')) {
      fullUrl = rawPath;
    } else {
      const separator = rawPath.startsWith('/') ? '' : '/';
      fullUrl = `${baseUrl}${separator}${rawPath}`;
    }

    const title = row.label ?? cleanPath;

    normalized.push({ url: fullUrl, title, pageviews });
  }

  return normalized.sort((a, b) => b.pageviews - a.pageviews);
}
