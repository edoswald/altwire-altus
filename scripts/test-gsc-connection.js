/**
 * scripts/test-gsc-connection.js
 *
 * Tests the altwire-gsc-client connection using the configured env vars.
 * Run: node scripts/test-gsc-connection.js
 *
 * Requires:
 *   ALTWIRE_GSC_SERVICE_ACCOUNT_JSON
 *   ALTWIRE_GSC_SITE_URL
 */

import { getSearchPerformance, getSearchOpportunities } from '../handlers/altwire-gsc-client.js';

const now = new Date();
const endDate = new Date(now);
endDate.setDate(endDate.getDate() - 3);
const startDate = new Date(endDate);
startDate.setDate(startDate.getDate() - 28);

const startStr = startDate.toISOString().slice(0, 10);
const endStr = endDate.toISOString().slice(0, 10);

console.log(`Testing GSC connection...`);
console.log(`Date range: ${startStr} → ${endStr}`);
console.log('');

const [perfResult, oppResult] = await Promise.all([
  getSearchPerformance(startStr, endStr, { rowLimit: 5 }),
  getSearchOpportunities(startStr, endStr),
]);

if (perfResult.error) {
  console.error('getSearchPerformance error:', perfResult.error);
} else {
  console.log('getSearchPerformance: OK');
  console.log(`  Rows returned: ${perfResult.rows?.length ?? 0}`);
  if (perfResult.rows?.length > 0) {
    perfResult.rows.slice(0, 3).forEach((r) => {
      console.log(`  - ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impressions, pos ${r.position.toFixed(1)}`);
    });
  }
}

console.log('');

if (oppResult.error) {
  console.error('getSearchOpportunities error:', oppResult.error);
} else {
  console.log('getSearchOpportunities: OK');
  console.log(`  Opportunities: ${oppResult.opportunities?.length ?? 0}`);
  if (oppResult.opportunities?.length > 0) {
    oppResult.opportunities.slice(0, 3).forEach((o) => {
      console.log(`  - ${o.query}: ${o.impressions} imp, ${o.ctr.toFixed(3)} CTR, pos ${o.position.toFixed(1)}`);
    });
  }
}

console.log('');
console.log('Done.');