import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';

// Minimal fake of votechain's orgs/proposals surface.
function fakeBackend(): typeof fetch {
  const proposals = new Map<string, Record<string, unknown>>();
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

    if (path === '/api/orgs' && method === 'GET') return json({ success: true, data: [{ id: 'org1', name: 'Research DAO' }] });
    if (path === '/api/orgs/org1' && method === 'GET') return json({ success: true, data: { id: 'org1', name: 'Research DAO', members: [] } });
    if (path === '/api/orgs/org1/members') return json({ success: true, data: [{ walletAddress: 'rA', role: 'admin' }] });
    if (path === '/api/orgs/org1/proposals' && method === 'POST') {
      const id = `prop_${proposals.size + 1}`;
      proposals.set(id, { id, title: body.title, status: 'draft', tally: { yes: 0, no: 0, abstain: 0 } });
      return json({ success: true, data: proposals.get(id) }, 201);
    }
    if (path === '/api/orgs/org1/proposals' && method === 'GET') return json({ success: true, data: [...proposals.values()] });
    const pid = /^\/api\/proposals\/([^/]+)$/.exec(path);
    if (pid) return proposals.get(pid[1]) ? json({ success: true, data: proposals.get(pid[1]) }) : json({ success: false, error: { code: 'PROPOSAL_NOT_FOUND', message: 'x' } }, 404);
    const vote = /^\/api\/proposals\/([^/]+)\/vote$/.exec(path);
    if (vote) {
      const p = proposals.get(vote[1]);
      if (p) (p.tally as Record<string, number>)[body.choice as string] += 1;
      return json({ success: true, data: { voted: true } });
    }
    const status = /^\/api\/proposals\/([^/]+)\/status$/.exec(path);
    if (status) {
      const p = proposals.get(status[1]);
      if (p) p.status = body.action === 'finalize' ? 'closed' : 'active';
      return json({ success: true, data: p });
    }
    return json({ success: false, error: { code: 'NOT_FOUND', message: path } }, 404);
  };
}

async function makeClient() {
  const { server } = createServer({ config: loadConfig({}), fetchImpl: fakeBackend() });
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

describe('Phase 3 — governance', () => {
  it('lists DAOs and members', async () => {
    const { call, client, server } = await makeClient();
    expect((await call('shadow_list_daos')).data[0].id).toBe('org1');
    expect((await call('shadow_list_dao_members', { daoId: 'org1' })).data[0].role).toBe('admin');
    await client.close();
    await server.close();
  });

  it('creates a proposal, votes, and finalizes', async () => {
    const { call, client, server } = await makeClient();
    const wallet = 'rAgentWalletAddr1234567890';
    const created = await call('shadow_create_proposal', { daoId: 'org1', createdBy: wallet, title: 'Fund research', description: 'Pay for a survey' });
    if (!created.data.id) throw new Error(`create_proposal raw: ${created.raw}`);
    const pid = created.data.id as string;
    expect(pid).toMatch(/^prop_/);

    await call('shadow_execute_proposal', { proposalId: pid, action: 'activate' });
    const voted = await call('shadow_cast_vote', { proposalId: pid, walletAddress: wallet, choice: 'yes' });
    expect(voted.isError).toBe(false);

    const status = await call('shadow_get_vote_status', { proposalId: pid });
    expect(status.data.tally.yes).toBe(1);

    const fin = await call('shadow_execute_proposal', { proposalId: pid, action: 'finalize' });
    expect(fin.data.status).toBe('closed');
    await client.close();
    await server.close();
  });
});
