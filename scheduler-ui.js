import { element, button, icon, badge } from './workbench-utils.js';

/** Scheduler presentation reuses the existing director, never makes its own model request. */
export class SchedulerUI {
    constructor(workbench) {
        this.workbench = workbench;
        this.director = workbench.director;
        this.reportKey = null;
        this.ruleHosts = [];
        this.settingsControls = [];
        this.build();
    }

    build() {
        this.enabled = element('input', { id: 'wb-scheduler-enabled', type: 'checkbox', 'aria-label': '启用生成前调度' });
        this.enabled.addEventListener('change', () => this.director.updateSettings({ enabled: this.enabled.checked }));
        this.enabledNote = element('p', { class: 'wb-help' });
        this.preview = button('试选（调用 API）', { glyph: 'play', kind: 'primary', onclick: () => this.workbench.run(() => this.director.preview()) });
        this.settingsButton = button('调度设置', { glyph: 'sliders', onclick: () => this.settings() });
        this.summary = button('AI 概括目录（调用 API）', { kind: 'text', onclick: () => this.workbench.run(() => this.workbench.summarize()) });
        this.refresh = button('刷新本地目录', { kind: 'text', glyph: 'refresh', onclick: () => this.workbench.run(() => this.director.loadCatalog()) });
        this.cancel = button('取消辅助请求', { kind: 'text', onclick: () => this.director.invalidate('辅助请求已取消；若正文仍继续，本轮使用原生世界书规则。') });
        this.status = element('div', { class: 'wb-status', role: 'status', 'aria-live': 'polite' });
        this.scopeNote = element('p', { class: 'wb-help' });
        this.sceneText = element('p', { class: 'wb-scene-text' });
        this.resultHeading = element('h3', { text: '调度结果' });
        this.resultNote = element('p', { class: 'wb-help' });
        this.results = element('div');
        this.view = element('section', { class: 'wb-scheduler' },
            element('div', { class: 'wb-scheduler-heading' }, element('div', {}, element('h2', { text: '本聊天调度' }), this.enabledNote),
                element('label', { class: 'wb-switch', htmlFor: this.enabled.id }, this.enabled, element('span', { class: 'wb-switch-track', 'aria-hidden': 'true' }))),
            element('div', { class: 'wb-scheduler-actions' }, this.preview, this.settingsButton),
            this.scopeNote, element('div', { class: 'wb-scheduler-secondary' }, this.summary, this.refresh, this.cancel),
            this.status,
            element('section', { class: 'wb-scene' }, element('div', { class: 'wb-scene-header' }, element('strong', { text: '当前场景' }), badge('场景工作集')), this.sceneText,
                element('p', { class: 'wb-help', text: '工作集只参考已确认场景；保留并不代表永久激活。' })),
            element('section', {}, element('div', { class: 'wb-result-heading' }, this.resultHeading, this.resultNote), this.results),
            element('details', { class: 'wb-details' }, element('summary', {}, '托管、实际激活与失败回退', icon('down')),
                element('div', { class: 'wb-details-body' },
                    element('p', { class: 'wb-help', text: '托管选择全局保存，仅本聊天原生挂载的书参与；托管书内蓝灯与绿灯都由调度器决定是否入选，原生禁用不能被固定解除。' }),
                    element('p', { class: 'wb-help', text: '选中不等于实际激活。原生位置、预算、概率、互斥组、角色与生成类型过滤仍适用；忽略原生预算也不能越过调度器预筛。' }),
                    element('p', { class: 'wb-help', text: '请求超时、错误或无效 JSON 时回退原生触发，手动排除也不再限制原生扫描。调度器不是严格剧透锁或权限控制。' }),
                    element('p', { class: 'wb-help', text: '试选读取已发送聊天，不读取输入框草稿，不注入正文或更新场景。普通回复、重生成、滑动和续写可调度；安静生成、代写用户和原生提示预览保持原生行为。' }),
                    element('p', { class: 'wb-help', text: '并发生成与其他插件可能使请求回退；托管模式不保证原生黏性／冷却计时连续。AI 目录仅作选择线索，正文仍注入原文。' }))));
        this.update();
    }

