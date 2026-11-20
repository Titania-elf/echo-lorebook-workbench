import { MODULE, EXTENSION_FOLDER, entryId, sourceFingerprint } from './core.js';
import { contextKey } from './workbench-state.js';
import { element, button, icon, badge, assetUrl, entryTitle, displayText, errorView, SheetController } from './workbench-utils.js';
import { EntryEditor } from './entry-editor.js';
import { SchedulerUI } from './scheduler-ui.js';

const FILTERS = [
    ['all', '全部条目', '包括禁用和空正文条目'],
    ['actual', '最近激活', '最近生成中原生实际激活的托管条目'],
    ['pin', '本聊天固定', '手动固定，不改变原书触发方式'],
    ['exclude', '本聊天排除', '不等于原生禁用，失败回退时无效'],
    ['disabled', '已禁用', '原书禁用的条目仍可编辑'],
];

export class WorldbookWorkbench {
    constructor({ getContext, director, api, store, settings }) {
        Object.assign(this, { getContext, director, api, store, settings });
        this.root = null;
        this.popup = null;
        this.opening = null;
        this.books = [];
        this.currentBook = null;
        this.tab = 'entries';
        this.view = 'entries';
        this.query = '';
        this.filter = 'all';
        this.page = 0;
        this.pageSize = 50;
        this.listScroll = 0;
        this.request = 0;
        this.directoryRequest = 0;
        this.activeContext = contextKey(getContext());
        this.lastActual = new Set();
        this.textIndex = new WeakMap();
        this.guard = null;
        this.editor = null;
        this.scheduler = null;
        this.store.onChange = () => this.onStoreChange();
        this.unsubscribe = this.director.subscribe(() => this.onDirectorChange());
        this.unloadHandler = event => {
            if (!this.store.dirty && !this.store.session?.pending) return;
            event.preventDefault(); event.returnValue = '';
        };
        window.addEventListener('beforeunload', this.unloadHandler);
    }

    get nodes() {
        const get = name => this.root?.querySelector(`[data-wb="${name}"]`);
        return {
            header: get('header'), context: get('context'), contextName: get('context-name'), tabs: get('tabs'),
            view: get('view'), editorTop: get('editor-top'), actions: get('editor-actions'), footer: get('footer'), toast: get('toast'),
        };
    }

    bookInfo(name) { return this.books.find(book => book.name === name); }

    applyTheme() {
        const theme = this.settings.theme;
        for (const id of [MODULE, `${MODULE}-menu`, `${MODULE}-workbench`]) {
            const root = document.getElementById(id);
            if (root) root.dataset.theme = theme;
        }
        if (this.popup) this.popup.dlg.dataset.theme = theme;
    }

    notify(message, error = false) {
        if (!this.root) {
            if (error) globalThis.toastr?.error(String(message), '回声书台');
            return;
        }
        clearTimeout(this.toastTimer);
        const toast = this.nodes.toast;
        toast.replaceChildren(icon(error ? 'info' : 'check'), element('span', { text: message }));
        toast.dataset.state = error ? 'error' : 'success';
        toast.hidden = false;
        this.toastTimer = setTimeout(() => { if (this.root) this.nodes.toast.hidden = true; }, error ? 4500 : 2600);
    }

    async run(action) {
        try { return await action(); }
        catch (error) {
            if (error?.name !== 'AbortError') this.notify(error?.message || '操作未完成，请重新读取后重试。', true);
            return false;
        }
    }

    async open() {
        if (this.popup?.dlg?.open) { this.popup.dlg.focus(); return; }
        if (this.opening) return this.opening;
        if (this.store.session && !this.store.busy && !this.store.dirty && !this.store.session.pending) this.store.discard();
        const operation = this.openInternal().finally(() => { if (this.opening === operation) this.opening = null; });
        this.opening = operation;
        return operation;
    }

