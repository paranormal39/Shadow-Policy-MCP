/**
 * The PaymentFacilitator seam. A facilitator verifies an x402 payment payload
 * against its requirements and settles it on-chain, returning a result the
 * merchant can trust. Implementations: MockFacilitator (default, offline) and
 * T54XrplFacilitator (real hosted XRPL facilitator).
 */
import type { PaymentPayload, SettlementResponse, X402Accepted } from './x402-types.js';

export interface VerifyResult {
  valid: boolean;
  payer?: string;
  reason?: string;
}

export interface PaymentFacilitator {
  readonly kind: 'mock' | 't54';
  /** Validate that `payload` satisfies `requirements` without settling. */
  verify(requirements: X402Accepted, payload: PaymentPayload): Promise<VerifyResult>;
  /** Submit the payment to the ledger and return the settlement result. */
  settle(requirements: X402Accepted, payload: PaymentPayload): Promise<SettlementResponse>;
}
