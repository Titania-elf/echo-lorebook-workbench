import {
    MODULE, EXTENSION_NAME, EXTENSION_FOLDER, settingsWithDefaults, makeCatalog, digest, entryId, historyChain, previousSnapshot,
    selectorPayload, SELECTOR_SYSTEM, SUMMARY_SYSTEM, validateSelection, allocateSelection,
    overlayEntries, recordSnapshot, parseJsonObject,
} from './core.js';

const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

export class LorebookDirector {
    constructor({ getContext, getEntries, requestModel, onChange = () => {}, onWarning = () => {} }) {
        this.getContext = getContext;
        this.getEntries = getEntries;
        this.requestModel = requestModel;
        this.onChange = onChange;
        this.onWarning = onWarning;
        this.catalog = [];
        this.activeBooks = [];
        this.report = null;
        this.status = '尚未运行。选择托管书后，可先试选而不发送正文。';
        this.operation = null;
        this.gate = null;
        this.revision = 0;
        this.listeners = new Set();
    }

    get config() { return settingsWithDefaults(this.getContext().extensionSettings[MODULE]); }
    get busy() { return Boolean(this.operation || this.gate); }

    chatKey(context = this.getContext()) {
        return JSON.stringify([context.groupId ?? null, context.characterId ?? null, context.chatId ?? null]);
    }

    signature(context = this.getContext()) {
        return digest([this.chatKey(context), historyChain(context.chat || []).at(-1)]);
    }

    state(context = this.getContext()) {
        const root = context.chatMetadata;
        if (!root) return { snapshots: [], overrides: {} };
        const state = root[MODULE] ||= { snapshots: [], overrides: {} };
        if (!Array.isArray(state.snapshots)) state.snapshots = [];
        if (!state.overrides || typeof state.overrides !== 'object' || Array.isArray(state.overrides)) state.overrides = {};
        return state;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        this.onChange(this);
        for (const listener of this.listeners) {
            try { listener(this); }
            catch (error) { console.warn('[回声书台] 工作台状态刷新失败', error); }
        }
    }

    async sourceSaved({ book, uid, deleted = false, context: originContext }) {
        this.invalidate('原世界书已保存，下次生成使用已保存的原文。');
        if (this.report) this.report = { ...this.report, stale: true };
        const id = entryId({ world: book, uid });
        const context = this.getContext();
        if (deleted) {
            const config = this.config;
            const summaries = { ...config.summaries };
            if (Object.hasOwn(summaries, id)) {
                delete summaries[id];
                context.extensionSettings[MODULE] = settingsWithDefaults({ ...config, summaries });
                context.saveSettingsDebounced();
            }
            if (originContext === this.chatKey(context)) {
                const state = this.state(context);
                delete state.overrides[id];
                state.snapshots = state.snapshots.map(snapshot => ({
                    ...snapshot,
                    selected: (Array.isArray(snapshot.selected) ? snapshot.selected : []).filter(item => item.id !== id),
                }));
                if (context.chatId) context.saveMetadataDebounced();
            }
            this.catalog = this.catalog.filter(item => item.id !== id);
        }
        await this.loadCatalog();
        this.notify();
    }

    invalidate(reason = '上下文已改变，下次生成会重新选择。', clear = false) {
        this.revision++;
        this.operation?.controller.abort(new Error(reason));
        this.operation = null;
        this.gate = null;
        if (clear) { this.catalog = []; this.activeBooks = []; this.report = null; }
        this.status = reason;
        this.notify();
    }

    updateSettings(patch) {
        this.invalidate('设置已更新，下次生成生效。');
        const context = this.getContext();
        context.extensionSettings[MODULE] = settingsWithDefaults({ ...this.config, ...patch });
        context.saveSettingsDebounced();
        this.notify();
    }

    setOverride(id, mode) {
        const context = this.getContext();
        if (!context.chatId) return;
        const state = this.state(context);
        const candidate = this.catalog.some(x => x.id === id);
        // A disabled/unmounted entry may still have an old rule that must be releasable.
        if (!candidate && !(mode === 'auto' && Object.hasOwn(state.overrides, id))) return;
        this.invalidate('手动规则已更新，下次试选或生成时生效。');
        if (mode === 'pin' || mode === 'exclude') state.overrides[id] = mode;
        else delete state.overrides[id];
        context.saveMetadataDebounced();
        this.notify();
    }

