import { clone, sameValue, contextKey, UID_LIMIT, bookWatermark, reserveBookWatermark } from './workbench-state.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ownEntry = (data, uid) => Object.hasOwn(data.entries, String(uid)) ? data.entries[String(uid)] : undefined;

export class EntryStoreError extends Error {
    constructor(message, code = 'entry') {
        super(message);
        this.name = 'EntryStoreError';
        this.code = code;
    }
}

/** Raw book snapshots, independent drafts and per-book write serialization. */
export class EntryStore {
    constructor({ api, settings, onBegin = () => {}, onCommit = () => {}, onChange = () => {} }) {
        this.api = api;
        this.settings = settings;
        this.onBegin = onBegin;
        this.onCommit = onCommit;
        this.onChange = onChange;
        this.loaded = new Map();
        this.queues = new Map();
        this.session = null;
        this.sequence = 0;
        this.inFlight = 0;
    }

    get busy() { return this.inFlight > 0; }
    get dirty() { return Boolean(this.session && (this.session.isNew || this.session.changes.size)); }

    notify() {
        try { this.onChange(this); }
        catch (error) { console.warn('[回声书台] 编辑状态显示失败', error); }
    }

    remember(book, data) {
        this.loaded.delete(book);
        this.loaded.set(book, clone(data));
        for (const name of this.loaded.keys()) {
            if (this.loaded.size <= 6) break;
            if (name !== book && name !== this.session?.book) this.loaded.delete(name);
        }
    }

    async loadBook(book, options = {}) {
        const data = await this.api.readBook(book, options);
        this.remember(book, data);
        if (options.fresh) {
            try { this.api.acceptRead?.(book, data); } catch (error) {
                console.warn('[回声书台] 原书已读取，但原生编辑器刷新失败', error);
            }
        }
        return clone(data);
    }

    observeBook(book, data) {
        if ((!this.loaded.has(book) && this.session?.book !== book) || !object(data) || !object(data.entries)) return;
        this.loaded.set(book, clone(data));
        if (this.session?.book === book && !sameValue(this.session.bookBaseline, data)) {
            this.session.externalChanged = true;
        }
        this.notify();
    }

    entries(book) {
        const data = this.loaded.get(book);
        if (!data) return [];
        return Object.entries(data.entries).map(([key, raw]) => {
            const entry = object(raw) ? raw : {};
            const validIdentity = typeof entry.uid === 'string' || (typeof entry.uid === 'number' && Number.isFinite(entry.uid));
            const editable = object(raw) && validIdentity && String(entry.uid) === key;
            return { key, uid: entry.uid ?? key, entry, raw, editable };
        });
    }

    begin(book, key = null, { copy = false } = {}) {
        if (this.busy) throw new EntryStoreError('请等待当前保存完成。');
        if (this.session?.pending) throw new EntryStoreError('先确认上次操作结果，或明确放弃本地草稿。');
        const data = this.loaded.get(book);
        if (!data) throw new EntryStoreError('请先打开一本世界书。');
        this.loaded.delete(book);
        this.loaded.set(book, data);
        let draft;
        let baseline;
        const isNew = key === null || copy;
        if (key !== null) {
            const record = this.entries(book).find(item => item.key === String(key));
            if (!record?.editable) throw new EntryStoreError('条目 ID 或格式异常，请在原生编辑器中处理。');
            baseline = clone(record.entry);
            draft = clone(record.entry);
            if (copy) {
                delete draft.uid;
                const title = draft.comment || (Array.isArray(draft.key) ? draft.key.join('、') : '') || '条目';
                draft.comment = `${title} · 副本`;
                baseline = clone(draft);
            }
        } else {
            draft = this.api.template();
            baseline = clone(draft);
        }
        this.session = {
            token: ++this.sequence, book, uid: isNew ? null : String(key), isNew,
            baseline, draft, bookBaseline: clone(data), changes: new Set(),
            context: contextKey(this.api.getContext()), status: 'idle', problem: '',
            pending: null, externalChanged: false,
        };
        this.notify();
        return this.session;
    }

    value(field) {
        const draft = this.session?.draft;
        return draft && Object.hasOwn(draft, field) ? clone(draft[field]) : this.api.defaultValue(field);
    }

    baselineValue(session, field) {
        return Object.hasOwn(session.baseline, field) ? session.baseline[field] : this.api.defaultValue(field);
    }

    fieldValue(entry, field) {
        return Object.hasOwn(entry, field) ? entry[field] : this.api.defaultValue(field);
    }

