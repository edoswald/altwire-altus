import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadWriter(query) {
  const client = { query, release: vi.fn() };
  const connect = vi.fn().mockResolvedValue(client);
  vi.doMock('../lib/altus-db.js', () => ({ default: { connect } }));
  const writer = await import('../lib/altus-primary-reflection-memory.js');
  return { ...writer, client, connect };
}

describe('Altus primary reflection writer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('fails closed before connecting when no primary admin is configured', async () => {
    const { appendPrimaryReflectionWin, connect } = await loadWriter(vi.fn());

    await expect(appendPrimaryReflectionWin({ winText: 'Completed: secure the CMS' }))
      .resolves.toEqual({ success: false, exit_reason: 'primary_admin_unconfigured' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('writes wins only to the configured primary admin envelope', async () => {
    vi.stubEnv('HAL_PRIMARY_ADMIN_ID', '7');
    const query = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'altwire-editorial' }] })
      .mockResolvedValueOnce({}) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // canonical read
      .mockResolvedValueOnce({ rows: [{ value: '["Completed: prior win"]' }] }) // legacy read
      .mockResolvedValueOnce({ rows: [{ version: 1, updated_at: '2026-09-19T00:00:00.000Z' }] }) // INSERT
      .mockResolvedValueOnce({}); // COMMIT
    const { appendPrimaryReflectionWin } = await loadWriter(query);

    const result = await appendPrimaryReflectionWin({ winText: 'Completed: secure the CMS' });

    expect(result).toMatchObject({ success: true, status: 'created', key: 'hal:mem:7:reflection:wins' });
    const [insertSql, params] = query.mock.calls[5];
    expect(insertSql).toContain("scope, memory_type, source");
    expect(params[0]).toBe('hal:mem:7:reflection:wins');
    expect(params[2]).toBe('altwire-editorial');
    expect(params[1]).toContain('Completed: prior win');
    expect(params[1]).toContain('Completed: secure the CMS');
  });

  it('does not overwrite a primary record owned by a different tenant', async () => {
    vi.stubEnv('HAL_PRIMARY_ADMIN_ID', '7');
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'altwire-editorial' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ value: '[]', tenant_id: 'another-tenant', version: 2 }] })
      .mockResolvedValueOnce({}); // ROLLBACK
    const { appendPrimaryReflectionWin } = await loadWriter(query);

    await expect(appendPrimaryReflectionWin({ winText: 'Completed: no overwrite' }))
      .resolves.toEqual({ success: false, exit_reason: 'tenant_mismatch' });
    expect(query.mock.calls.map(([sql]) => sql)).not.toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO agent_memory')]));
  });
});
