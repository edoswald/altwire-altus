/**
 * Altus MCP Server — AltWire AI Operations
 *
 * 91 tools: RAG archive, public search, Matomo + GSC analytics, combined
 * synthesis, editorial intelligence, monitoring, review tracker, watch list,
 * AI Writer pipeline, author profile, Slack outbound + extended, Hal memory,
 * editorial idea tools, link evaluator, Better Stack incidents, event log,
 * AI cost tracking, and multi-admin onboarding. See spec §5 for the
 * authoritative breakdown.
 * Transport: StreamableHTTP (stateless — sessionIdGenerator: undefined)
 * Health: GET /health
 */

import { initializeLaminar } from './lib/laminar-integration.js';

// ---------------------------------------------------------------------------
// Laminar initialization — must run before any other imports
// ---------------------------------------------------------------------------
await initializeLaminar();

import { sessionIdStorage } from './lib/safe-tool-handler.js';
import { observe } from './tracing.js';
import { logAltusEvent } from './altus-event-log.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { z } from 'zod';
import { logger } from './logger.js';
import pool, { initSchema, initMountaineeringSchema, hasDbConfig } from './lib/altus-db.js';
import {
  seedMountaineeringClimbs,
  collectClimbScores,
  createClimb,
  startClimbIteration,
  scoreClimbIteration,
  getClimbStatus,
  supervisorDecision,
  peakClimb,
  getClimbHistory,
} from './handlers/altus-mountaineering.js';
import { safeToolHandler } from './lib/safe-tool-handler.js';
import { searchAltwireArchive } from './handlers/altus-search.js';
import { reIngestHandler } from './handlers/altus-reingest.js';
import { getArchiveStats } from './handlers/altus-stats.js';
import { getContentByUrl } from './handlers/altus-fetch.js';
import { analyzeCoverageGaps } from './handlers/altus-coverage.js';
import { getTrafficSummary, getReferrerBreakdown, getTopPages, getSiteSearch } from './handlers/altwire-matomo-client.js';
import {
  getSearchPerformance,
  getSearchOpportunities,
  getSitemapHealth,
  getNewsSearchPerformance,
  getOpportunityZoneQueries,
  getPagePerformance,
} from './handlers/altwire-gsc-client.js';
import { getCombinedAnalytics } from './handlers/altus-combined-analytics.js';
import { generateChart } from './hal-chart.js';
import { getAltwireMorningDigest } from './handlers/altus-digest.js';
import { getStoryOpportunities } from './handlers/altus-topic-discovery.js';
import { getNewsOpportunities, runNewsMonitorCron } from './handlers/altus-news-monitor.js';
import { getArticlePerformance, getNewsPerformancePatterns, runPerformanceSnapshotCron } from './handlers/altus-performance-tracker.js';
import { searchAltwirePublic, getSearchFeedback } from './handlers/altwire-search.js';
import { emitEvent, getEvents, clearBus, hasEvents, registerSession, isSessionRegistered } from './lib/altus-event-bus.js';
import { startIngestCron } from './lib/ingest-cron.js';
import cron from 'node-cron';
import { initAiUsageSchema } from './lib/ai-cost-tracker.js';
import { identifyCompatibleHalClient, isAllowedAltusRestToken, authenticateHalWebToken, signHalWebSessionToken } from './lib/altus-auth-compat.js';
import { initChatHistorySchema, saveSession as saveChatSession, listSessions as listChatSessions, getSession as getChatSession, deleteSession as deleteChatSession } from './lib/altus-chat-history.js';
import { createAnthropicMessageStream } from './lib/anthropic-message-stream.js';
import { assembleSystemPrompt } from './hal-harness.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
  initChatPresenceSchema,
  listChatPresence,
  upsertChatPresence,
  cleanupChatPresence,
} from './handlers/altus-chat-presence.js';
import {
  initCommitmentsSchema,
  recordCommitment,
  listCommitments,
  updateCommitment,
  recordWatchItem,
  listWatchItems,
  updateWatchItem,
  recordAutonomyNote,
} from './handlers/altus-commitments.js';
import {
  listDocuments,
  getDocument,
  saveDocument,
} from './handlers/altus-documents.js';
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
  adjustWriterSystemPrompt,
  getWriterDirectives,
  getAssignment,
  listAssignments,
} from './handlers/altus-writer.js';
import {
  initOpportunityQueueSchema,
  upsertStoryOpportunityQueue,
  listStoryOpportunityQueue,
  assignStoryOpportunity,
} from './handlers/altus-opportunity-queue.js';
import { refreshOpportunityQueue } from './handlers/altus-opportunity-refresh.js';
import { sendAltusAdminEmail } from './handlers/altus-admin-email.js';
import { getSeoState, updateSeoFields } from './lib/wp-client.js';
import { initOAuthSchema } from './lib/oauth-store.js';
import { createRateLimiter } from './lib/rate-limiter.js';
import { getHalUiRateLimitBucket } from './lib/hal-ui-rate-limit.js';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export const oauthClientStorage = new AsyncLocalStorage();

const PORT = process.env.PORT || 3000;

// Rate limiters
const globalLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const halUiLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 600 });
const halChatLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120 });

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

// Dynamically registered clients (RFC 7591) are persisted in Postgres via
// lib/oauth-store.js (storeClient/getClient) so a client that registered before
// a deploy/restart — or against another replica — is still known at /authorize
// and /oauth/token time. Claude reuses its registered client_id across sessions.

const MCP_BASE_URL = process.env.MCP_BASE_URL || 'https://altus.altwire.net';

// Claude's hosted custom-connector surfaces (claude.ai web and the Desktop app)
// always redirect to these fixed callbacks. Claude may register one domain and
// authorize with the other, so both are allowlisted unconditionally.
const CLAUDE_HOSTED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