    async openInternal() {
        const context = this.getContext();
        const template = await context.renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`, 'workbench');
        const wrapper = document.createElement('div');
        // Only the extension-owned static template enters HTML parsing.
        wrapper.innerHTML = template;
        const root = wrapper.querySelector(`#${MODULE}-workbench`);
        if (!root) throw new Error('工作台模板未加载，请刷新酒馆后重试。');
        const popup = new context.Popup(root, context.POPUP_TYPE.DISPLAY, '', {
            wide: true, large: true, leftAlign: true, allowVerticalScrolling: false,
            onClosing: async () => {
                if (this.store.busy) { this.notify('原书保存尚未完成，请稍后关闭。'); return false; }
                return await this.guardDraft();
            },
        });
        popup.dlg.classList.add('echo-workbench-popup');
        this.popup = popup;
        this.root = root;
        this.view = 'loading'; this.editor = null; this.scheduler = null;
        this.readController = new AbortController();
        this.sheets = new SheetController(root);
        this.applyTheme();
        root.querySelector('[data-wb="brand"]').src = assetUrl('echo-mark.svg');
        root.querySelector('[data-wb="theme"]').append(icon('palette'));
        root.querySelector('[data-wb="close"]').append(icon('close'));
        root.querySelectorAll('[data-wb="sheet-close"]').forEach(control => { if (!control.classList.contains('wb-backdrop')) control.append(icon('close')); });
        root.querySelector('[data-wb="entries-tab"]').prepend(icon('book'));
        root.querySelector('[data-wb="scheduler-tab"]').prepend(icon('layers'));
        root.querySelector('[data-wb="theme"]').addEventListener('click', () => this.themeSheet());
        root.querySelector('[data-wb="close"]').addEventListener('click', () => this.run(() => popup.completeCancelled()));
        root.querySelector('[data-wb="entries-tab"]').addEventListener('click', () => this.run(() => this.setTab('entries')));
        root.querySelector('[data-wb="scheduler-tab"]').addEventListener('click', () => this.run(() => this.setTab('scheduler')));
        root.addEventListener('keydown', event => {
            // Native Popup treats Enter as a completion key; search/edit Enter must not close this app.
            if (event.key === 'Enter') {
                event.stopPropagation();
            }
            const tab = event.target.closest('[role="tab"]');
            if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const target = event.key === 'Home' ? 'entries' : event.key === 'End' ? 'scheduler' : this.tab === 'entries' ? 'scheduler' : 'entries';
            root.querySelector(`[data-wb="${target}-tab"]`).click();
            root.querySelector(`[data-wb="${target}-tab"]`).focus();
        });
        this.viewportHandler = () => this.applyViewport();
        window.visualViewport?.addEventListener('resize', this.viewportHandler);
        window.visualViewport?.addEventListener('scroll', this.viewportHandler);
        window.addEventListener('resize', this.viewportHandler);
        this.applyViewport();
        this.updateContextLabel();
        this.nodes.view.replaceChildren(element('div', { class: 'wb-empty' }, icon('book'), element('p', { text: '正在读取世界书库…' })));
        const closing = popup.show();
        closing.catch(error => { console.warn('[回声书台] 工作台弹窗未正常完成', error); })
            .finally(() => this.closeView(popup));
        const request = ++this.directoryRequest;
        try {
            const books = await this.api.books({ fresh: true, signal: this.readController.signal });
            if (!this.root || this.popup !== popup || request !== this.directoryRequest) return;
            this.books = books;
            this.activeContext = contextKey(this.getContext());
            if (this.store.session) {
                this.currentBook = this.store.session.book;
                this.renderEditor();
            } else {
                this.currentBook = books[0]?.name || null;
                this.query = ''; this.filter = 'all'; this.page = 0;
                if (this.currentBook) await this.selectBook(this.currentBook);
                else this.renderEntries();
            }
            this.captureActual();
        } catch (error) {
            if (!this.root || this.popup !== popup || error?.name === 'AbortError') return;
            this.nodes.view.replaceChildren(errorView(error.message, () => this.run(() => this.refreshLibrary())));
        }
    }

    applyViewport() {
        if (!this.popup) return;
        const viewport = window.visualViewport;
        const height = viewport?.height || window.innerHeight;
        this.popup.dlg.style.setProperty('--wb-viewport-height', `${Math.round(height)}px`);
        this.popup.dlg.style.setProperty('--wb-viewport-top', `${Math.round(viewport?.offsetTop || 0)}px`);
        this.editor?.resizeText(this.editor.textarea);
    }

    closeView(popup) {
        if (this.popup !== popup) return;
        ++this.request; ++this.directoryRequest;
        this.readController?.abort();
        clearTimeout(this.toastTimer); clearTimeout(this.searchTimer);
        window.visualViewport?.removeEventListener('resize', this.viewportHandler);
        window.visualViewport?.removeEventListener('scroll', this.viewportHandler);
        window.removeEventListener('resize', this.viewportHandler);
        this.sheets?.dispose();
        this.root = null; this.popup = null; this.editor = null; this.scheduler = null; this.opening = null;
        if (!this.store.busy && !this.store.dirty && !this.store.session?.pending && this.store.session) this.store.discard();
        // A forced host close still leaves the in-memory draft recoverable on the next open.
    }

    updateContextLabel() {
        if (!this.root) return;
        const context = this.getContext();
        const character = context.characterId != null ? context.characters?.[context.characterId] : null;
        this.nodes.contextName.textContent = context.chatId ? `当前聊天 · ${character?.name || (context.groupId ? '群聊' : context.chatId)}` : '未打开聊天 · 仍可编辑全部世界书';
    }

