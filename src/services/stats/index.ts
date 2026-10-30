/**
 * In-memory operational stats for the hosted endpoint (the Legion dashboard).
 *
 * The HTTP transport is stateless (no long-lived MCP sessions), so "connected"
 * is expressed as agents *seen* and agents *active recently*. Everything here is
 * aggregate and non-sensitive — no tokens, seeds, or organizer keys are ever
 * recorded. Single-instance only, like the rest of the MVP stores.
 */
export type StatEventKind = 'tool' | 'auth' | 'auth_fail';

export interface StatEvent {
  at: number;
  kind: StatEventKind;
  tool?: string;
  agentId?: string;
  ok?: boolean;
  code?: string;
  ms?: number;
}

export interface AgentSeen {
  agentId: string;
  wallet?: string;
  firstSeen: number;
  lastSeen: number;
  requests: number;
}

const ACTIVE_WINDOW_MS = 5 * 60_000;
const MAX_RECENT = 200;

export class StatsService {
  readonly startedAt = Date.now();
  private requests = 0;
  private errors = 0;
  private authSuccess = 0;
  private authFailures = 0;
  private readonly byTool = new Map<string, { calls: number; errors: number }>();
  private readonly byErrorCode = new Map<string, number>();
  private readonly agents = new Map<string, AgentSeen>();
  private readonly recent: StatEvent[] = [];

  private push(e: StatEvent): void {
    this.recent.push(e);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  /** An authenticated HTTP request from a known agent. */
  recordAuth(agentId: string, wallet?: string): void {
    this.authSuccess++;
    const now = Date.now();
    const seen = this.agents.get(agentId);
    if (seen) {
      seen.lastSeen = now;
      seen.requests++;
      if (wallet) seen.wallet = wallet;
    } else {
      this.agents.set(agentId, { agentId, wallet, firstSeen: now, lastSeen: now, requests: 1 });
    }
    this.push({ at: now, kind: 'auth', agentId });
  }

  /** A rejected HTTP request (bad/absent token). */
  recordAuthFailure(): void {
    this.authFailures++;
    this.push({ at: Date.now(), kind: 'auth_fail' });
  }

  /** A completed tool call. */
  recordTool(tool: string, opts: { agentId?: string; ok: boolean; code?: string; ms: number }): void {
    this.requests++;
    const t = this.byTool.get(tool) ?? { calls: 0, errors: 0 };
    t.calls++;
    if (!opts.ok) {
      this.errors++;
      t.errors++;
      if (opts.code) this.byErrorCode.set(opts.code, (this.byErrorCode.get(opts.code) ?? 0) + 1);
    }
    this.byTool.set(tool, t);
    this.push({ at: Date.now(), kind: 'tool', tool, agentId: opts.agentId, ok: opts.ok, code: opts.code, ms: opts.ms });
  }

  snapshot() {
    const now = Date.now();
    const agents = [...this.agents.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.floor((now - this.startedAt) / 1000),
      requests: this.requests,
      errors: this.errors,
      auth: { success: this.authSuccess, failures: this.authFailures },
      agents: {
        total: agents.length,
        activeNow: agents.filter((a) => now - a.lastSeen <= ACTIVE_WINDOW_MS).length,
        activeWindowSec: ACTIVE_WINDOW_MS / 1000,
        list: agents.slice(0, 50).map((a) => ({
          agentId: a.agentId,
          wallet: a.wallet,
          requests: a.requests,
          firstSeen: new Date(a.firstSeen).toISOString(),
          lastSeen: new Date(a.lastSeen).toISOString(),
          active: now - a.lastSeen <= ACTIVE_WINDOW_MS,
        })),
      },
      tools: [...this.byTool.entries()]
        .map(([name, s]) => ({ name, calls: s.calls, errors: s.errors }))
        .sort((a, b) => b.calls - a.calls),
      errorsByCode: Object.fromEntries(this.byErrorCode),
      recent: [...this.recent].reverse().slice(0, 100),
    };
  }
}
