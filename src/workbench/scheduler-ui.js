import { element, button, icon, badge } from './workbench-utils.js';
import { sameValue } from './workbench-state.js';
import { scrollRegion } from './workbench-scroll.js';
import { catalogScope, resultSummary, choiceState } from '../scheduler/scheduler-report.js';

const NUMBER_SETTINGS = [
    ['maxEntries', '绿灯最多条目', 1, 30, '条'],
    ['tokenBudget', '绿灯 Token 预算', 128, 16000, 'Token'],
    ['recentMessages', '读取最近 AI 楼层', 1, 30, '层', '；另读最新已发送用户消息，不占 AI 层数。'],
];

/** Scheduler presentation delegates local reads and selection requests to the runtime. */
export class SchedulerUI {
    constructor(workbench) {
        this.workbench = workbench;
        this.director = workbench.director;
        this.reportKey = null;
        this.ruleHosts = [];
        this.baseline = this.savedSettings();
        this.selectedBooks = new Set(this.baseline.books);
        this.numbers = new Map();
        this.bookRows = new Map();
        this.scrollTop = 0;
        this.booksScrollTop = 0;
        this.build();
    }

    savedSettings() {
        const config = this.director.config;
        return {
            enabled: config.enabled, maxEntries: config.maxEntries, tokenBudget: config.tokenBudget,
            recentMessages: config.recentMessages, books: [...config.books].sort(),
        };
    }

    get dirty() {
        return this.enabled.checked !== this.baseline.enabled
            || NUMBER_SETTINGS.some(([key]) => !this.numbers.get(key).value.trim() || Number(this.numbers.get(key).value) !== this.baseline[key])
            || !sameValue([...this.selectedBooks].sort(), this.baseline.books);
    }

