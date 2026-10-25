/**
 * MockFacilitator — deterministic, offline, no real XRP. The default used by
 * tests, CI, and local development. It simulates the x402 handshake faithfully
 * (same types, same checks) so the end-to-end flow is exercised without a live
 * ledger or funded wallets.
 *
 * The "signed tx blob" is a base64-JSON envelope created by `createMockSignedBlob`
 * (standing in for a real signed XRPL Payment). It is NOT a real signature and
 * is rejected by the real facilitator.
 */
import { sha256Hex } from '../../security/hash.js';
import type { PaymentFacilitator, VerifyResult } from './facilitator.js';
import type { PaymentPayload, SettlementResponse, X402Accepted } from './x402-types.js';

export interface MockSignedInner {
  mock: true;
  from: string;
  payTo: string;
  amount: string;
  asset: string;
  network: string;
  invoiceId?: string;
  nonce: string;
}

/** Build a mock "signed" payment blob for a given set of requirements. */
export function createMockSignedBlob(requirements: X402Accepted, fromAddress: string): string {
  const inner: MockSignedInner = {
    mock: true,
    from: fromAddress,
    payTo: requirements.payTo,
    amount: requirements.amount,
    asset: requirements.asset,
    network: requirements.network,
    invoiceId: requirements.extra?.invoiceId,
    nonce: sha256Hex(`${requirements.extra?.invoiceId ?? ''}:${fromAddress}:${requirements.amount}`).slice(0, 24),
  };
  return Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
}

function decodeBlob(blob: string): MockSignedInner | null {
  try {
    const obj = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
    return obj && obj.mock === true ? (obj as MockSignedInner) : null;
  } catch {
    return null;
  }
}

export class MockFacilitator implements PaymentFacilitator {
  readonly kind = 'mock' as const;

  async verify(requirements: X402Accepted, payload: PaymentPayload): Promise<VerifyResult> {
    const inner = decodeBlob(payload.payload.signedTxBlob);
    if (!inner) return { valid: false, reason: 'Not a mock-signed payload (use createMockSignedBlob, or the t54 facilitator for real payments).' };
    if (inner.payTo !== requirements.payTo) return { valid: false, reason: 'Destination mismatch.' };
    if (inner.amount !== requirements.amount) return { valid: false, reason: 'Amount mismatch — the amount cannot be altered from the quote.' };
    if (inner.asset !== requirements.asset) return { valid: false, reason: 'Asset mismatch.' };
    if (inner.network !== requirements.network) return { valid: false, reason: 'Network mismatch.' };
    if (requirements.extra?.invoiceId && inner.invoiceId !== requirements.extra.invoiceId) {
      return { valid: false, reason: 'Invoice id mismatch.' };
    }
    return { valid: true, payer: inner.from };
  }

  async settle(requirements: X402Accepted, payload: PaymentPayload): Promise<SettlementResponse> {
    const verified = await this.verify(requirements, payload);
    if (!verified.valid) return { success: false, errorReason: verified.reason, network: requirements.network };
    // Deterministic synthetic hash so retries with the same payload are stable.
    const txHash = ('MOCK' + sha256Hex(payload.payload.signedTxBlob).toUpperCase()).slice(0, 64);
    return { success: true, txHash, network: requirements.network, payer: verified.payer };
  }
}
