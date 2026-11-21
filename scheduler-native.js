import { MODULE, entryId, entryVersion } from './core.js';

const SOURCE_KEYS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
const OWNER = '__echoLorebookSchedulerTurn';
const MASK = Object.freeze({
    disable: true, sticky: null, cooldown: null, delay: null,
    delayUntilRecursion: false, excludeRecursion: false, preventRecursion: true,
});

export function verifyNativeSources(payload, snapshot) {
    const books = new Set(snapshot.books);
    const seen = new Map();
    for (const key of SOURCE_KEYS) {
        if (!Array.isArray(payload?.[key])) throw new Error('酒馆没有返回完整的世界书来源列表。');
        for (const entry of payload[key]) {
            if (!books.has(entry.world)) continue;
            const id = entryId(entry);
            const version = entryVersion(entry);
            if (!snapshot.versions.has(id) || snapshot.versions.get(id) !== version) {
                throw new Error(`《${entry.world}》的原生读取与已保存内容不同，请先保存或刷新原书。`);
            }
            if (seen.has(id) && seen.get(id) !== version) throw new Error('同一个条目出现了不同的原生读取版本。');
            seen.set(id, version);
        }
    }
    if (seen.size !== snapshot.versions.size) throw new Error('部分已挂载的托管条目未被酒馆读取，已跳过本轮调度。');
}

/**
 * Ownership belongs to one generation and one native sorted array. Source-list swaps
 * never touch the book cache. Keep this object after cancellation until any already
 * cloned scan has also been restored.
 */
export class SchedulerScanGate {
    constructor({ snapshot, catalog, prepared, ...turn }) {
        Object.assign(this, turn);
        this.snapshot = snapshot;
        this.catalog = new Map(catalog.map(item => [item.id, item.entry]));
        this.prepared = prepared;
        this.nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.sources = [];
        this.scanEntries = null;
        this.activeMap = null;
        this.inserted = new Map();
        this.staged = false;
        this.cancelled = false;
        this.completed = false;
        this.injected = false;
        this.committed = false;
        this.recovered = false;
    }

    stage(payload) {
        if (this.staged) throw new Error('调度等待期间出现了另一轮世界书读取，已放弃本轮接管。');
        verifyNativeSources(payload, this.snapshot);
        const changes = [];
        for (const key of SOURCE_KEYS) {
            const entries = payload[key];
            for (let index = 0; index < entries.length; index++) {
                const original = entries[index];
                const id = entryId(original);
                if (!this.catalog.has(id)) continue;
                if (Object.hasOwn(original, OWNER)) throw new Error('世界书副本含有未清理的调度标记，已跳过本轮接管。');
                const staged = structuredClone(original);
                Object.assign(staged, MASK, { [OWNER]: { nonce: this.nonce, id, role: 'mask' } });
                changes.push({ entries, index, original, staged });
            }
        }
        // Prepare everything before swapping any element, so a copy/validation failure
        // leaves the native source lists unchanged.
        this.sources = changes;
        for (const change of changes) change.entries[change.index] = change.staged;
        this.staged = true;
    }

    owns(entry, role) {
        return entry?.[OWNER]?.nonce === this.nonce && (!role || entry[OWNER].role === role);
    }

    matches(entries) {
        return entries === this.scanEntries || entries.some(entry => this.owns(entry, 'mask'));
    }

    restoreFields(entry, original, parsed = false) {
        for (const [key, value] of Object.entries(MASK)) {
            if (entry[key] !== value) continue;
            if (Object.hasOwn(original, key)) entry[key] = structuredClone(original[key]);
            else delete entry[key];
        }
        if (parsed) {
            if (Object.hasOwn(original, 'hash')) entry.hash = original.hash;
            else delete entry.hash;
        }
        delete entry[OWNER];
    }

    restoreSources() {
        for (const change of this.sources) {
            const current = change.entries[change.index];
            if (current === change.staged) change.entries[change.index] = change.original;
            else if (this.owns(current, 'mask')) this.restoreFields(current, change.original);
        }
    }

    restoreScan(entries = this.scanEntries) {
        if (!entries) return;
        for (const entry of entries) {
            if (!this.owns(entry, 'mask')) continue;
            const original = this.catalog.get(entryId(entry));
            if (original) this.restoreFields(entry, original, true);
        }
    }

    removeInserted(map = this.activeMap) {
        if (!map) return;
        for (const [key] of this.inserted) if (this.owns(map.get(key), 'included')) map.delete(key);
    }

    cancel() {
        if (this.completed) return;
        this.cancelled = true;
        this.restoreSources();
        this.sources = [];
        this.restoreScan();
        this.removeInserted();
    }

    inject(args) {
        if (!Array.isArray(args.sortedEntries) || !(args.activated?.entries instanceof Map)) {
            throw new Error('酒馆的世界书扫描接口不完整。');
        }
        if (this.scanEntries && this.scanEntries !== args.sortedEntries) throw new Error('扫描已不属于本轮调度。');
        this.scanEntries = args.sortedEntries;
        this.activeMap = args.activated.entries;
        if (this.injected) {
            for (const [key, entry] of this.inserted) {
                if (this.activeMap.get(key) !== entry) throw new Error('本轮注入的条目已被其他扫描操作改变。');
            }
            return;
        }
        const seen = new Set();
        for (const entry of args.sortedEntries) {
            if (!this.owns(entry, 'mask')) continue;
            const id = entryId(entry);
            const original = this.catalog.get(id);
            if (!original) throw new Error('扫描副本中出现了不属于本轮的调度条目。');
            const restored = structuredClone(entry);
            this.restoreFields(restored, original, true);
            if (entryVersion(restored) !== entryVersion(original)) throw new Error('世界书条目在等待期间发生变化，已放弃本轮接管。');
            seen.add(id);
        }
        if (seen.size !== this.catalog.size) throw new Error('本轮接管的世界书副本不完整。');
        const copies = this.prepared.map(entry => {
            const copy = structuredClone(entry);
            copy[OWNER] = { nonce: this.nonce, id: entryId(copy), role: 'included' };
            return [JSON.stringify([MODULE, this.nonce, entryId(copy)]), copy];
        });
        for (const [key, copy] of copies) {
            this.activeMap.set(key, copy);
            this.inserted.set(key, copy);
        }
        this.injected = true;
        this.restoreSources();
    }

    acceptedIds(entries) {
        return entries.filter(entry => this.owns(entry, 'included')).map(entryId);
    }

    finish() {
        this.restoreSources();
        // Masked sorted copies must stay disabled until the host finishes scanning.
        // Their stamp is removed here only after prompt construction has completed.
        this.restoreScan();
        this.completed = true;
        this.sources = [];
        this.activeMap = null;
        this.scanEntries = null;
        this.inserted.clear();
    }
}
