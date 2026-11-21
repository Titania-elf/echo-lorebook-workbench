import {
    createWorldInfoEntry, loadWorldInfo, worldInfoCache, world_info, selected_world_info,
    newWorldInfoEntryDefinition, world_info_position, world_info_logic,
    originalWIDataKeyMap, splitKeywordsAndRegexes,
    checkWorldInfo, world_info_include_names, world_info_max_recursion_steps,
} from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';
import { getTagKeyForEntity } from '../../../tags.js';
import { promptManager } from '../../../openai.js';
import { MODULE, entryId, entryVersion } from './core.js';
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
        this.recovering = false;
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

    schedulerBooks(books) {
        const mounted = this.associations();
        return books.filter(name => mounted.has(name)).sort();
    }

    schedulerApplicable(entry, type = 'normal') {
        if (Array.isArray(entry.triggers) && entry.triggers.length && !entry.triggers.includes(type)) return false;
        const filter = entry.characterFilter;
        if (Array.isArray(filter?.names) && filter.names.length) {
            const included = filter.names.includes(getCharaFilename(this.getContext().characterId));
            if (filter.isExclude ? included : !included) return false;
        }
        if (Array.isArray(filter?.tags) && filter.tags.length) {
            const context = this.getContext();
            const tagKey = getTagKeyForEntity(context.characterId);
            const tags = tagKey ? context.tagMap?.[tagKey] : null;
            if (Array.isArray(tags)) {
                const included = tags.some(tag => filter.tags.includes(tag));
                if (filter.isExclude ? included : !included) return false;
            }
        }
        const decorators = Array.isArray(entry.decorators) ? entry.decorators : [];
        return !decorators.includes('@@dont_activate') || decorators.includes('@@activate');
    }

    assertSchedulerSlots(included, type) {
        if (this.getContext().mainApi !== 'openai' || !included.length) return;
        if (!promptManager) throw new WorldbookError('酒馆的正文预设尚未准备好。');
        for (const position of new Set(included.map(item => item.position))) {
            const id = position === 'before' ? 'worldInfoBefore' : 'worldInfoAfter';
            const name = position === 'before' ? '世界书之前' : '世界书之后';
            const prompt = promptManager.getPromptById(id);
            if (promptManager.isPromptDisabledForActiveCharacter(id)
                || (prompt && !promptManager.shouldTrigger(prompt, type))) {
                throw new WorldbookError(`正文预设中的“${name}”已关闭或不适用于本次生成，请先启用该位置。`);
            }
        }
    }

    /** Read disk without accepting it into the editor/cache; a failed native load is not an empty book. */
    async schedulerSnapshot(books, { signal } = {}) {
        const mounted = this.schedulerBooks(books);
        const sources = new Map();
        if (!mounted.length) return { books: mounted, sources, versions: new Map() };
        const records = await this.directory({ fresh: true, signal });
        for (const name of mounted) {
            if (!records.some(record => record.name === name)) throw new WorldbookError(`托管世界书《${name}》已删除或改名。`);
        }
        const saved = await Promise.all(mounted.map(async name => [
            name, await this.readBook(name, { fresh: true, signal, requireExisting: false }),
        ]));
        for (const [world, data] of saved) {
            for (const value of Object.values(data.entries)) {
                if (!object(value) || !['string', 'number'].includes(typeof value.uid)) {
                    throw new WorldbookError(`《${world}》含有无法识别 ID 的条目，已跳过本轮调度。`);
                }
                const source = { ...value, world };
                const id = entryId(source);
                if (sources.has(id)) throw new WorldbookError(`《${world}》含有重复条目 ID，已跳过本轮调度。`);
                sources.set(id, source);
            }
        }
        return { books: mounted, sources, versions: new Map([...sources].map(([id, entry]) => [id, entryVersion(entry)])) };
    }

    /**
     * Rare recovery after a scan already skipped masked entries. A fresh native scan also
     * works when the outer scan reached its recursion cap. Capture its expanded entries
     * before the builder and leave formatting/regex/timers to the original scan once.
     */
    async recoverSchedulerScan(input, contextSize, type, parentEntries, guard) {
        if (this.recovering) throw new WorldbookError('另一个原生恢复正在进行。');
        guard();
        const context = this.getContext();
        const fields = context.getCharacterCardFields();
        const globalScanData = {
            personaDescription: fields.persona, characterDescription: fields.description,
            characterPersonality: fields.personality, characterDepthPrompt: fields.charDepthPrompt,
            scenario: fields.scenario, creatorNotes: fields.creatorNotes, trigger: type,
        };
        const chat = input.map(message => world_info_include_names ? `${message.name}: ${message.mes}` : message.mes).reverse();
        let sorted = null;
        let recovered = null;
        const capture = args => {
            if (args.sortedEntries === parentEntries) return;
            guard();
            if (sorted && sorted !== args.sortedEntries) throw new WorldbookError('原生恢复期间出现了另一轮世界书扫描。');
            sorted = args.sortedEntries;
            const lastLoop = !args.state.next || (world_info_max_recursion_steps > 0 && args.state.loopCount >= world_info_max_recursion_steps);
            if (!lastLoop) return;
            recovered = [...args.activated.entries.values()];
            args.activated.entries.clear();
        };
        this.recovering = true;
        context.eventSource.on(context.eventTypes.WORLDINFO_SCAN_DONE, capture);
        try {
            const native = await checkWorldInfo(chat, contextSize, false, globalScanData);
            guard();
            if (sorted && recovered === null) throw new WorldbookError('原生恢复没有返回完整的世界书扫描结果。');
            return recovered || [...native.allActivatedEntries];
        } finally {
            context.eventSource.removeListener(context.eventTypes.WORLDINFO_SCAN_DONE, capture);
            this.recovering = false;
        }
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
