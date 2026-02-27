import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { getNapCatRuntime, getNapCatConfig } from "./runtime.js";
import { routeMessage } from "./router/index.js";

// Group name cache removed


// Simple function to send message via NapCat API
async function sendToNapCat(url: string, payload: any) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        throw new Error(`NapCat API Error: ${res.status} ${res.statusText}`);
    }
    return await res.json();
}

function buildMediaProxyUrl(mediaUrl: string, config: any): string {
    const enabled = config.mediaProxyEnabled === true;
    const baseUrl = String(config.publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (!enabled || !baseUrl) return mediaUrl;

    const token = String(config.mediaProxyToken || "").trim();
    const query = new URLSearchParams({ url: mediaUrl });
    if (token) query.set("token", token);
    return `${baseUrl}/napcat/media?${query.toString()}`;
}

function isAudioMedia(mediaUrl: string): boolean {
    return /\.(wav|mp3|amr|silk|ogg|m4a|flac|aac)(?:\?.*)?$/i.test(mediaUrl);
}

function resolveVoiceMediaUrl(mediaUrl: string, config: any): string {
    const trimmed = mediaUrl.trim();
    if (!trimmed) return trimmed;
    if (/^(https?:\/\/|file:\/\/)/i.test(trimmed) || trimmed.startsWith("/")) {
        return trimmed;
    }
    const voiceBasePath = String(config.voiceBasePath || "").trim().replace(/\/+$/, "");
    if (!voiceBasePath) return trimmed;
    return `${voiceBasePath}/${trimmed.replace(/^\/+/, "")}`;
}

function buildNapCatMediaCq(mediaUrl: string, config: any, forceVoice = false): string {
    const shouldUseVoice = forceVoice || isAudioMedia(mediaUrl);
    const resolvedUrl = shouldUseVoice ? resolveVoiceMediaUrl(mediaUrl, config) : mediaUrl;
    const proxiedMediaUrl = buildMediaProxyUrl(resolvedUrl, config);
    const type = shouldUseVoice ? "record" : "image";
    return `[CQ:${type},file=${proxiedMediaUrl}]`;
}

function buildNapCatMessageFromReply(
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; audioAsVoice?: boolean },
    config: any
) {
    const text = payload.text?.trim() || "";
    const mediaCandidates = [
        ...(payload.mediaUrls || []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : [])
    ];
    const mediaSegments = mediaCandidates
        .map((url) => String(url || "").trim())
        .filter(Boolean)
        .map((url) => buildNapCatMediaCq(url, config, payload.audioAsVoice === true));

    if (text && mediaSegments.length > 0) return `${text}\n${mediaSegments.join("\n")}`;
    if (text) return text;
    return mediaSegments.join("\n");
}

function isScheduledReplyPayload(payload: any): boolean {
    if (!payload || typeof payload !== "object") return false;

    const source = String(payload.source || "").toLowerCase();
    const trigger = String(payload.trigger || "").toLowerCase();
    const replyType = String(payload.replyType || "").toLowerCase();

    const metadata = payload.meta && typeof payload.meta === "object"
        ? payload.meta
        : payload.metadata && typeof payload.metadata === "object"
            ? payload.metadata
            : payload.extra && typeof payload.extra === "object"
                ? payload.extra
                : null;

    const metaSource = String(metadata?.source || "").toLowerCase();
    const metaTrigger = String(metadata?.trigger || "").toLowerCase();
    const metaKind = String(metadata?.kind || "").toLowerCase();

    return (
        payload.isScheduled === true ||
        payload.scheduled === true ||
        payload.fromSchedule === true ||
        payload.fromScheduler === true ||
        payload.replyOptions?.isScheduled === true ||
        metadata?.isScheduled === true ||
        metadata?.scheduled === true ||
        source === "schedule" ||
        source === "scheduler" ||
        trigger === "schedule" ||
        trigger === "scheduler" ||
        replyType === "scheduled" ||
        metaSource === "schedule" ||
        metaSource === "scheduler" ||
        metaTrigger === "schedule" ||
        metaTrigger === "scheduler" ||
        metaKind === "schedule" ||
        metaKind === "scheduler"
    );
}

