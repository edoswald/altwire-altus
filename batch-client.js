/**
 * batch-client.js
 *
 * Thin, stateless wrapper around the Anthropic Batch API.
 * No database access — callers pass data in and receive results back.
 * Adapted for Altus from cirrusly-nimbus/batch-client.js.
 *
 * Exports: submitBatch, collectBatch, logBatchUsage
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import { logAiUsage } from './lib/ai-cost-tracker.js';

/**
 * Submit a batch of review requests to the Anthropic Batch API.
 *
 * @param {Array<{ custom_id: string, params: object }>} requests
 * @returns {Promise<string>} batch_id
 * @throws {Error} on API failure — callers should catch and retry
 */
export async function submitBatch(requests) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.batches.create({ requests });
  return response.id;
}

/**
 * Poll a batch for completion and collect results.
 *
 * @param {string} batchId
 * @returns {Promise<Array<{ custom_id: string, result: object }>|null>}
 *   Results array if ended, null if still in_progress
 * @throws {Error} on API failure — callers should catch and skip the batch for this cycle
 */
export async function collectBatch(batchId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const batch = await client.beta.messages.batches.retrieve(batchId);
  if (batch.processing_status === 'in_progress') {
    return null;
  }

  const stream = await client.beta.messages.batches.results(batchId);
  const results = [];
  for await (const item of stream) {
    results.push({ custom_id: item.custom_id, result: item.result });
  }

  return results;
}

/**
 * Log aggregated batch usage to ai_usage.
 * Sums input_tokens and output_tokens across all succeeded results.
 *
 * @param {string} batchId
 * @param {Array<{ custom_id: string, result: object }>} results
 * @param {string} toolName
 */
export async function logBatchUsage(batchId, results, toolName) {
  if (!results || results.length === 0) return;

  let inputTokens = 0;
  let outputTokens = 0;
  let model = null;

  for (const item of results) {
    if (item.result?.type !== 'succeeded') continue;
    const msg = item.result.message;
    if (!model && msg?.model) model = msg.model;
    inputTokens += msg?.usage?.input_tokens ?? 0;
    outputTokens += msg?.usage?.output_tokens ?? 0;
  }

  if (!model) return;

  try {
    await logAiUsage(toolName, model, { input_tokens: inputTokens, output_tokens: outputTokens });
  } catch (err) {
    logger.error('logBatchUsage: failed to log AI usage', { batchId, error: err.message });
  }
}