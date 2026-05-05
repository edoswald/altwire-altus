/**
 * altus-incident-handler.js
 *
 * Better Stack incident and status update tools for AltWire.
 * Adapted from cirrusly-nimbus/better-stack-incidents.js for AltWire editorial context.
 *
 * Exports:
 *   getAltwireIncidentComments(incident_id)
 *   createAltwireIncidentComment(incident_id, content)
 *   getAltwireStatusUpdates(status_report_id)
 *   createAltwireStatusUpdate({ status_report_id, message, affected_resources, notify_subscribers })
 */

import { logger } from '../logger.js';

const BETTER_STACK_BASE = 'https://uptime.betterstack.com/api/v2';

async function bsFetch(path, method = 'GET', body = null) {
  const token = process.env.BETTER_STACK_TOKEN;
  if (!token) return { error: 'BETTER_STACK_TOKEN not configured' };

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BETTER_STACK_BASE}${path}`, opts);
  if (res.status === 204) return { deleted: true };
  if (res.status === 404) return { error: 'not_found', status: 404 };
  if (!res.ok) return { error: `betterstack_${res.status}`, status: res.status };

  return res.json();
}

export async function getAltwireIncidentComments(incident_id) {
  if (!incident_id) return { error: 'incident_id is required' };

  const result = await bsFetch(`/incidents/${incident_id}/comments`);
  if (result.error) return result;

  const comments = (result.data ?? []).map(c => ({
    id: c.id,
    content: c.attributes?.content,
    created_at: c.attributes?.created_at,
    updated_at: c.attributes?.updated_at,
  }));

  return { success: true, comments };
}

export async function createAltwireIncidentComment(incident_id, content) {
  if (!incident_id) return { success: false, exit_reason: 'validation_error', message: 'incident_id is required' };
  if (!content || !content.trim()) return { success: false, exit_reason: 'validation_error', message: 'content is required' };

  const result = await bsFetch(`/incidents/${incident_id}/comments`, 'POST', { content });
  if (result.error) return { success: false, exit_reason: 'api_error', message: result.error };

  const a = result.data?.attributes ?? {};
  return {
    success: true,
    comment: {
      id: result.data?.id,
      content: a.content,
      created_at: a.created_at,
    },
  };
}

function statusPagePath(suffix) {
  const pageId = process.env.BETTERSTACK_STATUS_PAGE_ID;
  if (!pageId) return null;
  return `/status-pages/${pageId}${suffix}`;
}

export async function getAltwireStatusUpdates(status_report_id) {
  if (!status_report_id) return { success: false, exit_reason: 'validation_error', message: 'status_report_id is required' };

  const path = statusPagePath(`/status-reports/${status_report_id}/status-updates`);
  if (!path) return { success: false, exit_reason: 'config_error', message: 'BETTERSTACK_STATUS_PAGE_ID not configured' };

  const result = await bsFetch(path);
  if (result.error) return { success: false, exit_reason: 'api_error', message: result.error };

  const updates = (result.data ?? []).map(u => ({
    id: u.id,
    message: u.attributes?.message,
    affected_resources: u.attributes?.affected_resources,
    created_at: u.attributes?.created_at,
    updated_at: u.attributes?.updated_at,
  }));

  return { success: true, updates };
}

export async function createAltwireStatusUpdate({ status_report_id, message, affected_resources, notify_subscribers = false }) {
  if (!status_report_id) return { success: false, exit_reason: 'validation_error', message: 'status_report_id is required' };
  if (!message || !message.trim()) return { success: false, exit_reason: 'validation_error', message: 'message is required' };

  const path = statusPagePath(`/status-reports/${status_report_id}/status-updates`);
  if (!path) return { success: false, exit_reason: 'config_error', message: 'BETTERSTACK_STATUS_PAGE_ID not configured' };

  const result = await bsFetch(path, 'POST', { message, affected_resources: affected_resources ?? [], notify_subscribers });
  if (result.error) return { success: false, exit_reason: 'api_error', message: result.error };

  const a = result.data?.attributes ?? {};
  return {
    success: true,
    update: {
      id: result.data?.id,
      message: a.message,
      affected_resources: a.affected_resources,
      notify_subscribers: a.notify_subscribers,
      created_at: a.created_at,
    },
  };
}