import { element, button } from './workbench-utils.js';
import { scrollRegion } from './workbench-scroll.js';
import { clone, sameValue } from './workbench-state.js';
import { PromptReorderController } from './prompt-reorder.js';
import {
    PROMPT_TASKS, PROMPT_ROLES, PROMPT_MACROS,
    normalizePromptTemplates, defaultPromptEntries, validatePromptTemplates,
} from '../scheduler/prompt-templates.js';

const entryKey = (task, id) => JSON.stringify([task, id]);
const taskLabel = id => PROMPT_TASKS.find(task => task.id === id)?.label || id;
const roleLabel = value => PROMPT_ROLES.find(role => role.value === value)?.label || value;
const ENTRY_ACTIONS = [
    {
        id: 'delete', label: '删除条目', glyph: 'trash', tone: 'danger',
        run: (ui, task, entry) => ui.removeEntry(task, entry.id, entry),
    },
];

/** Keeps the draft and editor controls alive while other workbench pages are open. */
export class PromptSettingsUI {
    constructor(workbench) {
        this.workbench = workbench;
        this.director = workbench.director;
        this.task = PROMPT_TASKS[0].id;
        this.selected = new Map();
        this.rows = new Map();
        this.textPositions = new Map();
        this.listPositions = new Map();
        this.listPagePositions = new Map();
        this.editorPagePositions = new Map();
        this.mobileEditor = false;
        this.expandedEntryKey = '';
        this.scrollTop = 0;
        this.baseline = this.savedSettings();
        this.draft = clone(this.baseline);
        this.build();
    }

    savedSettings() {
        return normalizePromptTemplates(this.director.config.promptTemplates);
    }

    get dirty() { return !sameValue(this.draft, this.baseline); }
    get locked() { return this.director.busy || this.workbench.store.busy; }
    get entries() { return this.draft[this.task] || []; }
    get entry() { return this.entries.find(value => value.id === this.selected.get(this.task)); }

    field(input, label, hint = '') {
        return element('div', { class: 'wb-field' },
            element('label', { htmlFor: input.id, text: label }), input,
            hint ? element('p', { class: 'wb-help', text: hint }) : null);
    }