    async refreshLibrary() {
        if (this.store.busy) throw new Error('请等待保存完成。');
        const generation = ++this.directoryRequest;
        const books = await this.api.refreshDirectory();
        if (!this.root || generation !== this.directoryRequest) return;
        this.books = books;
        if (this.store.session) {
            if (!this.editor || this.view !== 'editor') this.renderEditor(); else this.editor.update();
            return;
        }
        if (!books.some(book => book.name === this.currentBook)) this.currentBook = books[0]?.name || null;
        if (this.currentBook) await this.selectBook(this.currentBook, { fresh: true });
        else this.renderEntries();
        this.notify('世界书库已刷新，没有调用模型。');
    }

    async selectBook(book, { fresh = false } = {}) {
        if (this.store.busy) throw new Error('请等待保存完成。');
        if (this.store.session && !(await this.guardDraft())) return;
        if (this.store.session) this.store.discard();
        const request = ++this.request;
        this.currentBook = book;
        this.query = ''; this.filter = 'all'; this.page = 0; this.listScroll = 0;
        this.view = 'entries'; this.tab = 'entries'; this.editor = null; this.scheduler = null;
        this.sheets?.close();
        this.setChrome(false); this.updateTabs();
        this.nodes.view.replaceChildren(element('div', { class: 'wb-empty' }, icon('book'), element('p', { text: '正在读取原世界书…' })));
        try {
            await this.store.loadBook(book, { fresh, signal: this.readController.signal });
            if (!this.root || request !== this.request) return;
            this.renderEntries();
        } catch (error) {
            if (!this.root || request !== this.request || error?.name === 'AbortError') return;
            this.setChrome(false);
            this.nodes.view.replaceChildren(errorView(error.message, () => this.run(() => this.refreshLibrary())),
                button('切换其他世界书', { glyph: 'book', onclick: () => this.bookPicker() }));
        }
    }

    setChrome(editor) {
        const nodes = this.nodes;
        nodes.header.hidden = editor; nodes.context.hidden = editor; nodes.tabs.hidden = editor;
        nodes.editorTop.hidden = !editor; nodes.actions.hidden = !editor; nodes.footer.hidden = editor;
        if (!editor) { nodes.editorTop.replaceChildren(); nodes.actions.replaceChildren(); }
    }

    async setTab(tab) {
        if (this.view === 'editor') return;
        if (tab === this.tab && ((tab === 'entries' && this.view === 'entries') || tab === 'scheduler')) return;
        if (this.view === 'entries') this.listScroll = this.nodes.view.scrollTop;
        this.tab = tab;
        if (tab === 'entries') this.renderEntries();
        else {
            this.view = 'scheduler'; this.editor = null; this.setChrome(false); this.updateTabs();
            this.scheduler = new SchedulerUI(this);
            this.nodes.view.replaceChildren(this.scheduler.view);
            this.nodes.view.scrollTop = 0;
        }
    }

    updateTabs() {
        if (!this.root) return;
        this.root.querySelector('[data-wb="entries-tab"]').setAttribute('aria-selected', String(this.tab === 'entries'));
        this.root.querySelector('[data-wb="scheduler-tab"]').setAttribute('aria-selected', String(this.tab === 'scheduler'));
        this.nodes.view.setAttribute('aria-labelledby', `wb-tab-${this.tab}`);
    }

