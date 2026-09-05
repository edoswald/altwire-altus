/**
 * Voyage AI embedding wrappers.
 *
 * embedDocuments(texts, opts) — batch-embed content for storage (input_type: 'document')
 * embedQuery(text)            — embed a single search query (input_type: 'query')
 * embedQueries(texts)         — batch-embed search queries (input_type: 'query')
 *
 * All return float[] (or float[][]) on success or { error: string } on failure.
 * Never throw — callers check for .error property.
 *
 * Model: defaults to voyage-4 (current generation). Can be overridden with the
 * VOYAGE_MODEL env var. For Matryoshka models we request explicit
 * output_dimension (default 512 from VOYAGE_EMBEDDING_DIMENSION) so vectors
 * keep fitting the existing vector(512) column — no schema migration needed.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = process.env.VOYAGE_MODEL || 'voyage-4';
const OUTPUT_DIMENSION = Number(process.env.VOYAGE_EMBEDDING_DIMENSION || '512');
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000; // 1s between batches

// Models with Matryoshka flexible output dimensions accept `output_dimension`
// (voyage-3.5 and newer). Fixed-dim legacy models (voyage-3, voyage-3-lite)
// must omit the parameter; the env-pin path still supports them unchanged.
const MATRYOSHKA_MODELS = new Set([
  'voyage-4', 'voyage-4-lite', 'voyage-4-large', 'voyage-code-4',
  'voyage-3.5', 'voyage-3.5-lite', 'voyage-3-large', 'voyage-code-3',
]);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call the Voyage API with retry on 429.
 */
async function callVoyage(input, inputType, opts = {}) {
  const { maxRetries = 5, retryDelayMs = 15000 } = opts;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }

  const body = { model: MODEL, input, input_type: inputType };
  if (OUTPUT_DIMENSION > 0 && MATRYOSHKA_MODELS.has(MODEL)) {
    body.output_dimension = OUTPUT_DIMENSION;
  }

  let delay = retryDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      return data.data.map((d) => d.embedding);
    }

    if (res.status === 429 && attempt < maxRetries) {
      await sleep(delay);
      delay *= 2; // exponential backoff
      continue;
    }

    if (res.status === 429) {
      return { error: `Voyage API error — rate limit exceeded after ${maxRetries} retries` };
    }
    return { error: `Voyage API error — HTTP ${res.status}` };
  }
  // If we exit the loop without returning, all retries were exhausted
  return { error: `Voyage API error — rate limit exceeded after ${maxRetries} retries` };
}

/**
 * Embed an array of document strings for storage.
 * Batches in groups of BATCH_SIZE with a delay between batches.
 * Returns float[][] or { error: string }.
 *
 * @param {string[]} texts
 * @param {object} [opts] - { maxRetries, retryDelayMs, batchDelayMs } (for testing)
 * @returns {Promise<number[][] | { error: string }>}
 */
export async function embedDocuments(texts, opts = {}) {
  if (!process.env.VOYAGE_API_KEY) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }

  const results = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchResult = await callVoyage(batch, 'document', opts);
    if (batchResult?.error) return batchResult;
    results.push(...batchResult);
    // Inter-batch delay between pages to avoid rate limiting; skip during tests
    if (i + BATCH_SIZE < texts.length && opts.batchDelayMs !== 0) {
      await sleep(opts.batchDelayMs ?? BATCH_DELAY_MS);
    }
  }
  return results;
}

/**
 * Embed a single query string for search.
 * Returns float[] or { error: string }.
 *
 * @param {string} text
 * @returns {Promise<number[] | { error: string }>}
 */
export async function embedQuery(text) {
  if (!process.env.VOYAGE_API_KEY) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }
  const result = await callVoyage([text], 'query');
  if (result?.error) return result;
  return result[0];
}

/**
 * Embed multiple query strings in a single API call (query input_type).
 * Returns float[][] or { error: string }.
 *
 * @param {string[]} texts
 * @param {object} [opts] - { maxRetries, retryDelayMs, batchDelayMs } (for testing)
 * @returns {Promise<number[][] | { error: string }>}
 */
export async function embedQueries(texts, opts = {}) {
  if (!process.env.VOYAGE_API_KEY) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }
  return callVoyage(texts, 'query', opts);
}