    set(field, value) {
        const session = this.session;
        if (!session || this.busy || session.pending) return;
        if (field === 'uid' || !Object.hasOwn(this.api.definition, field)) {
            throw new EntryStoreError('不能通过编辑表单修改此字段。', 'validation');
        }
        if (sameValue(this.baselineValue(session, field), value)) {
            session.changes.delete(field);
            if (Object.hasOwn(session.baseline, field)) session.draft[field] = clone(session.baseline[field]);
            else delete session.draft[field];
        } else {
            session.draft[field] = clone(value);
            session.changes.add(field);
        }
        session.problem = '';
        if (session.status !== 'saving') session.status = 'idle';
        this.notify();
    }

    discard() {
        if (this.busy) throw new EntryStoreError('保存中不能丢弃草稿。');
        this.session = null;
        this.notify();
    }

    validate(session) {
        for (const field of session.changes) {
            const value = session.draft[field];
            const definition = this.api.definition[field];
            const type = String(definition?.type || '');
            if (value === null && (definition?.default === null || type.includes('?'))) continue;
            if (type.startsWith('boolean') && typeof value !== 'boolean') {
                throw new EntryStoreError(`${field} 必须是开关值。`, 'validation');
            }
            if ((type.startsWith('number') || type === 'enum') && !Number.isFinite(value)) {
                throw new EntryStoreError(`${field} 必须填写有效数字。`, 'validation');
            }
            if (type === 'string' && typeof value !== 'string') {
                throw new EntryStoreError(`${field} 必须是文本。`, 'validation');
            }
            if (type === 'array' && !Array.isArray(value)) {
                throw new EntryStoreError(`${field} 必须是列表。`, 'validation');
            }
            if (field === 'probability' && (value < 0 || value > 100)) {
                throw new EntryStoreError('激活概率必须在 0 到 100 之间。', 'validation');
            }
        }
    }

    async serialized(book, action) {
        const previous = this.queues.get(book) || Promise.resolve();
        const operation = previous.catch(() => {}).then(action);
        this.queues.set(book, operation);
        try { return await operation; }
        finally { if (this.queues.get(book) === operation) this.queues.delete(book); }
    }

    ensureCurrent(session) {
        if (this.session !== session) throw new EntryStoreError('编辑对象已改变，本次未写入原书。', 'stale');
    }

    checkCache(session, cached, latest) {
        if (cached && !sameValue(cached, session.bookBaseline) && !sameValue(cached, latest)) {
            throw new EntryStoreError('原生编辑器的缓存与已保存原书不同。请先完成原生保存，再重新读取；当前草稿保留。', 'conflict');
        }
    }

    nextUid(book, data) {
        const existing = Object.keys(data.entries).map(Number)
            .filter(value => Number.isInteger(value) && value >= 0 && value < UID_LIMIT);
        const highest = existing.reduce((maximum, value) => Math.max(maximum, value), Math.max(-1, this.settings.watermark(book), bookWatermark(data)));
        const uid = highest + 1;
        if (uid >= UID_LIMIT) {
            throw new EntryStoreError('条目 ID 已达到安全分配上限。为避免旧聊天规则误套，不复用空洞 ID；请拆分世界书。', 'uid_limit');
        }
        return uid;
    }

    async reconcile(session) {
        const pending = session.pending;
        if (!pending) return null;
        const latest = await this.api.readBook(session.book, { fresh: true });
        const actual = ownEntry(latest, pending.uid);
        if (pending.kind === 'delete' && actual === undefined) {
            const accepted = await this.api.acceptSaved(session.book, latest);
            return this.finish(session, latest, pending.uid, accepted.warning, true);
        }
        if (pending.kind === 'save' && object(actual) && sameValue(actual, pending.data.entries[pending.uid])) {
            const accepted = await this.api.acceptSaved(session.book, latest);
            return this.finish(session, latest, pending.uid, accepted.warning, false);
        }
        const original = pending.isNew ? undefined : session.baseline;
        if (sameValue(actual, original)) {
            session.pending = null;
            return null;
        }
        throw new EntryStoreError('上次保存结果不确定，原书现值又发生了变化。请重新读取后处理，避免重复新增或覆盖。', 'conflict');
    }

    async finish(session, data, uid, warning = '', deleted = false) {
        const wasNew = session.isNew;
        const changedFields = [...session.changes];
        this.loaded.set(session.book, clone(data));
        session.pending = null;
        if (this.session === session) {
            if (deleted) this.session = null;
            else {
                session.uid = String(uid);
                session.isNew = false;
                session.baseline = clone(data.entries[uid]);
                session.draft = clone(session.baseline);
                session.bookBaseline = clone(data);
                session.changes.clear();
                session.externalChanged = false;
                session.status = 'idle';
                session.problem = '';
            }
        }
        try {
            await this.onCommit({ book: session.book, uid: String(uid), deleted, wasNew, fields: changedFields, context: session.context });
        } catch (error) {
            console.warn('[回声书台] 原书提交后调度目录同步失败', error);
            warning ||= '原书已保存，但目录同步失败，请手动刷新目录。';
        }
        this.notify();
        return { book: session.book, uid: String(uid), deleted, wasNew, warning };
    }

