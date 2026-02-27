import { createHash } from "node:crypto";
import { ClassifierCache } from "./classifier-cache.js";

export type LLMRouteAgentId = "acm" | "tool" | "main";

export interface LLMClassifyResult {
    agentId: LLMRouteAgentId;
    confidence: number;
    reason: string;
}

const CLASSIFIER_PROMPT = `你是一个消息分类器。判断用户消息应由哪个 Agent 处理。

Agent 类型:
- "acm": 复杂推理、数学证明、深度分析、架构设计
- "tool": 需要工具的任务 — 网络搜索、文件操作、代码执行
- "main": 日常问答、闲聊、简单问题

只回复 JSON: {"agent":"acm|tool|main","confidence":0.0-1.0}`;

const cache = new ClassifierCache<LLMClassifyResult>(1000, 5 * 60 * 1000);

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

function parseNumber(value: any, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return n;
    }
    return fallback;
}

function normalizeAgent(raw: any): LLMRouteAgentId {
    const v = String(raw || "").trim().toLowerCase();
    if (v === "acm" || v === "tool" || v === "main") return v;
    return "main";
}

function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function extractJsonObject(raw: string): any {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        // continue
    }

    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

export async function classifyByLLM(text: string, config: any): Promise<LLMClassifyResult | null> {
    const enabled = parseBoolean(config?.enableLLMClassifier, true);
    if (!enabled) return null;

    const model = String(config?.llmClassifierModel || "sat/gpt-5.2-low").trim() || "sat/gpt-5.2-low";
    const timeoutMs = Math.max(500, parseNumber(config?.llmClassifierTimeout, 3000));

    const apiBase = String(
        config?.newApiBaseUrl ||
        process.env.NEW_API_BASE ||
        process.env.NEWAPI_BASE ||
        ""
    ).trim().replace(/\/+$/, "");
    const apiKey = String(
        config?.newApiKey ||
        process.env.NEW_API_KEY ||
        process.env.NEWAPI_KEY ||
        ""
    ).trim();

    if (!apiBase || !apiKey) {
        return null;
    }

    const cacheKey = `${model}:${hashText(text)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${apiBase}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: CLASSIFIER_PROMPT },
                    { role: "user", content: `用户消息: ${text}` },
                ],
                max_tokens: 64,
                temperature: 0,
            }),
            signal: controller.signal,
        });

        if (!response.ok) return null;
        const data = await response.json();
        const content = String(data?.choices?.[0]?.message?.content || "");
        const parsed = extractJsonObject(content);
        if (!parsed) return null;

        const result: LLMClassifyResult = {
            agentId: normalizeAgent(parsed.agent),
            confidence: Math.max(0, Math.min(1, parseNumber(parsed.confidence, 0.6))),
            reason: "llm_classifier",
        };

        cache.set(cacheKey, result);
        return result;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