    clearState() {
        this.invalidate('本聊天场景记忆已清空；手动固定/排除仍保留。');
        const context = this.getContext();
        this.state(context).snapshots = [];
        if (context.chatId) context.saveMetadataDebounced();
        this.report = null;
        this.notify();
    }

    begin(kind) {
        this.invalidate('正在准备目录…');
        const context = this.getContext();
        if (!context.chatId) throw new Error('请先打开一个角色聊天。');
        const op = {
            kind, revision: this.revision, signature: this.signature(context), chatKey: this.chatKey(context),
            controller: new AbortController(), config: this.config,
        };
        this.operation = op;
        this.notify();
        return op;
    }

    assertCurrent(op) {
        if (this.operation !== op || op.controller.signal.aborted || op.revision !== this.revision || op.signature !== this.signature()) {
            throw new Error('对话或设置已改变，已丢弃旧请求的结果。');
        }
    }

    async loadCatalog() {
        if (this.busy) return;
        const revision = this.revision;
        const signature = this.signature();
        try {
            const entries = await this.getEntries();
            if (this.busy || revision !== this.revision || signature !== this.signature()) return;
            this.activeBooks = [...new Set(entries.map(x => x.world))];
            this.catalog = makeCatalog(entries, this.config.books, this.config.summaries);
            this.notify();
        } catch (error) {
            if (revision === this.revision) { this.status = `读取目录失败：${error.message}`; this.notify(); }
        }
    }

    async select(chat, op) {
        const entries = await this.getEntries();
        this.assertCurrent(op);
        this.activeBooks = [...new Set(entries.map(x => x.world))];
        this.catalog = makeCatalog(entries, op.config.books, op.config.summaries);
        const catalog = this.catalog;
        const state = this.state();
        const overrides = { ...state.overrides };
        const previous = previousSnapshot(state.snapshots, historyChain(chat));
        let choice = { scene: previous?.scene || '', selected: [] };
        const modelCatalog = catalog.filter(x => overrides[x.id] !== 'exclude');
        if (modelCatalog.some(x => overrides[x.id] !== 'pin')) {
            const payload = selectorPayload(modelCatalog, chat, previous, overrides, op.config);
            this.status = `资料管理员正在阅读 ${modelCatalog.length} 张目录卡片…`;
            this.notify();
            const response = await this.requestModel(this.getContext(), op.config, [
                { role: 'system', content: SELECTOR_SYSTEM },
                { role: 'user', content: JSON.stringify(payload) },
            ], op.controller.signal);
            this.assertCurrent(op);
            choice = validateSelection(response, modelCatalog);
        }
        const context = this.getContext();
        const result = await allocateSelection(choice, catalog, overrides, op.config,
            text => context.getTokenCountAsync(context.substituteParams(String(text))));
        this.assertCurrent(op);
        return result;
    }

    async intercept(chat, _contextSize, _abort, type) {
        const config = this.config;
        const context = this.getContext();
        const identities = new Set([MODULE, EXTENSION_NAME, EXTENSION_FOLDER,
            `third-party/${MODULE}`, `third-party/${EXTENSION_NAME}`, `third-party/${EXTENSION_FOLDER}`]);
        const extensionDisabled = context.extensionSettings.disabledExtensions?.some(name => identities.has(name));
        if (!config.enabled || extensionDisabled || !config.books.length || !SUPPORTED_TYPES.has(type || 'normal')) return;
        let op;
        try {
            op = this.begin('generation');
            const input = structuredClone(chat);
            const result = await this.select(input, op);
            this.assertCurrent(op);
            this.report = { ...result, mode: 'generation', actual: [], at: Date.now(), chatKey: op.chatKey };
            this.gate = {
                revision: this.revision, signature: op.signature, books: [...config.books],
                selected: new Set(result.selected.map(x => x.id)), result, input,
            };
            this.status = `已选 ${result.selected.length} 条，等待原生世界书扫描。`;
        } catch (error) {
            // Fail open deliberately: without a gate, native blue/green/vector behavior is untouched.
            if (!op || this.operation === op) {
                this.gate = null;
                this.report = { mode: 'fallback', selected: [], skipped: [], actual: [], error: error.message, chatKey: op?.chatKey || this.chatKey(context) };
                this.status = `选书失败，本轮回退原生触发：${error.message}`;
                this.onWarning(this.status);
            }
        } finally {
            if (this.operation === op) this.operation = null;
            this.notify();
        }
    }

