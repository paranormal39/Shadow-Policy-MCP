/**
 * Random poll generator — creates a different poll on every run, no LLM needed.
 *
 * Runs the real paid flow (quote -> authorize -> mock x402 payment -> create +
 * publish) through the operations layer. By default it uses the mock facilitator
 * and an in-memory fake backend so it works fully offline. Point it at a live
 * Shadow Labz instance to create REAL polls:
 *
 *   SHADOWLABZ_BASE_URL=http://localhost:3000 SHADOWLABZ_API_KEY=sdk_... \
 *     LIVE=1 npm run poll:random
 */
import { buildContext } from '../../src/server/context.js';
import { loadConfig } from '../../src/config/index.js';
import { ShadowLabzClient } from '../../src/integrations/shadowlabz/client.js';
import { getQuote, requestAuthorization, executePayment, createPollForOrder } from '../../src/services/operations.js';

const SUBJECTS = [
  { topic: 'favourite programming language', options: ['TypeScript', 'Python', 'Rust', 'Go'] },
  { topic: 'best layer-1 blockchain', options: ['XRPL', 'Ethereum', 'Solana', 'Bitcoin', 'Cardano'] },
  { topic: 'preferred AI coding assistant', options: ['Claude', 'GPT', 'Gemini', 'Local model'] },
  { topic: 'ideal remote-work schedule', options: ['Fully remote', 'Hybrid', 'In office'] },
  { topic: 'favourite database', options: ['Postgres', 'SQLite', 'MongoDB', 'Redis'] },
  { topic: 'most exciting frontier in AI', options: ['Agents', 'Reasoning', 'Multimodal', 'Robotics'] },
  { topic: 'how teams should run standups', options: ['Daily sync', 'Async written', 'Twice weekly', 'None'] },
  { topic: 'best way to learn a new stack', options: ['Build a project', 'Read docs', 'Courses', 'Pairing'] },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Offline fake backend (used unless LIVE=1 with a real SHADOWLABZ_BASE_URL).
function fakeBackend(): typeof fetch {
  const polls = new Map<string, Record<string, unknown>>();
  return async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (path === '/api/polls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const id = `poll_${polls.size + 1}`;
      polls.set(id, { id, title: body.title, status: 'draft', options: body.options, tallies: [], totalVotes: 0 });
      return json({ success: true, data: { poll: polls.get(id), organizerKey: 'org_SECRET' } });
    }
    const act = /^\/api\/polls\/([^/]+)\/activate$/.exec(path);
    if (act && init?.method === 'POST') {
      const p = polls.get(act[1]);
      if (p) p.status = 'active';
      return json({ success: true, data: p });
    }
    const m = /^\/api\/polls\/([^/]+)$/.exec(path);
    if (m) return polls.get(m[1]) ? json({ success: true, data: polls.get(m[1]) }) : json({ success: false, error: { code: 'POLL_NOT_FOUND', message: 'x' } }, 404);
    return json({ success: false, error: { code: 'NOT_FOUND', message: path } }, 404);
  };
}

async function main() {
  const live = process.env.LIVE === '1';
  const config = loadConfig();
  const ctx = live
    ? buildContext({ config }) // real backend from SHADOWLABZ_BASE_URL
    : buildContext({ config, shadowlabz: new ShadowLabzClient({ baseUrl: config.shadowlabz.baseUrl, apiKey: config.shadowlabz.apiKey, fetchImpl: fakeBackend() }) });

  const subject = pick(SUBJECTS);
  const openers = ['What is your', 'Which do you prefer:', 'Tell us your', 'Vote:'];
  const poll = {
    title: `Poll: ${subject.topic}`.slice(0, 120),
    description: `${pick(openers)} ${subject.topic}?`,
    kind: 'single' as const,
    options: subject.options,
  };

  const agentId = `random-poll-${Date.now()}`;
  console.log(`[random-poll] ${live ? 'LIVE' : 'OFFLINE (mock backend)'} — topic: "${subject.topic}"`);

  const { quote } = getQuote(ctx, agentId, 'poll.create', 'poll.create');
  requestAuthorization(ctx, agentId, quote);
  await executePayment(ctx, { agentId, quote, simulate: true });
  const created = await createPollForOrder(ctx, agentId, quote.invoiceId, poll, true);

  console.log(`\nCreated poll "${poll.title}"`);
  console.log(`  options : ${poll.options.join(', ')}`);
  console.log(`  status  : ${created.status}`);
  console.log(`  pollId  : ${created.pollId}`);
  console.log(`  URL     : ${created.pollUrl}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
