// Feature: altus-html-export — Unit tests for edge cases and error paths

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { markdownToHtml } from '../lib/markdown.js';

// ---------------------------------------------------------------------------
// markdownToHtml unit tests
// ---------------------------------------------------------------------------

describe('markdownToHtml', () => {
  it('converts a known markdown document to expected HTML', () => {
    const md = `## Section One

This is a paragraph with **bold** and *italic* text.

### Subsection

- Item one
- Item two
- Item three

Check out [AltWire](https://altwire.net) for more.

Another paragraph here.`;

    const html = markdownToHtml(md);

    expect(html).toContain('<h2>Section One</h2>');
    expect(html).toContain('<h3>Subsection</h3>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Item one</li>');
    expect(html).toContain('<li>Item two</li>');
    expect(html).toContain('<li>Item three</li>');
    expect(html).toContain('</ul>');
    expect(html).toContain('<a href="https://altwire.net">AltWire</a>');
    expect(html).toContain('<p>');
  });

  it('returns empty string for null', () => {
    expect(markdownToHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(markdownToHtml(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('converts ordered lists', () => {
    const md = `1. First\n2. Second\n3. Third`;
    const html = markdownToHtml(md);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<li>Second</li>');
    expect(html).toContain('<li>Third</li>');
    expect(html).toContain('</ol>');
  });

  it('converts h1 headings', () => {
    expect(markdownToHtml('# Title')).toContain('<h1>Title</h1>');
  });
});

// ---------------------------------------------------------------------------
// getDraftAsHtml unit tests (mocked DB)
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

describe('getDraftAsHtml', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns assignment_not_found for nonexistent assignment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getDraftAsHtml({ assignment_id: 999 });
    expect(result).toEqual({ error: 'assignment_not_found', assignment_id: 999 });
  });

  it('returns no_draft_content when draft_content is null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 1,
        topic: 'Test',
        outline: null,
        draft_content: null,
        draft_word_count: null,
        status: 'outline_ready',
      }],
    });
    const result = await getDraftAsHtml({ assignment_id: 1 });
    expect(result.error).toBe('no_draft_content');
    expect(result.assignment_id).toBe(1);
    expect(result.message).toContain('does not have a draft');
  });

  it('returns success with HTML for assignment with draft', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 5,
        topic: 'Turnstile Tour',
        outline: JSON.stringify({ title_suggestion: 'Turnstile Announces 2026 Tour' }),
        draft_content: '## The Tour\n\nTurnstile is hitting the road.',
        draft_word_count: 7,
        status: 'draft_ready',
      }],
    });
    const result = await getDraftAsHtml({ assignment_id: 5 });
    expect(result.success).toBe(true);
    expect(result.assignment_id).toBe(5);
    expect(result.topic).toBe('Turnstile Tour');
    expect(result.title_suggestion).toBe('Turnstile Announces 2026 Tour');
    expect(result.html).toContain('<h2>The Tour</h2>');
    expect(result.html).toContain('<p>Turnstile is hitting the road.</p>');
    expect(result.word_count).toBe(7);
    expect(result.instructions).toContain('Text/Code editor');
  });

  it('falls back to topic when outline has no title_suggestion', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 3,
        topic: 'Fallback Topic',
        outline: JSON.stringify({}),
        draft_content: 'Some draft text',
        draft_word_count: 3,
        status: 'ready_to_post',
      }],
    });
    const result = await getDraftAsHtml({ assignment_id: 3 });
    expect(result.success).toBe(true);
    expect(result.title_suggestion).toBe('Fallback Topic');
  });

  it('handles outline stored as string (not pre-parsed)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 4,
        topic: 'String Outline',
        outline: '{"title_suggestion":"From String"}',
        draft_content: 'Draft here',
        draft_word_count: 2,
        status: 'posted',
      }],
    });
    const result = await getDraftAsHtml({ assignment_id: 4 });
    expect(result.title_suggestion).toBe('From String');
  });

  it('handles null outline gracefully', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 6,
        topic: 'No Outline',
        outline: null,
        draft_content: 'Draft text',
        draft_word_count: 2,
        status: 'draft_ready',
      }],
    });
    const result = await getDraftAsHtml({ assignment_id: 6 });
    expect(result.success).toBe(true);
    expect(result.title_suggestion).toBe('No Outline');
  });
});
