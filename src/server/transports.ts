/**
 * Transports. stdio for local/desktop MCP clients; Streamable HTTP for remote /
 * cloud agents (the shared "Legion" endpoint).
 *
 * On HTTP, each request is authenticated and bound to an agent identity:
 *   - if AGENT_TOKENS / the token file are configured, a valid bearer resolves
 *     locally to a fixed identity (agentId + votechain wallet);
 *   - otherwise, when a votechain x-api-key is configured, the bearer (an
 *     `agt_…` dashboard token) is resolved via votechain introspection, cached
 *     briefly. The body's agentId / actor-wallet are always ignored in favour
 *     of the resolved identity;
 *   - else if HTTP_AUTH_TOKENS is set, those act as a coarse access gate (no
 *     identity binding);
 *   - else the endpoint is open (local dev only).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeLog } from '../security/secrets.js';
import { createMcpServer } from './index.js';
import type { ServerContext } from './context.js';
import { hashToken, type TokenIdentity } from '../services/tokens/index.js';

/** How long a resolved (or rejected) introspection result is cached, matching
 *  votechain's own ~30s api-key verification cache. */
const INTROSPECT_TTL_MS = 30_000;

export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  safeLog.info('shadow-policy-mcp listening on stdio');
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** Assemble the dashboard payload: live stats + registry + payment aggregates.
 *  Aggregate only — no tokens, seeds, or organizer keys. */
function buildStats(ctx: ServerContext) {
  const orders = ctx.orders.list();
  const paid = orders.filter((o) => o.status === 'paid' || o.status === 'fulfilled');
  const totalDropsPaid = paid.reduce((sum, o) => sum + Number(o.quote.amountDrops || 0), 0);
  const byStatus: Record<string, number> = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  return {
    ...ctx.stats.snapshot(),
    registry: { registeredAgents: ctx.agents.list().length },
    payments: {
      orders: orders.length,
      paid: paid.length,
      byStatus,
      totalXrpPaid: totalDropsPaid / 1_000_000,
      facilitator: ctx.config.facilitator,
      network: ctx.config.network,
    },
    config: { legionOrgId: ctx.config.legionOrgId, transport: ctx.config.transport },
  };
}

