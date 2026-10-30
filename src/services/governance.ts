import { ShadowLabzError, type ShadowLabzClient } from '../integrations/shadowlabz/client.js';
import { OperationError } from './operations.js';

/** Proposal aggregates cannot establish participation by a particular wallet.
 * Keep this check unavailable until the backend has an authenticated, durable
 * participation API. In particular, never turn missing evidence into false.
 */
export function getMyVote(walletAddress?: string): never {
  if (!walletAddress) {
    throw new OperationError('A caller wallet is required to check personal participation.', 'WALLET_REQUIRED');
  }
  throw new OperationError(
    'The backend integration has no authoritative per-wallet proposal participation lookup. Your vote status is unknown; aggregate tallies cannot verify it. Do not submit or retry a vote based on this check.',
    'VOTE_VERIFICATION_UNAVAILABLE',
  );
}

/** No retries: a lost response can follow a committed vote. Only an explicit
 * acknowledgement confirms this submission; duplicates establish participation
 * but cannot confirm which choice was previously recorded.
 */
export async function castVote(
  client: ShadowLabzClient,
  proposalId: string,
  body: { walletAddress: string; choice: 'yes' | 'no' | 'abstain' },
): Promise<{ voted: true }> {
  let result: unknown;
  try {
    result = await client.voteProposal(proposalId, body);
  } catch (err) {
    if (err instanceof ShadowLabzError && err.status >= 400 && err.status < 500) {
      if (err.status === 409 && err.code === 'ALREADY_VOTED') {
        throw new OperationError(
          'This wallet has already voted on this proposal. This confirms prior participation, not that the choice in this request was recorded. Do not resubmit.',
          'ALREADY_VOTED',
        );
      }
      const code = err.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(err.code) ? err.code : 'VOTE_REJECTED';
      // Do not expose arbitrary backend error details (which may contain ballots).
      throw new OperationError(`The backend rejected the vote (HTTP ${err.status}, ${code}).`, code);
    }
    throw unknownVoteOutcome();
  }
  if (result && typeof result === 'object' && 'voted' in result && result.voted === true) {
    // Return participation only, even if a backend includes extra private data.
    return { voted: true };
  }
  throw unknownVoteOutcome();
}

function unknownVoteOutcome(): OperationError {
  return new OperationError(
    'The vote submission outcome is unknown: the backend may have recorded it. Do not automatically retry or infer success from aggregate tallies. Authoritative participation verification or operator reconciliation is required.',
    'VOTE_OUTCOME_UNKNOWN',
  );
}
