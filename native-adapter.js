import {
    createWorldInfoEntry, loadWorldInfo, worldInfoCache, world_info, selected_world_info,
    newWorldInfoEntryDefinition, world_info_position, world_info_logic,
    originalWIDataKeyMap, splitKeywordsAndRegexes,
} from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';
import { MODULE } from './core.js';
import { clone } from './workbench-state.js';

export class WorldbookError extends Error {
    constructor(message, { code = 'worldbook', uncertain = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'WorldbookError';
        this.code = code;
        this.uncertain = uncertain;
    }
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const originalPathMap = {
    ...originalWIDataKeyMap,
    selectiveLogic: 'extensions.selectiveLogic',
    useProbability: 'extensions.useProbability',
    outletName: 'extensions.outlet_name',
    group: 'extensions.group',
};

/** Known paths only; arbitrary imported keys never become executable markup or paths. */
function setPath(target, path, value) {
    const parts = path.split('.');
    let cursor = target;
    for (const key of parts.slice(0, -1)) {
        if (!object(cursor[key])) cursor[key] = {};
        cursor = cursor[key];
    }
    cursor[parts.at(-1)] = clone(value);
}

/** Preserve the native file and synchronize the character-book mirror when present. */
export function synchronizeOriginalData(data, uid, entry, fields, { create = false, remove = false } = {}) {
    if (!data.originalData || !Array.isArray(data.originalData.entries)) return;
    const originals = data.originalData.entries;
    let index = -1;
    for (let position = originals.length - 1; position >= 0; position--) {
        const item = originals[position];
        const identity = object(item) ? item.id ?? item.uid : undefined;
        if ((typeof identity === 'string' || typeof identity === 'number') && String(identity) === String(uid)) { index = position; break; }
    }
    if (remove) {
        if (index >= 0) originals.splice(index, 1);
        return;
    }
    let original = index >= 0 ? originals[index] : null;
    if (!original && !create) return;
    if (!original) {
        // id is the character-book identity; uid also keeps native mirror helpers usable.
        original = { id: uid, uid, extensions: clone(object(entry.extensions) ? entry.extensions : {}) };
        originals.push(original);
    }
    for (const field of fields) {
        if (field === 'uid') continue;
        if (field === 'disable') {
            original.enabled = !entry.disable;
            continue;
        }
        const path = originalPathMap[field];
        if (!path || entry[field] === undefined) continue;
        setPath(original, path, entry[field]);
        if (field === 'position' && (entry.position === world_info_position.before || entry.position === world_info_position.after)) {
            original.position = entry.position === world_info_position.before ? 'before_char' : 'after_char';
        }
    }
    if (create && original.enabled === undefined) original.enabled = !entry.disable;
}

/** All host-specific behavior lives here. No model requests are made by this adapter. */
export class NativeWorldbookAdapter {
    constructor(getContext) {
        this.getContext = getContext;
        this.definition = newWorldInfoEntryDefinition;
        this.positions = world_info_position;
        this.logic = world_info_logic;
        this.records = new Map();
        this.directoryLoaded = false;
        this.synchronizeOriginalData = synchronizeOriginalData;
    }

    async request(endpoint, body, { signal, write = false } = {}) {
        const context = this.getContext();
        let response;
        try {
            response = await fetch(`/api/worldinfo/${endpoint}`, {
                method: 'POST', headers: context.getRequestHeaders(),
                body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-cache', signal,
            });
        } catch (cause) {
            if (signal?.aborted) throw cause;
            throw new WorldbookError(write
                ? '保存请求中断，结果暂不确定。草稿已保留，重试前会先读取原书。'
                : '无法连接酒馆读取世界书，请检查连接后重试。',
            { code: 'network', uncertain: write, cause });
        }
        if (!response.ok) {
            throw new WorldbookError(`${write ? '原书未确认保存' : '读取世界书失败'}：HTTP ${response.status}。请检查酒馆登录与服务状态。`,
                { code: 'http', uncertain: write && response.status >= 500 });
        }
        try {
            return await response.json();
        } catch (cause) {
            throw new WorldbookError(write
                ? '保存响应无法解析，结果暂不确定。草稿已保留，重试前会读取原书。'
                : '酒馆返回的数据无法解析，请检查世界书格式或重新登录。',
            { code: 'response', uncertain: write, cause });
        }
    }

    async directory({ fresh = false, signal } = {}) {
        if (fresh) {
            const data = await this.request('list', {}, { signal });
            if (!Array.isArray(data)) throw new WorldbookError('世界书目录格式异常。');
            this.records = new Map(data.filter(item => object(item) && typeof item.file_id === 'string')
                .map(item => [item.file_id, { name: item.file_id, displayName: typeof item.name === 'string' && item.name ? item.name : item.file_id }]));
            this.directoryLoaded = true;
            return [...this.records.values()];
        }
        if (this.directoryLoaded) return [...this.records.values()];
        return this.getContext().getWorldInfoNames().map(name => ({ name, displayName: name }));
    }

    associations() {
        const context = this.getContext();
        const result = new Map();
        const add = (name, label, priority) => {
            if (typeof name !== 'string' || !name) return;
            const current = result.get(name) || { labels: [], priority };
            if (!current.labels.includes(label)) current.labels.push(label);
            current.priority = Math.min(current.priority, priority);
            result.set(name, current);
        };
        const character = context.characterId != null ? context.characters?.[context.characterId] : null;
        add(character?.data?.extensions?.world, '角色卡绑定', 0);
        if (character) {
            try {
                const filename = getCharaFilename(context.characterId);
                const extra = world_info.charLore?.find(item => item.name === filename)?.extraBooks;
                if (Array.isArray(extra)) for (const name of extra) add(name, '角色辅助绑定', 1);
            } catch { /* A group without a selected character has no character preference. */ }
        }
        for (const name of selected_world_info) add(name, '全局已启用', 2);
        add(context.chatMetadata?.world_info, '聊天挂载', 3);
        add(context.powerUserSettings?.persona_description_lorebook, '人设挂载', 3);
        return result;
    }

    async books(options = {}) {
        const records = await this.directory(options);
        const associations = this.associations();
        const raw = this.getContext().extensionSettings[MODULE]?.books;
        const managed = new Set(Array.isArray(raw) ? raw : []);
        return records.map(record => {
            const association = associations.get(record.name);
            return {
                ...record, priority: association?.priority ?? 4,
                source: association ? association.labels.join(' · ') : '未挂载到当前聊天',
                mounted: Boolean(association), managed: managed.has(record.name),
            };
        }).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    }

    async assertExists(name, { signal } = {}) {
        const records = await this.directory({ fresh: true, signal });
        if (!records.some(record => record.name === name)) {
            throw new WorldbookError('来源世界书已被删除或改名。草稿保留，不会重新创建同名空书。', { code: 'missing_book' });
        }
    }

    async readBook(name, { fresh = false, signal, requireExisting = true } = {}) {
        if (requireExisting) await this.assertExists(name, { signal });
        // Warm reads reuse the native accessor. Cold reads are abortable and do not let an
        // old load overwrite a newer acknowledged native cache while the popup is closing.
        const data = !fresh && worldInfoCache.has(name) ? await loadWorldInfo(name) : await this.request('get', { name }, { signal });
        if (signal?.aborted) throw signal.reason || new DOMException('读取已取消', 'AbortError');
        if (!object(data) || !object(data.entries)) {
            throw new WorldbookError('世界书不是有效的原生 entries 对象，请检查原书格式。', { code: 'format' });
        }
        return clone(data);
    }

    cachedBook(name) {
        return worldInfoCache.has(name) ? clone(worldInfoCache.get(name)) : null;
    }

    acceptRead(name, data) {
        worldInfoCache.set(name, clone(data));
        this.getContext().reloadWorldInfoEditor?.(name);
    }

    invalidateReadCache(name) {
        // A dispatched write may have reached disk even when its response was lost.
        worldInfoCache.delete(name);
    }

    template() {
        const temporary = { entries: {} };
        const entry = createWorldInfoEntry('', temporary);
        if (!entry) throw new WorldbookError('无法创建原生条目模板。');
        const result = clone(entry);
        delete result.uid;
        return result;
    }

    create(data, desiredUid) {
        const entry = createWorldInfoEntry('', data);
        if (!entry) throw new WorldbookError('无法分配新条目 ID，请检查条目数量。');
        const provisional = entry.uid;
        if (desiredUid !== provisional) {
            if (Object.hasOwn(data.entries, String(desiredUid))) {
                delete data.entries[provisional];
                throw new WorldbookError('新条目 ID 已被使用，请重新读取原书。', { code: 'conflict' });
            }
            delete data.entries[provisional];
            entry.uid = desiredUid;
            data.entries[desiredUid] = entry;
        }
        return entry;
    }

    parseKeywords(text) {
        return splitKeywordsAndRegexes(String(text));
    }

    defaultValue(field) {
        return clone(this.definition[field]?.default);
    }

    async writeBook(name, data, { signal } = {}) {
        await this.assertExists(name, { signal });
        const response = await this.request('edit', { name, data }, { signal, write: true });
        if (response?.ok !== true) {
            throw new WorldbookError('后端没有确认原书保存，结果暂不确定。草稿已保留。', { code: 'response', uncertain: true });
        }
        return this.acceptSaved(name, data);
    }

    async acceptSaved(name, data) {
        const context = this.getContext();
        // Cache is updated only after acknowledgment, and never shares the editor draft.
        worldInfoCache.set(name, clone(data));
        let warning = '';
        try {
            if (context.eventTypes.WORLDINFO_UPDATED) {
                await context.eventSource.emit(context.eventTypes.WORLDINFO_UPDATED, name, clone(data), { source: MODULE });
            }
            context.reloadWorldInfoEditor?.(name);
        } catch (error) {
            console.warn('[回声书台] 原书已保存，但界面同步失败', error);
            warning = '原书已保存，但部分界面同步失败，请手动刷新目录。';
        }
        return { data: clone(data), warning };
    }

    async refreshDirectory() {
        await this.getContext().updateWorldInfoList?.();
        return this.books({ fresh: true });
    }
}
