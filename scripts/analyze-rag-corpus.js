/**
 * scripts/analyze-rag-corpus.js
 *
 * Analyzes the AltWire RAG corpus using a two-model approach:
 * - Minimax: development/iterative passes (cheap, fast)
 * - Opus 4: production output (final editorial quality)
 *
 * Produces a structured `hal:altwire:editorial_context` memory object.
 *
 * Usage:
 *   node scripts/analyze-rag-corpus.js          # Full run: minimax draft + opus review
 *   node scripts/analyze-rag-corpus.js --minimax  # Minimax draft only
 *   node scripts/analyze-rag-corpus.js --opus    # Opus review only (needs MINIMAX_DRAFT env var)
 */

import altusDb, { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';
const pool = altusDb; // default export is the pool

const EDITORIAL_CONTEXT_KEY = 'hal:altwire:editorial_context';
const DEREK_AUTHOR_KEY = 'hal:altwire:derek_author_profile';
const RAG_SAMPLE_SIZE = 250; // chunks to sample for analysis
const DEREK_SAMPLE_SIZE = 100; // Derek's own chunks for author profiling
const MINIMAX_MODEL = 'MiniMax-M2.7';
const OPUS_MODEL = 'claude-opus-4-7';
const DEREK_AUTHOR_ID = 2; // WordPress author ID for Derek

const SYSTEM_PROMPT = `You are an expert editorial analyst specializing in music publications. You analyze article corpora and produce structured assessments of editorial identity. Your output is precise, specific, and grounded in the texts you analyze — never vague or generic.`;

const MINIMAX_ANALYSIS_PROMPT = (chunks) => `Analyze the following ${chunks.length} article excerpts from AltWire (a music and lifestyle publication). Extract the editorial identity characteristics below. Be specific and ground your observations in the actual content.

For each dimension, provide:
- A concrete characterization (not generic like "varies" — give specifics)
- Estimated prevalence if relevant (e.g., "reviews ~60% of coverage", "interviews ~15%")

Analyze and return ONLY a valid JSON object with this exact structure (no markdown, no explanation outside the JSON):

{
  "tone": {
    "overall": "2-3 sentence characterization of the publication's voice",
    "formality": "formal | semi-formal | conversational | casual",
    "audience_assumed_knowledge": "beginner | intermediate | advanced | mixed",
    "emotional_range": "reserved | moderate | expressive"
  },
  "article_types": {
    "reviews": "X%",
    "interviews": "Y%",
    "features": "Z%",
    "listicles": "W%",
    "news": "V%",
    "galleries": "U%"
  },
  "subjects": {
    "top_genres": ["genre1", "genre2", ...],
    "common_angles": ["angle1", "angle2", ...],
    "coverage_depth": "deep | medium | breadth-first",
    "recurring_themes": ["theme1", "theme2", ...]
  },
  "headline_patterns": {
    "typical_length": "short | medium | long | mixed",
    "common_formulas": ["formula1", "formula2", ...],
    "questions_used": true | false,
    "numbers_used": true | false,
    "all_caps_rare": true | false
  },
  "voice_markers": ["marker1", "marker2", ...],
  "what_makes_good_altwire_article": "2-3 sentence description of implicit editorial standards"
}

---
ARTICLE EXCERPTS:
${chunks.join('\n\n---\n\n')}
---`;

const OPUS_REVIEW_PROMPT = (minimaxDraft) => `You are an expert editor reviewing a draft editorial analysis of the AltWire corpus. Your job is to take the draft analysis, evaluate it against the actual corpus characteristics, and produce a refined, definitive version.

Be critical: strengthen weak observations, correct mischaracterizations, fill gaps, and sharpen vague language. The final output should be something you would be proud to have as the definitive description of AltWire's editorial identity.

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "tone": {
    "overall": "2-3 sentence characterization of the publication's voice",
    "formality": "formal | semi-formal | conversational | casual",
    "audience_assumed_knowledge": "beginner | intermediate | advanced | mixed",
    "emotional_range": "reserved | moderate | expressive"
  },
  "article_types": {
    "reviews": "X%",
    "interviews": "Y%",
    "features": "Z%",
    "listicles": "W%",
    "news": "V%",
    "galleries": "U%"
  },
  "subjects": {
    "top_genres": ["genre1", "genre2", ...],
    "common_angles": ["angle1", "angle2", ...],
    "coverage_depth": "deep | medium | breadth-first",
    "recurring_themes": ["theme1", "theme2", ...]
  },
  "headline_patterns": {
    "typical_length": "short | medium | long | mixed",
    "common_formulas": ["formula1", "formula2", ...],
    "questions_used": true | false,
    "numbers_used": true | false,
    "all_caps_rare": true | false
  },
  "voice_markers": ["marker1", "marker2", ...],
  "what_makes_good_altwire_article": "2-3 sentence description of implicit editorial standards"
}

---
MINIMAX DRAFT ANALYSIS:
${minimaxDraft}
---`;

const DEREK_ANALYSIS_PROMPT = (chunks) => `Analyze the following ${chunks.length} article excerpts all written by Derek (author ID 2) for AltWire. Extract Derek's personal writing voice and style characteristics. This profile will be used to guide AI-generated drafts to match how Derek actually writes.

For each dimension, provide concrete, specific observations grounded in the actual text:

- Writing voice: tone, rhythm, sentence structure preferences, first-person usage
- Strengths: what makes Derek's writing distinctive and effective
- Habits: recurring patterns, signature moves, things he consistently does
- Editorial voice markers: phrases, angles, or approaches he favors
- What to preserve in AI drafts: elements that MUST carry over from this voice profile

Analyze and return ONLY a valid JSON object with this exact structure (no markdown, no explanation outside the JSON):

{
  "writing_voice": {
    "tone": "characterization of Derek's tone",
    "sentence_patterns": "short | varied | long | flowing | etc",
    "first_person_usage": "none | rare | moderate | frequent",
    "emotional_candor": "reserved | moderate | high — note specific examples",
    "humor_style": "dry | wry | deadpan | self-deprecating | none | etc"
  },
  "strengths": ["strength1", "strength2", ...],
  "signature_habits": ["habit1", "habit2", ...],
  "editorial_voice_markers": ["marker1", "marker2", ...],
  "topics_specialties": ["topic1", "topic2", ...],
  "prose_tendencies": {
    "paragraph_style": "short_paragraphs | long_flowing | mixed",
    "transition_style": "abrupt | smooth | thematic | etc",
    "detail_level": "sparse | moderate | rich | immersive",
    "quote_integration": "how Derek handles quotes from sources"
  },
  "what_to_preserve_in_ai_drafts": "2-3 sentence directive for AI writer: what MUST carry over from Derek's voice"
}

---
DEREK'S ARTICLES:
${chunks.join('\n\n---\n\n')}
---`;

const OPUS_DEREK_REVIEW_PROMPT = (minimaxDraft) => `You are an expert editor reviewing a draft analysis of Derek's personal writing voice and style. Derek is the primary writer and editor for AltWire. Your job is to produce a definitive, refined author voice profile that can guide AI-generated drafts to sound authentically like Derek.

Be critical: strengthen weak observations, correct mischaracterizations, fill gaps, sharpen vague language. The final output should be a precise voice profile that a writer AI can follow to produce text indistinguishable from Derek's own work.

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):

{
  "writing_voice": {
    "tone": "characterization of Derek's tone",
    "sentence_patterns": "short | varied | long | flowing | etc",
    "first_person_usage": "none | rare | moderate | frequent",
    "emotional_candor": "reserved | moderate | high — note specific examples",
    "humor_style": "dry | wry | deadpan | self-deprecating | none | etc"
  },
  "strengths": ["strength1", "strength2", ...],
  "signature_habits": ["habit1", "habit2", ...],
  "editorial_voice_markers": ["marker1", "marker2", ...],
  "topics_specialties": ["topic1", "topic2", ...],
  "prose_tendencies": {
    "paragraph_style": "short_paragraphs | long_flowing | mixed",
    "transition_style": "abrupt | smooth | thematic | etc",
    "detail_level": "sparse | moderate | rich | immersive",
    "quote_integration": "how Derek handles quotes from sources"
  },
  "what_to_preserve_in_ai_drafts": "2-3 sentence directive for AI writer: what MUST carry over from Derek's voice"
}

---
MINIMAX DRAFT:
${minimaxDraft}
---`;

async function fetchRagChunks() {
  const result = await pool.query(
    `SELECT title, raw_text, content_type, published_at
     FROM altus_content
     WHERE raw_text IS NOT NULL AND raw_text != ''
     ORDER BY RANDOM()
     LIMIT $1`,
    [RAG_SAMPLE_SIZE]
  );
  return result.rows;
}

async function fetchDerekChunks() {
  const result = await pool.query(
    `SELECT title, raw_text, content_type, published_at
     FROM altus_content
     WHERE author = $1 AND raw_text IS NOT NULL AND raw_text != ''
     ORDER BY published_at DESC
     LIMIT $2`,
    [DEREK_AUTHOR_ID, DEREK_SAMPLE_SIZE]
  );
  return result.rows;
}

function formatChunk(row) {
  const type = row.content_type || 'post';
  const title = row.title || '(no title)';
  const text = row.raw_text || '';
  // Truncate long texts to ~800 chars to keep token count reasonable
  const truncated = text.length > 800 ? text.slice(0, 800) + '...' : text;
  return `[${type}] ${title}\n\n${truncated}`;
}

// Schema names for Minimax response_format
const EDITORIAL_SCHEMA = 'editorial_analysis';
const DEREK_SCHEMA = 'derek_author_profile';

const MINIMAX_SCHEMAS = {
  [EDITORIAL_SCHEMA]: {
    name: EDITORIAL_SCHEMA,
    schema: {
      type: 'object',
      properties: {
        tone: {
          type: 'object',
          properties: {
            overall: { type: 'string' },
            formality: { type: 'string' },
            audience_assumed_knowledge: { type: 'string' },
            emotional_range: { type: 'string' },
          },
          required: ['overall', 'formality', 'audience_assumed_knowledge', 'emotional_range'],
        },
        article_types: {
          type: 'object',
          properties: {
            reviews: { type: 'string' },
            interviews: { type: 'string' },
            features: { type: 'string' },
            listicles: { type: 'string' },
            news: { type: 'string' },
            galleries: { type: 'string' },
          },
        },
        subjects: {
          type: 'object',
          properties: {
            top_genres: { type: 'array', items: { type: 'string' } },
            common_angles: { type: 'array', items: { type: 'string' } },
            coverage_depth: { type: 'string' },
            recurring_themes: { type: 'array', items: { type: 'string' } },
          },
        },
        headline_patterns: {
          type: 'object',
          properties: {
            typical_length: { type: 'string' },
            common_formulas: { type: 'array', items: { type: 'string' } },
            questions_used: { type: 'boolean' },
            numbers_used: { type: 'boolean' },
            all_caps_rare: { type: 'boolean' },
          },
        },
        voice_markers: { type: 'array', items: { type: 'string' } },
        what_makes_good_altwire_article: { type: 'string' },
      },
      required: ['tone', 'article_types', 'subjects', 'headline_patterns', 'voice_markers', 'what_makes_good_altwire_article'],
    },
  },
  [DEREK_SCHEMA]: {
    name: DEREK_SCHEMA,
    schema: {
      type: 'object',
      properties: {
        writing_voice: {
          type: 'object',
          properties: {
            tone: { type: 'string' },
            sentence_patterns: { type: 'string' },
            first_person_usage: { type: 'string' },
            emotional_candor: { type: 'string' },
            humor_style: { type: 'string' },
          },
          required: ['tone', 'sentence_patterns', 'first_person_usage', 'emotional_candor', 'humor_style'],
        },
        strengths: { type: 'array', items: { type: 'string' } },
        signature_habits: { type: 'array', items: { type: 'string' } },
        editorial_voice_markers: { type: 'array', items: { type: 'string' } },
        topics_specialties: { type: 'array', items: { type: 'string' } },
        prose_tendencies: {
          type: 'object',
          properties: {
            paragraph_style: { type: 'string' },
            transition_style: { type: 'string' },
            detail_level: { type: 'string' },
            quote_integration: { type: 'string' },
          },
        },
        what_to_preserve_in_ai_drafts: { type: 'string' },
      },
      required: ['writing_voice', 'strengths', 'signature_habits', 'editorial_voice_markers', 'topics_specialties', 'prose_tendencies', 'what_to_preserve_in_ai_drafts'],
    },
  },
};

async function callLLM({ model, systemPrompt, userPrompt, minimaxSchema }) {
  const isMinimax = model === MINIMAX_MODEL;
  const apiKey = isMinimax
    ? process.env.MINIMAX_API_KEY
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(`${isMinimax ? 'MINIMAX_API_KEY' : 'ANTHROPIC_API_KEY'} not set`);
  }

  if (isMinimax) {
    // Minimax API call — OpenAI-compatible endpoint per MiniMax docs
    // Use response_format to request structured JSON, avoiding parse issues
    const response = await fetch('https://api.minimax.io/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        ...(minimaxSchema ? { response_format: { type: 'json_schema', json_schema: minimaxSchema } } : {}),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Minimax API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    // With response_format: json_schema, content may still come back as a JSON string
    // in choices[0].message.content, OR the structured output may be elsewhere in the response.
    // Log the raw data shape so we can diagnose:
    const choice = data.choices?.[0];
    let content;
    if (choice?.message?.content) {
      content = choice.message.content;
    } else {
      // Structured JSON mode may put the result elsewhere — dump for diagnostics
      console.error('[callLLM] Minimax response structure:', JSON.stringify(data).slice(0, 500));
      throw new Error('Minimax returned no content in expected field');
    }
    if (!content) throw new Error('Minimax returned empty content');
    return content.trim();
  } else {
    // Anthropic API call
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        ...(isMinimax ? { temperature: 0.3 } : {}),
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) throw new Error('Anthropic returned empty content');
    return content.trim();
  }
}

