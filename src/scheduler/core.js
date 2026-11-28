// Pure selection/state logic. No SillyTavern or browser dependencies.
// Persistent keys / UI IDs remain stable across the directory rename.
import { normalizePromptTemplates } from './prompt-templates.js';
export { SELECTOR_SYSTEM } from './prompt-templates.js';

export const MODULE = 'lorebook-director';
export const EXTENSION_NAME = 'echo-lorebook-workbench';
export const ENTRY_TOKEN_OVERHEAD = 4;
// Resolve the actual installation folder instead of coupling template paths to storage keys.
export const EXTENSION_FOLDER = decodeURIComponent(new URL('../../', import.meta.url).pathname.split('/').filter(Boolean).at(-1) || EXTENSION_NAME);
export const DEFAULTS = Object.freeze({
    enabled: false, books: [], profileId: '', maxEntries: 8, tokenBudget: 1800,
    recentMessages: 3, timeoutSeconds: 60,
    apiMode: 'main', apiSchemeId: '', apiSchemes: [],
    promptTemplates: normalizePromptTemplates(), promptRoleVersion: 2,
});

export function settingsWithDefaults(value = {}) {
    const integer = (key, min, max) => {
        const n = Number(value[key] ?? DEFAULTS[key]);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULTS[key];
    };
    const storedRoleVersion = Number.isInteger(value.promptRoleVersion) && value.promptRoleVersion > 0 ? value.promptRoleVersion : 0;
    // Full-text/director templates used a different protocol, even when customized.
    // Do not load their messages or roles into the directory-only selector.
    const promptTemplates = normalizePromptTemplates(storedRoleVersion < DEFAULTS.promptRoleVersion ? undefined : value.promptTemplates);
    return {
        enabled: value.enabled === true,
        books: [...new Set((Array.isArray(value.books) ? value.books : []).filter(x => typeof x === 'string'))],
        profileId: typeof value.profileId === 'string' ? value.profileId : '',
        apiMode: ['main', 'scheme', 'profile'].includes(value.apiMode) ? value.apiMode
            : typeof value.profileId === 'string' && value.profileId ? 'profile' : 'main',
        apiSchemeId: typeof value.apiSchemeId === 'string' ? value.apiSchemeId : '',
        apiSchemes: normalizeAPISchemes(value.apiSchemes),
        maxEntries: integer('maxEntries', 1, 30), tokenBudget: integer('tokenBudget', 128, 16000),
        recentMessages: integer('recentMessages', 1, 30),
        timeoutSeconds: integer('timeoutSeconds', 10, 180),
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
        forwardHeaders: typeof value.forwardHeaders === 'string' ? value.forwardHeaders : '',
        forwardBody: typeof value.forwardBody === 'string' ? value.forwardBody : '',
        forwardExclude: typeof value.forwardExclude === 'string' ? value.forwardExclude : '',
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

export function makeCatalog(entries, books, { applicable = () => true, cards = new Map() } = {}) {
    const managed = new Set(books);
    const seen = new Set();
    const catalog = [];
    for (const entry of entries) {
        if (!managed.has(entry.world) || entry.disable || entryKind(entry) === 'vector'
            || !String(entry.content || '').trim() || !applicable(entry)) continue;
        const id = entryId(entry);
        const card = cards.get(id);
        if (!card || seen.has(id)) continue;
        seen.add(id);
        const primary = Array.isArray(entry.key) ? entry.key.filter(key => typeof key === 'string') : [];
        const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary.filter(key => typeof key === 'string') : [];
        catalog.push({
            id, entry, kind: entryKind(entry), position: injectionPosition(entry),
            title: (typeof entry.comment === 'string' && entry.comment.trim() ? entry.comment : primary.join('、')) || `条目 ${entry.uid}`,
            keywords: [...new Set([...primary, ...secondary])],
            category: card.category, summary: card.summary, ancestors: card.ancestors,
        });
    }
    return catalog;
}

/** Legacy pin/exclude rules follow split ancestry; "auto" exempts this entry only. */
export function resolveOverride(overrides, id, ancestors = []) {
    const direct = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
    if (direct === 'pin' || direct === 'exclude' || direct === 'auto') return direct;
    if (!ancestors.length) return 'auto';
    let world;
    try { [world] = JSON.parse(id); }
    catch { return 'auto'; }
    if (typeof world !== 'string') return 'auto';
    for (const uid of ancestors) {
        const parent = entryId({ world, uid });
        if (parent === id || !Object.hasOwn(overrides, parent)) continue;
        const mode = overrides[parent];
        if (mode === 'pin' || mode === 'exclude') return mode;
    }
    return 'auto';
}

export function parseJsonObject(text) {
    if (typeof text !== 'string') throw new Error('模型没有返回文本 JSON。');
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try { parsed = JSON.parse(clean); } catch { throw new Error('模型返回的 JSON 不完整或格式不正确。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型必须返回一个 JSON 对象。');
    return parsed;
}

export function validateSelection(text, catalog) {
    const data = parseJsonObject(text);
    if (!Array.isArray(data.selected)) throw new Error('筛选结果缺少 selected 数组。');
    const known = new Set(catalog.filter(item => item.kind === 'green').map(item => item.id));
    const seen = new Set();
    const selected = [];
    for (const item of data.selected) {
        if (!item || typeof item.id !== 'string' || !known.has(item.id)) {
            throw new Error('模型返回了不在本轮候选目录中的条目 ID。');
        }
        if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('筛选结果缺少条目的选择理由。');
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        selected.push({ id: item.id, reason: item.reason.trim().slice(0, 240) });
    }
    return { selected };
}

export function historyChain(chat) {
    const hashes = [digest('lorebook-director:v1')];
    for (const message of chat) {
        hashes.push(digest([hashes.at(-1), message.is_user, message.is_system, message.name, message.mes]));
    }
    return hashes;
}

export function recentContext(chat, count) {
    return chat.filter(message => !message.is_user && !message.is_system && String(message.mes || '').trim()).slice(-count)
        .map(message => ({ role: 'assistant', name: typeof message.name === 'string' ? message.name : '', text: String(message.mes) }));
}

export function latestUserContext(chat) {
    const message = chat.findLast(value => value.is_user && !value.is_system);
    return message ? { role: 'user', name: typeof message.name === 'string' ? message.name : '', text: String(message.mes || '') } : null;
}

/** Only the explicitly allowed directory fields leave the scheduler. */
export function selectorPayload(candidates, chat, settings, fixed) {
    const recentChat = recentContext(chat, settings.recentMessages);
    return {
        greenCandidates: candidates.filter(item => item.kind === 'green').map(item => ({
            id: item.id, book: item.entry.world, title: item.title,
            category: item.category, keywords: item.keywords, summary: item.summary,
        })),
        recentChat, latestUserMessage: latestUserContext(chat),
        maxAdditionalGreenEntries: Math.max(0, settings.maxEntries - fixed.selected.length),
        remainingGreenTokenBudget: Math.max(0, settings.tokenBudget - fixed.tokens),
        greenTokenBudget: settings.tokenBudget,
        history: { requested: settings.recentMessages, read: recentChat.length },
    };
}

export async function allocateSelection(selection, catalog, overrides, settings, countTokens) {
    const green = catalog.filter(item => item.kind === 'green');
    const byId = new Map(green.map(item => [item.id, item]));
    const pins = green.filter(x => overrides[x.id] === 'pin').map(x => ({ id: x.id, reason: '本聊天手动固定' }));
    const candidates = [...pins, ...selection.selected];
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
        const cost = Math.ceil(rawCount) + ENTRY_TOKEN_OVERHEAD;
        if (selected.length >= settings.maxEntries || tokens + cost > settings.tokenBudget) {
            skipped.push({ ...choice, kind: 'green', tokens: cost, reason: selected.length >= settings.maxEntries ? '超过绿灯条目数量上限' : '超过绿灯 Token 预算（不截断原文）' });
            continue;
        }
        tokens += cost;
        selected.push({ ...choice, kind: 'green', position: injectionPosition(byId.get(choice.id).entry), tokens: cost });
    }
    return { selected, skipped, tokens };
}

