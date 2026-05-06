/**
 * writer-client.js
 *
 * Unified AI generation abstraction for the AI Writer pipeline.
 * Routes all generation calls to either Anthropic or OpenAI based on
 * the ALTUS_WRITER_MODEL environment variable.
 *
 * Default model: claude-sonnet-4-5 (Anthropic)
 * Provider detection: gpt-*, o1*, o3* → OpenAI; all else → Anthropic
 *
 * The handler never calls SDKs directly — always through generate().
 */

import Anthropic from '@anthropic-ai/sdk';
import { logAiUsage } from './ai-cost-tracker.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const model = process.env.ALTUS_WRITER_MODEL || 'claude-sonnet-4-6';

/**
 * Detect provider from model string prefix.
 * @param {string} m - model name
 * @returns {'anthropic'|'openai'}
 */
export function detectProvider(m) {
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3')) {
    return 'openai';
  }
  return 'anthropic';
}

const provider = detectProvider(model);

// Anthropic client — instantiated at module level (always available)
const anthropic = provider === 'anthropic' ? new Anthropic() : null;

// ---------------------------------------------------------------------------
// generate() — main export
// ---------------------------------------------------------------------------

/**
 * Generate text via the configured AI provider.
 *
 * @param {Object} params
 * @param {string} params.toolName    - MCP tool name (for cost logging)
 * @param {string} params.system      - System prompt
 * @param {string} params.prompt      - User message
 * @param {number} [params.maxTokens=4000] - Max output tokens
 * @param {boolean} [params.webSearch=false] - Enable web search tool
 * @param {boolean} [params.jsonMode=false]  - Request JSON output
 * @returns {Promise<string>} Plain text response from the model
 */
export async function generate({
  toolName,
  system,
  prompt,
  maxTokens = 4000,
  webSearch = false,
  jsonMode = false,
}) {
  if (provider === 'anthropic') {
    return generateAnthropic({ toolName, system, prompt, maxTokens, webSearch, jsonMode });
  }
  return generateOpenAI({ toolName, system, prompt, maxTokens, webSearch, jsonMode });
}


// ---------------------------------------------------------------------------
// Anthropic path
// ---------------------------------------------------------------------------

async function generateAnthropic({ toolName, system, prompt, maxTokens, webSearch, jsonMode }) {
  const effectiveSystem = jsonMode
    ? `${system}\n\nRespond with valid JSON only. No markdown fences.`
    : system;

  const requestParams = {
    model,
    max_tokens: maxTokens,
    system: effectiveSystem,
    messages: [{ role: 'user', content: prompt }],
  };

  if (webSearch) {
    requestParams.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const response = await anthropic.messages.create(requestParams);

    // Extract text from content blocks
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Cost logging — non-throwing
    try {
      await logAiUsage(toolName, response.model, {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      });
    } catch (costErr) {
      logger.error('writer-client: logAiUsage failed', { error: costErr.message });
    }

    return text;
  } catch (err) {
    throw new Error(`writer-client [anthropic]: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// OpenAI path (lazy import)
// ---------------------------------------------------------------------------

async function generateOpenAI({ toolName, system, prompt, maxTokens, webSearch, jsonMode }) {
  let OpenAI;
  try {
    const mod = await import('openai');
    OpenAI = mod.default;
  } catch (importErr) {
    throw new Error(`writer-client [openai]: openai package not installed — ${importErr.message}`);
  }

  const openai = new OpenAI();

  // o1/o3 models use max_completion_tokens; gpt-* use max_tokens
  const tokenKey = model.startsWith('o1') || model.startsWith('o3') ? 'max_completion_tokens' : 'max_tokens';
  const requestParams = {
    model,
    [tokenKey]: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };

  if (webSearch) {
    requestParams.tools = [{ type: 'web_search_preview' }];
  }

  if (jsonMode) {
    requestParams.response_format = { type: 'json_object' };
  }

  try {
    const response = await openai.chat.completions.create(requestParams);
    const text = response.choices[0].message.content;

    // Normalize OpenAI token fields and log cost — non-throwing
    try {
      await logAiUsage(toolName, response.model, {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      });
    } catch (costErr) {
      logger.error('writer-client: logAiUsage failed', { error: costErr.message });
    }

    return text;
  } catch (err) {
    throw new Error(`writer-client [openai]: ${err.message}`);
  }
}
