/**
 * scripts/seed-top-articles.js
 *
 * Pre-seeds hal:altwire:top_articles_7d and hal:altwire:top_articles_30d memory keys.
 * Computes top articles by pageviews from Matomo for the 7-day and 30-day windows.
 *
 * Run: node scripts/seed-top-articles.js
 *
 * The performance tracker cron already keeps these fresh daily.
 * This script seeds them on first deploy and can be re-run manually to refresh.
 */

import altusDb from '../lib/altus-db.js';
const { pool, writeAgentMemory } = altusDb;
import { getTopPages } from '../handlers/altwire-matomo-client.js';

const KEY_7D = 'hal:altwire:top_articles_7d';
const KEY_30D = 'hal:altwire:top_articles_30d';

async function fetchRecentPosts(limit = 20) {
  const { rows } = await pool.query(
    `SELECT url, title, slug, published_at, categories
     FROM altus_content
     WHERE content_type = 'post' AND url IS NOT NULL
     ORDER BY published_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

function computeTopArticles(pageData, posts, limit = 10) {
  const urlToTitle = new Map(posts.map((p) => [p.url, p.title]));
  const results = [];

  const pageUrls = pageData.pageUrls ?? [];
  for (const row of pageUrls) {
    const label = row.label ?? row.url ?? '';
    const url = label.startsWith('http') ? label : `https://altwire.net${label}`;
    const title = urlToTitle.get(url) ?? label;
    const pageviews = typeof row.value === 'number' ? row.value : 0;
    results.push({ url, title, pageviews });
  }

  return results
    .sort((a, b) => b.pageviews - a.pageviews)
    .slice(0, limit);
}

async function writeTopArticlesKey(key, articles) {
  await writeAgentMemory('hal', key, JSON.stringify({
    articles,
    generated_at: new Date().toISOString(),
  }));
}

async function main() {
  console.log('seed-top-articles: Starting...\n');

  if (!process.env.DATABASE_URL) {
    console.error('seed-top-articles: DATABASE_URL not set — cannot seed.');
    process.exit(1);
  }

  const recentPosts = await fetchRecentPosts(50);
  console.log(`seed-top-articles: fetched ${recentPosts.length} recent posts`);

  // 7-day window
  console.log('seed-top-articles: fetching 7d Matomo data...');
  const data7d = await getTopPages('week', 'yesterday');
  if (data7d.error) {
    console.error(`seed-top-articles: Matomo 7d error: ${data7d.error} — proceeding without pageview data`);
  } else {
    const top7d = computeTopArticles(data7d, recentPosts, 10);
    await writeTopArticlesKey(KEY_7D, top7d);
    console.log(`seed-top-articles: ${KEY_7D} written with ${top7d.length} articles`);
  }

  // 30-day window
  console.log('seed-top-articles: fetching 30d Matomo data...');
  const data30d = await getTopPages('month', 'yesterday');
  if (data30d.error) {
    console.error(`seed-top-articles: Matomo 30d error: ${data30d.error} — proceeding without pageview data`);
  } else {
    const top30d = computeTopArticles(data30d, recentPosts, 10);
    await writeTopArticlesKey(KEY_30D, top30d);
    console.log(`seed-top-articles: ${KEY_30D} written with ${top30d.length} articles`);
  }

  console.log('\nseed-top-articles: Done.');
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('seed-top-articles: Unexpected error', err);
  process.exit(1);
});