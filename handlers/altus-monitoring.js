/**
 * Better Stack monitoring handlers.
 * Fetches uptime status and open incidents for AltWire monitors.
 */

import { logger } from '../logger.js';

const BETTER_STACK_BASE = 'https://uptime.betterstack.com/api/v2';
const MONITORS = {
  site: '1881007',
  wp_cron: '2836297',
};

/**
 * Fetch live uptime status for AltWire's site and wp_cron monitors.
 * @returns {Promise<object>} { site: {...}, wp_cron: {...} } or { error: string }
 */
export async function getAltwireUptime() {
  if (process.env.TEST_MODE === 'true') {
    return {
      test_mode: true,
      site: {
        status: 'up',
        last_checked_at: '2025-01-01T00:00:00Z',
        url: 'https://altwire.net',
      },
      wp_cron: {
        status: 'up',
        last_checked_at: '2025-01-01T00:00:00Z',
        url: 'https://altwire.net/wp-cron.php',
      },
    };
  }

  if (!process.env.BETTER_STACK_TOKEN) {
    return { error: 'BETTER_STACK_TOKEN not configured' };
  }

  try {
    const headers = {
      Authorization: `Bearer ${process.env.BETTER_STACK_TOKEN}`,
    };

    const [siteRes, wpCronRes] = await Promise.all([
      fetch(`${BETTER_STACK_BASE}/monitors/${MONITORS.site}`, { headers }),
      fetch(`${BETTER_STACK_BASE}/monitors/${MONITORS.wp_cron}`, { headers }),
    ]);

    if (!siteRes.ok || !wpCronRes.ok) {
      const failedStatus = !siteRes.ok ? siteRes.status : wpCronRes.status;
      return { error: `Better Stack API error`, status: failedStatus };
    }

    const [siteJson, wpCronJson] = await Promise.all([
      siteRes.json(),
      wpCronRes.json(),
    ]);

    const mapMonitor = (json) => ({
      status: json.data.attributes.status,
      last_checked_at: json.data.attributes.last_checked_at,
      url: json.data.attributes.url,
    });

    return {
      site: mapMonitor(siteJson),
      wp_cron: mapMonitor(wpCronJson),
    };
  } catch (err) {
    logger.error('getAltwireUptime failed', { error: err.message });
    return { error: err.message };
  }
}

/**
 * Fetch open incidents for AltWire's site and wp_cron monitors.
 * @returns {Promise<object>} { site: [...], wp_cron: [...] } or { error: string }
 */
export async function getAltwireIncidents() {
  if (process.env.TEST_MODE === 'true') {
    return { test_mode: true, site: [], wp_cron: [] };
  }

  if (!process.env.BETTER_STACK_TOKEN) {
    return { error: 'BETTER_STACK_TOKEN not configured' };
  }

  try {
    const headers = {
      Authorization: `Bearer ${process.env.BETTER_STACK_TOKEN}`,
    };

    const [siteRes, wpCronRes] = await Promise.all([
      fetch(
        `${BETTER_STACK_BASE}/incidents?monitor_id=${MONITORS.site}&resolved=false&per_page=5`,
        { headers },
      ),
      fetch(
        `${BETTER_STACK_BASE}/incidents?monitor_id=${MONITORS.wp_cron}&resolved=false&per_page=5`,
        { headers },
      ),
    ]);

    if (!siteRes.ok || !wpCronRes.ok) {
      const failedStatus = !siteRes.ok ? siteRes.status : wpCronRes.status;
      return { error: 'Better Stack API error', status: failedStatus };
    }

    const [siteJson, wpCronJson] = await Promise.all([
      siteRes.json(),
      wpCronRes.json(),
    ]);

    const mapIncidents = (json) =>
      (json.data || []).map((item) => ({
        name: item.attributes.name,
        started_at: item.attributes.started_at,
        cause: item.attributes.cause,
      }));

    return {
      site: mapIncidents(siteJson),
      wp_cron: mapIncidents(wpCronJson),
    };
  } catch (err) {
    logger.error('getAltwireIncidents failed', { error: err.message });
    return { error: err.message };
  }
}