    renderResults(report) {
        this.ruleHosts = [];
        this.results.replaceChildren();
        if (!report) {
            this.resultHeading.textContent = '尚未试选';
            this.resultNote.textContent = '先配置托管书和辅助连接，可以试选而不发送正文。';
            return;
        }
        if (report.mode === 'fallback') {
            this.resultHeading.textContent = '本轮回退原生触发';
            this.resultNote.textContent = report.error || '原生世界书照常扫描，本轮没有接管。';
            return;
        }
        const selected = report.selected || [];
        const skipped = report.skipped || [];
        this.resultHeading.textContent = report.mode === 'preview' ? '最近试选结果' : '最近生成结果';
        const actual = new Set(report.actual || []);
        this.resultNote.textContent = report.stale ? '世界书已改变，此结果已过期，请重新试选。' :
            report.mode === 'preview' ? `选中 ${selected.length} 条，约 ${report.tokens ?? 0} tokens；没有注入正文，也没有更新场景。` :
                `选中 ${selected.length} 条，原生实际激活 ${actual.size} 条，约 ${report.tokens ?? 0} tokens。`;
        for (const choice of selected) {
            const item = this.director.catalog.find(entry => entry.id === choice.id);
            const identity = this.workbench.parseIdentity(choice.id);
            if (!identity) continue;
            const title = item?.title || `${identity.book} · 条目 ${identity.uid}`;
            const state = report.mode === 'preview' ? '试选候选' : this.director.gate ? '待原生扫描' : actual.has(choice.id) ? '原生实际激活' : '选中，未激活';
            const rules = element('div');
            const chat = report.chatKey || this.director.chatKey();
            this.workbench.attachOverride(rules, identity.book, identity.uid, chat);
            this.ruleHosts.push({ host: rules, ...identity, chat });
            this.results.append(element('article', { class: 'wb-result' },
                button(title, { class: 'wb-result-open', glyph: 'file', onclick: () => this.workbench.run(() => this.workbench.openEntry(identity.book, identity.uid, 'scheduler')) }),
                element('div', { class: 'wb-result-meta' }, badge(state, actual.has(choice.id) ? 'check' : null), badge(choice.scope === 'scene' ? '场景资料' : '本轮临时'), badge(`约 ${choice.tokens ?? 0} tokens`)),
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
        if (!selected.length && !skipped.length) this.results.append(element('div', { class: 'wb-empty' }, icon('file'),
            element('strong', { text: '本次没有选中条目' }), element('p', { class: 'wb-help', text: '空选择是允许的；检查挂载、托管、禁用及当前场景需要。' })));
    }

    update() {
        const config = this.director.config;
        const hasChat = Boolean(this.workbench.getContext().chatId);
        this.enabled.checked = config.enabled;
        this.enabledNote.textContent = config.enabled ? '生成前读取目录并选择资料' : '调度已关闭，世界书编辑仍可使用';
        this.preview.disabled = this.director.busy || !hasChat;
        this.summary.disabled = this.director.busy || !hasChat;
        this.refresh.disabled = this.director.busy;
        this.cancel.disabled = !this.director.busy;
        this.status.textContent = this.director.status;
        const missing = config.books.filter(book => !this.director.activeBooks.includes(book));
        this.scopeNote.textContent = `${this.director.catalog.length} 个可用条目；上限 ${config.maxEntries} 条 / ${config.tokenBudget} tokens。${missing.length ? `未挂载或为空：${missing.join('、')}` : '仅当前挂载书参与调度。'}`;
        const state = this.director.state();
        const current = this.director.report;
        const report = current?.chatKey && current.chatKey !== this.director.chatKey() ? null : current;
        this.sceneText.textContent = report?.scene || state.snapshots.at(-1)?.scene || '尚未建立场景工作集。';
        const key = JSON.stringify([report, Boolean(this.director.gate)]);
        if (key !== this.reportKey) { this.reportKey = key; this.renderResults(report); }
        for (const rule of this.ruleHosts) this.workbench.updateOverride(rule.host, rule.book, rule.uid, rule.chat);
        for (const control of this.settingsControls) if (control.isConnected) control.disabled = this.director.busy || (control.dataset.requiresChat === 'true' && !hasChat);
    }

    settings() {
        const config = this.director.config;
        this.settingsControls = [];
        const options = [element('option', { value: '', text: '当前聊天补全连接', selected: !config.profileId })];
        let profiles = [];
        try { profiles = this.workbench.getContext().ConnectionManagerRequestService?.getSupportedProfiles() || []; } catch { /* Optional host extension. */ }
        for (const profile of profiles) options.push(element('option', { value: profile.id, text: profile.name, selected: config.profileId === profile.id }));
        if (config.profileId && !profiles.some(profile => profile.id === config.profileId)) options.push(element('option', { value: config.profileId, text: '所选连接已失效（请重新选择）', selected: true }));
        const profile = element('select', { id: 'wb-profile' }, options);
        this.settingsControls.push(profile);
        const controls = new Map();
        const numbers = [['maxEntries', '单轮最多条目', 1, 30], ['tokenBudget', '原文 Token 预算', 128, 16000], ['recentMessages', '最近消息数', 1, 30], ['timeoutSeconds', '请求超时（秒）', 10, 180]];
        const fields = numbers.map(([key, label, min, max]) => {
            const input = element('input', { id: `wb-config-${key}`, type: 'number', inputMode: 'numeric', min, max, step: 1, value: config[key] });
            controls.set(key, input); this.settingsControls.push(input);
            return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), input);
        });
        const selected = new Set(config.books);
        const bookNames = [...new Set([...this.workbench.books.map(book => book.name), ...config.books])];
        const bookList = element('div', { class: 'wb-managed-list' });
        const rows = [];
        for (const name of bookNames) {
            const book = this.workbench.bookInfo(name);
            const input = element('input', { type: 'checkbox', checked: selected.has(name), 'aria-label': `托管 ${name}` });
            input.addEventListener('change', () => input.checked ? selected.add(name) : selected.delete(name));
            this.settingsControls.push(input);
            const row = element('label', { class: 'wb-managed-option' },
                element('span', { class: 'wb-option-main' }, element('strong', { text: name }), element('small', { class: 'wb-option-meta', text: book?.source || '书目已失效，可取消托管' })), input);
            rows.push({ name, row }); bookList.append(row);
        }
        const search = element('input', { id: 'wb-managed-search', type: 'search', placeholder: '搜索托管书目', 'aria-label': '搜索托管书目' });
        search.addEventListener('input', () => rows.forEach(({ name, row }) => { row.hidden = !name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()); }));
        const apply = button('完成设置', { kind: 'primary', onclick: () => this.workbench.run(async () => {
            if (this.director.busy) throw new Error('先完成或取消当前辅助请求。');
            const values = {};
            for (const [key, input] of controls) {
                const value = Number(input.value);
                if (!Number.isInteger(value) || value < Number(input.min) || value > Number(input.max) || !input.value.trim()) throw new Error('请在输入框标明的范围内填写整数。');
                values[key] = value;
            }
            this.director.updateSettings({ ...values, books: [...selected], profileId: profile.value });
            this.workbench.sheets.close();
            await this.director.loadCatalog();
            this.workbench.notify('调度设置已保存，下次生成生效。');
        }) });
        const clear = button('清空场景记忆', { kind: 'text', onclick: () => this.workbench.run(() => this.workbench.clearScene()) });
        clear.disabled = this.director.busy || !this.workbench.getContext().chatId;
        clear.dataset.requiresChat = 'true';
        this.settingsControls.push(apply, clear);
        const body = element('div', { class: 'wb-settings-body' },
            element('div', { class: 'wb-field' }, element('label', { htmlFor: profile.id, text: '辅助模型连接' }), profile,
                element('p', { class: 'wb-help', text: '可使用当前补全连接或已保存配置，不切换正文模型，不额外保存 API 密钥。' })),
            element('div', { class: 'wb-settings-grid' }, fields),
            element('h3', { text: '托管世界书' }),
            element('p', { class: 'wb-help', text: '设置全局保存；勾选未挂载书不会自动把它带入当前聊天。' }),
            element('div', { class: 'wb-search' }, icon('search'), search), bookList,
            element('p', { class: 'wb-help', text: '固定也受数量与 Token 预算约束，原文不截断；最终仍受原生扫描条件限制。' }), clear, apply);
        this.workbench.sheets.open('调度设置', body);
        this.update();
    }
}
