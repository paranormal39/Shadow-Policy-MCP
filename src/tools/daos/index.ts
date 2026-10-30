/**
 * Phase 3 — DAO tools. Thin, typed adapters over votechain's existing
 * /api/orgs + /api/projects endpoints (see API.md), authenticated with the
 * server's x-api-key. Wallet-addressed actions take an explicit walletAddress
 * (with an API key the backend treats the body wallet as the actor).
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';
import { resolveDaoId } from '../shared.js';
import { OperationError } from '../../services/operations.js';

const walletSchema = z.string().min(3).max(120);
const chainSchema = z.enum(['midnight', 'xrpl', 'xahau', 'cardano']);
const daoIdSchema = z.string().min(1).optional().describe('DAO/org id. Defaults to the configured Legion DAO (LEGION_ORG_ID) when omitted.');

export const daoTools: AnyToolDef[] = [
  defineTool({
    name: 'shadow_list_daos',
    description: 'List DAOs (organizations) on Shadow Labz.',
    inputShape: { all: z.boolean().optional().describe('Include orgs without a deployed contract. Default true.') },
    handler: (ctx, args) => ctx.shadowlabz.listDaos(args.all ?? true),
  }),

  defineTool({
    name: 'shadow_get_dao',
    description: 'Get a DAO detail (members, settings, governance).',
    inputShape: { daoId: daoIdSchema },
    handler: (ctx, args) => ctx.shadowlabz.getDao(resolveDaoId(ctx, args.daoId)),
  }),

  defineTool({
    name: 'shadow_list_dao_members',
    description: 'List a DAO\u2019s members.',
    inputShape: { daoId: daoIdSchema },
    handler: (ctx, args) => ctx.shadowlabz.listDaoMembers(resolveDaoId(ctx, args.daoId)),
  }),

  defineTool({
    name: 'shadow_create_dao',
    description:
      'Create a DAO via the launchpad (POST /api/projects). The project becomes an on-chain org after its funding/activation lifecycle; this call creates the project record. Returns the created project.',
    callerWalletField: 'createdBy',
    inputShape: {
      name: z.string().min(2).max(120),
      createdBy: walletSchema,
      chain: chainSchema,
      currency: z.string().min(2).max(20),
      description: z.string().max(1000).optional(),
      membership: z
        .object({
          kind: z.enum(['token', 'nft', 'credential']),
          name: z.string().min(1).max(80),
          currency: z.string().max(20).optional(),
          amountPerContributor: z.number().optional(),
          taxon: z.number().int().optional(),
        })
        .describe('Membership gate for the DAO.'),
      goalAmount: z.number().optional(),
      visibility: z.enum(['public', 'private']).optional(),
    },
    handler: (ctx, args) => ctx.shadowlabz.createProject({ ...args }),
  }),

  defineTool({
    name: 'shadow_join_dao',
    description: 'Self-join a DAO per its join policy (token/NFT/credential gates enforced by the backend).',
    callerWalletField: 'walletAddress',
    inputShape: {
      daoId: daoIdSchema,
      walletAddress: walletSchema,
      chain: chainSchema.optional().describe('Chain of walletAddress. Defaults to the chain bound to your token.'),
      displayName: z.string().max(80).optional(),
      proofHash: z.string().max(200).optional(),
    },
    handler: (ctx, args) => {
      const chain = args.chain ?? ctx.callerChain;
      if (!chain) throw new OperationError('No chain provided and none bound to the token.', 'CHAIN_REQUIRED');
      return ctx.shadowlabz.joinDao(resolveDaoId(ctx, args.daoId), { walletAddress: args.walletAddress, chain, displayName: args.displayName, proofHash: args.proofHash });
    },
  }),
];
