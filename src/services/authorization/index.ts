/**
 * Authorization / spending-policy engine.
 *
 * Enforces, per agent identity, before any payment is authorized:
 *   - maximum expenditure per transaction
 *   - rolling daily and monthly spending allowances
 *   - allowed payment destinations
 *   - a human-approval threshold above which an explicit approval is required
 *
 * This is a small server-side interface (AgilityCore's device SDK does not
 * model a multi-agent spending policy). State is in-memory; swap the store for
 * a durable one in production.
 */
import { addDrops, compareDrops, dropsToXrp } from '../../security/money.js';
import type { ShadowPolicyConfig } from '../../config/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

export interface SpendingLimits {
  perTxLimitDrops: string;
  dailyLimitDrops: string;
  monthlyLimitDrops: string;
  humanApprovalDrops: string;
  allowedDestinations: string[];
}

export interface SpendRecord {
  amountDrops: string;
  at: number;
  invoiceId: string;
}

export type AuthorizationDecision =
  | { ok: true; authorizationId: string }
  | { ok: false; reason: string; requiresHumanApproval?: boolean };

export interface AuthorizeRequest {
  agentId: string;
  amountDrops: string;
  invoiceId: string;
  destination: string;
  service: string;
}

export class PolicyEngine {
  private readonly ledger = new Map<string, SpendRecord[]>();
  private readonly approvals = new Set<string>(); // approved invoiceIds
  private readonly overrides = new Map<string, Partial<SpendingLimits>>();

  constructor(private readonly config: ShadowPolicyConfig) {}

  /** Register per-agent limit overrides (e.g. delegated authority). */
  setLimits(agentId: string, limits: Partial<SpendingLimits>): void {
    this.overrides.set(agentId, { ...this.overrides.get(agentId), ...limits });
  }

  getLimits(agentId: string): SpendingLimits {
    const base: SpendingLimits = {
      perTxLimitDrops: this.config.policy.perTxLimitDrops,
      dailyLimitDrops: this.config.policy.dailyLimitDrops,
      monthlyLimitDrops: this.config.policy.monthlyLimitDrops,
      humanApprovalDrops: this.config.policy.humanApprovalDrops,
      allowedDestinations: [this.config.merchantAddress],
    };
    return { ...base, ...this.overrides.get(agentId) };
  }

  private spentSince(agentId: string, since: number): string {
    const records = this.ledger.get(agentId) ?? [];
    return records.filter((r) => r.at >= since).reduce((acc, r) => addDrops(acc, r.amountDrops), '0');
  }

  /** Record a human approval for a specific invoice (quote). */
  approve(invoiceId: string): void {
    this.approvals.add(invoiceId);
  }

  isApproved(invoiceId: string): boolean {
    return this.approvals.has(invoiceId);
  }

  /** Decide whether `req` may proceed. Does NOT record the spend. */
  authorize(req: AuthorizeRequest): AuthorizationDecision {
    const limits = this.getLimits(req.agentId);

    if (!limits.allowedDestinations.includes(req.destination)) {
      return { ok: false, reason: `Destination ${req.destination} is not in the allow-list.` };
    }
    if (compareDrops(req.amountDrops, limits.perTxLimitDrops) > 0) {
      return { ok: false, reason: `Amount ${dropsToXrp(req.amountDrops)} XRP exceeds the per-transaction limit of ${dropsToXrp(limits.perTxLimitDrops)} XRP.` };
    }
    const now = Date.now();
    const daily = addDrops(this.spentSince(req.agentId, now - DAY_MS), req.amountDrops);
    if (compareDrops(daily, limits.dailyLimitDrops) > 0) {
      return { ok: false, reason: `Daily spending allowance of ${dropsToXrp(limits.dailyLimitDrops)} XRP would be exceeded.` };
    }
    const monthly = addDrops(this.spentSince(req.agentId, now - MONTH_MS), req.amountDrops);
    if (compareDrops(monthly, limits.monthlyLimitDrops) > 0) {
      return { ok: false, reason: `Monthly spending allowance of ${dropsToXrp(limits.monthlyLimitDrops)} XRP would be exceeded.` };
    }
    // Human-approval threshold.
    if (compareDrops(req.amountDrops, limits.humanApprovalDrops) >= 0 && !this.isApproved(req.invoiceId)) {
      return {
        ok: false,
        requiresHumanApproval: true,
        reason: `Amount ${dropsToXrp(req.amountDrops)} XRP is at/above the human-approval threshold of ${dropsToXrp(limits.humanApprovalDrops)} XRP. A human must approve invoice ${req.invoiceId} first.`,
      };
    }
    return { ok: true, authorizationId: `auth_${req.invoiceId}` };
  }

  /** Record a confirmed spend against the agent's rolling allowances. */
  recordSpend(agentId: string, amountDrops: string, invoiceId: string): void {
    const records = this.ledger.get(agentId) ?? [];
    records.push({ amountDrops, at: Date.now(), invoiceId });
    this.ledger.set(agentId, records);
  }

  usage(agentId: string): { dailyDrops: string; monthlyDrops: string } {
    const now = Date.now();
    return {
      dailyDrops: this.spentSince(agentId, now - DAY_MS),
      monthlyDrops: this.spentSince(agentId, now - MONTH_MS),
    };
  }
}
