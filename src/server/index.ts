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

export function createServer(overrides: BuildContextOverrides = {}): CreatedServer {
  const ctx = buildContext(overrides);
  const server = new McpServer({
    name: 'shadow-policy-mcp',
    version: '0.1.0',
  });
  registerTools(server, ctx, allTools);
  return { server, ctx };
}

export { buildContext };
export type { ServerContext };