    renderEntries() {
        if (!this.root) return;
        this.view = 'entries'; this.tab = 'entries'; this.editor = null; this.scheduler = null;
        this.setChrome(false); this.updateTabs(); this.updateContextLabel();
        const book = this.bookInfo(this.currentBook);
        this.bookNameNode = element('strong', { text: this.currentBook || '选择世界书' });
        this.bookSourceNode = element('small', { class: 'wb-option-meta', text: book?.source || '当前没有可用世界书' });
        this.bookButton = button('', { class: 'wb-book-button', onclick: () => this.bookPicker() });
        this.bookButton.append(icon('book'), element('span', { class: 'wb-option-main' }, this.bookNameNode, this.bookSourceNode), icon('down'));
        const search = element('input', {
            id: 'wb-entry-search', type: 'search', value: this.query,
            placeholder: '搜索这本书的标题、关键词或正文', 'aria-label': '搜索当前世界书条目', autocomplete: 'off',
        });
        this.clearSearch = button('清除搜索', { glyph: 'close', iconOnly: true, onclick: () => { search.value = ''; this.query = ''; this.page = 0; this.renderRows(); search.focus(); } });
        search.addEventListener('input', () => {
            this.query = search.value; this.page = 0;
            clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.renderRows(), 100);
        });
        this.filterButton = button(FILTERS.find(([value]) => value === this.filter)[1], { glyph: 'down', onclick: () => this.filterSheet() });
        const targetBook = this.currentBook;
        const create = button('新增', { glyph: 'plus', kind: 'primary', disabled: !targetBook, onclick: () => this.run(() => this.newEntry(targetBook)) });
        this.listCount = element('span');
        this.list = element('div', { class: 'wb-list' });
        this.pager = element('div', { class: 'wb-pagination' });
        const toolbar = element('div', { class: 'wb-toolbar' }, this.bookButton,
            element('div', { class: 'wb-search' }, icon('search'), search, this.clearSearch),
            element('div', { class: 'wb-filterbar' }, this.filterButton, create));
        this.nodes.view.replaceChildren(toolbar, element('div', { class: 'wb-list-heading' }, this.listCount, element('span', { class: 'wb-help', text: '当前打开的世界书' })), this.list, this.pager);
        this.renderRows(); this.nodes.view.scrollTop = this.listScroll;
    }

    recordMatches(record) {
        const entry = record.entry;
        const id = entryId({ world: this.currentBook, uid: record.key });
        const overrides = this.director.state().overrides;
        if (this.filter === 'actual' && !this.lastActual.has(id)) return false;
        if (this.filter === 'pin' && overrides[id] !== 'pin') return false;
        if (this.filter === 'exclude' && overrides[id] !== 'exclude') return false;
        if (this.filter === 'disabled' && !entry.disable) return false;
        const query = this.query.trim().toLocaleLowerCase();
        if (!query) return true;
        let text = this.textIndex.get(entry);
        if (text === undefined) {
            text = [entry.comment, Array.isArray(entry.key) ? entry.key.map(displayText).join(' ') : entry.key,
                Array.isArray(entry.keysecondary) ? entry.keysecondary.map(displayText).join(' ') : entry.keysecondary, entry.content].map(displayText).join(' ').toLocaleLowerCase();
            this.textIndex.set(entry, text);
        }
        return text.includes(query);
    }

    renderRows() {
        if (!this.root || this.view !== 'entries' || !this.list?.isConnected) return;
        const scroll = this.nodes.view.scrollTop;
        const all = this.store.entries(this.currentBook);
        const matches = all.filter(record => this.recordMatches(record));
        const pages = Math.max(1, Math.ceil(matches.length / this.pageSize));
        this.page = Math.min(this.page, pages - 1);
        this.listCount.textContent = `${matches.length} / ${all.length} 个条目`;
        this.clearSearch.hidden = !this.query;
        this.list.replaceChildren();
        if (!this.currentBook) {
            this.list.append(element('div', { class: 'wb-empty' }, icon('book'), element('strong', { text: '世界书库为空' }),
                element('p', { class: 'wb-help', text: '先在酒馆原生界面创建或导入世界书，再刷新这里的书库。' }),
                button('刷新书库', { glyph: 'refresh', onclick: () => this.run(() => this.refreshLibrary()) })));
        } else if (!matches.length) {
            this.list.append(element('div', { class: 'wb-empty' }, icon('search'), element('strong', { text: all.length ? '没有找到条目' : '这本书还没有条目' }),
                element('p', { class: 'wb-help', text: all.length ? '换一个关键词，或清除当前筛选。' : '点击新增，直接在当前书开始编辑。' }),
                all.length ? button('清除筛选', { onclick: () => { this.query = ''; this.filter = 'all'; this.page = 0; this.renderEntries(); } }) : null));
        }
        const overrides = this.director.state().overrides;
        for (const record of matches.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize)) {
            const entry = record.entry;
            const id = entryId({ world: this.currentBook, uid: record.key });
            const badges = [];
            if (!record.editable) badges.push(badge('格式异常'));
            if (entry.disable) badges.push(badge('禁用', 'ban'));
            if (overrides[id] === 'pin') badges.push(badge('本聊天固定', 'pin'));
            if (overrides[id] === 'exclude') badges.push(badge('本聊天排除', 'ban'));
            if (this.lastActual.has(id)) badges.push(badge('最近激活', 'check'));
            const rawExcerpt = displayText(entry.content).replace(/\s+/g, ' ').slice(0, 500);
            const content = element('span', { class: 'wb-entry-main' },
                element('span', { class: 'wb-entry-title' }, entryTitle(entry, record.key)),
                element('span', { class: 'wb-entry-meta' }, badge(`UID ${record.key}`), badges),
                element('span', { class: 'wb-excerpt', text: rawExcerpt || '空正文 · 仍可编辑，暂不参与调度目录' }));
            const book = this.currentBook;
            const row = button('', { class: 'wb-entry', onclick: () => record.editable ? this.run(() => this.openEntry(book, record.key, 'entries')) : this.rawEntry(record, book) });
            row.append(content, icon('chevron')); this.list.append(row);
        }
        this.pager.replaceChildren();
        if (pages > 1) {
            const previous = button('上一页', { disabled: this.page === 0, onclick: () => { this.page--; this.renderRows(); this.nodes.view.scrollTop = 0; } });
            const next = button('下一页', { disabled: this.page >= pages - 1, onclick: () => { this.page++; this.renderRows(); this.nodes.view.scrollTop = 0; } });
            this.pager.append(previous, element('span', { class: 'wb-help', text: `${this.page + 1} / ${pages}` }), next);
        }
        this.nodes.view.scrollTop = scroll;
    }

    bookPicker() {
        if (!this.root || this.store.busy) return;
        const search = element('input', { id: 'wb-library-search', type: 'search', placeholder: '搜索全部世界书', 'aria-label': '搜索全部世界书', autocomplete: 'off' });
        const list = element('div');
        const render = () => {
            const query = search.value.trim().toLocaleLowerCase();
            const matches = this.books.filter(book => `${book.name} ${book.displayName}`.toLocaleLowerCase().includes(query));
            list.replaceChildren();
            const appendGroup = (label, books) => {
                if (!books.length) return;
                list.append(element('p', { class: 'wb-book-group', text: label }));
                for (const book of books) {
                    const row = button('', { class: 'wb-option', 'aria-pressed': this.currentBook === book.name, onclick: () => this.run(() => this.selectBook(book.name)) });
                    row.append(icon('book'), element('span', { class: 'wb-option-main' }, element('strong', { text: book.name }),
                        element('small', { class: 'wb-option-meta', text: `${book.source}${book.managed ? ' · 已托管' : ''}` })), icon(this.currentBook === book.name ? 'check' : 'chevron'));
                    list.append(row);
                }
            };
            appendGroup('当前聊天优先 · 角色绑定与启用全局书', matches.filter(book => book.priority < 3));
            appendGroup('其他世界书', matches.filter(book => book.priority >= 3));
            if (!matches.length) list.append(element('div', { class: 'wb-empty' }, icon('search'), element('p', { text: '没有找到世界书。' })));
        };
        search.addEventListener('input', render);
        const refresh = button('刷新书库', { kind: 'text', glyph: 'refresh', onclick: () => this.run(async () => {
            this.books = await this.api.refreshDirectory(); render(); this.notify('书目已刷新，不会自动挂载。');
        }) });
        this.sheets.open('切换世界书', element('div', { class: 'wb-book-picker' },
            element('p', { class: 'wb-help', text: '可编辑全部酒馆世界书，未挂载的书也在这里。切换不改变挂载；新增直接作用当前打开的书。' }),
            element('div', { class: 'wb-search' }, icon('search'), search), list, refresh));
        render();
    }

    filterSheet() {
        const options = FILTERS.map(([value, label, hint]) => {
            const row = button('', { class: 'wb-option', 'aria-pressed': value === this.filter, onclick: () => {
                this.filter = value; this.page = 0; this.sheets.close(); this.renderEntries();
            } });
            row.append(icon(value === 'pin' ? 'pin' : value === 'exclude' || value === 'disabled' ? 'ban' : 'layers'),
                element('span', { class: 'wb-option-main' }, element('strong', { text: label }), element('small', { class: 'wb-option-meta', text: hint })), value === this.filter ? icon('check') : null);
            return row;
        });
        this.sheets.open('筛选条目', element('div', {}, options));
    }

    async openEntry(book, uid, returnTo = this.tab) {
        if (this.store.busy) throw new Error('请等待当前保存完成。');
        const request = ++this.request;
        const origin = contextKey(this.getContext());
        if (this.view === 'entries') this.listScroll = this.nodes.view.scrollTop;
        if (!this.store.loaded.has(book)) await this.store.loadBook(book, { signal: this.readController.signal });
        if (!this.root || request !== this.request) return;
        this.currentBook = book;
        this.editorReturn = returnTo;
        const session = this.store.begin(book, String(uid));
        session.context = origin;
        this.renderEditor();
    }

    rawEntry(record, book) {
        const input = element('textarea', { id: 'wb-raw-entry', readOnly: true, rows: 12, value: JSON.stringify(record.raw, null, 2) ?? String(record.raw) });
        this.sheets.open('原格式条目查看', element('div', { class: 'wb-field' },
            element('p', { class: 'wb-help', text: `${book} · ${record.key}：ID 或格式异常，提供只读原始数据，不覆盖保存。` }),
            element('label', { htmlFor: input.id, text: '原始条目数据' }), input));
    }

    newEntry(book = this.currentBook) {
        if (!book) throw new Error('先打开一本世界书。');
        this.currentBook = book;
        this.listScroll = this.nodes.view.scrollTop;
        this.editorReturn = 'entries';
        this.store.begin(book);
        this.renderEditor();
    }

    renderEditor() {
        if (!this.root || !this.store.session) return;
        this.view = 'editor'; this.scheduler = null;
        this.setChrome(true);
        try { this.editor = new EntryEditor(this); }
        catch (error) {
            this.editor = null; this.setChrome(false);
            this.nodes.view.replaceChildren(errorView(`条目表单无法显示：${error.message}`),
                button('返回条目列表', { onclick: () => this.run(() => this.leaveEditor()) }));
            return;
        }
        const header = this.editor.view.querySelector('.wb-editor-header');
        const source = this.editor.view.querySelector('.wb-editor-source');
        this.nodes.editorTop.replaceChildren(header, source);
        this.nodes.view.replaceChildren(this.editor.view);
        this.nodes.actions.replaceChildren(...this.editor.actions.childNodes);
        this.nodes.view.scrollTop = 0;
        if (this.store.session.isNew) requestAnimationFrame(() => { if (this.root && this.view === 'editor') this.root.querySelector('#wb-edit-comment')?.focus(); });
    }

    async saveEditor() {
        const session = this.store.session;
        const result = await this.store.save();
        if (result.unchanged) return true;
        if (result.deleted) {
            this.currentBook = session.book;
            this.page = 0; this.query = ''; this.filter = 'all';
            this.renderEntries();
            this.notify(result.warning || `已确认从《${session.book}》删除条目。`);
        } else {
            this.editor?.syncValues(); this.editor?.update();
            this.notify(result.warning || `已保存到《${session.book}》原书，下次调度使用已保存内容。`);
        }
        return true;
    }

    async guardDraft() {
        if (this.store.busy) return false;
        if (!this.store.dirty && !this.store.session?.pending) return true;
        if (this.guard) return this.guard;
        this.guard = (async () => {
            const pending = this.store.session?.pending;
            const title = pending ? '上次操作结果待确认' : '有未保存的修改';
            const hint = pending ? '会先读取原书确认上次结果，再决定是否重试。直接离开不能撤销可能已经完成的写入。' : '保存会直接修改原世界书。你可以保存、放弃这次草稿，或继续编辑。';
            const choice = await this.sheets.choose(title,
                element('p', { class: 'wb-help', text: hint }),
                [{ label: pending?.kind === 'delete' ? '重试删除并继续' : pending ? '重试保存并继续' : '保存并继续', value: 'save', kind: 'primary' },
                    { label: pending ? '离开，不继续操作' : '放弃草稿', value: 'discard' }, { label: '保持此页', value: 'cancel', kind: 'text' }]);
            if (choice === 'save') {
                try { return await this.saveEditor(); }
                catch (error) { this.notify(error.message, true); return false; }
            }
            if (choice === 'discard') { this.store.discard(); return true; }
            return false;
        })().finally(() => { this.guard = null; });
        return this.guard;
    }

    async leaveEditor() {
        const pendingBook = this.store.session?.pending ? this.store.session.book : null;
        if (!(await this.guardDraft())) return;
        if (this.store.session) this.store.discard();
        const target = this.editorReturn || 'entries';
        this.view = 'entries'; this.tab = 'entries';
        if (pendingBook) await this.selectBook(pendingBook, { fresh: true });
        if (target === 'scheduler') await this.setTab('scheduler'); else if (!pendingBook) this.renderEntries();
    }

    async reloadEditorSource() {
        const session = this.store.session;
        if (!session || this.store.busy) return;
        const choice = await this.sheets.choose('重新读取原书？',
            element('p', { class: 'wb-help', text: '未保存的草稿会被放弃。若上次保存结果不确定，这里显示服务端当前版本，不重复新增。' }),
            [{ label: '取消', value: 'cancel' }, { label: '放弃草稿并读取', value: 'reload', kind: 'primary' }]);
        if (choice !== 'reload') return;
        const uid = session.pending?.uid ?? session.uid;
        await this.store.loadBook(session.book, { fresh: true, signal: this.readController.signal });
        this.store.discard();
        if (uid != null && this.store.entries(session.book).some(record => record.key === String(uid) && record.editable)) {
            this.store.begin(session.book, uid); this.renderEditor();
        } else this.renderEntries();
        this.notify('已读取原书当前版本。');
    }

    entryMenu() {
        const session = this.store.session;
        if (!session) return;
        if (session.isNew) {
            this.sheets.open('新增条目', element('p', { class: 'wb-help', text: '先保存新增条目，再复制或从原书删除。' }));
            return;
        }
        const copy = button('', { class: 'wb-option', onclick: () => this.run(async () => {
            this.sheets.close();
            if (!(await this.guardDraft())) return;
            if (this.store.session) this.store.discard();
            this.store.begin(session.book, session.uid, { copy: true });
            this.renderEditor();
        }) });
        copy.append(icon('copy'), element('span', { class: 'wb-option-main' }, element('strong', { text: '复制为新条目' }), element('small', { class: 'wb-option-meta', text: '复制原生属性，不继承本聊天规则' })), icon('chevron'));
        const remove = button('', { class: 'wb-option', onclick: () => this.run(() => this.deleteEditorEntry()) });
        remove.append(icon('trash'), element('span', { class: 'wb-option-main' }, element('strong', { text: '从原书删除' }), element('small', { class: 'wb-option-meta', text: '影响所有使用原书的聊天，需要确认' })), icon('chevron'));
        this.sheets.open('条目操作', element('div', {}, copy, remove));
    }

    async deleteEditorEntry() {
        const session = this.store.session;
        if (!session || session.isNew) return;
        const title = entryTitle(session.baseline, session.uid);
        const choice = await this.sheets.choose('删除这个条目？',
            element('div', {}, element('strong', { text: title }), element('p', { class: 'wb-help', text: session.book }),
                element('p', { class: 'wb-help', text: '将从原世界书删除，其他聊天也受影响。当前未保存的修改一并放弃；这不是本聊天排除。' })),
            [{ label: '取消', value: 'cancel' }, { label: '确认删除', value: 'delete', kind: 'primary' }]);
        if (choice !== 'delete') return;
        const result = await this.store.remove();
        this.currentBook = session.book;
        this.page = 0; this.query = ''; this.filter = 'all'; this.listScroll = 0;
        this.renderEntries();
        this.notify(result.warning || `已从《${session.book}》原书删除条目。`);
    }

    parseIdentity(id) {
        try {
            const value = JSON.parse(id);
            if (Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string')) return { book: value[0], uid: value[1] };
        } catch { /* Invalid stale identities are never used as filenames. */ }
        return null;
    }

    attachOverride(host, book, uid, origin) {
        host.replaceChildren();
        if (uid == null) { host.append(element('p', { class: 'wb-help', text: '先保存新增条目，再设置本聊天规则。' })); return; }
        const segment = element('div', { class: 'wb-segment', 'aria-label': '本聊天调度规则' });
        for (const [value, label] of [['auto', '自动'], ['pin', '固定'], ['exclude', '排除']]) segment.append(button(label, {
            kind: 'text', 'data-mode': value, 'aria-pressed': false,
            onclick: () => this.run(() => {
                const id = entryId({ world: book, uid });
                const context = this.getContext();
                if (!context.chatId || origin !== this.director.chatKey(context)) throw new Error('聊天已变化，请在当前聊天重新打开条目后设置规则。');
                if (this.director.busy) throw new Error('先完成或取消当前辅助请求。');
                if (value !== 'auto' && !this.director.catalog.some(item => item.id === id)) throw new Error('条目尚未挂载、托管或启用，不能设置此调度规则。');
                this.director.setOverride(id, value);
                this.notify({ auto: '已恢复本聊天自动选择。', pin: '已设为本聊天固定，仍受预算限制。', exclude: '已设为本聊天排除，失败回退时无效。' }[value]);
            }),
        }));
        host.append(segment);
        this.updateOverride(host, book, uid, origin);
    }

    updateOverride(host, book, uid, origin) {
        if (uid == null) return;
        const id = entryId({ world: book, uid });
        const context = this.getContext();
        const mode = this.director.state().overrides[id] || 'auto';
        const eligible = this.director.catalog.some(item => item.id === id);
        const locked = !context.chatId || origin !== this.director.chatKey(context) || this.director.busy || this.store.busy;
        for (const control of host.querySelectorAll('[data-mode]')) {
            control.setAttribute('aria-pressed', String(control.dataset.mode === mode));
            control.disabled = locked || (!eligible && !(control.dataset.mode === 'auto' && mode !== 'auto'));
        }
    }

    entryDirectory(book, entry) {
        const id = entryId({ world: book, uid: entry.uid });
        const summary = this.director.config.summaries[id];
        if (summary?.fingerprint === sourceFingerprint(entry) && typeof summary.text === 'string' && summary.text.trim()) return { kind: 'AI 概括', text: summary.text.slice(0, 400) };
        return { kind: '本地摘录', text: displayText(entry.content).replace(/\s+/g, ' ').slice(0, 240) || '暂无正文' };
    }

    async summarize() {
        if (this.director.busy) throw new Error('先完成或取消当前辅助请求。');
        const choice = await this.sheets.choose('生成 AI 目录？',
            element('p', { class: 'wb-help', text: '会将新增或改动条目的原文发送给所选辅助模型，产生 API 用量。只生成选书目录，不改写世界书正文。' }),
            [{ label: '取消', value: 'cancel' }, { label: '调用 API 概括', value: 'summary', kind: 'primary' }]);
        if (choice === 'summary') await this.director.summarize();
    }

    async clearScene() {
        if (this.director.busy) throw new Error('先完成或取消当前辅助请求。');
        const choice = await this.sheets.choose('清空场景记忆？',
            element('p', { class: 'wb-help', text: '只清空本聊天场景工作集，不解除手动固定或排除。' }),
            [{ label: '取消', value: 'cancel' }, { label: '清空场景记忆', value: 'clear', kind: 'primary' }]);
        if (choice === 'clear') this.director.clearState();
    }

    themeSheet() {
        const list = element('div');
        for (const [value, label, hint] of [['tavern', '跟随酒馆', '继承酒馆实际配色，随主题变化'], ['light', '日间', '浅色正文，紫绿渐变强调'], ['dark', '夜间', '深色正文，柔和渐变强调']]) {
            const row = button('', { class: 'wb-option', 'aria-pressed': this.settings.theme === value, onclick: () => {
                this.settings.setTheme(value); this.applyTheme(); this.themeSheet();
            } });
            row.append(icon('palette'), element('span', { class: 'wb-option-main' }, element('strong', { text: label }), element('small', { class: 'wb-option-meta', text: hint })), this.settings.theme === value ? icon('check') : null);
            list.append(row);
        }
        const about = element('details', { class: 'wb-details' }, element('summary', {}, '关于回声书台与素材授权', icon('down')),
            element('div', { class: 'wb-details-body' },
                element('p', { class: 'wb-help', text: '回声系列原创 SVG 回环。世界书编辑保存原书；调度通过原生世界书扫描使用资料。' }),
                element('a', { href: assetUrl('OFL.txt'), target: '_blank', rel: 'noopener noreferrer', text: '圆体字体版权与 SIL OFL 1.1 许可' }),
                element('a', { href: assetUrl('icon-LICENSE.txt'), target: '_blank', rel: 'noopener noreferrer', text: 'Lucide / Feather 图标许可' })));
        this.sheets.open('主题与外观', element('div', {}, list, about));
    }

    captureActual() {
        const key = contextKey(this.getContext());
        if (key !== this.actualContext) { this.actualContext = key; this.lastActual.clear(); }
        const report = this.director.report;
        if (report?.mode === 'generation' && (!report.chatKey || report.chatKey === key)) this.lastActual = new Set(report.actual || []);
    }

    onDirectorChange() {
        this.captureActual();
        if (!this.root) return;
        this.updateContextLabel();
        this.editor?.update();
        this.scheduler?.update();
        if (this.view === 'entries') this.renderRows();
    }

    onStoreChange() {
        if (!this.root) return;
        if (this.view === 'editor') {
            if (this.store.session) this.editor?.update();
            else { this.editor = null; this.renderEntries(); }
        } else if (this.view === 'entries') this.renderRows();
    }

    onBookUpdated(book, data, metadata) {
        if (metadata?.source === MODULE) return;
        this.store.observeBook(book, data);
        if (this.root && this.store.loaded.has(book)) this.run(() => this.director.loadCatalog());
    }

    onBindingsChanged() {
        if (!this.root) return;
        this.run(async () => {
            this.books = await this.api.books();
            this.updateContextLabel();
            this.editor?.update(); this.scheduler?.update();
            if (this.view === 'entries') {
                const book = this.bookInfo(this.currentBook);
                if (this.bookSourceNode) this.bookSourceNode.textContent = book?.source || '未挂载到当前聊天';
            }
        });
    }

    onChatChanged() {
        this.actualContext = contextKey(this.getContext()); this.lastActual.clear();
        ++this.request; ++this.directoryRequest;
        if (!this.root) return;
        this.updateContextLabel();
        if (this.store.session) { this.editor?.update(); this.onBindingsChanged(); return; }
        this.run(async () => {
            const request = ++this.directoryRequest;
            const books = await this.api.books({ fresh: true, signal: this.readController.signal });
            if (!this.root || request !== this.directoryRequest) return;
            this.books = books;
            if (this.store.session) { this.editor?.update(); return; }
            this.currentBook = books[0]?.name || null;
            if (this.currentBook) await this.selectBook(this.currentBook); else this.renderEntries();
        });
    }
}
