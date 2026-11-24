import { element, button } from './workbench-utils.js';
import { scrollRegion } from './workbench-scroll.js';
import { clone, sameValue } from './workbench-state.js';
import { PromptReorderController } from './prompt-reorder.js';
import {
    PROMPT_TASKS, PROMPT_ROLES, PROMPT_MACROS,
    normalizePromptTemplates, defaultPromptEntries, validatePromptTemplates,
} from './prompt-templates.js';

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
        this.taskSelect = element('select', { id: 'wb-prompt-task', 'aria-label': '当前提示词任务' },
            PROMPT_TASKS.map(task => element('option', { value: task.id, text: task.label })));
        this.taskSelect.addEventListener('change', () => this.selectTask(this.taskSelect.value));
        this.taskNote = element('p', { class: 'wb-help' });
        this.helpButton = button('宏与提示词说明', {
            id: 'wb-prompt-help', iconOnly: true, glyph: 'help',
            onclick: () => this.openHelp(),
        });
        this.addButton = button('新增条目', {
            id: 'wb-prompt-add', glyph: 'plus', onclick: () => workbench.run(() => this.addEntry()),
        });
        this.defaultsButton = button('恢复本任务默认', {
            id: 'wb-prompt-defaults', onclick: () => workbench.run(() => this.restoreDefaults()),
        });
        this.entryCount = element('small', { class: 'wb-help' });
        this.entryList = element('div', {
            id: 'wb-prompt-list', class: 'wb-prompt-list', role: 'group', 'aria-label': '当前任务的提示词条目',
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
                    this.field(this.taskSelect, '当前任务'), this.defaultsButton),
                this.taskNote,
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

    selectTask(task) {
        if (!PROMPT_TASKS.some(value => value.id === task) || task === this.task) return;
        this.reorder?.cancel();
        this.expandedEntryKey = '';
        this.rememberTextPosition();
        if (this.entryList.getClientRects().length) this.listPositions.set(this.task, this.entryList.scrollTop);
        if (this.compactLayout() && !this.mobileEditor) this.listPagePositions.set(this.task, this.viewport.scrollTop);
        this.task = task;
        this.mobileEditor = false;
        this.renderTask();
        this.update();
        if (this.compactLayout()) this.viewport.scrollTop = this.listPagePositions.get(task) || 0;
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
        this.taskSelect.value = this.task;
        this.taskNote.textContent = PROMPT_TASKS.find(value => value.id === this.task)?.description || '';
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
            element('p', { class: 'wb-help', text: '会替换当前任务的全部条目；另一任务的草稿会保留。点击保存后生效。' }),
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
                ...['宏', '适用任务', '用途', '格式'].map(text => element('th', { scope: 'col', text })))),
            element('tbody', {}, PROMPT_MACROS.map(macro => element('tr', {},
                element('td', {}, element('code', { text: macro.token })),
                element('td', { text: macro.tasks.map(taskLabel).join('、') }),
                element('td', {}, element('strong', { text: macro.label }), element('p', { text: macro.description })),
                element('td', { text: macro.format })))));
        const help = element('div', { class: 'wb-prompt-help-content' },
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '条目顺序与消息身份' }),
                element('p', { text: '启用的条目按列表顺序提交。默认将“导演身份与职责”和“JSON 输出协议”分成两个独立条目。只有“最新已发送用户发言”使用 User，其余所有条目，包括最近 AI 回复和目录概括条目，均使用 System；已有模板首次加载时只迁移一次身份，不改变正文、开关或顺序，之后仍可编辑身份。所有输入资料都不能改变导演任务或输出协议，放在 System 资料条目中也不例外。部分原生模型接口会按自身要求转换消息身份。' }),
                element('p', { text: '“剧情导演与资料统筹”用于试选和生成前调度；“目录概括”只用于 AI 展示概括，两套提示词与响应协议独立。修改条目、开关或顺序后，点击“保存提示词”会一并保存两套提示词。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '导演与正文模型的分工' }),
                element('p', { text: '导演完整决定本轮唯一的剧情主方向、事件因果、节点顺序和收束位置，先接住用户已表达的行动，再在世界书与角色设定内适度主动推进有依据的新事件。正文模型执行隐藏方案，负责文风、对白、动作、心理和其他表达细节，不另开剧情分支，也不向用户展示提纲。' }),
                element('p', { text: '导演不能替用户角色作出尚未表达的决定，不能把世界书秘密当成角色已知。scene 只保存已经确认的事实，replyPlan 中尚未执行的事件不是场景记忆。generationType 为 continue 时，只接续当前 AI 回复，不重写开头或重复已完成节点。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '宏如何使用' }),
                element('p', { text: '在正文中放置光标或选中一段文字，点击正文右上角的“插入宏”按钮，再从弹出的列表选择宏。也可以直接输入表中的完整宏名。列表只显示当前任务可用的宏。' }),
                element('p', { text: '发送辅助请求时，宏会替换为本次数据，内容只展开一次。聊天、角色资料与世界书正文里的宏字符串会保留为原文，不会再次执行。' }),
                element('p', { text: 'recentChat 仍是按设置读取的 AI 消息全文数组。最新用户发言由 latestUserMessage 独立提供；{{echo_latest_user_message}} 读取其中的 text，没有发言时为空，不占 AI 楼层，也不读取未发送草稿。{{echo_character_context}} 提供角色描述、性格、场景、用户人设和角色深度提示。' }),
                element('p', { text: '文本宏提供原文，数字宏提供数值，JSON 宏提供完整对象或数组。JSON 宏可以单独放在一行，避免再用引号包住。完整导演输入 {{echo_selection_input}} 与分项宏同时使用时，会重复其中的资料。绿灯原文与 replyPlan 的 Token 预算分别约束；生成类型和方案预算都有独立宏。' })),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '必须保留的响应格式' }),
                element('p', { text: '导演只返回一个 JSON 对象，必须有 selected 数组和 replyPlan 对象。selected 可为 []；每项必须提供候选中的完整原始 id、非空 reason；scope 可省略（默认 turn），提供时为 turn 或 scene。蓝灯和已纳入的固定绿灯不重复选择。scene 可省略；如提供，只写已确认事实。' }),
                element('p', { text: 'replyPlan 的 direction、beats、constraints、ending、requiredEntryIds 全部必填。direction 和 ending 是非空字符串；beats 是 1～8 个非空字符串，按执行顺序排列；constraints 是 0～12 个非空字符串，可为 []；requiredEntryIds 是字符串数组，无必需世界书原文时可为 []。方案文字使用 replyPlanContentTokenBudget；replyPlanTokenBudget 约束整段深度 0 注入，包含固定指导与标记，也计入正文总上下文。超过时不截断，而是不采用方案。' }),
                element('p', { text: 'requiredEntryIds 只列支撑方案不可缺少的世界书原文 ID，来源限本轮 blueEntries、已经纳入的 fixedGreenEntries 或本次 selected。ID 必须逐字复制，不拆成数组、不缩短、不编造；不得引用未知、未入选或未纳入的绿灯。依赖候选原文时先选入该条目，不能把原文转述进方案作为替代；预算不足时缩小方案。示例 ID 只是占位，实际必须来自本轮输入。' }),
                element('pre', {}, element('code', { text: `{
  "scene": "已确认的当前场景",
  "selected": [{"id": "候选条目的完整原始 ID", "reason": "本轮事件因果与限制需要此原文", "scope": "scene"}],
  "replyPlan": {
    "direction": "接住用户行动，沿当前冲突推进一个有设定依据的新变化",
    "beats": ["其他角色依据已知信息回应用户已经表达的行动", "呈现有因果依据的新变化，给用户回应机会"],
    "constraints": ["不替用户作决定，不泄露角色尚未知晓的秘密，遵守所需世界书原文"],
    "ending": "停在变化已经明确、需要用户决定如何回应的位置",
    "requiredEntryIds": ["候选条目的完整原始 ID"]
  }
}` })),
                element('p', { text: '目录概括仍只返回包含 summaries 数组的 JSON 对象，每项提供输入中的原始 id 和目录说明 text，不需要 replyPlan。两种响应都不要添加代码围栏、解释或故事正文。' }),
                element('pre', {}, element('code', { text: '{"summaries":[{"id":"输入条目的原始 ID","text":"目录说明"}]}' }))),
            element('section', { class: 'wb-prompt-help-section' },
                element('h3', { text: '旧模板升级与自定义内容' }),
                element('p', { text: '兼容“最近聊天”版与“最近 AI 消息”版的旧默认文案：七个旧条目完整存在、旧规则正文未改写且保持已启用 System、尚无新版新增条目时，原位升级并加入独立 JSON 协议、角色约束和末尾用户发言；初始化时将识别到的升级保存到酒馆设置。未改写的旧任务条目补充生成类型与导演方案预算；已修改的任务或资料正文、名称、开关和原有相对顺序保留；消息身份按独立的一次性迁移处理，仅最新已发送用户发言为 User。' }),
                element('p', { text: '已改写、关闭或变更消息身份的旧规则，以及删过旧条目的模板，不会被自动覆盖或补全。新版新增条目删除或关闭后，常规整理不会重新加回或启用。自定义旧模板需自行移除“禁止安排剧情”等与导演职责相冲突的旧规则，补充必填 replyPlan 协议、最新用户发言、角色上下文、生成类型和方案预算；也可使用已有的“恢复本任务默认”，检查草稿后保存。' })),
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
