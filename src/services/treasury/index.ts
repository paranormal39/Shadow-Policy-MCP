/**
 * Treasury approval guard (Phase 4).
 *
 * HARD RULE: a treasury payment must never be executable merely because an agent
 * called a tool. Every spend request tracked here must collect the required
 * number of DISTINCT approvals and (by policy) be linked to a finalized
 * governance proposal before execution is permitted. The server enforces this
 * before ever calling the backend's execute endpoint.
 */
import type { TreasuryPolicy } from '../../config/index.js';

export interface TrackedSpend {
  spendRequestId: string;
  orgId: string;
  amount: string;
  recipientAddress: string;
  requestedBy: string;
  proposalId?: string;
  approvals: string[]; // distinct approver identities
  executed: boolean;
  createdAt: number;
}

export type ExecuteGate =
  | { ok: true }
  | { ok: false; reason: string; approvalsHave: number; approvalsNeed: number };

export class TreasuryGuard {
  private readonly spends = new Map<string, TrackedSpend>();
  constructor(private readonly policy: TreasuryPolicy) {}

  track(input: { spendRequestId: string; orgId: string; amount: string; recipientAddress: string; requestedBy: string; proposalId?: string }): TrackedSpend {
    const existing = this.spends.get(input.spendRequestId);
    if (existing) return existing;
    const rec: TrackedSpend = { ...input, approvals: [], executed: false, createdAt: Date.now() };
    this.spends.set(input.spendRequestId, rec);
    return rec;
  }

  get(spendRequestId: string): TrackedSpend | undefined {
    return this.spends.get(spendRequestId);
  }

  /** Record a distinct approval. Returns the updated record. */
  approve(spendRequestId: string, approver: string): TrackedSpend {
    const rec = this.spends.get(spendRequestId);
    if (!rec) throw new Error(`Unknown spend request ${spendRequestId}`);
    if (!rec.approvals.includes(approver)) rec.approvals.push(approver);
    return rec;
  }

  /**
   * Whether the spend may execute. `proposalFinalized` is supplied by the caller
   * after checking the linked proposal's status against the backend.
   */
  canExecute(spendRequestId: string, proposalFinalized: boolean): ExecuteGate {
    const rec = this.spends.get(spendRequestId);
    const need = this.policy.approvalsRequired;
    if (!rec) return { ok: false, reason: `Unknown spend request ${spendRequestId}.`, approvalsHave: 0, approvalsNeed: need };
    if (rec.executed) return { ok: false, reason: 'Spend request already executed.', approvalsHave: rec.approvals.length, approvalsNeed: need };
    if (this.policy.requireProposal) {
      if (!rec.proposalId) return { ok: false, reason: 'A finalized governance proposal must be linked to this spend (requireProposal).', approvalsHave: rec.approvals.length, approvalsNeed: need };
      if (!proposalFinalized) return { ok: false, reason: `Linked proposal ${rec.proposalId} is not finalized/passed.`, approvalsHave: rec.approvals.length, approvalsNeed: need };
    }
    if (rec.approvals.length < need) {
      return { ok: false, reason: `Needs ${need} distinct approvals; has ${rec.approvals.length}.`, approvalsHave: rec.approvals.length, approvalsNeed: need };
    }
    return { ok: true };
  }

  markExecuted(spendRequestId: string): void {
    const rec = this.spends.get(spendRequestId);
    if (rec) rec.executed = true;
  }
}
