import {
    MODULE, EXTENSION_NAME, EXTENSION_FOLDER, settingsWithDefaults, makeCatalog, digest, entryId, historyChain, previousSnapshot,
    selectorPayload, validateSelection, allocateSelection,
    recordSnapshot, parseJsonObject, recentContext, latestUserContext,
} from './core.js';
import { buildReplyPlanPrompt, missingReplyPlanEntries } from './reply-plan.js';
import { SchedulerScanGate, verifyNativeSources } from './scheduler-native.js';
import { buildPromptMessages } from './prompt-templates.js';
import {
    historyChatInfo, historyConnectionInfo, historyEntryGroups, historyEffectiveEntries,
    historyAbortError, historyFailure,
} from './scheduler-history.js';

const SUPPORTED_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const HISTORY_TIMEOUT_CODES = new Set(['ECHO_REQUEST_TIMEOUT', 'ECHO_SCHEDULER_TIMEOUT']);
const HISTORY_CANCEL_CODES = new Set(['ECHO_USER_CANCELLED', 'ECHO_CONTEXT_CHANGED', 'ECHO_GENERATION_ENDED', 'ECHO_SUPERSEDED']);

export class LorebookDirector {
    constructor({ getContext, getEntries, native, requestModel, history, onChange = () => {}, onWarning = () => {} }) {
        this.getContext = getContext;
        this.getEntries = getEntries;
        this.native = native;
        this.requestModel = requestModel;
        this.history = history;
        this.onChange = onChange;
        this.onWarning = onWarning;
        this.catalog = [];
        this.activeBooks = [];
        this.catalogError = '';
        this.report = null;
        this.status = '尚未运行。配置 API 后可以试运行导演方案；已挂载并托管的世界书提供蓝灯约束与绿灯参考。';
        this.operation = null;
        this.gate = null;
        this.revision = 0;
        this.listeners = new Set();
        this.nativeReads = new Set();
        this.scanGates = new Set();
        this.generationEpoch = 0;
        this.generationSignal = null;
        this.generationStopped = false;
        this.workSerial = 0;
        this.latestWork = 0;
    }