function parseJsonOrThrow(text, context = '') {
  // Try to extract JSON object — find the first { and matching } using a stack approach
  // to avoid greedy capture of trailing text that might corrupt the JSON
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' && start === -1) {
      start = i;
      depth = 1;
    } else if (ch === '{' && start !== -1) {
      depth++;
    } else if (ch === '}' && start !== -1) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (start === -1 || end === -1) throw new Error('No JSON object found in response' + (context ? ` (${context})` : ''));
  const jsonStr = text.slice(start, end);
  try {
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    // Show the problematic area
    const errPos = parseErr.message.match(/position (\d+)/)?.[1];
    const pos = errPos ? parseInt(errPos) : null;
    let excerpt = jsonStr;
    if (pos !== null) {
      const startEx = Math.max(0, pos - 50);
      const endEx = Math.min(jsonStr.length, pos + 50);
      excerpt = jsonStr.slice(startEx, endEx);
    }
    throw new Error(`${parseErr.message} — excerpt: "${excerpt}"${context ? ` (${context})` : ''}`);
  }
}

async function main() {
  const mode = process.argv.includes('--minimax')
    ? 'minimax-only'
    : process.argv.includes('--opus')
      ? 'opus-only'
      : 'full';

  console.log('analyze-rag-corpus: Starting...\n');

  if (!process.env.ALTWIRE_DATABASE_URL) {
    console.error('analyze-rag-corpus: ALTWIRE_DATABASE_URL not set — cannot analyze corpus.');
    process.exit(1);
  }

  // Fetch chunks
  console.log(`Fetching ${RAG_SAMPLE_SIZE} RAG chunks...`);
  const chunks = await fetchRagChunks();
  console.log(`Fetched ${chunks.length} chunks.`);

  if (chunks.length === 0) {
    console.error('analyze-rag-corpus: No RAG chunks found. Run the ingest pipeline first.');
    process.exit(1);
  }

  // Also fetch Derek's own articles for author voice profiling
  console.log(`\nFetching ${DEREK_SAMPLE_SIZE} Derek-authored chunks (author_id=${DEREK_AUTHOR_ID})...`);
  const derekChunks = await fetchDerekChunks();
  console.log(`Fetched ${derekChunks.length} Derek chunks.`);

  const formattedChunks = chunks.map(formatChunk);
  const formattedDerekChunks = derekChunks.map(formatChunk);

  let minimaxDraft = null;
  let derekMinimaxDraft = null;

  // Step 1a: Minimax editorial context
  if (mode === 'minimax-only' || mode === 'full') {
    console.log('\n[Step 1a] Running Minimax editorial analysis...');
    let raw = null;
    try {
      raw = await callLLM({
        model: MINIMAX_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: MINIMAX_ANALYSIS_PROMPT(formattedChunks),
        minimaxSchema: MINIMAX_SCHEMAS[EDITORIAL_SCHEMA],
      });
      minimaxDraft = parseJsonOrThrow(raw, 'Step 1a editorial');
      console.log('[Step 1a] Minimax editorial draft complete.');
      console.log(JSON.stringify(minimaxDraft, null, 2));
    } catch (err) {
      console.error('[Step 1a] Minimax editorial failed:', err.message);
      if (raw) console.error('[Step 1a] Raw response (first 500 chars):', raw.slice(0, 500));
      if (mode === 'minimax-only') process.exit(1);
      console.warn('[Step 1a] Proceeding without editorial draft...');
    }
  } else if (mode === 'opus-only') {
    // Load previous drafts from env vars
    if (!process.env.MINIMAX_DRAFT) {
      console.error('--opus mode requires MINIMAX_DRAFT env var (base64 encoded editorial JSON)');
      process.exit(1);
    }
    try {
      minimaxDraft = JSON.parse(Buffer.from(process.env.MINIMAX_DRAFT, 'base64').toString('utf8'));
      console.log('[Step 1a] Loaded Minimax editorial draft from MINIMAX_DRAFT env var.');
    } catch (err) {
      console.error('Failed to parse MINIMAX_DRAFT:', err.message);
      process.exit(1);
    }
  }

  // Step 1b: Minimax Derek author profile
  if (derekChunks.length > 0 && (mode === 'minimax-only' || mode === 'full')) {
    console.log('\n[Step 1b] Running Minimax Derek author analysis...');
    let raw = null;
    try {
      raw = await callLLM({
        model: MINIMAX_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: DEREK_ANALYSIS_PROMPT(formattedDerekChunks),
        minimaxSchema: MINIMAX_SCHEMAS[DEREK_SCHEMA],
      });
      derekMinimaxDraft = parseJsonOrThrow(raw, 'Step 1b Derek author');
      console.log('[Step 1b] Minimax Derek author draft complete.');
      console.log(JSON.stringify(derekMinimaxDraft, null, 2));
    } catch (err) {
      console.error('[Step 1b] Minimax Derek author failed:', err.message);
      if (raw) console.error('[Step 1b] Raw response (first 500 chars):', raw.slice(0, 500));
      console.warn('[Step 1b] Proceeding without Derek author draft...');
    }
  } else if (mode === 'opus-only' && process.env.DEREK_MINIMAX_DRAFT) {
    try {
      derekMinimaxDraft = JSON.parse(Buffer.from(process.env.DEREK_MINIMAX_DRAFT, 'base64').toString('utf8'));
      console.log('[Step 1b] Loaded Minimax Derek author draft from DEREK_MINIMAX_DRAFT env var.');
    } catch (err) {
      console.error('Failed to parse DEREK_MINIMAX_DRAFT:', err.message);
    }
  }

  // Step 2a: Opus editorial review (production)
  if (mode === 'full' || mode === 'opus-only') {
    if (!minimaxDraft) {
      console.error('[Step 2a] No Minimax editorial draft to review — cannot proceed.');
      process.exit(1);
    }
    console.log('\n[Step 2a] Running Opus 4 editorial review...');
    try {
      const raw = await callLLM({
        model: OPUS_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: OPUS_REVIEW_PROMPT(JSON.stringify(minimaxDraft, null, 2)),
      });
      const finalContext = parseJsonOrThrow(raw);
      console.log('[Step 2a] Opus editorial review complete.');
      console.log(JSON.stringify(finalContext, null, 2));

      // Write to agent_memory
      const value = JSON.stringify(finalContext, null, 2);
      await writeAgentMemory('hal', EDITORIAL_CONTEXT_KEY, value);
      console.log(`\n[Done] Wrote ${EDITORIAL_CONTEXT_KEY} to agent_memory.`);

      // If full mode, also save minimax draft as a diagnostic artifact
      if (mode === 'full') {
        await writeAgentMemory('hal', 'hal:altwire:editorial_context:draft', JSON.stringify(minimaxDraft));
        console.log('[Done] Also saved Minimax editorial draft to hal:altwire:editorial_context:draft (for diagnostics).');
      }
    } catch (err) {
      console.error('[Step 2a] Opus editorial review failed:', err.message);
      process.exit(1);
    }
  }

  // Step 2b: Opus Derek author review (production)
  if (derekMinimaxDraft && (mode === 'full' || mode === 'opus-only')) {
    console.log('\n[Step 2b] Running Opus 4 Derek author review...');
    try {
      const raw = await callLLM({
        model: OPUS_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: OPUS_DEREK_REVIEW_PROMPT(JSON.stringify(derekMinimaxDraft, null, 2)),
      });
      const derekProfile = parseJsonOrThrow(raw);
      console.log('[Step 2b] Opus Derek author review complete.');
      console.log(JSON.stringify(derekProfile, null, 2));

      // Write to agent_memory
      const derekValue = JSON.stringify(derekProfile, null, 2);
      await writeAgentMemory('hal', DEREK_AUTHOR_KEY, derekValue);
      console.log(`\n[Done] Wrote ${DEREK_AUTHOR_KEY} to agent_memory.`);

      if (mode === 'full') {
        await writeAgentMemory('hal', 'hal:altwire:derek_author_profile:draft', JSON.stringify(derekMinimaxDraft));
        console.log('[Done] Also saved Minimax Derek draft to hal:altwire:derek_author_profile:draft (for diagnostics).');
      }
    } catch (err) {
      console.error('[Step 2b] Opus Derek author review failed:', err.message);
      process.exit(1);
    }
  } else if (mode === 'minimax-only' && derekMinimaxDraft) {
    const derekEncoded = Buffer.from(JSON.stringify(derekMinimaxDraft)).toString('base64');
    console.log('\n[Done] Derek author Minimax draft ready. Run with --opus and set DEREK_MINIMAX_DRAFT env var:');
    console.log(`  export DEREK_MINIMAX_DRAFT="${derekEncoded}"`);
  }

  if (mode === 'minimax-only') {
    // Save minimax editorial draft to env-parseable location for later opus pass
    const encoded = Buffer.from(JSON.stringify(minimaxDraft)).toString('base64');
    console.log('\n[Done] Minimax editorial draft ready. Run with --opus and set MINIMAX_DRAFT env var:');
    console.log(`  export MINIMAX_DRAFT="${encoded}"`);
    console.log(`  node scripts/analyze-rag-corpus.js --opus`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('analyze-rag-corpus: Unexpected error', err);
  process.exit(1);
});