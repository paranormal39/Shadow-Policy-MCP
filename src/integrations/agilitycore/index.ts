/**
 * AgilityCore integration.
 *
 * Reuses AgilityCore (@agility-protocol/headless) for the parts that genuinely
 * exist there:
 *   - XrplPaymentAdapter: independent on-chain verification of a settled payment
 *     (defence-in-depth behind the x402 facilitator's own settlement result).
 *   - derivePairwiseDid: per-service pairwise DID for each participating agent,
 *     so an agent's identity toward Shadow Policy is unlinkable elsewhere.
 *
 * Capabilities AgilityCore's device SDK does not provide for a multi-agent
 * *server* (an agent registry, spending-limit policy, order/receipt state) are
 * implemented as small local interfaces under src/services — see the inventory
 * doc. This keeps the reuse honest rather than forcing a device-shaped API.
 */
import { createXrplPaymentAdapter } from '@agility-protocol/headless/payments-xrpl';
import { derivePairwiseDid } from '@agility-protocol/headless';
import { xrpToDrops } from '../../security/money.js';
import { safeLog } from '../../security/secrets.js';
import type { XrplNetwork } from '../../config/index.js';

const MASTER_DID = 'did:shadowpolicy:agents';

/** Derive the stable pairwise DID this agent presents to Shadow Policy. */
export function agentPairwiseDid(agentId: string): string {
  return derivePairwiseDid(`${MASTER_DID}:${agentId}`, 'shadow-policy-mcp');
}

export interface OnChainCheck {
  confirmed: boolean;
  skipped?: boolean;
  reason?: string;
  ledgerIndex?: number;
  deliveredDrops?: string;
}

/**
 * Independently confirm, via AgilityCore's XRPL adapter, that `txHash` delivered
 * at least `expectedDrops` XRP to `destination` on the given network.
 */
export async function verifyXrplPaymentOnChain(opts: {
  network: XrplNetwork;
  txHash: string;
  destination: string;
  expectedDrops: string;
}): Promise<OnChainCheck> {
  const adapter = createXrplPaymentAdapter();
  try {
    await adapter.connect({ networkType: opts.network === 'mainnet' ? 'mainnet' : opts.network });
    const tx = await adapter.getTransaction(opts.txHash);
    if (!tx) return { confirmed: false, reason: 'Transaction not found on ledger.' };
    if (tx.status !== 'confirmed') return { confirmed: false, reason: `Transaction not validated (status=${tx.status}).` };
    if (tx.to !== opts.destination) return { confirmed: false, reason: 'On-chain destination mismatch.' };
    if (tx.currency !== 'XRP') return { confirmed: false, reason: `Unexpected currency ${tx.currency}.` };
    // adapter returns the amount as a decimal XRP string; normalise to drops.
    const deliveredDrops = xrpToDrops(tx.amount);
    if (BigInt(deliveredDrops) < BigInt(opts.expectedDrops)) {
      return { confirmed: false, reason: 'Delivered amount is less than the quoted amount.', deliveredDrops };
    }
    return { confirmed: true, ledgerIndex: tx.ledgerIndex, deliveredDrops };
  } catch (err) {
    safeLog.warn('on-chain verify failed', { message: (err as Error).message });
    return { confirmed: false, reason: `On-chain verification error: ${(err as Error).message}` };
  } finally {
    try {
      await adapter.disconnect();
    } catch {
      /* ignore */
    }
  }
}
