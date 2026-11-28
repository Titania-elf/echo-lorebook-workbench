import { historyFailure } from '../history/scheduler-history.js';
import { bookWatermark, contextKey, reserveBookWatermark, sameValue, UID_LIMIT } from '../workbench/workbench-state.js';
import { organizationBackupName, organizationMetadata } from './organization-index.js';
import { bookCategories } from './book-categories.js';
import {
    materializeOrganization, organizationBatches, organizationMessages, organizationSnapshotVersion,
    organizationSources, parseOrganizationBatch, validateOrganizationParts,
} from './organization-plan.js';

const assertRunning = signal => {
    if (signal?.aborted) throw signal.reason || new DOMException('整理已取消。', 'AbortError');
};

const CHECKPOINT_SCHEMA = 1;

function replyBudget(context, config) {
    const scheme = config.apiMode === 'scheme' ? config.apiSchemes?.find(item => item.id === config.apiSchemeId) : null;
    const followsMain = config.apiMode === 'main' || scheme?.source === 'main';
    const known = followsMain ? Number(context.chatCompletionSettings?.openai_max_context) : 0;
    return known > 0 ? Math.max(1, Math.min(6800, Math.floor(known * .4))) : 6800;
}

export class BookOrganizer {
    constructor({ store, getContext, requestModel, checkpoints }) {
        Object.assign(this, { store, getContext, requestModel, checkpoints });
        this.api = store.api;
    }

    async progressFor(book) {
        const value = await this.checkpoints.read(book);
        return value?.schema === CHECKPOINT_SCHEMA ? { count: Object.keys(value.records || {}).length } : null;
    }

    async discardDraft(draft) {
        if (draft.checkpoint) await this.checkpoints.replace(draft.book, draft.checkpoint, null);
    }

    assertIdle() {
        if (this.store.busy || this.store.dirty || this.store.session?.pending) throw new Error('先处理当前世界书草稿或保存操作。');
    }

    async readSaved(book, signal) {
        const latest = await this.api.readBook(book, { fresh: true, signal });
        assertRunning(signal);
        const cached = this.api.cachedBook(book);
        if (cached && !sameValue(cached, latest)) throw new Error('原生编辑器中的世界书版本与磁盘不同。请先保存或刷新世界书，再继续。');
        return latest;
    }

    async prepare(book, { context, config, signal, onProgress = () => {} }) {
        this.assertIdle();
        onProgress('正在读取已保存的原书…');
        const baseline = await this.readSaved(book, signal);
        const sources = organizationSources(baseline);
        if (!sources.some(item => item.text.trim())) throw new Error('这本世界书没有可整理的正文。');
        const backupVersion = organizationSnapshotVersion(baseline);
        let checkpoint = await this.checkpoints.read(book);
        assertRunning(signal);
        const previous = checkpoint?.schema === CHECKPOINT_SCHEMA ? checkpoint : null;
        const fingerprints = new Map(sources.map(source => [source.uid, organizationSnapshotVersion([source.entry, source.category])]));
        const plans = new Map();
        const records = new Map();
        for (const source of sources) {
            const saved = previous?.records && Object.hasOwn(previous.records, source.uid) ? previous.records[source.uid] : null;
            if (!saved || saved.fingerprint !== fingerprints.get(source.uid)) continue;
            try {
                const parts = validateOrganizationParts(source, saved.parts);
                plans.set(source.uid, parts);
                records.set(source.uid, { fingerprint: saved.fingerprint, parts });
            } catch { /* The book is still untouched; invalid or outdated drafts are processed again. */ }
        }

        let backup = '';
        if (previous?.backupVersion === backupVersion && typeof previous.backup === 'string' && previous.backup !== book) {
            onProgress('正在核对上次保留的整书备份…');
            try {
                const saved = await this.api.readBook(previous.backup, { fresh: true, signal });
                if (sameValue(saved, baseline)) backup = previous.backup;
            } catch { assertRunning(signal); }
        }
        if (!backup) {
            onProgress('正在创建并核对完整备份…');
            backup = await this.api.createOrganizationBackup(book, baseline, { signal });
        }
        assertRunning(signal);
        const saveProgress = async () => {
            checkpoint = await this.checkpoints.replace(book, checkpoint, {
                schema: CHECKPOINT_SCHEMA, backup, backupVersion, records: Object.fromEntries(records),
            });
        };
        const categories = new Set(bookCategories(baseline).map(category => category.name));
        for (const parts of plans.values()) for (const part of parts) categories.add(part.category);
        const batches = organizationBatches(sources.filter(source => !plans.has(source.uid)));
        const failures = [];
        const maxTokens = replyBudget(context, config);
        try {
            await saveProgress();
            for (const [index, batch] of batches.entries()) {
                assertRunning(signal);
                const batchName = `第 ${index + 1}/${batches.length} 批`;
                onProgress(`已保留 ${plans.size}/${sources.length} 条进度。正在整理${batchName}（${batch.length} 条完整原文）…`);
                let text;
                try {
                    text = await this.requestModel(context, config, organizationMessages(batch, [...categories].slice(-60)), signal, maxTokens);
                } catch (error) {
                    assertRunning(signal);
                    throw new Error(`${batchName}（${batch.length} 条完整原文）请求失败：${historyFailure(error, config).error} 若模型上下文不足，请换用更长上下文的连接。`);
                }
                assertRunning(signal);
                let result;
                try { result = parseOrganizationBatch(text, batch); }
                catch (error) {
                    failures.push(`${batchName}：${error.message}`);
                    continue;
                }
                for (const [uid, parts] of result.plans) {
                    plans.set(uid, parts);
                    records.set(uid, { fingerprint: fingerprints.get(uid), parts });
                    for (const part of parts) categories.add(part.category);
                }
                if (result.plans.size) await saveProgress();
                for (const item of result.failures) failures.push(`${batchName}条目 #${item.uid}：${item.message}`);
            }
            assertRunning(signal);
            if (plans.size !== sources.length) {
                throw new Error(`还有 ${sources.length - plans.size} 条未完成。${failures.slice(0, 3).join(' ')}`);
            }
            const prepared = materializeOrganization(baseline, sources, plans, {
                book, backupName: backup,
                nextUid: data => this.store.nextUid(book, data), synchronize: this.api.synchronizeOriginalData.bind(this.api),
            });
            return { ...prepared, action: 'organize', book, backup, baseline, backupVersion, checkpoint,
                context: contextKey(context), pending: false };
        } catch (error) {
            assertRunning(signal);
            const count = checkpoint?.schema === CHECKPOINT_SCHEMA ? Object.keys(checkpoint.records || {}).length : 0;
            throw new Error(`${historyFailure(error, config).error} 原书未改动，备份《${backup}》已保留。本机草稿已有 ${count} 条，再次整理时只请求未完成或已变动的条目。`);
        }
    }

