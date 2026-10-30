import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext } from '../src/server/context.js';
import { createMcpServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

/** Fake votechain recording member enrolments. */
function fakeBackend(members: Array<Record<string, unknown>>): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const m = /^\/api\/orgs\/([^/]+)\/members$/.exec(url.pathname);
    if (m && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      members.push({ org: m[1], ...body });
      return json({ success: true, data: { ...body, joined: true } }, 201);
    }
    return json({ success: false, error: { code: 'NOT_FOUND', message: url.pathname } }, 404);
  };
}

async function connect(ctx: ReturnType<typeof buildContext>) {
  const server = createMcpServer(ctx);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    return { data: JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}'), isError: !!res.isError };
  };
  return { server, client, call };
}

describe('auto-invite to Legion on registration', () => {
  it('enrols the token-bound wallet into the configured Legion DAO', async () => {
    const members: Array<Record<string, unknown>> = [];
    const config = loadConfig({ RECEIPT_SIGNING_SECRET: 's', LEGION_ORG_ID: 'legion1' });
    const base = buildContext({ config, fetchImpl: fakeBackend(members) });
    const ctx = { ...base, callerAgentId: 'rScout', callerWallet: 'rScout', callerChain: 'xrpl' };
    const { server, client, call } = await connect(ctx);

    const res = await call('shadow_register_agent', { agentId: 'ignored', capabilities: ['research'] });
    expect(res.data.legion.enrolled).toBe(true);
    expect(res.data.legion.orgId).toBe('legion1');
    expect(members).toEqual([{ org: 'legion1', walletAddress: 'rScout', chain: 'xrpl', role: 'member' }]);

    await client.close();
    await server.close();
  });

  it('reports not-enrolled when the token has no wallet bound', async () => {
    const members: Array<Record<string, unknown>> = [];
    const config = loadConfig({ RECEIPT_SIGNING_SECRET: 's', LEGION_ORG_ID: 'legion1' });
    const base = buildContext({ config, fetchImpl: fakeBackend(members) });
    const ctx = { ...base, callerAgentId: 'rScout' };
    const { server, client, call } = await connect(ctx);

    const res = await call('shadow_register_agent', { agentId: 'rScout' });
    expect(res.isError).toBe(false); // registration still succeeds
    expect(res.data.legion.enrolled).toBe(false);
    expect(members).toHaveLength(0);

    await client.close();
    await server.close();
  });
});