export async function startHttp(ctx: ServerContext): Promise<void> {
  const { config, tokens, shadowlabz } = ctx;
  // Dashboard-issued tokens are resolved via votechain; that needs an x-api-key.
  const introspectEnabled = !!config.shadowlabz.apiKey;
  const identityAuth = tokens.size() > 0 || introspectEnabled;
  const gateTokens = config.httpAuthTokens;

  // Per-process cache of introspection results (keyed by token hash, never the
  // plaintext). Negative results are cached too, so garbage bearers don't
  // hammer votechain on every request.
  const introspectCache = new Map<string, { identity: TokenIdentity | null; exp: number }>();

  async function resolveIdentity(bearer: string): Promise<TokenIdentity | null> {
    // 1) Local tokens (AGENT_TOKENS / token file) take precedence.
    const local = tokens.resolve(bearer);
    if (local) return local;
    if (!introspectEnabled) return null;

    // 2) votechain introspection, cached.
    const key = hashToken(bearer);
    const now = Date.now();
    const hit = introspectCache.get(key);
    if (hit && hit.exp > now) return hit.identity;

    let identity: TokenIdentity | null = null;
    try {
      const r = await shadowlabz.introspectAgentToken(bearer);
      if (r.active && r.walletAddress) {
        identity = { agentId: r.agentId ?? r.walletAddress, walletAddress: r.walletAddress, chain: r.chain, roles: r.roles ?? [] };
      }
    } catch (err) {
      // Fail closed: a backend error means we cannot vouch for the caller. A
      // 401/403 here means the SERVER's SHADOWLABZ_API_KEY is invalid (every
      // agent token will fail until it's fixed) — log it loudly.
      safeLog.error('agent-token introspection failed — check the server SHADOWLABZ_API_KEY', { message: (err as Error).message });
      identity = null;
    }
    introspectCache.set(key, { identity, exp: now + INTROSPECT_TTL_MS });
    return identity;
  }

  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    // Liveness probe (public, no sensitive data) — handy for Railway healthchecks.
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, uptimeSec: Math.floor((Date.now() - ctx.stats.startedAt) / 1000) }));
      return;
    }

    // Gated stats dashboard. Disabled unless DASHBOARD_TOKEN is set.
    if (pathname === '/stats' || pathname === '/dashboard' || pathname === '/') {
      if (!config.dashboardToken) {
        res.writeHead(404).end('Not found');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const supplied = bearerOf(req) ?? url.searchParams.get('token') ?? '';
      if (!constantTimeEquals(supplied, config.dashboardToken)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: 'Dashboard token required (?token= or Authorization: Bearer).' }));
        return;
      }
      if (pathname === '/stats') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(buildStats(ctx), null, 2));
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DASHBOARD_HTML);
      }
      return;
    }

    if (pathname !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }

    const bearer = bearerOf(req);
    let callerAgentId: string | undefined;
    let callerWallet: string | undefined;
    let callerChain: string | undefined;

    if (identityAuth) {
      const identity = bearer ? await resolveIdentity(bearer) : null;
      if (!identity) {
        ctx.stats.recordAuthFailure();
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: 'A valid agent token is required (Authorization: Bearer <token>).' }));
        return;
      }
      callerAgentId = identity.agentId;
      callerWallet = identity.walletAddress;
      callerChain = identity.chain;
      ctx.stats.recordAuth(callerAgentId, callerWallet);
    } else if (gateTokens.length > 0) {
      if (!bearer || !gateTokens.includes(bearer)) {
        ctx.stats.recordAuthFailure();
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    try {
      // Per-request server bound to the authenticated caller; shares the base
      // context's stores so all agents see one registry / treasury / ledger.
      const reqCtx: ServerContext = callerAgentId ? { ...ctx, callerAgentId, callerWallet, callerChain } : ctx;
      const server = createMcpServer(reqCtx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      await server.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      safeLog.error('http request failed', { message: (err as Error).message });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  await new Promise<void>((resolve) => http.listen(config.httpPort, resolve));
  safeLog.info(`shadow-policy-mcp listening on http://0.0.0.0:${config.httpPort}/mcp`, {
    auth: identityAuth
      ? `token-identity (${tokens.size()} local${introspectEnabled ? ' + votechain introspection' : ''})`
      : gateTokens.length ? 'shared-gate' : 'open (dev)',
    dashboard: config.dashboardToken ? `enabled at /dashboard` : 'disabled',
  });
}

/** Self-contained dashboard page. Reads the token from its own query string and
 *  polls /stats every few seconds. No external assets. */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Legion — Shadow Policy MCP</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0b0e14; color:#cdd6f4; }
  header { padding:16px 20px; border-bottom:1px solid #1e2430; display:flex; justify-content:space-between; align-items:center; }
  h1 { font-size:16px; margin:0; color:#89b4fa; }
  .muted { color:#6c7086; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:#11151f; border:1px solid #1e2430; border-radius:10px; padding:14px; }
  .card .n { font-size:26px; color:#a6e3a1; }
  .card .l { color:#6c7086; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  h2 { font-size:13px; color:#f9e2af; text-transform:uppercase; letter-spacing:.05em; margin:22px 0 8px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #1a1f2b; }
  th { color:#6c7086; font-weight:600; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .on { background:#a6e3a1; } .off { background:#45475a; }
  .err { color:#f38ba8; } .ok { color:#a6e3a1; }
  #err { color:#f38ba8; }
</style></head>
<body>
<header><h1>Legion · Shadow Policy MCP</h1><div class="muted"><span id="net"></span> · uptime <span id="uptime"></span> · <span id="clock"></span></div></header>
<main>
  <div id="err"></div>
  <div class="cards">
    <div class="card"><div class="n" id="c-active">–</div><div class="l">Agents active (5m)</div></div>
    <div class="card"><div class="n" id="c-agents">–</div><div class="l">Agents seen</div></div>
    <div class="card"><div class="n" id="c-registered">–</div><div class="l">Registered</div></div>
    <div class="card"><div class="n" id="c-requests">–</div><div class="l">Tool calls</div></div>
    <div class="card"><div class="n err" id="c-errors">–</div><div class="l">Errors</div></div>
    <div class="card"><div class="n" id="c-paid">–</div><div class="l">Paid orders</div></div>
    <div class="card"><div class="n" id="c-xrp">–</div><div class="l">XRP collected</div></div>
    <div class="card"><div class="n err" id="c-authfail">–</div><div class="l">Auth failures</div></div>
  </div>
  <h2>Agents</h2>
  <table><thead><tr><th></th><th>agentId</th><th>wallet</th><th>requests</th><th>last seen</th></tr></thead><tbody id="agents"></tbody></table>
  <h2>Tools</h2>
  <table><thead><tr><th>tool</th><th>calls</th><th>errors</th></tr></thead><tbody id="tools"></tbody></table>
  <h2>Recent activity</h2>
  <table><thead><tr><th>time</th><th>kind</th><th>agent</th><th>tool</th><th>result</th><th>ms</th></tr></thead><tbody id="recent"></tbody></table>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const t = (iso) => iso ? new Date(iso).toLocaleTimeString() : '';
const esc = (s) => String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function tick(){
  try{
    const r = await fetch('/stats?token='+encodeURIComponent(token), {headers:{accept:'application/json'}});
    if(!r.ok){ document.getElementById('err').textContent = 'stats '+r.status+(r.status===401?' — bad or missing ?token=':''); return; }
    document.getElementById('err').textContent='';
    const s = await r.json();
    document.getElementById('net').textContent = (s.payments?.network||'')+' · '+(s.payments?.facilitator||'');
    document.getElementById('uptime').textContent = s.uptimeSec+'s';
    document.getElementById('clock').textContent = new Date().toLocaleTimeString();
    document.getElementById('c-active').textContent = s.agents.activeNow;
    document.getElementById('c-agents').textContent = s.agents.total;
    document.getElementById('c-registered').textContent = s.registry.registeredAgents;
    document.getElementById('c-requests').textContent = s.requests;
    document.getElementById('c-errors').textContent = s.errors;
    document.getElementById('c-paid').textContent = s.payments.paid;
    document.getElementById('c-xrp').textContent = s.payments.totalXrpPaid;
    document.getElementById('c-authfail').textContent = s.auth.failures;
    document.getElementById('agents').innerHTML = s.agents.list.map(a =>
      '<tr><td><span class="dot '+(a.active?'on':'off')+'"></span></td><td>'+esc(a.agentId)+'</td><td class="muted">'+esc(a.wallet||'—')+'</td><td>'+a.requests+'</td><td class="muted">'+t(a.lastSeen)+'</td></tr>').join('');
    document.getElementById('tools').innerHTML = s.tools.map(x =>
      '<tr><td>'+esc(x.name)+'</td><td>'+x.calls+'</td><td class="'+(x.errors?'err':'')+'">'+x.errors+'</td></tr>').join('');
    document.getElementById('recent').innerHTML = s.recent.map(e =>
      '<tr><td class="muted">'+t(new Date(e.at).toISOString())+'</td><td>'+esc(e.kind)+'</td><td class="muted">'+esc(e.agentId||'')+'</td><td>'+esc(e.tool||'')+'</td><td class="'+(e.kind==='tool'?(e.ok?'ok':'err'):'')+'">'+(e.kind==='tool'?(e.ok?'ok':esc(e.code||'error')):'')+'</td><td class="muted">'+(e.ms??'')+'</td></tr>').join('');
  }catch(e){ document.getElementById('err').textContent = String(e); }
}
tick(); setInterval(tick, 4000);
</script>
</body></html>`;
