import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TokenRegistry } from '../src/services/tokens/index.js';
import { buildContext } from '../src/server/context.js';
import { createMcpServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

describe('TokenRegistry', () => {
  it('resolves env tokens to identities and rejects unknown', () => {
    const reg = TokenRegistry.load({ envTokens: 'tokA:alice,tokB:bob:Bob' });
    expect(reg.size()).toBe(2);
    expect(reg.resolve('tokA')?.agentId).toBe('alice');
    expect(reg.resolve('tokB')?.agentId).toBe('bob');
    expect(reg.resolve('nope')).toBeNull();
  });
});

describe('token -> identity binding', () => {
  it('ignores a spoofed agentId and binds to the authenticated caller', async () => {
    const config = loadConfig({ RECEIPT_SIGNING_SECRET: 'auth-secret' });
    const base = buildContext({ config });
    // Simulate an authenticated request for caller "alice".
    const reqCtx = { ...base, callerAgentId: 'alice' };
    const server = createMcpServer(reqCtx);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }> };
      return JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}');
    };

    // Caller claims to be "mallory" — must be overridden to "alice".
    const prep = await call('shadow_prepare_poll', { agentId: 'mallory' });
    expect(prep.quote.agentId).toBe('alice');

    // History is the caller's, regardless of the agentId argument.
    const history = await call('shadow_get_payment_history', { agentId: 'mallory' });
    expect(Array.isArray(history)).toBe(true);
    expect(history.every((o: { agentId: string }) => o.agentId === 'alice')).toBe(true);

    await client.close();
    await server.close();
  });
});
