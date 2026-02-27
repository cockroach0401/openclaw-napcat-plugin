import {
    classifyByRules,
    detectHasFileAttachment,
    type RuleClassifyResult,
} from "./rule-classifier.js";
import { classifyByLLM } from "./llm-classifier.js";

export interface RouteMessageInput {
    isGroup: boolean;
    senderId: string;
    config: any;
    event?: any;
}

export interface RouteDecision {
    agentId: "acm" | "tool" | "main";
    reason: string;
    confidence?: number;
    via: "rules" | "llm";
}

function parseBoolean(value: any, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) return true;
        if (["0", "false", "no", "off"].includes(normalized)) return false;
    }
    return fallback;
}

function convertRuleResult(result: RuleClassifyResult): RouteDecision {
    return {
        agentId: result.agentId,
        reason: result.reason,
        confidence: result.confidence,
        via: "rules",
    };
}

export async function routeMessage(text: string, input: RouteMessageInput): Promise<RouteDecision | null> {
    const enableRouting = parseBoolean(input.config?.enableRouting, true);
    if (!enableRouting) return null;

    const hasFileAttachment = detectHasFileAttachment(input.event);
    const byRules = classifyByRules(text, {
        hasFileAttachment,
        isGroup: input.isGroup,
        senderId: input.senderId,
    });

    if (byRules) return convertRuleResult(byRules);

    const byLLM = await classifyByLLM(text, input.config);
    if (byLLM) {
        return {
            agentId: byLLM.agentId,
            reason: byLLM.reason,
            confidence: byLLM.confidence,
            via: "llm",
        };
    }

    return null;
}
