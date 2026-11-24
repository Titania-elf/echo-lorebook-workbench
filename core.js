// Pure selection/state logic. No SillyTavern or browser dependencies.
// Persistent keys / UI IDs remain stable across the directory rename.
import { normalizePromptTemplates } from './prompt-templates.js';
import { validateReplyPlan } from './reply-plan.js';
export { SELECTOR_SYSTEM, SUMMARY_SYSTEM } from './prompt-templates.js';

export const MODULE = 'lorebook-director';
export const EXTENSION_NAME = 'echo-lorebook-workbench';
// Resolve the actual installation folder instead of coupling template paths to storage keys.
export const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1) || EXTENSION_NAME);
export const DEFAULTS = Object.freeze({
    enabled: false, books: [], profileId: '', maxEntries: 8, tokenBudget: 1800,
    recentMessages: 3, replyPlanTokenBudget: 1000, timeoutSeconds: 60, summaries: {},
    apiMode: 'main', apiSchemeId: '', apiSchemes: [],
    promptTemplates: normalizePromptTemplates(), promptRoleVersion: 1,
});
export const HISTORY_LIMIT = 16;

export function settingsWithDefaults(value = {}) {
    const integer = (key, min, max) => {
        const n = Number(value[key] ?? DEFAULTS[key]);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULTS[key];
    };
    const storedRoleVersion = Number.isInteger(value.promptRoleVersion) && value.promptRoleVersion > 0 ? value.promptRoleVersion : 0;
    const promptTemplates = normalizePromptTemplates(value.promptTemplates);
    if (storedRoleVersion < DEFAULTS.promptRoleVersion) {
        // One-time requested role migration; later edits in the role picker remain editable.
        // Only mutate the normalized copies, never the stored prompts or their body/order/toggles.
        for (const [task, entries] of Object.entries(promptTemplates)) {
            for (const entry of entries) {
                entry.role = task === 'selector' && entry.id === 'selector-latest-user' ? 'user' : 'system';
            }
        }
    }
    return {
        enabled: value.enabled === true,
        books: [...new Set((Array.isArray(value.books) ? value.books : []).filter(x => typeof x === 'string'))],
        profileId: typeof value.profileId === 'string' ? value.profileId : '',
        apiMode: ['main', 'scheme', 'profile'].includes(value.apiMode) ? value.apiMode
            : typeof value.profileId === 'string' && value.profileId ? 'profile' : 'main',
        apiSchemeId: typeof value.apiSchemeId === 'string' ? value.apiSchemeId : '',
        apiSchemes: normalizeAPISchemes(value.apiSchemes),
        maxEntries: integer('maxEntries', 1, 30), tokenBudget: integer('tokenBudget', 128, 16000),
        recentMessages: integer('recentMessages', 1, 30), replyPlanTokenBudget: integer('replyPlanTokenBudget', 128, 4000),
        timeoutSeconds: integer('timeoutSeconds', 10, 180),
        summaries: value.summaries && typeof value.summaries === 'object' && !Array.isArray(value.summaries) ? value.summaries : {},
        promptTemplates, promptRoleVersion: Math.max(storedRoleVersion, DEFAULTS.promptRoleVersion),
    };
}

export function normalizeAPISchemes(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).filter(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id || seen.has(value.id)) return false;
        seen.add(value.id);
        return true;
    }).map(value => ({
        id: value.id,
        name: typeof value.name === 'string' ? value.name : '',
        source: value.source === 'main' ? 'main' : 'custom',
        url: typeof value.url === 'string' ? value.url : '',
        apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
        model: typeof value.model === 'string' ? value.model : '',
        models: [...new Set((Array.isArray(value.models) ? value.models : []).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))],
        autoModels: value.autoModels !== false,
    }));
}

export function apiSelection(config) {
    const mode = config.apiMode || (config.profileId ? 'profile' : 'main');
    return mode === 'scheme' ? `scheme:${config.apiSchemeId}` : mode === 'profile' ? `profile:${config.profileId}` : 'main';
}

export function apiSelectionPatch(value) {
    if (value.startsWith('scheme:')) return { apiMode: 'scheme', apiSchemeId: value.slice(7), profileId: '' };
    if (value.startsWith('profile:')) return { apiMode: 'profile', apiSchemeId: '', profileId: value.slice(8) };
    return { apiMode: 'main', apiSchemeId: '', profileId: '' };
}

export function entryId(entry) {
    // JSON tuple avoids collisions between dots/slashes in book names and UIDs.
    return JSON.stringify([String(entry.world), String(entry.uid)]);
}

