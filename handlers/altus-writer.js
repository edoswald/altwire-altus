/**
 * altus-writer.js
 *
 * AI Writer pipeline handler for AltWire Altus.
 * Multi-step content generation: assignment → outline → draft → fact-check → WordPress post.
 *
 * All AI generation calls route through lib/writer-client.js — never calls SDKs directly.
 */

import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';
import { generate } from '../lib/writer-client.js';
import { searchAltwireArchive } from './altus-search.js';
import { buildAuthHeader } from '../lib/wp-client.js';
import { markdownToHtml } from '../lib/markdown.js';
import { getDerekAuthorProfile } from '../hal-harness.js';

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

export async function initWriterSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_assignments (
      id                SERIAL PRIMARY KEY,
      topic             TEXT NOT NULL,
      article_type      TEXT NOT NULL DEFAULT 'article'
                        CHECK (article_type IN ('article', 'review', 'interview', 'feature')),
      status            TEXT NOT NULL DEFAULT 'researching'
                        CHECK (status IN (
                          'researching', 'outline_ready', 'outline_approved',
                          'drafting', 'draft_ready', 'fact_checking',
                          'needs_revision', 'ready_to_post', 'posted', 'cancelled'
                        )),
      archive_research  JSONB,
      web_research      TEXT,
      review_notes_id   INTEGER REFERENCES altus_reviews(id) ON DELETE SET NULL,
      outline           JSONB,
      outline_notes     TEXT,
      draft_content     TEXT,
      draft_word_count  INTEGER,
      fact_check_results JSONB,
      wp_post_id        INTEGER,
      wp_post_url       TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_assignments_status_idx ON altus_assignments (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_assignments_created_idx ON altus_assignments (created_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_editorial_decisions (
      id              SERIAL PRIMARY KEY,
      assignment_id   INTEGER REFERENCES altus_assignments(id) ON DELETE SET NULL,
      stage           TEXT NOT NULL
                      CHECK (stage IN ('outline', 'draft', 'post', 'feedback')),
      decision        TEXT NOT NULL
                      CHECK (decision IN ('approved', 'rejected', 'modified', 'cancelled')),
      feedback        TEXT,
      article_type    TEXT,
      topic           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS altus_editorial_decisions_assignment_idx ON altus_editorial_decisions (assignment_id)`);

  logger.info('Writer schema initialized');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchAssignment(id) {
  const { rows } = await pool.query('SELECT * FROM altus_assignments WHERE id = $1', [id]);
  return rows[0] || null;
}

async function updateAssignment(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  sets.push('updated_at = NOW()');
  const values = keys.map((k) => fields[k]);
  const { rows } = await pool.query(
    `UPDATE altus_assignments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0];
}

async function fetchReviewNotes(reviewNotesId) {
  if (!reviewNotesId) return null;
  const { rows } = await pool.query(
    'SELECT * FROM altus_review_notes WHERE review_id = $1 ORDER BY created_at ASC',
    [reviewNotesId],
  );
  return rows.length > 0 ? rows : null;
}

function formatReviewNotes(notes) {
  if (!notes || notes.length === 0) return '';
  const pros = notes.filter((n) => n.category === 'pro').map((n) => n.note_text);
  const cons = notes.filter((n) => n.category === 'con').map((n) => n.note_text);
  const observations = notes.filter((n) => n.category === 'observation').map((n) => n.note_text);
  let text = "\nDerek's review notes (first-person observations — treat as authoritative):";
  if (pros.length) text += `\nPros: ${pros.join('; ')}`;
  if (cons.length) text += `\nCons: ${cons.join('; ')}`;
  if (observations.length) text += `\nObservations: ${observations.join('; ')}`;
  return text;
}

function formatArchiveForPrompt(archive, limit = 5) {
  if (!archive?.results) return 'No previous AltWire coverage found.';
  return archive.results
    .slice(0, limit)
    .map((r) => `- ${r.title}: ${r.snippet}`)
    .join('\n');
}


// ---------------------------------------------------------------------------
// createAssignment
// ---------------------------------------------------------------------------

export async function createAssignment({ topic, article_type = 'article', review_notes_id }) {
  // Insert initial row
  const { rows } = await pool.query(
    `INSERT INTO altus_assignments (topic, article_type, review_notes_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [topic, article_type, review_notes_id || null],
  );
  const assignment = rows[0];

  // Parallel research via Promise.allSettled
  const [archiveResult, webResult] = await Promise.allSettled([
    searchAltwireArchive({ query: topic, limit: 10, content_type: 'all' }),
    generate({
      toolName: 'create_article_assignment',
      system: 'You are a research assistant for AltWire, an independent music news publication. Synthesize current context about the given topic — recent news, announcements, background. Be concise and factual.',
      prompt: `Research current context about: ${topic}`,
      webSearch: true,
    }),
  ]);

  const archiveResearch = archiveResult.status === 'fulfilled' ? archiveResult.value : null;
  const webResearch = webResult.status === 'fulfilled' ? webResult.value : null;

  if (archiveResult.status === 'rejected') {
    logger.error('Archive research failed', { error: archiveResult.reason?.message, topic });
  }
  if (webResult.status === 'rejected') {
    logger.error('Web research failed', { error: webResult.reason?.message, topic });
  }

  // If review_notes_id provided, fetch notes and store as part of research context
  let reviewNotesContext = null;
  if (review_notes_id) {
    const notes = await fetchReviewNotes(review_notes_id);
    if (notes) {
      reviewNotesContext = notes;
    }
  }

  // Update assignment with research results and advance status
  const updated = await updateAssignment(assignment.id, {
    archive_research: archiveResearch ? JSON.stringify(archiveResearch) : null,
    web_research: webResearch,
    status: 'outline_ready',
  });

  return {
    success: true,
    assignment: {
      id: updated.id,
      topic: updated.topic,
      article_type: updated.article_type,
      status: updated.status,
      archive_hits: archiveResearch?.results?.length || 0,
      web_research_summary: webResearch ? webResearch.slice(0, 200) : null,
      has_review_notes: !!reviewNotesContext,
    },
  };
}


// ---------------------------------------------------------------------------
// generateOutline
// ---------------------------------------------------------------------------

export async function generateOutline({ assignment_id }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };
  if (assignment.status !== 'outline_ready') {
    return { error: 'assignment_not_ready_for_outline', status: assignment.status };
  }

  // Fetch review notes if linked
  const reviewNotes = await fetchReviewNotes(assignment.review_notes_id);
  const reviewNotesPrompt = reviewNotes ? formatReviewNotes(reviewNotes) : '';

  const archiveContext = formatArchiveForPrompt(assignment.archive_research);

  const system = `You are an editorial assistant for AltWire, an independent music news publication covering alternative, indie, and emerging artists. Write in AltWire's voice: direct, knowledgeable, enthusiastic without being breathless. Avoid generic music journalism clichés. Derek is the editor and will approve this outline before any writing begins.`;

  const prompt = `Generate a structured outline for a ${assignment.article_type} about: ${assignment.topic}

Archive research (what AltWire has already covered):
${archiveContext}

Web research context:
${assignment.web_research || 'No web research available.'}
${reviewNotesPrompt}

Return a JSON object with this exact structure:
{
  "title_suggestion": "suggested headline",
  "sections": [
    {
      "title": "section heading",
      "points": ["bullet point 1", "bullet point 2"]
    }
  ],
  "angle": "one sentence describing the editorial angle",
  "estimated_words": 800
}`;

  const response = await generate({
    toolName: 'generate_article_outline',
    system,
    prompt,
    jsonMode: true,
  });

  // Parse and validate outline JSON
  let outline;
  try {
    outline = JSON.parse(response);
  } catch {
    // Retry once on malformed JSON
    const retry = await generate({
      toolName: 'generate_article_outline',
      system,
      prompt: prompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY a valid JSON object.',
      jsonMode: true,
    });
    outline = JSON.parse(retry);
  }

  const updated = await updateAssignment(assignment_id, {
    outline: JSON.stringify(outline),
  });

  return {
    success: true,
    assignment_id: updated.id,
    outline,
  };
}


// ---------------------------------------------------------------------------
// approveOutline
// ---------------------------------------------------------------------------

export async function approveOutline({ assignment_id, decision, feedback }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };
  if (assignment.status !== 'outline_ready') {
    return { error: 'assignment_not_ready_for_approval', status: assignment.status };
  }

  let newStatus;
  const updateFields = {};

  if (decision === 'approved') {
    newStatus = 'outline_approved';
    if (feedback) updateFields.outline_notes = feedback;
  } else if (decision === 'rejected') {
    newStatus = 'cancelled';
    if (feedback) updateFields.outline_notes = feedback;
  } else if (decision === 'modified') {
    newStatus = 'outline_ready';
    if (feedback) updateFields.outline_notes = feedback;
  }

  updateFields.status = newStatus;
  const updated = await updateAssignment(assignment_id, updateFields);

  // Log editorial decision
  await pool.query(
    `INSERT INTO altus_editorial_decisions (assignment_id, stage, decision, feedback, article_type, topic)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [assignment_id, 'outline', decision, feedback || null, assignment.article_type, assignment.topic],
  );

  return { success: true, assignment_id: updated.id, status: updated.status, decision_logged: true };
}


// ---------------------------------------------------------------------------
// generateDraft
// ---------------------------------------------------------------------------

export async function generateDraft({ assignment_id }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };
  if (assignment.status !== 'outline_approved') {
    return { error: 'assignment_not_ready_for_draft', status: assignment.status };
  }

  // Set status to drafting before the long API call
  await updateAssignment(assignment_id, { status: 'drafting' });

  const outline = typeof assignment.outline === 'string' ? JSON.parse(assignment.outline) : assignment.outline;
  const reviewNotes = await fetchReviewNotes(assignment.review_notes_id);
  const reviewNotesPrompt = reviewNotes ? formatReviewNotes(reviewNotes) : '';
  const archiveContext = formatArchiveForPrompt(assignment.archive_research, 2);

  // Load Derek's author profile for voice injection
  const authorProfile = await getDerekAuthorProfile();
  const voiceDirective = authorProfile?.what_to_preserve_in_ai_drafts
    ? `\n\nVoice directive from Derek: ${authorProfile.what_to_preserve_in_ai_drafts}`
    : '';

  const outlineFormatted = (outline.sections || [])
    .map((s) => `## ${s.title}\n${(s.points || []).map((p) => `- ${p}`).join('\n')}`)
    .join('\n\n');

  const system = `You are a staff writer for AltWire, an independent music news publication.
Write in AltWire's voice: direct, knowledgeable, conversational. Music-literate readers who follow indie and alternative scenes. No filler. No hollow superlatives. Lead with the most interesting thing. Active voice. Concrete details over vague praise.
Target length: ${outline.estimated_words || 800} words.${voiceDirective}`;

  const prompt = `Write a ${assignment.article_type} about: ${assignment.topic}

Follow this approved outline exactly:
${outlineFormatted}
${reviewNotesPrompt ? `\nThese are Derek's first-person observations from spending time with the product. Weave them into the appropriate sections naturally — they are the most authentic part of this piece:${reviewNotesPrompt}` : ''}

Web research context:
${assignment.web_research || 'No web research available.'}

Previous AltWire coverage for voice reference (do not repeat — use for tone only):
${archiveContext}

Return the complete article in markdown. Use ## for section headings matching the outline.`;

  const draft = await generate({
    toolName: 'generate_article_draft',
    system,
    prompt,
    maxTokens: 6000,
  });

  const wordCount = draft.split(/\s+/).filter(Boolean).length;

  const updated = await updateAssignment(assignment_id, {
    draft_content: draft,
    draft_word_count: wordCount,
    status: 'draft_ready',
  });

  return {
    success: true,
    assignment_id: updated.id,
    status: updated.status,
    word_count: wordCount,
    draft_preview: draft.slice(0, 300),
  };
}


// ---------------------------------------------------------------------------
// factCheckDraft
// ---------------------------------------------------------------------------

export async function factCheckDraft({ assignment_id }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };
  if (assignment.status !== 'draft_ready' && assignment.status !== 'needs_revision') {
    return { error: 'assignment_not_ready_for_fact_check', status: assignment.status };
  }

  await updateAssignment(assignment_id, { status: 'fact_checking' });

  const factCheckSystem = `You are a fact-checker for a music news publication. Check factual claims only — not style, tone, or opinion. Flag specific verifiable claims that appear incorrect or unverifiable. Do not flag subjective statements or opinions.`;

  const factCheckPrompt = `Fact-check the following article about ${assignment.topic}. Use web search to verify specific claims about dates, names, album titles, chart positions, and factual statements.

${assignment.draft_content}

Return JSON:
{
  "passed": true/false,
  "issues": [
    {
      "section_heading": "## Section Title",
      "claim": "the specific claim that may be wrong",
      "issue": "what appears to be incorrect",
      "severity": "high|medium|low"
    }
  ]
}
If no issues found, return { "passed": true, "issues": [] }`;

  // Initial fact check
  const checkResponse = await generate({
    toolName: 'fact_check_draft',
    system: factCheckSystem,
    prompt: factCheckPrompt,
    webSearch: true,
    jsonMode: true,
  });

  let results;
  try {
    results = JSON.parse(checkResponse);
  } catch {
    results = { passed: true, issues: [] };
  }

  // If no issues, we're done
  if (results.passed || !results.issues || results.issues.length === 0) {
    const updated = await updateAssignment(assignment_id, {
      fact_check_results: JSON.stringify(results),
      status: 'ready_to_post',
    });
    return { success: true, assignment_id: updated.id, passed: true, issues_found: 0, status: 'ready_to_post' };
  }

  // Issues found — regenerate flagged sections, then re-check (bounded to 1 iteration)
  await updateAssignment(assignment_id, { status: 'needs_revision' });

  let draftContent = assignment.draft_content;
  for (const issue of results.issues.filter((i) => i.severity === 'high' || i.severity === 'medium')) {
    const sectionHeading = issue.section_heading || '';
    const regenPrompt = `Rewrite the following section of an article about ${assignment.topic}. Fix this factual issue: "${issue.issue}" regarding the claim: "${issue.claim}"

Section to rewrite (preserve the heading):
${extractSection(draftContent, sectionHeading)}

Return ONLY the corrected section text including the heading. Do not include any other sections.`;

    const corrected = await generate({
      toolName: 'fact_check_draft',
      system: 'You are a staff writer for AltWire. Rewrite the section to fix the factual issue while preserving the original voice and style.',
      prompt: regenPrompt,
    });

    draftContent = spliceSection(draftContent, sectionHeading, corrected);
  }

  // Re-check the updated draft
  const reCheckResponse = await generate({
    toolName: 'fact_check_draft',
    system: factCheckSystem,
    prompt: `Fact-check the following corrected article about ${assignment.topic}. Use web search to verify specific claims about dates, names, album titles, chart positions, and factual statements.

${draftContent}

Return JSON:
{
  "passed": true/false,
  "issues": [
    {
      "section_heading": "## Section Title",
      "claim": "the specific claim that may be wrong",
      "issue": "what appears to be incorrect",
      "severity": "high|medium|low"
    }
  ]
}
If no issues found, return { "passed": true, "issues": [] }`,
    webSearch: true,
    jsonMode: true,
  });

  let finalResults;
  try {
    finalResults = JSON.parse(reCheckResponse);
  } catch {
    finalResults = results;
  }

  const updated = await updateAssignment(assignment_id, {
    draft_content: draftContent,
    draft_word_count: draftContent.split(/\s+/).filter(Boolean).length,
    fact_check_results: JSON.stringify(finalResults),
    status: 'ready_to_post',
  });

  return {
    success: true,
    assignment_id: updated.id,
    passed: finalResults.passed ?? false,
    issues_found: finalResults.issues?.length || 0,
    status: 'ready_to_post',
  };
}

// Section extraction/splicing helpers for fact-check regeneration
function extractSection(markdown, heading) {
  if (!heading) return '';
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped}[\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = markdown.match(regex);
  return match ? match[1].trim() : '';
}

function spliceSection(markdown, heading, replacement) {
  if (!heading) return markdown;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped}[\\s\\S]*?)(?=\\n##\\s|$)`);
  return markdown.replace(regex, replacement.trim());
}


// ---------------------------------------------------------------------------
// getDraftAsHtml
// ---------------------------------------------------------------------------

export async function getDraftAsHtml({ assignment_id }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };
  if (!assignment.draft_content) return {
    error: 'no_draft_content',
    assignment_id,
    message: 'This assignment does not have a draft yet. Run generate_article_draft first.',
  };

  const outline = typeof assignment.outline === 'string'
    ? JSON.parse(assignment.outline) : assignment.outline;

  return {
    success: true,
    assignment_id: assignment.id,
    topic: assignment.topic,
    title_suggestion: outline?.title_suggestion || assignment.topic,
    html: markdownToHtml(assignment.draft_content),
    word_count: assignment.draft_word_count,
    instructions: 'Copy the html field and paste into WordPress → Text/Code editor. The title_suggestion is not included in the HTML — set it as the post title in WordPress.',
  };
}

