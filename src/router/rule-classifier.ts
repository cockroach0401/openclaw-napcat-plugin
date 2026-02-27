export type RouteAgentId = "acm" | "tool" | "main";

export interface RuleClassifyMeta {
    hasFileAttachment: boolean;
    isGroup: boolean;
    senderId: string;
}

export interface RuleClassifyResult {
    agentId: RouteAgentId;
    confidence: number;
    reason: string;
}

const ACM_KEYWORDS = [
    "证明",
    "推导",
    "设计方案",
    "架构设计",
    "算法分析",
    "数学",
];

const TOOL_KEYWORDS = [
    "搜索",
    "查一下",
    "最新新闻",
    "天气预报",
    "运行代码",
    "执行命令",
];

function normalizeText(input: string): string {
    return String(input || "").trim().toLowerCase();
}

function hitKeywordCount(text: string, keywords: string[]): number {
    return keywords.filter((kw) => text.includes(kw)).length;
}

export function detectHasFileAttachment(event: any): boolean {
    const message = event?.message;
    if (!Array.isArray(message)) return false;
    return message.some((seg: any) => {
        const segmentType = String(seg?.type || "").toLowerCase();
        return ["file", "image", "video", "record", "voice", "audio", "document"].includes(segmentType);
    });
}

export function classifyByRules(text: string, meta: RuleClassifyMeta): RuleClassifyResult | null {
    const normalized = normalizeText(text);
    if (!normalized) return null;

    // 1) 命令前缀（最高置信度）
    if (normalized.startsWith("/search ") || normalized.startsWith("/查 ")) {
        return { agentId: "tool", confidence: 1.0, reason: "command:/search" };
    }
    if (normalized.startsWith("/ask ") || normalized.startsWith("/深度 ")) {
        return { agentId: "acm", confidence: 1.0, reason: "command:/ask" };
    }
    if (normalized.startsWith("/run ") || normalized.startsWith("/exec ")) {
        return { agentId: "tool", confidence: 1.0, reason: "command:/run" };
    }

    // 2) 短语关键词（至少 2 个）
    const acmScore = hitKeywordCount(normalized, ACM_KEYWORDS);
    const toolScore = hitKeywordCount(normalized, TOOL_KEYWORDS);

    if (acmScore >= 2) {
        return { agentId: "acm", confidence: 0.85, reason: "keyword:acm" };
    }
    if (toolScore >= 2) {
        return { agentId: "tool", confidence: 0.85, reason: "keyword:tool" };
    }

    // 3) 消息特征
    if (normalized.length > 500) {
        return { agentId: "acm", confidence: 0.7, reason: "long_message" };
    }
    if (meta.hasFileAttachment) {
        return { agentId: "tool", confidence: 0.8, reason: "file_attachment" };
    }

    // 4) 无法判断
    return null;
}
