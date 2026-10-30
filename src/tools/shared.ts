/**
 * Shared tool helpers.
 */
import { OperationError } from '../services/operations.js';
import type { ServerContext } from '../server/context.js';

/**
 * Resolve the DAO/org id for an org-scoped tool: the explicit `daoId` argument
 * if given, otherwise the server's configured Legion org (LEGION_ORG_ID). Lets
 * Legion agents omit daoId once the host is pinned to one DAO.
 */
export function resolveDaoId(ctx: ServerContext, daoId?: string): string {
  const id = daoId ?? ctx.config.legionOrgId ?? undefined;
  if (!id) {
    throw new OperationError(
      'No daoId provided and no default Legion DAO configured (set LEGION_ORG_ID).',
      'DAO_REQUIRED',
    );
  }
  return id;
}
