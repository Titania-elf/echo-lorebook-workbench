import { historyFailure } from '../history/scheduler-history.js';
import { bookWatermark, contextKey, reserveBookWatermark, sameValue, UID_LIMIT } from '../workbench/workbench-state.js';
import { organizationBackupName, organizationMetadata } from './organization-index.js';
import {
    categoryMessages, materializeOrganization, organizationBatches, organizationMessages, organizationSnapshotVersion,
    organizationSources, organizationUnits, organizationWindow, parseOrganizationCategories, parseOrganizationParts,
} from './organization-plan.js';

const assertRunning = signal => {
    if (signal?.aborted) throw signal.reason || new DOMException('整理已取消。', 'AbortError');
};

function requestLimits(context, config) {
    const followMain = config.apiMode === 'main'
        || (config.apiMode === 'scheme' && config.apiSchemes.find(item => item.id === config.apiSchemeId)?.source === 'main');
    const known = followMain ? Number(context.chatCompletionSettings?.openai_max_context) : 0;
    const capacity = known > 0 ? Math.min(known, 28000) : 12000;
    const output = Math.min(6800, Math.floor(capacity * .40));
    const input = capacity - output - 900; // Leave room for the fixed rules and framing.
    if (input < 1500 || output < 1240) throw new Error('当前连接的上下文太短，无法安全整理。请换用更长上下文的 API 方案。');
    return { input, output };
}

const shortCard = part => ({ title: part.title, category: part.category, summary: part.summary, keywords: part.keywords });

export class BookOrganizer {
    constructor({ store, getContext, requestModel }) {
        Object.assign(this, { store, getContext, requestModel });
        this.api = store.api;
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
        const limits = requestLimits(context, config);
        const batches = organizationBatches(sources, limits);
        onProgress('正在创建并核对完整备份…');
        const backup = await this.api.createOrganizationBackup(book, baseline, { signal });
        assertRunning(signal);

        const request = async (messages, maxTokens = limits.output) => {
            assertRunning(signal);
            const result = await this.requestModel(context, config, messages, signal, maxTokens);
            assertRunning(signal);
            return result;
        };
        try {
            const proposals = new Map();
            for (const [index, batch] of batches.entries()) {
                onProgress(`已备份《${backup}》。正在通读原文：${index + 1} / ${batches.length} 批…`);
                const result = parseOrganizationParts(await request(organizationMessages(batch)), batch);
                for (const [id, parts] of result) proposals.set(id, parts);
            }
            const plans = new Map();
            for (const source of sources) {
                let parts = source.windows.flatMap(({ id, start }) => proposals.get(id).map(part => ({
                    ...part, start: start + part.start, end: start + part.end,
                })));
                if (source.windows.length > 1) {
                    onProgress(`正在统一长条目的拆分边界：${source.title.slice(0, 80)}…`);
                    parts = await this.combineWindows(source, parts, limits, request);
                }
                plans.set(source.uid, parts);
            }
            const labels = [...new Set([...plans.values()].flatMap(parts => parts.map(part => part.category)))];
            let unified = new Map();
            if (batches.length > 1 && labels.length > 1) {
                onProgress('全文已读完，正在统一各批次的分类…');
                if (organizationUnits(labels) > limits.input || organizationUnits(labels) + 100 > limits.output) {
                    throw new Error('分类数量超出当前模型可处理的范围。请换用更长上下文的连接。');
                }
                unified = parseOrganizationCategories(await request(categoryMessages(labels)), labels);
            }
            assertRunning(signal);
            const prepared = materializeOrganization(baseline, sources, plans, {
                book, backupName: backup, labels: unified,
                nextUid: data => this.store.nextUid(book, data), synchronize: this.api.synchronizeOriginalData.bind(this.api),
            });
            return { ...prepared, action: 'organize', book, backup, baseline,
                backupVersion: organizationSnapshotVersion(baseline), context: contextKey(context), pending: false };
        } catch (error) {
            assertRunning(signal);
            throw new Error(`${historyFailure(error, config).error} 原书未改动，备份《${backup}》已保留。`);
        }
    }

    async combineWindows(source, parts, limits, request) {
        const combine = async (group, maySplit) => {
            const wire = organizationWindow(source, 'long-entry', group.map(shortCard), { maySplit });
            const result = await request(organizationMessages([wire], { coalesce: true }));
            return parseOrganizationParts(result, [wire]).get(wire.id).map(part => ({
                ...part, start: group[part.start].start, end: group[part.end - 1].end,
            }));
        };
        // For exceptionally long entries, merge adjacent card windows without discarding any source span.
        const size = organizationUnits(organizationWindow(source, 'long-entry', [], { maySplit: false })) + 10;
        while (size + organizationUnits(parts.map(shortCard)) > limits.input) {
            const groups = [];
            let group = [], cost = size;
            for (const part of parts) {
                const next = organizationUnits(shortCard(part)) + 2;
                if (group.length && cost + next > limits.input) { groups.push(group); group = []; cost = size; }
                if (cost + next > limits.input) throw new Error('单条目录卡超出整理请求预算。');
                group.push(part); cost += next;
            }
            if (group.length) groups.push(group);
            if (groups.length >= parts.length) throw new Error('长条目的目录无法在当前请求预算下合并。');
            parts = [];
            for (const chunk of groups) parts.push(...(chunk.length > 1 ? await combine(chunk, false) : chunk));
        }
        return combine(parts, !source.restriction);
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
        return { written: true, warning };
    }
}
