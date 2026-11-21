import { element, button, icon, displayText } from './workbench-utils.js';
import { contextKey, clone } from './workbench-state.js';
import { bookCategories } from './book-categories.js';
import { scrollRegion } from './workbench-scroll.js';

/** Builds the editor once per session; status updates never replace the form. */
export class EntryEditor {
    constructor(workbench) {
        this.workbench = workbench;
        this.store = workbench.store;
        this.controls = [];
        this.overrideIdentity = '';
        this.session = this.store.session;
        this.isNew = this.session.isNew;
        this.expanded = false;
        this.position = { form: 0, text: 0 };
        this.focus = null;
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
        input.addEventListener('input', () => {
            this.store.set(field, this.workbench.api.parseKeywords(input.value));
            if (field === 'keysecondary') this.updatePosition();
        });
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
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: select.id, text: '触发方式' }), select);
    }

    categoryField() {
        this.category = element('select', { id: 'wb-edit-category', 'aria-label': '条目分类' });
        this.category.dataset.kind = 'category';
        this.category.addEventListener('change', () => this.workbench.run(() => this.store.setCategory(this.category.value)));
        this.controls.push(this.category);
        this.categoryHeading = element('div', { class: 'wb-field-heading' }, element('label', { htmlFor: this.category.id, text: '分类' }));
        if (this.isNew) {
            this.addCategory = button('新增分类', { class: 'wb-inline-action', onclick: () => this.workbench.addCategorySheet(this.session.book, {
                onAdded: (id, book) => {
                    if (this.store.session === this.session && book === this.session.book) {
                        this.store.setCategory(id); this.refreshCategories();
                    }
                },
            }) });
            this.categoryHeading.append(this.addCategory);
        }
        this.refreshCategories();
        return element('div', { class: 'wb-field' }, this.categoryHeading, this.category);
    }

    refreshCategories() {
        if (!this.category || this.store.session !== this.session) return;
        const definitions = bookCategories(this.store.loaded.get(this.session.book));
        const selected = this.session.categoryDraft;
        const signature = JSON.stringify([definitions, selected]);
        if (signature === this.categorySignature) return;
        this.categorySignature = signature;
        this.category.replaceChildren(element('option', { value: '', text: '不指定分类' }),
            ...definitions.map(value => element('option', { value: value.id, text: value.name })));
        if (selected && !definitions.some(value => value.id === selected)) {
            this.category.append(element('option', { value: selected, text: '原分类已移除（请重新选择）' }));
        }
        this.category.value = selected;
    }

    build() {
        const session = this.session;
        this.backButton = button(this.workbench.editorReturn === 'scheduler' ? '返回调度器' : '条目列表', {
            glyph: 'back', onclick: () => this.workbench.run(() => this.workbench.leaveEditor()),
        });
        this.identity = element('small', { class: 'wb-option-meta' });
        this.previous = button('上条', { 'aria-label': '编辑上一条', onclick: () => this.workbench.run(() => this.workbench.navigateEntry(-1)) });
        this.next = button('下条', { 'aria-label': '编辑下一条', onclick: () => this.workbench.run(() => this.workbench.navigateEntry(1)) });
        this.top = element('div', { class: 'wb-editor-source' }, this.backButton,
            element('div', { class: 'wb-option-main' }, element('strong', { text: session.book }), this.identity),
            this.isNew ? null : element('div', { class: 'wb-entry-step' }, this.previous, this.next));
        this.problem = element('div', { class: 'wb-error', role: 'alert', hidden: true });
        this.externalNote = element('p', { class: 'wb-help', hidden: true, text: '原书已在其他位置变化，当前草稿保留。保存时会检查是否冲突。' });
        this.contextNote = element('p', { class: 'wb-help', hidden: true, text: '聊天已切换，这份草稿仍属于上方显示的世界书。' });
        this.toggleNote = element('p', { class: 'wb-help', hidden: session.editKind !== 'toggle', text: '这里保留了条目启用状态的修改。可以保存这次修改，或放弃草稿。' });
        this.reloadButton = button('重新读取原书', { kind: 'text', glyph: 'refresh', onclick: () => this.workbench.run(() => this.workbench.reloadEditorSource()) });
        this.recoveryButton = button('重新读取原书', { kind: 'text', glyph: 'refresh', hidden: true,
            onclick: () => this.workbench.run(() => this.workbench.reloadEditorSource()) });
        this.categoryPendingText = element('span');
        this.categoryPendingButton = button('处理分类', { kind: 'text', onclick: () => {
            if (this.workbench.categories.pending) this.workbench.addCategorySheet(this.workbench.categories.operation.book);
        } });
        this.categoryPendingNote = element('div', { class: 'wb-draft-notice', hidden: true }, this.categoryPendingText, this.categoryPendingButton);
        this.secondaryOptions = element('div', { class: 'wb-conditional-row' },
            this.switchField('selective', '使用次关键词条件'),
            this.selectField('selectiveLogic', '次关键词逻辑', [
                [this.workbench.api.logic.AND_ANY, '任意匹配'], [this.workbench.api.logic.NOT_ALL, '不全部匹配'],
                [this.workbench.api.logic.NOT_ANY, '全部不匹配'], [this.workbench.api.logic.AND_ALL, '全部匹配'],
            ]));
        const positions = this.workbench.api.positions;
        const positionChoices = [
            [positions.before, '角色定义之前'], [positions.after, '角色定义之后'],
            [positions.ANTop, '作者注释之前'], [positions.ANBottom, '作者注释之后'],
            [positions.atDepth, '聊天内指定深度'], [positions.EMTop, '示例消息之前'],
            [positions.EMBottom, '示例消息之后'], [positions.outlet, '指定出口'],
        ];
        this.depthGroup = element('div', { class: 'wb-conditional-row' },
            this.numberField('depth', '插入深度', { min: 0 }),
            this.selectField('role', '插入角色', [[0, '系统'], [1, '用户'], [2, '助手']]));
        this.outletGroup = this.textField('outletName', '出口名称');
        const positionInput = this.selectField('position', '插入位置', positionChoices, { onChange: () => this.updatePosition() });
        this.probabilityGroup = this.numberField('probability', '概率 %', { min: 0, max: 100 });
        const probabilityEnabled = this.switchField('useProbability', '概率判定', { onChange: () => this.updatePosition() });
        this.advanced = element('div', { class: 'wb-settings-body' },
            element('p', { class: 'wb-help', text: '这些属性随条目一起保存到原书。' }),
            this.isNew ? null : element('p', { class: 'wb-help', text: `原书条目编号：${session.uid}` }),
            this.switchField('ignoreBudget', '忽略原生预算', { hint: '成功调度使用自己的绿灯预算，蓝灯不占预算；未托管或纯向量条目仍按原生规则处理。' }),
            this.switchField('excludeRecursion', '排除递归匹配'),
            this.switchField('preventRecursion', '阻止触发递归'),
            this.numberField('scanDepth', '独立扫描深度', { min: 0, max: 1000, nullable: true }),
            this.selectField('caseSensitive', '区分大小写', [['null', '跟随原生默认'], ['true', '是'], ['false', '否']], { nullable: true }),
            this.selectField('matchWholeWords', '匹配完整单词', [['null', '跟随原生默认'], ['true', '是'], ['false', '否']], { nullable: true }),
            element('p', { class: 'wb-help', text: '未在此处显示的原生属性会随原条目保留。' }));
        this.advancedButton = button('高级属性', { onclick: () => {
            this.workbench.sheets.open('高级属性', this.advanced); this.update();
        } });
        this.overrideHost = element('div');
        this.summaryText = element('p', { class: 'wb-help' });
        const scheduling = this.details('本聊天调度与目录', [
            this.overrideHost,
            element('p', { class: 'wb-help', text: '自动／固定／排除只属于本聊天。未挂载、未托管、禁用或尚未保存的条目不能设置此规则。' }),
            this.summaryText,
        ]);
        this.advanced.append(scheduling, this.reloadButton);
        const contentField = this.textField('content', '正文', { multiline: true, placeholder: '填写世界书原文…' });
        const bodyLabel = contentField.querySelector('label');
        this.expand = button('放大正文', { class: 'wb-inline-action', 'aria-pressed': false, onclick: () => {
            this.expanded = !this.expanded;
            this.workbench.root.classList.toggle('wb-editor-expanded', this.expanded);
            this.expand.setAttribute('aria-pressed', String(this.expanded));
            this.expand.textContent = this.expanded ? '还原布局' : '放大正文';
            this.resizeText(this.textarea);
        } });
        const bodyTools = element('div', { class: 'wb-body-tools' }, this.expand);
        if (this.isNew) {
            this.templateButton = button('正文模板', { class: 'wb-inline-action', onclick: () => this.templateSheet() });
            bodyTools.prepend(this.templateButton);
        }
        contentField.classList.add('wb-body-field');
        contentField.replaceChildren(element('div', { class: 'wb-body-heading' }, bodyLabel, bodyTools), scrollRegion(this.textarea, 'wb-textarea-scroll'));
        this.form = element('form', { class: 'wb-editor-form', id: 'wb-entry-form' },
            this.problem, this.externalNote, this.contextNote, this.toggleNote, this.categoryPendingNote, this.recoveryButton,
            element('div', { class: 'wb-editor-meta' },
                this.textField('comment', '标题 / 备注', { placeholder: '填写条目标题' }), this.categoryField(), this.activationField()),
            element('div', { class: 'wb-keyword-row' }, this.keywordsField('key', '主要关键词'), this.keywordsField('keysecondary', '次要关键词')),
            this.secondaryOptions,
            this.isNew ? element('p', { class: 'wb-creation-hint', text: '先选分类与触发方式，再填写内容；蓝灯条目会自动出现在常驻页。' }) : null,
            contentField,
            element('div', { class: 'wb-editor-attributes' }, positionInput, this.numberField('order', '顺序'),
                element('div', { class: 'wb-probability-field' }, this.probabilityGroup, probabilityEnabled), this.advancedButton),
            this.depthGroup, this.outletGroup);
        this.form.addEventListener('submit', event => { event.preventDefault(); this.workbench.run(() => this.workbench.saveEditor()); });
        this.form.addEventListener('focusin', event => this.rememberFocus(event.target));
        this.form.addEventListener('focusout', event => this.rememberFocus(event.target));
        for (const type of ['input', 'keyup', 'pointerup', 'select']) this.form.addEventListener(type, event => this.rememberFocus(event.target));
        this.view = element('section', { class: 'wb-feature-view wb-editor' }, scrollRegion(this.form, 'wb-fill-scroll'));
        this.dirtyStatus = element('span', { class: 'wb-dirty-status', role: 'status' });
        this.saveButton = button(this.isNew ? '创建条目' : '保存到原书', {
            glyph: 'save', kind: 'primary', onclick: () => this.workbench.run(() => this.workbench.saveEditor()),
        });
        this.discardButton = button(this.isNew ? '取消' : '放弃修改', { onclick: () => this.workbench.run(() => this.workbench.discardEditor()) });
        const actionButtons = element('div', { class: `wb-action-buttons${this.isNew ? ' wb-create-actions' : ''}` });
        if (!this.isNew) {
            this.copyButton = button('复制正文', { glyph: 'copy', onclick: () => this.workbench.run(() => this.workbench.copyEditorContent()) });
            this.deleteButton = button('删除', { glyph: 'trash', 'data-tone': 'danger', onclick: () => this.workbench.run(() => this.workbench.deleteEditorEntry()) });
            actionButtons.append(this.copyButton, this.deleteButton);
        }
        actionButtons.append(this.discardButton, this.saveButton);
        this.actions = element('div', { class: 'wb-action-row wb-entry-actions' }, this.dirtyStatus, actionButtons);
        this.updatePosition();
        this.update();
    }

    templateSheet() {
        if (!this.isNew || this.store.busy || this.session.pending) return;
        const list = element('div', { class: 'wb-settings-body' },
            element('p', { class: 'wb-help', text: '模板只提供正文结构，填写后仍需点击创建条目。' }));
        for (const [name, text] of [
            ['简洁说明', '概述：\n\n详细说明：\n\n补充信息：\n'],
            ['分段资料', '【基本信息】\n\n【详细描述】\n\n【相关关系】\n\n【备注】\n'],
        ]) {
            const preview = element('pre', { class: 'wb-template-preview', text });
            list.append(element('section', { class: 'wb-template-option' }, element('h3', { text: name }), preview,
                button('填入正文', { onclick: () => this.workbench.run(async () => {
                    if (displayText(this.store.value('content')).trim()) {
                        const choice = await this.workbench.sheets.choose('替换当前草稿正文？',
                            element('p', { class: 'wb-help', text: '填入模板会替换尚未保存的正文。' }),
                            [{ label: '保留正文', value: 'cancel' }, { label: '填入模板', value: 'apply', kind: 'primary' }]);
                        if (choice !== 'apply') return;
                    }
                    this.store.set('content', text); this.syncValues(); this.workbench.sheets.close();
                    this.textarea.focus({ preventScroll: true }); this.textarea.setSelectionRange(3, 3);
                }) })));
        }
        this.workbench.sheets.open('正文模板', list);
    }

    syncValues() {
        if (this.store.session !== this.session) return;
        for (const control of this.controls) {
            const kind = control.dataset.kind;
            if (kind === 'category') { this.refreshCategories(); continue; }
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
        this.workbench.scrollbars?.refresh();
    }

    rememberFocus(control) {
        if (!control?.id || !this.form.contains(control) || !['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName)) return;
        this.focus = {
            id: control.id, start: control.selectionStart, end: control.selectionEnd, direction: control.selectionDirection,
        };
    }

    rememberPosition() {
        if (!this.form.isConnected) return;
        this.position = { form: this.form.scrollTop, text: this.textarea.scrollTop };
        this.rememberFocus(document.activeElement);
    }

    restorePosition({ first = false } = {}) {
        cancelAnimationFrame(this.restoreFrame);
        this.restoreFrame = requestAnimationFrame(() => {
            if (!this.form.isConnected) return;
            this.form.scrollTop = this.position.form; this.textarea.scrollTop = this.position.text;
            const control = this.focus ? this.form.querySelector(`#${this.focus.id}`) : first && this.isNew ? this.form.querySelector('#wb-edit-comment') : null;
            if (control && !control.disabled) {
                control.focus({ preventScroll: true });
                if (Number.isInteger(this.focus?.start)) control.setSelectionRange?.(this.focus.start, this.focus.end, this.focus.direction || 'none');
            }
            this.resizeText(this.textarea);
        });
    }

    dispose() {
        cancelAnimationFrame(this.restoreFrame);
        if (this.workbench.sheets?.body.contains(this.advanced)) {
            this.workbench.sheets.close(); this.advanced.remove();
        }
    }

    updatePosition() {
        const raw = this.store.value('position');
        const position = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
        this.depthGroup.hidden = position !== this.workbench.api.positions.atDepth;
        this.outletGroup.hidden = position !== this.workbench.api.positions.outlet;
        const secondary = this.store.value('keysecondary');
        this.secondaryOptions.hidden = !(Array.isArray(secondary) ? secondary.length : displayText(secondary).trim()) && !this.store.value('selective');
        this.secondaryOptions.querySelector('select').disabled = this.store.busy || Boolean(this.session.pending) || !this.store.value('selective');
        const probability = this.probabilityGroup.querySelector('input');
        probability.disabled = this.store.busy || Boolean(this.session.pending) || !this.store.value('useProbability');
        this.resizeText(this.textarea);
    }

    update() {
        const session = this.store.session;
        if (!session || session !== this.session) return;
        const busy = this.store.busy;
        const pending = Boolean(session.pending);
        for (const control of this.controls) control.disabled = busy || pending;
        this.backButton.disabled = busy;
        this.previous.disabled = busy || this.workbench.editorNeighbors().previous == null;
        this.next.disabled = busy || this.workbench.editorNeighbors().next == null;
        this.advancedButton.disabled = busy;
        if (this.addCategory) this.addCategory.disabled = busy || pending;
        if (this.templateButton) this.templateButton.disabled = busy || pending;
        this.reloadButton.disabled = busy || this.workbench.categories.pending;
        this.recoveryButton.disabled = busy || this.workbench.categories.pending;
        this.recoveryButton.hidden = !session.problem && !session.externalChanged && !pending;
        this.categoryPendingNote.hidden = !this.workbench.categories.pending;
        this.categoryPendingButton.disabled = busy;
        if (this.workbench.categories.pending) this.categoryPendingText.textContent = `《${this.workbench.categories.operation.book}》的分类保存结果待确认。`;
        this.discardButton.disabled = busy || this.workbench.categories.pending || (!this.isNew && !this.store.dirty && !pending);
        if (this.deleteButton) this.deleteButton.disabled = busy || pending || this.workbench.categories.pending;
        const neighbors = this.workbench.editorNeighbors();
        const returnLabel = this.workbench.editorReturn === 'scheduler' ? '返回调度器' : '条目列表';
        if (this.backButton.dataset.returnTo !== returnLabel) {
            this.backButton.replaceChildren(icon('back'), document.createTextNode(returnLabel));
            this.backButton.dataset.returnTo = returnLabel;
        }
        this.identity.textContent = session.isNew ? '填写后创建到这本书' : `第 ${neighbors.index} / ${neighbors.total} 条${session.draft.disable ? ' · 已禁用' : ''}`;
        this.saveButton.disabled = busy || this.workbench.categories.pending || (!this.store.dirty && !session.pending);
        const saveLabel = session.pending?.kind === 'delete' ? '确认并重试删除' : pending ? '确认并重试保存' : this.isNew ? '创建条目' : '保存到原书';
        this.saveButton.replaceChildren(icon('save'), document.createTextNode(saveLabel));
        this.saveButton.setAttribute('aria-busy', String(busy));
        this.dirtyStatus.textContent = busy ? '正在提交…' : this.workbench.categories.pending ? '分类结果待确认'
            : pending ? '结果待确认 · 草稿保留' : session.status === 'conflict' ? '保存冲突 · 草稿保留'
                : this.isNew ? '新条目尚未创建' : this.store.dirty ? '未保存修改' : '已保存';
        this.dirtyStatus.dataset.dirty = String(this.store.dirty);
        this.problem.hidden = !session.problem;
        this.problem.textContent = session.problem;
        this.externalNote.hidden = !session.externalChanged;
        this.contextNote.hidden = session.context === contextKey(this.workbench.getContext());
        this.refreshCategories(); this.updatePosition();
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