function shouldBypassSilentModeForAgent(payload: any, currentAgentId: string): boolean {
    if (!payload || typeof payload !== "object") return false;

    const normalizedCurrentAgentId = String(currentAgentId || "").trim().toLowerCase();
    if (!normalizedCurrentAgentId || normalizedCurrentAgentId === "main") return false;

    const metadata = payload.meta && typeof payload.meta === "object"
        ? payload.meta
        : payload.metadata && typeof payload.metadata === "object"
            ? payload.metadata
            : payload.extra && typeof payload.extra === "object"
                ? payload.extra
                : null;

    const payloadAgentId = String(payload.agentId || "").trim().toLowerCase();
    const metaAgentId = String(metadata?.agentId || "").trim().toLowerCase();
    const source = String(payload.source || "").trim().toLowerCase();
    const metaSource = String(metadata?.source || "").trim().toLowerCase();

    const candidateAgentId = payloadAgentId || metaAgentId;
    if (candidateAgentId && candidateAgentId !== normalizedCurrentAgentId) return false;

    if (payload.bypassSilentMode === true) return true;
    if (payload.replyOptions?.bypassSilentMode === true) return true;
    if (metadata?.bypassSilentMode === true) return true;

    if (candidateAgentId === normalizedCurrentAgentId) return true;
    if (source === normalizedCurrentAgentId || metaSource === normalizedCurrentAgentId) return true;

    return false;
}

function getContentTypeByPath(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
    if (ext === ".bmp") return "image/bmp";
    if (ext === ".svg") return "image/svg+xml";
    return "application/octet-stream";
}

async function handleMediaProxyRequest(res: ServerResponse, url: string): Promise<boolean> {
    const config = getNapCatConfig();
    if (config.mediaProxyEnabled !== true) {
        res.statusCode = 404;
        res.end("not found");
        return true;
    }

    const parsed = new URL(url, "http://127.0.0.1");
    if (parsed.pathname !== "/napcat/media") {
        res.statusCode = 404;
        res.end("not found");
        return true;
    }

    const expectedToken = String(config.mediaProxyToken || "").trim();
    const token = String(parsed.searchParams.get("token") || "").trim();
    if (expectedToken && token !== expectedToken) {
        res.statusCode = 403;
        res.end("forbidden");
        return true;
    }

    const mediaUrl = String(parsed.searchParams.get("url") || "").trim();
    if (!mediaUrl) {
        res.statusCode = 400;
        res.end("missing url");
        return true;
    }

    try {
        if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
            const upstream = await fetch(mediaUrl);
            if (!upstream.ok) {
                res.statusCode = 502;
                res.end(`upstream fetch failed: ${upstream.status}`);
                return true;
            }
            const contentType = upstream.headers.get("content-type") || "application/octet-stream";
            res.statusCode = 200;
            res.setHeader("Content-Type", contentType);
            const buffer = Buffer.from(await upstream.arrayBuffer());
            res.setHeader("Content-Length", buffer.length);
            res.end(buffer);
            return true;
        }

        let filePath = mediaUrl;
        if (mediaUrl.startsWith("file://")) {
            filePath = decodeURIComponent(new URL(mediaUrl).pathname);
        }
        if (!filePath.startsWith("/")) {
            res.statusCode = 400;
            res.end("unsupported media url");
            return true;
        }

        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            res.statusCode = 404;
            res.end("file not found");
            return true;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", getContentTypeByPath(filePath));
        res.setHeader("Content-Length", fileStat.size);
        createReadStream(filePath).pipe(res);
        return true;
    } catch (err) {
        console.error("[NapCat] Media proxy error:", err);
        res.statusCode = 500;
        res.end("media proxy error");
        return true;
    }
}

async function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => {
            try {
                if (!data) {
                    resolve({});
                    return;
                }
                resolve(JSON.parse(data));
            } catch (e) {
                console.error("NapCat JSON Parse Error:", e);
                // Some deployments send form-urlencoded bodies with nested JSON payload.
                try {
                    const params = new URLSearchParams(data);
                    const wrapped = params.get("payload") || params.get("data") || params.get("message");
                    if (wrapped) {
                        resolve(JSON.parse(wrapped));
                        return;
                    }
                } catch {
                    // Fall through and preserve raw body for diagnostics.
                }
                resolve({ __raw: data, __parseError: true });
            }
        });
        req.on("error", reject);
    });
}

