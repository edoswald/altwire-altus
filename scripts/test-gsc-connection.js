/**
 * scripts/test-gsc-connection.js
 *
 * Tests all Google Search Console client functions using the configured env vars.
 * Run: node scripts/test-gsc-connection.js
 *
 * Requires:
 *   ALTWIRE_GSC_SERVICE_ACCOUNT_JSON
 *   ALTWIRE_GSC_SITE_URL
 */

import {
  getSearchPerformance,
  getSitemapHealth,
  getSearchOpportunities,
  getNewsSearchPerformance,
  getOpportunityZoneQueries,
  getPagePerformance,
} from '../handlers/altwire-gsc-client.js';

const now = new Date();
const endDate = new Date(now);
endDate.setDate(endDate.getDate() - 3);
const startDate = new Date(endDate);
startDate.setDate(startDate.getDate() - 28);

const startStr = startDate.toISOString().slice(0, 10);
const endStr = endDate.toISOString().slice(0, 10);

console.log('Testing GSC connection...');
console.log(`Date range: ${startStr} → ${endStr}`);
console.log('');

const [perfResult, sitemapResult, oppResult, newsResult, zoneResult] = await Promise.all([
  getSearchPerformance(startStr, endStr, { rowLimit: 5 }),
  getSitemapHealth(),
  getSearchOpportunities(startStr, endStr),
  getNewsSearchPerformance(startStr, endStr, { rowLimit: 5 }),
  getOpportunityZoneQueries(startStr, endStr),
]);

console.log('=== getSearchPerformance ===');
if (perfResult.error) {
  console.error('ERROR:', perfResult.error, perfResult.message ?? '');
} else {
  console.log('OK');
  console.log(`  Rows returned: ${perfResult.rows?.length ?? 0}`);
  if (perfResult.rows?.length > 0) {
    perfResult.rows.slice(0, 3).forEach((r) => {
      console.log(`  - ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impressions, pos ${r.position.toFixed(1)}`);
    });
  }
}

console.log('');
console.log('=== getSitemapHealth ===');
if (sitemapResult.error) {
  console.error('ERROR:', sitemapResult.error, sitemapResult.message ?? '');
} else {
  console.log('OK');
  console.log(`  Sitemaps: ${sitemapResult.sitemaps?.length ?? 0}`);
  if (sitemapResult.sitemaps?.length > 0) {
    sitemapResult.sitemaps.slice(0, 3).forEach((s) => {
      console.log(`  - ${s.path}: ${s.errors} errors, ${s.warnings} warnings`);
    });
  }
}

console.log('');
console.log('=== getSearchOpportunities ===');
if (oppResult.error) {
  console.error('ERROR:', oppResult.error, oppResult.message ?? '');
} else {
  console.log('OK');
  console.log(`  Opportunities: ${oppResult.opportunities?.length ?? 0}`);
  if (oppResult.opportunities?.length > 0) {
    oppResult.opportunities.slice(0, 3).forEach((o) => {
      console.log(`  - ${o.query}: ${o.impressions} imp, ${o.ctr.toFixed(3)} CTR, pos ${o.position.toFixed(1)}`);
    });
  }
}

console.log('');
console.log('=== getNewsSearchPerformance ===');
if (newsResult.error) {
  console.error('ERROR:', newsResult.error, newsResult.message ?? '');
} else {
  console.log('OK');
  console.log(`  Rows returned: ${newsResult.rows?.length ?? 0}`);
  if (newsResult.note) console.log(`  Note: ${newsResult.note}`);
  if (newsResult.rows?.length > 0) {
    newsResult.rows.slice(0, 3).forEach((r) => {
      console.log(`  - ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impressions, pos ${r.position.toFixed(1)}`);
    });
  }
}

console.log('');
console.log('=== getOpportunityZoneQueries ===');
if (zoneResult.error) {
  console.error('ERROR:', zoneResult.error, zoneResult.message ?? '');
} else {
  console.log('OK');
  console.log(`  Rows: ${zoneResult.rows?.length ?? 0}`);
  if (zoneResult.note) console.log(`  Note: ${zoneResult.note}`);
  if (zoneResult.rows?.length > 0) {
    zoneResult.rows.slice(0, 3).forEach((r) => {
      console.log(`  - ${r.keys[0]}: ${r.impressions} imp, pos ${r.position.toFixed(1)}`);
    });
  }
}

console.log('');
console.log('=== getPagePerformance (sample URL) ===');
const sampleUrl = 'https://altwire.net/';
const pageResult = await getPagePerformance(sampleUrl, startStr, endStr);
if (pageResult.error) {
  console.error('ERROR:', pageResult.error, pageResult.message ?? '');
} else {
  console.log('OK');
  console.log(`  URL: ${pageResult.pageUrl}`);
  console.log(`  Clicks: ${pageResult.clicks}, Impressions: ${pageResult.impressions}, CTR: ${pageResult.ctr.toFixed(3)}, Position: ${pageResult.position ?? 'N/A'}`);
  if (pageResult.note) console.log(`  Note: ${pageResult.note}`);
}

console.log('');
console.log('Done.');