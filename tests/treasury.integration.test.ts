import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

// Fake treasury + proposal backend. `prop_final` is finalized; others are open.
function fakeBackend(): typeof fetch {
  let executed = 0;
  return async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const search = new URL(typeof input === 'string' ? input : input.toString()).search;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

    if (/^\/api\/orgs\/[^/]+\/treasury$/.test(path) && method === 'GET') return json({ success: true, data: { balance: '1000', currency: 'XRP' } });
    if (/^\/api\/orgs\/[^/]+\/treasury\/spend$/.test(path) && method === 'POST' && search.includes('action=execute')) {
      executed += 1;
      return json({ success: true, data: { executed: true, count: executed } });
    }
    if (/^\/api\/orgs\/[^/]+\/treasury\/spend$/.test(path) && method === 'POST') {
      return json({ success: true, data: { id: 'spend_1', amount: body.amount } }, 201);
    }
    const pid = /^\/api\/proposals\/([^/]+)$/.exec(path);
    if (pid) return json({ success: true, data: { id: pid[1], status: pid[1] === 'prop_final' ? 'closed' : 'active' } });
    return json({ success: false, error: { code: 'NOT_FOUND', message: path } }, 404);
  };
}

async function makeClient(env: Record<string, string> = {}) {
  const { server } = createServer({ config: loadConfig({ TREASURY_APPROVALS_REQUIRED: '2', ...env }), fetchImpl: fakeBackend() });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const raw = res.content.find((c) => c.type === 'text')?.text ?? '{}';
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
    return { data, isError: !!res.isError, raw };
  };
  return { client, server, call };
}

const WALLET = 'rTreasuryActorAddr1234567';

describe('Phase 4 — treasury', () => {
  it('refuses execution without a finalized proposal and enough approvals, then allows it', async () => {
    const { call, client, server } = await makeClient();

    // Request linked to a finalized proposal.
    const req = await call('shadow_create_treasury_request', {
      daoId: 'org1',
      amount: '100',
      recipientAddress: WALLET,
      purpose: 'Pay survey vendor',
      requestedBy: WALLET,
      proposalId: 'prop_final',
    });
    const spendRequestId = req.data.spendRequestId as string;
    expect(spendRequestId).toBe('spend_1');
    expect(req.data.approvalsRequired).toBe(2);

    // No approvals yet -> denied.
    const denied0 = await call('shadow_execute_treasury_payment', { spendRequestId, authorisedBy: WALLET });
    expect(denied0.isError).toBe(true);
    expect(denied0.data.error.code).toBe('TREASURY_DENIED');

    // One approval -> still denied (needs 2).
    await call('shadow_approve_treasury_request', { spendRequestId, approver: 'human-1' });
    const denied1 = await call('shadow_execute_treasury_payment', { spendRequestId, authorisedBy: WALLET });
    expect(denied1.isError).toBe(true);

    // Second DISTINCT approval -> ready; execution allowed.
    const appr = await call('shadow_approve_treasury_request', { spendRequestId, approver: 'human-2' });
    expect(appr.data.ready).toBe(true);
    const ok = await call('shadow_execute_treasury_payment', { spendRequestId, authorisedBy: WALLET });
    expect(ok.isError).toBe(false);
    expect(ok.data.executed).toBe(true);
    expect(ok.data.backend.count).toBe(1);

    // No double-pay: a repeat execute is refused outright (already executed).
    const again = await call('shadow_execute_treasury_payment', { spendRequestId, authorisedBy: WALLET });
    expect(again.isError).toBe(true);
    expect(again.data.error.message).toMatch(/already executed/i);

    await client.close();
    await server.close();
  });

  it('refuses execution when the linked proposal is not finalized', async () => {
    const { call, client, server } = await makeClient();
    const req = await call('shadow_create_treasury_request', {
      daoId: 'org1', amount: '50', recipientAddress: WALLET, purpose: 'x', requestedBy: WALLET, proposalId: 'prop_open',
    });
    const spendRequestId = req.data.spendRequestId as string;
    await call('shadow_approve_treasury_request', { spendRequestId, approver: 'human-1' });
    await call('shadow_approve_treasury_request', { spendRequestId, approver: 'human-2' });
    const denied = await call('shadow_execute_treasury_payment', { spendRequestId, authorisedBy: WALLET });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.message).toMatch(/not finalized/i);
    await client.close();
    await server.close();
  });

  it('refuses execution when no proposal is linked (default requireProposal)', async () => {
    const { call, client, server } = await makeClient();
    const req = await call('shadow_create_treasury_request', {
      daoId: 'org1', amount: '50', recipientAddress: WALLET, purpose: 'x', requestedBy: WALLET,
    });
    const spendRequestId = req.data.spendRequestId as string;
    await call('shadow_approve_treasury_request', { spendRequestId, approver: 'human-1' });
    await call('shadow_approve_treasury_request', { spendRequestId, approver: 'human-2' });
    const denied = await call('shadow_execute_treasury_payment', { spendRequestId, authorisedBy: WALLET });
    expect(denied.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
