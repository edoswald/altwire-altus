import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('altus-mountaineering — createClimb (TEST_MODE)', () => {
  beforeEach(() => {
    process.env.TEST_MODE = 'true';
    process.env.ALTWIRE_DATABASE_URL = 'postgres://test';
  });

  it('returns test_mode result without hitting DB', async () => {
    const { createClimb } = await import('../handlers/altus-mountaineering.js');
    const result = await createClimb({
      name: 'test-climb',
      objective: 'test',
      metric_description: 'test metric',
      workspace_key: 'hal:altwire:digest_format',
      eval_snapshot: { scoring_criteria: [] },
    });
    expect(result.success).toBe(true);
    expect(result.test_mode).toBe(true);
    expect(result.name).toBe('test-climb');
  });

  it('rejects invalid name (uppercase)', async () => {
    process.env.TEST_MODE = 'false';
    const { createClimb } = await import('../handlers/altus-mountaineering.js');
    const result = await createClimb({
      name: 'Invalid-Name',
      objective: 'test',
      metric_description: 'test',
      workspace_key: 'hal:altwire:digest_format',
      eval_snapshot: { a: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('validation_error');
  });

  it('rejects empty eval_snapshot', async () => {
    process.env.TEST_MODE = 'false';
    const { createClimb } = await import('../handlers/altus-mountaineering.js');
    const result = await createClimb({
      name: 'valid-name',
      objective: 'test',
      metric_description: 'test',
      workspace_key: 'hal:altwire:digest_format',
      eval_snapshot: {},
    });
    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('validation_error');
  });
});

describe('altus-mountaineering — startClimbIteration (TEST_MODE)', () => {
  it('returns test_mode result', async () => {
    process.env.TEST_MODE = 'true';
    const { startClimbIteration } = await import('../handlers/altus-mountaineering.js');
    const result = await startClimbIteration({ climb_name: 'morning-digest-v1' });
    expect(result.success).toBe(true);
    expect(result.test_mode).toBe(true);
    expect(result.iteration_number).toBe(1);
  });
});

describe('altus-mountaineering — scoreClimbIteration (TEST_MODE)', () => {
  it('returns test_mode result', async () => {
    process.env.TEST_MODE = 'true';
    const { scoreClimbIteration } = await import('../handlers/altus-mountaineering.js');
    const result = await scoreClimbIteration({ climb_name: 'morning-digest-v1', iteration_number: 1 });
    expect(result.success).toBe(true);
    expect(result.test_mode).toBe(true);
    expect(result.batch_id).toBe('mock-batch-id');
  });
});

describe('altus-mountaineering — scoreClimbIteration evidence', () => {
  it('reads altus_events payload as scoring evidence', async () => {
    vi.resetModules();
    process.env.TEST_MODE = 'false';
    process.env.ALTWIRE_DATABASE_URL = 'postgres://test';

    const mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          name: 'morning-digest-v1',
          eval_snapshot: { scoring_criteria: ['Use recent tool outcomes'] },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 9,
          climb_id: 1,
          iteration_number: 1,
          proposed_change: 'Add stronger story opportunities section',
          score: null,
          created_at: '2026-06-04T12:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          event_type: 'tool_call',
          payload: { tool_name: 'get_story_opportunities', success: true },
          created_at: '2026-06-04T12:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
    }));
    vi.doMock('../batch-client.js', () => ({
      submitBatch: vi.fn().mockResolvedValue('batch-123'),
      collectBatch: vi.fn(),
      logBatchUsage: vi.fn(),
    }));
    vi.doMock('../lib/ai-cost-tracker.js', () => ({
      logAiUsage: vi.fn(),
    }));
    vi.doMock('../logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const { scoreClimbIteration } = await import('../handlers/altus-mountaineering.js');
    await scoreClimbIteration({ climb_name: 'morning-digest-v1', iteration_number: 1 });

    const evidenceQuery = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('FROM altus_events'),
    );
    expect(evidenceQuery[0]).toContain('payload');
    expect(evidenceQuery[0]).not.toContain('details');
  });
});

describe('altus-mountaineering — supervisorDecision (TEST_MODE)', () => {
  it('returns test_mode result for keep', async () => {
    process.env.TEST_MODE = 'true';
    const { supervisorDecision } = await import('../handlers/altus-mountaineering.js');
    const result = await supervisorDecision({ climb_name: 'morning-digest-v1', iteration_number: 1, decision: 'keep' });
    expect(result.success).toBe(true);
    expect(result.workspace_restored).toBe(false);
  });
});

describe('altus-mountaineering — peakClimb (TEST_MODE)', () => {
  it('returns test_mode result', async () => {
    process.env.TEST_MODE = 'true';
    const { peakClimb } = await import('../handlers/altus-mountaineering.js');
    const result = await peakClimb({ climb_name: 'morning-digest-v1' });
    expect(result.success).toBe(true);
    expect(result.status).toBe('peaked');
  });
});

describe('altus-mountaineering — CLIMB_SLUG_REGEX', () => {
  it('accepts valid slugs', async () => {
    const { CLIMB_SLUG_REGEX } = await import('../handlers/altus-mountaineering.js');
    expect(CLIMB_SLUG_REGEX.test('morning-digest-v1')).toBe(true);
    expect(CLIMB_SLUG_REGEX.test('headline-v1')).toBe(true);
    expect(CLIMB_SLUG_REGEX.test('ab')).toBe(true);
  });

  it('rejects invalid slugs', async () => {
    const { CLIMB_SLUG_REGEX } = await import('../handlers/altus-mountaineering.js');
    expect(CLIMB_SLUG_REGEX.test('Invalid')).toBe(false);
    expect(CLIMB_SLUG_REGEX.test('-leading')).toBe(false);
    expect(CLIMB_SLUG_REGEX.test('trailing-')).toBe(false);
    expect(CLIMB_SLUG_REGEX.test('a')).toBe(false);
  });
});