// ---------------------------------------------------------------------------
// postToWordPress
// ---------------------------------------------------------------------------

export async function postToWordPress({ assignment_id, title, categories, tags }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };
  if (assignment.status !== 'ready_to_post') {
    return { error: 'assignment_not_ready_to_post', status: assignment.status };
  }

  const outline = typeof assignment.outline === 'string' ? JSON.parse(assignment.outline) : assignment.outline;
  const postTitle = title || outline?.title_suggestion || assignment.topic;
  const htmlContent = markdownToHtml(assignment.draft_content);

  const wpUrl = (process.env.ALTWIRE_WP_URL || '').replace(/\/$/, '');
  const body = {
    title: postTitle,
    content: htmlContent,
    status: 'draft',
  };
  if (categories) body.categories = categories;
  if (tags) body.tags = tags;

  try {
    const res = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: buildAuthHeader(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: 'wordpress_post_failed', message: `WP API ${res.status}: ${errText}` };
    }

    const wpPost = await res.json();
    const updated = await updateAssignment(assignment_id, {
      wp_post_id: wpPost.id,
      wp_post_url: wpPost.link || `${wpUrl}/?p=${wpPost.id}`,
      status: 'posted',
    });

    // Log editorial decision
    await pool.query(
      `INSERT INTO altus_editorial_decisions (assignment_id, stage, decision, article_type, topic)
       VALUES ($1, $2, $3, $4, $5)`,
      [assignment_id, 'post', 'approved', assignment.article_type, assignment.topic],
    );

    return {
      success: true,
      assignment_id: updated.id,
      wp_post_id: wpPost.id,
      wp_post_url: updated.wp_post_url,
      status: 'posted',
    };
  } catch (err) {
    return { error: 'wordpress_post_failed', message: err.message };
  }
}


