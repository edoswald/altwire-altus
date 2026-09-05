/**
 * batch-client.js
 *
 * Thin, stateless wrapper around the Anthropic Batch API.
 * No database access — callers pass data in and receive results back.
 * Adapted for Altus from cirrusly-nimbus/batch-client.js.
 *
 * Exports: submitBatch, collectBatch, waitForBatch, logBatchUsage, isRefusal, extractText
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger.js';
import { logAiUsage } from './lib/ai-cost-tracker.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isRefusal(item) {
  return item?.result?.type === 'succeeded'
    && item.result.message?.stop_reason === 'refusal';
}

export function extractText(item) {
  if (item?.result?.type !== 'succeeded') return null;
  const block = item.result.message?.content?.find((contentBlock) => contentBlock?.type === 'text');
  return block?.text?.trim() || null;
}

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
 * Poll a batch until it finishes (used by flows that need the results inline,
 * e.g. ingestion pipelines). Batch jobs typically complete within ~1 hour.
 *
 * @param {string} batchId
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=30000] - poll interval
 * @param {number} [opts.timeoutMs=6h]     - overall deadline
 * @returns {Promise<Array<{ custom_id: string, result: object }>>}
 * @throws {Error} on API failure or if the batch does not finish in time
 */
export async function waitForBatch(batchId, { intervalMs = 30000, timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const results = await collectBatch(batchId);
    if (results !== null) return results;
    await sleep(intervalMs);
  }
  throw new Error(`Batch ${batchId} did not finish within ${Math.floor(timeoutMs / 1000)}s`);
}

/**
 * Log aggregated batch usage to ai_usage.
 * Sums input_tokens, output_tokens, and cache read/creation tokens across all
 * succeeded results (batch params ship cached system prompts, so results carry
 * cache usage that must not be dropped from the cost estimate).
 *
 * @param {string} batchId
 * @param {Array<{ custom_id: string, result: object }>} results
 * @param {string} toolName
 */
export async function logBatchUsage(batchId, results, toolName) {
  if (!results || results.length === 0) return;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let model = null;

  for (const item of results) {
    if (item.result?.type !== 'succeeded') continue;
    const msg = item.result.message;
    if (!model && msg?.model) model = msg.model;
    inputTokens += msg?.usage?.input_tokens ?? 0;
    outputTokens += msg?.usage?.output_tokens ?? 0;
    cacheReadTokens += msg?.usage?.cache_read_input_tokens ?? 0;
    cacheCreationTokens += msg?.usage?.cache_creation_input_tokens ?? 0;
  }

  if (!model) return;

  try {
    await logAiUsage(
      toolName,
      model,
      {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheCreationTokens,
      },
      { isBatch: true },
    );
  } catch (err) {
    logger.error('logBatchUsage: failed to log AI usage', { batchId, error: err.message });
  }
}
