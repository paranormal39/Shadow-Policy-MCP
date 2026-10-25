/**
 * Response provenance + poll audience (Phase 2).
 *
 * The brief requires distinguishing verified human responses from agent-
 * generated ones so results never misrepresent AI answers as human survey
 * evidence. We can only attribute responses that flow THROUGH this server
 * (agent responses proxied via shadow_submit_poll_response); direct human
 * responses on the Shadow Labz web app are counted by the backend tally but are
 * not individually attributable here. The summary makes that explicit.
 */
export type RespondentType = 'agent' | 'human';
export type PollAudience = 'public' | 'agents';

export interface ResponseRecord {
  pollId: string;
  respondentType: RespondentType;
  agentId?: string;
  capabilitiesDisclosed?: string[];
  at: number;
}

export interface ProvenanceSummary {
  /** Responses proxied through this server (the only ones we can attribute). */
  proxiedResponses: number;
  proxiedByAgents: number;
  proxiedByHumans: number;
  note: string;
}

export class ProvenanceStore {
  private readonly responses = new Map<string, ResponseRecord[]>();
  private readonly audience = new Map<string, PollAudience>();

  setAudience(pollId: string, audience: PollAudience): void {
    this.audience.set(pollId, audience);
  }

  getAudience(pollId: string): PollAudience {
    return this.audience.get(pollId) ?? 'public';
  }

  record(rec: ResponseRecord): void {
    const list = this.responses.get(rec.pollId) ?? [];
    list.push(rec);
    this.responses.set(rec.pollId, list);
  }

  summary(pollId: string): ProvenanceSummary {
    const list = this.responses.get(pollId) ?? [];
    const proxiedByAgents = list.filter((r) => r.respondentType === 'agent').length;
    const proxiedByHumans = list.filter((r) => r.respondentType === 'human').length;
    return {
      proxiedResponses: list.length,
      proxiedByAgents,
      proxiedByHumans,
      note: 'Counts reflect only responses submitted through Shadow Policy MCP. Responses made directly on the Shadow Labz app are included in the backend tally but are not individually attributable here.',
    };
  }
}