// ---------------------------------------------------------------------------
// logEditorialDecision
// ---------------------------------------------------------------------------

export async function logEditorialDecision({ assignment_id, stage, decision, feedback }) {
  const assignment = await fetchAssignment(assignment_id);
  if (!assignment) return { error: 'assignment_not_found', assignment_id };

  // If cancelled, also update assignment status
  if (decision === 'cancelled') {
    await updateAssignment(assignment_id, { status: 'cancelled' });
  }

  const { rows } = await pool.query(
    `INSERT INTO altus_editorial_decisions (assignment_id, stage, decision, feedback, article_type, topic)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [assignment_id, stage, decision, feedback || null, assignment.article_type, assignment.topic],
  );

  return { success: true, decision_id: rows[0].id };
}

// ---------------------------------------------------------------------------
// getAssignment
// ---------------------------------------------------------------------------

export async function getAssignment({ id }) {
  const { rows: assignmentRows } = await pool.query(
    'SELECT * FROM altus_assignments WHERE id = $1',
    [id],
  );
  if (assignmentRows.length === 0) return { error: 'assignment_not_found', assignment_id: id };

  const { rows: decisionRows } = await pool.query(
    'SELECT * FROM altus_editorial_decisions WHERE assignment_id = $1 ORDER BY created_at ASC',
    [id],
  );

  return {
    ...assignmentRows[0],
    decisions: decisionRows,
  };
}

// ---------------------------------------------------------------------------
// listAssignments
// ---------------------------------------------------------------------------

export async function listAssignments({ status, article_type, limit = 20, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (status) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }
  if (article_type) {
    conditions.push(`article_type = $${idx++}`);
    values.push(article_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(limit, 1), 50);

  const { rows } = await pool.query(
    `SELECT id, topic, article_type, status, draft_word_count, wp_post_url, created_at, updated_at
     FROM altus_assignments
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...values, safeLimit, offset],
  );

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM altus_assignments ${where}`,
    values,
  );

  return {
    assignments: rows,
    count: rows.length,
    total: countRows[0]?.total || 0,
  };
}
