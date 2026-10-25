/**
 * AgilityCore-compatible identity + on-chain verification.
 *
 * Uses vendored AgilityCore algorithms (src/vendor/agility) so this server stays
 * self-contained and deployable (e.g. Railway) without the sibling
 * `@agility-protocol/headless` package, while remaining byte-compatible with the
 * Agility ecosystem's pairwise DIDs and payment verification.
 */
import { derivePairwiseDid } from '../../vendor/agility/pairwise-did.js';
import { verifyXrplPaymentOnChain as vendorVerify, type OnChainCheck } from '../../vendor/agility/xrpl-verify.js';
import type { XrplNetwork } from '../../config/index.js';

const MASTER_DID = 'did:shadowpolicy:agents';

/** Derive the stable pairwise DID this agent presents to Shadow Policy. */
export function agentPairwiseDid(agentId: string): string {
  return derivePairwiseDid(`${MASTER_DID}:${agentId}`, 'shadow-policy-mcp');
}

export type { OnChainCheck };

/**
 * Independently confirm that `txHash` delivered at least `expectedDrops` XRP to
 * `destination` on the given network.
 */
export function verifyXrplPaymentOnChain(opts: {
  network: XrplNetwork;
  txHash: string;
  destination: string;
  expectedDrops: string;
}): Promise<OnChainCheck> {
  return vendorVerify({
    network: opts.network === 'mainnet' ? 'mainnet' : opts.network === 'devnet' ? 'devnet' : 'testnet',
    txHash: opts.txHash,
    destination: opts.destination,
    expectedDrops: opts.expectedDrops,
  });
}