const OAUTH_ALLOWED_REDIRECT_URIS = new Set([
  process.env.OAUTH_REDIRECT_URI || `${MCP_BASE_URL}/oauth/callback`,
  ...CLAUDE_HOSTED_REDIRECT_URIS,
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
// Parse OAUTH_CLIENT_CONTEXTS → Map<clientId, Set<agentContext>>
  // Format: "clientId1:altwire,nimbus;clientId2:altwire"
  // If a client is not listed here, no agentContext restriction applies (backwards-compatible).
  // If a client IS listed, it may only use listed contexts.
  function parseClientContexts() {
    const map = new Map();
    const raw = process.env.OAUTH_CLIENT_CONTEXTS;
    if (!raw) return map;
    for (const entry of raw.split(';')) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) continue;
      const clientId = entry.slice(0, colonIdx).trim();
      const contexts = entry.slice(colonIdx + 1).split(',').map(c => c.trim()).filter(Boolean);
      map.set(clientId, new Set(contexts));
    }
    return map;
  }

  const OAUTH_CLIENT_CONTEXTS = parseClientContexts();

  // Check whether a clientId is authorized to claim a given agentContext.
  // Returns true if no restriction exists for the client; false otherwise.
  function isContextAllowed(clientId, agentContext) {
    if (!agentContext) return true;
    const allowed = OAUTH_CLIENT_CONTEXTS.get(clientId);
    if (!allowed) return true; // no restriction defined — allow
    return allowed.has(agentContext);
  }
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
  get_altwire_seo_state:      [],
  update_altwire_seo_fields:  [],
  get_altwire_sitemap_health:  [],
  get_altwire_news_search_performance: [],
  get_altwire_opportunity_zone_queries: [],
  get_altwire_page_performance: [],
  get_altwire_combined_analytics: [],
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
  // Shared Hal parity surfaces
  altus_list_chat_presence:    [],
  altus_list_documents:        [],
  altus_get_document:          [],
  altus_save_document:         [],
  altus_record_commitment:     [],
  altus_list_commitments:      [],
  altus_update_commitment:     [],
  altus_record_watch_item:     [],
  altus_list_watch_items:      [],
  altus_update_watch_item:     [],
  altus_record_autonomy_note:  [],
  altus_send_admin_email:      [],
  // AI Writer pipeline
  create_article_assignment:   [],
  generate_article_outline:    [],
  approve_outline:             [],
  generate_article_draft:      [],
  fact_check_draft:            [],
  post_to_wordpress:           [],
  get_draft_as_html:           [],
  log_editorial_decision:      [],
  adjust_writer_system_prompt: [],
  get_writer_directives:       [],
  get_article_assignment:     [],
  list_article_assignments:   [],
  // Slack status (Altus outbound)
  post_slack_status:           [],
  get_slack_post_history:     [],
  // Slack extended capabilities
  add_slack_reaction:          [],
  list_slack_reactions:        [],
  get_slack_dnd_status:        [],
  upload_slack_file:           [],
  list_slack_channel_files:    [],
  share_slack_file_public:     [],
  send_slack_dm:               [],
  open_slack_dm:               [],
  search_slack_messages:       [],
  schedule_slack_message:      [],
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
  get_altus_audit_log:         [],
  // AI cost
  get_altus_ai_cost_summary:    [],
  // Multi-admin onboarding
  altus_check_onboarding_status: [],
  altus_save_onboarding_response: [],
  altus_get_onboarding_preferences: [],
  altus_get_perch_agenda:        [],
  altus_update_perch_agenda:     [],
  altus_reset_onboarding:        [],
  // Mountaineering — supervised hill-climbing optimization
  altus_create_climb:             [],
  altus_start_climb_iteration:    [],
  altus_score_climb_iteration:    [],
  altus_get_climb_status:         [],
  altus_supervisor_decision:      [],
  altus_peak_climb:               [],
  altus_get_climb_history:        [],
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
    initChatHistorySchema().catch((err) => {
      logger.error('Chat history schema init failed', { error: err.message, code: err.code });
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
    initChatPresenceSchema().catch((err) => {
      logger.error('Chat presence schema init failed', { error: err.message, code: err.code });
    });
    initCommitmentsSchema().catch((err) => {
      logger.error('Commitments schema init failed', { error: err.message, code: err.code });
    });
    initWriterSchema()
      .then(() => initOpportunityQueueSchema())
      .catch((err) => {
        logger.error('Writer/opportunity schema init failed', { error: err.message, code: err.code });
      });
    initMountaineeringSchema().catch((err) => {
      logger.error('Mountaineering schema init failed', { error: err.message, code: err.code });
    });
    seedMountaineeringClimbs().catch((err) => {
      logger.error('seedMountaineeringClimbs failed', { error: err.message });
    });

    // Event log schema (non-blocking)
    import('./altus-event-log.js')
      .then(({ initAltusEventLogSchema }) => initAltusEventLogSchema().catch(err => {
        logger.error('Altus event log schema init failed', { error: err.message, code: err.code });
      }))
      .catch(err => logger.error('altus-event-log: import failed', { error: err.message }));

    // Heartbeat schema (non-blocking)
    import('./handlers/altus-heartbeat.js')
      .then(({ initHeartbeatSchema }) => {
        initHeartbeatSchema().catch(err => {
          logger.error('Altus heartbeat schema init failed', { error: err.message, code: err.code });
        });
      })
      .catch(err => logger.error('altus-heartbeat: import failed', { error: err.message }));

    import('./handlers/altus-action-items.js')
      .then(({ initActionItemsSchema }) => {
        initActionItemsSchema().catch(err => {
          logger.error('Altus action items schema init failed', { error: err.message, code: err.code });
        });
      })
      .catch(err => logger.error('altus-action-items: import failed', { error: err.message }));

    import('./handlers/altus-skill-library.js')
      .then(({ initSkillLibrarySchema }) => {
        initSkillLibrarySchema().catch(err => {
          logger.error('Altus skill library schema init failed', { error: err.message, code: err.code });
        });
      })
      .catch(err => logger.error('altus-skill-library: import failed', { error: err.message }));

    // Slack schema init (non-blocking)
    import('./handlers/slack-altus.js')
      .then(({ initSlackAltusSchema, initSlackAltus }) => {
        return initSlackAltusSchema().then(() => initSlackAltus());
      })
      .catch(err => logger.error('slack-altus: init import failed', { error: err.message, code: err.code, stack: err.stack }));

  startIngestCron();

  // News Monitor — 4:30 AM ET daily (after 4 AM reflection so fresh GSC data is available)
  cron.schedule('30 4 * * *', () => observe({ name: 'news_monitor', spanType: 'DEFAULT' }, async () => {
    await runNewsMonitorCron();
  }), { timezone: 'America/New_York' });

  // Story Opportunities — 5:00 AM ET weekdays (15 min before digest; upserts the altus_story_opportunities queue the digest reads)
  cron.schedule('0 5 * * 1-5', () => observe({ name: 'story_opportunities', spanType: 'DEFAULT' }, async () => {
    try {
      const { getStoryOpportunities } = await import('./handlers/altus-topic-discovery.js');
      await logAltusEvent('cron_trigger', { payload: { cron_name: 'story_opportunities', phase: 'started' } });
      const result = await getStoryOpportunities({ days: 28 });
      if (result?.error) {
        await logAltusEvent('cron_trigger', {
          payload: {
            cron_name: 'story_opportunities',
            phase: 'failed',
            error: result.error,
            message: result.message ?? null,
          },
        });
        logger.error('story_opportunities cron failed', { error: result.error, message: result.message });
        return;
      }
      await upsertStoryOpportunityQueue(result);
      await logAltusEvent('cron_trigger', {
        payload: {
          cron_name: 'story_opportunities',
          phase: 'completed',
          opportunities: result?.opportunities?.length ?? 0,
          cached: Boolean(result?.cached),
        },
      });
      logger.info('story_opportunities cron: completed');
    } catch (err) {
      await logAltusEvent('cron_trigger', {
        payload: {
          cron_name: 'story_opportunities',
          phase: 'failed',
          error: err.message,
        },
      });
      logger.error('story_opportunities cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  // Performance Snapshot — 6 AM ET daily
  cron.schedule('0 6 * * *', () => observe({ name: 'performance_snapshot', spanType: 'DEFAULT' }, async () => {
    await runPerformanceSnapshotCron();
  }), { timezone: 'America/New_York' });

  // AltWire Nightly Reflection — 4 AM ET daily
  cron.schedule('0 4 * * *', () => observe({ name: 'altwire_reflection', spanType: 'DEFAULT' }, async () => {
    try {
      const { runAltwireReflection } = await import('./handlers/altus-reflection.js');
      await runAltwireReflection();
    } catch (err) {
      logger.error('AltWire reflection cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  // Altus Heartbeat — every 2 hours
  cron.schedule('0 */2 * * *', async () => {
    try {
      const { runAltusHeartbeat } = await import('./handlers/altus-heartbeat.js');
      await runAltusHeartbeat();
    } catch (err) {
      logger.error('Altus heartbeat cron failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // Chat presence cleanup — hourly
  cron.schedule('15 * * * *', async () => {
    try {
      const result = await cleanupChatPresence();
      if (result?.deleted > 0) {
        logger.info('Altus chat presence cleanup completed', { deleted: result.deleted });
      }
    } catch (err) {
      logger.error('Altus chat presence cleanup failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // Altus Event Log Retention — 3 AM ET daily
  cron.schedule('0 3 * * *', () => observe({ name: 'event_retention', spanType: 'DEFAULT' }, async () => {
    try {
      const { runRetentionCron } = await import('./altus-event-log.js');
      await runRetentionCron();
    } catch (err) {
      logger.error('Altus event retention cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  // Altus Audit Batch Collection — every 2 hours, staggered 30 min from heartbeat
  cron.schedule('30 */2 * * *', () => observe({ name: 'audit_batch', spanType: 'DEFAULT' }, async () => {
    try {
      const { runAuditBatchCollection } = await import('./altus-event-log.js');
      const { collectSynthesisBatches } = await import('./handlers/altus-combined-analytics.js');
      const { collectAltusWeeklyBriefBatches } = await import('./handlers/altus-weekly-brief.js');
      await runAuditBatchCollection();
      await collectSynthesisBatches();
      await collectAltusWeeklyBriefBatches();
    } catch (err) {
      logger.error('Altus audit batch collection cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  // AltWire synthesis focused early poll — helps land before the 5:15 AM digest.
  cron.schedule('15,30,45 4 * * *', () => observe({ name: 'synthesis_batch_early', spanType: 'DEFAULT' }, async () => {
    try {
      const { collectSynthesisBatches } = await import('./handlers/altus-combined-analytics.js');
      await collectSynthesisBatches();
    } catch (err) {
      logger.error('AltWire synthesis early collection cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  cron.schedule('0 5 * * *', () => observe({ name: 'synthesis_batch_early', spanType: 'DEFAULT' }, async () => {
    try {
      const { collectSynthesisBatches } = await import('./handlers/altus-combined-analytics.js');
      await collectSynthesisBatches();
    } catch (err) {
      logger.error('AltWire synthesis early collection cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  // Mountaineering Batch Collection — every 2 hours, staggered 45 min from heartbeat
  cron.schedule('45 */2 * * *', () => observe({ name: 'mountaineering_batch', spanType: 'DEFAULT' }, async () => {
    try {
      await collectClimbScores();
    } catch (err) {
      logger.error('altus mountaineering batch cron failed', { error: err.message });
    }
  }));

  // Daily morning digest email — Mon-Fri 5:15 AM ET
  cron.schedule('15 5 * * 1-5', () => observe({ name: 'morning_digest', spanType: 'DEFAULT' }, async () => {
    try {
      const { sendMorningDigestEmail } = await import('./handlers/altus-digest-mailer.js');
      await sendMorningDigestEmail();
    } catch (err) {
      logger.error('altus-digest-mailer cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  // Weekly prose brief email — Sundays 8 AM ET
  cron.schedule('0 8 * * 0', () => observe({ name: 'weekly_brief', spanType: 'DEFAULT' }, async () => {
    try {
      const { sendAltusWeeklyBrief } = await import('./handlers/altus-weekly-brief.js');
      await sendAltusWeeklyBrief();
    } catch (err) {
      logger.error('altus-weekly-brief cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });

  cron.schedule('*/10 8-13 * * 0', () => observe({ name: 'weekly_brief_batch', spanType: 'DEFAULT' }, async () => {
    try {
      const { collectAltusWeeklyBriefBatches } = await import('./handlers/altus-weekly-brief.js');
      await collectAltusWeeklyBriefBatches();
    } catch (err) {
      logger.error('altus-weekly-brief batch cron failed', { error: err.message });
    }
  }), { timezone: 'America/New_York' });
} else {
  logger.warn('No database URL set — ALTWIRE_DATABASE_URL and DATABASE_URL are both empty — skipping schema init and cron');
}

// ---------------------------------------------------------------------------
// Laminar Signals — register on startup (idempotent, 409 = already exists)
// ---------------------------------------------------------------------------

import { registerSignals } from './hal-signals.js';
registerSignals().catch((err) => {
  logger.warn('[altus-signals] Registration failed:', err.message);
});

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
    async ({ query, limit, content_type }) => {
      const result = await searchAltwireArchive({ query, limit, content_type });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
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
    async ({ query, limit }) => {
      const result = await searchAltwirePublic({ query, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
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
    async ({ rating, since, limit }) => {
      const result = await getSearchFeedback({ rating, since, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ mode, dry_run }) => {
      const result = await reIngestHandler({ mode, dry_run });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: get_archive_stats
  // -------------------------------------------------------------------------
  scopedRegister(
    'get_archive_stats',
    {
      description: 'Returns health and coverage statistics for the AltWire content archive — total documents indexed, breakdown by type, last ingest run, and any errors.',
    },
    async () => {
      const result = await getArchiveStats();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ url, slug }) => {
      if (!url && !slug) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Either url or slug must be provided' }) }] };
      }
      const result = await getContentByUrl({ url, slug });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ subject, limit }) => {
      const result = await analyzeCoverageGaps({ subject, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // AltWire Analytics — Matomo
  // -------------------------------------------------------------------------

  scopedRegister(
    'get_altwire_site_analytics',
    {
      description: 'AltWire traffic summary for a period — visits, unique visitors, pageviews, bounce rate. Use to assess overall site health and content performance trends.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).optional().default('day').describe('Time period (default: day)'),
        date: z.string().optional().default('yesterday').describe('Matomo date — ISO date or keyword like yesterday, today (default: yesterday)'),
      },
    },
    async ({ period, date }) => {
      const result = await getTrafficSummary(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_traffic_sources',
    {
      description: 'AltWire referrer breakdown — where readers are coming from. Includes social media, organic search, direct, and campaign referrers. Use to understand content distribution channel performance.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).optional().default('day').describe('Time period (default: day)'),
        date: z.string().optional().default('yesterday').describe('Matomo date — ISO date or keyword like yesterday, today (default: yesterday)'),
      },
    },
    async ({ period, date }) => {
      const result = await getReferrerBreakdown(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_top_pages',
    {
      description: 'AltWire most-viewed articles, entry pages, and exit pages for a period. Use to identify best-performing content and high-exit pages that may need improvement.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).optional().default('day').describe('Time period (default: day)'),
        date: z.string().optional().default('yesterday').describe('Matomo date — ISO date or keyword like yesterday, today (default: yesterday)'),
      },
    },
    async ({ period, date }) => {
      const result = await getTopPages(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_site_search',
    {
      description: 'AltWire internal search terms — what readers are searching for on the site. Useful for identifying content gaps and topics with reader demand.',
      inputSchema: {
        period: z.enum(['day', 'week', 'month', 'year']).optional().default('day').describe('Time period (default: day)'),
        date: z.string().optional().default('yesterday').describe('Matomo date — ISO date or keyword like yesterday, today (default: yesterday)'),
      },
    },
    async ({ period, date }) => {
      const result = await getSiteSearch(period, date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
        dimensions: z.union([z.array(z.string()), z.string()]).optional().describe('Dimensions to group by — e.g. query, page, country. Default: query'),
      },
    },
    async ({ start_date, end_date, row_limit, dimensions }) => {
      const result = await getSearchPerformance(start_date, end_date, { rowLimit: row_limit, dimensions });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ start_date, end_date }) => {
      const result = await getSearchOpportunities(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_seo_state',
    {
      description: 'Read current SEO state for an AltWire WordPress object through the cirrusly-seo plugin. Use this before changing titles, meta descriptions, canonicals, social fields, or indexation.',
      inputSchema: {
        object_type: z.enum(['post', 'page', 'term']).describe('SEO object type. Use post for articles and podcast episodes.'),
        object_id: z.number().int().positive().describe('WordPress object ID'),
      },
    },
    async ({ object_type, object_id }) => {
      const result = await getSeoState({ objectType: object_type, objectId: object_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'update_altwire_seo_fields',
    {
      description: 'Update allowlisted content-level SEO fields for an AltWire WordPress object through the cirrusly-seo plugin. Use after reviewing current SEO state and identifying a clear editorial or search-performance improvement.',
      inputSchema: {
        object_type: z.enum(['post', 'page', 'term']).describe('SEO object type. Use post for articles and podcast episodes.'),
        object_id: z.number().int().positive().describe('WordPress object ID'),
        fields: z.object({
          seo_title: z.string().optional(),
          meta_description: z.string().optional(),
          canonical: z.string().optional(),
          focus_keyword: z.string().optional(),
          noindex: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
          nofollow: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
          social_title: z.string().optional(),
          social_description: z.string().optional(),
          social_image_id: z.number().int().positive().optional(),
        }).refine((value) => Object.keys(value).length > 0, {
          message: 'At least one SEO field must be provided.',
        }).describe('Allowlisted content-level SEO patch'),
        reason: z.string().optional().describe('Why Hal is making this SEO change. Required if the WordPress plugin enforces write reasons.'),
      },
    },
    async ({ object_type, object_id, fields, reason }) => {
      const result = await updateSeoFields({ objectType: object_type, objectId: object_id, fields, reason });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_sitemap_health',
    {
      description: 'Check GSC sitemap fetch status for altwire.net. Returns fetch status, last crawl date, and coverage counts. Alerts if sitemap is stale or unfetchable.',
    },
    async () => {
      const result = await getSitemapHealth();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_news_search_performance',
    {
      description: 'AltWire Google News search type performance — queries and pages appearing in Google News results. Use to evaluate News visibility and identify which articles are getting News pickup.',
      inputSchema: {
        start_date: z.string().describe('Start date — ISO format'),
        end_date: z.string().describe('End date — ISO format'),
        row_limit: z.number().int().min(1).max(1000).default(25).optional(),
        dimensions: z.union([z.array(z.string()), z.string()]).optional().describe('Dimensions to group by — query (default), page, country'),
      },
    },
    async ({ start_date, end_date, row_limit, dimensions }) => {
      const result = await getNewsSearchPerformance(start_date, end_date, { rowLimit: row_limit, dimensions });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_opportunity_zone_queries',
    {
      description: 'AltWire GSC queries currently in the opportunity zone (positions 5–30). These are queries where AltWire is close to ranking on page 1 — small content or SEO improvements can move them up.',
      inputSchema: {
        start_date: z.string().describe('Start date — ISO format'),
        end_date: z.string().describe('End date — ISO format'),
      },
    },
    async ({ start_date, end_date }) => {
      const result = await getOpportunityZoneQueries(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_page_performance',
    {
      description: 'GSC performance for a specific AltWire page — clicks, impressions, CTR, and average position over a date range. Use for post-publish article performance checks.',
      inputSchema: {
        page_url: z.string().describe('Full article URL'),
        start_date: z.string().describe('Start date — ISO format'),
        end_date: z.string().describe('End date — ISO format'),
      },
    },
    async ({ page_url, start_date, end_date }) => {
      const result = await getPagePerformance(page_url, start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_combined_analytics',
    {
      description: 'Synthesizes Matomo (on-site behavior) and Google Search Console (organic search visibility) for a date range into a unified editorial picture: which articles drive both pageviews AND impressions, search-driven traffic share, opportunity-zone queries paired with on-site reader interest, and content gaps where search demand exists but AltWire ranks weakly. Returns combined metrics plus historical context from agent_memory.',
      inputSchema: {
        start_date: z.string().optional().describe('Start date — ISO format. Default: 28 days ago.'),
        end_date: z.string().optional().describe('End date — ISO format. Default: 3 days ago (GSC lag-aware).'),
        synthesize: z.boolean().default(true).optional().describe('Run LLM synthesis pass for narrative insights (default true)'),
      },
    },
    async ({ start_date, end_date, synthesize }) => {
      const result = await getCombinedAnalytics({ startDate: start_date, endDate: end_date, synthesize });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ days }) => {
      const result = await getStoryOpportunities({ days });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ days }) => {
      const result = await getNewsOpportunities({ days });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ article_url, snapshot_type }) => {
      const result = await getArticlePerformance({ article_url, snapshot_type });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ days }) => {
      const result = await getNewsPerformancePatterns({ days });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review: { id: 1, title: params.title, reviewer: params.reviewer || 'Derek', status: 'assigned' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await createReview(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review: { id: params.review_id, status: params.status || 'assigned' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await updateReview(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_review',
    {
      description: 'Fetch full review details by ID.',
      inputSchema: {
        review_id: z.number().int().positive().describe('Review ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review: { id: params.review_id, title: 'Test Review', reviewer: 'Derek', status: 'assigned' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getReview(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, reviews: [], count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listReviews(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_upcoming_review_deadlines',
    {
      description: 'Reviews due within the next N days (default 7), excluding completed/cancelled.',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7).optional().describe('Lookahead window in days — default 7'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, reviews: [], count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getUpcomingReviewDeadlines(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaner: { id: 1, item_name: params.item_name, borrower: params.borrower || 'Derek', status: params.is_loaner === false ? 'kept' : 'out' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await logLoaner(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaner: { id: params.loaner_id, status: params.status || 'out' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await updateLoaner(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_loaner',
    {
      description: 'Fetch full details of a specific loaner item.',
      inputSchema: {
        loaner_id: z.number().int().positive().describe('Loaner ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaner: { id: params.loaner_id, item_name: 'Test Item', borrower: 'Derek', status: 'out' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getLoaner(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaners: [], count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listLoaners(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_overdue_loaners',
    {
      description: 'All loaner items past their expected return date not yet returned.',
    },
    async () => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaners: [], count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getOverdueLoaners();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_upcoming_loaner_returns',
    {
      description: 'Loaner items expected back within the next N days (default 14).',
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14).optional().describe('Lookahead window in days — default 14'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, loaners: [], count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getUpcomingLoanerReturns(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, note: { id: 1, review_id: params.review_id, note_text: params.note_text, category: params.category || 'pro' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await addReviewNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, note: { id: params.note_id, category: params.category || 'pro' } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await updateReviewNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, notes: [], count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listReviewNotes(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_delete_review_note',
    {
      description: 'Delete a note by ID.',
      inputSchema: {
        note_id: z.number().int().positive().describe('Note ID to delete'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, deleted: true, note_id: params.note_id }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await deleteReviewNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_editorial_digest',
    {
      description: 'Full editorial status: active reviews by status, overdue items, upcoming deadlines, loaner status. Use for morning digest or on-demand check-ins.',
    },
    async () => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, review_pipeline: {}, loaner_summary: {}, upcoming_deadlines: [], overdue_loaners: [], generated_at: new Date().toISOString() }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getEditorialDigest();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, subject: { id: 1, name: params.name, active: true, added_at: new Date().toISOString(), notes: params.notes || null } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await addWatchSubject(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, deactivated_count: 1, subjects: [{ id: 1, name: params.name || 'Test Subject' }] }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await removeWatchSubject(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_list_watch_subjects',
    {
      description: 'View Derek\'s current news monitor watch list. By default shows only active subjects. Pass include_inactive=true to see previously removed subjects.',
      inputSchema: {
        include_inactive: z.boolean().default(false).optional().describe('Include previously removed subjects. Default false.'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, subjects: [], total: 0, active_count: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listWatchSubjects(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment: { id: 1, topic: params.topic, article_type: params.article_type || 'article', status: 'outline_ready', archive_hits: 3, web_research_summary: 'Test research...', has_review_notes: !!params.review_notes_id } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await createAssignment(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'generate_article_outline',
    {
      description: 'Generate a structured outline from an assignment\'s research. Returns an editable outline for Derek to review before any writing begins.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, outline: { title_suggestion: 'Test Headline', sections: [{ title: 'Intro', points: ['Point 1'] }], angle: 'Test angle', estimated_words: 800 } }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await generateOutline(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, status: params.decision === 'approved' ? 'outline_approved' : params.decision === 'rejected' ? 'cancelled' : 'outline_ready', decision_logged: true }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await approveOutline(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'generate_article_draft',
    {
      description: 'Generate the full article draft from an approved outline. Uses web research, archive voice reference, and review notes if present. Returns when draft is complete.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, status: 'draft_ready', word_count: 850, draft_preview: 'Test draft content...' }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await generateDraft(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'fact_check_draft',
    {
      description: 'Run a fact-checking pass on a completed draft. Verifies specific factual claims via web search. Only regenerates flagged sections — clean sections are preserved.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, passed: true, issues_found: 0, status: 'ready_to_post' }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await factCheckDraft(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, wp_post_id: 12345, wp_post_url: 'https://altwire.net/?p=12345', status: 'posted' }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await postToWordPress(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_draft_as_html',
    {
      description: 'Returns the article draft as clean HTML for copy-pasting into WordPress\'s Text/Code editor. Does not post to WordPress — just converts and returns the HTML. Available once a draft exists, regardless of pipeline status.',
      inputSchema: {
        assignment_id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignment_id: params.assignment_id, topic: 'Test Topic', title_suggestion: 'Test Headline', html: '<h2>Test</h2><p>Draft content.</p>', word_count: 850, instructions: 'Copy the html field and paste into WordPress → Text/Code editor.' }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getDraftAsHtml(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, decision_id: 1 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await logEditorialDecision(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'adjust_writer_system_prompt',
    {
      description: 'Self-improving loop: mine recent editorial feedback (outline edits, rejections, revisions, and feedback notes) into durable writing directives that are injected into the writer\'s outline and draft system prompts. Safe to run on demand or on a schedule.',
      inputSchema: {
        lookback_days: z.number().int().positive().optional().describe('Window of editorial decisions to consider (default 120)'),
        min_signals: z.number().int().positive().optional().describe('Minimum feedback signals required to adjust (default 3)'),
        dry_run: z.boolean().optional().describe('Compute proposed directives without persisting'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, adjusted: false }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await adjustWriterSystemPrompt(params || {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_writer_directives',
    {
      description: 'Return the writer\'s current learned editorial directives (the persisted output of the self-improving system-prompt loop).',
      inputSchema: {},
    },
    async () => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ directives: [], test_mode: true }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getWriterDirectives();
      return { content: [{ type: 'text', text: JSON.stringify(result || { directives: [] }) }] };
    }
  );

  scopedRegister(
    'get_article_assignment',
    {
      description: 'Fetch full details of a specific assignment including research context, outline, draft status, and decision history.',
      inputSchema: {
        id: z.number().int().positive().describe('Assignment ID'),
      },
    },
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, id: params.id, topic: 'Test Topic', status: 'outline_ready', decisions: [] }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await getAssignment(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      if (process.env.TEST_MODE === 'true') return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, assignments: [], count: 0, total: 0 }) }] };
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const result = await listAssignments(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async (params) => {
      const result = generateChart(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  const { getAltwireUptime, getAltwireIncidents } = await import('./handlers/altus-monitoring.js');
  const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');
  const { getAltwireIncidentComments, createAltwireIncidentComment, getAltwireStatusUpdates, createAltwireStatusUpdate } = await import('./handlers/altus-incident-handler.js');
  const { queryAltusEvents, synthesizeAudit } = await import('./altus-event-log.js');
  const { listActionItems, manageActionItem, getActionItemStats } = await import('./handlers/altus-action-items.js');
  const { querySessionTraces } = await import('./handlers/altus-session-traces.js');
  const { altusWebResearch } = await import('./handlers/altus-web-research.js');
  const { synthesizeTopic } = await import('./handlers/altus-topic-synthesis.js');
  const { searchSkills } = await import('./handlers/altus-skill-library.js');

  scopedRegister(
    'get_altwire_uptime',
    {
      description: 'Live status of AltWire\'s uptime monitors — altwire.net and WP Cron. Returns overall health and per-monitor status.',
    },
    async () => {
      const result = await getAltwireUptime();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_incidents',
    {
      description: 'Open (unresolved) incidents on AltWire\'s Better Stack monitors. Returns empty list when all is well.',
    },
    async () => {
      const result = await getAltwireIncidents();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ incident_id }) => {
      const result = await getAltwireIncidentComments(incident_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ incident_id, content }) => {
      const result = await createAltwireIncidentComment(incident_id, content);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_status_updates',
    {
      description: 'Retrieve status page updates for a Better Stack status report. Use to see recent public-facing status communications.',
      inputSchema: {
        status_report_id: z.string().describe('Better Stack status report ID'),
      },
    },
    async ({ status_report_id }) => {
      const result = await getAltwireStatusUpdates(status_report_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ status_report_id, message, affected_resources, notify_subscribers }) => {
      const result = await createAltwireStatusUpdate({ status_report_id, message, affected_resources, notify_subscribers });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ event_type, tool_name, session_id, last_n_hours, limit }) => {
      const result = await queryAltusEvents({ event_type, tool_name, session_id, last_n_hours, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ last_n_hours, batch_id, last_n_days, limit }) => {
      const result = await synthesizeAudit({ last_n_hours, batch_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'get_altwire_morning_digest',
    {
      description: 'Full AltWire morning briefing — site uptime, open incidents, today\'s news alerts, story opportunities, upcoming review deadlines, overdue loaners, and yesterday\'s traffic. Use at the start of a session or when Derek asks for a status overview.',
    },
    async () => {
      const result = await getAltwireMorningDigest();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_list_action_items',
    {
      description: 'List Altus action items for admin follow-through and heartbeat review.',
      inputSchema: {
        status: z.enum(['proposed', 'accepted', 'completed', 'dismissed']).optional().describe('Filter by action-item status'),
        category: z.enum(['marketing', 'operations', 'pricing', 'quality', 'infrastructure', 'editorial']).optional().describe('Filter by action-item category'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum action items to return'),
      },
    },
    async ({ status, category, limit }) => {
      const result = await listActionItems({ status, category, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_manage_action_item',
    {
      description: 'Accept, complete, or dismiss an Altus action item.',
      inputSchema: {
        item_id: z.number().int().describe('Action-item ID'),
        action: z.enum(['accept', 'complete', 'dismiss']).describe('Lifecycle action to perform'),
        reason: z.string().optional().describe('Dismissal or transition reason'),
        outcome_notes: z.string().optional().describe('Optional notes about the result or follow-through'),
      },
    },
    async ({ item_id, action, reason, outcome_notes }) => {
      const result = await manageActionItem({ item_id, action, reason, outcome_notes });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_action_item_stats',
    {
      description: 'Get summary counts for Altus action items by status.',
    },
    async () => {
      const result = await getActionItemStats();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_session_trace',
    {
      description: 'Inspect Altus session traces derived from the event log.',
      inputSchema: {
        session_id: z.number().int().optional().describe('Return the full event stream for a specific session'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum session summaries to return when session_id is omitted'),
      },
    },
    async ({ session_id, limit }) => {
      const result = await querySessionTraces({ session_id, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_web_research',
    {
      description: 'Perform shared Hal-style web research for AltWire admin questions.',
      inputSchema: {
        query: z.string().describe('Question or topic to research'),
        limit: z.number().int().min(1).max(10).optional().describe('Maximum number of search results to synthesize'),
      },
    },
    async ({ query, limit }) => {
      const result = await altusWebResearch({ query, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_topic_synthesis',
    {
      description: 'Synthesize research findings into an AltWire editorial briefing.',
      inputSchema: {
        topic: z.string().describe('Topic to synthesize'),
        findings: z.array(z.string()).describe('Findings or signals to combine into a briefing'),
      },
    },
    async ({ topic, findings }) => {
      const result = await synthesizeTopic({ topic, findings });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_search_skills',
    {
      description: 'Search Altus shared skills for reusable admin workflows.',
      inputSchema: {
        query: z.string().optional().describe('Skill name or keyword query'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum skills to return'),
      },
    },
    async ({ query, limit }) => {
      const result = await searchSkills({ query, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ text, post_type, emoji, severity, channel_override }) => {
      const result = await postStatusUpdate({ text, post_type, emoji, severity, channel_override });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ limit, severity_filter }) => {
      const posts = await getSlackPostHistory({ limit, severity_filter });
      return { content: [{ type: 'text', text: JSON.stringify(posts) }] };
    }
  );

  // -------------------------------------------------------------------------
  // SLACK EXTENDED CAPABILITIES
  // -------------------------------------------------------------------------

  const { addReaction, listReactions, getDndStatus, uploadSlackFile, listChannelFiles, shareFilePublic, sendDm, openDm, searchSlackMessages, scheduleSlackMessage } = await import('./handlers/slack-altus.js');

  scopedRegister(
    'add_slack_reaction',
    {
      description: 'Add an emoji reaction to a Slack message. Use this when someone asks Hal to react to something, or as acknowledgment.',
      inputSchema: {
        channel: z.string().describe('Slack channel ID of the message'),
        message_ts: z.string().describe('Timestamp of the message to react to'),
        emoji: z.string().describe('Emoji name without colons, e.g. "white_check_mark" or "heart"'),
      },
    },
    async ({ channel, message_ts, emoji }) => {
      const result = await addReaction(channel, message_ts, emoji);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'list_slack_reactions',
    {
      description: 'List all emoji reactions on a specific Slack message. Useful for reading reaction context.',
      inputSchema: {
        channel: z.string().describe('Slack channel ID'),
        message_ts: z.string().describe('Timestamp of the message'),
      },
    },
    async ({ channel, message_ts }) => {
      const reactions = await listReactions(channel, message_ts);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, reactions }) }] };
    }
  );

  scopedRegister(
    'get_slack_dnd_status',
    {
      description: "Get a Slack user's Do Not Disturb status. Pass no user_id to check the team member's own status. Useful for context-awareness before initiating contact.",
      inputSchema: {
        user_id: z.string().optional().describe('Slack user ID. Omit to check own DND status.'),
      },
    },
    async ({ user_id }) => {
      const result = await getDndStatus(user_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'upload_slack_file',
    {
      description: 'Upload a file to Slack, optionally posting it to one or more channels. Returns a file ID and permalink.',
      inputSchema: {
        content: z.string().optional().describe('File content as a string'),
        filename: z.string().describe('Name of the file to upload'),
        title: z.string().optional().describe('Title shown in Slack'),
        channels: z.string().optional().describe('Comma-separated channel IDs to post the file to'),
        initial_comment: z.string().optional().describe('Comment to attach when posting to channels'),
      },
    },
    async ({ content, filename, title, channels, initial_comment }) => {
      const result = await uploadSlackFile({ content, filename, title, channels, initialComment: initial_comment });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'list_slack_channel_files',
    {
      description: 'List recent files shared in a Slack channel. Useful for retrieving documents, exports, or assets.',
      inputSchema: {
        channel: z.string().describe('Slack channel ID to search'),
        limit: z.number().int().min(1).max(100).default(10).optional().describe('Max files to return'),
      },
    },
    async ({ channel, limit }) => {
      const files = await listChannelFiles(channel, limit);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, files }) }] };
    }
  );

  scopedRegister(
    'share_slack_file_public',
    {
      description: 'Generate a public shareable URL for a Slack file. Use this to share files outside Slack or via email.',
      inputSchema: {
        file_id: z.string().describe('Slack file ID'),
      },
    },
    async ({ file_id }) => {
      const result = await shareFilePublic(file_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'send_slack_dm',
    {
      description: 'Send a direct message to a Slack user. Opens a DM conversation if one does not exist.',
      inputSchema: {
        user_id: z.string().describe('Slack user ID to send the DM to'),
        text: z.string().min(1).max(4000).describe('Message text (max 4000 chars)'),
      },
    },
    async ({ user_id, text }) => {
      const result = await sendDm(user_id, text);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'open_slack_dm',
    {
      description: 'Open a direct message conversation with a Slack user. Returns the channel ID for threading follow-up messages.',
      inputSchema: {
        user_id: z.string().describe('Slack user ID'),
      },
    },
    async ({ user_id }) => {
      const channel = await openDm(user_id);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, channel }) }] };
    }
  );

  scopedRegister(
    'search_slack_messages',
    {
      description: 'Search past messages in Slack by keyword. Useful for finding context, prior decisions, or customer history across all channels.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Search query string'),
        limit: z.number().int().min(1).max(100).default(20).optional().describe('Max results to return'),
        channels: z.array(z.string()).optional().describe('Optional channel IDs to restrict search to'),
      },
    },
    async ({ query, limit, channels }) => {
      const result = await searchSlackMessages(query, limit, channels);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'schedule_slack_message',
    {
      description: 'Schedule a message to be posted to a Slack channel at a future time. Use for announcements, reminders, or time-sensitive posts.',
      inputSchema: {
        channel: z.string().describe('Slack channel ID to post to'),
        text: z.string().min(1).max(4000).describe('Message text'),
        post_at_ts: z.number().int().describe('Unix timestamp for when to deliver the message (must be in the future, max 120 days out)'),
        emoji: z.string().optional().describe('Optional lead emoji'),
      },
    },
    async ({ channel, text, post_at_ts, emoji }) => {
      const result = await scheduleSlackMessage(channel, text, post_at_ts, emoji);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ key }) => {
      const result = await readMemory(key);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ key, value }) => {
      if (key.startsWith('hal:soul') || key.startsWith('hal:onboarding_state:')) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, exit_reason: 'protected_key', message: 'Protected key — use the seed script to update hal:soul values.' }) }] };
      }
      const result = await writeMemory(key, value);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'hal_list_memory',
    {
      description: 'List all Hal agent memory keys and values, newest first. Useful for discovering what memory keys exist and their last-updated timestamps.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).optional().describe('Max entries to return (default 50)'),
      },
    },
    async ({ limit }) => {
      const rows = await listMemory();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, entries: rows.slice(0, limit), total: rows.length }) }] };
    }
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
    async ({ url, title, category, notes }) => {
      const result = await trackArticle({ url, title, category, notes });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'list_tracked_articles',
    {
      description: 'List all tracked articles, newest first. Returns URL, title, category, tracked_at, and notes.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).optional().describe('Max articles to return (default 50)'),
      },
    },
    async ({ limit }) => {
      const result = await listTrackedArticles({ limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ topic, angle, status, notes }) => {
      const result = await addContentIdea({ topic, angle, status, notes });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
async ({ status, limit }) => {
      const result = await getContentIdeas({ status, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async ({ url, description }) => {
      const result = await evaluateLinkFitness({ url, description });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
    async () => {
      const profile = await getDerekAuthorProfile();
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, profile: profile || null }) }] };
    }
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
    async ({ field_path, value }) => {
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
    }
  );

  // -------------------------------------------------------------------------
  // AI Writer — Phase 4: Writer Summary
  // -------------------------------------------------------------------------

  scopedRegister(
    'get_writer_summary',
    {
      description: 'Aggregated writer stats for the prompt page context card — active assignments, action needed count, ready to post count, last digest time, search opportunities, and today\'s Matomo pageviews.',
    },
    async () => {
      if (!hasDbConfig()) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database not configured' }) }] };
      const { getTrafficSummary } = await import('./handlers/altwire-matomo-client.js');
      const { getSearchOpportunities } = await import('./handlers/altwire-gsc-client.js');
      const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');
      const { buildWriterSummary } = await import('./handlers/altus-writer-summary.js');
      const summary = await buildWriterSummary({
        getTrafficSummary,
        getSearchOpportunities,
        getAltwireMorningDigest,
      });
      return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
    }
  );

  // -------------------------------------------------------------------------
  // AI Cost Summary
  // -------------------------------------------------------------------------

  const { getAiCostSummary } = await import('./lib/ai-cost-tracker.js');

  scopedRegister(
    'get_altus_ai_cost_summary',
    {
      description: 'Altus AI usage cost breakdown — by model, by tool, and by period (today, 7d, 30d). Use to track Anthropic API spend across all Altus operations.',
    },
    async () => {
      const result = await getAiCostSummary();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Multi-Admin Onboarding
  // -------------------------------------------------------------------------

  const {
    checkOnboardingStatus,
    saveOnboardingResponse,
    getOnboardingPreferences,
    getPerchAgenda,
    updatePerchAgenda,
    resetOnboarding,
  } = await import('./handlers/altus-onboarding.js');

  scopedRegister(
    'altus_check_onboarding_status',
    {
      description: 'Check whether a specific admin has completed Altus onboarding. Returns the current phase or "complete".',
      inputSchema: {
        admin_id: z.number().describe('Admin ID — must be a number'),
      },
    },
    async ({ admin_id }) => {
      const result = await checkOnboardingStatus({ admin_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_save_onboarding_response',
    {
      description: 'Save an admin\'s response for a specific onboarding phase. Advances to the next phase or completes onboarding when all five phases are done.',
      inputSchema: {
        admin_id: z.number().describe('Admin ID'),
        phase: z.enum(['workload', 'tracking', 'checkins', 'communication', 'perch']).describe('Phase to save response for'),
        response: z.string().describe('Admin\'s natural language response to the phase prompt'),
      },
    },
    async ({ admin_id, phase, response }) => {
      const result = await saveOnboardingResponse({ admin_id, phase, response });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_onboarding_preferences',
    {
      description: 'Retrieve all stored preferences for a specific admin — communication style, monitoring topics, etc.',
      inputSchema: {
        admin_id: z.number().describe('Admin ID'),
      },
    },
    async ({ admin_id }) => {
      const result = await getOnboardingPreferences({ admin_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_perch_agenda',
    {
      description: 'Read the shared Altus perch agenda — monitoring topics across all admins and scheduled jobs.',
    },
    async () => {
      const result = await getPerchAgenda();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_update_perch_agenda',
    {
      description: 'Update a specific admin\'s monitoring topics in the shared perch agenda. Replaces the admin\'s topics and recomputes the merged monitoring list.',
      inputSchema: {
        admin_id: z.number().describe('Admin ID'),
        monitoring: z.array(z.string()).describe('Array of monitoring topic strings'),
      },
    },
    async ({ admin_id, monitoring }) => {
      const result = await updatePerchAgenda({ admin_id, monitoring });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_reset_onboarding',
    {
      description: 'Reset an admin\'s onboarding state back to the beginning. Requires confirm: true.',
      inputSchema: {
        admin_id: z.number().describe('Admin ID'),
        confirm: z.boolean().describe('Must be true to confirm the reset'),
      },
    },
    async ({ admin_id, confirm }) => {
      const result = await resetOnboarding({ admin_id, confirm });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // Mountaineering tools — supervised hill-climbing optimization loop
  // -------------------------------------------------------------------------
  scopedRegister(
    'altus_list_chat_presence',
    {
      description: 'List active Altus chat/session presence rows. Useful when checking whether the shared Hal shell still has a live Altus session attached.',
      inputSchema: {
        client_id: z.string().optional().describe('Optional client ID filter'),
        active_only: z.boolean().default(true).optional().describe('Only return recently active sessions (default true)'),
        limit: z.number().int().min(1).max(100).default(20).optional().describe('Max rows to return (default 20)'),
      },
    },
    async ({ client_id, active_only, limit }) => {
      const result = await listChatPresence({ client_id, active_only, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_list_documents',
    {
      description: 'Browse lightweight shared-Hal documents stored in agent memory, including editorial context, reflections, research notes, and workspace guidance.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).optional().describe('Max documents to return (default 50)'),
      },
    },
    async ({ limit }) => {
      const result = await listDocuments({ limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_document',
    {
      description: 'Retrieve a single lightweight shared-Hal document by agent-memory key.',
      inputSchema: {
        key: z.string().min(1).describe('Document key, such as hal:altwire:editorial_context'),
      },
    },
    async ({ key }) => {
      const result = await getDocument(key);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_save_document',
    {
      description: 'Update a lightweight shared-Hal document in agent memory without touching broader memory routing or analytics payloads.',
      inputSchema: {
        key: z.string().min(1).describe('Existing document key to update'),
        value: z.string().describe('Replacement document value'),
      },
    },
    async ({ key, value }) => {
      if (process.env.TEST_MODE === 'true') {
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, test_mode: true, key }) }] };
      }
      const result = await saveDocument(key, value);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_record_commitment',
    {
      description: 'Record a durable Altus commitment so shared-Hal follow-through survives beyond the current session.',
      inputSchema: {
        admin_id: z.number().int().positive().optional().describe('Optional Altus admin ID owner'),
        client_id: z.string().optional().describe('Optional OAuth client owner'),
        title: z.string().min(1).describe('Short commitment title'),
        description: z.string().optional().describe('Optional detail about what will be done'),
        due_at: z.string().optional().describe('Optional ISO due datetime'),
        source: z.string().optional().describe('Source label, defaults to manual'),
        evidence: z.string().optional().describe('Optional evidence or rationale'),
        session_id: z.union([z.string(), z.number()]).optional().describe('Optional originating session ID'),
      },
    },
    async (params) => {
      const result = await recordCommitment(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_list_commitments',
    {
      description: 'List tracked Altus commitments by status, optionally filtering for overdue items.',
      inputSchema: {
        status: z.enum(['open', 'completed', 'blocked', 'cancelled']).default('open').optional().describe('Commitment status to list'),
        overdue: z.boolean().default(false).optional().describe('Only include overdue commitments'),
        limit: z.number().int().min(1).max(100).default(20).optional().describe('Max rows to return (default 20)'),
      },
    },
    async ({ status, overdue, limit }) => {
      const result = await listCommitments({ status, overdue, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_update_commitment',
    {
      description: 'Advance or close an existing Altus commitment with evidence and outcome notes.',
      inputSchema: {
        commitment_id: z.number().int().positive().describe('Commitment ID'),
        status: z.enum(['open', 'completed', 'blocked', 'cancelled']).describe('New commitment status'),
        evidence: z.string().optional().describe('Optional evidence update'),
        outcome_notes: z.string().optional().describe('Optional outcome notes'),
      },
    },
    async (params) => {
      const result = await updateCommitment(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_record_watch_item',
    {
      description: 'Record a durable watch item for something Altus should revisit or monitor over time.',
      inputSchema: {
        admin_id: z.number().int().positive().optional().describe('Optional Altus admin ID owner'),
        client_id: z.string().optional().describe('Optional OAuth client owner'),
        title: z.string().min(1).describe('Short watch item title'),
        description: z.string().optional().describe('Optional detail about what to watch'),
        cadence: z.string().optional().describe('Cadence label such as daily, weekly, or as-needed'),
        next_check_at: z.string().optional().describe('Optional ISO datetime for the next check'),
        source: z.string().optional().describe('Source label, defaults to manual'),
        evidence: z.string().optional().describe('Optional evidence or rationale'),
        session_id: z.union([z.string(), z.number()]).optional().describe('Optional originating session ID'),
      },
    },
    async (params) => {
      const result = await recordWatchItem(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_list_watch_items',
    {
      description: 'List tracked Altus watch items by status, optionally filtering for items due for a check-in.',
      inputSchema: {
        status: z.enum(['active', 'resolved', 'cancelled']).default('active').optional().describe('Watch item status to list'),
        due: z.boolean().default(false).optional().describe('Only include items due for review'),
        limit: z.number().int().min(1).max(100).default(20).optional().describe('Max rows to return (default 20)'),
      },
    },
    async ({ status, due, limit }) => {
      const result = await listWatchItems({ status, due, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_update_watch_item',
    {
      description: 'Advance, resolve, or cancel a tracked Altus watch item.',
      inputSchema: {
        watch_item_id: z.number().int().positive().describe('Watch item ID'),
        status: z.enum(['active', 'resolved', 'cancelled']).describe('New watch item status'),
        next_check_at: z.string().optional().describe('Optional replacement ISO next-check datetime'),
        evidence: z.string().optional().describe('Optional evidence update'),
        outcome_notes: z.string().optional().describe('Optional outcome notes'),
      },
    },
    async (params) => {
      const result = await updateWatchItem(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_record_autonomy_note',
    {
      description: 'Store a lightweight autonomy or policy note alongside the new commitment-tracking surfaces.',
      inputSchema: {
        admin_id: z.number().int().positive().optional().describe('Optional Altus admin ID owner'),
        client_id: z.string().optional().describe('Optional OAuth client owner'),
        note_type: z.string().optional().describe('Note type label, defaults to general'),
        body: z.string().min(1).describe('Autonomy note body'),
        source: z.string().optional().describe('Source label, defaults to autonomy'),
        evidence: z.string().optional().describe('Optional evidence or rationale'),
        session_id: z.string().optional().describe('Optional originating session ID'),
      },
    },
    async (params) => {
      const result = await recordAutonomyNote(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_send_admin_email',
    {
      description: 'Send a fresh Altus admin-only email via SES. Use only for Derek/Ed/admin progress updates, small blocking questions, or urgent admin alerts. Recipients must be configured admin addresses such as DEREK_EMAIL, ED_EMAIL, ALTUS_ADMIN_EMAILS, ALTUS_CC_EMAILS, ADMIN_EMAILS, or HAL_ADMIN_EMAILS.',
      inputSchema: {
        to: z.string().describe('Admin recipient email address. Display-name format is allowed if it resolves to a configured admin address.'),
        cc: z.string().optional().describe('Optional comma-separated admin CC recipients. All recipients must be configured admins.'),
        subject: z.string().min(1).max(200).describe('Email subject line'),
        body: z.string().min(1).max(10000).describe('Plain-text email body'),
      },
    },
    async ({ to, cc, subject, body }) => {
      const result = await sendAltusAdminEmail({ to, cc, subject, body });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_create_climb',
    {
      description: 'Create a new mountaineering optimization climb. A climb defines what to optimize (objective), how to measure it (metric_description), where the mutable state lives (workspace_key in agent_memory), and frozen evaluation criteria (eval_snapshot). Name must be lowercase kebab-case.',
      inputSchema: {
        name: z.string().describe('Climb name — lowercase kebab-case, min 2 chars (e.g. "morning-digest-v1")'),
        objective: z.string().describe('Plain-English goal for what this climb optimizes'),
        metric_description: z.string().describe('How success is measured — what signals or data are used to score iterations'),
        workspace_key: z.string().describe('Key in agent_memory holding the value to optimize (must already exist)'),
        eval_snapshot: z.record(z.unknown()).describe('Frozen evaluation criteria as a JSON object — cannot be empty'),
      },
    },
    async ({ name, objective, metric_description, workspace_key, eval_snapshot }) => {
      const result = await createClimb({ name, objective, metric_description, workspace_key, eval_snapshot });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_start_climb_iteration',
    {
      description: 'Start a new iteration for a climb. Reads the current workspace_key value, asks Claude Haiku to propose a targeted change, writes the proposal to agent_memory, and records the iteration. Only allowed when climb status is idle or running.',
      inputSchema: {
        climb_name: z.string().describe('Name of the climb to iterate on'),
      },
    },
    async ({ climb_name }) => {
      const result = await startClimbIteration({ climb_name });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_score_climb_iteration',
    {
      description: 'Submit a scoring batch request for a completed iteration. Reads eval_snapshot from the database (not from caller) and queues an Anthropic Batch API job. Results are collected automatically every 2 hours by the mountaineering batch cron.',
      inputSchema: {
        climb_name: z.string().describe('Name of the climb'),
        iteration_number: z.number().int().describe('Iteration number to score'),
      },
    },
    async ({ climb_name, iteration_number }) => {
      const result = await scoreClimbIteration({ climb_name, iteration_number });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_climb_status',
    {
      description: 'Get current status, score trend, and plateau detection for a climb. Returns plateau_alert: true when the last 3+ consecutive decisions are all "plateau".',
      inputSchema: {
        climb_name: z.string().describe('Name of the climb'),
      },
    },
    async ({ climb_name }) => {
      const result = await getClimbStatus({ climb_name });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_supervisor_decision',
    {
      description: 'Record your decision on a scored iteration. "keep" — accept the proposed change (workspace stays updated). "revert" — reject the change (previous value restored to agent_memory). "plateau" — reject and signal the climb is stalling (previous value restored).',
      inputSchema: {
        climb_name: z.string().describe('Name of the climb'),
        iteration_number: z.number().int().describe('Iteration number to decide on'),
        decision: z.enum(['keep', 'revert', 'plateau']).describe('Your decision: keep, revert, or plateau'),
      },
    },
    async ({ climb_name, iteration_number, decision }) => {
      const result = await supervisorDecision({ climb_name, iteration_number, decision });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_peak_climb',
    {
      description: 'Declare a climb peaked — the current best workspace value is the optimum. Sets status to "peaked" and records the best_workspace_value. Only allowed on running or paused climbs.',
      inputSchema: {
        climb_name: z.string().describe('Name of the climb to peak'),
      },
    },
    async ({ climb_name }) => {
      const result = await peakClimb({ climb_name });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  scopedRegister(
    'altus_get_climb_history',
    {
      description: 'Return paginated iteration history for a climb — all proposed changes, scores, decisions, and evidence summaries.',
      inputSchema: {
        climb_name: z.string().describe('Name of the climb'),
        limit: z.number().int().min(1).max(200).default(50).optional().describe('Max iterations to return (default 50, max 200)'),
        offset: z.number().int().min(0).default(0).optional().describe('Pagination offset (default 0)'),
      },
    },
    async ({ climb_name, limit, offset }) => {
      const result = await getClimbHistory({ climb_name, limit, offset });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
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
  for (const [secretEnvVarName, secretValue] of Object.entries(process.env)) {
    if (!secretEnvVarName.startsWith('OAUTH_CLIENT_SECRET_')) continue;
    const secretHash = crypto.createHash('sha256').update(secretValue).digest();
    try {
      if (crypto.timingSafeEqual(providedHash, secretHash)) {
        const operator = secretEnvVarName.slice('OAUTH_CLIENT_SECRET_'.length);
        const clientIdEnvKey = `OAUTH_CLIENT_ID_${operator}`;
        return process.env[clientIdEnvKey] || null;
      }
    } catch { /* timingSafeEqual threw — lengths mismatch */ }
  }
  return identifyCompatibleHalClient(token);
}

// ---------------------------------------------------------------------------
// Allowed UI origins for /hal/auth, /hal/chat, and /events/* (CORS).
// Set HAL_UI_ALLOWED_ORIGINS as a comma-separated list of origins in Railway.
// Falls back to wildcard when unset so local dev works out of the box.
// ---------------------------------------------------------------------------
const HAL_UI_ALLOWED_ORIGINS = process.env.HAL_UI_ALLOWED_ORIGINS
  ? new Set(process.env.HAL_UI_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean))
  : null; // null = allow all

function setChatCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return; // server-to-server — no CORS needed
  if (!HAL_UI_ALLOWED_ORIGINS || HAL_UI_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Agent-Context, Accept');
}

async function trackChatPresence(req, clientId) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return;
  const token = authHeader.slice(7).trim();
  if (!token || !clientId) return;

  const sessionTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    await upsertChatPresence({
      client_id: clientId,
      session_token_hash: sessionTokenHash,
    });
  } catch (err) {
    logger.warn('Chat presence upsert failed', { error: err.message, clientId });
  }
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Handle CORS preflight for Hal UI endpoints
  if (req.method === 'OPTIONS' && (
    url.pathname === '/hal/auth' ||
    url.pathname === '/hal/chat' ||
    url.pathname === '/hal/chat-sessions' ||
    url.pathname.startsWith('/hal/chat-sessions/') ||
    url.pathname.startsWith('/hal/writer/') ||
    url.pathname.startsWith('/altwire/') ||
    url.pathname.startsWith('/events/')
  )) {
    setChatCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Global CORS for the MCP transport, OAuth, and discovery endpoints ---
  // Claude's web/desktop client issues browser-originated requests (Origin:
  // https://claude.ai) to /.well-known/*, /authorize, /oauth/*, and /mcp. Without
  // these headers the browser blocks the responses and the connection fails with
  // "Authorization with the MCP server failed" — which is why cirrus/nimbus (which
  // set CORS globally) connect and altus did not. Mirrors their behavior.
  {
    const ALLOWED_ORIGINS = new Set([
      'https://claude.ai',
      'https://app.claude.ai',
      'https://claude.com',
      process.env.ALLOWED_ORIGIN,
    ].filter(Boolean));
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (!origin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, X-Agent-Context, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  const halUiRateLimitBucket = getHalUiRateLimitBucket(req.method, url.pathname);
  if (halUiRateLimitBucket === 'chat') {
    if (!halChatLimiter.check(req, res)) return;
  } else if (halUiRateLimitBucket === 'ui') {
    if (!halUiLimiter.check(req, res)) return;
  } else if (!globalLimiter.check(req, res)) {
    return;
  }

  if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: MCP_BASE_URL,
      authorization_endpoint: `${MCP_BASE_URL}/authorize`,
      token_endpoint: `${MCP_BASE_URL}/oauth/token`,
      registration_endpoint: `${MCP_BASE_URL}/oauth/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    }));
    return;
  }

  // OAuth 2.0 Protected Resource Metadata (RFC 9728).
  // MCP clients (Claude) fetch this FIRST to discover the authorization server
  // for this resource. Without it, Claude cannot bootstrap the OAuth flow —
  // cirrus/nimbus expose this, which is why they connect and altus did not.
  if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      resource: MCP_BASE_URL,
      authorization_servers: [MCP_BASE_URL],
      scopes_supported: ['read'],
    }));
    return;
  }

  // POST /oauth/register — RFC 7591 Dynamic Client Registration
  // MCP clients (Claude Desktop, Claude Code) use this to self-register before
  // starting the OAuth flow. PKCE-only: no client_secret issued or required.
  if (url.pathname === '/oauth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let meta;
      try { meta = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client_metadata' }));
        return;
      }
      const clientId = `dyn_${crypto.randomBytes(16).toString('hex')}`;
      const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
      const { storeClient } = await import('./lib/oauth-store.js');
      await storeClient(clientId, {
        redirectUris,
        clientName: meta.client_name || 'MCP Client',
      });
      logger.info('OAuth dynamic client registered', { clientId, clientName: meta.client_name });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }));
    });
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
    const isStaticClient = OAUTH_CLIENTS.has(clientId);
    const { getClient } = await import('./lib/oauth-store.js');
    const dynamicClient = isStaticClient ? null : await getClient(clientId);
    if (!isStaticClient && !dynamicClient) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'unknown client_id' }));
      return;
    }
    // Validate redirect_uri. Accept it if it is on the static allowlist, is a
    // loopback callback, or was registered by this client via Dynamic Client
    // Registration (RFC 7591). Honoring the DCR-registered URIs is required for
    // Claude Desktop / Claude Code, which self-register their own callback —
    // without this check they fail here with 'redirect_uri not allowed'.
    // Loopback (localhost/127.0.0.1) ports vary per session and are only
    // reachable on the user's own machine, so they are matched port-agnostically.
    const isLocalhostRedirect = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(redirectUri);
    const isRegisteredRedirect = !!dynamicClient && dynamicClient.redirectUris.includes(redirectUri);
    if (!isLocalhostRedirect && !isRegisteredRedirect && !OAUTH_ALLOWED_REDIRECT_URIS.has(redirectUri)) {
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
      const { getClient } = await import('./lib/oauth-store.js');
      const isDynamic = !operator && !!(await getClient(clientId));
      if (!operator && !isDynamic) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      if (!isDynamic) {
        // Static clients may have a secret — verify if configured
        const secretEnvKey = `OAUTH_CLIENT_SECRET_${operator}`;
        const expectedSecret = process.env[secretEnvKey];
        if (expectedSecret && presentedSecret) {
          const presentedHash = crypto.createHash('sha256').update(presentedSecret).digest();
          const expectedHash = crypto.createHash('sha256').update(expectedSecret).digest();
          if (!crypto.timingSafeEqual(presentedHash, expectedHash)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_client' }));
            return;
          }
        }
      }
      // Dynamic clients are PKCE-only — no secret check needed

      if (grantType === 'authorization_code') {
        const { getAuthCode, storeAccessToken, storeRefreshToken } = await import('./lib/oauth-store.js');
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
        // Code is already deleted atomically within getAuthCode — no separate delete needed.
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
        if (refreshData.clientId && clientId !== refreshData.clientId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'client_id mismatch' }));
          return;
        }
        const effectiveClientId = refreshData.clientId || clientId;
        await deleteRefreshToken(refreshToken);
        const accessToken = generateAccessToken();
        const newRefreshToken = generateAccessToken();
        await storeAccessToken(accessToken, { clientId: effectiveClientId, scope: refreshData.scope || 'read' });
        await storeRefreshToken(newRefreshToken, { clientId: effectiveClientId, scope: refreshData.scope });
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

  // ---------------------------------------------------------------------------
  // Auth — POST /hal/auth
  // Issues a signed session token for web API keys (HAL_KEY_*_WEB env vars).
  // Used by the Hal Chat UI when in altwire mode so admins don't need nimbus.
  // ---------------------------------------------------------------------------
  if (url.pathname === '/hal/auth' && req.method === 'POST') {
    if (!authLimiter.check(req, res)) return;
    setChatCors(req, res);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let apiKey;
      try {
        apiKey = JSON.parse(body).apiKey;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'apiKey required' }));
        return;
      }
      const identity = authenticateHalWebToken(apiKey);
      if (!identity || identity.interface !== 'web') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid access key' }));
        return;
      }
      try {
        const token = signHalWebSessionToken(identity);
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token, expiresAt, adminName: identity.name }));
      } catch (err) {
        logger.error('Auth token signing failed', { error: err.message });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'auth_unavailable' }));
      }
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Chat session persistence — /hal/chat-sessions
  // Same REST surface as Nimbus so the shared Hal chat UI can save, list,
  // restore, and delete sessions when running in altwire mode.
  // Auth: any valid HAL web API key or signed web session token.
  // ---------------------------------------------------------------------------
  if (url.pathname === '/hal/chat-sessions' || url.pathname.startsWith('/hal/chat-sessions/')) {
    setChatCors(req, res);
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer /, '').trim();
    const caller = authenticateHalWebToken(bearer);
    if (!caller) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // POST /hal/chat-sessions — save (upsert) a session
    if (url.pathname === '/hal/chat-sessions' && req.method === 'POST') {
      const MAX_BODY_BYTES = 1048576; // 1 MB — chat history can be sizeable
      let bodySize = 0;
      let bodySizeExceeded = false;
      let body = '';
      req.on('data', (chunk) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_BYTES) { bodySizeExceeded = true; req.destroy(); return; }
        body += chunk;
      });
      req.on('end', async () => {
        if (bodySizeExceeded) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Payload too large' })); return; }
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_json' })); return; }
        const { id, title, messages } = parsed;
        if (!id || !messages) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'id and messages required' })); return; }
        const result = await saveChatSession(id, title || 'Untitled', messages, caller.name ?? null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    // GET /hal/chat-sessions — list recent sessions
    if (url.pathname === '/hal/chat-sessions' && req.method === 'GET') {
      const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : 50;
      const result = await listChatSessions(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // GET/DELETE /hal/chat-sessions/:id — fetch or delete a session
    if (url.pathname.startsWith('/hal/chat-sessions/') && (req.method === 'GET' || req.method === 'DELETE')) {
      const sessionId = decodeURIComponent(url.pathname.slice('/hal/chat-sessions/'.length));
      const result = req.method === 'DELETE' ? await deleteChatSession(sessionId) : await getChatSession(sessionId);
      res.writeHead(result.error === 'not_found' ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  // Slack events — signature verification handled by slack-altus.js
  if (url.pathname === '/slack/events' && req.method === 'POST') {
    await observe({ name: 'slack_webhook', spanType: 'DEFAULT' }, async () => {
      const { handleSlackRequest } = await import('./handlers/slack-altus.js');
      handleSlackRequest(req, res);
    });
    return;
  }

  // CORS allowlist for writer REST endpoints.
  // Uses ALTUS_WRITER_ALLOWED_ORIGINS if set; falls back to HAL_UI_ALLOWED_ORIGINS
  // so the chat UI works without a separate env var.
  const ALLOWED_ORIGINS = new Set(
    [
      ...(process.env.ALTUS_WRITER_ALLOWED_ORIGINS || '').split(','),
      ...(process.env.HAL_UI_ALLOWED_ORIGINS || '').split(','),
    ]
      .map(u => u.trim())
      .filter(Boolean)
  );

  // ---------------------------------------------------------------------------
  // Writer REST endpoints — authenticated via ALTUS_ADMIN_TOKEN
  // ---------------------------------------------------------------------------
  if (url.pathname.startsWith('/hal/writer/')) {
    // CORS — enforce the explicit allowlist when one is configured; otherwise
    // mirror setChatCors and reflect the origin so the chat UI works without
    // extra env vars. (Preflights are answered by the shared handler above.)
    const origin = req.headers.origin;
    if (origin) {
      if (ALLOWED_ORIGINS.size > 0 && !ALLOWED_ORIGINS.has(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'origin_not_allowed' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    // Auth check
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!isAllowedAltusRestToken(authToken, { allowAltusAdminToken: true })) {
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
          `SELECT id, topic, article_type, status, draft_word_count, wp_post_url, research_status, created_at, updated_at,
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
        const refresh = ['1', 'true', 'yes'].includes((url.searchParams.get('refresh') || '').toLowerCase());
        const result = await getStoryOpportunities({ refresh });
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

    // GET /hal/writer/summary — dashboard summary card for the chat UI prompt page
    if (url.pathname === '/hal/writer/summary' && req.method === 'GET') {
      try {
        const { getTrafficSummary } = await import('./handlers/altwire-matomo-client.js');
        const { getSearchOpportunities } = await import('./handlers/altwire-gsc-client.js');
        const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');
        const { buildWriterSummary } = await import('./handlers/altus-writer-summary.js');
        const summary = await buildWriterSummary({ getTrafficSummary, getSearchOpportunities, getAltwireMorningDigest });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary));
      } catch (err) {
        logger.error('Writer summary query failed', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'summary_failed', message: err.message }));
      }
      return;
    }

    // GET /hal/writer/author-profile — editorial voice profile for the settings drawer
    if (url.pathname === '/hal/writer/author-profile' && req.method === 'GET') {
      try {
        const { getDerekAuthorProfile } = await import('./hal-harness.js');
        const profile = await getDerekAuthorProfile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, profile: profile || null }));
      } catch (err) {
        logger.error('Author profile query failed', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'profile_failed' }));
      }
      return;
    }

    // POST /hal/writer/author-profile — update one field ({ field_path, value })
    if (url.pathname === '/hal/writer/author-profile' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let params;
      try { params = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'invalid_json' }));
        return;
      }
      const { field_path, value } = params ?? {};
      const ALLOWED_PROFILE_PATHS = [
        'writing_voice.tone', 'writing_voice.formality',
        'writing_voice.sentence_patterns', 'writing_voice.first_person_usage',
        'writing_voice.emotional_candor', 'writing_voice.humor_style',
        'what_to_preserve_in_ai_drafts',
      ];
      if (!ALLOWED_PROFILE_PATHS.includes(field_path) || typeof value !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'invalid_field_path', allowed: ALLOWED_PROFILE_PATHS }));
        return;
      }
      try {
        const { getDerekAuthorProfile } = await import('./hal-harness.js');
        const current = await getDerekAuthorProfile() || {};
        const parts = field_path.split('.');
        let obj = current;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
        await pool.query(
          `INSERT INTO agent_memory (agent, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (agent, key) DO UPDATE SET value = $3`,
          ['hal', 'hal:altwire:editorial_voice_profile', JSON.stringify(current)]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, profile: current }));
      } catch (err) {
        logger.error('Author profile update failed', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'update_failed' }));
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Search Feedback REST endpoint — for WordPress plugin
  // POST /hal/feedback — log feedback from search results
  // GET /hal/search-feedback — retrieve feedback entries (for wp plugin polling)
  // Auth: requires HAL_KEY shared secret
  // ---------------------------------------------------------------------------
  if (url.pathname === '/hal/feedback' && req.method === 'POST') {
    // Authenticate via shared secret
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken || authToken !== process.env.HAL_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const FEEDBACK_ALLOWED_ORIGINS = new Set([
      'https://claude.ai',
      'https://app.claude.ai',
      process.env.ALLOWED_ORIGIN,
    ].filter(Boolean));
    const feedbackOrigin = req.headers.origin;
    if (feedbackOrigin && FEEDBACK_ALLOWED_ORIGINS.has(feedbackOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', feedbackOrigin);
      res.setHeader('Vary', 'Origin');
    } else if (!feedbackOrigin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
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

      const { query, rating, comment, answer_excerpt, results_shown, user_agent } = data;
      // Derive IP from the connection — never trust a caller-supplied value.
      const ip_address = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;

      if (!query || !rating) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'query and rating are required' }));
        return;
      }

      // Validate field lengths to prevent abuse
      if (query.length > 1000 || (comment && comment.length > 5000) || (answer_excerpt && answer_excerpt.length > 2000)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'field too long' }));
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
            ip_address,
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
    // Authenticate via shared secret
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken || authToken !== process.env.HAL_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const FEEDBACK_GET_ALLOWED_ORIGINS = new Set([
      'https://claude.ai',
      'https://app.claude.ai',
      process.env.ALLOWED_ORIGIN,
    ].filter(Boolean));
    const feedbackGetOrigin = req.headers.origin;
    if (feedbackGetOrigin && FEEDBACK_GET_ALLOWED_ORIGINS.has(feedbackGetOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', feedbackGetOrigin);
      res.setHeader('Vary', 'Origin');
    } else if (!feedbackGetOrigin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
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
  // GET /altwire/opportunities — normalized story opportunities feed for chat UI
  if (url.pathname === '/altwire/opportunities' && req.method === 'GET') {
    setChatCors(req, res);
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!isAllowedAltusRestToken(authToken, { allowHalKey: true, allowAltusAdminToken: true })) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const statusParam = url.searchParams.get('status') || 'active';
      const resolvedStatus = ['active', 'all', 'pending', 'in_progress', 'assigned', 'completed', 'dismissed'].includes(statusParam)
        ? statusParam
        : 'active';
      await refreshOpportunityQueue({ days: 28, includeNews: true });
      const queued = await listStoryOpportunityQueue({ status: resolvedStatus });
      if (queued?.error) throw new Error(queued.error);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(queued));
    } catch (err) {
      logger.error('AltWire opportunities endpoint failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'opportunities_failed', message: 'Opportunities temporarily unavailable' }));
    }
    return;
  }

  // POST /altwire/opportunities/:id/assign — promote a story opportunity into the writer pipeline
  const opportunityAssignMatch = url.pathname.match(/^\/altwire\/opportunities\/(\d+)\/assign$/);
  if (opportunityAssignMatch && req.method === 'POST') {
    setChatCors(req, res);
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!isAllowedAltusRestToken(authToken, { allowHalKey: true, allowAltusAdminToken: true })) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const id = parseInt(opportunityAssignMatch[1], 10);
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = body ? JSON.parse(body) : {};
      const result = await assignStoryOpportunity({
        id,
        article_type: params.article_type ?? 'article',
      });
      if (result?.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.error('AltWire opportunity assign endpoint failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'assign_failed', message: 'Opportunity could not be assigned' }));
    }
    return;
  }

  // GET /altwire/digest — full morning digest (auth via Authorization header)
  if (url.pathname === '/altwire/digest' && req.method === 'GET') {
    setChatCors(req, res);
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!isAllowedAltusRestToken(authToken, { allowHalKey: true })) {
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

  // GET /altwire/digest/send — trigger morning digest email (auth via Authorization header)
  if (url.pathname === '/altwire/digest/send' && req.method === 'GET') {
    setChatCors(req, res);
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!isAllowedAltusRestToken(authToken, { allowHalKey: true })) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const { sendMorningDigestEmail } = await import('./handlers/altus-digest-mailer.js');
      await sendMorningDigestEmail();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Morning digest email sent' }));
    } catch (err) {
      logger.error('AltWire digest send endpoint failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'send_failed', message: err.message }));
    }
    return;
  }

  // GET /altwire/digest/preview — render live digest as HTML in browser (no email sent)
  if (url.pathname === '/altwire/digest/preview' && req.method === 'GET') {
    setChatCors(req, res);
    const authToken = req.headers.authorization?.replace('Bearer ', '') || url.searchParams.get('token');
    if (!isAllowedAltusRestToken(authToken, { allowHalKey: true })) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    try {
      const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');
      const { buildDigestHtml } = await import('./handlers/altus-digest-mailer.js');
      const digest = await getAltwireMorningDigest();
      const html = buildDigestHtml(digest);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      logger.error('AltWire digest preview endpoint failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${err.message}`);
    }
    return;
  }

  // GET /altwire/digest/archive — list or retrieve archived sent digests
  // Without ?date: returns JSON list of available dates (last 30 days)
  // With ?date=YYYY-MM-DD: returns the archived HTML for that date
  if (url.pathname === '/altwire/digest/archive' && req.method === 'GET') {
    setChatCors(req, res);
    const authToken = req.headers.authorization?.replace('Bearer ', '') || url.searchParams.get('token');
    if (!isAllowedAltusRestToken(authToken, { allowHalKey: true })) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const dateParam = url.searchParams.get('date');
    try {
      if (dateParam) {
        const row = await pool.query(
          `SELECT value FROM agent_memory WHERE agent = 'altus' AND key = $1 AND deleted_at IS NULL LIMIT 1`,
          [`altus:digest_archive:${dateParam}`],
        );
        if (!row.rows.length) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`No archived digest found for ${dateParam}`);
          return;
        }
        const archived = JSON.parse(row.rows[0].value);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(archived.html);
      } else {
        const rows = await pool.query(
          `SELECT key, updated_at FROM agent_memory
           WHERE agent = 'altus' AND key LIKE 'altus:digest_archive:%' AND deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT 30`,
        );
        const dates = rows.rows.map(r => ({
          date: r.key.replace('altus:digest_archive:', ''),
          sent_at: r.updated_at,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ archives: dates, count: dates.length }));
      }
    } catch (err) {
      logger.error('AltWire digest archive endpoint failed', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'archive_failed', message: err.message }));
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
  // Hal Chat — POST /hal/chat
  // Streaming agentic chat endpoint for the Hal Chat UI (altwire mode).
  // Receives { message, history, session_id }, runs an Anthropic agentic loop
  // with all registered altus tools via in-process MCP, and streams SSE events.
  // Auth: same Bearer token accepted by the MCP endpoint.
  // ---------------------------------------------------------------------------
  if (url.pathname === '/hal/chat' && req.method === 'POST') {
    setChatCors(req, res);

    const clientId = await identifyClient(req);
    if (!clientId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Resolve full identity for system prompt and onboarding
    const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer /, '').trim();
    const identity = authenticateHalWebToken(bearerToken) ?? { name: clientId, interface: 'web' };

    const allowedTools = OAUTH_CLIENT_TOOLS.get(clientId) ?? null;

    let parsedBody = {};
    await new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try { parsedBody = JSON.parse(raw); } catch { /* use empty */ }
        resolve();
      });
    });

    const { message, history = [], session_id } = parsedBody;
    if (!message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'message required' }));
      return;
    }

    // Register session so /events/:sessionId can authenticate the subscriber
    if (session_id) registerSession(session_id, clientId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

    try {
      const systemPrompt = await assembleSystemPrompt(
        'interactive',
        identity,
        { agentContext: 'altwire' },
        null,
      );

      // Spin up an in-process MCP client connected to the tool server
      const mcpServer = await createMcpServer({ agentContext: 'altwire', allowedTools, clientId });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      const mcpClient = new Client({ name: 'hal-chat', version: '1.0' }, { capabilities: {} });
      await mcpClient.connect(clientTransport);

      const { tools: mcpTools } = await mcpClient.listTools();
      const anthropicTools = mcpTools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.inputSchema ?? { type: 'object', properties: {} },
      }));

      // Build conversation history
      let messages = [
        ...history.map((h) => ({ role: h.role, content: String(h.content) })),
        { role: 'user', content: message },
      ];

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.ALTUS_CHAT_MODEL ?? 'claude-sonnet-4-5';

      // Agentic loop — max 15 iterations to prevent runaway tool chains
      for (let iteration = 0; iteration < 15; iteration++) {
        const responseStream = await createAnthropicMessageStream(anthropic, {
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages,
          tools: anthropicTools,
        });

        const currentContent = [];
        let stopReason = null;

        for await (const event of responseStream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'text') {
              currentContent[event.index] = { type: 'text', text: '' };
            } else if (event.content_block.type === 'tool_use') {
              currentContent[event.index] = {
                type: 'tool_use',
                id: event.content_block.id,
                name: event.content_block.name,
                input: {},
                _inputJson: '',
              };
              send({ event: 'tool_start', tool: event.content_block.name, label: `Using ${event.content_block.name}…`, iteration: iteration + 1 });
            }
          }
          if (event.type === 'content_block_delta') {
            const block = currentContent[event.index];
            if (event.delta.type === 'text_delta' && block?.type === 'text') {
              block.text += event.delta.text;
              send({ token: event.delta.text });
            } else if (event.delta.type === 'input_json_delta' && block?.type === 'tool_use') {
              block._inputJson += event.delta.partial_json;
            }
          }
          if (event.type === 'content_block_stop') {
            const block = currentContent[event.index];
            if (block?.type === 'tool_use') {
              try { block.input = JSON.parse(block._inputJson || '{}'); } catch { block.input = {}; }
            }
          }
          if (event.type === 'message_delta') stopReason = event.delta.stop_reason;
        }

        // Push assistant turn into history
        messages.push({ role: 'assistant', content: currentContent.filter(Boolean).map(({ _inputJson: _, ...b }) => b) });

        if (stopReason !== 'tool_use') break;

        // Execute tool calls and push results
        const toolResults = [];
        for (const block of currentContent.filter(Boolean)) {
          if (block.type !== 'tool_use') continue;
          let toolContent = [{ type: 'text', text: 'Error: tool call failed' }];
          let success = false;
          try {
            const result = await mcpClient.callTool({ name: block.name, arguments: block.input });
            toolContent = result.content ?? [{ type: 'text', text: '' }];
            success = true;
          } catch (err) {
            toolContent = [{ type: 'text', text: `Tool error: ${err.message}` }];
          }
          const summary = toolContent.filter((c) => c.type === 'text').map((c) => c.text).join('').slice(0, 200);
          send({ event: 'tool_done', tool: block.name, label: block.name, success, summary });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolContent });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      send({ done: true, session_id: 0 });
    } catch (err) {
      logger.error('hal/chat error', { error: err.message, stack: err.stack });
      send({ token: '\n\nSorry, something went wrong. Please try again.' });
      send({ done: true, session_id: 0 });
    }

    res.end();
    return;
  }

  // ---------------------------------------------------------------------------
  // SSE Event Stream — GET /events/:sessionId
  // Streams tool_start/tool_done/thinking_done events to the Chat UI.
  // Client subscribes via EventSource, receives events from the in-memory bus.
  // Auth: requires a valid Bearer token whose clientId matches the session's owner.
  // ---------------------------------------------------------------------------
  const eventsMatch = url.pathname.match(/^\/events\/(.+)$/);
  if (eventsMatch && req.method === 'GET') {
    const sessionId = eventsMatch[1];
    setChatCors(req, res);

    // Authenticate the SSE subscriber.
    // EventSource can't set Authorization headers, so accept ?token= as fallback.
    const authHeader = req.headers['authorization'] || '';
    const queryToken = url.searchParams.get('token');
    if (!authHeader.startsWith('Bearer ') && !queryToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    // Build a req-like object with the token injected so identifyClient works regardless of source
    const eventsReq = authHeader.startsWith('Bearer ')
      ? req
      : { ...req, headers: { ...req.headers, authorization: `Bearer ${queryToken}` } };
    const clientId = await identifyClient(eventsReq);
    if (!clientId || !isSessionRegistered(sessionId, clientId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_not_found_or_not_owned' }));
      return;
    }

    await trackChatPresence(req, clientId);

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

    // Reject agentContext claims that this clientId is not authorized to make
    if (!isContextAllowed(clientId, agentContext)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent_context_not_allowed' }));
      return;
    }

    await trackChatPresence(req, clientId);

    // Read the body once so we can extract session_id AND forward it to the transport.
    // If we attach data/end listeners without saving the result, the body is consumed
    // and transport.handleRequest would receive an empty stream.
    const { sessionId, parsedBody } = await new Promise((resolve) => {
      if (req.body && typeof req.body === 'object') {
        resolve({ sessionId: req.body.session_id || null, parsedBody: req.body });
        return;
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve({ sessionId: data?.session_id || null, parsedBody: data });
        } catch {
          resolve({ sessionId: null, parsedBody: null });
        }
      });
    });

    const server = await createMcpServer({ agentContext, allowedTools, clientId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    const clientCtx = { clientId, allowedTools };
    const sessionMeta = { client_id: clientId, ...(agentContext && { agent_context: agentContext }) };
    if (sessionId) {
      // Register session so SSE stream can authenticate the owner
      registerSession(sessionId, clientId);
      await oauthClientStorage.run(clientCtx, async () =>
        sessionIdStorage.run(sessionId, async () =>
          observe({ name: 'altus_session', spanType: 'DEFAULT', metadata: sessionMeta }, async () => {
            await transport.handleRequest(req, res, parsedBody);
          })
        )
      );
    } else {
      await oauthClientStorage.run(clientCtx, async () =>
        observe({ name: 'altus_session', spanType: 'DEFAULT', metadata: sessionMeta }, async () => {
          await transport.handleRequest(req, res, parsedBody);
        })
      );
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
