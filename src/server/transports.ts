/**
 * Transports. stdio for local/desktop MCP clients; Streamable HTTP for remote /
 * cloud agents. The HTTP transport can require a bearer token (HTTP_AUTH_TOKENS).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeLog } from '../security/secrets.js';
import type { ShadowPolicyConfig } from '../config/index.js';

export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  safeLog.info('shadow-policy-mcp listening on stdio');
}

function bearerOk(req: IncomingMessage, tokens: string[]): boolean {
  if (tokens.length === 0) return true; // auth disabled
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return !!match && tokens.includes(match[1].trim());
}

export async function startHttp(server: McpServer, config: ShadowPolicyConfig): Promise<void> {
  // Stateless mode: a fresh transport per request keeps the server simple and
  // avoids cross-agent session leakage.
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!bearerOk(req, config.httpAuthTokens)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
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
  safeLog.info(`shadow-policy-mcp listening on http://127.0.0.1:${config.httpPort}/mcp`);
}