    build() {
        const workbench = this.workbench;
        const task = PROMPT_TASKS[0];
        this.helpButton = button('宏与提示词说明', {
            id: 'wb-prompt-help', iconOnly: true, glyph: 'help',
            onclick: () => this.openHelp(),
        });
        this.addButton = button('新增条目', {
            id: 'wb-prompt-add', glyph: 'plus', onclick: () => workbench.run(() => this.addEntry()),
        });
        this.defaultsButton = button('恢复默认', {
            id: 'wb-prompt-defaults', onclick: () => workbench.run(() => this.restoreDefaults()),
        });
        this.entryCount = element('small', { class: 'wb-help' });
        this.entryList = element('div', {
            id: 'wb-prompt-list', class: 'wb-prompt-list', role: 'group', 'aria-label': '目录筛选提示词条目',
        });
        this.entryList.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !this.expandedEntryKey) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeEntryActions({ focus: true });
        });
        const listPanel = element('aside', { class: 'wb-prompt-list-panel' },
            element('div', { class: 'wb-prompt-panel-heading' },
                element('h3', { text: '提示词条目' }), this.addButton),
            this.entryCount, scrollRegion(this.entryList, 'wb-prompt-list-scroll'));

        this.name = element('input', {
            id: 'wb-prompt-name', type: 'text', autocomplete: 'off', maxLength: 64,
            placeholder: '为这条提示词起一个名字',
        });
        this.role = element('select', { id: 'wb-prompt-role' },
            PROMPT_ROLES.map(role => element('option', { value: role.value, text: role.label })));
        this.content = element('textarea', {
            id: 'wb-prompt-content', class: 'wb-prompt-text', rows: 14,
            autocomplete: 'off', spellcheck: false, placeholder: '填写提示词正文，或在光标处插入宏…',
        });
        for (const [key, control, event] of [
            ['name', this.name, 'input'], ['role', this.role, 'change'], ['content', this.content, 'input'],
        ]) {
            control.addEventListener(event, () => {
                if (!this.entry || this.locked) return;
                this.entry[key] = control.value;
                if (key === 'content') this.rememberTextPosition();
                this.changed();
            });
        }
        for (const event of ['select', 'click', 'keyup', 'blur']) {
            this.content.addEventListener(event, () => this.rememberTextPosition());
        }
        this.insertMacroButton = button('插入宏', {
            id: 'wb-prompt-insert-macro', iconOnly: true, glyph: 'code', title: '插入宏',
            class: 'wb-icon-button wb-prompt-insert',
            onclick: () => workbench.run(() => this.openMacroPicker()),
        });
        this.insertMacroButton.addEventListener('pointerdown', () => this.rememberTextPosition());
        this.backButton = button('返回提示词条目', {
            id: 'wb-prompt-back', glyph: 'back', class: 'wb-button wb-secondary wb-prompt-back',
            onclick: () => this.returnToList(),
        });
        this.editorTitle = element('h3', { text: '编辑提示词', tabIndex: -1 });
        this.editorEmpty = element('div', { class: 'wb-empty wb-prompt-editor-empty' },
            element('strong', { text: '还没有提示词条目' }),
            element('p', { class: 'wb-help', text: '点击“新增条目”开始编辑。' }));
        this.editorFields = element('div', { class: 'wb-prompt-editor-fields' },
            element('div', { class: 'wb-prompt-meta' }, this.field(this.name, '条目名称'), this.field(this.role, '消息身份')),
            element('div', { class: 'wb-prompt-body wb-field' },
                element('div', { class: 'wb-prompt-body-heading' },
                    element('label', { htmlFor: this.content.id, text: '提示词正文' }), this.insertMacroButton),
                scrollRegion(this.content, 'wb-prompt-text-scroll')));
        const editorPanel = element('section', { id: 'wb-prompt-editor', class: 'wb-prompt-editor-panel' },
            this.backButton,
            element('div', { class: 'wb-prompt-panel-heading' },
                this.editorTitle),
            this.editorEmpty, this.editorFields);
        this.problem = element('p', { class: 'wb-error wb-prompt-problem', role: 'alert', hidden: true });
        this.state = element('span', { id: 'wb-prompt-state', class: 'wb-dirty-status', role: 'status', 'aria-live': 'polite' });
        this.discardButton = button('放弃修改', {
            id: 'wb-prompt-discard', onclick: () => this.discard(),
        });
        this.save = button('保存提示词', {
            id: 'wb-prompt-save', kind: 'primary', onclick: () => workbench.run(() => this.apply()),
        });
        this.actions = element('div', { class: 'wb-action-row wb-prompt-actions' }, this.state,
            element('div', { class: 'wb-action-buttons' }, this.discardButton, this.save));
        this.reorderStatus = element('span', { class: 'wb-prompt-reorder-status', role: 'status', 'aria-live': 'polite' });
        const form = element('form', { class: 'wb-prompt-settings' },
            element('div', { class: 'wb-prompt-overview' },
                element('div', { class: 'wb-prompt-heading' },
                    element('div', { class: 'wb-field' }, element('h3', { text: task.label })), this.defaultsButton),
                element('p', { class: 'wb-help', text: task.description }),
                element('p', { class: 'wb-help', text: '按顺序发送已启用的条目。修改后点击保存生效。' })),
            this.problem, this.reorderStatus, element('div', { class: 'wb-prompt-grid' }, listPanel, editorPanel));
        form.addEventListener('submit', event => { event.preventDefault(); workbench.run(() => this.apply()); });
        this.viewport = form;
        this.view = element('section', { class: 'wb-feature-view wb-prompt-view', 'data-prompt-editor': 'false' },
            scrollRegion(form, 'wb-fill-scroll'));
        this.renderTask();
        this.update();
        this.reorder = new PromptReorderController({
            list: this.entryList, viewport: this.viewport,
            getIds: () => this.entries.map(entry => entry.id),
            canReorder: () => !this.locked && Boolean(this.entryList.getClientRects().length)
                && Boolean(this.workbench.root?.contains(this.entryList)) && this.workbench.sheets?.layer.hidden === true,
            onReorder: move => this.reorderEntry(move),
            onAnnounce: message => { this.reorderStatus.textContent = message; },
        });
    }

    selectEntry(id) {
        if (!this.entries.some(value => value.id === id)) return;
        this.reorder?.cancel();
        this.expandedEntryKey = '';
        const compact = this.compactLayout();
        if (compact && !this.mobileEditor) {
            this.listPagePositions.set(this.task, this.viewport.scrollTop);
            this.listPositions.set(this.task, this.entryList.scrollTop);
        } else if (compact && this.entry) {
            this.editorPagePositions.set(entryKey(this.task, this.entry.id), this.viewport.scrollTop);
        }
        this.rememberTextPosition();
        this.selected.set(this.task, id);
        this.mobileEditor = true;
        this.renderEntries();
        this.renderEditor();
        this.update();
        if (compact) this.viewport.scrollTop = this.editorPagePositions.get(entryKey(this.task, id)) || 0;
        this.restoreTextPosition();
        this.editorTitle.focus({ preventScroll: true });
    }

    returnToList() {
        this.reorder?.cancel();
        this.rememberTextPosition();
        if (this.entry && this.compactLayout()) {
            this.editorPagePositions.set(entryKey(this.task, this.entry.id), this.viewport.scrollTop);
        }
        this.mobileEditor = false;
        this.updateMobileView();
        if (this.compactLayout()) {
            this.viewport.scrollTop = this.listPagePositions.get(this.task) || 0;
            this.entryList.scrollTop = this.listPositions.get(this.task) || 0;
        }
        this.workbench.scrollbars?.refresh();
        (this.rows.get(entryKey(this.task, this.selected.get(this.task)))?.open || this.addButton)
            .focus({ preventScroll: true });
    }

    compactLayout() {
        return this.workbench.root?.dataset.compact === 'true'
            || Boolean(globalThis.matchMedia?.('(max-width: 760px)').matches);
    }

    updateMobileView() {
        if (!this.entry) this.mobileEditor = false;
        this.view.dataset.promptEditor = String(this.mobileEditor && Boolean(this.entry));
    }

    renderTask() {
        if (!this.entries.some(value => value.id === this.selected.get(this.task))) {
            this.selected.set(this.task, this.entries[0]?.id || '');
        }
        this.renderEntries();
        this.renderEditor();
    }

    createRow(task, id) {
        const order = element('span', { class: 'wb-prompt-entry-order', 'aria-hidden': true });
        const title = element('strong', { class: 'wb-prompt-entry-name' });
        const detail = element('small', { class: 'wb-prompt-entry-detail' });
        const drag = button('拖动调整条目顺序', {
            class: 'wb-icon-button wb-prompt-drag-handle', iconOnly: true, glyph: 'grip',
            'data-prompt-drag': '', title: '拖动排序；上下方向键也可调整位置',
        });
        const open = button('', {
            class: 'wb-prompt-select', 'aria-controls': 'wb-prompt-editor',
            onclick: () => { if (this.task === task) this.selectEntry(id); },
        });
        open.append(order, element('span', { class: 'wb-prompt-entry-main' }, title, detail));
        const toggle = button('', {
            class: 'wb-entry-toggle wb-prompt-toggle', role: 'switch',
            onclick: () => { if (this.task === task) this.toggleEntry(id); },
        });
        toggle.append(element('span', { class: 'wb-toggle-track', 'aria-hidden': true }));
        const menu = button('条目操作', {
            class: 'wb-icon-button wb-prompt-menu', iconOnly: true, glyph: 'more', 'aria-expanded': 'false',
            onclick: () => this.workbench.run(() => this.openEntryMenu(task, id)),
        });
        const actionButtons = ENTRY_ACTIONS.map(action => button(action.label, {
            glyph: action.glyph, 'data-tone': action.tone, 'data-prompt-action': action.id,
            onclick: () => this.workbench.run(() => this.executeEntryAction(task, id, action)),
        }));
        const actions = element('div', {
            id: `wb-prompt-entry-actions-${task}-${encodeURIComponent(id)}`,
            class: 'wb-prompt-entry-actions', role: 'group', hidden: true,
        }, actionButtons);
        menu.setAttribute('aria-controls', actions.id);
        const header = element('div', { class: 'wb-prompt-entry-header' }, drag, open, menu, toggle);
        const node = element('div', { class: 'wb-prompt-entry-row', 'data-prompt-entry-id': id }, header, actions);
        return { node, open, drag, toggle, menu, actions, actionButtons, order, title, detail };
    }

    renderEntries() {
        if (!this.entries.some(entry => entryKey(this.task, entry.id) === this.expandedEntryKey)) {
            this.expandedEntryKey = '';
        }
        const nodes = [];
        this.entries.forEach((entry, index) => {
            const key = entryKey(this.task, entry.id);
            let row = this.rows.get(key);
            if (!row) {
                row = this.createRow(this.task, entry.id);
                this.rows.set(key, row);
            }
            const selected = entry.id === this.selected.get(this.task);
            const name = entry.name.trim() || '未命名提示词';
            row.order.textContent = String(index + 1);
            row.title.textContent = name;
            row.detail.textContent = `${roleLabel(entry.role)}，${entry.enabled ? '已启用' : '已关闭'}`;
            row.node.dataset.selected = String(selected);
            row.node.dataset.enabled = String(entry.enabled);
            row.open.setAttribute('aria-pressed', String(selected));
            row.toggle.setAttribute('aria-label', `${name}的启用开关`);
            row.toggle.setAttribute('aria-checked', String(entry.enabled));
            row.toggle.disabled = this.locked;
            row.menu.setAttribute('aria-label', `${name}的更多操作`);
            row.menu.disabled = this.locked;
            const expanded = this.expandedEntryKey === key;
            row.menu.setAttribute('aria-expanded', String(expanded));
            row.actions.hidden = !expanded;
            row.actions.setAttribute('aria-label', `${name}的操作`);
            for (const control of row.actionButtons) control.disabled = this.locked;
            row.drag.setAttribute('aria-label', `拖动调整${name}的位置；也可使用上下方向键`);
            row.drag.disabled = this.locked || this.entries.length < 2;
            nodes.push(row.node);
        });
        const valid = new Set(PROMPT_TASKS.flatMap(task => this.draft[task.id].map(entry => entryKey(task.id, entry.id))));
        for (const [key, row] of this.rows) {
            if (!valid.has(key)) { row.node.remove(); this.rows.delete(key); }
        }
        const signature = JSON.stringify([this.task, this.entries.map(entry => entry.id)]);
        if (signature !== this.listSignature) {
            this.reorder?.cancel();
            const scrollTop = this.renderedTask === this.task ? this.entryList.scrollTop : this.listPositions.get(this.task) || 0;
            this.entryList.replaceChildren(...(nodes.length ? nodes : [
                element('p', { class: 'wb-help wb-prompt-list-empty', text: '当前任务还没有条目。' }),
            ]));
            this.entryList.scrollTop = scrollTop;
            this.listSignature = signature;
            this.renderedTask = this.task;
        }
        this.entryCount.textContent = `共 ${this.entries.length} 条，启用 ${this.entries.filter(entry => entry.enabled).length} 条`;
    }

    renderEditor() {
        const entry = this.entry;
        if (this.editingEntry === entry && this.editingTask === this.task) return;
        this.rememberTextPosition();
        this.editingEntry = entry;
        this.editingTask = this.task;
        this.name.value = entry?.name || '';
        this.role.value = entry?.role || 'system';
        this.content.value = entry?.content || '';
        this.editorEmpty.hidden = Boolean(entry);
        this.editorFields.hidden = !entry;
        if (entry) this.restoreTextPosition();
    }

    changed() {
        this.problem.hidden = true;
        this.update();
    }

    update() {
        const saved = this.savedSettings();
        if (!this.dirty && !sameValue(saved, this.baseline)) {
            this.reorder?.cancel();
            this.rememberTextPosition();
            this.baseline = saved;
            this.draft = clone(saved);
            this.renderTask();
        }
        const entry = this.entry;
        const locked = this.locked;
        if (locked) this.reorder?.cancel();
        for (const control of [this.name, this.role, this.content]) {
            control.disabled = locked || !entry;
        }
        this.addButton.disabled = locked;
        this.defaultsButton.disabled = locked;
        this.insertMacroButton.disabled = locked || !entry;
        this.save.disabled = locked || !this.dirty;
        this.discardButton.disabled = locked || !this.dirty;
        this.state.textContent = this.dirty ? '有未保存的提示词' : '已保存';
        this.state.dataset.dirty = String(this.dirty);
        this.updateMobileView();
        this.renderEntries();
        this.workbench.scrollbars?.refresh();
    }

    addEntry() {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        this.reorder?.cancel();
        this.expandedEntryKey = '';
        if (this.compactLayout() && !this.mobileEditor) {
            this.listPagePositions.set(this.task, this.viewport.scrollTop);
            this.listPositions.set(this.task, this.entryList.scrollTop);
        }
        this.rememberTextPosition();
        let index = 1;
        while (this.entries.some(entry => entry.name === `提示词 ${index}`)) index++;
        const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const entry = { id: `${this.task}-entry-${random}`, name: `提示词 ${index}`, role: 'system', enabled: true, content: '' };
        this.entries.push(entry);
        this.selected.set(this.task, entry.id);
        this.mobileEditor = true;
        this.renderTask();
        this.changed();
        if (this.compactLayout()) this.viewport.scrollTop = 0;
        this.name.focus({ preventScroll: true });
        this.name.select();
    }

    toggleEntry(id) {
        const entry = this.entries.find(value => value.id === id);
        if (!entry || this.locked) return;
        entry.enabled = !entry.enabled;
        this.changed();
    }

    reorderEntry({ id, beforeId }) {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        const index = this.entries.findIndex(entry => entry.id === id);
        if (index < 0 || beforeId === id) return;
        const others = this.entries.filter(entry => entry.id !== id);
        const next = beforeId == null ? others.length : others.findIndex(entry => entry.id === beforeId);
        if (next < 0 || next === index) return;
        const [entry] = this.entries.splice(index, 1);
        this.entries.splice(next, 0, entry);
        this.renderEntries();
        this.changed();
        this.rows.get(entryKey(this.task, id))?.drag.focus({ preventScroll: true });
    }

    openEntryMenu(task, id) {
        const entry = this.draft[task]?.find(value => value.id === id);
        if (!entry || task !== this.task) return;
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        this.reorder?.cancel();
        this.rememberTextPosition();
        const key = entryKey(task, id);
        this.expandedEntryKey = this.expandedEntryKey === key ? '' : key;
        this.renderEntries();
        if (this.expandedEntryKey) {
            this.rows.get(key)?.actions.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
        this.workbench.scrollbars?.refresh();
    }

    closeEntryActions({ focus = false } = {}) {
        const key = this.expandedEntryKey;
        if (!key) return;
        this.reorder?.cancel();
        this.expandedEntryKey = '';
        this.renderEntries();
        this.workbench.scrollbars?.refresh();
        if (focus) this.rows.get(key)?.menu.focus({ preventScroll: true });
    }

    executeEntryAction(task, id, action) {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        const entry = this.draft[task]?.find(value => value.id === id);
        if (!entry || this.task !== task) return;
        this.reorder?.cancel();
        return action.run(this, task, entry);
    }

    removeEntry(task, id, expectedEntry) {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        const entry = this.draft[task]?.find(value => value.id === id);
        if (this.task !== task || entry !== expectedEntry) throw new Error('提示词条目已变化，请重新展开操作。');
        this.reorder?.cancel();
        this.rememberTextPosition();
        this.expandedEntryKey = '';
        const index = this.entries.indexOf(entry);
        if (index < 0) return;
        const selected = this.selected.get(task) === id;
        this.entries.splice(index, 1);
        this.textPositions.delete(entryKey(task, entry.id));
        this.editorPagePositions.delete(entryKey(task, entry.id));
        if (selected) this.selected.set(task, this.entries[index]?.id || this.entries[index - 1]?.id || '');
        if (this.compactLayout()) this.mobileEditor = false;
        this.renderTask();
        this.changed();
        if (this.compactLayout()) {
            this.viewport.scrollTop = this.listPagePositions.get(task) || 0;
            this.entryList.scrollTop = this.listPositions.get(task) || 0;
        }
        (this.rows.get(entryKey(task, this.selected.get(task)))?.open || this.addButton).focus({ preventScroll: true });
    }

    async restoreDefaults() {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        this.reorder?.cancel();
        this.closeEntryActions();
        this.rememberTextPosition();
        const task = this.task;
        const choice = await this.workbench.sheets.choose(`恢复“${taskLabel(task)}”的默认提示词？`,
            element('p', { class: 'wb-help', text: '会替换全部筛选提示词条目。点击保存后生效。' }),
            [{ label: '保留当前内容', value: 'cancel' }, { label: '恢复默认', value: 'restore', kind: 'primary' }]);
        if (choice !== 'restore' || this.locked || this.task !== task) return;
        this.draft[task] = defaultPromptEntries(task);
        this.selected.set(task, this.entries[0]?.id || '');
        this.renderTask();
        this.changed();
    }

    rememberTextPosition() {
        if (!this.editingEntry || !this.content?.getClientRects().length
            || !this.draft[this.editingTask]?.includes(this.editingEntry)) return;
        this.textPositions.set(entryKey(this.editingTask, this.editingEntry.id), {
            start: this.content.selectionStart,
            end: this.content.selectionEnd,
            direction: this.content.selectionDirection,
            scrollTop: this.content.scrollTop,
        });
    }

    restoreTextPosition() {
        if (!this.entry || !this.content.getClientRects().length) return;
        const position = this.textPositions.get(entryKey(this.task, this.entry.id));
        if (!position) return;
        const length = this.content.value.length;
        this.content.setSelectionRange(Math.min(position.start, length), Math.min(position.end, length), position.direction);
        this.content.scrollTop = position.scrollTop;
    }

    openMacroPicker() {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        const entry = this.entry;
        if (!entry) return;
        this.reorder?.cancel();
        this.closeEntryActions();
        this.rememberTextPosition();
        const position = this.textPositions.get(entryKey(this.task, entry.id));
        const target = {
            task: this.task, id: entry.id, entry, value: this.content.value,
            position: position ? { ...position } : {
                start: this.content.selectionStart, end: this.content.selectionEnd,
                direction: this.content.selectionDirection, scrollTop: this.content.scrollTop,
            },
        };
        const macros = PROMPT_MACROS.filter(value => value.tasks.includes(target.task));
        const list = element('div', { class: 'wb-prompt-macro-list', role: 'group', 'aria-label': '选择要插入的宏' },
            macros.map(macro => button('', {
                class: 'wb-prompt-macro-option',
                onclick: () => this.workbench.run(() => {
                    this.workbench.sheets.close();
                    this.insertMacro(macro.token, target);
                }),
            })));
        [...list.children].forEach((row, index) => {
            const macro = macros[index];
            row.append(element('strong', { text: macro.label }), element('code', { text: macro.token }),
                element('p', { class: 'wb-help', text: macro.description }));
        });
        this.workbench.sheets.open('插入宏', list);
    }

    insertMacro(token, target) {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        const entry = this.draft[target.task]?.find(value => value.id === target.id);
        if (this.task !== target.task || entry !== target.entry || this.entry !== entry
            || this.content.value !== target.value) {
            throw new Error('正在编辑的提示词已变化，请重新选择要插入的宏。');
        }
        const macro = PROMPT_MACROS.find(value => value.token === token && value.tasks.includes(target.task));
        if (!macro) return;
        const length = this.content.value.length;
        const start = Math.min(Math.max(0, target.position.start), length);
        const end = Math.min(Math.max(start, target.position.end), length);
        this.content.focus({ preventScroll: true });
        this.content.setRangeText(macro.token, start, end, 'end');
        this.content.scrollTop = target.position.scrollTop;
        entry.content = this.content.value;
        this.rememberTextPosition();
        this.changed();
    }

    openHelp() {
        this.reorder?.cancel();
        this.closeEntryActions();
        this.rememberTextPosition();
        const table = element('table', { class: 'wb-prompt-macro-table' },
            element('thead', {}, element('tr', {},
                ...['宏', '名称', '用途', '格式'].map(text => element('th', { scope: 'col', text })))),
            element('tbody', {}, PROMPT_MACROS.map(macro => element('tr', {},
                element('td', {}, element('code', { text: macro.token })),
                element('td', { text: macro.label }),
                element('td', { text: macro.description }),
                element('td', { text: macro.format })))));
        const help = element('div', { class: 'wb-prompt-help-content' },
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '条目顺序与消息身份' }),
                element('p', { text: '启用的条目按列表顺序发送。默认用 System 提供筛选职责、JSON 输出协议和数量预算，用 User 提供候选目录与聊天资料。资料不是指令；修改消息身份不会改变数据范围和返回校验。部分模型接口会按自身要求转换消息身份。' }),
                element('p', { text: '这些提示词用于试运行和生成前调度，不用于编写正文，也不影响世界书库的 AI 整理。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '宏如何使用' }),
                element('p', { text: '在提示词正文中放置光标或选中文字，点击“插入宏”，也可以直接输入表中的完整宏名。聊天、目录说明或关键词里的宏字符串仅作为资料发送，不会再次展开。' }),
                element('p', { text: '{{echo_recent_chat}} 提供最近 AI 消息全文。{{echo_latest_user_message}} 独立提供最新已发送用户发言，没有发言时为 null，不占 AI 楼层，也不读取草稿。{{echo_candidate_entries}} 不含世界书正文。' }),
                element('p', { text: 'JSON 宏可单独放在一行，不要再用引号包住。完整筛选输入 {{echo_selection_input}} 与分项宏并用会重复资料。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '筛选响应格式' }),
                element('p', { text: '返回一个只有 selected 的 JSON 对象。没有相关条目时返回空数组；入选条目按相关性排序，每项只填候选中逐字复制的完整 id、非空的简短 reason。不重复 ID、不选择蓝灯或固定绿灯，不添加其他字段、代码围栏、额外解释或正文。' }),
                element('pre', {}, element('code', { text: '{"selected":[{"id":"候选条目的完整原始 ID","reason":"与当前行动涉及的地点限制直接相关"}]}' })),
                element('p', { text: '不得超过剩余可选条目数。程序按入选条目的原文估算 Token，在剩余预算内纳入。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '旧模板升级' }),
                element('p', { text: '旧版调度提示词的输入与返回格式不再兼容，升级时会换为新的筛选默认模板。此后可继续编辑、关闭、删除或调整条目顺序；常规加载不会补回被删除的条目。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '可用宏' }),
                element('div', { class: 'wb-prompt-table-scroll' }, table)));
        this.workbench.sheets.open('宏与提示词说明', help);
    }

    apply() {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        this.reorder?.cancel();
        let templates;
        try { templates = validatePromptTemplates(this.draft); }
        catch (error) {
            this.problem.textContent = error.message;
            this.problem.hidden = false;
            throw error;
        }
        this.expandedEntryKey = '';
        this.rememberTextPosition();
        this.director.updateSettings({ promptTemplates: templates });
        this.baseline = this.savedSettings();
        this.draft = clone(this.baseline);
        this.problem.hidden = true;
        this.renderTask();
        this.update();
        this.workbench.notify('提示词设置已保存。');
        return true;
    }

    discard() {
        this.reorder?.cancel();
        this.expandedEntryKey = '';
        this.rememberTextPosition();
        this.baseline = this.savedSettings();
        this.draft = clone(this.baseline);
        this.problem.hidden = true;
        this.renderTask();
        this.update();
    }

    rememberPosition() {
        this.reorder?.cancel();
        this.closeEntryActions();
        if (!this.viewport.isConnected) return;
        this.scrollTop = this.viewport.scrollTop;
        if (this.entryList.getClientRects().length) this.listPositions.set(this.task, this.entryList.scrollTop);
        if (this.compactLayout()) {
            if (this.mobileEditor && this.entry) {
                this.editorPagePositions.set(entryKey(this.task, this.entry.id), this.viewport.scrollTop);
            } else this.listPagePositions.set(this.task, this.viewport.scrollTop);
        }
        this.rememberTextPosition();
    }

    restorePosition() {
        cancelAnimationFrame(this.restoreFrame);
        this.restoreFrame = requestAnimationFrame(() => {
            if (!this.workbench.root?.contains(this.viewport)) return;
            this.updateMobileView();
            this.viewport.scrollTop = this.scrollTop;
            if (this.entryList.getClientRects().length) this.entryList.scrollTop = this.listPositions.get(this.task) || 0;
            this.restoreTextPosition();
        });
    }

    dispose() {
        this.reorder?.cancel();
        this.closeEntryActions();
        cancelAnimationFrame(this.restoreFrame);
    }
}
