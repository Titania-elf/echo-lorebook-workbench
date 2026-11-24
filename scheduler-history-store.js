import { accountsEnabled, currentUser, getCurrentUserHandle } from '../../../user.js';
import { replyPlanSnapshot } from './scheduler-report.js';

const RECORD_STORE = 'records';
const RECORD_LIMIT = 100;
const SERVER_ROOT = new URL('../../../../', import.meta.url).href;
const REQUEST_STATUSES = new Set(['pending', 'returned', 'failed', 'timeout', 'cancelled']);
const VALIDATION_STATUSES = new Set(['pending', 'valid', 'invalid', 'not-run']);
const APPLICATION_STATUSES = new Set(['pending', 'preview', 'waiting', 'applied', 'unused']);
const REPLY_PLAN_STATUSES = new Set(['waiting', 'preview', 'injected', 'omitted', 'cancelled']);
const FINAL_REPLY_PLAN_STATUSES = new Set(['omitted', 'cancelled']);
const REPLY_PLAN_FIELDS = ['replyPlan', 'replyPlanStatus', 'replyPlanReason', 'replyPlanTokens'];
const STRING_FIELDS = [
    'chatKey', 'chatName', 'generationType', 'schemeName', 'model', 'rawResponse',
    'error', 'errorStage', 'errorCode', 'applicationReason', 'replyPlanReason',
];
const NUMBER_FIELDS = ['startedAt', 'submittedAt', 'responseReceivedAt', 'finishedAt', 'durationMs', 'replyPlanTokens'];
const COUNT_FIELDS = ['blueAvailable', 'fixedGreen', 'greenCandidates', 'selected', 'included'];
const ENTRY_GROUP_FIELDS = ['plannedEntries', 'effectiveEntries'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uniqueId = () => globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const byNewest = (left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id);
const unfinished = value => value.requestStatus === 'pending'
    || value.applicationStatus === 'pending' || value.applicationStatus === 'waiting'
    || value.replyPlanStatus === 'waiting';

/** Only title metadata survives; body text and other entry fields are never copied. */
function entryGroups(value) {
    if (!record(value) || !Array.isArray(value.blue) || !Array.isArray(value.green)) return null;
    const seen = new Set();
    const cards = values => values.flatMap(card => {
        if (!record(card) || typeof card.id !== 'string' || !card.id.trim() || seen.has(card.id)) return [];
        seen.add(card.id);
        return [{
            id: card.id,
            book: typeof card.book === 'string' ? card.book : '',
            title: typeof card.title === 'string' ? card.title : '',
        }];
    });
    return { blue: cards(value.blue), green: cards(value.green) };
}

const cloneEntryGroups = value => ({
    blue: value.blue.map(card => ({ ...card })),
    green: value.green.map(card => ({ ...card })),
});

/** Only display data is accepted; request payloads, headers and credentials never enter this store. */
function fields(value) {
    if (!record(value)) return {};
    const result = {};
    for (const key of STRING_FIELDS) {
        if (typeof value[key] === 'string') result[key] = value[key];
    }
    for (const key of NUMBER_FIELDS) {
        if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
    }
    if (['generation', 'preview'].includes(value.kind)) result.kind = value.kind;
    if (REQUEST_STATUSES.has(value.requestStatus)) result.requestStatus = value.requestStatus;
    if (VALIDATION_STATUSES.has(value.validationStatus)) result.validationStatus = value.validationStatus;
    if (APPLICATION_STATUSES.has(value.applicationStatus)) result.applicationStatus = value.applicationStatus;
    if (REPLY_PLAN_STATUSES.has(value.replyPlanStatus)) result.replyPlanStatus = value.replyPlanStatus;
    const plan = replyPlanSnapshot(value.replyPlan);
    if (plan) result.replyPlan = plan;
    for (const key of ['lateResponse', 'durationUnknown', 'recovered']) {
        if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    if (record(value.counts)) {
        result.counts = {};
        for (const key of COUNT_FIELDS) {
            const count = value.counts[key];
            if (typeof count === 'number' && Number.isFinite(count) && count >= 0) result.counts[key] = count;
        }
    }
    for (const key of ENTRY_GROUP_FIELDS) {
        const groups = entryGroups(value[key]);
        if (groups) result[key] = groups;
    }
    return result;
}

/** A final local plan decision cannot be rewritten by a late response or later cancellation. */
function protectReplyPlan(previous, update) {
    const discard = () => { for (const key of REPLY_PLAN_FIELDS) delete update[key]; };
    const delivered = ['preview', 'injected'].includes(previous.replyPlanStatus);
    const applicationFinal = ['preview', 'applied', 'unused'].includes(previous.applicationStatus);
    if (FINAL_REPLY_PLAN_STATUSES.has(previous.replyPlanStatus) || (delivered && applicationFinal)
        || (previous._sealed && previous.requestStatus !== 'returned')) {
        discard();
        return;
    }
    if (delivered) {
        // A staged injection may still be omitted by final prompt construction, never replaced or revived.
        delete update.replyPlan;
        delete update.replyPlanTokens;
        if (update.replyPlanStatus && ![previous.replyPlanStatus, 'omitted', 'cancelled'].includes(update.replyPlanStatus)) discard();
    }
    if (update.lateResponse === true) discard();
    const request = update.requestStatus ?? previous.requestStatus;
    const validation = update.validationStatus ?? previous.validationStatus;
    const application = update.applicationStatus ?? previous.applicationStatus;
    const applicationPending = ['pending', 'waiting'].includes(previous.applicationStatus);
    const requestEnded = ['failed', 'timeout', 'cancelled'].includes(request) || validation === 'invalid';
    const recoveringPlan = update.recovered === true
        && (previous.replyPlanStatus === 'waiting' || (delivered && applicationPending));
    const canCancel = requestEnded || recoveringPlan
        || (applicationPending && !['applied', 'preview'].includes(application));
    if (update.replyPlanStatus === 'cancelled' && !canCancel) discard();
    if (['preview', 'injected'].includes(update.replyPlanStatus)
        && (request !== 'returned' || validation !== 'valid')) discard();
    const interrupted = requestEnded || recoveringPlan || (applicationPending && application === 'unused');
    const status = update.replyPlanStatus ?? previous.replyPlanStatus;
    if (interrupted && (status === 'waiting' || (applicationPending && ['preview', 'injected'].includes(status)))) {
        update.replyPlanStatus = 'cancelled';
        update.replyPlanReason = update.replyPlanReason || update.applicationReason || update.error
            || '本轮未完成，待用导演方案已清理。';
    }
}

function storedRecord(value) {
    if (!record(value) || typeof value.id !== 'string' || !value.id) return null;
    const data = fields(value);
    if (!data.chatKey || data.startedAt === undefined) return null;
    return {
        id: value.id, kind: 'generation', generationType: 'normal',
        requestStatus: 'pending', validationStatus: 'pending', applicationStatus: 'pending',
        rawResponse: '', error: '', errorStage: '', applicationReason: '', lateResponse: false,
        ...data,
        _ownerSession: typeof value._ownerSession === 'string' ? value._ownerSession : '',
        _revision: Number.isInteger(value._revision) && value._revision >= 0 ? value._revision : 0,
        _sealed: value._sealed === true || (data.requestStatus && data.requestStatus !== 'pending'),
    };
}

/**
 * One browser-local history per server and authenticated account.
 * Updates are immediate in memory; persistence failures never reject a scheduler request.
 */
export class SchedulerHistoryStore {
    constructor({ getContext, onChange } = {}) {
        this.getContext = getContext;
        this._records = new Map();
        this._listeners = new Set();
        if (typeof onChange === 'function') this._listeners.add(onChange);
        this._storageError = '';
        this._removedIds = new Set();
        this._unconfirmed = new Set();
        this._writeChain = Promise.resolve();
        this._sessionId = uniqueId();
        this._sessionClosed = false;
        this._sessionLockAvailable = false;
        this._pageHide = event => {
            if (!event.persisted) this.dispose();
        };
        globalThis.addEventListener?.('pagehide', this._pageHide);
        this.ready = this.initialize();
    }

    get storageError() { return this._storageError; }

    get records() {
        return [...this._records.values()].sort(byNewest).map(value => {
            const { _ownerSession, _revision, _sealed, ...copy } = value;
            if (copy.counts) copy.counts = { ...copy.counts };
            if (copy.replyPlan) copy.replyPlan = replyPlanSnapshot(copy.replyPlan);
            for (const key of ENTRY_GROUP_FIELDS) {
                if (copy[key]) copy[key] = cloneEntryGroups(copy[key]);
            }
            if (this._unconfirmed.has(copy.id)) copy.recoveryUnconfirmed = true;
            return copy;
        });
    }

    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    initialize() {
        if (!this._initialization) {
            this._initialization = this._initialize().catch(error => {
                this._fail(error);
            }).then(() => this);
        }
        return this._initialization;
    }

    async _initialize() {
        if (accountsEnabled && !currentUser?.handle) {
            throw new Error('尚未取得当前酒馆账号，无法读取或持久保存该账号的调度历史。');
        }
        const handle = getCurrentUserHandle();
        this._dbName = `echo-workbench-scheduler-history:${JSON.stringify([SERVER_ROOT, handle])}`;
        this._closedKey = `${this._dbName}:closed-sessions`;
        this._openChannel();
        await this._holdSessionLock();
        this._db = await this._openDatabase();
        const saved = await this._readAll();
        for (const raw of saved) {
            const value = storedRecord(raw);
            if (!value || this._removedIds.has(value.id)) continue;
            const existing = this._records.get(value.id);
            if (!existing || (existing._ownerSession !== this._sessionId && value._revision > existing._revision)) {
                this._records.set(value.id, value);
            }
        }
        const live = await this._probeSessions();
        const owners = [...new Set([...this._records.values()].filter(unfinished)
            .filter(value => value._ownerSession !== this._sessionId).map(value => value._ownerSession))];
        const closed = this._closedSessions();
        const ownerStates = new Map(await Promise.all(owners.map(async owner => [
            owner, live.has(owner) ? false : await this._ownerEnded(owner, closed),
        ])));
        for (const value of [...this._records.values()]) {
            if (!unfinished(value) || value._ownerSession === this._sessionId) continue;
            const ended = ownerStates.get(value._ownerSession);
            if (ended) this._recover(value, closed[value._ownerSession]);
            else if (ended === undefined && !live.has(value._ownerSession)) this._unconfirmed.add(value.id);
        }
        this._pruneMemory();
        this._notify();
        this._enqueue(() => this._pruneDatabase());
    }

    begin(metadata = {}) {
        const id = uniqueId();
        const now = Date.now();
        const initial = fields(metadata);
        delete initial.effectiveEntries;
        for (const key of REPLY_PLAN_FIELDS) delete initial[key];
        for (const key of ['submittedAt', 'responseReceivedAt', 'finishedAt', 'durationMs', 'durationUnknown', 'recovered']) {
            delete initial[key];
        }
        this._records.set(id, {
            id, chatName: '', kind: 'generation', generationType: 'normal',
            startedAt: now, schemeName: '', model: '',
            ...initial,
            chatKey: initial.chatKey || 'unknown',
            rawResponse: '', error: '', errorStage: '', errorCode: '', applicationReason: '', lateResponse: false,
            requestStatus: 'pending', validationStatus: 'pending', applicationStatus: 'pending',
            replyPlanStatus: 'waiting', replyPlanReason: '',
            _ownerSession: this._sessionId, _revision: 1, _sealed: false,
        });
        this._pruneMemory();
        this._notify();
        this._enqueue(() => this._saveRecord(id));
        return id;
    }

    patch(id, changes = {}) {
        const previous = this._records.get(id);
        if (!previous) return;
        const update = fields(changes);
        if (previous._sealed) {
            delete update.requestStatus;
            delete update.finishedAt;
            delete update.durationMs;
            if (previous.requestStatus !== 'returned') {
                delete update.validationStatus;
                delete update.error;
                delete update.errorStage;
                delete update.errorCode;
                delete update.applicationReason;
                delete update.counts;
                delete update.plannedEntries;
                delete update.effectiveEntries;
                if (update.applicationStatus && update.applicationStatus !== 'unused') delete update.applicationStatus;
                if (update.rawResponse && update.rawResponse !== previous.rawResponse) update.lateResponse = true;
            } else if (['valid', 'invalid'].includes(previous.validationStatus)
                && update.validationStatus !== previous.validationStatus) {
                delete update.validationStatus;
            }
            if (['preview', 'applied', 'unused'].includes(previous.applicationStatus)
                && update.applicationStatus !== previous.applicationStatus) delete update.applicationStatus;
        }
        protectReplyPlan(previous, update);
        if ((update.requestStatus ?? previous.requestStatus) !== 'returned'
            || (update.validationStatus ?? previous.validationStatus) !== 'valid'
            || (update.applicationStatus ?? previous.applicationStatus) !== 'applied') delete update.effectiveEntries;
        if (update.rawResponse === '' && previous.rawResponse) delete update.rawResponse;
        if (update.counts) update.counts = { ...previous.counts, ...update.counts };
        this._records.set(id, { ...previous, ...update, _revision: previous._revision + 1 });
        this._unconfirmed.delete(id);
        this._pruneMemory();
        this._notify();
        this._enqueue(() => this._saveRecord(id));
    }

    complete(id, changes = {}) {
        const previous = this._records.get(id);
        if (!previous) return;
        if (previous._sealed) {
            this.patch(id, changes);
            return;
        }
        const update = fields(changes);
        const status = update.requestStatus && update.requestStatus !== 'pending'
            ? update.requestStatus : previous.requestStatus !== 'pending'
                ? previous.requestStatus : update.error ? 'failed' : 'returned';
        update.requestStatus = status;
        protectReplyPlan(previous, update);
        if (status !== 'returned' || (update.validationStatus ?? previous.validationStatus) !== 'valid'
            || (update.applicationStatus ?? previous.applicationStatus) !== 'applied') delete update.effectiveEntries;
        const finishedAt = update.finishedAt ?? Date.now();
        const next = {
            ...previous, ...update,
            requestStatus: status,
            finishedAt,
            durationMs: update.durationMs ?? Math.max(0, finishedAt - previous.startedAt),
            _revision: previous._revision + 1, _sealed: true,
        };
        if (next.counts) next.counts = { ...previous.counts, ...next.counts };
        if (status !== 'returned' || next.validationStatus === 'invalid') {
            next.applicationStatus = 'unused';
            delete next.effectiveEntries;
            if (next.validationStatus === 'pending') next.validationStatus = 'not-run';
        }
        if (next.durationUnknown) delete next.durationMs;
        if (next.rawResponse === '' && previous.rawResponse) next.rawResponse = previous.rawResponse;
        this._records.set(id, next);
        this._unconfirmed.delete(id);
        this._pruneMemory();
        this._notify();
        this._enqueue(() => this._saveRecord(id));
    }

    _recover(value, closedAt) {
        const reason = '页面关闭或刷新，未取得最终结果。';
        if (value.requestStatus === 'pending') {
            this.complete(value.id, {
                requestStatus: 'cancelled', validationStatus: 'not-run', applicationStatus: 'unused',
                error: reason, errorStage: 'recovery', errorCode: 'page-interrupted', applicationReason: reason,
                finishedAt: typeof closedAt === 'number' ? Math.max(closedAt, value.startedAt) : Date.now(),
                durationUnknown: !closedAt, recovered: true,
            });
        } else {
            const applicationPending = ['pending', 'waiting'].includes(value.applicationStatus);
            const planPending = value.replyPlanStatus === 'waiting'
                || (applicationPending && ['preview', 'injected'].includes(value.replyPlanStatus));
            this.patch(value.id, {
                recovered: true,
                ...(applicationPending ? {
                    applicationStatus: 'unused', applicationReason: reason,
                    ...(value.validationStatus === 'pending' ? { validationStatus: 'not-run' } : {}),
                    ...(value.error ? {} : { error: reason, errorStage: 'recovery', errorCode: 'page-interrupted' }),
                } : {}),
                ...(planPending ? { replyPlanStatus: 'cancelled', replyPlanReason: reason } : {}),
            });
        }
    }

    _notify() {
        for (const listener of this._listeners) {
            try { listener(this); } catch { /* A view must not interrupt an API request. */ }
        }
    }

    _fail(error) {
        this._storageError = `调度历史暂时无法持久保存，本次记录仍保留在当前页面内存中。${error?.message || ''}`;
        this._notify();
    }

    _enqueue(action) {
        this._writeChain = this._writeChain.then(async () => {
            await this.ready;
            if (this._db) await action();
        }).catch(error => this._fail(error));
    }

    _openDatabase() {
        return new Promise((resolve, reject) => {
            if (!globalThis.indexedDB) { reject(new Error('当前浏览器未提供本地数据库。')); return; }
            const request = globalThis.indexedDB.open(this._dbName, 1);
            let stopped = false;
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
                    request.result.createObjectStore(RECORD_STORE, { keyPath: 'id' });
                }
            };
            request.onerror = () => { stopped = true; reject(request.error || new Error('无法打开浏览器历史数据库。')); };
            request.onblocked = () => { stopped = true; reject(new Error('历史数据库被其他页面占用，请关闭旧页面后刷新。')); };
            request.onsuccess = () => {
                const database = request.result;
                if (stopped || this._sessionClosed) { database.close(); reject(new Error('历史存储页面已经关闭。')); return; }
                database.onversionchange = () => {
                    database.close();
                    if (this._db === database) this._db = null;
                    this._fail(new Error('历史数据库已更新，请刷新页面后继续保存。'));
                };
                resolve(database);
            };
        });
    }

    _readAll() {
        return new Promise((resolve, reject) => {
            const transaction = this._db.transaction(RECORD_STORE, 'readonly');
            const request = transaction.objectStore(RECORD_STORE).getAll();
            let result = [];
            request.onsuccess = () => { result = request.result; };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => reject(transaction.error || new Error('读取调度历史失败。'));
            transaction.onerror = () => reject(transaction.error || new Error('读取调度历史失败。'));
        });
    }

    _saveRecord(id) {
        if (!this._records.has(id) || this._removedIds.has(id)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const transaction = this._db.transaction(RECORD_STORE, 'readwrite');
            const store = transaction.objectStore(RECORD_STORE);
            const request = store.get(id);
            let written = false;
            let removed = [];
            request.onsuccess = () => {
                const value = this._records.get(id);
                if (!value || this._removedIds.has(id)) return;
                const saved = storedRecord(request.result);
                if (saved && saved._revision > value._revision) {
                    this._adopt(saved);
                    return;
                }
                store.put(value);
                written = true;
                const all = store.getAll();
                all.onsuccess = () => { removed = this._deleteOldest(store, all.result); };
            };
            transaction.oncomplete = () => {
                this._forget(removed);
                if (written) this._broadcast({ type: 'updated', id });
                if (removed.length) this._broadcast({ type: 'removed', ids: removed });
                resolve();
            };
            transaction.onabort = () => reject(transaction.error || new Error('保存调度历史失败。'));
            transaction.onerror = () => reject(transaction.error || new Error('保存调度历史失败。'));
        });
    }

    _deleteOldest(store, raw) {
        const entries = raw.map(storedRecord).filter(Boolean).sort(byNewest);
        const oldest = entries.slice().reverse();
        const removable = [
            ...oldest.filter(value => !unfinished(value)),
            ...oldest.filter(value => unfinished(value) && this._unconfirmed.has(value.id)),
        ];
        const removed = [];
        let excess = entries.length - RECORD_LIMIT;
        for (const value of removable) {
            if (excess-- <= 0) break;
            store.delete(value.id);
            removed.push(value.id);
        }
        return removed;
    }

    _pruneDatabase() {
        return new Promise((resolve, reject) => {
            const transaction = this._db.transaction(RECORD_STORE, 'readwrite');
            const store = transaction.objectStore(RECORD_STORE);
            const request = store.getAll();
            let removed = [];
            request.onsuccess = () => { removed = this._deleteOldest(store, request.result); };
            transaction.oncomplete = () => {
                this._forget(removed);
                if (removed.length) this._broadcast({ type: 'removed', ids: removed });
                resolve();
            };
            transaction.onabort = () => reject(transaction.error || new Error('整理调度历史失败。'));
            transaction.onerror = () => reject(transaction.error || new Error('整理调度历史失败。'));
        });
    }

    _pruneMemory() {
        let excess = this._records.size - RECORD_LIMIT;
        if (excess <= 0) return;
        const oldest = [...this._records.values()].sort(byNewest).reverse();
        const removable = [
            ...oldest.filter(value => !unfinished(value)),
            ...oldest.filter(value => unfinished(value) && this._unconfirmed.has(value.id)),
        ];
        const removed = [];
        for (const value of removable) {
            if (excess-- <= 0) break;
            this._removedIds.add(value.id);
            this._records.delete(value.id);
            this._unconfirmed.delete(value.id);
            removed.push(value.id);
        }
        if (removed.length) this._enqueue(() => this._deleteRecords(removed));
    }

    _deleteRecords(ids) {
        return new Promise((resolve, reject) => {
            const transaction = this._db.transaction(RECORD_STORE, 'readwrite');
            const store = transaction.objectStore(RECORD_STORE);
            for (const id of ids) store.delete(id);
            transaction.oncomplete = () => { this._broadcast({ type: 'removed', ids }); resolve(); };
            transaction.onabort = () => reject(transaction.error || new Error('清理最旧调度历史失败。'));
            transaction.onerror = () => reject(transaction.error || new Error('清理最旧调度历史失败。'));
        });
    }

    _forget(ids) {
        if (!ids.length) return;
        for (const id of ids) {
            this._removedIds.add(id);
            this._unconfirmed.delete(id);
            this._records.delete(id);
        }
        this._notify();
    }

    _adopt(value) {
        if (!value || this._removedIds.has(value.id)) return;
        const previous = this._records.get(value.id);
        if (previous && previous._revision >= value._revision) return;
        this._records.set(value.id, value);
        this._unconfirmed.delete(value.id);
        this._pruneMemory();
        this._notify();
    }

    _openChannel() {
        if (!globalThis.BroadcastChannel) return;
        try {
            this._channel = new BroadcastChannel(this._dbName);
            this._probes = new Map();
            this._channel.onmessage = ({ data }) => {
                if (!record(data) || this._sessionClosed) return;
                if (data.type === 'presence-query') {
                    this._broadcast({ type: 'presence-reply', nonce: data.nonce, session: this._sessionId });
                } else if (data.type === 'presence-reply') {
                    this._probes.get(data.nonce)?.add(data.session);
                } else if (data.type === 'removed' && Array.isArray(data.ids)) {
                    this._forget(data.ids.filter(id => typeof id === 'string'));
                } else if (data.type === 'updated' && typeof data.id === 'string') {
                    this._enqueue(() => new Promise((resolve, reject) => {
                        const transaction = this._db.transaction(RECORD_STORE, 'readonly');
                        const request = transaction.objectStore(RECORD_STORE).get(data.id);
                        request.onsuccess = () => this._adopt(storedRecord(request.result));
                        transaction.oncomplete = () => resolve();
                        transaction.onabort = () => reject(transaction.error || new Error('同步调度历史失败。'));
                        transaction.onerror = () => reject(transaction.error || new Error('同步调度历史失败。'));
                    }));
                }
            };
        } catch { /* Local history remains usable without cross-page notifications. */ }
    }

    _broadcast(message) {
        try { this._channel?.postMessage(message); } catch { /* The page may already be closing. */ }
    }

    _probeSessions() {
        const live = new Set([this._sessionId]);
        if (!this._channel) return Promise.resolve(live);
        const nonce = uniqueId();
        this._probes.set(nonce, live);
        this._broadcast({ type: 'presence-query', nonce });
        return new Promise(resolve => {
            setTimeout(() => { this._probes.delete(nonce); resolve(live); }, 400);
        });
    }

    _lockName(session) { return `${this._dbName}:session:${session}`; }

    _holdSessionLock() {
        if (!globalThis.navigator?.locks?.request) return Promise.resolve();
        return new Promise(resolve => {
            try {
                globalThis.navigator.locks.request(this._lockName(this._sessionId), async () => {
                    if (this._sessionClosed) { resolve(); return; }
                    this._sessionLockAvailable = true;
                    resolve();
                    await new Promise(release => { this._releaseSession = release; });
                }).catch(() => { this._sessionLockAvailable = false; resolve(); });
            } catch { resolve(); }
        });
    }

    async _ownerEnded(owner, closed) {
        if (!owner) return true;
        if (this._sessionLockAvailable) {
            try {
                return await globalThis.navigator.locks.request(this._lockName(owner), { ifAvailable: true },
                    lock => Boolean(lock));
            } catch { /* Use a definite page-close marker when session locks are unavailable. */ }
        }
        return closed[owner] ? true : undefined;
    }

    _closedSessions() {
        try {
            const value = JSON.parse(globalThis.localStorage.getItem(this._closedKey) || '{}');
            if (!record(value)) return {};
            return Object.fromEntries(Object.entries(value).filter(([, at]) =>
                typeof at === 'number' && Number.isFinite(at) && at > 0));
        } catch { return {}; }
    }

    _markClosed() {
        if (!this._closedKey) return;
        try {
            const recent = Object.entries(this._closedSessions()).filter(([, at]) =>
                typeof at === 'number' && at >= Date.now() - 30 * 24 * 60 * 60 * 1000);
            recent.push([this._sessionId, Date.now()]);
            recent.sort((left, right) => right[1] - left[1]);
            globalThis.localStorage.setItem(this._closedKey, JSON.stringify(Object.fromEntries(recent.slice(0, 256))));
        } catch { /* An absent close marker is treated conservatively on the next page. */ }
    }

    /** End the store's page lifetime; closing the workbench alone must not dispose this store. */
    dispose() {
        if (this._sessionClosed) return;
        this._sessionClosed = true;
        this._markClosed();
        this._releaseSession?.();
        this._channel?.close();
        globalThis.removeEventListener?.('pagehide', this._pageHide);
    }
}