    async mutate(session, action) {
        if (this.busy) throw new EntryStoreError('当前保存还未完成。');
        const previousPending = session.pending;
        this.inFlight++;
        session.status = 'saving';
        session.problem = '';
        this.notify();
        try {
            return await this.serialized(session.book, async () => {
                this.ensureCurrent(session);
                this.onBegin({ book: session.book, context: session.context });
                const reconciled = await this.reconcile(session);
                if (reconciled) return reconciled;
                return action();
            });
        } catch (error) {
            if (this.session === session) {
                session.status = error.code === 'conflict' ? 'conflict' : 'failed';
                session.problem = String(error.message || '保存失败，草稿已保留。');
                if (error.uncertain && session.pending) this.api.invalidateReadCache?.(session.book);
                // A failed read while reconciling an older uncertain write must not erase its identity.
                if (!error.uncertain && session.pending !== previousPending) session.pending = null;
            }
            throw error;
        } finally {
            this.inFlight--;
            this.notify();
        }
    }

    async save() {
        const session = this.session;
        if (!session) throw new EntryStoreError('没有正在编辑的条目。');
        if (session.pending?.kind === 'delete') return this.remove();
        if (!this.dirty && !session.pending) return { book: session.book, uid: session.uid, unchanged: true };
        try { this.validate(session); }
        catch (error) {
            session.status = 'failed'; session.problem = error.message; this.notify(); throw error;
        }
        return this.mutate(session, async () => {
            const cached = this.api.cachedBook(session.book);
            const latest = await this.api.readBook(session.book, { fresh: true });
            this.ensureCurrent(session);
            this.checkCache(session, cached, latest);
            let uid;
            let entry;
            if (session.isNew) {
                uid = this.nextUid(session.book, latest);
                const nativeEntry = this.api.create(latest, uid);
                entry = { ...nativeEntry, ...clone(session.draft), uid };
                latest.entries[uid] = entry;
            } else {
                uid = session.uid;
                const current = ownEntry(latest, uid);
                if (!object(current)) throw new EntryStoreError('原条目已被删除或格式改变，不能恢复覆盖它。草稿保留。', 'conflict');
                const conflicts = [...session.changes].filter(field =>
                    !sameValue(this.fieldValue(current, field), this.baselineValue(session, field)) &&
                    !sameValue(this.fieldValue(current, field), session.draft[field]));
                if (conflicts.length) {
                    throw new EntryStoreError(`原条目在其他位置已修改（${conflicts.join('、')}）。草稿保留，请重新读取后处理。`, 'conflict');
                }
                entry = { ...clone(current) };
                for (const field of session.changes) entry[field] = clone(session.draft[field]);
                Object.defineProperty(latest.entries, String(uid), { value: entry, enumerable: true, configurable: true, writable: true });
            }
            const fields = session.isNew ? Object.keys(entry) : [...session.changes];
            if (session.isNew) reserveBookWatermark(latest, Number(uid));
            this.api.synchronizeOriginalData(latest, uid, entry, fields, { create: session.isNew });
            this.settings.reserve(session.book, Number(uid));
            session.pending = { kind: 'save', uid: String(uid), data: clone(latest), isNew: session.isNew };
            const accepted = await this.api.writeBook(session.book, latest);
            return this.finish(session, accepted.data, uid, accepted.warning, false);
        });
    }

    async remove() {
        const session = this.session;
        if (!session || session.isNew) throw new EntryStoreError('新增草稿尚未写入原书。');
        return this.mutate(session, async () => {
            const cached = this.api.cachedBook(session.book);
            const latest = await this.api.readBook(session.book, { fresh: true });
            this.ensureCurrent(session);
            this.checkCache(session, cached, latest);
            const current = ownEntry(latest, session.uid);
            if (!object(current) || !sameValue(current, session.baseline)) {
                throw new EntryStoreError('原条目已在其他位置改变或删除，当前未执行删除。请重新读取。', 'conflict');
            }
            this.settings.reserve(session.book, Number(session.uid));
            if (Number.isInteger(Number(session.uid)) && Number(session.uid) >= 0 && Number(session.uid) < UID_LIMIT) reserveBookWatermark(latest, Number(session.uid));
            delete latest.entries[session.uid];
            this.api.synchronizeOriginalData(latest, session.uid, current, [], { remove: true });
            session.pending = { kind: 'delete', uid: session.uid, data: clone(latest), isNew: false };
            const accepted = await this.api.writeBook(session.book, latest);
            return this.finish(session, accepted.data, session.uid, accepted.warning, true);
        });
    }
}
