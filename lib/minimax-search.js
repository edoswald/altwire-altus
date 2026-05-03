/**
 * MiniMax LLM synthesis helpers for AltWire search.
 *
 * synthesizeSearchAnswer(query, context) — generates an AI answer from search context
 * Uses MiniMax-2.7 (fastest, most cost-effective for high-volume synthesis).
 *
 * Never throws — callers check for .error property on the return value.
 */

import { logger } from '../logger.js';

const SYNTHESIS_MODEL = 'MiniMax-2.7';
const SYNTHESIS_URL = 'https://api.minimax.chat/v1/text/chatcompletion_v2';

const SYSTEM_PROMPT = `You are a search assistant for AltWire, a music and lifestyle publication.
Given the user's search query and the most relevant article excerpts, provide a concise, accurate answer.
Cite your sources by article title. If the answer requires information not in the excerpts, say so.
Format: clear paragraph answer followed by "Sources:" list.`;

/**
 * Call the MiniMax API with retry on 429.
 */
async function callMiniMax(messages, maxTokens = 400,opts = {}) {
  const { maxRetries = 3, retryDelayMs = 5000 } = opts;
  const key = process.env.MINIMAX_API_KEY;
  if (!key) {
    return { error: 'Synthesis service unavailable — MINIMAX_API_KEY not set' };
  }

  let delay = retryDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(SYNTHESIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SYNTHESIS_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data;
    }

    if (res.status === 429 && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }

    return { error: `MiniMax API error — HTTP ${res.status}` };
  }
}

/**
 * Generate an AI search answer from a query and relevant article excerpts.
 *
 * @param {string} query - The user's search query
 * @param {Array<{title: string, url: string, snippet: string}>} context - Relevant articles
 * @returns {Promise<{answer: string, citations: Array, model: string}|{error: string}>}
 */
export async function synthesizeSearchAnswer(query, context) {
  if (!process.env.MINIMAX_API_KEY) {
    return {
      answer: buildFallbackAnswer(query, context),
      citations: context.slice(0, 3),
      model: 'none',
    };
  }

  try {
    const contextLines = context
      .map((c, i) => `[${i + 1}] ${c.title}\nURL: ${c.url}\n${(c.snippet || '').slice(0, 400)}`)
      .join('\n\n');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Search query: "${query}"\n\nRelevant articles:\n${contextLines}\n\nProvide a concise answer to the query citing sources by title, then list the sources.`,
      },
    ];

    const result = await callMiniMax(messages, 400);

    if (result?.error) {
      logger.warn('Search synthesis failed — using fallback', { error: result.error });
      return {
        answer: buildFallbackAnswer(query, context),
        citations: context.slice(0, 3),
        model: 'none',
      };
    }

    const reply = result.choices?.[0]?.message?.content || '';
    if (!reply.trim()) {
      return {
        answer: buildFallbackAnswer(query, context),
        citations: context.slice(0, 3),
        model: result.model || SYNTHESIS_MODEL,
      };
    }

    const citations = extractCitations(reply, context);
    return {
      answer: reply,
      citations,
      model: result.model || SYNTHESIS_MODEL,
    };
  } catch (err) {
    logger.warn('Search synthesis threw — using fallback', { error: err.message });
    return {
      answer: buildFallbackAnswer(query, context),
      citations: context.slice(0, 3),
      model: 'none',
    };
  }
}

/**
 * Parse citations from LLM reply.
 * Looks for numbered references like [1], [2] and matches to context.
 */
function extractCitations(reply, context) {
  const cited = new Set();
  const numPattern = /\[(\d+)\]/g;
  let match;
  while ((match = numPattern.exec(reply)) !== null) {
    cited.add(parseInt(match[1], 10) - 1);
  }
  return context
    .filter((_, i) => cited.has(i))
    .slice(0, 5)
    .map((c) => ({ title: c.title, url: c.url, snippet: c.snippet }));
}

function buildFallbackAnswer(query, context) {
  if (context.length === 0) {
    return `No relevant articles found for "${query}". Try different keywords or browse our categories.`;
  }
  const top = context[0];
  const snippet = (top.snippet || '').slice(0, 300);
  return `${snippet ? snippet + '...' : `Found ${context.length} articles about "${query}".`} (Source: ${top.title})`;
}