    async prepareRestore(book, signal) {
        this.assertIdle();
        const context = contextKey(this.getContext());
        const baseline = await this.readSaved(book, signal);
        const backup = organizationBackupName(baseline, book);
        if (!backup) throw new Error('这本书没有可恢复的整理备份。');
        const data = await this.api.readBook(backup, { fresh: true, signal });
        assertRunning(signal);
        const backupVersion = organizationSnapshotVersion(data);
        if (organizationMetadata(baseline).backup.fingerprint !== backupVersion) {
            throw new Error('备份内容与整理时的快照不同。请核对原书和备份，未进行恢复。');
        }
        // A restored book must not recycle child IDs that existing chats may still reference.
        const highUid = Object.keys(baseline.entries).reduce((max, key) => {
            const uid = Number(key);
            return Number.isInteger(uid) && uid >= 0 && uid < UID_LIMIT ? Math.max(max, uid) : max;
        }, Math.max(bookWatermark(baseline), this.store.settings.watermark(book)));
        if (highUid >= 0) reserveBookWatermark(data, highUid);
        return { action: 'restore', book, backup, baseline, data, context, backupVersion, highUid, pending: false,
            afterCount: Object.keys(data.entries).length };
    }

    async apply(draft) {
        if (draft.completed) throw new Error('这次整理已保存。');
        this.assertIdle();
        const { store, api } = this;
        const { book, baseline, backup, data } = draft;
        store.inFlight++;
        store.notify();
        try {
            return await store.serialized(book, async () => {
                if (draft.pending) {
                    const actual = await api.readBook(book, { fresh: true });
                    if (sameValue(actual, data)) {
                        const accepted = await api.acceptSaved(book, actual);
                        return this.finish(draft, accepted);
                    }
                    draft.pending = false;
                    if (!sameValue(actual, baseline)) {
                        draft.conflict = true;
                        throw new Error('原书当前版本与预览和待保存版本均不一致。请放弃此预览，核对原书和备份。');
                    }
                    // An explicit second confirmation is required after proving the original write did not land.
                    return { written: false };
                }
                if (draft.conflict || draft.context !== contextKey(this.getContext())) throw new Error('预览已失效，请重新打开世界书。');
                const savedBackup = await api.readBook(backup, { fresh: true });
                if (organizationSnapshotVersion(savedBackup) !== draft.backupVersion) {
                    throw new Error('备份在预览后发生变化，原书未覆盖。');
                }
                const current = await this.readSaved(book);
                if (draft.context !== contextKey(this.getContext()) || !sameValue(current, baseline)) {
                    throw new Error('原书或当前聊天在预览后发生变化，未覆盖。请重新读取后再操作。');
                }
                store.onBegin({ book, context: draft.context });
                if (draft.highUid >= 0) store.settings.reserve(book, draft.highUid);
                let accepted;
                try { accepted = await api.writeBook(book, data); }
                catch (error) {
                    if (error.uncertain) {
                        draft.pending = true;
                        api.invalidateReadCache?.(book);
                        throw new Error('写回结果尚未确定。请点「核对保存结果」重新读取，不要直接重试。');
                    }
                    throw error;
                }
                return this.finish(draft, accepted);
            });
        } finally {
            store.inFlight--;
            store.notify();
        }
    }

    async finish(draft, accepted) {
        draft.completed = true;
        draft.pending = false;
        const { store } = this;
        store.remember(draft.book, accepted.data);
        store.observeBook(draft.book, accepted.data);
        let warning = accepted.warning || '';
        try { await store.onCommit({ book: draft.book, uid: null, context: draft.context }); }
        catch { warning ||= '原书已保存，工作台未能刷新调度目录。'; }
        try { await this.discardDraft(draft); }
        catch { warning = [warning, '原书已保存，但本机整理草稿未能清理。'].filter(Boolean).join(' '); }
        return { written: true, warning };
    }
}
