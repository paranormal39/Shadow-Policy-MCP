/**
 * Tool registry. Tools are declared as plain objects (name, description, a zod
 * raw shape, and a handler over ServerContext) and registered with the MCP
 * server here. Errors are converted into structured, redacted tool errors.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type { ServerContext } from './context.js';
import { OperationError } from '../services/operations.js';
import { redact, safeLog } from '../security/secrets.js';

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputShape: Shape;
  /**
   * The input field naming the wallet that *performs* this action (e.g.
   * `createdBy`, `walletAddress`, `requestedBy`). When the caller is
   * token-authenticated, this field is overwritten with the caller's bound
   * votechain wallet so an agent can only ever act as itself. Fields that name
   * *other* wallets (recipientAddress, delegateAddress, a human approver) must
   * NOT be listed here.
   */
  callerWalletField?: keyof z.infer<z.ZodObject<Shape>> & string;
  handler: (ctx: ServerContext, args: z.infer<z.ZodObject<Shape>>) => Promise<unknown> | unknown;
}

/**
 * A tool of any shape — used for heterogeneous collections (the handler arg is
 * widened to `any` to avoid function-parameter variance errors when mixing
 * differently-shaped tools in one array).
 */
export type AnyToolDef = ToolDef<any>;

/** Helper to declare a tool with inferred argument typing. */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

function toToolResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(redact(data), null, 2) }] };
}

function toToolError(err: unknown) {
  const code = err instanceof OperationError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }, null, 2) }],
  };
}

export function registerTools(server: McpServer, ctx: ServerContext, tools: AnyToolDef[]): void {
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputShape, async (args: unknown) => {
      const startedAt = Date.now();
      try {
        // When the caller is authenticated (HTTP + token), bind identity to the
        // token — never trust an agentId / actor-wallet supplied in the body.
        if (ctx.callerAgentId && args && typeof args === 'object') {
          const a = args as Record<string, unknown>;
          if ('agentId' in a) a.agentId = ctx.callerAgentId;
          if (tool.callerWalletField) {
            if (!ctx.callerWallet) {
              throw new OperationError(
                'This action acts on votechain as your wallet, but your token has no wallet bound. Issue the token from the dashboard so it is linked to an address.',
                'WALLET_REQUIRED',
              );
            }
            a[tool.callerWalletField] = ctx.callerWallet;
          }
        }
        const data = await tool.handler(ctx, args as never);
        ctx.stats.recordTool(tool.name, { agentId: ctx.callerAgentId, ok: true, ms: Date.now() - startedAt });
        return toToolResult(data);
      } catch (err) {
        if (!(err instanceof OperationError)) safeLog.error(`tool ${tool.name} failed`, { message: (err as Error).message });
        const code = err instanceof OperationError ? err.code : 'INTERNAL_ERROR';
        ctx.stats.recordTool(tool.name, { agentId: ctx.callerAgentId, ok: false, code, ms: Date.now() - startedAt });
        return toToolError(err);
      }
    });
  }
}
