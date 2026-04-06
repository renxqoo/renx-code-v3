import type { AgentRunContext, ApprovalDecision, ApprovalEngine, ApprovalTicket } from "../types";
import type { AgentTool } from "../tool/types";
import { getToolRiskLevel, hasToolCapabilityTag, type ToolRiskLevel } from "../tool/capability";

export type ApprovalApproverScope = "user" | "tenant" | "org";

export interface ApprovalRule {
  id: string;
  match?: {
    toolNames?: string[];
    minimumRiskLevel?: ToolRiskLevel;
    capabilityTags?: string[];
  };
  requireApproval: boolean;
  approverScope: ApprovalApproverScope;
  reason: string;
}

const RISK_ORDER: Record<ToolRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export class InMemoryApprovalDecisionStore {
  private readonly tickets = new Map<string, ApprovalTicket>();
  private readonly decisions = new Map<string, ApprovalDecision>();

  async saveTicket(ticket: ApprovalTicket): Promise<void> {
    this.tickets.set(ticket.id, ticket);
  }

  async getTicket(ticketId: string): Promise<ApprovalTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async decide(ticketId: string, decision: ApprovalDecision): Promise<void> {
    this.decisions.set(ticketId, decision);
  }

  async getDecision(ticketId: string): Promise<ApprovalDecision | null> {
    return this.decisions.get(ticketId) ?? null;
  }
}

export class RuleBasedApprovalEngine implements ApprovalEngine {
  constructor(
    private readonly store: InMemoryApprovalDecisionStore,
    private readonly rules: ApprovalRule[],
  ) {}

  async evaluate(
    _ctx: AgentRunContext,
    tool: AgentTool,
    _input: unknown,
  ): Promise<{
    required: boolean;
    reason?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  }> {
    const riskLevel = getToolRiskLevel(tool);
    const matchedRule = this.rules.find((rule) => this.matches(rule, tool, riskLevel));
    if (!matchedRule || !matchedRule.requireApproval) {
      return { required: false };
    }

    return {
      required: true,
      reason: matchedRule.reason,
      metadata: {
        ruleId: matchedRule.id,
        riskLevel,
        approverScope: matchedRule.approverScope,
        auditCategory: tool.profile?.auditCategory ?? "general",
      },
    };
  }

  async request(_ctx: AgentRunContext, ticket: ApprovalTicket): Promise<void> {
    await this.store.saveTicket(ticket);
  }

  async getDecision(_ctx: AgentRunContext, ticketId: string): Promise<ApprovalDecision | null> {
    return await this.store.getDecision(ticketId);
  }

  private matches(rule: ApprovalRule, tool: AgentTool, riskLevel: ToolRiskLevel): boolean {
    const match = rule.match;
    if (!match) return true;
    if (match.toolNames && !match.toolNames.includes(tool.name)) return false;
    if (match.minimumRiskLevel && RISK_ORDER[riskLevel] < RISK_ORDER[match.minimumRiskLevel]) {
      return false;
    }
    if (
      match.capabilityTags &&
      !match.capabilityTags.every((tag) => hasToolCapabilityTag(tool, tag))
    ) {
      return false;
    }
    return true;
  }
}