function sanitizeLogToken(raw: string): string {
    return String(raw || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getInboundLogFilePath(body: any, config: any): string {
    const isGroup = body?.message_type === "group";
    const baseDirRaw = String(config.inboundLogDir || "./logs/napcat-inbound").trim() || "./logs/napcat-inbound";
    const baseDir = resolve(baseDirRaw);
    if (isGroup) {
        const groupId = sanitizeLogToken(String(body?.group_id || "unknown_group"));
        return resolve(baseDir, `group-${groupId}.log`);
    }
    const userId = sanitizeLogToken(String(body?.user_id || "unknown_user"));
    return resolve(baseDir, `qq-${userId}.log`);
}

async function logInboundMessage(body: any, config: any): Promise<void> {
    if (config.enableInboundLogging === false) return;
    if (body?.post_type !== "message" && body?.post_type !== "message_sent") return;

    const filePath = getInboundLogFilePath(body, config);
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        post_type: body.post_type,
        message_type: body.message_type,
        self_id: body.self_id,
        user_id: body.user_id,
        group_id: body.group_id,
        message_id: body.message_id,
        raw_message: body.raw_message || "",
        sender: body.sender || {},
    }) + "\n";

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
}

async function logInboundParseFailure(rawBody: string, config: any): Promise<void> {
    if (config.enableInboundLogging === false) return;
    const baseDirRaw = String(config.inboundLogDir || "./logs/napcat-inbound").trim() || "./logs/napcat-inbound";
    const filePath = resolve(baseDirRaw, "parse-error.log");
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        kind: "parse_error",
        raw_body: rawBody,
    }) + "\n";
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
}

function extractNapCatEvents(body: any): any[] {
    if (!body || typeof body !== "object") return [];
    if (Array.isArray(body)) return body.filter((item) => item && typeof item === "object");
    if (body.post_type) return [body];
    if (Array.isArray(body.events)) return body.events.filter((item: any) => item && typeof item === "object");
    if (Array.isArray(body.data)) return body.data.filter((item: any) => item && typeof item === "object");
    if (body.data && typeof body.data === "object") return [body.data];
    if (body.payload && typeof body.payload === "object") return [body.payload];
    return [];
}

