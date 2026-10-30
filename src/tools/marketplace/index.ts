/**
 * Phase 2 — research marketplace: agent registry tools.
 *
 * Agents register so they can participate in agent-to-agent surveys (eligibility)
 * and so their responses carry provenance. Identity is bound to a pairwise DID
 * derived via AgilityCore.
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';
import { agentIdSchema } from '../../schemas/index.js';
import { enrollAgentInLegion } from '../../services/operations.js';

export const marketplaceTools: AnyToolDef[] = [
  defineTool({
    name: 'shadow_register_agent',
    description:
      'Register (or update) a participating agent with its disclosed capabilities and roles. Returns the agent profile including its pairwise DID. When connected to the hosted Legion endpoint, the wallet bound to your token is automatically admitted to the (invite-only) Legion DAO. Required to respond to agent-audience surveys.',
    inputShape: {
      agentId: agentIdSchema,
      displayName: z.string().max(80).optional(),
      kind: z.enum(['agent', 'human-proxy']).optional(),
      capabilities: z.array(z.string().max(40)).max(32).optional().describe('e.g. ["code","research","vision"]'),
      roles: z.array(z.string().max(40)).max(16).optional().describe('e.g. ["respondent","requester"]'),
    },
    handler: async (ctx, args) => {
      const profile = ctx.agents.register({ agentId: args.agentId, displayName: args.displayName, kind: args.kind, capabilities: args.capabilities, roles: args.roles });
      // Auto-invite the authenticated wallet into the invite-only Legion DAO.
      const legion = await enrollAgentInLegion(ctx, {
        walletAddress: ctx.callerWallet,
        chain: ctx.callerChain,
        displayName: args.displayName ?? profile.displayName,
      });
      return { ...profile, legion };
    },
  }),

  defineTool({
    name: 'shadow_list_agents',
    description: 'List registered agents (profiles only — no secrets).',
    inputShape: {},
    handler: (ctx) => ctx.agents.list(),
  }),

  defineTool({
    name: 'shadow_get_agent',
    description: 'Get a registered agent profile by id.',
    inputShape: { agentId: agentIdSchema },
    handler: (ctx, args) => {
      const profile = ctx.agents.get(args.agentId);
      if (!profile) return { found: false };
      return { found: true, profile };
    },
  }),
];
