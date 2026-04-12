/**
 * Altus MCP Server — AltWire RAG Foundation
 *
 * Exposes one tool: search_altwire_archive
 * Transport: StreamableHTTP (stateless — sessionIdGenerator: undefined)
 * Health: GET /health
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { z } from 'zod';
import { logger } from './logger.js';
import { initSchema } from './lib/altus-db.js';
import { safeToolHandler } from './lib/safe-tool-handler.js';
import { searchAltwareArchive } from './handlers/altus-search.js';
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
function createMcpServer() {
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
      const result = await searchAltwareArchive({ query, limit, content_type });
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
      const result = await getNewsOpportunities();
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
      const result = await getNewsPerformancePatterns();
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

  // MCP endpoint — stateless POST
  if (url.pathname === '/' || url.pathname === '/mcp') {
    const server = createMcpServer();
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
