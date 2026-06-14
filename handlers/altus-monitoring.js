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

    const mapMonitor = (json) => ({
      status: json.data.attributes.status,
      last_checked_at: json.data.attributes.last_checked_at,
      url: json.data.attributes.url,
    });

    // Fetch each monitor independently so one missing/failing monitor
    // (e.g. a deleted wp-cron monitor returning 404) doesn't blank out
    // the status of the others in the digest.
    const fetchMonitor = async (id) => {
      try {
        const res = await fetch(`${BETTER_STACK_BASE}/monitors/${id}`, { headers });
        if (res.status === 404) return { status: 'not_monitored', error: 'monitor_not_found', monitor_id: id };
        if (!res.ok) return { status: 'unknown', error: 'Better Stack API error', http_status: res.status };
        return mapMonitor(await res.json());
      } catch (err) {
        return { status: 'unknown', error: err.message };
      }
    };

    const [site, wp_cron] = await Promise.all([
      fetchMonitor(MONITORS.site),
      fetchMonitor(MONITORS.wp_cron),
    ]);

    return { site, wp_cron };
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
