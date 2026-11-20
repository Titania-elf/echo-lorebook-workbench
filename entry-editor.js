import { element, button, icon, badge, displayText } from './workbench-utils.js';
import { contextKey, clone } from './workbench-state.js';

/** Builds the editor once per session; status updates never replace the form. */
export class EntryEditor {
    constructor(workbench) {
        this.workbench = workbench;
        this.store = workbench.store;
        this.controls = [];
        this.overrideIdentity = '';
        this.session = this.store.session;
        this.build();
    }

    textField(field, label, { multiline = false, hint = '', placeholder = '' } = {}) {
        const input = element(multiline ? 'textarea' : 'input', {
            id: `wb-edit-${field}`, type: multiline ? undefined : 'text',
            value: displayText(this.store.value(field)), placeholder,
            autocomplete: 'off', spellcheck: false,
        });
        input.dataset.field = field; input.dataset.kind = 'text';
        input.addEventListener('input', () => {
            this.store.set(field, input.value);
            if (multiline) this.resizeText(input);
        });
        this.controls.push(input);
        if (multiline) this.textarea = input;
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), input,
            hint ? element('p', { class: 'wb-help', text: hint }) : null);
    }

    keywordsField(field, label) {
        const values = this.store.value(field);
        const input = element('input', {
            id: `wb-edit-${field}`, type: 'text', autocomplete: 'off',
            value: Array.isArray(values) ? values.map(displayText).join(', ') : displayText(values),
            placeholder: '用英文逗号分隔，可使用原生正则关键词',
        });
        input.dataset.field = field; input.dataset.kind = 'keywords';
        input.addEventListener('input', () => this.store.set(field, this.workbench.api.parseKeywords(input.value)));
        this.controls.push(input);
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), input);
    }

    numberField(field, label, { min, max, nullable = false, hint = '' } = {}) {
        const value = this.store.value(field);
        const input = element('input', {
            id: `wb-edit-${field}`, type: 'number', inputMode: 'numeric', step: 1,
            min, max, value: value == null ? '' : displayText(value),
            placeholder: nullable ? '留空使用原生默认值' : '',
        });
        input.dataset.field = field; input.dataset.kind = 'number';
        input.addEventListener('input', () => {
            const next = input.value.trim() === '' ? (nullable ? null : Number.NaN) : Number(input.value);
            this.store.set(field, next);
        });
        this.controls.push(input);
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), input,
            hint ? element('p', { class: 'wb-help', text: hint }) : null);
    }

    selectField(field, label, choices, { onChange, nullable = false } = {}) {
        const value = this.store.value(field);
        const selected = value === null ? 'null' : displayText(value);
        const options = choices.map(([key, text]) => element('option', { value: String(key), text, selected: String(key) === selected }));
        if (!choices.some(([key]) => String(key) === selected)) options.unshift(element('option', {
            value: selected, text: `原值 ${selected}（保留）`, selected: true,
        }));
        const select = element('select', { id: `wb-edit-${field}` }, options);
        select.dataset.field = field; select.dataset.kind = 'select';
        select.wbValues = new Map(choices.map(([key]) => [String(key), nullable ? (key === 'null' ? null : key === 'true') : Number(key)]));
        if (!select.wbValues.has(selected)) select.wbValues.set(selected, clone(value));
        select.addEventListener('change', () => {
            const next = clone(select.wbValues.get(select.value));
            this.store.set(field, next);
            onChange?.(next);
        });
        this.controls.push(select);
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: select.id, text: label }), select);
    }

    switchField(field, label, { invert = false, hint = '', onChange } = {}) {
        const input = element('input', {
            id: `wb-edit-${field}`, type: 'checkbox',
            checked: invert ? !this.store.value(field) : Boolean(this.store.value(field)),
            'aria-label': label,
        });
        input.dataset.field = field; input.dataset.kind = 'switch'; input.dataset.invert = String(invert);
        input.addEventListener('change', () => {
            const next = invert ? !input.checked : input.checked;
            this.store.set(field, next); onChange?.(next);
        });
        this.controls.push(input);
        return element('div', { class: 'wb-switch-row' },
            element('div', {}, element('label', { htmlFor: input.id, text: label }), hint ? element('p', { class: 'wb-help', text: hint }) : null),
            element('label', { class: 'wb-switch', htmlFor: input.id }, input, element('span', { class: 'wb-switch-track', 'aria-hidden': 'true' })));
    }

    details(title, content) {
        return element('details', { class: 'wb-details' },
            element('summary', {}, title, icon('down')), element('div', { class: 'wb-details-body' }, content));
    }

    activationField() {
        const constant = Boolean(this.store.value('constant'));
        const vectorized = Boolean(this.store.value('vectorized'));
        const mode = constant && vectorized ? 'combined' : constant ? 'blue' : vectorized ? 'vector' : 'green';
        const options = [['green', '关键词触发 · 绿灯'], ['blue', '常驻触发 · 蓝灯'], ['vector', '向量触发']];
        if (mode === 'combined') options.push(['combined', '原生组合 · 蓝灯与向量']);
        const select = element('select', { id: 'wb-edit-activation' }, options.map(([value, text]) => element('option', { value, text, selected: value === mode })));
        select.dataset.kind = 'activation';
        select.addEventListener('change', () => {
            this.store.set('constant', select.value === 'blue' || select.value === 'combined');
            this.store.set('vectorized', select.value === 'vector' || select.value === 'combined');
        });
        this.controls.push(select);
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: select.id, text: '原生触发方式' }), select,
            element('p', { class: 'wb-help', text: '托管书仍由调度器决定是否入选；这里的改动写入原书。' }));
    }

    build() {
        const session = this.session;
        this.backButton = button('返回条目列表', { glyph: 'back', iconOnly: true, onclick: () => this.workbench.run(() => this.workbench.leaveEditor()) });
        this.moreButton = button('条目更多操作', { glyph: 'more', iconOnly: true, onclick: () => this.workbench.entryMenu() });
        this.heading = element('h2', { text: session.isNew ? '新增条目' : '条目编辑' });
        this.identity = element('span', { class: 'wb-muted' });
        this.problem = element('div', { class: 'wb-error', role: 'alert', hidden: true });
        this.externalNote = element('p', { class: 'wb-help', hidden: true, text: '原书已在其他位置变化，草稿保留；保存时会检查修改字段是否冲突。' });
        this.contextNote = element('p', { class: 'wb-help', hidden: true, text: '聊天已切换。仍可保存这本原书，但不会把旧编辑页的固定／排除写到新聊天。' });
        this.reloadButton = button('重新读取原书', { kind: 'text', glyph: 'refresh', onclick: () => this.workbench.run(() => this.workbench.reloadEditorSource()) });
        const trigger = this.details('关键词与触发设置', [
            this.keywordsField('key', '主要关键词'), this.keywordsField('keysecondary', '次要关键词'),
            this.selectField('selectiveLogic', '次关键词逻辑', [
                [this.workbench.api.logic.AND_ANY, '任意匹配'], [this.workbench.api.logic.NOT_ALL, '不全部匹配'],
                [this.workbench.api.logic.NOT_ANY, '全部不匹配'], [this.workbench.api.logic.AND_ALL, '全部匹配'],
            ]),
            this.switchField('selective', '使用次关键词条件'),
            this.switchField('disable', '启用条目', { invert: true, hint: '原书禁用是硬条件，本聊天固定不能解除它。' }),
            this.activationField(),
        ]);
        const positions = this.workbench.api.positions;
        const positionChoices = [
            [positions.before, '角色定义之前'], [positions.after, '角色定义之后'],
            [positions.ANTop, '作者注释之前'], [positions.ANBottom, '作者注释之后'],
            [positions.atDepth, '聊天内指定深度'], [positions.EMTop, '示例消息之前'],
            [positions.EMBottom, '示例消息之后'], [positions.outlet, '指定出口'],
        ];
        this.depthGroup = element('div', { class: 'wb-field-group' },
            this.numberField('depth', '插入深度', { min: 0 }),
            this.selectField('role', '插入角色', [[0, '系统'], [1, '用户'], [2, '助手']]));
        this.outletGroup = this.textField('outletName', '出口名称');
        const positionInput = this.selectField('position', '插入位置', positionChoices, { onChange: () => this.updatePosition() });
        this.probabilityGroup = this.numberField('probability', '激活概率（%）', { min: 0, max: 100 });
        const advanced = this.details('插入位置与高级属性', [
            positionInput, this.depthGroup, this.outletGroup,
            this.numberField('order', '插入顺序'),
            this.switchField('useProbability', '启用概率判定', { onChange: () => this.updatePosition() }),
            this.probabilityGroup,
            this.switchField('ignoreBudget', '忽略原生预算', { hint: '不会越过调度器自身的数量与 Token 预筛预算。' }),
            this.switchField('excludeRecursion', '排除递归匹配'),
            this.switchField('preventRecursion', '阻止触发递归'),
            this.numberField('scanDepth', '独立扫描深度', { min: 0, max: 1000, nullable: true }),
            this.selectField('caseSensitive', '区分大小写', [['null', '跟随原生默认'], ['true', '是'], ['false', '否']], { nullable: true }),
            this.selectField('matchWholeWords', '匹配完整单词', [['null', '跟随原生默认'], ['true', '是'], ['false', '否']], { nullable: true }),
            element('p', { class: 'wb-help', text: '其余原生过滤、时效和扩展字段保持不变，不用这张表单重建整条数据。' }),
        ]);
        this.overrideHost = element('div');
        this.summaryText = element('p', { class: 'wb-help' });
        const scheduling = this.details('本聊天调度与目录', [
            this.overrideHost,
            element('p', { class: 'wb-help', text: '自动／固定／排除只属于本聊天。未挂载、未托管、禁用或尚未保存的条目不能设置此规则。' }),
            this.summaryText,
        ]);
        this.form = element('form', { class: 'wb-editor-form', id: 'wb-entry-form' },
            this.textField('comment', '标题 / 备注', { placeholder: '让条目容易找到' }),
            this.textField('content', '正文', { multiline: true, placeholder: '输入世界书原文…', hint: '保存修改原世界书，其他聊天也会读取新内容。未保存的草稿不参与调度。' }),
            trigger, advanced, scheduling);
        this.form.addEventListener('submit', event => { event.preventDefault(); this.workbench.run(() => this.workbench.saveEditor()); });
        this.view = element('section', { class: 'wb-editor' },
            element('header', { class: 'wb-editor-header' }, element('div', { class: 'wb-editor-title' }, this.backButton, this.heading), this.moreButton),
            element('div', { class: 'wb-editor-source' }, element('span', {}, icon('book'), session.book), this.identity, badge('修改原书')),
            this.problem, this.externalNote, this.contextNote, this.reloadButton, this.form);
        this.dirtyStatus = element('span', { class: 'wb-dirty-status' });
        this.saveButton = button('保存到原书', { glyph: 'save', kind: 'primary', onclick: () => this.workbench.run(() => this.workbench.saveEditor()) });
        this.actions = element('div', { class: 'wb-editor-actions' }, this.dirtyStatus, this.saveButton);
        this.updatePosition();
        this.update();
        requestAnimationFrame(() => this.resizeText(this.textarea));
    }

    syncValues() {
        if (this.store.session !== this.session) return;
        for (const control of this.controls) {
            const kind = control.dataset.kind;
            if (kind === 'activation') {
                const constant = Boolean(this.store.value('constant'));
                const vector = Boolean(this.store.value('vectorized'));
                const mode = constant && vector ? 'combined' : constant ? 'blue' : vector ? 'vector' : 'green';
                if (![...control.options].some(option => option.value === mode)) control.append(element('option', { value: mode, text: '原生组合 · 蓝灯与向量' }));
                control.value = mode;
                continue;
            }
            const value = this.store.value(control.dataset.field);
            if (kind === 'switch') { control.checked = control.dataset.invert === 'true' ? !value : Boolean(value); continue; }
            const text = kind === 'keywords' && Array.isArray(value) ? value.map(displayText).join(', ') : displayText(value);
            if (kind === 'select') {
                const selected = value === null ? 'null' : displayText(value);
                if (!control.wbValues.has(selected)) {
                    control.wbValues.set(selected, clone(value));
                    control.append(element('option', { value: selected, text: `原值 ${selected}（保留）` }));
                }
                control.value = selected;
            } else if (control.value !== text) control.value = text;
        }
        this.updatePosition();
        this.resizeText(this.textarea);
    }

    resizeText(textarea) {
        if (!textarea?.isConnected) return;
        const available = window.visualViewport?.height || window.innerHeight;
        const maximum = Math.max(192, Math.min(640, Math.round(available * 0.6)));
        textarea.style.height = 'auto';
        const height = Math.max(192, Math.min(textarea.scrollHeight, maximum));
        textarea.style.height = `${height}px`;
        textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight ? 'auto' : 'hidden';
    }

    updatePosition() {
        const raw = this.store.value('position');
        const position = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
        this.depthGroup.hidden = position !== this.workbench.api.positions.atDepth;
        this.outletGroup.hidden = position !== this.workbench.api.positions.outlet;
        this.probabilityGroup.hidden = !this.store.value('useProbability');
    }

    update() {
        const session = this.store.session;
        if (!session || session !== this.session) return;
        const busy = this.store.busy;
        const pending = Boolean(session.pending);
        for (const control of this.controls) control.disabled = busy || pending;
        this.backButton.disabled = busy;
        this.moreButton.disabled = busy || pending;
        this.reloadButton.disabled = busy;
        this.heading.textContent = session.isNew ? '新增条目' : '条目编辑';
        this.identity.textContent = session.isNew ? '尚未保存' : `UID ${session.uid}`;
        this.saveButton.disabled = busy || (!this.store.dirty && !session.pending);
        this.saveButton.replaceChildren(icon('save'), document.createTextNode(session.pending?.kind === 'delete' ? '重试删除（先确认）' : pending ? '重试保存（先确认）' : '保存到原书'));
        this.saveButton.setAttribute('aria-busy', String(busy));
        this.dirtyStatus.textContent = busy ? '正在提交…' : pending ? '结果待确认 · 草稿保留' : session.status === 'conflict' ? '保存冲突 · 草稿保留' : this.store.dirty ? '未保存修改' : '已保存';
        this.dirtyStatus.dataset.dirty = String(this.store.dirty);
        this.problem.hidden = !session.problem;
        this.problem.textContent = session.problem;
        this.externalNote.hidden = !session.externalChanged;
        this.contextNote.hidden = session.context === contextKey(this.workbench.getContext());
        const identity = `${session.book}/${session.uid ?? 'new'}`;
        if (this.overrideIdentity !== identity) {
            this.overrideIdentity = identity;
            this.workbench.attachOverride(this.overrideHost, session.book, session.uid, session.context);
        }
        this.workbench.updateOverride(this.overrideHost, session.book, session.uid, session.context);
        const directory = this.workbench.entryDirectory(session.book, session.baseline);
        this.summaryText.textContent = session.isNew ? '保存后生成本地目录；AI 概括需要单独操作。' :
            `${directory.kind}：${directory.text}${this.store.dirty ? '（草稿尚未保存，目录只参考已保存版本。）' : ''}`;
    }
}