    get config() { return settingsWithDefaults(this.getContext().extensionSettings[MODULE]); }
    get busy() { return Boolean(this.operation || this.gate || this.native?.recovering); }

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
        try { this.onChange(this); }
        catch (error) { console.warn('[回声书台] 调度状态展示失败', error); }
        for (const listener of this.listeners) {
            try { listener(this); }
            catch (error) { console.warn('[回声书台] 工作台状态刷新失败', error); }
        }
    }

    beginHistory(op, context, type, counts, plannedEntries) {
        if (!this.history || op.historyId || op.kind === 'summary') return;
        try {
            const id = this.history.begin({
                ...op.historyChat, ...historyConnectionInfo(context, op.config),
                kind: op.kind, generationType: type, startedAt: Date.now(), counts, plannedEntries,
                replyPlanStatus: 'waiting', replyPlanReason: '',
            });
            if (!id) return;
            op.historyId = id;
            op.historyState = {
                requestStatus: 'pending', validationStatus: 'pending', applicationStatus: 'pending',
                sealed: false, responseSeen: false, receivedAt: null, hasBody: false, stage: 'prompt', counts: { ...counts },
                plannedEntries, replyPlanStatus: 'waiting', replyPlanReason: '',
            };
            op.historyAbort = () => this.failHistory(op, op.controller.signal.reason
                || historyAbortError('辅助请求已取消。', 'ECHO_USER_CANCELLED'));
            op.controller.signal.addEventListener('abort', op.historyAbort, { once: true });
        } catch {
            console.warn('[回声书台] 调度历史记录未能开始，调度照常继续。');
        }
    }

    patchHistory(turn, fields) {
        if (!turn?.historyId || !turn.historyState) return;
        const state = turn.historyState;
        for (const key of ['requestStatus', 'validationStatus', 'applicationStatus', 'lateResponse', 'replyPlanStatus', 'replyPlanReason', 'replyPlanTokens']) {
            if (fields[key] !== undefined) state[key] = fields[key];
        }
        if (fields.counts) state.counts = { ...state.counts, ...fields.counts };
        if (fields.plannedEntries) state.plannedEntries = fields.plannedEntries;
        try { this.history?.patch(turn.historyId, fields); }
        catch { console.warn('[回声书台] 调度历史更新失败，调度照常继续。'); }
    }

    completeHistory(turn, fields) {
        if (!turn?.historyId || !turn.historyState || turn.historyState.sealed) return;
        const state = turn.historyState;
        state.sealed = true;
        for (const key of ['requestStatus', 'validationStatus', 'applicationStatus', 'replyPlanStatus', 'replyPlanReason', 'replyPlanTokens']) {
            if (fields[key] !== undefined) state[key] = fields[key];
        }
        if (fields.counts) state.counts = { ...state.counts, ...fields.counts };
        try { this.history?.complete(turn.historyId, fields); }
        catch { console.warn('[回声书台] 调度历史收尾失败，调度照常继续。'); }
    }

    receiveHistory(turn, { content, receivedAt, late = false }) {
        if (!turn?.historyId || !turn.historyState) return;
        const state = turn.historyState;
        const delayed = Boolean(late || turn.controller?.signal.aborted
            || (state.sealed && state.requestStatus !== 'returned'));
        if (state.responseSeen && !delayed) return;
        const rawResponse = typeof content === 'string' ? content : '';
        if (!state.responseSeen) {
            state.responseSeen = true;
            state.receivedAt = Number.isFinite(receivedAt) ? receivedAt : Date.now();
            state.hasBody = Boolean(rawResponse.trim());
        }
        const fields = { rawResponse, lateResponse: Boolean(state.lateResponse || delayed) };
        if (!delayed && !state.sealed && state.hasBody) fields.requestStatus = 'returned';
        this.patchHistory(turn, fields);
    }

    failHistory(turn, error, stage = turn?.historyState?.stage || 'request') {
        if (!turn?.historyId || !turn.historyState) return;
        const state = turn.historyState;
        if (['preview', 'applied', 'unused'].includes(state.applicationStatus)) return;
        let failure;
        try { failure = historyFailure(error, turn.config || this.config); }
        catch { failure = { error: '调度未完成，无法读取失败说明。', errorCode: '' }; }
        const errorCode = failure.errorCode || (stage === 'validation' ? 'ECHO_SELECTION_INVALID'
            : stage === 'prompt' ? 'ECHO_PROMPT_INVALID' : stage === 'application' ? 'ECHO_APPLICATION_FAILED' : 'ECHO_REQUEST_FAILED');
        if (state.sealed) {
            if (state.requestStatus === 'returned') this.patchHistory(turn, {
                applicationStatus: 'unused', applicationReason: failure.error,
                replyPlanStatus: HISTORY_CANCEL_CODES.has(errorCode) ? 'cancelled' : 'omitted', replyPlanReason: failure.error,
                error: failure.error, errorCode, errorStage: 'application',
            });
            return;
        }
        const returned = state.requestStatus === 'returned' && state.hasBody;
        const requestStatus = returned ? 'returned' : HISTORY_TIMEOUT_CODES.has(errorCode) ? 'timeout'
            : HISTORY_CANCEL_CODES.has(errorCode) ? 'cancelled' : 'failed';
        this.completeHistory(turn, {
            requestStatus,
            validationStatus: returned && stage === 'validation' ? 'invalid' : 'not-run',
            applicationStatus: 'unused', applicationReason: failure.error,
            replyPlanStatus: HISTORY_CANCEL_CODES.has(errorCode) ? 'cancelled' : 'omitted', replyPlanReason: failure.error,
            error: failure.error, errorCode, errorStage: returned && stage !== 'validation' ? 'application' : stage,
            finishedAt: returned && state.receivedAt !== null ? state.receivedAt : Date.now(),
        });
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

    invalidate(reason = '上下文已改变，下次生成会重新选择。', clear = false, {
        warning = true, discardCommitted = false, reasonCode = 'ECHO_CONTEXT_CHANGED',
    } = {}) {
        const reasonError = reason instanceof Error ? reason : historyAbortError(reason, reasonCode);
        const message = reasonError.message;
        const committed = this.gate?.committed && !clear && !discardCommitted ? this.gate : null;
        const pending = this.operation?.kind === 'generation' ? this.operation : committed ? null : this.gate;
        for (const turn of new Set([this.operation, this.gate, ...this.scanGates])) {
            if (turn !== committed && turn?.historyId !== committed?.historyId) this.failHistory(turn, reasonError);
        }
        this.revision++;
        this.operation?.controller.abort(reasonError);
        this.operation = null;
        for (const gate of this.scanGates) {
            if (gate === committed) continue;
            this.native.clearSchedulerReplyPlan(gate);
            gate.cancel();
        }
        if (!committed) this.native.clearSchedulerReplyPlan();
        this.gate = committed;
        if (pending && warning) this.fallback(pending, reasonError);
        if (clear) { this.catalog = []; this.activeBooks = []; this.catalogError = ''; this.report = null; }
        if (committed && this.report) this.report.stale = true;
        this.status = committed ? `${message}本轮资料已经交给提示词构造，修改从下次生成生效。` : message;
        this.notify();
    }

    startGeneration(_type, options = {}, _dryRun = false) {
        this.invalidate('生成请求开始，等待本轮调度。', false, { discardCommitted: true, reasonCode: 'ECHO_SUPERSEDED' });
        this.generationEpoch++;
        this.generationSignal = options.signal || null;
        this.generationStopped = false;
    }

    stopGeneration() {
        const pending = this.operation?.kind === 'generation' ? this.operation : this.gate;
        this.generationStopped = true;
        this.invalidate('生成已停止，辅助请求和待注入选择已清理。', false, {
            warning: false, discardCommitted: true, reasonCode: 'ECHO_USER_CANCELLED',
        });
        if (pending) this.cancelReport(pending, '正文生成已停止，本轮调度已取消。');
        this.notify();
    }

    endGeneration() {
        if (this.gate || this.operation?.kind === 'generation') {
            const pending = this.operation?.kind === 'generation' ? this.operation : this.gate;
            this.invalidate('生成结束，待处理调度已清理。', false, {
                warning: false, discardCommitted: true, reasonCode: 'ECHO_GENERATION_ENDED',
            });
            this.cancelReport(pending, '正文生成已结束，本轮调度没有完成提示词构造。', 'ECHO_GENERATION_ENDED');
            this.notify();
        }
        this.generationSignal = null;
        this.native.clearSchedulerReplyPlan();
        for (const gate of this.scanGates) {
            // A plan-only turn never masks sources and needs no native scan recovery.
            // A staged managed source may already have been cloned by an unfinished scan.
            if (!gate.catalog.size || !gate.staged || (gate.cancelled && gate.committed && gate.scanEntries)) {
                gate.finish();
                this.scanGates.delete(gate);
            }
        }
    }

    fallback(turn, reason) {
        this.native.clearSchedulerReplyPlan(turn);
        this.failHistory(turn, reason);
        const message = typeof reason === 'string' ? reason : reason?.message || '本轮调度未完成。';
        if (turn.epoch !== this.generationEpoch || turn.chatKey !== this.chatKey() || turn.id !== this.latestWork) return;
        const info = turn.result || turn.info || {};
        this.report = {
            ...info, mode: 'fallback', blue: [], selected: [], skipped: [], actual: [],
            construction: 'native', replyPlanStatus: 'omitted', replyPlanReason: message,
            error: message, at: Date.now(), chatKey: turn.chatKey,
        };
        this.status = `本轮已跳过调度，继续原生生成：${message}`;
        if (!turn.warned) {
            turn.warned = true;
            try { this.onWarning(this.status); }
            catch (error) { console.warn('[回声书台] 顶部通知显示失败', error); }
        }
    }

    cancelReport(turn, reason, reasonCode = 'ECHO_USER_CANCELLED') {
        this.native.clearSchedulerReplyPlan(turn);
        const error = reason instanceof Error ? reason : historyAbortError(reason, reasonCode);
        this.failHistory(turn, error);
        const message = error.message;
        if (turn.id !== this.latestWork || turn.epoch !== this.generationEpoch || turn.chatKey !== this.chatKey()) return;
        this.report = {
            ...(turn.result || turn.info || {}), mode: 'cancelled', blue: [], selected: [], skipped: [], actual: [],
            construction: 'cancelled', replyPlanStatus: 'cancelled', replyPlanReason: message,
            error: message, at: Date.now(), chatKey: turn.chatKey,
        };
        this.status = message;
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
        const candidate = this.catalog.some(x => x.id === id && x.kind === 'green');
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
        this.invalidate('正在准备目录…', false, { reasonCode: 'ECHO_SUPERSEDED' });
        const context = this.getContext();
        if (!context.chatId) throw new Error('请先打开一个角色聊天。');
        const op = {
            kind, revision: this.revision, signature: this.signature(context), chatKey: this.chatKey(context),
            controller: new AbortController(), config: this.config, epoch: this.generationEpoch,
            id: ++this.workSerial,
            nonce: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            info: {
                historyCount: 0, latestUserRead: false, blueAvailable: 0, greenAvailable: 0, greenCandidates: 0,
                apiAttempted: false, apiSubmitted: false, apiDispatched: false, apiSucceeded: false, apiSkipReason: '',
                catalogLoaded: false,
            },
        };
        try { op.historyChat = historyChatInfo(context); }
        catch { /* History identity must not prevent a scheduler request. */ }
        this.latestWork = op.id;
        if (kind !== 'summary') op.timer = setTimeout(() => op.controller.abort(
            historyAbortError('调度等待超时，已跳过本轮调度。', 'ECHO_SCHEDULER_TIMEOUT'),
        ), op.config.timeoutSeconds * 1000);
        if (kind === 'generation' && this.generationSignal) {
            const signal = this.generationSignal;
            const cancel = () => {
                const error = historyAbortError(signal.reason?.message
                    || (typeof signal.reason === 'string' ? signal.reason : '正文生成已取消。'), 'ECHO_USER_CANCELLED');
                if (signal.reason !== undefined) error.cause = signal.reason;
                op.controller.abort(error);
            };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            op.detach = () => signal.removeEventListener('abort', cancel);
        }
        this.operation = op;
        this.notify();
        return op;
    }

    assertCurrent(op) {
        if (op.controller.signal.aborted) throw op.controller.signal.reason || new Error('请求已取消。');
        if (this.operation !== op || op.revision !== this.revision || op.signature !== this.signature()
            || op.epoch !== this.generationEpoch) {
            throw historyAbortError('对话或设置已改变，已丢弃旧请求的结果。', 'ECHO_CONTEXT_CHANGED');
        }
    }

    finishOperation(op) {
        if (!op) return;
        clearTimeout(op.timer);
        op.detach?.();
        if (op.historyAbort) op.controller.signal.removeEventListener('abort', op.historyAbort);
        if (this.operation === op) this.operation = null;
    }

    waitFor(promise, op) {
        const signal = op.controller.signal;
        return new Promise((resolve, reject) => {
            const cancel = () => reject(signal.reason || new Error('请求已取消。'));
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
        });
    }

    async readNative(op = null) {
        const read = { payloads: [] };
        this.nativeReads.add(read);
        const promise = Promise.resolve().then(() => this.getEntries()).finally(() => this.nativeReads.delete(read));
        const entries = await (op ? this.waitFor(promise, op) : promise);
        if (read.payloads.length !== 1) throw new Error('世界书读取未完成，或等待期间出现了另一轮读取。');
        const rawCount = ['globalLore', 'characterLore', 'chatLore', 'personaLore']
            .reduce((sum, key) => sum + (read.payloads[0][key]?.length || 0), 0);
        if (!Array.isArray(entries) || entries.length !== rawCount) throw new Error('酒馆未能完整解析世界书，已跳过本轮调度。');
        return { entries, payload: read.payloads[0] };
    }

    async loadCatalog() {
        if (this.busy) return;
        const revision = this.revision;
        const signature = this.signature();
        try {
            const { entries, payload } = await this.readNative();
            if (this.busy || revision !== this.revision || signature !== this.signature()) return;
            this.activeBooks = [...this.native.associations().keys()];
            this.catalogError = '';
            this.catalog = makeCatalog(entries, this.config.books, this.config.summaries, {
                applicable: entry => this.native.schedulerApplicable(entry),
                sources: this.sourceMap(payload),
            });
            this.notify();
        } catch (error) {
            if (revision === this.revision) {
                this.catalogError = error.message;
                this.status = `读取目录失败：${error.message}`;
                this.notify();
            }
        }
    }

    sourceMap(payload) {
        return new Map(['globalLore', 'characterLore', 'chatLore', 'personaLore']
            .flatMap(key => payload[key]).map(entry => [entryId(entry), entry]));
    }

    async select(chat, op, type = 'normal') {
        op.info.historyCount = recentContext(chat, op.config.recentMessages).length;
        op.info.historyRequested = op.config.recentMessages;
        op.info.latestUserRead = Boolean(latestUserContext(chat)?.text.trim());
        if (op.kind === 'generation') this.native.assertSchedulerReplyPlanSlot(type);
        this.status = `正在读取最近 ${op.info.historyCount} 层 AI 回复全文、最新用户输入和已保存的世界书…`;
        this.notify();
        const snapshot = await this.waitFor(this.native.schedulerSnapshot(op.config.books, { signal: op.controller.signal }), op);
        this.assertCurrent(op);
        const { entries, payload } = await this.readNative(op);
        this.assertCurrent(op);
        verifyNativeSources(payload, snapshot);
        this.activeBooks = [...this.native.associations().keys()];
        this.catalog = makeCatalog(entries, snapshot.books, op.config.summaries, {
            applicable: entry => this.native.schedulerApplicable(entry, type), sources: snapshot.sources,
        });
        const catalog = this.catalog;
        this.catalogError = '';
        const blue = catalog.filter(item => item.kind === 'blue');
        const green = catalog.filter(item => item.kind === 'green');
        const state = this.state();
        const overrides = { ...state.overrides };
        const previous = previousSnapshot(state.snapshots, historyChain(chat));
        let choice = { scene: previous?.scene || '', selected: [] };
        const modelCatalog = green.filter(item => overrides[item.id] !== 'exclude' && overrides[item.id] !== 'pin');
        Object.assign(op.info, { catalogLoaded: true, blueAvailable: blue.length, greenAvailable: green.length, greenCandidates: modelCatalog.length, mountedBooks: snapshot.books });
        const context = this.getContext();
        const tokenCache = new Map();
        const countTokens = text => {
            const content = String(text);
            if (!tokenCache.has(content)) tokenCache.set(content, this.waitFor(context.getTokenCountAsync(content), op));
            return tokenCache.get(content);
        };
        const pins = await allocateSelection(choice, catalog, overrides, op.config, countTokens);
        this.assertCurrent(op);
        if (op.kind === 'generation') {
            this.native.assertSchedulerSlots([...blue, ...pins.selected], type);
        }
        // Planning remains necessary with no candidate green entries or no remaining budget.
        const historyCatalog = catalog.map(item => ({
            id: item.id, book: String(item.entry.world), title: item.title,
        }));
        {
            this.beginHistory(op, context, type, {
                blueAvailable: blue.length, fixedGreen: pins.selected.length, greenCandidates: modelCatalog.length,
            }, historyEntryGroups(historyCatalog, blue, pins.selected));
            const input = selectorPayload(catalog, chat, previous, overrides, op.config, pins.selected, {
                generationType: type, characterContext: this.native.schedulerCharacterContext(),
            });
            const guidanceCount = await countTokens(buildReplyPlanPrompt({
                direction: '', beats: [], constraints: [], ending: '',
            }, op.nonce));
            if (!Number.isFinite(guidanceCount) || guidanceCount < 0) throw new Error('无法估算导演固定执行指导的 Token 开销。');
            input.replyPlanContentTokenBudget = Math.max(0, op.config.replyPlanTokenBudget - Math.ceil(guidanceCount) - 20);
            input.remainingGreenTokenBudget = Math.max(0, op.config.tokenBudget - pins.tokens);
            const messages = buildPromptMessages('selector', op.config.promptTemplates, { input, context, config: op.config });
            if (op.historyState) op.historyState.stage = 'request';
            op.info.apiAttempted = true;
            this.status = `正在提交导演提示词：构思本轮唯一主方向，并统筹 ${blue.length} 条蓝灯、${pins.selected.length} 条固定绿灯和 ${modelCatalog.length} 条候选绿灯。`;
            this.notify();
            let response;
            try {
                const responseTokens = Math.min(10000, Math.max(3000,
                    op.config.replyPlanTokenBudget + op.config.maxEntries * 160 + 600));
                const pending = this.requestModel(context, op.config, messages, op.controller.signal, responseTokens, {
                    onDispatch: info => {
                        this.assertCurrent(op);
                        op.info.apiSubmitted = true;
                        op.info.apiDispatched = !info.submittedOnly;
                        op.info.apiModel = info.model || '';
                        this.patchHistory(op, { submittedAt: Date.now(), ...(info.model ? { model: info.model } : {}) });
                    },
                    onResponse: observation => this.receiveHistory(op, observation),
                });
                const observed = Promise.resolve(pending).then(content => {
                    this.receiveHistory(op, {
                        content, receivedAt: Date.now(), late: op.controller.signal.aborted,
                    });
                    return content;
                });
                response = await this.waitFor(observed, op);
            } catch (error) {
                this.failHistory(op, error, 'request');
                throw error;
            }
            this.assertCurrent(op);
            op.info.apiDispatched = true;
            op.info.apiSucceeded = true;
            if (op.historyState) op.historyState.stage = 'validation';
            try {
                choice = validateSelection(response, modelCatalog, {
                    requireReplyPlan: true, fixedEntries: [...blue, ...pins.selected],
                });
            } catch (error) {
                this.failHistory(op, error, 'validation');
                throw error;
            }
            op.info.replyPlan = choice.replyPlan;
            this.patchHistory(op, { replyPlan: choice.replyPlan, replyPlanStatus: 'waiting', replyPlanReason: '' });
            this.completeHistory(op, {
                requestStatus: 'returned', validationStatus: 'valid',
                applicationStatus: op.kind === 'generation' ? 'waiting' : 'pending',
                finishedAt: op.historyState?.receivedAt ?? Date.now(),
            });
            if (op.historyState) op.historyState.stage = 'application';
        }
        const selected = await allocateSelection(choice, catalog, overrides, op.config, countTokens);
        this.assertCurrent(op);
        this.patchHistory(op, {
            counts: { selected: selected.selected.length },
            ...(historyCatalog ? { plannedEntries: historyEntryGroups(historyCatalog, blue, selected.selected) } : {}),
        });
        const constants = [];
        for (const item of blue) {
            const rawCount = await countTokens(item.entry.content);
            if (!Number.isFinite(rawCount) || rawCount < 0) throw new Error('无法估算蓝灯条目的 Token 数量。');
            constants.push({ id: item.id, kind: 'blue', scope: 'constant', position: item.position, reason: '蓝灯常驻，默认加入本轮', tokens: Math.ceil(rawCount) + 4 });
        }
        this.assertCurrent(op);
        if (JSON.stringify(this.native.schedulerBooks(op.config.books)) !== JSON.stringify(snapshot.books)) {
            throw new Error('当前聊天的世界书挂载已改变。');
        }
        if (op.kind === 'generation') {
            this.status = '正在确认本轮原书版本与前后注入位置…';
            this.notify();
            const latest = await this.waitFor(this.native.schedulerSnapshot(op.config.books, { signal: op.controller.signal }), op);
            this.assertCurrent(op);
            if (latest.versions.size !== snapshot.versions.size
                || [...snapshot.versions].some(([id, version]) => latest.versions.get(id) !== version)) {
                throw new Error('等待筛选期间原世界书已经改变，已跳过本轮调度。');
            }
        }
        const included = [...constants, ...selected.selected];
        const replyPlanPrompt = buildReplyPlanPrompt(choice.replyPlan, op.nonce);
        const planCount = await countTokens(replyPlanPrompt);
        if (!Number.isFinite(planCount) || planCount < 0) throw new Error('无法估算导演方案的 Token 数量。');
        const replyPlanTokens = Math.ceil(planCount) + 4;
        const missing = missingReplyPlanEntries(choice.replyPlan, included.map(item => item.id));
        const missingNames = missing.map(id => catalog.find(item => item.id === id)?.title || id);
        const reasons = [];
        if (missing.length) reasons.push(`导演方案必需的资料未通过绿灯预算或数量限制：${missingNames.join('、')}。`);
        if (replyPlanTokens > op.config.replyPlanTokenBudget) reasons.push(`导演方案约 ${replyPlanTokens} tokens，超过独立上限 ${op.config.replyPlanTokenBudget}（不截断方案）。`);
        const result = {
            ...selected, ...op.info, blue: constants,
            replyPlan: choice.replyPlan, replyPlanTokens,
            replyPlanStatus: reasons.length ? 'omitted' : op.kind === 'preview' ? 'preview' : 'waiting',
            replyPlanReason: reasons.join(''),
            blueTokens: constants.reduce((sum, item) => sum + item.tokens, 0),
            beforeCount: included.filter(item => item.position === 'before').length,
            afterCount: included.filter(item => item.position === 'after').length,
        };
        this.patchHistory(op, {
            replyPlan: result.replyPlan, replyPlanTokens, replyPlanStatus: result.replyPlanStatus, replyPlanReason: result.replyPlanReason,
        });
        const byId = new Map(catalog.map(item => [item.id, item]));
        for (const item of included) item.mappedPosition = ![0, 1].includes(byId.get(item.id).entry.position);
        if (op.kind === 'generation') this.native.assertSchedulerSlots(included, type);
        const prepared = op.kind === 'generation' ? included.map(item => {
            const source = structuredClone(byId.get(item.id).entry);
            return {
                ...source, content: String(context.substituteParams(String(source.content))),
                disable: false, constant: true, ignoreBudget: true, useProbability: false,
                position: item.position === 'before' ? this.native.positions.before : this.native.positions.after,
                group: '', groupOverride: false, sticky: null, cooldown: null, delay: null,
                preventRecursion: true, excludeRecursion: false, delayUntilRecursion: false,
            };
        }) : [];
        this.assertCurrent(op);
        op.info = result;
        return { result, snapshot, catalog, prepared, replyPlanPrompt };
    }

    replyPlanState(turn, status, reason = '') {
        const result = turn.result || turn.info;
        if (result) { result.replyPlanStatus = status; result.replyPlanReason = reason; }
        if (turn.id === this.latestWork && turn.epoch === this.generationEpoch && turn.chatKey === this.chatKey() && this.report) {
            this.report.replyPlanStatus = status;
            this.report.replyPlanReason = reason;
        }
        this.patchHistory(turn, { replyPlanStatus: status, replyPlanReason: reason });
    }

    warnReplyPlan(turn, reason) {
        if (turn.planWarned || turn.id !== this.latestWork || turn.epoch !== this.generationEpoch || turn.chatKey !== this.chatKey()) return;
        turn.planWarned = true;
        try { this.onWarning(`本轮导演方案未注入：${reason}本轮不再使用该方案；仍沿用本轮资料构造结果继续生成，由正文自行构思。`); }
        catch (error) { console.warn('[回声书台] 导演方案通知显示失败', error); }
    }

    omitReplyPlan(turn, reason, payload = null) {
        this.native.clearSchedulerReplyPlan(turn);
        if (payload) this.native.removeSchedulerReplyPlan(payload, turn);
        this.replyPlanState(turn, 'omitted', reason);
        this.warnReplyPlan(turn, reason);
    }

    replyPlanDependencyNames(turn) {
        const available = turn.activeMap instanceof Map ? [...turn.activeMap.values()]
            .filter(entry => String(entry.content || '').trim()) : [];
        const missing = missingReplyPlanEntries(turn.result.replyPlan, turn.acceptedIds(available));
        return missing.map(id => turn.catalog.get(id)?.comment || this.catalog.find(item => item.id === id)?.title || id);
    }

    applyReplyPlan(turn) {
        if (turn.result.replyPlanStatus !== 'waiting') return;
        const missing = this.replyPlanDependencyNames(turn);
        if (missing.length) {
            this.omitReplyPlan(turn, `世界书构造未接纳导演方案必需的资料：${missing.join('、')}。`);
            return;
        }
        try {
            this.native.injectSchedulerReplyPlan(turn);
            this.replyPlanState(turn, 'injected');
        } catch (error) {
            this.omitReplyPlan(turn, error.message || '深度 0 导演方案注入失败。');
        }
    }

    confirmReplyPlan(turn, payload) {
        if (turn.result.replyPlanStatus !== 'injected') return;
        const missing = this.replyPlanDependencyNames(turn);
        const missingText = this.native.schedulerReplyPlanMissingReferences(payload, turn)
            .map(id => turn.catalog.get(id)?.comment || this.catalog.find(item => item.id === id)?.title || id);
        if (missing.length || missingText.length) {
            this.omitReplyPlan(turn, `导演方案必需资料未完整保留在正文提示词中（可能被预算、正则或格式化改动）：${[...new Set([...missing, ...missingText])].join('、')}。`, payload);
        } else if (!this.native.schedulerReplyPlanPresent(payload, turn)) {
            this.omitReplyPlan(turn, '正文提示词没有完整保留本轮导演方案，可能被总上下文预算、正则或其他提示词操作移除。', payload);
        }
    }

    async intercept(chat, contextSize, _abort, type) {
        const config = this.config;
        const context = this.getContext();
        const identities = new Set([MODULE, EXTENSION_NAME, EXTENSION_FOLDER,
            `third-party/${MODULE}`, `third-party/${EXTENSION_NAME}`, `third-party/${EXTENSION_FOLDER}`]);
        const extensionDisabled = context.extensionSettings.disabledExtensions?.some(name => identities.has(name));
        if (!config.enabled || extensionDisabled || !SUPPORTED_TYPES.has(type || 'normal')) return;
        let op;
        try {
            op = this.begin('generation');
            op.type = type || 'normal';
            if (!context.eventTypes.WORLDINFO_SCAN_DONE) throw new Error('当前酒馆没有生成前世界书扫描接口。');
            const input = structuredClone(chat);
            const { result, snapshot, catalog, prepared, replyPlanPrompt } = await this.select(input, op, op.type);
            this.assertCurrent(op);
            this.report = { ...result, mode: 'generation', actual: [], construction: 'waiting', at: Date.now(), chatKey: op.chatKey };
            this.gate = new SchedulerScanGate({
                snapshot, catalog, prepared, result, input, contextSize, type: op.type, replyPlanPrompt,
                revision: this.revision, signature: op.signature, epoch: op.epoch, chatKey: op.chatKey, id: op.id, nonce: op.nonce,
                config: op.config, historyId: op.historyId, historyState: op.historyState,
            });
            this.scanGates.add(this.gate);
            if (result.replyPlanStatus === 'omitted') this.warnReplyPlan(this.gate, result.replyPlanReason);
            this.status = `导演方案已构思；蓝灯 ${result.blue.length} 条、绿灯 ${result.selected.length} 条，等待本轮世界书读取与深度 0 注入。${result.replyPlanReason}`;
        } catch (error) {
            this.failHistory(op, error);
            if (this.gate && this.gate.id === op?.id) {
                this.native.clearSchedulerReplyPlan(this.gate);
                this.gate.cancel();
                this.gate = null;
            }
            if (op && (this.generationStopped || this.generationSignal?.aborted)) {
                this.cancelReport(op, '正文生成已取消，本轮调度已清理。');
            } else if (op) this.fallback(op, error);
        } finally {
            this.finishOperation(op);
            this.notify();
        }
    }

    gateIsCurrent() {
        const gate = this.gate;
        return gate && !gate.cancelled && gate.epoch === this.generationEpoch && gate.chatKey === this.chatKey()
            && !this.generationStopped && !this.generationSignal?.aborted
            && (gate.committed || (gate.revision === this.revision && gate.signature === this.signature() && this.config.enabled));
    }

    onEntriesLoaded(payload) {
        if (this.native.recovering) return;
        if (this.nativeReads.size) {
            for (const read of this.nativeReads) read.payloads.push(structuredClone(payload));
            if (this.gate && !this.gate.committed) this.invalidate('世界书等待期间出现了另一轮目录读取，已跳过本轮调度。');
            return;
        }
        if (!this.gate) return;
        if (this.gate.committed) return;
        if (!this.gateIsCurrent()) {
            const gate = this.gate;
            const cancelled = this.generationStopped || this.generationSignal?.aborted;
            this.invalidate('当前聊天或调度设置已改变，已跳过本轮调度。', false, {
                warning: !cancelled, reasonCode: cancelled ? 'ECHO_USER_CANCELLED' : 'ECHO_CONTEXT_CHANGED',
            });
            if (cancelled) {
                this.cancelReport(gate, '正文生成已取消，本轮调度已清理。');
                this.notify();
            }
            return;
        }
        try {
            verifyNativeSources(payload, this.gate.snapshot);
            this.gate.stage(payload);
            if (!this.gate.catalog.size) {
                // With zero native entries the host returns before WORLDINFO_SCAN_DONE.
                // No source is masked, so the confirmed source read suffices for a plan-only turn.
                this.gate.injected = true;
                this.gate.activeMap = new Map();
                this.gate.committed = true;
                this.report.construction = 'scan-accepted';
                this.applyReplyPlan(this.gate);
                this.status = '本轮没有托管条目需要接管；导演方案按聊天与角色约束准备，原生世界书处理保持不变。';
            } else {
                this.status = '本轮蓝灯与入选绿灯已准备好，正在构造世界书之前／之后及深度 0 导演方案。';
            }
        } catch (error) {
            const gate = this.gate;
            gate.cancel();
            this.gate = null;
            this.fallback(gate, error.message);
        }
        this.notify();
    }

    async onScanDone(args) {
        if (this.native.recovering || !Array.isArray(args?.sortedEntries)) return;
        for (const gate of this.scanGates) {
            if (gate.completed || !gate.matches(args.sortedEntries)) continue;
            gate.scanEntries ||= args.sortedEntries;
            gate.activeMap ||= args.activated?.entries;
            if (!gate.cancelled && (this.gate !== gate || !this.gateIsCurrent())) {
                gate.cancel();
                if (this.gate === gate) this.gate = null;
                if (this.generationStopped || this.generationSignal?.aborted) this.cancelReport(gate, '正文生成已取消，本轮调度已清理。');
                else this.fallback(gate, historyAbortError('聊天或设置已变化，本轮选择已丢弃。', 'ECHO_CONTEXT_CHANGED'));
            }
            try {
                if (!gate.cancelled) {
                    gate.inject(args);
                    this.applyReplyPlan(gate);
                    if (this.report?.mode === 'generation') {
                        this.report.construction = 'scan-accepted';
                        this.report.actual = gate.acceptedIds([...args.activated.entries.values()]);
                    }
                    // No owned content means WORLD_INFO_ACTIVATED may never fire.
                    // Keep the empty allowlist fixed while native books finish scanning.
                    if (!gate.prepared.length) gate.committed = true;
                }
            } catch (error) {
                gate.cancel();
                if (this.gate === gate) this.gate = null;
                this.fallback(gate, error.message);
            }
            if (gate.cancelled && !gate.catalog.size) {
                this.native.clearSchedulerReplyPlan(gate);
                gate.finish();
                this.scanGates.delete(gate);
                this.notify();
                continue;
            }
            if (gate.cancelled && !gate.recovered) {
                this.native.clearSchedulerReplyPlan(gate);
                gate.restoreScan(args.sortedEntries);
                gate.removeInserted(args.activated?.entries);
                try {
                    const guard = () => {
                        if (gate.epoch !== this.generationEpoch || gate.signature !== this.signature()
                            || this.generationStopped || this.generationSignal?.aborted) {
                            throw new Error('原来的生成上下文已经结束。');
                        }
                    };
                    guard();
                    const entries = await this.native.recoverSchedulerScan(gate.input, gate.contextSize, gate.type, args.sortedEntries, guard);
                    args.activated.entries.clear();
                    for (const entry of entries) args.activated.entries.set(`${entry.world}.${entry.uid}`, entry);
                    args.activated.text = '';
                    args.state.next = 0;
                    gate.recovered = true;
                } catch (error) {
                    // A cancelled/changed chat must never acquire the new chat's lore.
                    if (gate.epoch === this.generationEpoch && gate.signature === this.signature()
                        && !this.generationStopped && !this.generationSignal?.aborted) {
                        this.fallback(gate, `恢复原生世界书时遇到问题：${error.message}`);
                    }
                } finally {
                    gate.finish();
                    this.scanGates.delete(gate);
                }
            }
            this.notify();
        }
    }

    onActivated(entries) {
        if (!this.gateIsCurrent() || this.report?.mode !== 'generation') return;
        if (!this.gate.injected || !this.gate.activeMap) return;
        const scanned = new Set(this.gate.activeMap.values());
        if (entries.some(entry => !scanned.has(entry))) return;
        const accepted = this.gate.acceptedIds(entries);
        if (!accepted.length && this.gate.prepared.length) return;
        this.report.actual = accepted;
        this.report.construction = 'scan-accepted';
        this.patchHistory(this.gate, { counts: { included: accepted.length } });
        this.gate.committed = true;
        this.gate.restoreScan();
        const missing = this.replyPlanDependencyNames(this.gate);
        if (this.gate.result.replyPlanStatus === 'injected' && missing.length) {
            this.omitReplyPlan(this.gate, `世界书构造没有保留导演方案必需的资料：${missing.join('、')}。`);
        }
        this.status = '本轮资料与导演安排已交给酒馆构造提示词，辅助导演请求已结束。';
        this.notify();
    }

    onChatCompletionReady(data) {
        if (data?.dryRun || !this.gateIsCurrent()) return;
        this.confirmReplyPlan(this.gate, data);
        this.report.promptPrepared = true;
        this.notify();
    }

    onPromptReady(data, dryRun = false) {
        if (dryRun) return;
        if (!this.gateIsCurrent()) return;
        const gate = this.gate;
        const { input, result } = gate;
        if (!gate.injected) {
            this.native.clearSchedulerReplyPlan(gate);
            this.native.removeSchedulerReplyPlan(data, gate);
            gate.cancel();
            this.gate = null;
            this.fallback(gate, '酒馆没有接纳本轮世界书扫描，本轮选择未注入。');
            this.notify();
            return;
        }
        this.confirmReplyPlan(gate, data);
        const actual = new Set(gate.activeMap instanceof Map
            ? gate.acceptedIds([...gate.activeMap.values()]) : []);
        this.report.actual = [...actual];
        const context = this.getContext();
        let memoryFailure;
        try {
            if (gate.revision === this.revision && gate.signature === this.signature()) {
                this.state(context).snapshots = recordSnapshot(this.state(context).snapshots, input, {
                    ...result, selected: result.selected.filter(x => actual.has(x.id)),
                });
                context.saveMetadataDebounced();
            }
        } catch (error) {
            this.report.memoryError = `场景参考未保存：${error.message}`;
            console.warn('[回声书台] 场景参考保存失败，正文照常继续', error);
            try { memoryFailure = historyFailure(this.report.memoryError, this.config); }
            catch { memoryFailure = { error: '场景参考未保存，无法读取失败说明。' }; }
        }
        this.report.promptPrepared = true;
        this.report.construction = 'prepared';
        const applied = Boolean(gate.catalog.size || result.replyPlanStatus === 'injected');
        this.patchHistory(gate, {
            applicationStatus: applied ? 'applied' : 'unused', counts: { included: actual.size },
            replyPlanStatus: result.replyPlanStatus, replyPlanReason: result.replyPlanReason,
            ...(applied ? { effectiveEntries: historyEffectiveEntries(gate.historyState?.plannedEntries, actual) }
                : { applicationReason: result.replyPlanReason || '本轮没有托管资料，导演方案也未采用。' }),
            ...(memoryFailure ? { ...memoryFailure, errorStage: 'memory', errorCode: 'ECHO_MEMORY_SAVE_FAILED' } : {}),
        });
        this.status = `调度完成：${result.replyPlanStatus === 'injected' ? '导演方案已在深度 0 构造接纳' : '导演方案未注入'}；蓝灯 ${result.blue.length} 条、绿灯 ${result.selected.length} 条，世界书构造接纳 ${actual.size} 条；原来的正文请求继续。${result.replyPlanReason}${this.report.memoryError || ''}`;
        this.native.clearSchedulerReplyPlan(gate);
        gate.finish();
        this.scanGates.delete(gate);
        this.gate = null;
        this.notify();
    }

    async preview() {
        let op;
        try {
            op = this.begin('preview');
            const chat = structuredClone(this.getContext().chat || []);
            const { result } = await this.select(chat, op);
            this.assertCurrent(op);
            this.report = { ...result, mode: 'preview', actual: null, construction: 'preview', at: Date.now(), chatKey: op.chatKey };
            this.patchHistory(op, { applicationStatus: 'preview' });
            this.status = `试运行完成：已构思本轮唯一主方向，蓝灯 ${result.blue.length} 条、绿灯 ${result.selected.length} 条。导演 API 已调用；没有注入正文或更新场景记忆。${result.replyPlanReason}`;
        } catch (error) {
            this.failHistory(op, error);
            if (!op || this.operation === op) {
                this.report = { ...op?.info, mode: 'preview-error', blue: [], selected: [], skipped: [], actual: null, error: error.message, chatKey: op?.chatKey || this.chatKey() };
                this.status = `试选失败：${error.message}`;
            }
        } finally {
            this.finishOperation(op);
            this.notify();
        }
    }

    async summarize() {
        let op;
        try {
            op = this.begin('summary');
            const { entries, payload } = await this.readNative(op);
            this.assertCurrent(op);
            const sources = this.sourceMap(payload);
            const catalog = makeCatalog(entries, op.config.books, op.config.summaries, {
                applicable: entry => this.native.schedulerApplicable(entry), sources,
            });
            const missing = catalog.filter(x => x.summaryKind !== 'AI 概括');
            const eligible = missing.filter(x => x.content.length <= 10000);
            const batches = [];
            let batch = [];
            let size = 0;
            for (const item of eligible) {
                if (batch.length && (size + item.content.length > 12000 || batch.length >= 6)) {
                    batches.push(batch); batch = []; size = 0;
                }
                batch.push(item); size += item.content.length;
            }
            if (batch.length) batches.push(batch);
            let completed = 0;
            for (const [index, items] of batches.entries()) {
                this.status = `生成 AI 目录：第 ${index + 1}/${batches.length} 批（仅处理新增/改动条目）。`;
                this.notify();
                const requestContext = this.getContext();
                const input = items.map(x => ({ id: x.id, title: x.title, content: x.content }));
                const messages = buildPromptMessages('summary', op.config.promptTemplates, {
                    input, context: requestContext, config: op.config, batchIndex: index + 1, batchCount: batches.length,
                });
                const text = await this.requestModel(requestContext, op.config, messages, op.controller.signal, 2200);
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
            this.catalog = makeCatalog(entries, op.config.books, this.config.summaries, {
                applicable: entry => this.native.schedulerApplicable(entry), sources,
            });
            this.activeBooks = [...this.native.associations().keys()];
            this.status = `目录更新完成：新增 ${completed} 条 AI 概括。${missing.length - eligible.length} 条超过 10000 字符，保留原文摘录（建议拆分）。`;
        } catch (error) {
            if (!op || this.operation === op) this.status = `AI 目录未完成：${error.message} 已完成的批次保留。`;
        } finally {
            this.finishOperation(op);
            this.notify();
        }
    }
}