export function digest(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let a = 2166136261;
    let b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${text.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

export function sourceFingerprint(entry) {
    return digest([entry.comment, entry.key, entry.content]);
}

// Compare saved data with native source arrays regardless of JSON property order.
export function entryVersion(entry) {
    const canonical = value => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        return value;
    };
    const source = { ...entry, uid: String(entry.uid) };
    delete source.world;
    return digest(canonical(source));
}

export function entryKind(entry) {
    return entry.constant ? 'blue' : entry.vectorized ? 'vector' : 'green';
}

export function injectionPosition(entry) {
    return entry.position === 0 ? 'before' : 'after';
}

export function makeCatalog(entries, books, summaries = {}, { applicable = () => true, sources = new Map() } = {}) {
    const managed = new Set(books);
    const seen = new Set();
    return entries.filter(entry => {
        if (!managed.has(entry.world) || entry.disable || entryKind(entry) === 'vector'
            || !String(entry.content || '').trim() || !applicable(entry)) return false;
        const id = entryId(entry);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    }).map(entry => {
        const id = entryId(entry);
        const source = sources.get(id) || entry;
        const fingerprint = sourceFingerprint(source);
        const saved = summaries[id];
        const hasSummary = saved?.fingerprint === fingerprint && typeof saved?.text === 'string' && saved.text.trim();
        return {
            id, entry, fingerprint, kind: entryKind(entry), position: injectionPosition(entry),
            content: String(source.content || ''),
            title: String(entry.comment || (Array.isArray(entry.key) ? entry.key : []).join('、') || `条目 ${entry.uid}`),
            summary: hasSummary ? saved.text.slice(0, 400) : String(source.content).replace(/\s+/g, ' ').slice(0, 240),
            summaryKind: hasSummary ? 'AI 概括' : '原文摘录',
        };
    });
}

export function parseJsonObject(text) {
    if (typeof text !== 'string') throw new Error('模型没有返回文本 JSON。');
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(clean); } catch { throw new Error('模型返回的 JSON 不完整或格式不正确。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型必须返回一个 JSON 对象。');
    return parsed;
}

export function validateSelection(text, catalog, { requireReplyPlan = false, fixedEntries = [] } = {}) {
    const data = parseJsonObject(text);
    if (!Array.isArray(data.selected)) throw new Error('筛选结果缺少 selected 数组。');
    if (data.scene !== undefined && typeof data.scene !== 'string') throw new Error('场景说明必须是文本。');
    const known = new Set(catalog.filter(item => item.kind !== 'blue' && item.kind !== 'vector').map(item => item.id));
    const seen = new Set();
    const selected = [];
    for (const item of data.selected) {
        if (!item || typeof item.id !== 'string' || !known.has(item.id)) {
            throw new Error('模型返回了不在本轮目录中的条目 ID。');
        }
        if (item.scope !== undefined && !['scene', 'turn'].includes(item.scope)) throw new Error('条目 scope 必须是 scene 或 turn。');
        if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('筛选结果缺少条目的选择理由。');
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        selected.push({ id: item.id, scope: item.scope || 'turn', reason: item.reason.slice(0, 240) });
    }
    const result = { scene: (data.scene || '').slice(0, 800), selected };
    if (requireReplyPlan || data.replyPlan !== undefined) {
        result.replyPlan = validateReplyPlan(data.replyPlan, [
            ...fixedEntries.map(item => typeof item === 'string' ? item : item.id),
            ...catalog.filter(item => item.kind === 'blue').map(item => item.id),
            ...selected.map(item => item.id),
        ]);
    }
    return result;
}

export function historyChain(chat) {
    const hashes = [digest('lorebook-director:v1')];
    for (const message of chat) {
        hashes.push(digest([hashes.at(-1), message.is_user, message.is_system, message.name, message.mes]));
    }
    return hashes;
}

export function previousSnapshot(snapshots, chain) {
    return (Array.isArray(snapshots) ? snapshots : [])
        .filter(s => Number.isInteger(s.length) && s.length >= 0 && s.length < chain.length && chain[s.length] === s.hash)
        .sort((a, b) => b.length - a.length || b.at - a.at)[0] || null;
}

export function recordSnapshot(snapshots, chat, result) {
    const chain = historyChain(chat);
    const snapshot = {
        hash: chain.at(-1), length: chat.length, at: Date.now(), scene: result.scene,
        selected: result.selected.filter(x => x.scope === 'scene').map(({ id, scope, reason }) => ({ id, scope, reason })),
    };
    const valid = (Array.isArray(snapshots) ? snapshots : [])
        .filter(s => s.length < snapshot.length && s.length >= 0 && chain[s.length] === s.hash);
    return [...valid, snapshot].slice(-HISTORY_LIMIT);
}

export function recentContext(chat, count) {
    return chat.filter(message => !message.is_user && !message.is_system && String(message.mes || '').trim()).slice(-count)
        .map(message => ({ role: 'assistant', name: message.name || '', text: String(message.mes) }));
}

export function latestUserContext(chat) {
    const message = chat.findLast(value => value.is_user && !value.is_system);
    return message ? { role: 'user', name: message.name || '', text: String(message.mes || '') } : null;
}

export function selectorPayload(catalog, chat, previous, overrides, settings, pinned = [], {
    generationType = 'normal', characterContext = {},
} = {}) {
    const card = item => ({
        id: item.id, book: item.entry.world, title: item.title,
        keywords: Array.isArray(item.entry.key) ? item.entry.key : [],
        secondaryKeywords: Array.isArray(item.entry.keysecondary) ? item.entry.keysecondary : [],
        content: item.content ?? String(item.entry.content || ''),
        position: item.position || injectionPosition(item.entry),
    });
    const pinIds = new Set(pinned.map(item => item.id));
    const green = catalog.filter(item => item.kind !== 'blue' && item.kind !== 'vector');
    const recentChat = recentContext(chat, settings.recentMessages);
    return {
        task: '担任本轮回复的幕后剧情导演兼设定统筹：根据最近 AI 回复、最新用户输入及世界书全文确定唯一主方向，允许设定范围内适度主动推进和引入新事件，并配齐支撑方案的绿灯原文；蓝灯和本轮已纳入的固定绿灯由程序加入。只规划本次回复，不替用户决定行动，不把安排记作事实。',
        generationType, characterContext,
        maxAdditionalGreenEntries: Math.max(0, settings.maxEntries - pinned.length),
        greenTokenBudget: settings.tokenBudget,
        replyPlanTokenBudget: settings.replyPlanTokenBudget ?? DEFAULTS.replyPlanTokenBudget,
        history: { requested: settings.recentMessages, read: recentChat.length, fullText: true },
        recentChat, latestUserMessage: latestUserContext(chat),
        previousScene: previous?.scene || '',
        previousWorkingSet: (previous?.selected || []).filter(choice => choice.scope === 'scene' && green.some(item => item.id === choice.id)),
        blueEntries: catalog.filter(item => item.kind === 'blue').map(card),
        fixedGreenEntries: green.filter(item => pinIds.has(item.id)).map(card),
        greenCandidates: green.filter(item => overrides[item.id] !== 'exclude' && overrides[item.id] !== 'pin').map(card),
    };
}

export async function allocateSelection(selection, catalog, overrides, settings, countTokens) {
    const green = catalog.filter(item => item.kind !== 'blue' && item.kind !== 'vector');
    const byId = new Map(green.map(item => [item.id, item]));
    const pins = green.filter(x => overrides[x.id] === 'pin').map(x => ({ id: x.id, scope: 'scene', reason: '本聊天手动固定' }));
    const required = new Set(selection.replyPlan?.requiredEntryIds || []);
    const candidates = [
        ...pins,
        ...selection.selected.filter(item => required.has(item.id)),
        ...selection.selected.filter(item => !required.has(item.id)),
    ];
    const seen = new Set();
    const selected = [];
    const skipped = green.filter(item => overrides[item.id] === 'exclude')
        .map(item => ({ id: item.id, kind: 'green', reason: '本聊天手动排除' }));
    let tokens = 0;
    for (const choice of candidates) {
        if (seen.has(choice.id) || !byId.has(choice.id)) continue;
        seen.add(choice.id);
        if (overrides[choice.id] === 'exclude') {
            continue;
        }
        const rawCount = await countTokens(byId.get(choice.id).entry.content);
        if (!Number.isFinite(rawCount) || rawCount < 0) throw new Error('无法计算条目的 token 数量。');
        const cost = Math.ceil(rawCount) + 4;
        if (selected.length >= settings.maxEntries || tokens + cost > settings.tokenBudget) {
            skipped.push({ ...choice, kind: 'green', tokens: cost, reason: selected.length >= settings.maxEntries ? '超过绿灯条目数量上限' : '超过绿灯 Token 预算（不截断原文）' });
            continue;
        }
        tokens += cost;
        selected.push({ ...choice, kind: 'green', position: injectionPosition(byId.get(choice.id).entry), tokens: cost });
    }
    return { scene: selection.scene, selected, skipped, tokens };
}

