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

// ---------------------------------------------------------------------------
// Laminar initialization — must run before any other imports
// ---------------------------------------------------------------------------
if (process.env.LMNR_PROJECT_API_KEY) {
  try {
    const { Laminar } = await import('@lmnr-ai/lmnr');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    Laminar.initialize({
      projectApiKey: process.env.LMNR_PROJECT_API_KEY,
      metadata: { service: 'altus' },
      instrumentModules: { anthropic: Anthropic },
    });
    Laminar.patch({ anthropic: Anthropic });
    logger.info('Laminar initialized — shared project, service: altus');
  } catch (err) {
    logger.warn('Laminar initialization failed', { error: err.message });
  }
}

import { sessionIdStorage } from './lib/safe-tool-handler.js';
import { observe } from './tracing.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { z } from 'zod';
import { logger } from './logger.js';
import pool, { initSchema, initMountaineeringSchema } from './lib/altus-db.js';
TRUNCATED_FOR_BREVITY