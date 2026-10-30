import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext, type ServerContext } from '../src/server/context.js';
import { createMcpServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

type Choice = 'yes' | 'no' | 'abstain';
type Vote = { walletAddress: string; choice: Choice };
const proposalId = 'prop_1';
const alice = 'rAliceWallet';
const bob = 'rBobWallet';
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

/** Records votes independently of responses so response loss can follow a durable write. */
function fakeBackend(options: {
  timeout?: 'before' | 'after';
  acknowledgement?: () => Response;
  rejection?: { code: string; status: number };
} = {}) {
  const votes = new Map<string, Map<string, Choice>>([[proposalId, new Map()]]);
  const requests: Array<{ path: string; method: string; body?: Vote }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Vote : undefined;
    requests.push({ path, method, body });
    const proposalVotes = votes.get(proposalId)!;
    if (path === `/api/proposals/${proposalId}` && method === 'GET') {
      const tally = { yes: 0, no: 0, abstain: 0 };
      for (const choice of proposalVotes.values()) tally[choice] += 1;
      return json({ success: true, data: { id: proposalId, status: 'active', tally } });
    }
    if (path === `/api/proposals/${proposalId}/vote` && method === 'POST' && body) {
      if (options.timeout === 'before') throw new DOMException('Response timed out', 'TimeoutError');
      if (options.rejection) {
        return json({ success: false, error: { code: options.rejection.code, message: 'Vote rejected' } }, options.rejection.status);
      }
      if (proposalVotes.has(body.walletAddress)) {
        return json({ success: false, error: { code: 'ALREADY_VOTED', message: 'Wallet already voted' } }, 409);
      }
      proposalVotes.set(body.walletAddress, body.choice);
      if (options.timeout === 'after') throw new DOMException('Response timed out', 'TimeoutError');
      return options.acknowledgement?.() ?? json({ success: true, data: { voted: true } });
    }
    return json({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } }, 404);
  };
  return { fetchImpl, votes, requests };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function connect(backend: ReturnType<typeof fakeBackend>, identity: Partial<ServerContext> = {
  callerAgentId: 'agent-alice', callerWallet: alice,
}) {
  const base = buildContext({ config: loadConfig({ RECEIPT_SIGNING_SECRET: 'test' }), fetchImpl: backend.fetchImpl });
  const server = createMcpServer({ ...base, ...identity });
  const client = new Client({ name: 'governance-voting-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const data = JSON.parse(content.find((item) => item.type === 'text')?.text ?? '{}');
    return { data, isError: !!result.isError };
  };
}

describe('governance vote acknowledgement and verification', () => {
  it('submits once as the token-bound wallet and returns only the acknowledgement', async () => {
    const backend = fakeBackend({ acknowledgement: () => json({
      success: true, data: { voted: true, walletAddress: alice, choice: 'yes', voters: [alice] },
    }) });
    const call = await connect(backend);
    const result = await call('shadow_cast_vote', { proposalId, walletAddress: bob, choice: 'yes' });

    expect(result).toEqual({ isError: false, data: { voted: true } });
    expect(backend.requests).toEqual([{
      path: `/api/proposals/${proposalId}/vote`, method: 'POST', body: { walletAddress: alice, choice: 'yes' },
    }]);
    expect([...backend.votes.get(proposalId)!]).toEqual([[alice, 'yes']]);
  });

  it('preserves ALREADY_VOTED without claiming the newly requested choice was accepted', async () => {
    const backend = fakeBackend();
    backend.votes.get(proposalId)!.set(alice, 'no');
    const call = await connect(backend);
    const result = await call('shadow_cast_vote', { proposalId, walletAddress: alice, choice: 'yes' });

    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('ALREADY_VOTED');
    expect(result.data.error.message).toMatch(/choice/i);
    expect(result.data.voted).toBeUndefined();
    expect(backend.votes.get(proposalId)!.get(alice)).toBe('no');
    expect(backend.requests).toHaveLength(1);
  });

  it('keeps aggregate status readable without treating another wallet’s vote as participation', async () => {
    const backend = fakeBackend();
    backend.votes.get(proposalId)!.set(bob, 'yes');
    const call = await connect(backend);
    expect(await call('shadow_get_vote_status', { proposalId })).toEqual({
      isError: false, data: { id: proposalId, status: 'active', tally: { yes: 1, no: 0, abstain: 0 } },
    });

    const result = await call('shadow_get_my_vote', { proposalId });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('VOTE_VERIFICATION_UNAVAILABLE');
    expect(backend.requests).toHaveLength(1);
    expect(backend.votes.get(proposalId)!.has(alice)).toBe(false);
  });

  it('does not infer a negative participation result or call the backend for verification', async () => {
    const backend = fakeBackend();
    const call = await connect(backend);
    const result = await call('shadow_get_my_vote', { proposalId, walletAddress: bob });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('VOTE_VERIFICATION_UNAVAILABLE');
    expect(result.data.hasVoted).toBeUndefined();
    expect(backend.requests).toEqual([]);
  });

  it('does not turn a previous successful submission into a durable participation lookup', async () => {
    const backend = fakeBackend();
    const call = await connect(backend);
    expect((await call('shadow_cast_vote', { proposalId, walletAddress: alice, choice: 'yes' })).isError).toBe(false);
    const result = await call('shadow_get_my_vote', { proposalId });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('VOTE_VERIFICATION_UNAVAILABLE');
    expect(backend.requests).toHaveLength(1);
  });

  it.each(['shadow_cast_vote', 'shadow_get_my_vote'])(
    'refuses %s for a token without a wallet, even when a wallet is supplied', async (tool) => {
      const backend = fakeBackend();
      const call = await connect(backend, { callerAgentId: 'agent-without-wallet' });
      const result = await call(tool, { proposalId, walletAddress: bob, ...(tool === 'shadow_cast_vote' ? { choice: 'yes' } : {}) });
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe('WALLET_REQUIRED');
      expect(backend.requests).toEqual([]);
    },
  );

  it('requires an explicit wallet for verification in local unauthenticated mode', async () => {
    const backend = fakeBackend();
    const call = await connect(backend, {});
    expect((await call('shadow_get_my_vote', { proposalId })).data.error.code).toBe('WALLET_REQUIRED');
    expect((await call('shadow_get_my_vote', { proposalId, walletAddress: alice })).data.error.code).toBe('VOTE_VERIFICATION_UNAVAILABLE');
    expect(backend.requests).toEqual([]);
  });

  it.each(['before', 'after'] as const)('keeps a timeout %s commitment unknown during recovery without resubmitting', async (timeout) => {
    const backend = fakeBackend({ timeout });
    const call = await connect(backend);
    const submitted = await call('shadow_cast_vote', { proposalId, walletAddress: alice, choice: 'yes' });
    expect(submitted.isError).toBe(true);
    expect(submitted.data.error.code).toBe('VOTE_OUTCOME_UNKNOWN');
    expect(backend.votes.get(proposalId)!.has(alice)).toBe(timeout === 'after');

    const recovered = await call('shadow_get_my_vote', { proposalId });
    expect(recovered.isError).toBe(true);
    expect(recovered.data.error.code).toBe('VOTE_VERIFICATION_UNAVAILABLE');
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0].method).toBe('POST');
  });

  it.each([
    ['empty body', () => new Response(null, { status: 204 })],
    ['invalid JSON', () => new Response('{', { status: 200 })],
    ['missing acknowledgement', () => json({ success: true, data: {} })],
    ['negative acknowledgement', () => json({ success: true, data: { voted: false } })],
    ['string acknowledgement', () => json({ success: true, data: { voted: 'true' } })],
    ['null data', () => json({ success: true, data: null })],
    ['array data', () => json({ success: true, data: [{ voted: true }] })],
    ['server failure', () => json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed after write' } }, 500)],
    ['response body loss', () => {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('Response body timed out', 'TimeoutError')); },
      }), { status: 200 });
    }],
  ] as const)('reports %s after submission as unknown, never success or a retry', async (_name, acknowledgement) => {
    const backend = fakeBackend({ acknowledgement });
    const call = await connect(backend);
    const result = await call('shadow_cast_vote', { proposalId, walletAddress: alice, choice: 'yes' });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe('VOTE_OUTCOME_UNKNOWN');
    expect(backend.votes.get(proposalId)!.get(alice)).toBe('yes');
    expect(backend.requests).toHaveLength(1);
  });

  it.each([
    { code: 'PROPOSAL_FORBIDDEN', status: 403 },
    { code: 'PROPOSAL_NOT_FOUND', status: 404 },
    { code: 'PROPOSAL_STATE', status: 409 },
    { code: 'RATE_LIMITED', status: 429 },
  ])('preserves the definite rejection $code without recording or retrying a vote', async (rejection) => {
    const backend = fakeBackend({ rejection });
    const call = await connect(backend);
    const result = await call('shadow_cast_vote', { proposalId, walletAddress: alice, choice: 'yes' });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe(rejection.code);
    expect(backend.votes.get(proposalId)!.size).toBe(0);
    expect(backend.requests).toHaveLength(1);
  });
});
