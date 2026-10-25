/**
 * Sample agent — demonstrates the full MVP loop over a real MCP connection
 * (in-memory transport), using the mock x402 facilitator and an offline fake
 * Shadow Labz backend so it runs with no external services:
 *
 *   discover -> prepare (quote + PAYMENT-REQUIRED) -> authorize -> pay (x402)
 *            -> verified receipt -> create poll -> poll URL
 *
 * In production you would instead run `shadow-policy-mcp` as a subprocess over
 * stdio (or connect to the HTTP transport) and point it at a live votechain.
 *
 *   npm run example
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/config/index.js';

// ── Offline fake Shadow Labz backend ─────────────────────────────────────────
const polls = new Map<string, Record<string, unknown>>();
const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.toString();
  const path = new URL(url).pathname;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (path === '/api/polls' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    const id = `poll_${polls.size + 1}`;
    const poll = { id, title: body.title, status: 'draft', kind: body.kind, tallies: {} };
    polls.set(id, poll);
    return json({ success: true, data: { poll, organizerKey: 'org_SECRET_key_never_leaves_server' } });
  }
  const actMatch = /^\/api\/polls\/([^/]+)\/activate$/.exec(path);
  if (actMatch && init?.method === 'POST') {
    const poll = polls.get(actMatch[1]);
    if (poll) poll.status = 'active';
    return poll ? json({ success: true, data: poll }) : json({ success: false, error: { code: 'POLL_NOT_FOUND', message: 'x' } }, 404);
  }
  const getMatch = /^\/api\/polls\/([^/]+)$/.exec(path);
  if (getMatch && (!init?.method || init.method === 'GET')) {
    const poll = polls.get(getMatch[1]);
    return poll ? json({ success: true, data: poll }) : json({ success: false, error: { code: 'POLL_NOT_FOUND', message: 'not found' } }, 404);
  }
  if (path === '/api/polls') return json({ success: true, data: [...polls.values()] });
  return json({ success: false, error: { code: 'NOT_FOUND', message: path } }, 404);
};

function parse(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  const data = JSON.parse(text);
  if (result.isError) throw new Error(`tool error: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const config = loadConfig({ ...process.env, FACILITATOR: 'mock', XRPL_NETWORK: 'testnet' });
  const { server } = createServer({ config, fetchImpl: fakeFetch });

  const client = new Client({ name: 'sample-agent', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parse((await client.callTool({ name, arguments: args })) as never);

  const agentId = 'agent-demo-001';
  const log = (label: string, v: unknown) => console.log(`\n=== ${label} ===\n${JSON.stringify(v, null, 2)}`);

  log('1. capabilities', await call('shadow_list_poll_capabilities'));

  const prepared = await call('shadow_prepare_poll', {
    agentId,
    pollDraft: { title: 'Which blockchain do developers prefer?', kind: 'single', options: ['XRPL', 'Ethereum', 'Solana', 'Bitcoin'] },
  });
  log('2. prepared (quote + PAYMENT-REQUIRED)', prepared);

  log('3. authorization', await call('shadow_request_payment_authorization', { agentId, quote: prepared.quote }));

  const paid = await call('shadow_execute_payment', { agentId, quote: prepared.quote, simulate: true });
  log('4. payment receipt', paid.receipt);

  const verify = await call('shadow_verify_payment', { agentId, invoiceId: prepared.quote.invoiceId });
  log('5. verify payment', verify);

  const created = await call('shadow_create_poll', {
    agentId,
    invoiceId: prepared.quote.invoiceId,
    poll: { title: 'Which blockchain do developers prefer?', kind: 'single', options: ['XRPL', 'Ethereum', 'Solana', 'Bitcoin'] },
  });
  log('6. poll created', created);

  // Idempotency: creating again with the same invoice returns the same poll.
  const again = await call('shadow_create_poll', {
    agentId,
    invoiceId: prepared.quote.invoiceId,
    poll: { title: 'Which blockchain do developers prefer?', kind: 'single', options: ['XRPL', 'Ethereum', 'Solana', 'Bitcoin'] },
  });
  console.log(`\nIdempotent re-create returned same poll: ${again.pollId === created.pollId}`);

  console.log(`\nDone. Poll URL: ${created.pollUrl}`);
  await client.close();
  await server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