    gateIsCurrent() {
        return this.gate && this.gate.revision === this.revision && this.gate.signature === this.signature() && this.config.enabled;
    }

    onEntriesLoaded(payload) {
        if (this.gateIsCurrent()) overlayEntries(payload, this.gate.books, this.gate.selected);
    }

    onActivated(entries) {
        if (!this.gateIsCurrent() || this.report?.mode !== 'generation') return;
        this.report.actual = entries.map(entryId).filter(id => this.gate.selected.has(id));
        this.notify();
    }

    onPromptReady() {
        if (!this.gateIsCurrent()) { this.gate = null; return; }
        const { input, result } = this.gate;
        const actual = new Set(this.report?.actual || []);
        const context = this.getContext();
        this.state(context).snapshots = recordSnapshot(this.state(context).snapshots, input, {
            ...result, selected: result.selected.filter(x => actual.has(x.id)),
        });
        context.saveMetadataDebounced();
        this.status = `调度完成：选中 ${result.selected.length} 条，原生激活 ${actual.size} 条。`;
        this.gate = null;
        this.notify();
    }

    async preview() {
        let op;
        try {
            op = this.begin('preview');
            const chat = structuredClone(this.getContext().chat || []);
            const result = await this.select(chat, op);
            this.assertCurrent(op);
            this.report = { ...result, mode: 'preview', actual: null, at: Date.now(), chatKey: op.chatKey };
            this.status = `试选完成：${result.selected.length} 条；没有注入正文，也没有更新场景记忆。`;
        } catch (error) {
            if (!op || this.operation === op) this.status = `试选失败：${error.message}`;
        } finally {
            if (this.operation === op) this.operation = null;
            this.notify();
        }
    }

    async summarize() {
        let op;
        try {
            op = this.begin('summary');
            const entries = await this.getEntries();
            this.assertCurrent(op);
            const catalog = makeCatalog(entries, op.config.books, op.config.summaries);
            const missing = catalog.filter(x => x.summaryKind !== 'AI 概括');
            const eligible = missing.filter(x => x.entry.content.length <= 10000);
            const batches = [];
            let batch = [];
            let size = 0;
            for (const item of eligible) {
                if (batch.length && (size + item.entry.content.length > 12000 || batch.length >= 6)) {
                    batches.push(batch); batch = []; size = 0;
                }
                batch.push(item); size += item.entry.content.length;
            }
            if (batch.length) batches.push(batch);
            let completed = 0;
            for (const [index, items] of batches.entries()) {
                this.status = `生成 AI 目录：第 ${index + 1}/${batches.length} 批（仅处理新增/改动条目）。`;
                this.notify();
                const text = await this.requestModel(this.getContext(), op.config, [
                    { role: 'system', content: SUMMARY_SYSTEM },
                    { role: 'user', content: JSON.stringify(items.map(x => ({ id: x.id, title: x.title, content: x.entry.content }))) },
                ], op.controller.signal, 2200);
                this.assertCurrent(op);
                const parsed = parseJsonObject(text);
                if (!Array.isArray(parsed.summaries)) throw new Error('目录响应缺少 summaries 数组。');
                const expected = new Map(items.map(x => [x.id, x]));
                const validated = new Map();
                for (const summary of parsed.summaries) {
                    if (!expected.has(summary.id) || typeof summary.text !== 'string' || !summary.text.trim()) {
                        throw new Error('AI 目录返回了未知 ID 或空说明。');
                    }
                    validated.set(summary.id, { fingerprint: expected.get(summary.id).fingerprint, text: summary.text.slice(0, 400) });
                }
                if (validated.size !== expected.size) throw new Error('AI 目录漏掉了部分条目；本批结果未保存。');
                const context = this.getContext();
                const updated = this.config;
                updated.summaries = { ...updated.summaries, ...Object.fromEntries(validated) };
                context.extensionSettings[MODULE] = updated;
                context.saveSettingsDebounced();
                completed += validated.size;
            }
            this.catalog = makeCatalog(entries, op.config.books, this.config.summaries);
            this.activeBooks = [...new Set(entries.map(x => x.world))];
            this.status = `目录更新完成：新增 ${completed} 条 AI 概括。${missing.length - eligible.length} 条超过 10000 字符，保留原文摘录（建议拆分）。`;
        } catch (error) {
            if (!op || this.operation === op) this.status = `AI 目录未完成：${error.message} 已完成的批次保留。`;
        } finally {
            if (this.operation === op) this.operation = null;
            this.notify();
        }
    }
}
