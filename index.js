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
import { startIngestCron } from './lib/ingest-cron.js';

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Schema init — runs once at startup
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  initSchema().catch((err) => {
    logger.error('Schema init failed', { error: err.message });
  });
  startIngestCron();
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
  server.tool(
    'search_altwire_archive',
    'Searches the AltWire content archive using semantic similarity. Returns relevant articles, reviews, and galleries based on the query. Use this to understand how AltWire has previously covered an artist or topic.',
    {
      query: z.string().describe('The search query — artist name, topic, or concept'),
      limit: z.number().int().min(1).max(20).default(5).describe('Number of results to return'),
      content_type: z
        .enum(['post', 'gallery', 'all'])
        .default('all')
        .describe('Filter by content type'),
    },
    safeToolHandler(async ({ query, limit, content_type }) => {
      const result = await searchAltwareArchive({ query, limit, content_type });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
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
