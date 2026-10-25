/**
 * Agent registry (Phase 2). A small server-side directory of participating
 * agents, each bound to a pairwise DID (via AgilityCore) and disclosing its
 * capabilities and roles. Used for agent-to-agent surveys (eligibility) and
 * response provenance.
 *
 * In-memory for the MVP; swap for a durable store in production.
 */
import { agentPairwiseDid } from '../../integrations/agilitycore/index.js';

export type AgentKind = 'agent' | 'human-proxy';

export interface AgentProfile {
  agentId: string;
  pairwiseDid: string;
  kind: AgentKind;
  displayName?: string;
  /** Self-disclosed capabilities (e.g. "code", "research", "vision"). */
  capabilities: string[];
  /** Organizational / marketplace roles (e.g. "respondent", "requester"). */
  roles: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RegisterAgentInput {
  agentId: string;
  kind?: AgentKind;
  displayName?: string;
  capabilities?: string[];
  roles?: string[];
}

export class AgentRegistry {
  private readonly byId = new Map<string, AgentProfile>();

  register(input: RegisterAgentInput): AgentProfile {
    const now = Date.now();
    const existing = this.byId.get(input.agentId);
    const profile: AgentProfile = {
      agentId: input.agentId,
      pairwiseDid: agentPairwiseDid(input.agentId),
      kind: input.kind ?? existing?.kind ?? 'agent',
      displayName: input.displayName ?? existing?.displayName,
      capabilities: input.capabilities ?? existing?.capabilities ?? [],
      roles: input.roles ?? existing?.roles ?? ['respondent'],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byId.set(input.agentId, profile);
    return profile;
  }

  get(agentId: string): AgentProfile | undefined {
    return this.byId.get(agentId);
  }

  isRegistered(agentId: string): boolean {
    return this.byId.has(agentId);
  }

  list(): AgentProfile[] {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
