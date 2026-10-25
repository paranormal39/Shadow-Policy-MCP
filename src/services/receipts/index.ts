/**
 * Signed, verifiable payment receipts. A receipt is auditable (carries the
 * txHash + amount + service) but contains no private survey content and no
 * secrets. It is HMAC-signed so any party holding the server secret can confirm
 * authenticity, and `shadow_verify_poll_receipt` can re-check it.
 */
import { randomUUID } from 'node:crypto';
import { signPayload, verifyPayload } from '../../security/hash.js';
import type { ServiceKind } from '../pricing/index.js';

export interface ReceiptCore {
  receiptId: string;
  invoiceId: string;
  quoteId: string;
  agentId: string;
  service: ServiceKind;
  amountDrops: string;
  asset: string;
  network: string;
  txHash: string;
  payer?: string;
  resource: string;
  onChainVerified: boolean;
  facilitator: 'mock' | 't54';
  settledAt: number;
}

export interface Receipt extends ReceiptCore {
  signature: string;
}

export class ReceiptService {
  constructor(private readonly secret: string) {}

  issue(core: Omit<ReceiptCore, 'receiptId' | 'settledAt'> & { settledAt?: number }): Receipt {
    const full: ReceiptCore = {
      ...core,
      receiptId: `rcpt_${randomUUID()}`,
      settledAt: core.settledAt ?? Date.now(),
    };
    return { ...full, signature: signPayload(this.secret, full) };
  }

  verify(receipt: Receipt): boolean {
    const { signature, ...core } = receipt;
    return verifyPayload(this.secret, core, signature);
  }
}
