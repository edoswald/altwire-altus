// Feature: altus-html-export, Property 1–5: markdown conversion and getDraftAsHtml correctness

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { markdownToHtml } from '../lib/markdown.js';

// ---------------------------------------------------------------------------
// Arbitraries for markdown generation
// ---------------------------------------------------------------------------

/** Text that won't accidentally trigger markdown syntax */
const safeText = fc.string({ minLength: 2, maxLength: 30 })
  .map(s => s.replace(/[#*\[\]\(\)\-\\`>!\d\n\r]/g, 'x'))
  .filter(s => s.trim().length >= 2);

// ---------------------------------------------------------------------------
// Property 1: Markdown-to-HTML tag preservation
// ---------------------------------------------------------------------------

describe('Property 1: Markdown-to-HTML tag preservation', () => {
  it('## headings produce <h2> tags with text preserved', () => {
    fc.assert(
      fc.property(safeText, (text) => {
        const html = markdownToHtml(`## ${text}`);
        expect(html).toContain(`<h2>${text}</h2>`);
      }),
      { numRuns: 100 }
    );
  });

  it('### headings produce <h3> tags with text preserved', () => {
    fc.assert(
      fc.property(safeText, (text) => {
        const html = markdownToHtml(`### ${text}`);
        expect(html).toContain(`<h3>${text}</h3>`);
      }),
      { numRuns: 100 }
    );
  });

  it('**bold** produces <strong> tags with text preserved', () => {
    fc.assert(
      fc.property(safeText, (text) => {
        const html = markdownToHtml(`**${text}**`);
        expect(html).toContain(`<strong>${text}</strong>`);
      }),
      { numRuns: 100 }
    );
  });

  it('*italic* produces <em> tags with text preserved', () => {
    fc.assert(
      fc.property(safeText, (text) => {
        const html = markdownToHtml(`*${text}*`);
        expect(html).toContain(`<em>${text}</em>`);
      }),
      { numRuns: 100 }
    );
  });

  it('[text](url) produces <a href> tags', () => {
    fc.assert(
      fc.property(safeText, (text) => {
        const url = 'https://altwire.net/test';
        const html = markdownToHtml(`[${text}](${url})`);
        expect(html).toContain(`<a href="${url}">${text}</a>`);
      }),
      { numRuns: 100 }
    );
  });

  it('consecutive - items produce grouped <ul><li> tags', () => {
    fc.assert(
      fc.property(
        fc.array(safeText.map(s => s.trim()), { minLength: 2, maxLength: 4 }),
        (items) => {
          const md = items.map(i => `- ${i}`).join('\n');
          const html = markdownToHtml(md);
          expect(html).toContain('<ul>');
          expect(html).toContain('</ul>');
          for (const item of items) {
            expect(html).toContain(`<li>${item}</li>`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('blank-line-separated text blocks produce <p> tags', () => {
    fc.assert(
      fc.property(safeText, safeText, (a, b) => {
        const md = `${a}\n\n${b}`;
        const html = markdownToHtml(md);
        // markdownToHtml trims blocks, so check trimmed versions
        expect(html).toContain(`<p>${a.trim()}</p>`);
        expect(html).toContain(`<p>${b.trim()}</p>`);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Null and empty input safety
// ---------------------------------------------------------------------------

describe('Property 2: Null and empty input safety', () => {
  it('null, undefined, and empty string all return empty string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, ''),
        (input) => {
          expect(markdownToHtml(input)).toBe('');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Extraction equivalence (no-regression)
// ---------------------------------------------------------------------------

describe('Property 3: Extraction equivalence (no-regression)', () => {
  // Inline copy of the original function for comparison
  function originalMarkdownToHtml(md) {
    if (!md) return '';
    let html = md;
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/(?:^- .+$\n?)+/gm, (block) => {
      const items = block.trim().split('\n').map((line) => `<li>${line.replace(/^- /, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    });
    html = html.replace(/(?:^\d+\. .+$\n?)+/gm, (block) => {
      const items = block.trim().split('\n').map((line) => `<li>${line.replace(/^\d+\. /, '')}</li>`).join('');
      return `<ol>${items}</ol>`;
    });
    html = html
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        if (/^<(h[1-3]|ul|ol|p)/.test(block)) return block;
        return `<p>${block.replace(/\n/g, ' ')}</p>`;
      })
      .join('\n');
    return html;
  }

  /** Arbitrary that produces markdown-like strings with mixed syntax */
  const h2Arb = safeText.map(t => `## ${t}`);
  const h3Arb = safeText.map(t => `### ${t}`);
  const boldArb = safeText.map(t => `**${t}**`);
  const italicArb = safeText.map(t => `*${t}*`);
  const ulArb = fc.array(safeText, { minLength: 2, maxLength: 4 })
    .map(items => items.map(i => `- ${i}`).join('\n'));

  const mixedMarkdownArb = fc.array(
    fc.oneof(h2Arb, h3Arb, boldArb, italicArb, ulArb, safeText),
    { minLength: 1, maxLength: 6 }
  ).map(parts => parts.join('\n\n'));

  it('extracted lib/markdown.js output is byte-identical to original inline function', () => {
    fc.assert(
      fc.property(mixedMarkdownArb, (md) => {
        expect(markdownToHtml(md)).toBe(originalMarkdownToHtml(md));
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: getDraftAsHtml response shape completeness
// Property 5: No status gating on HTML export
// ---------------------------------------------------------------------------

vi.mock('../lib/altus-db.js', () => {
  const mockQuery = vi.fn();
  return {
    default: { query: mockQuery },
    __mockQuery: mockQuery,
  };
});

const { getDraftAsHtml } = await import('../handlers/altus-writer.js');
const { __mockQuery: mockQuery } = await import('../lib/altus-db.js');

const VALID_STATUSES = [
  'researching', 'outline_ready', 'outline_approved', 'drafting',
  'draft_ready', 'fact_checking', 'needs_revision', 'ready_to_post',
  'posted', 'cancelled',
];

describe('Property 4: getDraftAsHtml response shape completeness', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns all required fields for any assignment with draft_content', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeText,
        safeText,
        safeText,
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 100, max: 5000 }),
        async (topic, titleSuggestion, draftContent, id, wordCount) => {
          mockQuery.mockResolvedValueOnce({
            rows: [{
              id,
              topic,
              outline: JSON.stringify({ title_suggestion: titleSuggestion }),
              draft_content: draftContent,
              draft_word_count: wordCount,
              status: 'draft_ready',
            }],
          });

          const result = await getDraftAsHtml({ assignment_id: id });
          expect(result).toHaveProperty('success', true);
          expect(result).toHaveProperty('assignment_id', id);
          expect(result).toHaveProperty('topic', topic);
          expect(result).toHaveProperty('title_suggestion', titleSuggestion);
          expect(result).toHaveProperty('html');
          expect(typeof result.html).toBe('string');
          expect(result).toHaveProperty('word_count', wordCount);
          expect(result).toHaveProperty('instructions');
          expect(typeof result.instructions).toBe('string');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 5: No status gating on HTML export', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns success for every valid status when draft_content is non-null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...VALID_STATUSES),
        async (status) => {
          mockQuery.mockResolvedValueOnce({
            rows: [{
              id: 1,
              topic: 'Test Topic',
              outline: JSON.stringify({ title_suggestion: 'Test Title' }),
              draft_content: '## Hello\n\nWorld',
              draft_word_count: 2,
              status,
            }],
          });

          const result = await getDraftAsHtml({ assignment_id: 1 });
          expect(result.success).toBe(true);
          expect(result.error).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});
