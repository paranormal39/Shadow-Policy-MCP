/**
 * Self-contained XRPL on-chain payment verification.
 *
 * Replicates the verification performed by AgilityCore's XrplPaymentAdapter
 * (@agility-protocol/headless/agility-payments) — fetch the tx, confirm it is
 * validated + successful, and that it delivered at least the expected amount to
 * the expected destination — using the `xrpl` package directly so this repo has
 * no cross-package build dependency. Amounts are compared in integer drops.
 */
import { Client } from 'xrpl';

export type XrplNetworkType = 'mainnet' | 'testnet' | 'devnet';

const WS_ENDPOINTS: Record<XrplNetworkType, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
  devnet: 'wss://s.devnet.rippletest.net:51233',
};

export interface OnChainCheck {
  confirmed: boolean;
  reason?: string;
  ledgerIndex?: number;
  deliveredDrops?: string;
}

export async function verifyXrplPaymentOnChain(opts: {
  network: XrplNetworkType;
  txHash: string;
  destination: string;
  expectedDrops: string;
  wsUrl?: string;
}): Promise<OnChainCheck> {
  const client = new Client(opts.wsUrl ?? WS_ENDPOINTS[opts.network]);
  try {
    await client.connect();
    const resp = await client.request({ command: 'tx', transaction: opts.txHash });
    const r = resp.result as Record<string, any>;

    if (!r.validated) return { confirmed: false, reason: 'Transaction not yet validated.' };

    const meta = r.meta ?? r.metaData;
    if (meta && typeof meta === 'object' && meta.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') {
      return { confirmed: false, reason: `Transaction failed on-chain: ${meta.TransactionResult}` };
    }

    // xrpl.js v4 nests the submitted fields under tx_json; older shapes are flat.
    const dest = r.tx_json?.Destination ?? r.Destination;
    if (dest !== opts.destination) return { confirmed: false, reason: 'On-chain destination mismatch.' };

    const delivered = (meta && typeof meta === 'object' ? meta.delivered_amount : undefined) ?? (r.tx_json?.Amount ?? r.Amount);
    if (typeof delivered !== 'string') return { confirmed: false, reason: 'Delivered amount is not native XRP.' };

    if (BigInt(delivered) < BigInt(opts.expectedDrops)) {
      return { confirmed: false, reason: 'Delivered amount is less than the quoted amount.', deliveredDrops: delivered };
    }
    return { confirmed: true, ledgerIndex: r.ledger_index, deliveredDrops: delivered };
  } catch (err) {
    return { confirmed: false, reason: `On-chain verification error: ${(err as Error).message}` };
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}
