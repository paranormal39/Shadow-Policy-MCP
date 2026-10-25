import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

function fakeBackend(): typeof fetch {
  const polls = new Map<string, Record<string, unknown>>();
  return async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/polls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = `poll_${polls.size + 1}`;
      polls.set(id, { id, title: body.title, status: 'draft', options: body.options, tallies: [3, 1], totalVotes: 4 });
      return json({ success: true, data: { poll: polls.get(id), organizerKey: 'org_SECRET' } });
    }
    const act = /^\/api\/polls\/([^/]+)\/activate$/.exec(path);
    if (act && init?.method === 'POST') {
      const poll = polls.get(act[1]);
      if (poll) poll.status = 'active';
      return json({ success: true, data: poll });
    }
    const vote = /^\/api\/polls\/([^/]+)\/vote$/.exec(path);
    if (vote && init?.method === 'POST') return json({ success: true, data: { voted: true } });
    const m = /^\/api\/polls\/([^/]+)$/.exec(path);
    if (m) return polls.get(m[1]) ? json({ success: true, data: polls.get(m[1]) }) : json({ success: false, error: { code: 'POLL_NOT_FOUND', message: 'x' } }, 404);
    return json({ success: false, error: { code: 'NOT_FOUND', message: path } }, 404);
  };
}

async function makeClient() {
  const config = loadConfig({ RECEIPT_SIGNING_SECRET: 'mkt-secret' });
  const { server } = createServer({ config, fetchImpl: fakeBackend() });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    return { data: JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}'), isError: !!res.isError };
  };
  return { client, server, call };
}

async function createPaidPoll(call: (n: string, a?: Record<string, unknown>) => Promise<{ data: any }>, agentId: string, audience: 'public' | 'agents') {
  const prep = await call('shadow_prepare_poll', { agentId });
  await call('shadow_execute_payment', { agentId, quote: prep.data.quote, simulate: true });
  const created = await call('shadow_create_poll', { agentId, invoiceId: prep.data.quote.invoiceId, poll: { title: 'Agent survey', kind: 'single', options: ['A', 'B'] }, audience });
  return created.data.pollId as string;
}

describe('Phase 2 — research marketplace', () => {
  it('registers, lists, and gets an agent with a pairwise DID', async () => {
    const { call, client, server } = await makeClient();
    const reg = await call('shadow_register_agent', { agentId: 'a1', capabilities: ['research'], roles: ['respondent'] });
    expect(reg.data.pairwiseDid).toMatch(/^did:/);
    const list = await call('shadow_list_agents');
    expect(list.data.length).toBe(1);
    const got = await call('shadow_get_agent', { agentId: 'a1' });
    expect(got.data.found).toBe(true);
    await client.close();
    await server.close();
  });

  it('restricts agent-audience surveys to registered agents', async () => {
    const { call, client, server } = await makeClient();
    const pollId = await createPaidPoll(call, 'requester-1', 'agents');

    const denied = await call('shadow_submit_poll_response', { pollId, answers: [[0]], agentId: 'ghost' });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe('AGENT_NOT_REGISTERED');

    await call('shadow_register_agent', { agentId: 'resp-1', capabilities: ['research'] });
    const ok = await call('shadow_submit_poll_response', { pollId, answers: [[0]], agentId: 'resp-1' });
    expect(ok.data.respondentType).toBe('agent');
    await client.close();
    await server.close();
  });

  it('requires data-use consent and returns analytics + provenance on purchase', async () => {
    const { call, client, server } = await makeClient();
    const pollId = await createPaidPoll(call, 'requester-2', 'public');
    // one agent response for provenance
    await call('shadow_register_agent', { agentId: 'resp-2' });
    await call('shadow_submit_poll_response', { pollId, answers: [[0]], agentId: 'resp-2' });

    const quote = await call('shadow_get_payment_quote', { agentId: 'requester-2', service: 'results.purchase', resource: `poll:${pollId}:results` });
    await call('shadow_execute_payment', { agentId: 'requester-2', quote: quote.data.quote, simulate: true });

    const denied = await call('shadow_purchase_poll_results', { agentId: 'requester-2', invoiceId: quote.data.quote.invoiceId, dataUseConsent: false });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe('CONSENT_REQUIRED');

    const released = await call('shadow_purchase_poll_results', { agentId: 'requester-2', invoiceId: quote.data.quote.invoiceId, dataUseConsent: true });
    expect(released.data.analytics.totalVotes).toBe(4);
    expect(released.data.analytics.options[0].percent).toBe(75);
    expect(released.data.analytics.provenance.proxiedByAgents).toBe(1);
    await client.close();
    await server.close();
  });
});
