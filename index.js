/**
 * Altus MCP Server — AltWire AI Operations
 *
 * 45 tools: RAG archive, analytics, editorial intelligence, review tracker,
 * watch list, and AI Writer pipeline.
 * Transport: StreamableHTTP (stateless — sessionIdGenerator: undefined)
 * Health: GET /health
 */

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
import { getStoryOpportunities } from './handlers/altus-topic-discovery.js';
import { getNewsOpportunities, runNewsMonitorCron } from './handlers/altus-news-monitor.js';
import { getArticlePerformance, getNewsPerformancePatterns, runPerformanceSnapshotCron } from './handlers/altus-performance-tracker.js';
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

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Schema init — runs once at startup
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  initSchema().catch((err) => {
    logger.error('Schema init failed', { error: err.message });
  });
  initAiUsageSchema().catch((err) => {
    logger.error('AI usage schema init failed', { error: err.message });
  });
  initReviewTrackerSchema().catch((err) => {
    logger.error('Review tracker schema init failed', { error: err.message });
  });
  initWatchListSchema().catch((err) => {
    logger.error('Watch list schema init failed', { error: err.message });
  });
  initWriterSchema().catch((err) => {
    logger.error('Writer schema init failed', { error: err.message });
  });
  startIngestCron();

  // News Monitor — 9 AM ET daily
  cron.schedule('0 9 * * *', () => runNewsMonitorCron(), { timezone: 'America/New_York' });

  // Performance Snapshot — 6 AM ET daily
  cron.schedule('0 6 * * *', () => runPerformanceSnapshotCron(), { timezone: 'America/New_York' });
} else {
  logger.warn('DATABASE_URL not set — skipping schema init and cron');
}

// ---------------------------------------------------------------------------
// MCP Server factory — new instance per stateless request
// ---------------------------------------------------------------------------
async function createMcpServer() {
  const server = new McpServer({
    name: 'altwire-altus',
    version: '1.0.0',
  });

  // -------------------------------------------------------------------------
  // Tool: search_altwire_archive
  // -------------------------------------------------------------------------
  server.registerTool(
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
  // Tool: reingest_altwire_archive
  // -------------------------------------------------------------------------
  server.registerTool(
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
  server.registerTool(
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
  server.registerTool(
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
  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  const { getAltwireUptime, getAltwireIncidents } = await import('./handlers/altus-monitoring.js');
  const { getAltwireMorningDigest } = await import('./handlers/altus-digest.js');

  server.registerTool(
    'get_altwire_uptime',
    {
      description: 'Live status of AltWire\'s uptime monitors — altwire.net and WP Cron. Returns overall health and per-monitor status.',
    },
    safeToolHandler(async () => {
      const result = await getAltwireUptime();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  server.registerTool(
    'get_altwire_incidents',
    {
      description: 'Open (unresolved) incidents on AltWire\'s Better Stack monitors. Returns empty list when all is well.',
    },
    safeToolHandler(async () => {
      const result = await getAltwireIncidents();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  server.registerTool(
    'get_altwire_morning_digest',
    {
      description: 'Full AltWire morning briefing — site uptime, open incidents, today\'s news alerts, story opportunities, upcoming review deadlines, overdue loaners, and yesterday\'s traffic. Use at the start of a session or when Derek asks for a status overview.',
    },
    safeToolHandler(async () => {
      const result = await getAltwireMorningDigest();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check — no auth required
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'altus' }));
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

  // MCP endpoint — stateless POST
  if (url.pathname === '/' || url.pathname === '/mcp') {
    const server = await createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — prevents Claude.ai session caching issues
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
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
