/**
 * Durable story opportunity queue for AltWire editorial signals.
 *
 * GSC/news discovery produces signals; this queue makes them actionable by
 * tracking status and optional writer assignment linkage.
 */

import crypto from 'crypto';
import pool, { hasDbConfig } from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { createAssignment } from './altus-writer.js';

const SOURCE_LABELS = {
  gsc_opportunity_zone: 'GSC opportunity zone',
  google_news: 'Google News',
  news_performer: 'Existing coverage',
};

const SOURCE_BEHAVIOR = {
  gsc_opportunity_zone: {
    opportunity_kind: 'optimization',
    recommendation_type: 'optimize_search',
    assignable: false,
  },
  google_news: {
    opportunity_kind: 'new_content',
    recommendation_type: 'cover_news',
    assignable: true,
  },
  news_performer: {
    opportunity_kind: 'optimization',
    recommendation_type: 'refresh_existing',
    assignable: false,
  },
};

function getOpportunityBehavior(source) {
  return SOURCE_BEHAVIOR[source] ?? {
    opportunity_kind: 'optimization',
    recommendation_type: 'investigate',
    assignable: false,
  };
}

export async function initOpportunityQueueSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_story_opportunities (
      id              SERIAL PRIMARY KEY,
      source_key      TEXT NOT NULL UNIQUE,
      source          TEXT NOT NULL DEFAULT 'gsc_opportunity_zone',
      topic           TEXT NOT NULL,
      url             TEXT,
      suggested_angle TEXT,
      priority        TEXT NOT NULL DEFAULT 'low'
                      CHECK (priority IN ('low', 'medium', 'high', 'critical')),
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'in_progress', 'assigned', 'completed', 'dismissed')),
      coverage_status TEXT,
      impressions     INTEGER DEFAULT 0,
      clicks          INTEGER DEFAULT 0,
      position        NUMERIC,
      score           NUMERIC DEFAULT 0,
      payload         JSONB,
      assignment_id   INTEGER REFERENCES altus_assignments(id) ON DELETE SET NULL,
      discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_at     TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS altus_story_opps_status_idx ON altus_story_opportunities (status, discovered_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_story_opps_source_idx ON altus_story_opportunities (source, discovered_at DESC)`);

  logger.info('Opportunity queue schema initialized');
}

function sourceKeyForOpportunity(opp) {
  const basis = ['gsc_opportunity_zone', opp.query ?? '', opp.page ?? ''].join(':');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function sourceKeyForNewsMatch(match) {
  const basis = ['google_news', match.query ?? '', (match.matched_items ?? []).join('|')].join(':');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function sourceKeyForNewsPage(page) {
  const pageUrl = page.keys?.[0] ?? '';
  const basis = ['news_performer', pageUrl].join(':');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function topicFromNewsPage(pageUrl) {
  try {
    const pathname = new URL(pageUrl).pathname;
    const slug = pathname.split('/').filter(Boolean).pop() ?? pageUrl;
    return slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || pageUrl;
  } catch {
    return String(pageUrl).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function classifyPriority(position) {
  if (position >= 5 && position <= 10) return 'high';
  if (position >= 11 && position <= 20) return 'medium';
  return 'low';
}

function formatMetricSnapshot(opp) {
  const pieces = [];
  if (Number.isFinite(opp.impressions)) pieces.push(`${Math.round(opp.impressions).toLocaleString()} impressions`);
  if (Number.isFinite(opp.position)) pieces.push(`average position ${Number(opp.position).toFixed(1)}`);
  return pieces.join(' and ');
}

function defaultAngle(opp) {
  const metrics = formatMetricSnapshot(opp);
  const metricsText = metrics ? `${metrics}. ` : '';

  if (opp.coverageStatus === 'no_coverage') {
    return `${metricsText}AltWire is already getting search demand for "${opp.query}" without a strong matching page. Build or substantially expand coverage so this query has a clear landing page to rank.`;
  }

  if (opp.coverageStatus === 'weak_coverage') {
    return `${metricsText}AltWire already appears for "${opp.query}", but the current coverage looks thin. Refresh the existing story, improve the headline and internal links, and add missing context to move it higher.`;
  }

  return `${metricsText}AltWire already ranks for "${opp.query}". Treat this as an optimization lead: tighten titles, update the copy, and strengthen internal links on the best-matching page.`;
}

export async function upsertStoryOpportunityQueue(storyResult = {}) {
  if (!hasDbConfig()) return { error: 'Database not configured' };

  const opportunities = storyResult.opportunities ?? [];
  let upserted = 0;

  for (const opp of opportunities) {
    const sourceKey = sourceKeyForOpportunity(opp);
    const topic = opp.query;
    if (!topic) continue;

    await pool.query(
      `INSERT INTO altus_story_opportunities
         (source_key, topic, url, suggested_angle, source, priority, coverage_status,
          impressions, clicks, position, score, payload)
       VALUES ($1, $2, $3, $4, 'gsc_opportunity_zone', $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (source_key) DO UPDATE SET
         suggested_angle = EXCLUDED.suggested_angle,
         priority = EXCLUDED.priority,
         coverage_status = EXCLUDED.coverage_status,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         position = EXCLUDED.position,
         score = EXCLUDED.score,
         payload = EXCLUDED.payload,
         updated_at = NOW()
       WHERE altus_story_opportunities.status IN ('pending', 'in_progress')`,
      [
        sourceKey,
        topic,
        opp.page ?? null,
        defaultAngle(opp),
        classifyPriority(opp.position),
        opp.coverageStatus ?? null,
        Math.round(opp.impressions ?? 0),
        Math.round(opp.clicks ?? 0),
        opp.position ?? null,
        opp.score ?? 0,
        JSON.stringify(opp),
      ],
    );
    upserted++;
  }

  return { success: true, upserted };
}

export async function upsertNewsOpportunityQueue(newsResult = {}) {
  if (!hasDbConfig()) return { error: 'Database not configured' };

  const matches = newsResult.watch_list_matches ?? [];
  const newsPages = newsResult.news_pages ?? [];
  let upserted = 0;

  for (const match of matches) {
    const topic = match.query;
    if (!topic) continue;
    const matchedItems = match.matched_items ?? [];
    const page = newsPages[0]?.keys?.[0] ?? null;
    const sourceKey = sourceKeyForNewsMatch(match);
    const impressions = Math.round(match.impressions ?? 0);
    const clicks = Math.round(match.clicks ?? 0);
    const suggestedAngle = matchedItems.length
      ? `Google News is surfacing "${topic}" and it matches AltWire watch item(s): ${matchedItems.join(', ')}.`
      : `Google News is surfacing "${topic}" for AltWire coverage review.`;

    await pool.query(
      `INSERT INTO altus_story_opportunities
         (source_key, topic, url, suggested_angle, source, priority, coverage_status,
          impressions, clicks, position, score, payload)
       VALUES ($1, $2, $3, $4, 'google_news', 'high', 'watch_list_match', $5, $6, NULL, $7, $8)
       ON CONFLICT (source_key) DO UPDATE SET
         suggested_angle = EXCLUDED.suggested_angle,
         priority = EXCLUDED.priority,
         coverage_status = EXCLUDED.coverage_status,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         score = EXCLUDED.score,
         payload = EXCLUDED.payload,
         updated_at = NOW()
       WHERE altus_story_opportunities.status IN ('pending', 'in_progress')`,
      [
        sourceKey,
        topic,
        page,
        suggestedAngle,
        impressions,
        clicks,
        impressions + clicks * 25,
        JSON.stringify(match),
      ],
    );
    upserted++;
  }

  for (const page of newsPages) {
    const pageUrl = page.keys?.[0];
    const clicks = Math.round(page.clicks ?? 0);
    if (!pageUrl || clicks <= 0) continue;

    const impressions = Math.round(page.impressions ?? 0);
    const position = page.position ?? null;
    const sourceKey = sourceKeyForNewsPage(page);
    const topic = topicFromNewsPage(pageUrl);
    const suggestedAngle = `This AltWire story is already earning Google News traffic. Refresh "${topic}" with the newest context, tighten the headline and dek, and strengthen internal links while the topic is still active.`;

    await pool.query(
      `INSERT INTO altus_story_opportunities
         (source_key, topic, url, suggested_angle, source, priority, coverage_status,
          impressions, clicks, position, score, payload)
       VALUES ($1, $2, $3, $4, 'news_performer', $5, 'existing_story', $6, $7, $8, $9, $10)
       ON CONFLICT (source_key) DO UPDATE SET
         suggested_angle = EXCLUDED.suggested_angle,
         priority = EXCLUDED.priority,
         coverage_status = EXCLUDED.coverage_status,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         position = EXCLUDED.position,
         score = EXCLUDED.score,
         payload = EXCLUDED.payload,
         updated_at = NOW()
       WHERE altus_story_opportunities.status IN ('pending', 'in_progress')`,
      [
        sourceKey,
        topic,
        pageUrl,
        suggestedAngle,
        classifyPriority(position),
        impressions,
        clicks,
        position,
        impressions + clicks * 25,
        JSON.stringify(page),
      ],
    );
    upserted++;
  }

  return { success: true, upserted };
}

function rowToOpportunity(row) {
  const behavior = getOpportunityBehavior(row.source);
  const discoveredAt = row.discovered_at instanceof Date
    ? row.discovered_at.toISOString()
    : row.discovered_at;
  const assignedAt = row.assigned_at instanceof Date
    ? row.assigned_at.toISOString()
    : row.assigned_at;
  const position = row.position === null || row.position === undefined ? null : Number(row.position);
  const score = row.score === null || row.score === undefined ? 0 : Number(row.score);

  return {
    id: row.id,
    title: row.topic,
    topic: row.topic,
    description: row.suggested_angle ?? '',
    suggested_angle: row.suggested_angle ?? '',
    category: row.coverage_status ?? row.source,
    priority: row.priority,
    urgency: row.priority === 'critical' ? 'high' : row.priority,
    status: row.status,
    source: SOURCE_LABELS[row.source] ?? row.source,
    url: row.url ?? undefined,
    discovered_at: discoveredAt,
    assigned_at: assignedAt ?? undefined,
    assignment_id: row.assignment_id ?? undefined,
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    position,
    score,
    coverage_status: row.coverage_status ?? '',
    opportunity_kind: behavior.opportunity_kind,
    recommendation_type: behavior.recommendation_type,
    assignable: behavior.assignable,
  };
}

export async function listStoryOpportunityQueue({ status = 'active', limit = 50 } = {}) {
  if (!hasDbConfig()) return { error: 'Database not configured' };

  const values = [];
  let where = '';
  if (status === 'active') {
    where = `WHERE status IN ('pending', 'in_progress')`;
  } else if (status && status !== 'all') {
    values.push(status);
    where = `WHERE status = $${values.length}`;
  }

  values.push(Math.min(100, Math.max(1, Number(limit) || 50)));
  const { rows } = await pool.query(
    `SELECT * FROM altus_story_opportunities
     ${where}
     ORDER BY
       CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       score DESC,
       discovered_at DESC
     LIMIT $${values.length}`,
    values,
  );

  return {
    success: true,
    opportunities: rows.map(rowToOpportunity),
  };
}

export async function assignStoryOpportunity({ id, article_type = 'article' }) {
  if (!hasDbConfig()) return { error: 'Database not configured' };

  const { rows } = await pool.query(
    `SELECT * FROM altus_story_opportunities WHERE id = $1`,
    [id],
  );
  const opportunity = rows[0];
  if (!opportunity) return { error: 'opportunity_not_found', id };
  const behavior = getOpportunityBehavior(opportunity.source);
  if (!behavior.assignable) {
    return { error: 'opportunity_not_assignable', id, status: opportunity.status, source: opportunity.source };
  }
  if (!['pending', 'in_progress'].includes(opportunity.status)) {
    return { error: 'opportunity_not_assignable', id, status: opportunity.status };
  }

  const assignmentResult = await createAssignment({
    topic: opportunity.topic,
    article_type,
  });
  if (assignmentResult.error || assignmentResult.success === false) return assignmentResult;

  const assignmentId = assignmentResult.assignment?.id ?? null;
  await pool.query(
    `UPDATE altus_story_opportunities
     SET status = 'assigned', assignment_id = $2, assigned_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING id, status, assignment_id`,
    [id, assignmentId],
  );

  return {
    success: true,
    opportunity_id: id,
    assignment: assignmentResult.assignment,
  };
}
