import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

const ORGANIZER_SECRET = 'org_SECRET_key_never_leaves_server';

function fakeBackend(): typeof fetch {
  const polls = new Map<string, Record<string, unknown>>();
  return async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/polls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = `poll_${polls.size + 1}`;
      const poll = { id, title: body.title, status: 'draft', tallies: { 0: 0, 1: 0 } };
      polls.set(id, poll);
      return json({ success: true, data: { poll, organizerKey: ORGANIZER_SECRET } });
    }
    const act = /^\/api\/polls\/([^/]+)\/activate$/.exec(path);
    if (act && init?.method === 'POST') {
      const poll = polls.get(act[1]);
      if (poll) poll.status = 'active';
      return poll ? json({ success: true, data: poll }) : json({ success: false, error: { code: 'POLL_NOT_FOUND', message: 'x' } }, 404);
    }
    const m = /^\/api\/polls\/([^/]+)$/.exec(path);
    if (m) {
      const poll = polls.get(m[1]);
      return poll ? json({ success: true, data: poll }) : json({ success: false, error: { code: 'POLL_NOT_FOUND', message: 'x' } }, 404);
    }
    if (path === '/api/polls') return json({ success: true, data: [...polls.values()] });
    return json({ success: false, error: { code: 'NOT_FOUND', message: path } }, 404);
  };
}

async function makeClient(overrides = {}) {
  const config = loadConfig({ RECEIPT_SIGNING_SECRET: 'it-secret', ...overrides });
  const { server } = createServer({ config, fetchImpl: fakeBackend() });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const data = JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}');
    return { data, isError: !!res.isError, raw: res.content.find((c) => c.type === 'text')?.text ?? '' };
  };
  return { client, server, call };
}

describe('MVP end-to-end flow', () => {
  it('discover -> prepare -> authorize -> pay -> verify -> create poll', async () => {
    const { call, client, server } = await makeClient();
    const agentId = 'agent-x';

    const caps = await call('shadow_list_poll_capabilities');
    expect(caps.data.services.some((s: { service: string }) => s.service === 'poll.create')).toBe(true);

    const prep = await call('shadow_prepare_poll', { agentId, pollDraft: { title: 'Fav chain?', kind: 'single', options: ['XRPL', 'ETH'] } });
    expect(prep.data.quote.amountDrops).toBe('1000000');
    expect(prep.data.paymentRequired.accepts[0].scheme).toBe('exact');

    const auth = await call('shadow_request_payment_authorization', { agentId, quote: prep.data.quote });
    expect(auth.data.decision.ok).toBe(true);

    const pay = await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
    expect(pay.data.receipt.txHash).toMatch(/^MOCK/);

    const verify = await call('shadow_verify_payment', { agentId, invoiceId: prep.data.quote.invoiceId });
    expect(verify.data.verified).toBe(true);

    const created = await call('shadow_create_poll', {
      agentId,
      invoiceId: prep.data.quote.invoiceId,
      poll: { title: 'Fav chain?', kind: 'single', options: ['XRPL', 'ETH'] },
    });
    expect(created.data.pollId).toBeTruthy();
    expect(created.data.pollUrl).toContain('/polls/');
    expect(created.data.published).toBe(true);
    expect(created.data.status).toBe('active');

    await client.close();
    await server.close();
  });

  it('never leaks the organizer key in any tool output', async () => {
    const { call, client, server } = await makeClient();
    const agentId = 'agent-y';
    const prep = await call('shadow_prepare_poll', { agentId });
    await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
    const created = await call('shadow_create_poll', { agentId, invoiceId: prep.data.quote.invoiceId, poll: { title: 'Secret test', kind: 'single', options: ['a', 'b'] } });
    const history = await call('shadow_get_payment_history', { agentId });

    for (const raw of [prep.raw, created.raw, history.raw]) {
      expect(raw.includes(ORGANIZER_SECRET)).toBe(false);
    }
    await client.close();
    await server.close();
  });

  it('is idempotent: paying twice does not double-charge and re-creating returns the same poll', async () => {
    const { call, client, server } = await makeClient();
    const agentId = 'agent-z';
    const prep = await call('shadow_prepare_poll', { agentId });
    const pay1 = await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
    const pay2 = await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
    expect(pay1.data.receipt.receiptId).toBe(pay2.data.receipt.receiptId);

    const poll = { title: 'Idem test', kind: 'single', options: ['a', 'b'] } as const;
    const c1 = await call('shadow_create_poll', { agentId, invoiceId: prep.data.quote.invoiceId, poll });
    const c2 = await call('shadow_create_poll', { agentId, invoiceId: prep.data.quote.invoiceId, poll });
    expect(c1.data.pollId).toBe(c2.data.pollId);

    const usage = await call('shadow_get_spending_limits', { agentId });
    expect(usage.data.usageXrp.daily).toBe('1'); // charged exactly once
    await client.close();
    await server.close();
  });

  it('refuses to create a poll for an unpaid invoice', async () => {
    const { call, client, server } = await makeClient();
    const agentId = 'agent-unpaid';
    const prep = await call('shadow_prepare_poll', { agentId });
    const res = await call('shadow_create_poll', { agentId, invoiceId: prep.data.quote.invoiceId, poll: { title: 'nope', kind: 'single', options: ['a', 'b'] } });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('NOT_PAID');
    await client.close();
    await server.close();
  });

  it('enforces human approval for high-value quotes', async () => {
    const { call, client, server } = await makeClient({ POLICY_HUMAN_APPROVAL_XRP: '1', PRICE_POLL_CREATE_XRP: '2' });
    const agentId = 'agent-hi';
    const prep = await call('shadow_prepare_poll', { agentId });
    const auth = await call('shadow_request_payment_authorization', { agentId, quote: prep.data.quote });
    expect(auth.data.decision.ok).toBe(false);
    expect(auth.data.decision.requiresHumanApproval).toBe(true);

    const pay = await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
    expect(pay.isError).toBe(true);
    expect(pay.data.error.code).toBe('APPROVAL_REQUIRED');

    await call('shadow_approve_payment', { invoiceId: prep.data.quote.invoiceId });
    const payOk = await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
    expect(payOk.isError).toBeFalsy();
    await client.close();
    await server.close();
  });
});
