/**
 * Voyage AI embedding wrappers.
 *
 * embedDocuments(texts, opts) — batch-embed content for storage (input_type: 'document')
 * embedQuery(text)            — embed a single search query (input_type: 'query')
 *
 * Both return a float[] on success or { error: string } on failure.
 * Never throw — callers check for .error property.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite';
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 21000; // 21s between batches — stays under Voyage free tier (3 RPM)

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call the Voyage API with retry on 429.
 */
async function callVoyage(input, inputType, opts = {}) {
  const { maxRetries = 3, retryDelayMs = 2000 } = opts;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }

  let delay = retryDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, input, input_type: inputType }),
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
}

/**
 * Embed an array of document strings for storage.
 * Batches in groups of BATCH_SIZE with a delay between batches.
 * Returns float[][] or { error: string }.
 *
 * @param {string[]} texts
 * @param {object} [opts] - { maxRetries, retryDelayMs } (for testing)
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
    if (i + BATCH_SIZE < texts.length) {
      // opts.retryDelayMs used in tests to bypass inter-batch delay
      await sleep(opts.retryDelayMs !== undefined ? 0 : BATCH_DELAY_MS);
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
