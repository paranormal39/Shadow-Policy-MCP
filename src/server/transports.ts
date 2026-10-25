/**
 * Transports. stdio for local/desktop MCP clients; Streamable HTTP for remote /
 * cloud agents (the shared "Legion" endpoint).
 *
 * On HTTP, each request is authenticated and bound to an agent identity:
 *   - if AGENT_TOKENS / the token file are configured, a valid bearer resolves
 *     to a fixed agentId (ctx.callerAgentId) — the body's agentId is ignored;
 *   - else if HTTP_AUTH_TOKENS is set, those act as a coarse access gate (no
 *     identity binding);
 *   - else the endpoint is open (local dev only).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeLog } from '../security/secrets.js';
import { createMcpServer } from './index.js';
import type { ServerContext } from './context.js';

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

export async function startHttp(ctx: ServerContext): Promise<void> {
  const { config, tokens } = ctx;
  const identityAuth = tokens.size() > 0;
  const gateTokens = config.httpAuthTokens;

  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }

    const bearer = bearerOf(req);
    let callerAgentId: string | undefined;

    if (identityAuth) {
      const identity = bearer ? tokens.resolve(bearer) : null;
      if (!identity) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', message: 'A valid agent token is required (Authorization: Bearer <token>).' }));
        return;
      }
      callerAgentId = identity.agentId;
    } else if (gateTokens.length > 0) {
      if (!bearer || !gateTokens.includes(bearer)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    try {
      // Per-request server bound to the authenticated caller; shares the base
      // context's stores so all agents see one registry / treasury / ledger.
      const reqCtx: ServerContext = callerAgentId ? { ...ctx, callerAgentId } : ctx;
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
    auth: identityAuth ? `token-identity (${tokens.size()} tokens)` : gateTokens.length ? 'shared-gate' : 'open (dev)',
  });
}