export async function handleNapCatWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url || "";
    const method = req.method || "UNKNOWN";
    
    console.log(`[NapCat] Incoming request: ${method} ${url}`);
    
    // Accept /napcat, /napcat/, or any path starting with /napcat
    if (!url.startsWith("/napcat")) return false;

    if (method === "GET") {
        return handleMediaProxyRequest(res, url);
    }
    
    if (method !== "POST") {
        // For non-POST requests to /napcat endpoints, return 405
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"error","message":"Method Not Allowed"}');
        return true;
    }

    try {
        const body = await readBody(req);
        const config = getNapCatConfig();
        const events = extractNapCatEvents(body);

        try {
            if (body?.__parseError && typeof body.__raw === "string" && body.__raw.trim()) {
                await logInboundParseFailure(body.__raw, config);
            }
            for (const event of events) {
                await logInboundMessage(event, config);
            }
        } catch (err) {
            console.error("[NapCat] Failed to write inbound log:", err);
        }

        const event = events[0] || body;

        // Heartbeat / Lifecycle
        if (event.post_type === "meta_event") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        if (event.post_type === "message") {
            const runtime = getNapCatRuntime();
            const isGroup = event.message_type === "group";
            // Ensure senderId is numeric string
            const senderId = String(event.user_id);
            // Safety check: if senderId looks like a name (non-numeric), log warning
            if (!/^\d+$/.test(senderId)) {
                console.warn(`[NapCat] WARNING: user_id is not numeric: ${senderId}`);
            }
            const rawText = event.raw_message || "";
            let text = rawText;

            const parseSimpleIdList = (value: any): string[] => {
                if (Array.isArray(value)) {
                    return value
                        .flatMap((item) => parseSimpleIdList(item))
                        .map((item) => String(item).trim())
                        .filter(Boolean);
                }
                if (value === null || value === undefined) return [];
                if (typeof value === "number" || typeof value === "bigint") return [String(value)];
                if (typeof value === "string") {
                    const raw = value.trim();
                    if (!raw) return [];
                    if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
                        try {
                            return parseSimpleIdList(JSON.parse(raw));
                        } catch {
                            // Ignore JSON parse failures and fallback to split.
                        }
                    }
                    return raw
                        .split(/[\s,;|]+/)
                        .map((item) => item.trim())
                        .filter(Boolean);
                }
                if (typeof value === "object") {
                    return parseSimpleIdList((value as any).id)
                        .concat(parseSimpleIdList((value as any).qq))
                        .concat(parseSimpleIdList((value as any).uin))
                        .concat(parseSimpleIdList((value as any).user_id));
                }
                return [];
            };

            // Get allowUsers from config
            const allowUsers = parseSimpleIdList(config.allowUsers);
            const isAllowUser = allowUsers.includes(senderId);

            // Check allowlist logic
            // If allowUsers is configured, only listed users should trigger the bot.
            // This applies to both DMs and Group chats.
            if (allowUsers.length > 0 && !isAllowUser) {
                console.log(`[NapCat] Ignoring message from ${senderId} (not in allowlist)`);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"ok"}');
                return true;
            }

            // Group message handling
            const enableGroupMessages = config.enableGroupMessages || false;
            const silentGroupIds = parseSimpleIdList(config.groupSilentMode);
            const isLegacyGlobalSilentMode = config.groupSilentMode === true;

            // Legacy default true: require @ mention in group chats (unless groupSilentMode hits).
            const groupMentionOnly = config.groupMentionOnly !== false;

            // Optional per-group override: if set (non-empty), only these groups require @ when groupMentionOnly is true.
            const groupMentionOnlyGroups = parseSimpleIdList(
                config.groupMentionOnlyGroups ??
                    config.groupMentionOnlyGroupIds ??
                    config.mentionOnlyGroups
            );
            let isSilentModeForCurrentGroup = false;
            let wasMentioned = !isGroup; // In DMs, we consider it "mentioned"

            if (isGroup) {
                if (!enableGroupMessages) {
                    // Group messages disabled - ignore
                    console.log(`[NapCat] Ignoring group message (group messages disabled)`);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end('{"status":"ok"}');
                    return true;
                }

                const groupId = String(event.group_id || "").trim();
                isSilentModeForCurrentGroup =
                    silentGroupIds.includes(groupId) ||
                    (isLegacyGlobalSilentMode && !silentGroupIds.length);

                const botId = event.self_id || config.selfId;
                let isMentioned = false;

                if (botId) {
                    // Check for bot mention in raw_message
                    // Support two formats:
                    // 1. CQ code format: [CQ:at,qq={botId}] or [CQ:at,qq=all]
                    // 2. Plain text format: @Nickname (botId) or @botId
                    const mentionPatternCQ = new RegExp(`\\[CQ:at,qq=${botId}\\]`, 'i');
                    const allMentionPatternCQ = /\[CQ:at,qq=all\]/i;

                    // Plain text mention patterns: @xxx (123456) or @123456
                    const mentionPatternPlain1 = new RegExp(`@[^\\s]+ \\(${botId}\\)`, 'i');
                    const mentionPatternPlain2 = new RegExp(`@${botId}(?:\\s|$|,)`, 'i');

                    const isMentionedCQ = mentionPatternCQ.test(text) || allMentionPatternCQ.test(text);
                    const isMentionedPlain = mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);
                    isMentioned = isMentionedCQ || isMentionedPlain;
                } else {
                    console.log(`[NapCat] Cannot determine bot ID for mention detection`);
                }

                wasMentioned = isMentioned;

                // Legacy behavior (when per-group silent mode is not enabled for current group):
                // require mention before forwarding to agent.
                const shouldRequireMention =
                    groupMentionOnly &&
                    (groupMentionOnlyGroups.length === 0 || groupMentionOnlyGroups.includes(groupId));

                if (!isSilentModeForCurrentGroup && shouldRequireMention && !wasMentioned) {
                    console.log(`[NapCat] Ignoring group message (bot not mentioned)`);
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end('{"status":"ok"}');
                    return true;
                }

                if (isSilentModeForCurrentGroup && !wasMentioned) {
                    console.log(`[NapCat] Group silent mode active for group ${groupId}: forward to agent but mute reply (bot not mentioned)`);
                } else if (wasMentioned) {
                    console.log(`[NapCat] Bot mentioned in group, processing message`);
                }

                // Strip mentions from text for cleaner processing and command detection
                if (botId) {
                    const stripCQ = new RegExp(`^\\[CQ:at,qq=${botId}\\]\\s*`, 'i');
                    const stripAll = /^\[CQ:at,qq=all\]\s*/i;
                    const stripPlain1 = new RegExp(`^@[^\\s]+ \\(${botId}\\)\\s*`, 'i');
                    const stripPlain2 = new RegExp(`^@${botId}(?:\\s|$|,)\\s*`, 'i');
                    text = text.replace(stripCQ, '').replace(stripAll, '').replace(stripPlain1, '').replace(stripPlain2, '').trim();
                }
            }

            const messageId = String(event.message_id);
            // OpenClaw convention: conversationId differentiates chats
            // We prefix with type to help outbound routing
            const conversationId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;
            const senderName = event.sender?.nickname || senderId;
            const parseBoolLoose = (value: any): boolean => {
                if (typeof value === "boolean") return value;
                if (typeof value === "number") return value === 1;
                if (typeof value === "string") {
                    const normalized = value.trim().toLowerCase();
                    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
                }
                return false;
            };
            const parseIdList = (value: any): string[] => {
                if (Array.isArray(value)) return value.flatMap((item) => parseIdList(item));
                if (value === null || value === undefined) return [];
                if (typeof value === "number" || typeof value === "bigint") return [String(value)];
                if (typeof value === "string") {
                    const raw = value.trim();
                    if (!raw) return [];
                    if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
                        try {
                            return parseIdList(JSON.parse(raw));
                        } catch {
                            // Ignore JSON parse failures and fallback to split.
                        }
                    }
                    return raw
                        .split(/[\s,;|]+/)
                        .map((item) => item.trim())
                        .filter(Boolean);
                }
                if (typeof value === "object") {
                    return [
                        ...parseIdList(value.id),
                        ...parseIdList(value.qq),
                        ...parseIdList(value.uin),
                        ...parseIdList(value.user_id),
                    ];
                }
                return [];
            };

            const ownerConfigInputs = [
                config.ownerId,
                config.ownerQQ,
                config.ownerUin,
                config.ownerIds,
                config.ownerQQs,
                config.ownerUins,
                config.owner,
                config.owners,
                config.master,
                config.masters,
                config.masterQQ,
                config.masterUin,
                config.superUser,
                config.superUsers,
                config.superusers,
                config.botOwner,
                config.botOwners,
                config.onebot?.owner,
                config.onebot?.owners,
                config.onebot?.superUser,
                config.onebot?.superUsers,
                config.onebot?.superusers,
                config.napcat?.owner,
                config.napcat?.owners,
                config.napcat?.superUser,
                config.napcat?.superUsers,
                config.napcat?.superusers,
            ];
            const adminConfigInputs = [
                config.adminId,
                config.adminQQ,
                config.adminUin,
                config.adminIds,
                config.adminQQs,
                config.adminUins,
                config.admin,
                config.admins,
                config.manager,
                config.managers,
                config.moderator,
                config.moderators,
                config.onebot?.admin,
                config.onebot?.admins,
                config.onebot?.manager,
                config.onebot?.managers,
                config.napcat?.admin,
                config.napcat?.admins,
                config.napcat?.manager,
                config.napcat?.managers,
            ];
            const hasExplicitOwnerConfig = ownerConfigInputs.some((value) => parseIdList(value).length > 0);

            const ownerIdCandidates = Array.from(
                new Set(
                    [
                        ...ownerConfigInputs,
                        // 兜底：未配置 owner 字段时，且 allowUsers 仅 1 人，则视为机器人主人
                        !hasExplicitOwnerConfig && Array.isArray(config.allowUsers) && config.allowUsers.length === 1
                            ? config.allowUsers
                            : [],
                    ].flatMap((item) => parseIdList(item))
                )
            );
            const adminIdCandidates = Array.from(new Set(adminConfigInputs.flatMap((item) => parseIdList(item))));

            const senderIsOwnerFromEvent =
                parseBoolLoose(event.sender?.is_owner) ||
                parseBoolLoose(event.is_owner) ||
                parseBoolLoose(event.sender?.isOwner) ||
                parseBoolLoose(event.isOwner) ||
                parseBoolLoose(event.sender?.is_master) ||
                parseBoolLoose(event.is_master) ||
                parseBoolLoose(event.sender?.isMaster) ||
                parseBoolLoose(event.isMaster);
            const senderRole = String(event.sender?.role || "").trim().toLowerCase();
            const senderIsAdminFromEvent =
                parseBoolLoose(event.sender?.is_admin) ||
                parseBoolLoose(event.is_admin) ||
                parseBoolLoose(event.sender?.isAdmin) ||
                parseBoolLoose(event.isAdmin) ||
                senderRole === "admin";

            const senderIsOwner = senderIsOwnerFromEvent || ownerIdCandidates.includes(senderId);
            const senderIsAdmin = senderIsOwner || senderIsAdminFromEvent || adminIdCandidates.includes(senderId);

            // Command authorization strategy (most-specific wins):
            // 1) explicit commandAuthorizedUsers list
            // 2) owner/admin (if any owner/admin config exists)
            // 3) allowUsers (if configured)
            // 4) fallback allow all (backward compatible)
            const commandAuthConfigInputs = [
                config.commandAuthorizedUsers,
                config.commandAllowUsers,
                config.commandUsers,
                config.napcat?.commandAuthorizedUsers,
                config.onebot?.commandAuthorizedUsers,
            ];
            const commandAuthorizedCandidates = Array.from(
                new Set(commandAuthConfigInputs.flatMap((item) => parseIdList(item)))
            );
            const hasExplicitOwnerOrAdminConfig = ownerIdCandidates.length > 0 || adminIdCandidates.length > 0;

            let computedCommandAuthorized = true;
            let commandAuthSource = "fallback_true";

            if (commandAuthorizedCandidates.length > 0) {
                computedCommandAuthorized = commandAuthorizedCandidates.includes(senderId);
                commandAuthSource = "commandAuthorizedUsers";
            } else if (hasExplicitOwnerOrAdminConfig) {
                computedCommandAuthorized = senderIsOwner || senderIsAdmin;
                commandAuthSource = "owner_admin";
            } else if (allowUsers.length > 0) {
                computedCommandAuthorized = isAllowUser;
                commandAuthSource = "allowUsers";
            }

            // Diagnostic auth log (avoid leaking full config; only counts and booleans)
            console.log(
                `[NapCat] Auth diagnostics: sender=${senderId} ` +
                `isAllowUser=${isAllowUser} allowUsersCount=${allowUsers.length} ` +
                `ownerCandidates=${ownerIdCandidates.length} adminCandidates=${adminIdCandidates.length} ` +
                `senderIsOwner=${senderIsOwner} senderIsAdmin=${senderIsAdmin} ` +
                `commandAuthCandidates=${commandAuthorizedCandidates.length} ` +
                `CommandAuthorized=${computedCommandAuthorized} source=${commandAuthSource}`
            );

            const senderMetaName = event.sender?.nickname ? `${event.sender.nickname} (${senderId})` : senderId;
            const senderMeta = {
                label: senderId,
                name: senderMetaName,
                is_owner: senderIsOwner,
                is_admin: senderIsAdmin,
            };

            // Generate NapCat base session key by conversation type
            // Base format: session:napcat:private:{userId} or session:napcat:group:{groupId}
            const baseSessionKey = isGroup 
                ? `session:napcat:group:${event.group_id}`
                : `session:napcat:private:${senderId}`;
            const cfg = runtime.config?.loadConfig?.() || {};

            // Resolve route for this message with specific session key
            // Note: OpenClaw SDK ignores the sessionKey param, so we must override it after
            const resolvedRoute = await runtime.channel.routing.resolveAgentRoute({
                channel: "napcat",
                conversationId,
                senderId,
                text,
                cfg,
                ctx: {},
            });
            const route = (resolvedRoute && typeof resolvedRoute === "object") ? resolvedRoute : {};

            const enableRouting = parseBoolLoose(config.enableRouting ?? true);
            const routeDecision = enableRouting
                ? await routeMessage(text, { isGroup, senderId, config, event })
                : null;

            const configuredAgentId = String(config.agentId || "").trim().toLowerCase();
            const routeDecisionAgentId = String(routeDecision?.agentId || "").trim().toLowerCase();
            const routeAgentId = String(route?.agentId || "").trim().toLowerCase();
            const effectiveAgentId =
                configuredAgentId ||
                routeDecisionAgentId ||
                routeAgentId ||
                "main";
            const sessionKey = `agent:${effectiveAgentId}:${baseSessionKey}`;

            // User requested to use session key as display name for consistency
            const sessionDisplayName = sessionKey;

            // Log for debugging
            console.log(`[NapCat] Inbound from ${senderId} (session: ${sessionKey}): ${text.substring(0, 50)}...`);
            if (configuredAgentId && configuredAgentId !== routeDecisionAgentId && configuredAgentId !== routeAgentId) {
                const overrideFrom = routeDecisionAgentId || routeAgentId || "none";
                console.log(`[NapCat] Override route agent by config: ${overrideFrom} -> ${configuredAgentId}`);
            }
            console.log(`[NapCat] Route: agentId=${effectiveAgentId}, reason=${routeDecision?.reason || "default"}`);

            if (isGroup) {
                const groupIdForLog = String(event.group_id || "").trim();
                console.log(
                    `[NapCat] Group diagnostics: groupId=${groupIdForLog} ` +
                    `enableGroupMessages=${enableGroupMessages} ` +
                    `isSilentModeForCurrentGroup=${isSilentModeForCurrentGroup} ` +
                    `groupMentionOnly=${groupMentionOnly} wasMentioned=${wasMentioned}`
                );
            }

            // Forward group messages with sender QQ for better identity recognition.
            const textForAgent = isGroup ? `[QQ:${senderId}] ${text}` : text;

            // Force our custom session key and configured agent
            route.agentId = effectiveAgentId;
            route.sessionKey = sessionKey;

            // Build ctxPayload using runtime methods
            const ctxPayload = {
                Body: textForAgent,
                RawBody: rawText,
                CommandBody: textForAgent,
                From: `napcat:${conversationId}`,
                To: "me",
                SessionKey: sessionKey,  // Use our custom session key
                SessionDisplayName: sessionDisplayName,
                displayName: sessionDisplayName,
                name: sessionDisplayName,
                Title: sessionDisplayName,
                ConversationTitle: sessionDisplayName,
                Topic: sessionDisplayName,
                Subject: sessionDisplayName,
                AccountId: route.accountId,
                ChatType: isGroup ? "group" : "direct",
                ConversationLabel: sessionKey,
                SenderName: senderName,
                SenderId: senderId,
                Sender: senderMeta,
                Provider: "napcat",
                Surface: "napcat",
                MessageSid: messageId,
                WasMentioned: wasMentioned,

                CommandAuthorized: computedCommandAuthorized,
                CommandAuthSource: commandAuthSource,

                OriginatingChannel: "napcat",
                OriginatingTo: conversationId,
            };

            // Create dispatcher for replies
            let dispatcher = null;
            
            // Store conversationId for reply routing
            const replyTarget = conversationId;
            const muteUnmentionedGroupReply = isGroup && isSilentModeForCurrentGroup && !wasMentioned;
            const shouldBypassSilentMode = (payload: any) =>
                isScheduledReplyPayload(payload) || shouldBypassSilentModeForAgent(payload, effectiveAgentId);
            
            if (runtime.channel.reply.createReplyDispatcherWithTyping) {
                console.log("[NapCat] Calling createReplyDispatcherWithTyping...");
                const result = await runtime.channel.reply.createReplyDispatcherWithTyping({
                    responsePrefix: "",
                    responsePrefixContextProvider: () => ({}),
                    humanDelay: 0,
                    deliver: async (payload: any) => {
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        if (muteUnmentionedGroupReply && !shouldBypassSilentMode(payload)) {
                            console.log("[NapCat] Group silent mode muted reply (not @ and not bypass payload)");
                            return;
                        }
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = buildNapCatMessageFromReply(payload, config);
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload: any = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${message.substring(0, 50)}...`);
                        await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload);
                        console.log("[NapCat] Reply sent successfully");
                    },
                    onError: (err: any, info: any) => {
                        console.error(`[NapCat] Reply error (${info.kind}):`, err);
                    },
                    onReplyStart: () => {},
                    onIdle: () => {},
                });
                dispatcher = result.dispatcher;
            } else if (runtime.channel.reply.createReplyDispatcher) {
                dispatcher = runtime.channel.reply.createReplyDispatcher({
                    responsePrefix: "",
                    responsePrefixContextProvider: () => ({}),
                    humanDelay: 0,
                    deliver: async (payload: any) => {
                        console.log("[NapCat] Reply to deliver:", JSON.stringify(payload).substring(0, 100));
                        if (muteUnmentionedGroupReply && !shouldBypassSilentMode(payload)) {
                            console.log("[NapCat] Group silent mode muted reply (not @ and not bypass payload)");
                            return;
                        }
                        // Actually send the message via NapCat API
                        const config = getNapCatConfig();
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const isGroup = conversationId.startsWith("group:");
                        const targetId = isGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                        const endpoint = isGroup ? "/send_group_msg" : "/send_private_msg";
                        const message = buildNapCatMessageFromReply(payload, config);
                        if (!message) {
                            console.log("[NapCat] Skip empty reply payload");
                            return;
                        }
                        const msgPayload: any = { message };
                        if (isGroup) msgPayload.group_id = targetId;
                        else msgPayload.user_id = targetId;
                        
                        console.log(`[NapCat] Sending reply to ${isGroup ? 'group' : 'private'} ${targetId}: ${message.substring(0, 50)}...`);
                        await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload);
                        console.log("[NapCat] Reply sent successfully");
                    },
                    onError: (err: any, info: any) => {
                        console.error(`[NapCat] Reply error (${info.kind}):`, err);
                    },
                });
            }

            if (!dispatcher) {
                console.error("[NapCat] Could not create dispatcher");
                res.statusCode = 503;
                res.setHeader("Content-Type", "application/json");
                res.end('{"status":"error","message":"dispatcher creation failed"}');
                return true;
            }

            console.log("[NapCat] Dispatcher created, methods:", Object.keys(dispatcher));

            // Send immediate "收到" acknowledgment for non-main agents (tool/acm)
            // then dispatch asynchronously so the user knows their request is being processed
            const isNonMainAgent = effectiveAgentId !== "main";
            if (isNonMainAgent) {
                const ackConfig = getNapCatConfig();
                const ackBaseUrl = ackConfig.url || "http://127.0.0.1:3000";
                const ackIsGroup = conversationId.startsWith("group:");
                const ackTargetId = ackIsGroup ? conversationId.replace("group:", "") : conversationId.replace("private:", "");
                const ackEndpoint = ackIsGroup ? "/send_group_msg" : "/send_private_msg";
                const agentLabel = effectiveAgentId === "acm" ? "深度推理" : effectiveAgentId === "tool" ? "工具搜索" : effectiveAgentId;
                const ackMessage = `收到，正在调用 ${agentLabel} 处理，请稍候...`;
                const ackPayload: any = { message: ackMessage };
                if (ackIsGroup) ackPayload.group_id = ackTargetId;
                else ackPayload.user_id = ackTargetId;

                // Send ack without blocking the dispatch (fire-and-forget with error logging)
                sendToNapCat(`${ackBaseUrl}${ackEndpoint}`, ackPayload)
                    .then(() => console.log(`[NapCat] Ack sent for ${effectiveAgentId} agent`))
                    .catch((err) => console.error(`[NapCat] Ack send failed:`, err));
            }

            // Dispatch the message to OpenClaw
            await runtime.channel.reply.dispatchReplyFromConfig({
                ctx: ctxPayload,
                cfg,
                dispatcher,
                replyOptions: {},
            });
            
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        // Default OK for handled path
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"ok"}');
        return true;
    } catch (err) {
        console.error("NapCat Webhook Error:", err);
        res.statusCode = 500;
        res.end("error");
        return true;
    }
}
