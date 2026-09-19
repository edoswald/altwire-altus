import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryRow(overrides = {}) {
  return {
    agent: 'hal',
    key: 'hal:altwire:editorial_context',
    value: '{"voice":"direct"}',
    tenant_id: null,
    scope: 'shared',
    memory_type: 'editorial_context',
    source: 'altus',
    source_id: 'test-writer',
    provenance: { source: 'altus' },
    value_digest: 'a'.repeat(64),
    version: 1,
    confidence: 1,
    expires_at: null,
    updated_at: '2026-09-19T00:00:00.000Z',
    ...overrides,
  };
}

async function loadPublisher(query) {
  const client = { query, release: vi.fn() };
  const connect = vi.fn().mockResolvedValue(client);
  vi.doMock('../lib/altus-db.js', () => ({ default: { connect } }));
  const publisher = await import('../lib/altus-hal-memory-publisher.js');
  return { ...publisher, client, connect };
}

describe('Altus governed shared Hal publisher', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts only canonical hal:altwire keys before opening a database connection', async () => {
    const query = vi.fn();
    const { publishAltwireHalMemory, connect } = await loadPublisher(query);

    await expect(publishAltwireHalMemory({ key: 'hal:soul:altwire', value: 'nope' }))
      .rejects.toMatchObject({ code: 'altwire_hal_memory_key_not_allowed' });
    await expect(publishAltwireHalMemory({ key: 'reflection:wins', value: 'nope' }))
      .rejects.toMatchObject({ code: 'altwire_hal_memory_key_not_allowed' });
    await expect(publishAltwireHalMemory({ key: 'hal:altwire:', value: 'nope' }))
      .rejects.toMatchObject({ code: 'altwire_hal_memory_key_not_allowed' });

    expect(connect).not.toHaveBeenCalled();
  });

  it('creates a shared envelope with canonical Altus provenance and a digest', async () => {
    const row = memoryRow({
      value: '{"voice":"direct"}',
      value_digest: 'b'.repeat(64),
    });
    const query = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [row] }) // INSERT
      .mockResolvedValueOnce({}); // COMMIT
    const { publishAltwireHalMemory, client } = await loadPublisher(query);

    const result = await publishAltwireHalMemory({
      key: 'hal:altwire:editorial_context',
      value: { voice: 'direct' },
      memoryType: 'editorial_context',
      sourceId: 'test-writer',
      confidence: 0.9,
      provenance: { run: 'unit' },
    });

    expect(result.status).toBe('created');
    expect(result.row).toMatchObject({
      key: 'hal:altwire:editorial_context',
      tenantId: null,
      scope: 'shared',
      source: 'altus',
      sourceId: 'test-writer',
    });
    const [insertSql, params] = query.mock.calls[3];
    expect(insertSql).toContain("scope, memory_type, source");
    expect(params.slice(0, 4)).toEqual([
      'hal:altwire:editorial_context',
      '{"voice":"direct"}',
      'editorial_context',
      'test-writer',
    ]);
    expect(JSON.parse(params[4])).toMatchObject({
      run: 'unit',
      source: 'altus',
      source_id: 'test-writer',
      publisher: 'altus-governed-hal-publisher',
    });
    expect(params[5]).toMatch(/^[a-f0-9]{64}$/);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('repairs a legacy shared row through a governed update', async () => {
    const legacy = memoryRow({
      scope: 'legacy',
      memory_type: 'legacy',
      source: 'legacy',
      source_id: null,
      provenance: {},
      value_digest: null,
      version: 1,
    });
    const repaired = memoryRow({ version: 2, value_digest: 'c'.repeat(64) });
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [legacy] })
      .mockResolvedValueOnce({ rows: [repaired] })
      .mockResolvedValueOnce({});
    const { publishAltwireHalMemory } = await loadPublisher(query);

    const result = await publishAltwireHalMemory({
      key: legacy.key,
      value: { refreshed: true },
      sourceId: 'legacy-repair-test',
    });

    expect(result.status).toBe('updated');
    const [updateSql] = query.mock.calls[3];
    expect(updateSql).toContain("scope = 'shared'");
    expect(updateSql).toContain("source = 'altus'");
    expect(updateSql).toContain('COALESCE(version, 0) + 1');
  });

  it('returns stale for a mismatched snapshot without issuing an update', async () => {
    const current = memoryRow({ version: 4, value_digest: 'd'.repeat(64) });
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({}); // ROLLBACK
    const { publishAltwireHalMemory } = await loadPublisher(query);

    const result = await publishAltwireHalMemory({
      key: current.key,
      value: 'new value',
      expectedVersion: 3,
    });

    expect(result).toMatchObject({ status: 'stale', priorVersion: 4, priorDigest: 'd'.repeat(64) });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[3][0]).toBe('ROLLBACK');
  });

  it('preserves an existing seed when ifAbsent is set', async () => {
    const current = memoryRow({ key: 'hal:altwire:digest_format' });
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({}); // COMMIT
    const { publishAltwireHalMemory } = await loadPublisher(query);

    const result = await publishAltwireHalMemory({
      key: current.key,
      value: { sections: [] },
      ifAbsent: true,
    });

    expect(result.status).toBe('exists');
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[3][0]).toBe('COMMIT');
  });

  it('joins a caller-owned transaction without committing or releasing it', async () => {
    const row = memoryRow({ value_digest: 'e'.repeat(64) });
    const query = vi.fn()
      .mockResolvedValueOnce({}) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [row] }); // INSERT
    const { publishAltwireHalMemory, client } = await loadPublisher(query);

    const result = await publishAltwireHalMemory({
      key: row.key,
      value: 'transactional write',
    }, { client });

    expect(result.status).toBe('created');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('BEGIN');
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
    expect(client.release).not.toHaveBeenCalled();
  });
});
