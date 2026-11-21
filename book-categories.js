import { WORKBENCH_SETTINGS, clone, sameValue, contextKey } from './workbench-state.js';

export const CATEGORY_ALL = 'all';
export const CATEGORY_CONSTANT = 'constant';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const definition = value => object(value) && typeof value.id === 'string' && value.id
    && typeof value.name === 'string' && value.name.trim();

export function bookCategories(data) {
    const values = data?.extensions?.[WORKBENCH_SETTINGS]?.categories;
    return Array.isArray(values) ? values.filter(definition).map(value => ({ id: value.id, name: value.name })) : [];
}

export function entryCategory(data, uid) {
    const values = data?.extensions?.[WORKBENCH_SETTINGS]?.entryCategories;
    return object(values) && Object.hasOwn(values, String(uid)) && typeof values[String(uid)] === 'string'
        ? values[String(uid)] : '';
}

export function categoryName(data, id) {
    return bookCategories(data).find(value => value.id === id)?.name || '';
}

function namespace(target) {
    if (target.extensions != null && !object(target.extensions)) throw new Error('世界书扩展信息格式异常，未覆盖原始数据。');
    const extensions = target.extensions || {};
    const current = extensions[WORKBENCH_SETTINGS];
    if (current != null && !object(current)) throw new Error('世界书分类信息格式异常，未覆盖原始数据。');
    if (current?.categories != null && (!Array.isArray(current.categories) || !current.categories.every(definition))) {
        throw new Error('已有分类信息无法读取，请先处理原书数据。');
    }
    if (current?.entryCategories != null && !object(current.entryCategories)) throw new Error('已有条目分类信息无法读取。');
    target.extensions = { ...extensions, [WORKBENCH_SETTINGS]: { ...(current || {}) } };
    return target.extensions[WORKBENCH_SETTINGS];
}

function writeMetadata(data, apply) {
    apply(namespace(data));
    if (Array.isArray(data.originalData?.entries)
        && (data.originalData.extensions == null || object(data.originalData.extensions))) {
        // The raw character-book mirror carries the same IDs as the native book.
        const mirror = data.originalData.extensions?.[WORKBENCH_SETTINGS];
        if (mirror == null || object(mirror)) apply(namespace(data.originalData));
    }
}

export function validateCategoryName(value) {
    const name = String(value || '').trim();
    if (!name || Array.from(name).length > 32) throw new Error('分类名称请填写 1 到 32 个字符。');
    if (['全部', '常驻', '不指定分类'].includes(name)) throw new Error('这个名称已用于固定视图，请换一个分类名称。');
    return name;
}

function addDefinition(data, id, name) {
    const existing = bookCategories(data);
    if (existing.some(value => value.id !== id && value.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error('这本书已经有同名分类，请直接选择它。');
    }
    const own = existing.find(value => value.id === id);
    if (own && own.name !== name) throw new Error('分类信息已在其他位置改变，请重新读取。');
    writeMetadata(data, values => {
        const list = values.categories || [];
        values.categories = list.some(value => value.id === id)
            ? list.map(value => value.id === id ? { ...value, name } : value)
            : [...list, { id, name }];
    });
}

export function assignEntryCategory(data, uid, id) {
    if (id && !bookCategories(data).some(value => value.id === id)) {
        throw new Error('所选分类已不存在，请重新选择后保存。');
    }
    if (!id && !entryCategory(data, uid)) return;
    writeMetadata(data, values => {
        const table = { ...(values.entryCategories || {}) };
        if (id) Object.defineProperty(table, String(uid), { value: id, enumerable: true, configurable: true, writable: true });
        else delete table[String(uid)];
        values.entryCategories = table;
    });
}

/** Definitions live in book metadata, leaving entry text and activation fields intact. */
export class BookCategoryStore {
    constructor(store) {
        this.store = store;
        this.operation = null;
    }

    get pending() { return Boolean(this.operation?.pending); }

    async add(book, value) {
        if (this.store.busy || this.store.session?.pending) throw new Error('先完成或确认当前条目的保存。');
        if (this.pending) {
            if (this.operation.book !== book) throw new Error('先确认上一本书的分类保存结果。');
            return this.retry();
        }
        const name = validateCategoryName(value);
        const baseline = this.store.loaded.get(book);
        if (!baseline) throw new Error('请先打开这本世界书。');
        const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        this.operation = {
            book, id: `category-${random}`, name, bookBaseline: clone(baseline),
            context: contextKey(this.store.api.getContext()), pending: null,
        };
        return this.retry();
    }

    async retry() {
        const operation = this.operation;
        const store = this.store;
        if (!operation) throw new Error('没有待保存的分类。');
        if (store.busy || store.session?.pending) throw new Error('先完成或确认当前条目的保存。');
        store.inFlight++;
        store.notify();
        const previousPending = operation.pending;
        try {
            return await store.serialized(operation.book, async () => {
                const cached = store.api.cachedBook(operation.book);
                const latest = await store.api.readBook(operation.book, { fresh: true });
                if (operation.pending) {
                    const actual = bookCategories(latest).find(value => value.id === operation.id);
                    if (actual?.name === operation.name) {
                        const accepted = await store.api.acceptSaved(operation.book, latest);
                        return this.finish(operation, accepted.data, accepted.warning);
                    }
                    if (actual) throw new Error('上次分类保存结果不确定，现值又发生了变化，请重新读取后处理。');
                }
                store.checkCache(operation, cached, latest);
                store.onBegin({ book: operation.book, context: operation.context });
                addDefinition(latest, operation.id, operation.name);
                operation.pending = clone(latest);
                const accepted = await store.api.writeBook(operation.book, latest);
                return this.finish(operation, accepted.data, accepted.warning);
            });
        } catch (error) {
            if (error.uncertain) store.api.invalidateReadCache?.(operation.book);
            else if (!previousPending) operation.pending = null;
            throw error;
        } finally {
            store.inFlight--;
            store.notify();
        }
    }

    async finish(operation, data, warning = '') {
        const session = this.store.session;
        this.store.remember(operation.book, data);
        if (session?.book === operation.book) {
            if (!sameValue(operation.bookBaseline.entries, data.entries)) session.externalChanged = true;
            session.bookBaseline = clone(data);
        }
        this.operation = null;
        try { await this.store.onCommit({ book: operation.book, uid: null, metadataOnly: true, context: operation.context }); }
        catch { warning ||= '分类已保存，请刷新界面查看。'; }
        this.store.notify();
        return { id: operation.id, name: operation.name, book: operation.book, warning };
    }

    abandon() {
        if (this.store.busy) throw new Error('分类还在保存中。');
        this.operation = null;
    }
}
