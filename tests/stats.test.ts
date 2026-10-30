import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StatsService } from '../src/services/stats/index.js';
import { createServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

describe('StatsService', () => {
  it('aggregates agents, tool calls, and errors', () => {
    const s = new StatsService();
    s.recordAuth('rAlice', 'rAlice');
    s.recordAuth('rAlice', 'rAlice');
    s.recordAuth('rBob', 'rBob');
    s.recordAuthFailure();
    s.recordTool('shadow_list_agents', { agentId: 'rAlice', ok: true, ms: 3 });
    s.recordTool('shadow_cast_vote', { agentId: 'rBob', ok: false, code: 'WALLET_REQUIRED', ms: 1 });

    const snap = s.snapshot();
    expect(snap.agents.total).toBe(2);
    expect(snap.agents.activeNow).toBe(2);
    expect(snap.auth.success).toBe(3);
    expect(snap.auth.failures).toBe(1);
    expect(snap.requests).toBe(2);
    expect(snap.errors).toBe(1);
    expect(snap.errorsByCode.WALLET_REQUIRED).toBe(1);
    expect(snap.tools.find((t) => t.name === 'shadow_list_agents')?.calls).toBe(1);
    // rAlice made two auth-ed requests.
    expect(snap.agents.list.find((a) => a.agentId === 'rAlice')?.requests).toBe(2);
  });
});

describe('tool calls are recorded on the context', () => {
  it('records a tool invocation in ctx.stats', async () => {
    const { server, ctx } = createServer({ config: loadConfig({ RECEIPT_SIGNING_SECRET: 's' }) });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    await client.callTool({ name: 'shadow_list_agents', arguments: {} });

    const snap = ctx.stats.snapshot();
    expect(snap.requests).toBeGreaterThanOrEqual(1);
    expect(snap.tools.some((t) => t.name === 'shadow_list_agents')).toBe(true);

    await client.close();
    await server.close();
  });
});
