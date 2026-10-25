/**
 * MCP server factory. Builds the McpServer, registers every MVP tool, and
 * returns both the server and its context (handy for tests/examples).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildContext, type BuildContextOverrides, type ServerContext } from './context.js';
import { registerTools, type AnyToolDef } from './registry.js';
import { pollTools } from '../tools/polls/index.js';
import { paymentTools } from '../tools/payments/index.js';
import { marketplaceTools } from '../tools/marketplace/index.js';
import { daoTools } from '../tools/daos/index.js';
import { governanceTools } from '../tools/governance/index.js';
import { treasuryTools } from '../tools/treasury/index.js';

export const allTools: AnyToolDef[] = [
  ...pollTools,
  ...paymentTools,
  ...marketplaceTools,
  ...daoTools,
  ...governanceTools,
  ...treasuryTools,
];

export interface CreatedServer {
  server: McpServer;
  ctx: ServerContext;
}

/** Build an McpServer whose tools run against a specific (possibly per-request) context. */
export function createMcpServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: 'shadow-policy-mcp', version: '0.1.0' });
  registerTools(server, ctx, allTools);
  return server;
}

export function createServer(overrides: BuildContextOverrides = {}): CreatedServer {
  const ctx = buildContext(overrides);
  return { server: createMcpServer(ctx), ctx };
}

export { buildContext };
export type { ServerContext };
