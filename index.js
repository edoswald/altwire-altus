/**
 * Altus MCP Server — AltWire AI Operations
 *
 * 45 tools: RAG archive, analytics, editorial intelligence, review tracker,
 * watch list, and AI Writer pipeline.
 * Transport: StreamableHTTP (stateless — sessionIdGenerator: undefined)
 * Health: GET /health
 */

import { sessionIdStorage } from './lib/safe-tool-handler.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { z } from 'zod';
import { logger } from './logger.js';
import pool, { initSchema } from './lib/altus-db.js';
import { safeToolHandler } from './lib/safe-tool-handler.js';
import { searchAltwireArchive } from './handlers/altus-search.js';
import { reIngestHandler } from './handlers/altus-reingest.js';
import { getArchiveStats } from './handlers/altus-stats.js';
import { getContentByUrl } from './handlers/altus-fetch.js';
import { analyzeCoverageGaps } from './handlers/altus-coverage.js';
import { getTrafficSummary, getReferrerBreakdown, getTopPages, getSiteSearch } from './handlers/altwire-matomo-client.js';
import { getSearchPerformance, getSearchOpportunities, getSitemapHealth } from './handlers/altwire-gsc-client.js';
import { generateChart } from './hal-chart.js';
import { getStoryOpportunities } from './handlers/altus-topic-discovery.js';
import { getNewsOpportunities, runNewsMonitorCron } from './handlers/altus-news-monitor.js';
import { getArticlePerformance, getNewsPerformancePatterns, runPerformanceSnapshotCron } from './handlers/altus-performance-tracker.js';
import { searchAltwirePublic, getSearchFeedback } from './handlers/altwire-search.js';
import { emitEvent, getEvents, clearBus, hasEvents } from './lib/altus-event-bus.js';
import { startIngestCron } from './lib/ingest-cron.js';
import cron from 'node-cron';
import { initAiUsageSchema } from './lib/ai-cost-tracker.js';
import {
  initReviewTrackerSchema,
  createReview, updateReview, getReview, listReviews, getUpcomingReviewDeadlines,
  logLoaner, updateLoaner, getLoaner, listLoaners, getOverdueLoaners, getUpcomingLoanerReturns,
  addReviewNote, updateReviewNote, listReviewNotes, deleteReviewNote,
  getEditorialDigest,
} from './handlers/review-tracker-handler.js';
import {
  initWatchListSchema,
  addWatchSubject,
  removeWatchSubject,
  listWatchSubjects,
} from './handlers/altus-watch-list.js';
import {
  initWriterSchema,
  createAssignment,
  generateOutline,
  approveOutline,
  generateDraft,
  factCheckDraft,
  postToWordPress,
  getDraftAsHtml,
  logEditorialDecision,
  getAssignment,
  listAssignments,
} from './handlers/altus-writer.js';
import { initOAuthSchema } from './lib/oauth-store.js';
import { createRateLimiter } from './lib/rate-limiter.js';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export const oauthClientStorage = new AsyncLocalStorage();

const PORT = process.env.PORT || 3000;

// Rate limiters
const globalLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });

// OAuth Configuration
// Discover clients by scanning OAUTH_CLIENT_ID_* env vars at startup.
// Each OAUTH_CLIENT_ID_<OPERATOR> pairs with OAUTH_CLIENT_SECRET_<OPERATOR>.
function discoverOAuthClients() {
  const clients = new Map();
  for (const [key, clientId] of Object.entries(process.env)) {
    if (key.startsWith('OAUTH_CLIENT_ID_') && clientId) {
      const operator = key.slice('OAUTH_CLIENT_ID_'.length);
      clients.set(clientId, operator);
    }
  }
  return clients;
}

const OAUTH_CLIENTS = discoverOAuthClients();

const MCP_BASE_URL = process.env.MCP_BASE_URL || 'https://altus.altwire.net';