    build() {
        this.enabled = element('input', {
            id: 'wb-scheduler-enabled', type: 'checkbox', role: 'switch', 'aria-label': '启用生成前调度', checked: this.baseline.enabled,
        });
        this.enabled.addEventListener('change', () => this.update());
        this.enabledNote = element('p', { class: 'wb-help' });
        this.preview = button('试运行', { glyph: 'play', onclick: () => this.workbench.run(() => this.director.preview()) });
        this.refresh = button('刷新本地目录', { glyph: 'refresh', onclick: () => this.workbench.run(() => this.director.loadCatalog()) });
        this.cancel = button('取消辅助请求', { onclick: () => this.director.invalidate('辅助请求已取消；若正文仍继续，本轮使用原生世界书规则。', false, { reasonCode: 'ECHO_USER_CANCELLED' }) });
        this.save = button('保存调度设置', { glyph: 'save', kind: 'primary', onclick: () => this.workbench.run(() => this.apply()) });
        this.discardButton = button('放弃修改', { onclick: () => this.discard() });
        this.dirtyState = element('span', { class: 'wb-dirty-status', role: 'status' });
        this.actions = element('div', { class: 'wb-action-row wb-scheduler-footer' }, this.dirtyState,
            element('div', { class: 'wb-action-buttons' }, this.preview, this.cancel, this.discardButton, this.save));
        const fields = NUMBER_SETTINGS.map(([key, label, min, max, unit, note = '']) => {
            const input = element('input', {
                id: `wb-config-${key}`, type: 'number', inputMode: 'numeric', min, max, step: 1, value: this.baseline[key],
            });
            input.addEventListener('input', () => this.update());
            this.numbers.set(key, input);
            const rangeHint = element('small', {
                id: `${input.id}-range`, class: 'wb-help',
                text: `范围：${min.toLocaleString('en-US')}～${max.toLocaleString('en-US')}${unit === 'Token' ? ' ' : ''}${unit}（整数）${note}`,
            });
            input.setAttribute('aria-describedby', rangeHint.id);
            return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), rangeHint, input);
        });
        this.bookList = element('div', { class: 'wb-managed-list' });
        this.bookSearch = element('input', {
            id: 'wb-managed-search', type: 'search', placeholder: '搜索托管世界书', 'aria-label': '搜索托管世界书', autocomplete: 'off',
        });
        this.bookSearch.addEventListener('input', () => this.filterBooks());
        this.bookCount = element('small', { class: 'wb-help' });
        const managed = element('section', { class: 'wb-settings-section' },
            element('div', { class: 'wb-section-heading' }, element('h3', { text: '托管世界书' }), this.bookCount),
            element('p', { class: 'wb-help', text: '勾选需要调度的书。只有当前已挂载、且有可用目录的书会被接管；无可用目录的书继续按酒馆原生规则工作。' }),
            element('div', { class: 'wb-browse-search' }, element('div', { class: 'wb-search' }, icon('search'), this.bookSearch), this.refresh),
            scrollRegion(this.bookList, 'wb-managed-scroll'));
        this.status = element('div', { class: 'wb-status', role: 'status', 'aria-live': 'polite' });
        this.scopeNote = element('p', { class: 'wb-help' });
        this.resultHeading = element('h3', { text: '调度结果' });
        this.resultNote = element('p', { class: 'wb-help' });
        this.results = element('div');
        const content = element('div', { class: 'wb-scheduler wb-reading-page' },
            element('p', { class: 'wb-help', text: '辅助连接与请求超时可从侧边栏进入“调度器 API 设置”修改。' }),
            element('section', { class: 'wb-settings-section' },
                element('div', { class: 'wb-scheduler-heading' }, element('div', {}, element('h3', { text: '生成前调度' }), this.enabledNote),
                    element('label', { class: 'wb-switch', htmlFor: this.enabled.id }, this.enabled, element('span', { class: 'wb-switch-track', 'aria-hidden': 'true' }))),
                element('div', { class: 'wb-settings-grid' }, fields),
                element('p', { class: 'wb-help', text: '辅助模型只读取最近 AI 消息、最新已发送用户发言和候选绿灯目录，不读取条目原文。选中的绿灯按 ID 取原文用于正文；托管蓝灯默认纳入，不占绿灯数量或 Token 预算。' })),
            managed, this.scopeNote, this.status,
            element('section', {}, element('div', { class: 'wb-result-heading' }, this.resultHeading, this.resultNote), this.results),
            element('details', { class: 'wb-details' }, element('summary', {}, '注入位置与失败处理', icon('down')),
                element('div', { class: 'wb-details-body' },
                    element('p', { class: 'wb-help', text: '禁用、角色／生成类型限制和禁止激活标记仍有效；纯向量条目继续走原生。固定／排除仅控制本聊天的绿灯。先在数量与预算内纳入固定绿灯，再按模型返回顺序分配其他入选绿灯。' }),
                    element('p', { class: 'wb-help', text: '前置条目放入预设的“世界书之前”，其余放入“世界书之后”。深度、作者注释或出口等位置只在本轮映射到后置，不改原书。' }),
                    element('p', { class: 'wb-help', text: '成功调度的条目直接交给世界书构造，不再通过关键词、概率、互斥组或原生世界书预算重筛。酒馆正则、预设开关和正文总上下文仍影响最终提示词。构造接纳以条目 ID 为准，不代表上游正文 API 已接收每个字符。' }),
                    element('p', { class: 'wb-help', text: '试运行只读已发送聊天，不读取输入框草稿，不注入正文。没有候选绿灯、没有剩余绿灯名额或预算为零时，不调用筛选 API。普通回复、重生成、滑动和续写可调度；安静生成、代写用户和原生提示预览保持原生行为。' }),
                    element('p', { class: 'wb-help', text: '调度失败时丢弃本轮结果，顶部提示原因，正文按原生规则继续；本聊天排除也不限制失败后的原生触发。' }))));
        this.view = element('section', { class: 'wb-feature-view' }, scrollRegion(content, 'wb-fill-scroll'));
        this.viewport = content;
        this.refreshBooks();
        this.update();
    }

    refreshBooks() {
        const names = [...new Set([...this.workbench.books.map(book => book.name), ...this.director.config.books, ...this.selectedBooks])];
        for (const [name, row] of this.bookRows) {
            if (!names.includes(name)) { row.node.remove(); this.bookRows.delete(name); }
        }
        for (const name of names) {
            let row = this.bookRows.get(name);
            if (!row) {
                const input = element('input', { type: 'checkbox', role: 'switch', 'aria-label': `托管 ${name}`, checked: this.selectedBooks.has(name) });
                input.addEventListener('change', () => {
                    if (input.checked) this.selectedBooks.add(name); else this.selectedBooks.delete(name);
                    this.filterBooks(); this.update();
                });
                const source = element('small', { class: 'wb-option-meta' });
                const node = element('label', { class: 'wb-managed-option' },
                    element('span', { class: 'wb-option-main' }, element('strong', { text: name }), source), input);
                row = { node, input, source };
                this.bookRows.set(name, row);
                this.bookList.append(node);
            }
            row.input.checked = this.selectedBooks.has(name);
            row.input.disabled = this.director.busy || this.workbench.store.busy;
            row.sourceLabel = this.workbench.bookInfo(name)?.source || '书目已失效，可取消托管';
        }
        this.updateBookDirectories();
        this.filterBooks();
    }

    updateBookDirectories() {
        const unindexed = new Set(this.director.unindexedBooks || []);
        for (const [name, row] of this.bookRows) {
            const label = unindexed.has(name) ? `${row.sourceLabel}；无可用目录` : row.sourceLabel;
            if (row.source.textContent !== label) row.source.textContent = label;
        }
    }

    filterBooks() {
        const query = this.bookSearch.value.trim().toLocaleLowerCase();
        for (const [name, row] of this.bookRows) row.node.hidden = !name.toLocaleLowerCase().includes(query);
        this.bookCount.textContent = `已选择 ${this.selectedBooks.size} 本`;
        this.workbench.scrollbars?.refresh();
    }

    renderResults(report) {
        this.ruleHosts = [];
        this.results.replaceChildren();
        if (!report) {
            this.resultHeading.textContent = '尚无调度结果';
            this.resultNote.textContent = '打开聊天后可试运行，不会发送正文；有候选绿灯和剩余额度时，会使用所选辅助连接。';
            return;
        }
        if (['fallback', 'preview-error', 'cancelled'].includes(report.mode)) {
            this.resultHeading.textContent = report.mode === 'fallback' ? '本轮已跳过调度' : report.mode === 'cancelled' ? '本轮生成已取消' : '最近试运行失败';
            this.resultNote.textContent = resultSummary(report);
            return;
        }
        const selected = report.selected || [];
        const skipped = report.skipped || [];
        this.resultHeading.textContent = report.mode === 'preview' ? '最近试运行结果' : '最近生成结果';
        const actual = new Set(report.actual || []);
        this.resultNote.textContent = resultSummary(report);
        const blue = report.blue || [];
        for (const choice of [...blue, ...selected]) {
            const item = this.director.catalog.find(entry => entry.id === choice.id);
            const identity = this.workbench.parseIdentity(choice.id);
            if (!identity) continue;
            const title = item?.title || `${identity.book} · 条目 ${identity.uid}`;
            const state = choiceState(report, choice.id);
            const rules = element('div');
            const chat = report.chatKey || this.director.chatKey();
            this.workbench.attachOverride(rules, identity.book, identity.uid, chat);
            this.ruleHosts.push({ host: rules, ...identity, chat });
            this.results.append(element('article', { class: 'wb-result' },
                button(title, { class: 'wb-result-open', glyph: 'file', onclick: () => this.workbench.run(() => this.workbench.openEntry(identity.book, identity.uid, 'scheduler')) }),
                element('div', { class: 'wb-result-meta' }, badge(state, actual.has(choice.id) ? 'check' : null),
                    badge(choice.kind === 'blue' ? '蓝灯常驻' : '绿灯 · 本轮纳入'),
                    badge(choice.position === 'before' ? '世界书之前' : '世界书之后'),
                    choice.mappedPosition ? badge('本轮映射到后置') : null, badge(`约 ${choice.tokens ?? 0} tokens`)),
                element('p', { class: 'wb-result-reason', text: String(choice.reason || '') }), rules));
        }
        for (const choice of skipped) {
            const identity = this.workbench.parseIdentity(choice.id);
            if (!identity) continue;
            const item = this.director.catalog.find(entry => entry.id === choice.id);
            this.results.append(element('article', { class: 'wb-result' },
                button(item?.title || `${identity.book} · 条目 ${identity.uid}`, { class: 'wb-result-open', glyph: 'file', onclick: () => this.workbench.run(() => this.workbench.openEntry(identity.book, identity.uid, 'scheduler')) }),
                badge('未纳入'), element('p', { class: 'wb-result-reason', text: String(choice.reason || '') })));
        }
        if (!blue.length && !selected.length && !skipped.length) this.results.append(element('div', { class: 'wb-empty' }, icon('file'),
            element('strong', { text: '本轮未纳入蓝灯或绿灯' }), element('p', { class: 'wb-help', text: report.unindexedBooks?.length
                ? '无可用目录的书继续走原生规则。可在世界书库整理目录后再试。'
                : '仅对已挂载、勾选托管且目录可用的书进行筛选。' })));
    }

    update() {
        if (!this.dirty && !sameValue(this.baseline, this.savedSettings())) this.discard();
        const config = this.director.config;
        const hasChat = Boolean(this.workbench.getContext().chatId);
        const locked = this.director.busy || this.workbench.store.busy;
        this.enabled.disabled = locked;
        this.enabledNote.textContent = this.enabled.checked !== config.enabled ? '启用状态已修改，保存设置后生效'
            : config.enabled ? '已启用，生成前按目录筛选本轮需要的绿灯' : '调度已关闭，世界书编辑仍可使用';
        this.preview.disabled = locked || !hasChat || this.dirty;
        this.refresh.disabled = locked;
        const cancellable = Boolean(this.director.operation || (this.director.gate && !this.director.gate.committed));
        this.cancel.disabled = !cancellable;
        this.cancel.hidden = !cancellable;
        this.save.disabled = locked || !this.dirty;
        this.discardButton.disabled = locked || !this.dirty;
        this.save.setAttribute('aria-busy', String(locked));
        for (const input of this.numbers.values()) input.disabled = locked;
        for (const row of this.bookRows.values()) row.input.disabled = locked;
        this.updateBookDirectories();
        this.dirtyState.textContent = this.dirty ? '先保存设置，再试运行' : '设置已保存';
        this.dirtyState.dataset.dirty = String(this.dirty);
        this.status.textContent = this.director.status;
        this.scopeNote.textContent = catalogScope(this.director);
        const current = this.director.report;
        const report = current?.chatKey && current.chatKey !== this.director.chatKey() ? null : current;
        const key = JSON.stringify([report, Boolean(this.director.gate)]);
        if (key !== this.reportKey) { this.reportKey = key; this.renderResults(report); }
        for (const rule of this.ruleHosts) this.workbench.updateOverride(rule.host, rule.book, rule.uid, rule.chat);
        this.workbench.scrollbars?.refresh();
    }

    async apply() {
        if (this.director.busy || this.workbench.store.busy) throw new Error('请先完成当前请求或原书保存。');
        const values = {};
        for (const [key, input] of this.numbers) {
            const value = Number(input.value);
            if (!input.value.trim() || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) {
                throw new Error('请在输入框标明的范围内填写整数。');
            }
            values[key] = value;
        }
        this.director.updateSettings({ ...values, enabled: this.enabled.checked, books: [...this.selectedBooks] });
        this.baseline = this.savedSettings();
        this.update();
        await this.director.loadCatalog();
        this.workbench.notify('调度设置已保存，下次生成生效。');
        return true;
    }

    discard() {
        this.baseline = this.savedSettings();
        this.enabled.checked = this.baseline.enabled;
        for (const [key, input] of this.numbers) input.value = this.baseline[key];
        this.selectedBooks = new Set(this.baseline.books);
        this.refreshBooks();
        this.update();
    }

    rememberPosition() {
        if (!this.viewport.isConnected) return;
        this.scrollTop = this.viewport.scrollTop; this.booksScrollTop = this.bookList.scrollTop;
    }

    restorePosition() {
        cancelAnimationFrame(this.restoreFrame);
        this.restoreFrame = requestAnimationFrame(() => {
            if (!this.workbench.root?.contains(this.viewport)) return;
            this.viewport.scrollTop = this.scrollTop; this.bookList.scrollTop = this.booksScrollTop;
        });
    }
}
