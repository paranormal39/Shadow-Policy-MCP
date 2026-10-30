import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext } from '../src/server/context.js';
import { createMcpServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

/** Fake votechain that records the proposal-create body + the path it was posted to. */
function fakeBackend(captured: { path?: string; body?: Record<string, unknown> }): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (/\/api\/orgs\/[^/]+\/proposals$/.test(url.pathname) && init?.method === 'POST') {
      captured.path = url.pathname;
      captured.body = JSON.parse(String(init.body));
      return json({ success: true, data: { id: 'prop_1', ...captured.body } }, 201);
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

describe('actor-wallet binding', () => {
  it('overrides a spoofed wallet with the token-bound caller wallet', async () => {
    const captured: { path?: string; body?: Record<string, unknown> } = {};
    const config = loadConfig({ RECEIPT_SIGNING_SECRET: 's', LEGION_ORG_ID: 'legion1' });
    const base = buildContext({ config, fetchImpl: fakeBackend(captured) });
    const ctx = { ...base, callerAgentId: 'rAlice', callerWallet: 'rAlice', callerChain: 'xrpl' };
    const { server, client, call } = await connect(ctx);

    // Caller tries to create a proposal AS someone else, and omits daoId.
    const res = await call('shadow_create_proposal', { createdBy: 'rMallory', title: 'Grab funds', description: 'x' });
    expect(res.isError).toBe(false);
    // Bound to the caller's wallet, not the spoofed one…
    expect(captured.body?.createdBy).toBe('rAlice');
    // …and routed to the configured Legion org.
    expect(captured.path).toBe('/api/orgs/legion1/proposals');

    await client.close();
    await server.close();
  });

  it('refuses wallet-addressed actions when the token has no wallet bound', async () => {
    const captured: { path?: string; body?: Record<string, unknown> } = {};
    const config = loadConfig({ RECEIPT_SIGNING_SECRET: 's', LEGION_ORG_ID: 'legion1' });
    const base = buildContext({ config, fetchImpl: fakeBackend(captured) });
    // Authenticated caller but no wallet on the token.
    const ctx = { ...base, callerAgentId: 'rAlice' };
    const { server, client, call } = await connect(ctx);

    const res = await call('shadow_create_proposal', { createdBy: 'rAlice', title: 'A proposal', description: 'x' });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('WALLET_REQUIRED');

    await client.close();
    await server.close();
  });
});
