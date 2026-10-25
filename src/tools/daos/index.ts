/**
 * Phase 3 — DAO tools. Thin, typed adapters over votechain's existing
 * /api/orgs + /api/projects endpoints (see API.md), authenticated with the
 * server's x-api-key. Wallet-addressed actions take an explicit walletAddress
 * (with an API key the backend treats the body wallet as the actor).
 */
import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../../server/registry.js';

const walletSchema = z.string().min(3).max(120);
const chainSchema = z.enum(['midnight', 'xrpl', 'xahau', 'cardano']);

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
    inputShape: { daoId: z.string().min(1) },
    handler: (ctx, args) => ctx.shadowlabz.getDao(args.daoId),
  }),

  defineTool({
    name: 'shadow_list_dao_members',
    description: 'List a DAO\u2019s members.',
    inputShape: { daoId: z.string().min(1) },
    handler: (ctx, args) => ctx.shadowlabz.listDaoMembers(args.daoId),
  }),

  defineTool({
    name: 'shadow_create_dao',
    description:
      'Create a DAO via the launchpad (POST /api/projects). The project becomes an on-chain org after its funding/activation lifecycle; this call creates the project record. Returns the created project.',
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
    inputShape: {
      daoId: z.string().min(1),
      walletAddress: walletSchema,
      chain: chainSchema,
      displayName: z.string().max(80).optional(),
      proofHash: z.string().max(200).optional(),
    },
    handler: (ctx, args) =>
      ctx.shadowlabz.joinDao(args.daoId, { walletAddress: args.walletAddress, chain: args.chain, displayName: args.displayName, proofHash: args.proofHash }),
  }),
];