const OAUTH_ALLOWED_REDIRECT_URIS = new Set([
  process.env.OAUTH_REDIRECT_URI || `${MCP_BASE_URL}/oauth/callback`,
  ...(process.env.OAUTH_ALLOWED_REDIRECT_URIS || '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean),
]);

function generateAuthCode() {
  return crypto.randomBytes(32).toString('hex');
}

function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Parse OAUTH_CLIENT_TOOLS → Map<clientId, Set<toolName>>
// Format: "clientId1:tool1,tool2;clientId2:tool1"
function parseClientTools() {
  const map = new Map();
  const raw = process.env.OAUTH_CLIENT_TOOLS;
  if (!raw) return map;
  for (const entry of raw.split(';')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const clientId = entry.slice(0, colonIdx).trim();
    const tools = entry.slice(colonIdx + 1).split(',').map(t => t.trim()).filter(Boolean);
    map.set(clientId, new Set(tools));
  }
  return map;
}

const OAUTH_CLIENT_TOOLS = parseClientTools();
// ---------------------------------------------------------------------------
// Tool scoping — maps tool names to allowed agent contexts.
// Tool is registered only if its contexts array is empty (no restriction)
// or contains the current agentContext.
// ---------------------------------------------------------------------------
const TOOL_CONTEXTS = {
  // AltWire content intelligence — always available
  search_altwire_archive:      [],
  reingest_altwire_archive:    [],
  get_archive_stats:           [],
  get_content_by_url:          [],
  analyze_coverage_gaps:       [],
  // AltWire analytics — always available
  get_altwire_site_analytics:  [],
  get_altwire_traffic_sources: [],
  get_altwire_top_pages:       [],
  get_altwire_site_search:     [],
  get_altwire_search_performance:   [],
  get_altwire_search_opportunities: [],
  get_altwire_sitemap_health:  [],
  // Editorial intelligence
  get_story_opportunities:      [],
  get_news_opportunities:       [],
  get_article_performance:      [],
  get_news_performance_patterns: [],
  // Chart (shared)
  generate_chart:              [],
  // Monitoring
  get_altwire_uptime:          [],
  get_altwire_incidents:       [],
  get_altwire_morning_digest:  [],
  // Review tracker
  altus_create_review:          [],
  altus_update_review:          [],
  altus_get_review:             [],
  altus_list_reviews:           [],
  altus_get_upcoming_review_deadlines: [],
  altus_log_loaner:             [],
  altus_update_loaner:          [],
  altus_get_loaner:             [],
  altus_list_loaners:           [],
  altus_get_overdue_loaners:   [],
  altus_get_upcoming_loaner_returns: [],
  altus_add_review_note:       [],
  altus_update_review_note:    [],
  altus_list_review_notes:     [],
  altus_delete_review_note:    [],
  altus_get_editorial_digest:   [],
  // Watch list
  altus_add_watch_subject:     [],
  altus_remove_watch_subject:  [],
  altus_list_watch_subjects:   [],
  // AI Writer pipeline
  create_article_assignment:   [],
  generate_article_outline:    [],
  approve_outline:             [],
  generate_article_draft:      [],
  fact_check_draft:            [],
  post_to_wordpress:           [],
  get_draft_as_html:           [],
  log_editorial_decision:      [],
  get_article_assignment:     [],
  list_article_assignments:   [],
  // Slack status (Altus outbound)
  post_slack_status:           [],
  get_slack_post_history:     [],
  // Hal memory — nimbus-only tools (scoped to 'nimbus' agentContext)
  hal_read_memory:             ['nimbus'],
  hal_write_memory:            ['nimbus'],
  hal_list_memory:             ['nimbus'],
  // Altus editorial tools
  track_article:              [],
  list_tracked_articles:      [],
  add_content_idea:            [],
  get_content_ideas:           [],
  // Link evaluation
  evaluate_link_fitness:       [],
  // Author profile
  get_author_profile:           [],
  update_author_profile:         [],
  // Better Stack incident management
  altus_get_incident_comments:  [],
  altus_post_incident_comment:  [],
  altus_get_status_updates:     [],
  altus_post_status_update:     [],
  // Event log tools
  query_altus_events:           [],
  get_altus_audit_log:          [],
};

// Canonical context names for the X-Agent-Context header values.
// Add new contexts here as they are introduced.
const TOOL_CONTEXT_NAMES = ['altwire', 'weather', 'nimbus'];


// Schema init — runs once at startup (all are fire-and-forget, non-blocking)
  // Each logs errors rather than crashing so the MCP server can start regardless.
  // ---------------------------------------------------------------------------
  const altusDbUrl = process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL;
  if (altusDbUrl) {
    initSchema().catch((err) => {
      logger.error('Schema init failed', { error: err.message, code: err.code });
    });
    initAiUsageSchema().catch((err) => {
      logger.error('AI usage schema init failed', { error: err.message, code: err.code });
    });
    initOAuthSchema().catch((err) => {
      logger.error('OAuth schema init failed', { error: err.message, code: err.code });
    });
    initReviewTrackerSchema().catch((err) => {
      logger.error('Review tracker schema init failed', { error: err.message, code: err.code });
    });
    initWatchListSchema().catch((err) => {
      logger.error('Watch list schema init failed', { error: err.message, code: err.code });
    });
    initWriterSchema().catch((err) => {
      logger.error('Writer schema init failed', { error: err.message, code: err.code });
    });

    // Event log schema (non-blocking)
    import('./altus-event-log.js')
      .then(({ initAltusEventLogSchema }) => initAltusEventLogSchema().catch(err => {
        logger.error('Altus event log schema init failed', { error: err.message, code: err.code });
      }))
      .catch(err => logger.error('altus-event-log: import failed', { error: err.message }));

    // Heartbeat schema (non-blocking)
    import('./handlers/altus-heartbeat.js')
      .then(({ initHeartbeatSchema }) => initHeartbeatSchema().catch(err => {
        logger.error('Altus heartbeat schema init failed', { error: err.message, code: err.code });
      }))
      .catch(err => logger.error('altus-heartbeat: import failed', { error: err.message }));

    // Slack schema init (non-blocking)
    import('./handlers/slack-altus.js')
      .then(({ initSlackAltusSchema, initSlackAltus }) => {
        return initSlackAltusSchema().then(() => initSlackAltus());
      })
      .catch(err => logger.error('slack-altus: init import failed', { error: err.message, code: err.code, stack: err.stack }));

  startIngestCron();

  // News Monitor — 9 AM ET daily
  cron.schedule('0 9 * * *', () => runNewsMonitorCron(), { timezone: 'America/New_York' });

  // Performance Snapshot — 6 AM ET daily
  cron.schedule('0 6 * * *', () => runPerformanceSnapshotCron(), { timezone: 'America/New_York' });

  // AltWire Nightly Reflection — 5 AM ET daily
  cron.schedule('0 5 * * *', async () => {
    try {
      const { runAltwireReflection } = await import('./handlers/altus-reflection.js');
      await runAltwireReflection();
    } catch (err) {
      logger.error('AltWire reflection cron failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // Altus Heartbeat — every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    try {
      const { runAltusHeartbeat } = await import('./handlers/altus-heartbeat.js');
      await runAltusHeartbeat();
    } catch (err) {
      logger.error('Altus heartbeat cron failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // Altus Event Log Retention — 3 AM ET daily
  cron.schedule('0 3 * * *', async () => {
    try {
      const { runRetentionCron } = await import('./altus-event-log.js');
      await runRetentionCron();
    } catch (err) {
      logger.error('Altus event retention cron failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // Altus Audit Batch Collection — every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    try {
      const { runAuditBatchCollection } = await import('./altus-event-log.js');
      await runAuditBatchCollection();
    } catch (err) {
      logger.error('Altus audit batch collection cron failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });
} else {
  logger.warn('No database URL set — ALTWIRE_DATABASE_URL and DATABASE_URL are both empty — skipping schema init and cron');
}

// ---------------------------------------------------------------------------
// MCP Server factory — new instance per stateless request
// ---------------------------------------------------------------------------
async function createMcpServer({ agentContext = null, allowedTools = null, clientId = null } = {}) {
  const server = new McpServer({
    name: 'altwire-altus',
    version: '1.0.0',
  });


  /**
   * Scoped tool registration — only registers the tool if:
   *   - TOOL_CONTEXTS[toolName] is empty/undefined (no restriction), OR
   *   - the current agentContext is in TOOL_CONTEXTS[toolName]
   * This allows a single server instance to serve multiple agents (AltWire, CW, nimbus)
   * while restricting nimbus-only tools to the nimbus agentContext.
   *
   * @param {string} toolName
   * @param {object} inputSchema
   * @param {function} handler
   */
  function scopedRegister(toolName, inputSchema, handler) {
    const allowed = TOOL_CONTEXTS[toolName];
    if (!allowed || allowed.length === 0 || (agentContext && allowed.includes(agentContext))) {
      server.registerTool(toolName, inputSchema, safeToolHandler(toolName, handler));
    }
  }

  // -------------------------------------------------------------------------
  // Tool: search_altwire_archive
  // -------------------------------------------------------------------------
  scopedRegister(
    'search_altwire_archive',
    {
      description: 'Searches the AltWire content archive using semantic similarity. Returns relevant articles, reviews, and galleries based on the query. Use this to understand how AltWire has previously covered an artist or topic.',
      inputSchema: {
        query: z.string().describe('The search query — artist name, topic, or concept'),
        limit: z.number().int().min(1).max(20).default(5).describe('Number of results to return'),
        content_type: z
          .enum(['post', 'gallery', 'all'])
          .default('all')
          .describe('Filter by content type'),
      },
    },
    safeToolHandler(async ({ query, limit, content_type }) => {
      const result = await searchAltwireArchive({ query, limit, content_type });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    })
  );

  // -------------------------------------------------------------------------
  // Tool: search_altwire (public-facing AI search)
  // -------------------------------------------------------------------------
  scopedRegister(
    'search_altwire',
    {
      description: 'Public AI-powered search for AltWire. Embeds the query via Voyage AI, searches altus_content for relevant articles using cosine similarity, and synthesizes an answer with MiniMax-2.7. Returns an AI-generated answer with cited sources and ranked results.',
      inputSchema: {
        query: z.string().describe('The search query — artist name, topic, concept, or question'),
        limit: z.number().int().min(1).max(20).default(10).optional()
          .describe('Maximum number of results to retrieve (default 10)'),
      },
    },
    safeToolHandler(async ({ query, limit }) => {
      const result = await searchAltwirePublic({ query, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    })
  );

  // -------------------------------------------------------------------------
  // Tool: get_search_feedback (for Hal to review beta feedback)
  // -------------------------------------------------------------------------
  scopedRegister(
    'get_search_feedback',
    {
      description: 'Retrieves search feedback submitted by readers during the AI search beta. Use this to review what users are saying about search quality, accuracy, and relevance. Filter by rating (1=thumbs down, 2=thumbs up) or date.',
      inputSchema: {
        rating: z.number().int().optional()
          .describe('Filter by rating — 1 = thumbs down, 2 = thumbs up'),
        since: z.string().optional()
          .describe('Return feedback created after this ISO date'),
        limit: z.number().int().min(1).max(200).default(50).optional()
          .describe('Maximum number of feedback entries to return (default 50)'),
      },
    },
    safeToolHandler(async ({ rating, since, limit }) => {
      const result = await getSearchFeedback({ rating, since, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Tool: reingest_altwire_archive
  // -------------------------------------------------------------------------
  scopedRegister(
    'reingest_altwire_archive',
    {
      description: 'Re-runs the AltWire content ingestion pipeline. Pulls all published posts and galleries from WordPress, regenerates embeddings, and upserts to the archive. Use this after publishing new content or to refresh the index. Takes 3-5 minutes to complete.',
      inputSchema: {
        mode: z.enum(['full', 'recent']).default('recent')
          .describe('full = all 1500+ documents; recent = posts published in the last 30 days only'),
        dry_run: z.boolean().default(false)
          .describe('If true, fetches and processes content but does not write to the database'),
      },
    },
    safeToolHandler(async ({ mode, dry_run }) => {
      const result = await reIngestHandler({ mode, dry_run });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Tool: get_archive_stats
  // -------------------------------------------------------------------------
  scopedRegister(
    'get_archive_stats',
    {
      description: 'Returns health and coverage statistics for the AltWire content archive — total documents indexed, breakdown by type, last ingest run, and any errors.',
    },
    safeToolHandler(async () => {
      const result = await getArchiveStats();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Tool: get_content_by_url
  // -------------------------------------------------------------------------
  scopedRegister(
    'get_content_by_url',
    {
      description: 'Retrieves a specific piece of content from the AltWire archive by its URL or slug. Use when a specific article or gallery is referenced by name or link rather than by topic.',
      inputSchema: {
        url: z.string().optional()
          .describe('Full URL of the content, e.g. https://altwire.net/my-chemical-romance-philadelphia/'),
        slug: z.string().optional()
          .describe('URL slug only, e.g. my-chemical-romance-philadelphia'),
      },
    },
    safeToolHandler(async ({ url, slug }) => {
      if (!url && !slug) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Either url or slug must be provided' }) }] };
      }
      const result = await getContentByUrl({ url, slug });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Tool: analyze_coverage_gaps
  // -------------------------------------------------------------------------
  scopedRegister(
    'analyze_coverage_gaps',
    {
      description: 'Analyzes how thoroughly AltWire has covered a specific artist or topic. Returns a plain-English assessment of what exists, what\'s missing, and editorial opportunities.',
      inputSchema: {
        subject: z.string()
          .describe('Artist name, band name, or topic to analyze — e.g. "Paramore", "shoegaze", "festival coverage"'),
        limit: z.number().int().min(5).max(20).default(10)
          .describe('Maximum number of archive results to analyze'),
      },
    },
    safeToolHandler(async ({ subject, limit }) => {
      const result = await analyzeCoverageGaps({ subject, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // AltWire Analytics — Matomo
  // -------------------------------------------------------------------------

  scopedRegister(
    'get_altwire_site_analytics',
    {
      description: 'AltWire traffic summary for a period — visits, unique visitors, pageviews, bounce rate. Use to assess overall site health and content performance trends.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).describe('Time period'),
        date: z.string().describe('Matomo date — ISO date or keyword like yesterday, today'),
      },
    },
    safeToolHandler(async ({ period, date }) => {
      const result = await getTrafficSummary(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_traffic_sources',
    {
      description: 'AltWire referrer breakdown — where readers are coming from. Includes social media, organic search, direct, and campaign referrers. Use to understand content distribution channel performance.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).describe('Time period'),
        date: z.string().describe('Matomo date — ISO date or keyword like yesterday, today'),
      },
    },
    safeToolHandler(async ({ period, date }) => {
      const result = await getReferrerBreakdown(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_top_pages',
    {
      description: 'AltWire most-viewed articles, entry pages, and exit pages for a period. Use to identify best-performing content and high-exit pages that may need improvement.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).describe('Time period'),
        date: z.string().describe('Matomo date — ISO date or keyword like yesterday, today'),
      },
    },
    safeToolHandler(async ({ period, date }) => {
      const result = await getTopPages(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_site_search',
    {
      description: 'AltWire internal search terms — what readers are searching for on the site. Useful for identifying content gaps and topics with reader demand.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).describe('Time period'),
        date: z.string().describe('Matomo date — ISO date or keyword like yesterday, today'),
      },
    },
    safeToolHandler(async ({ period, date }) => {
      const result = await getSiteSearch(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // AltWire Analytics — Google Search Console
  // -------------------------------------------------------------------------

  scopedRegister(
    'get_altwire_search_performance',
    {
      description: 'AltWire Google Search Console data — queries driving organic traffic, impressions, clicks, CTR, and average position. Use to identify which content is ranking and where there\'s room to improve.',
      inputSchema: {
        start_date: z.string().describe('Start date — ISO format, e.g. 2024-06-01'),
        end_date: z.string().describe('End date — ISO format, e.g. 2024-06-30'),
        row_limit: z.number().int().min(1).max(1000).default(25).optional().describe('Max rows to return (default 25)'),
        dimensions: z.string().optional().describe('Dimensions to group by — e.g. query, page, country. Default: query'),
      },
    },
    safeToolHandler(async ({ start_date, end_date, row_limit, dimensions }) => {
      const result = await getSearchPerformance(start_date, end_date, { rowLimit: row_limit, dimensions });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_search_opportunities',
    {
      description: 'AltWire high-impression, low-CTR search queries — topics where AltWire appears in results but readers aren\'t clicking. These are candidates for title tag or meta description improvements, or stronger content on those topics.',
      inputSchema: {
        start_date: z.string().describe('Start date — ISO format, e.g. 2024-06-01'),
        end_date: z.string().describe('End date — ISO format, e.g. 2024-06-30'),
      },
    },
    safeToolHandler(async ({ start_date, end_date }) => {
      const result = await getSearchOpportunities(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_sitemap_health',
    {
      description: 'Check GSC sitemap fetch status for altwire.net. Returns fetch status, last crawl date, and coverage counts. Alerts if sitemap is stale or unfetchable.',
    },
    safeToolHandler(async () => {
      const result = await getSitemapHealth();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Editorial Intelligence — Topic Discovery & News Monitoring
  // -------------------------------------------------------------------------

  scopedRegister(
    'get_story_opportunities',
    {
      description: 'Cross-references GSC opportunity-zone queries (position 5–30) against the AltWire archive to surface story opportunities where search demand exists but coverage is thin. Uses Haiku to synthesize editorial pitches.',
      inputSchema: {
        days: z.number().int().min(7).max(90).default(28)
          .describe('Lookback window in days for GSC data (default 28)'),
      },
    },
    safeToolHandler(async ({ days }) => {
      const result = await getStoryOpportunities({ days });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_news_opportunities',
    {
      description: 'Tracks GSC News search type data and cross-references with the watch list to surface News coverage opportunities and alert on watch list activity.',
      inputSchema: {
        days: z.number().int().min(1).max(30).default(7)
          .describe('Lookback window in days for News data (default 7)'),
      },
    },
    safeToolHandler(async ({ days }) => {
      const result = await getNewsOpportunities({ days });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_article_performance',
    {
      description: 'Returns post-publish GSC performance snapshots (72h, 7d, 30d) for tracked articles. Use to check how published content is performing in Google Search.',
      inputSchema: {
        article_url: z.string().optional()
          .describe('Full article URL — omit to get aggregate for most recent 20 articles'),
        snapshot_type: z.enum(['72h', '7d', '30d']).optional()
          .describe('Filter to a specific snapshot interval'),
      },
    },
    safeToolHandler(async ({ article_url, snapshot_type }) => {
      const result = await getArticlePerformance({ article_url, snapshot_type });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_news_performance_patterns',
    {
      description: 'Analyzes which content types get Google News pickup — groups News-appearing articles by category and tag to identify patterns for optimizing News visibility.',
      inputSchema: {
        days: z.number().int().min(7).max(90).default(30)
          .describe('Lookback window in days for News performance data (default 30)'),
      },
    },
    safeToolHandler(async ({ days }) => {
      const result = await getNewsPerformancePatterns({ days });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Review & Loaner Tracker
  // -------------------------------------------------------------------------

  scopedRegister(
    'altus_create_review',
    {
      description: 'Create a new review assignment. Reviewer defaults to Derek if not specified.',
      inputSchema: {
        title: z.string().describe('Review title — e.g. "Fender Telecaster Player II review"'),
        product: z.string().optional().describe('Product or topic being reviewed'),
        reviewer: z.string().default('Derek').optional().describe('Reviewer name — defaults to Derek'),
        status: z.enum(['assigned', 'in_progress', 'submitted', 'editing', 'scheduled', 'published', 'cancelled']).optional().describe('Pipeline status — defaults to assigned'),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date — ISO YYYY-MM-DD'),
        wp_post_id: z.number().int().optional().describe('WordPress post ID if published/scheduled'),
        notes: z.string().optional().describe('Internal editorial notes'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review: { id: 1, title: params.title, reviewer: params.reviewer || 'Derek', status: 'assigned' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await createReview(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_update_review',
    {
      description: 'Update a review — change status, reassign, update due date, add editorial notes, record WordPress post ID.',
      inputSchema: {
        review_id: z.number().int().positive().describe('Review ID'),
        title: z.string().optional().describe('Updated title'),
        product: z.string().optional().describe('Updated product/topic'),
        reviewer: z.string().optional().describe('Reassign to reviewer'),
        status: z.enum(['assigned', 'in_progress', 'submitted', 'editing', 'scheduled', 'published', 'cancelled']).optional().describe('New pipeline status'),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Updated due date — ISO YYYY-MM-DD'),
        wp_post_id: z.number().int().optional().describe('WordPress post ID'),
        notes: z.string().optional().describe('Updated notes'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review: { id: params.review_id, status: params.status || 'assigned' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await updateReview(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_review',
    {
      description: 'Fetch full review details by ID.',
      inputSchema: {
        review_id: z.number().int().positive().describe('Review ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review: { id: params.review_id, title: 'Test Review', reviewer: 'Derek', status: 'assigned' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getReview(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_list_reviews',
    {
      description: 'List reviews with optional filters: status, reviewer.',
      inputSchema: {
        status: z.enum(['assigned', 'in_progress', 'submitted', 'editing', 'scheduled', 'published', 'cancelled']).optional().describe('Filter by pipeline status'),
        reviewer: z.string().optional().describe('Filter by reviewer name'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, reviews: [], count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listReviews(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_upcoming_review_deadlines',
    {
      description: 'Reviews due within the next N days (default 7), excluding completed/cancelled.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).optional().describe('Lookahead window in days — default 7'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, reviews: [], count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getUpcomingReviewDeadlines(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_log_loaner',
    {
      description: 'Log a review item received. Records whether it\'s a loaner (with optional return deadline) or a keeper. Defaults to Derek as recipient.',
      inputSchema: {
        item_name: z.string().describe('Item name — e.g. "Fender Telecaster Player II (Sonic Blue)"'),
        brand: z.string().optional().describe('Brand name'),
        borrower: z.string().default('Derek').optional().describe('Who has the item — defaults to Derek'),
        is_loaner: z.boolean().default(true).optional().describe('true = loaner with return expected; false = keeper'),
        expected_return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Expected return date — ISO YYYY-MM-DD'),
        review_id: z.number().int().positive().optional().describe('Link to a review by ID'),
        notes: z.string().optional().describe('Notes — serial number, condition, etc.'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaner: { id: 1, item_name: params.item_name, borrower: params.borrower || 'Derek', status: params.is_loaner === false ? 'kept' : 'out' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await logLoaner(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_update_loaner',
    {
      description: 'Update a loaner record — mark returned, convert to keeper, change return date, update status.',
      inputSchema: {
        loaner_id: z.number().int().positive().describe('Loaner ID'),
        item_name: z.string().optional().describe('Updated item name'),
        brand: z.string().optional().describe('Updated brand'),
        borrower: z.string().optional().describe('Reassign to borrower'),
        is_loaner: z.boolean().optional().describe('Set to false to convert to keeper'),
        status: z.enum(['out', 'kept', 'returned', 'overdue', 'lost']).optional().describe('New status'),
        expected_return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Updated return date — ISO YYYY-MM-DD'),
        actual_return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Actual return date — auto-set when status=returned'),
        review_id: z.number().int().positive().optional().describe('Link to a review by ID'),
        notes: z.string().optional().describe('Updated notes'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaner: { id: params.loaner_id, status: params.status || 'out' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await updateLoaner(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_loaner',
    {
      description: 'Fetch full details of a specific loaner item.',
      inputSchema: {
        loaner_id: z.number().int().positive().describe('Loaner ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaner: { id: params.loaner_id, item_name: 'Test Item', borrower: 'Derek', status: 'out' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getLoaner(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_list_loaners',
    {
      description: 'List loaner items with optional filters: status, borrower.',
      inputSchema: {
        status: z.enum(['out', 'kept', 'returned', 'overdue', 'lost']).optional().describe('Filter by status'),
        borrower: z.string().optional().describe('Filter by borrower name'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaners: [], count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listLoaners(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_overdue_loaners',
    {
      description: 'All loaner items past their expected return date not yet returned.',
    },
    safeToolHandler(async () => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaners: [], count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getOverdueLoaners();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_upcoming_loaner_returns',
    {
      description: 'Loaner items expected back within the next N days (default 14).',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).optional().describe('Lookahead window in days — default 14'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaners: [], count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getUpcomingLoanerReturns(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_add_review_note',
    {
      description: 'Add a check-in note to a review. If category not specified, Hal auto-classifies it as pro/con/observation.',
      inputSchema: {
        review_id: z.number().int().positive().describe('Review ID to add note to'),
        note_text: z.string().describe('The note text — e.g. "poor battery life"'),
        category: z.enum(['pro', 'con', 'observation', 'uncategorized']).optional().describe('Note category — auto-classified if omitted'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, note: { id: 1, review_id: params.review_id, note_text: params.note_text, category: params.category || 'pro' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await addReviewNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_update_review_note',
    {
      description: 'Correct a note\'s text or category.',
      inputSchema: {
        note_id: z.number().int().positive().describe('Note ID'),
        note_text: z.string().optional().describe('Updated note text'),
        category: z.enum(['pro', 'con', 'observation', 'uncategorized']).optional().describe('Corrected category'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, note: { id: params.note_id, category: params.category || 'pro' } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await updateReviewNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_list_review_notes',
    {
      description: 'Fetch all notes for a review, optionally filtered by category. Returns counts by category.',
      inputSchema: {
        review_id: z.number().int().positive().describe('Review ID'),
        category: z.enum(['pro', 'con', 'observation', 'uncategorized']).optional().describe('Filter by category'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, notes: [], count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listReviewNotes(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_delete_review_note',
    {
      description: 'Delete a note by ID.',
      inputSchema: {
        note_id: z.number().int().positive().describe('Note ID to delete'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, deleted: true, note_id: params.note_id }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await deleteReviewNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_editorial_digest',
    {
      description: 'Full editorial status: active reviews by status, overdue items, upcoming deadlines, loaner status. Use for morning digest or on-demand check-ins.',
    },
    safeToolHandler(async () => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review_pipeline: {}, loaner_summary: {}, upcoming_deadlines: [], overdue_loaners: [], generated_at: new Date().toISOString() }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getEditorialDigest();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Watch List Management
  // -------------------------------------------------------------------------

  scopedRegister(
    'altus_add_watch_subject',
    {
      description: 'Add an artist or topic to Derek\'s news monitor watch list. The news monitor cron will flag when these subjects appear in Google News search data.',
      inputSchema: {
        name: z.string().min(1).describe("Artist name or topic to monitor — e.g. 'Paramore', 'shoegaze'"),
        notes: z.string().optional().describe("Optional context — e.g. 'touring in summer 2026'"),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, subject: { id: 1, name: params.name, active: true, added_at: new Date().toISOString(), notes: params.notes || null } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await addWatchSubject(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_remove_watch_subject',
    {
      description: 'Remove a subject from the watch list by name or ID. Subject is deactivated (not deleted) — it won\'t appear in future news monitor checks.',
      inputSchema: {
        id: z.number().int().positive().optional().describe('Watch list ID'),
        name: z.string().optional().describe('Artist name or topic (case-insensitive match)'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, deactivated_count: 1, subjects: [{ id: 1, name: params.name || 'Test Subject' }] }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await removeWatchSubject(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_list_watch_subjects',
    {
      description: 'View Derek\'s current news monitor watch list. By default shows only active subjects. Pass include_inactive=true to see previously removed subjects.',
      inputSchema: {
        include_inactive: z.boolean().default(false).optional().describe('Include previously removed subjects. Default false.'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, subjects: [], total: 0, active_count: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listWatchSubjects(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // AI Writer Pipeline
  // -------------------------------------------------------------------------

  scopedRegister(
    'create_article_assignment',
    {
      description: 'Start a new AI Writer assignment. Runs archive and web research in parallel. Returns when research is complete and outline is ready to generate. For product reviews, pass review_notes_id to include Derek\'s pro/con notes.',
      inputSchema: {
        topic: z.string().min(1).describe('What to cover — as Derek described it'),
        article_type: z.enum(['article', 'review', 'interview', 'feature']).default('article').optional().describe('Content type'),
        review_notes_id: z.number().int().positive().optional().describe('ID of an altus_reviews entry to pull pro/con notes from'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment: { id: 1, topic: params.topic, article_type: params.article_type || 'article', status: 'outline_ready', archive_hits: 3, web_research_summary: 'Test research...', has_review_notes: !!params.review_notes_id } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await createAssignment(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'generate_article_outline',
    {
      description: 'Generate a structured outline from an assignment\'s research. Returns an editable outline for Derek to review before any writing begins.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, outline: { title_suggestion: 'Test Headline', sections: [{ title: 'Intro', points: ['Point 1'] }], angle: 'Test angle', estimated_words: 800 } }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await generateOutline(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'approve_outline',
    {
      description: 'Record Derek\'s approval or rejection of an outline. Pass feedback for modifications. Nothing is written until this is called with decision=\'approved\'.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
        decision: z.enum(['approved', 'rejected', 'modified']).describe('Editorial decision'),
        feedback: z.string().optional().describe('Derek\'s notes or modification instructions'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, status: params.decision === 'approved' ? 'outline_approved' : params.decision === 'rejected' ? 'cancelled' : 'outline_ready', decision_logged: true }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await approveOutline(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'generate_article_draft',
    {
      description: 'Generate the full article draft from an approved outline. Uses web research, archive voice reference, and review notes if present. Returns when draft is complete.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, status: 'draft_ready', word_count: 850, draft_preview: 'Test draft content...' }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await generateDraft(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'fact_check_draft',
    {
      description: 'Run a fact-checking pass on a completed draft. Verifies specific factual claims via web search. Only regenerates flagged sections — clean sections are preserved.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, passed: true, issues_found: 0, status: 'ready_to_post' }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await factCheckDraft(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'post_to_wordpress',
    {
      description: 'Post a clean draft to WordPress as a draft post. Never publishes directly. Only works when draft has passed fact check. Returns the WordPress draft URL for Derek to review.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
        title: z.string().optional().describe('Override the outline title suggestion'),
        categories: z.array(z.string()).optional().describe('WordPress category names'),
        tags: z.array(z.string()).optional().describe('WordPress tag names'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, wp_post_id: 12345, wp_post_url: 'https://altwire.net/?p=12345', status: 'posted' }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await postToWordPress(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_draft_as_html',
    {
      description: 'Returns the article draft as clean HTML for copy-pasting into WordPress\'s Text/Code editor. Does not post to WordPress — just converts and returns the HTML. Available once a draft exists, regardless of pipeline status.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, topic: 'Test Topic', title_suggestion: 'Test Headline', html: '<h2>Test</h2><p>Draft content.</p>', word_count: 850, instructions: 'Copy the html field and paste into WordPress → Text/Code editor.' }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getDraftAsHtml(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'log_editorial_decision',
    {
      description: 'Record Derek\'s feedback or decision on any stage of the pipeline. Use for explicit feedback, cancellations, or supplemental decisions.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
        stage: z.enum(['outline', 'draft', 'post', 'feedback']).describe('Pipeline stage'),
        decision: z.enum(['approved', 'rejected', 'modified', 'cancelled']).describe('Editorial decision'),
        feedback: z.string().optional().describe('Derek\'s notes'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, decision_id: 1 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await logEditorialDecision(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_article_assignment',
    {
      description: 'Fetch full details of a specific assignment including research context, outline, draft status, and decision history.',
      inputSchema: {
        id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, id: params.id, topic: 'Test Topic', status: 'outline_ready', decisions: [] }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getAssignment(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'list_article_assignments',
    {
      description: 'List active assignments with optional filters by status or type. By default excludes posted and cancelled.',
      inputSchema: {
        status: z.string().optional().describe('Filter by pipeline status'),
        article_type: z.enum(['article', 'review', 'interview', 'feature']).optional().describe('Filter by article type'),
        limit: z.number().int().min(1).max(50).default(20).optional().describe('Results per page (default 20, max 50)'),
        offset: z.number().int().min(0).default(0).optional().describe('Pagination offset'),
      },
    },
    safeToolHandler(async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignments: [], count: 0, total: 0 }) }] };
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listAssignments(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Monitoring & Morning Digest
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // HAL — CHART GENERATION
  // -------------------------------------------------------------------------

  scopedRegister(
    'generate_chart',
    {
      description: 'Render a chart inline in the Chat UI using data already in context. ' +
      'Use ONLY after fetching the underlying data — do not call this tool without data to chart. ' +
      'Supported types: line (trends over time), bar (category comparisons), pie (proportions, max 6 segments). ' +
      'For line and bar charts with time-series x-axis, use ISO date strings (YYYY-MM-DD) as x values. ' +
      'For multi-series charts, include a series array and use series names as data keys.',
      inputSchema: {
        chart_type: z.enum(['line', 'bar', 'pie']).describe("Chart type: 'line', 'bar', or 'pie'"),
        title: z.string().max(120).describe('Chart title shown above the chart'),
        description: z.string().max(240).optional().describe('Optional subtitle or context note shown below the title'),
        x_label: z.string().max(60).optional().describe('X-axis label (line and bar only)'),
        y_label: z.string().max(60).optional().describe('Y-axis label (line and bar only)'),
        series: z.array(z.string()).max(4).optional().describe(
          'Series names for multi-series charts. If provided, each data point must include a key matching each series name.'
        ),
        data: z.array(z.record(z.unknown())).min(1).max(200).describe(
          'Data array. For single-series: [{x, value}, ...]. For multi-series: [{x, seriesName1, seriesName2, ...}, ...]. ' +
          'For pie charts: [{name, value}, ...].'
        ),
      },
    },
    safeToolHandler(async (params) => {
      const result = generateChart(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  const { getAltwireUptime, getAltwireIncidents } = await import('./handlers/altus-monitoring.js');
  const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');
  const { getAltwireIncidentComments, createAltwireIncidentComment, getAltwireStatusUpdates, createAltwireStatusUpdate } = await import('./handlers/altus-incident-handler.js');
  const { queryAltusEvents, synthesizeAudit } = await import('./altus-event-log.js');

  scopedRegister(
    'get_altwire_uptime',
    {
      description: 'Live status of AltWire\'s uptime monitors — altwire.net and WP Cron. Returns overall health and per-monitor status.',
    },
    safeToolHandler(async () => {
      const result = await getAltwireUptime();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_incidents',
    {
      description: 'Open (unresolved) incidents on AltWire\'s Better Stack monitors. Returns empty list when all is well.',
    },
    safeToolHandler(async () => {
      const result = await getAltwireIncidents();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Better Stack Incident Management
  // -------------------------------------------------------------------------

  scopedRegister(
    'altus_get_incident_comments',
    {
      description: 'Retrieve comments on a Better Stack incident. Use to see diagnostic notes already posted, or review attribution history.',
      inputSchema: {
        incident_id: z.string().describe('Better Stack incident ID — numeric string, e.g. "123456"'),
      },
    },
    safeToolHandler(async ({ incident_id }) => {
      const result = await getAltwireIncidentComments(incident_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_post_incident_comment',
    {
      description: 'Post an attributed comment to a Better Stack incident. Altus identity is attributed in the Better Stack timeline. Use for editorial notes, status updates, or diagnosis context.',
      inputSchema: {
        incident_id: z.string().describe('Better Stack incident ID'),
        content: z.string().describe('Comment content — markdown supported. Plain text preferred.'),
      },
    },
    safeToolHandler(async ({ incident_id, content }) => {
      const result = await createAltwireIncidentComment(incident_id, content);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_get_status_updates',
    {
      description: 'Retrieve status page updates for a Better Stack status report. Use to see recent public-facing status communications.',
      inputSchema: {
        status_report_id: z.string().describe('Better Stack status report ID'),
      },
    },
    safeToolHandler(async ({ status_report_id }) => {
      const result = await getAltwireStatusUpdates(status_report_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'altus_post_status_update',
    {
      description: 'Post a public status page update for a Better Stack status report. Use to communicate incident status, resolution, or maintenance windows to AltWire readers.',
      inputSchema: {
        status_report_id: z.string().describe('Better Stack status report ID'),
        message: z.string().describe('Status update message — describe current status clearly'),
        affected_resources: z.array(z.string()).optional().default([]).describe('Affected URLs or services'),
        notify_subscribers: z.boolean().optional().default(false).describe('Email subscribers'),
      },
    },
    safeToolHandler(async ({ status_report_id, message, affected_resources, notify_subscribers }) => {
      const result = await createAltwireStatusUpdate({ status_report_id, message, affected_resources, notify_subscribers });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Event Log Tools
  // -------------------------------------------------------------------------

  scopedRegister(
    'query_altus_events',
    {
      description: 'Query the Altus event log — every tool call, error, cron trigger, and session boundary is recorded here. Use to audit what Altus has done, debug failures, or investigate agent behavior.',
      inputSchema: {
        event_type: z.string().optional().describe('Filter by event type: tool_call, tool_error, cron_trigger, session_start, session_end, scope_denied'),
        tool_name: z.string().optional().describe('Filter by tool name'),
        session_id: z.number().optional().describe('Filter by session ID'),
        last_n_hours: z.number().optional().describe('Time window in hours (1-168, default 24)'),
        limit: z.number().optional().default(50).describe('Max events to return (1-200)'),
      },
    },
    safeToolHandler(async ({ event_type, tool_name, session_id, last_n_hours, limit }) => {
      const result = await queryAltusEvents({ event_type, tool_name, session_id, last_n_hours, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altus_audit_log',
    {
      description: 'Synthesize a plain-English audit narrative from Altus event logs for a time window. For windows ≤24h, returns a direct synthesis. For longer windows, queues a batch job and returns a batch_id to poll.',
      inputSchema: {
        last_n_hours: z.number().optional().default(24).describe('Time window in hours (1-168)'),
        batch_id: z.string().optional().describe('Poll a pending batch by ID'),
        last_n_days: z.number().optional().default(30).describe('For completed audits: how far back to search'),
        limit: z.number().optional().default(5).describe('Max completed audits to return'),
      },
    },
    safeToolHandler(async ({ last_n_hours, batch_id, last_n_days, limit }) => {
      const result = await synthesizeAudit({ last_n_hours, batch_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_altwire_morning_digest',
    {
      description: 'Full AltWire morning briefing — site uptime, open incidents, today\'s news alerts, story opportunities, upcoming review deadlines, overdue loaners, and yesterday\'s traffic. Use at the start of a session or when Derek asks for a status overview.',
    },
    safeToolHandler(async () => {
      const result = await getAltwireMorningDigest();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // HAL — SLACK STATUS POSTING (Altus outbound)
  // -------------------------------------------------------------------------

  const { postStatusUpdate, getSlackPostHistory } = await import('./handlers/slack-altus.js');

  scopedRegister(
    'post_slack_status',
    {
      description: 'Post a status update to Slack. Channel routing is automatic by post_type: status_update/alert/incident_resolved/task_complete/observation → #admin-announcements; dave_digest → #bug-reports. Use channel_override to post directly to a specific channel.',
      inputSchema: {
        text: z.string().describe('Status update text to post'),
        post_type: z.enum(['status_update', 'alert', 'incident_resolved', 'task_complete', 'observation', 'dave_digest']).optional().default('status_update').describe('Determines routing — default: status_update'),
        emoji: z.string().optional().default(':information_source:').describe('Lead emoji. :white_check_mark: resolved, :warning: alert, :hammer_and_wrench: task, :bar_chart: digest.'),
        severity: z.enum(['normal', 'urgent']).optional().default('normal').describe('Severity — urgent posts bypass quiet hours'),
        channel_override: z.string().optional().describe('Post directly to a channel ID, bypassing post_type routing'),
      },
    },
    safeToolHandler(async ({ text, post_type, emoji, severity, channel_override }) => {
      const result = await postStatusUpdate({ text, post_type, emoji, severity, channel_override });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_slack_post_history',
    {
      description: 'Query recent Hal-initiated Slack status posts from the hal_slack_posts table. Returns posts ordered by created_at descending.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).optional().describe('Number of posts to return (default 10, max 50)'),
        severity_filter: z.enum(['normal', 'urgent']).optional().describe('Filter by severity'),
      },
    },
    safeToolHandler(async ({ limit, severity_filter }) => {
      const posts = await getSlackPostHistory({ limit, severity_filter });
      return { content: [{ type: 'text', text: JSON.stringify(posts) }] };
    })
  );

  // -------------------------------------------------------------------------
  // HAL — AGENT MEMORY (read/write for hal: soul, editorial context, etc.)
  // -------------------------------------------------------------------------

  const { readMemory, writeMemory, listMemory, deleteMemory } = await import('./handlers/hal-memory.js');
  const { trackArticle, listTrackedArticles, addContentIdea, getContentIdeas } = await import('./handlers/altus-editorial-tools.js');

  scopedRegister(
    'hal_read_memory',
    {
      description: 'Read a single Hal agent memory entry by key. Use to retrieve hal:soul:altwire, hal:altwire:editorial_context, or any other Hal memory key.',
      inputSchema: {
        key: z.string().describe('Memory key — e.g. hal:soul:altwire, hal:altwire:editorial_context'),
      },
    },
    safeToolHandler(async ({ key }) => {
      const result = await readMemory(key);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'hal_write_memory',
    {
      description: 'Write a Hal agent memory entry. Use to seed or update hal:soul:altwire, hal:altwire:editorial_context, or other Hal memory keys. Protected keys (hal:soul*, hal:onboarding_state:*) cannot be overwritten via this tool.',
      inputSchema: {
        key: z.string().describe('Memory key — e.g. hal:soul:altwire, hal:altwire:editorial_context'),
        value: z.string().describe('Value to store'),
      },
    },
    safeToolHandler(async ({ key, value }) => {
      if (key.startsWith('hal:soul') || key.startsWith('hal:onboarding_state:')) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, exit_reason: 'protected_key', message: 'Protected key — use the seed script to update hal:soul values.' }) }] };
      }
      const result = await writeMemory(key, value);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'hal_list_memory',
    {
      description: 'List all Hal agent memory keys and values, newest first. Useful for discovering what memory keys exist and their last-updated timestamps.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).optional().describe('Max entries to return (default 50)'),
      },
    },
    safeToolHandler(async ({ limit }) => {
      const rows = await listMemory();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, entries: rows.slice(0, limit), total: rows.length }) }] };
    })
  );

  // -------------------------------------------------------------------------
  // ALTUS EDITORIAL TOOLS
  // -------------------------------------------------------------------------

  scopedRegister(
    'track_article',
    {
      description: 'Track an article for performance monitoring. Stores the URL, title, category, and optional notes in agent memory.',
      inputSchema: {
        url: z.string().describe('Article URL — slug is derived from the URL path'),
        title: z.string().describe('Article title'),
        category: z.string().describe('Content category — e.g. review, interview, feature, news'),
        notes: z.string().optional().describe('Optional editorial notes'),
      },
    },
    safeToolHandler(async ({ url, title, category, notes }) => {
      const result = await trackArticle({ url, title, category, notes });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'list_tracked_articles',
    {
      description: 'List all tracked articles, newest first. Returns URL, title, category, tracked_at, and notes.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).optional().describe('Max articles to return (default 50)'),
      },
    },
    safeToolHandler(async ({ limit }) => {
      const result = await listTrackedArticles({ limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'add_content_idea',
    {
      description: 'Add a new editorial content idea. Returns a UUID-keyed idea entry.',
      inputSchema: {
        topic: z.string().describe('The content topic or angle'),
        angle: z.string().optional().describe('Specific angle or take'),
        status: z.enum(['idea', 'writing', 'published']).default('idea').optional().describe('Pipeline status'),
        notes: z.string().optional().describe('Optional notes'),
      },
    },
    safeToolHandler(async ({ topic, angle, status, notes }) => {
      const result = await addContentIdea({ topic, angle, status, notes });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  scopedRegister(
    'get_content_ideas',
    {
      description: 'Retrieve content ideas, optionally filtered by pipeline status.',
      inputSchema: {
        status: z.enum(['idea', 'writing', 'published']).optional().describe('Filter by status'),
        limit: z.number().int().min(1).max(100).default(50).optional().describe('Max ideas to return (default 50)'),
      },
    },
safeToolHandler(async ({ status, limit }) => {
      const result = await getContentIdeas({ status, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // Link Evaluator — pre-publication content fitness
  // -------------------------------------------------------------------------

  const { evaluateLinkFitness } = await import('./handlers/altus-link-evaluator.js');

  scopedRegister(
    'evaluate_link_fitness',
    {
      description: 'Evaluate a URL for AltWire editorial fitness. Fetches the page, cross-references it with AltWire\'s 18-month analytics, editorial context, and archive coverage, then returns a plain-language fit assessment (excellent/decent/okay/questionable/poor) with reasoning and a suggested angle if it\'s a good fit. Use when Derek or an admin asks "is this link a good fit for AltWire?" or "should we cover this?".',
      inputSchema: {
        url: z.string().url().describe('The URL to evaluate'),
        description: z.string().optional().describe('Optional admin context — any additional description or angle hint from the person asking'),
      },
    },
    safeToolHandler(async ({ url, description }) => {
      const result = await evaluateLinkFitness({ url, description });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  // -------------------------------------------------------------------------
  // AI Writer — Phase 3: Author Profile Editing
  // -------------------------------------------------------------------------

  const { getDerekAuthorProfile } = await import('./hal-harness.js');

  scopedRegister(
    'get_author_profile',
    {
      description: 'Returns the editorial voice profile — writing voice, tone preferences, and what to preserve in AI-generated drafts.',
    },
    safeToolHandler(async () => {
      const profile = await getDerekAuthorProfile();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, profile: profile || null }) }] };
    })
  );

  scopedRegister(
    'update_author_profile',
    {
      description: 'Update a single field of the editorial voice profile. Valid field paths: writing_voice.tone, writing_voice.formality, writing_voice.sentence_patterns, writing_voice.first_person_usage, writing_voice.emotional_candor, writing_voice.humor_style, what_to_preserve_in_ai_drafts.',
      inputSchema: {
        field_path: z.string().describe('Dot-notation path to the field — e.g. "writing_voice.tone" or "what_to_preserve_in_ai_drafts"'),
        value: z.string().describe('New value for the field'),
      },
    },
    safeToolHandler(async ({ field_path, value }) => {
      const ALLOWED_PATHS = [
        'writing_voice.tone', 'writing_voice.formality',
        'writing_voice.sentence_patterns', 'writing_voice.first_person_usage',
        'writing_voice.emotional_candor', 'writing_voice.humor_style',
        'what_to_preserve_in_ai_drafts',
      ];
      if (!ALLOWED_PATHS.includes(field_path)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'invalid_field_path', allowed: ALLOWED_PATHS }) }] };
      }
      const current = await getDerekAuthorProfile() || {};
      const parts = field_path.split('.');
      let obj = current;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      const key = 'hal:altwire:editorial_voice_profile';
      await pool.query(
        `INSERT INTO agent_memory (agent, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (agent, key) DO UPDATE SET value = $3`,
        ['hal', key, JSON.stringify(current)]
      );
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, profile: current }) }] };
    })
  );

  // -------------------------------------------------------------------------
  // AI Writer — Phase 4: Writer Summary
  // -------------------------------------------------------------------------

  scopedRegister(
    'get_writer_summary',
    {
      description: 'Aggregated writer stats for the prompt page context card — active assignments, action needed count, ready to post count, last digest time, search opportunities, and today\'s Matomo pageviews.',
    },
    safeToolHandler(async () => {
      if (!process.env.DATABASE_URL) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const { rows: activeRows } = await pool.query(
        `SELECT COUNT(*) AS count FROM altus_assignments WHERE status NOT IN ('posted', 'cancelled')`
      );
      const { rows: actionRows } = await pool.query(
        `SELECT COUNT(*) AS count FROM altus_assignments WHERE status IN ('outline_ready', 'draft_ready')`
      );
      const { rows: readyRows } = await pool.query(
        `SELECT COUNT(*) AS count FROM altus_assignments WHERE status = 'ready_to_post'`
      );
      const { getTrafficSummary } = await import('./handlers/altwire-matomo-client.js');
      const { getSearchOpportunities } = await import('./handlers/altwire-gsc-client.js');
      const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');
      let digest = null;
      try { digest = await getAltwireMorningDigest(); } catch { /* non-blocking */ }
      let analytics = { pageviews_today: 0, top_article: null };
      try {
        const matomoData = await getTrafficSummary('day', 'today');
        analytics = {
          pageviews_today: matomoData?.pageviews ?? 0,
          top_article: matomoData?.top_article_title ?? null,
        };
      } catch { /* non-blocking */ }
      let opportunities = { high: 0, medium: 0, low: 0 };
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const oppData = await getSearchOpportunities(thirtyDaysAgo, new Date().toISOString().slice(0, 10));
        if (oppData?.opportunities) {
          for (const o of oppData.opportunities) {
            if (o.position >= 5 && o.position <= 10) opportunities.high++;
            else if (o.position >= 11 && o.position <= 20) opportunities.medium++;
            else opportunities.low++;
          }
        }
      } catch { /* non-blocking */ }
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        writer: {
          active: parseInt(activeRows[0]?.count || 0),
          action_needed: parseInt(actionRows[0]?.count || 0),
          ready_to_post: parseInt(readyRows[0]?.count || 0),
        },
        digest: {
          last_updated: digest?.generated_at || null,
          warning_count: digest?.warnings?.length || 0,
        },
        opportunities,
        analytics,
      }) }] };
    })
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

async function identifyClient(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const { getAccessToken } = await import('./lib/oauth-store.js');
  const tokenData = await getAccessToken(token);
  if (tokenData) return tokenData.clientId;

  const providedHash = crypto.createHash('sha256').update(token).digest();
  for (const [clientId, secretEnvKey] of Object.entries(process.env)) {
    if (!clientId.startsWith('OAUTH_CLIENT_SECRET_')) continue;
    const secretHash = crypto.createHash('sha256').update(secretEnvKey).digest();
    try {
      if (crypto.timingSafeEqual(providedHash, secretHash)) {
        const operator = clientId.slice('OAUTH_CLIENT_SECRET_'.length);
        const clientIdEnvKey = `OAUTH_CLIENT_ID_${operator}`;
        return process.env[clientIdEnvKey] || null;
      }
    } catch { /* timingSafeEqual threw — lengths mismatch */ }
  }
  return null;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!globalLimiter.check(req, res)) return;

  if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: MCP_BASE_URL,
      authorization_endpoint: `${MCP_BASE_URL}/authorize`,
      token_endpoint: `${MCP_BASE_URL}/oauth/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    }));
    return;
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    if (!authLimiter.check(req, res, { errorMessage: 'Too many authentication attempts, please try again later.' })) return;

    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const responseType = url.searchParams.get('response_type');
    const scope = url.searchParams.get('scope') || 'read';
    const state = url.searchParams.get('state');

    if (responseType !== 'code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_response_type' }));
      return;
    }
    if (!clientId || !redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }
    if (!OAUTH_CLIENTS.has(clientId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'unknown client_id' }));
      return;
    }
    if (!OAUTH_ALLOWED_REDIRECT_URIS.has(redirectUri)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uri not allowed' }));
      return;
    }

    const { storeAuthCode } = await import('./lib/oauth-store.js');
    const authCode = generateAuthCode();
    await storeAuthCode(authCode, {
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge: url.searchParams.get('code_challenge'),
      codeChallengeMethod: url.searchParams.get('code_challenge_method'),
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', authCode);
    if (state) redirectUrl.searchParams.set('state', state);
    res.writeHead(302, { Location: redirectUrl.toString() });
    res.end();
    return;
  }

  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    if (!authLimiter.check(req, res, { errorMessage: 'Too many authentication attempts, please try again later.' })) return;

    const MAX_BODY_BYTES = 262144;
    let bodySize = 0;
    let bodySizeExceeded = false;
    let body = '';
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_BYTES) { bodySizeExceeded = true; req.destroy(); return; }
      body += chunk;
    });
    req.on('end', async () => {
      if (bodySizeExceeded) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        return;
      }
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      const code = params.get('code');
      const redirectUri = params.get('redirect_uri');
      const clientId = params.get('client_id');
      const refreshToken = params.get('refresh_token');
      const codeVerifier = params.get('code_verifier');
      const presentedSecret = params.get('client_secret');

      if (!clientId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      const operator = OAUTH_CLIENTS.get(clientId);
      if (!operator) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      const secretEnvKey = `OAUTH_CLIENT_SECRET_${operator}`;
      const expectedSecret = process.env[secretEnvKey];
      if (expectedSecret && presentedSecret !== expectedSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      if (grantType === 'authorization_code') {
        const { getAuthCode, deleteAuthCode, storeAccessToken, storeRefreshToken } = await import('./lib/oauth-store.js');
        const authData = await getAuthCode(code);
        if (!authData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (redirectUri !== authData.redirectUri) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (authData.codeChallenge) {
          if (!codeVerifier) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code_verifier required' }));
            return;
          }
          const digest = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
          if (digest !== authData.codeChallenge) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code_verifier mismatch' }));
            return;
          }
        }
        await deleteAuthCode(code);
        const accessToken = generateAccessToken();
        const newRefreshToken = generateAccessToken();
        await storeAccessToken(accessToken, { clientId, scope: authData.scope });
        await storeRefreshToken(newRefreshToken, { clientId, scope: authData.scope });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: newRefreshToken }));
        return;
      }

      if (grantType === 'refresh_token') {
        const { getRefreshToken, deleteRefreshToken, storeAccessToken, storeRefreshToken } = await import('./lib/oauth-store.js');
        const refreshData = await getRefreshToken(refreshToken);
        if (!refreshData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        await deleteRefreshToken(refreshToken);
        const accessToken = generateAccessToken();
        const newRefreshToken = generateAccessToken();
        await storeAccessToken(accessToken, { clientId, scope: refreshData.scope || 'read' });
        await storeRefreshToken(newRefreshToken, { clientId, scope: refreshData.scope });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: newRefreshToken }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    });
    return;
  }

  // Health check — no auth required
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'altus' }));
    return;
  }

  // Slack events — signature verification handled by slack-altus.js
  if (url.pathname === '/slack/events' && req.method === 'POST') {
    const { handleSlackRequest } = await import('./handlers/slack-altus.js');
    handleSlackRequest(req, res);
    return;
  }

  // ---------------------------------------------------------------------------
  // Writer REST endpoints — authenticated via ALTUS_ADMIN_TOKEN
  // ---------------------------------------------------------------------------
  if (url.pathname.startsWith('/hal/writer/')) {
    // CORS headers for all writer routes
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken || authToken !== process.env.ALTUS_ADMIN_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // GET /hal/writer/assignments
    if (url.pathname === '/hal/writer/assignments' && req.method === 'GET') {
      try {
        const statusFilter = url.searchParams.get('status');
        const typeFilter = url.searchParams.get('article_type');
        const conditions = [];
        const values = [];
        let idx = 1;
        if (statusFilter) { conditions.push(`status = $${idx++}`); values.push(statusFilter); }
        if (typeFilter) { conditions.push(`article_type = $${idx++}`); values.push(typeFilter); }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows } = await pool.query(
          `SELECT id, topic, article_type, status, draft_word_count, wp_post_url, created_at, updated_at,
                  outline->>'title_suggestion' AS title_suggestion
           FROM altus_assignments
           ${where}
           ORDER BY created_at DESC
           LIMIT 50`,
          values
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ assignments: rows, count: rows.length }));
      } catch (err) {
        logger.error('Writer assignments query failed', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query_failed', message: 'Writer data temporarily unavailable' }));
      }
      return;
    }

    // GET /hal/writer/assignments/:id
    const assignmentMatch = url.pathname.match(/^\/hal\/writer\/assignments\/(\d+)$/);
    if (assignmentMatch && req.method === 'GET') {
      const id = parseInt(assignmentMatch[1], 10);
      try {
        const { rows: assignmentRows } = await pool.query(
          'SELECT * FROM altus_assignments WHERE id = $1',
          [id]
        );
        if (assignmentRows.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ assignment: null }));
          return;
        }
        const { rows: decisionRows } = await pool.query(
          'SELECT * FROM altus_editorial_decisions WHERE assignment_id = $1 ORDER BY created_at ASC',
          [id]
        );
        const result = { ...assignmentRows[0], decisions: decisionRows };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        logger.error('Writer assignment detail query failed', { error: err.message, id });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query_failed', message: 'Writer data temporarily unavailable' }));
      }
      return;
    }

    // GET /hal/writer/opportunities
    if (url.pathname === '/hal/writer/opportunities' && req.method === 'GET') {
      try {
        const result = await getStoryOpportunities();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        logger.error('Writer opportunities query failed', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query_failed', message: 'Writer data temporarily unavailable' }));
      }
      return;
    }

    // GET /hal/writer/news-alerts
    if (url.pathname === '/hal/writer/news-alerts' && req.method === 'GET') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const { rows } = await pool.query(
          'SELECT value FROM agent_memory WHERE agent = $1 AND key = $2',
          ['altus', `altus:news_alert:${today}`]
        );
        const data = rows[0]?.value ? JSON.parse(rows[0].value) : { news_queries: [], watch_list_matches: [] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        logger.error('Writer news alerts query failed', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query_failed', message: 'Writer data temporarily unavailable' }));
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Search Feedback REST endpoint — for WordPress plugin
  // POST /hal/feedback — log feedback from search results
  // GET /hal/search-feedback — retrieve feedback entries (for wp plugin polling)
  // ---------------------------------------------------------------------------
  if (url.pathname === '/hal/feedback' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }

      const { query, rating, comment, answer_excerpt, results_shown, ip_address, user_agent } = data;

      if (!query || !rating) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'query and rating are required' }));
        return;
      }

      try {
        await pool.query(
          `INSERT INTO altus_search_feedback
             (query, rating, comment, answer_excerpt, results_shown, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            query,
            rating,
            comment || null,
            answer_excerpt || null,
            results_shown || [],
            ip_address || null,
            user_agent || null,
          ]
        );
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        logger.error('Feedback insert failed', { error: err.message });
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'insert failed' }));
      }
    });
    return;
  }

  if (url.pathname === '/hal/search-feedback' && req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const ratingParam = url.searchParams.get('rating');
    const sinceParam = url.searchParams.get('since');
    const limitParam = url.searchParams.get('limit');

    try {
      const result = await getSearchFeedback({
        rating: ratingParam !== null ? parseInt(ratingParam, 10) : undefined,
        since: sinceParam || undefined,
        limit: limitParam ? parseInt(limitParam, 10) : 50,
      });
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.error('search-feedback GET failed', { error: err.message });
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'query failed' }));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // AltWire REST endpoints — authenticated via HAL_KEY
  // ---------------------------------------------------------------------------
  // GET /altwire/digest — full morning digest (auth via Authorization header)
  if (url.pathname === '/altwire/digest' && req.method === 'GET') {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const digest = await getAltwireMorningDigest();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(digest));
    } catch (err) {
      logger.error('AltWire digest endpoint failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'digest_failed', message: 'Digest temporarily unavailable' }));
    }
    return;
  }

  // Health check — Railway liveness/readiness probe
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // ---------------------------------------------------------------------------
  // SSE Event Stream — GET /events/:sessionId
  // Streams tool_start/tool_done/thinking_done events to the Chat UI.
  // Client subscribes via EventSource, receives events from the in-memory bus.
  // ---------------------------------------------------------------------------
  const eventsMatch = url.pathname.match(/^\/events\/(.+)$/);
  if (eventsMatch && req.method === 'GET') {
    const sessionId = eventsMatch[1];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    const flush = () => {
      const events = getEvents(sessionId);
      if (events) {
        res.write(events);
      }
    };

    const poll = setInterval(flush, 100);

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(poll);
      clearBus(sessionId);
    });

    res.write(': connected\n\n');
    flush();
    return;
  }

  // MCP endpoint — stateless POST
  if (url.pathname === '/' || url.pathname === '/mcp') {
    if (!authLimiter.check(req, res)) return;

    const clientId = await identifyClient(req);
    if (!clientId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const allowedTools = OAUTH_CLIENT_TOOLS.get(clientId);
    const agentContext = req.headers['x-agent-context'] || null;

    // Extract session_id from request body for SSE event bus correlation
    const sessionId = await new Promise((resolve) => {
      if (req.body && typeof req.body === 'object' && req.body.session_id) {
        resolve(req.body.session_id);
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data?.session_id || null);
        } catch {
          resolve(null);
        }
      });
    });

    const server = await createMcpServer({ agentContext, allowedTools, clientId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    const clientCtx = { clientId, allowedTools };
    if (sessionId) {
      await oauthClientStorage.run(clientCtx, async () =>
        sessionIdStorage.run(sessionId, async () => {
          await transport.handleRequest(req, res);
        })
      );
    } else {
      await oauthClientStorage.run(clientCtx, async () => {
        await transport.handleRequest(req, res);
      });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, () => {
  logger.info(`Altus MCP server listening on port ${PORT}`, {
    healthEndpoint: `http://localhost:${PORT}/health`,
    mcpEndpoint: `http://localhost:${PORT}/`,
  });
});
