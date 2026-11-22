import { MODULE, EXTENSION_FOLDER, entryId, sourceFingerprint } from './core.js';
import { contextKey } from './workbench-state.js';
import { element, button, icon, badge, assetUrl, entryTitle, displayText, errorView, SheetController } from './workbench-utils.js';
import { EntryEditor } from './entry-editor.js';
import { SchedulerUI } from './scheduler-ui.js';
import { APISettingsUI } from './api-settings-ui.js';
import { PromptSettingsUI } from './prompt-settings-ui.js';
import { SchedulerHistoryUI } from './scheduler-history-ui.js';
import { BookCategoryStore, bookCategories, entryCategory, categoryName, CATEGORY_ALL, CATEGORY_CONSTANT } from './book-categories.js';
import { WorkbenchScrollbars, scrollRegion } from './workbench-scroll.js';
import { copyText } from '../../../utils.js';
import { isMobile } from '../../../RossAscends-mods.js';

const FILTERS = [
    ['all', '全部状态'],
    ['enabled', '已启用'],
    ['disabled', '已禁用'],
    ['actual', '最近调度'],
    ['pin', '本聊天固定'],
    ['exclude', '本聊天排除'],
];
const PAGE_TITLES = {
    library: '世界书列表', entries: '条目列表', editor: '条目编辑',
    create: '新增条目', scheduler: '调度器', history: '调度历史',
    api: '调度器 API 设置', prompts: '提示词管理', loading: '正在读取',
};

export class WorldbookWorkbench {
    constructor({ getContext, director, api, store, settings, history = director.history }) {
        Object.assign(this, { getContext, director, api, store, settings, history });
        this.root = null;
        this.popup = null;
        this.opening = null;
        this.books = [];
        this.currentBook = null;
        this.tab = 'entries';
        this.view = 'library';
        this.workspaceView = 'library';
        this.libraryQuery = '';
        this.libraryFilter = 'all';
        this.libraryScroll = 0;
        this.query = '';
        this.filter = 'all';
        this.categoryFilter = CATEGORY_ALL;
        this.categoryScroll = 0;
        this.bookViews = new Map();
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
        this.apiSettings = null;
        this.promptSettings = null;
        this.historyUI = null;
        this.categories = new BookCategoryStore(store);
        this.desktopNavOpen = true;
        this.store.onChange = () => this.onStoreChange();
        this.unsubscribe = this.director.subscribe(() => this.onDirectorChange());
        this.unsubscribeHistory = this.history?.subscribe(() => {
            if (this.root) this.historyUI?.update();
        });
        this.unloadHandler = event => {
            if (!this.store.dirty && !this.store.session?.pending && !this.categories.pending
                && !this.scheduler?.dirty && !this.apiSettings?.dirty && !this.promptSettings?.dirty) return;
            event.preventDefault(); event.returnValue = '';
        };
        window.addEventListener('beforeunload', this.unloadHandler);
    }

    get nodes() {
        const get = name => this.root?.querySelector(`[data-wb="${name}"]`);
        return {
            header: get('header'), context: get('context'), contextName: get('context-name'), tabs: get('tabs'),
            sidebar: get('sidebar'), navToggle: get('nav-toggle'), backdrop: get('nav-backdrop'), title: get('page-title'),
            view: get('view'), editorTop: get('editor-top'), actions: get('editor-actions'), help: get('page-help'),
            footer: get('footer'), toast: get('toast'),
        };
    }

    bookInfo(name) { return this.books.find(book => book.name === name); }

    applyTheme() {
        const theme = this.settings.theme;
        if (this.root) this.root.dataset.theme = theme;
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
                return await this.guardDraft({ closing: true }) && await this.guardSettings();
            },
        });
        popup.dlg.classList.add('echo-workbench-popup');
        this.popup = popup;
        this.root = root;
        this.view = 'loading'; this.editor = null;
        this.tab = 'entries';
        this.workspaceView = this.store.session ? this.store.session.isNew ? 'create' : 'editor' : 'library';
        this.lastCompact = null;
        this.readController = new AbortController();
        this.sheets = new SheetController(root);
        this.scrollbars = new WorkbenchScrollbars(root);
        this.layoutHandler = () => this.syncNavigation();
        root.addEventListener('wb-layout', this.layoutHandler);
        this.applyTheme();
        root.querySelector('[data-wb="brand"]').src = assetUrl('echo-mark.svg');
        root.querySelector('[data-wb="theme"]').append(icon('palette'));
        root.querySelector('[data-wb="close"]').append(icon('close'));
        root.querySelectorAll('[data-wb="sheet-close"]').forEach(control => { if (!control.classList.contains('wb-backdrop')) control.append(icon('close')); });
        root.querySelector('[data-wb="entries-tab"]').prepend(icon('book'));
        root.querySelector('[data-wb="scheduler-tab"]').prepend(icon('layers'));
        root.querySelector('[data-wb="history-tab"]').prepend(icon('clock'));
        root.querySelector('[data-wb="api-tab"]').prepend(icon('sliders'));
        root.querySelector('[data-wb="prompts-tab"]').prepend(icon('message'));
        root.querySelector('[data-wb="nav-toggle"]').append(icon('menu'));
        root.querySelector('[data-wb="nav-close"]').prepend(icon('back'));
        root.querySelector('[data-wb="theme"]').addEventListener('click', () => this.themeSheet());
        root.querySelector('[data-wb="close"]').addEventListener('click', () => this.run(() => popup.completeCancelled()));
        root.querySelector('[data-wb="entries-tab"]').addEventListener('click', () => this.run(() => this.setTab('entries')));
        root.querySelector('[data-wb="scheduler-tab"]').addEventListener('click', () => this.run(() => this.setTab('scheduler')));
        root.querySelector('[data-wb="history-tab"]').addEventListener('click', () => this.run(() => this.setTab('history')));
        root.querySelector('[data-wb="api-tab"]').addEventListener('click', () => this.run(() => this.setTab('api')));
        root.querySelector('[data-wb="prompts-tab"]').addEventListener('click', () => this.run(() => this.setTab('prompts')));
        this.nodes.navToggle.addEventListener('click', () => this.setNavigation(!this.navOpen, true));
        root.querySelector('[data-wb="nav-close"]').addEventListener('click', () => this.setNavigation(false, true));
        this.nodes.backdrop.addEventListener('click', () => this.setNavigation(false, true));
        root.addEventListener('keydown', event => {
            // Native Popup treats Enter as a completion key; search/edit Enter must not close this app.
            if (event.key === 'Enter') {
                event.stopPropagation();
            }
            if (!this.sheets.layer.hidden) return;
            if (event.key === 'Escape' && this.compact && this.navOpen) {
                event.preventDefault(); event.stopPropagation(); this.setNavigation(false, true); return;
            }
            if (event.key === 'Tab' && this.compact && this.navOpen) {
                const controls = [...this.nodes.sidebar.querySelectorAll('button:not([disabled])')].filter(control => control.getClientRects().length);
                if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
                else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
            }
            const navigation = event.target.closest('.wb-nav-item');
            if (!navigation || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const controls = [...this.nodes.tabs.querySelectorAll('.wb-nav-item')];
            const index = controls.indexOf(navigation);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
            controls[next]?.focus();
        });
        this.viewportHandler = () => this.applyViewport();
        window.visualViewport?.addEventListener('resize', this.viewportHandler);
        window.visualViewport?.addEventListener('scroll', this.viewportHandler);
        window.addEventListener('resize', this.viewportHandler);
        this.resizeObserver = new ResizeObserver(() => this.applyViewport());
        this.resizeObserver.observe(root);
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
            this.scheduler?.refreshBooks();
            if (this.tab === 'entries') {
                if (this.store.session && ['editor', 'create'].includes(this.workspaceView)) this.renderEditor();
                else if (this.workspaceView === 'library') this.renderLibrary();
            }
            this.captureActual();
        } catch (error) {
            if (!this.root || this.popup !== popup || request !== this.directoryRequest || error?.name === 'AbortError') return;
            if (this.tab === 'entries' && this.view === 'loading') this.showReadError(error.message, () => this.run(() => this.refreshLibrary()));
            else this.notify(error.message, true);
        }
    }

    applyViewport() {
        if (!this.popup || !this.root) return;
        const viewport = window.visualViewport;
        const width = viewport?.width || window.innerWidth;
        const height = viewport?.height || window.innerHeight;
        this.popup.dlg.style.setProperty('--wb-viewport-width', `${width}px`);
        this.popup.dlg.style.setProperty('--wb-viewport-height', `${height}px`);
        this.popup.dlg.style.setProperty('--wb-viewport-left', `${viewport?.offsetLeft || 0}px`);
        this.popup.dlg.style.setProperty('--wb-viewport-top', `${viewport?.offsetTop || 0}px`);
        // Native mobile detection also covers phones in landscape.
        const fullscreen = isMobile() || window.innerWidth <= 700;
        this.popup.dlg.dataset.wbFullscreen = String(fullscreen);
        this.root.dataset.fullscreen = String(fullscreen);
        const compact = fullscreen || (this.root.clientWidth || width) <= 700;
        this.compact = compact;
        if (compact !== this.lastCompact) {
            this.lastCompact = compact;
            this.navOpen = compact ? false : this.desktopNavOpen;
        }
        this.syncNavigation();
        this.editor?.resizeText(this.editor.textarea);
        this.scrollbars?.refresh();
    }

    setNavigation(open, moveFocus = false) {
        if (!this.root || !this.sheets.layer.hidden) return;
        this.navOpen = Boolean(open);
        if (!this.compact) this.desktopNavOpen = this.navOpen;
        this.syncNavigation();
        if (moveFocus && this.compact && open) this.nodes.tabs.querySelector('[aria-current="page"]')?.focus();
        else if (moveFocus && !open) this.nodes.navToggle.focus({ preventScroll: true });
        this.scrollbars?.refresh();
    }

    syncNavigation() {
        if (!this.root) return;
        this.root.dataset.compact = String(this.compact);
        this.root.dataset.nav = this.navOpen ? 'open' : 'closed';
        this.nodes.navToggle.setAttribute('aria-expanded', String(this.navOpen));
        // A sheet owns the inert state until it closes.
        if (!this.sheets?.layer.hidden) return;
        this.nodes.sidebar.inert = !this.navOpen;
        this.nodes.sidebar.setAttribute('aria-hidden', String(!this.navOpen));
        const modal = this.compact && this.navOpen;
        this.root.querySelector('.wb-page').inert = modal;
        this.nodes.backdrop.hidden = !modal;
        this.nodes.backdrop.inert = false;
    }

    closeView(popup) {
        if (this.popup !== popup) return;
        ++this.request; ++this.directoryRequest;
        this.readController?.abort();
        clearTimeout(this.toastTimer); clearTimeout(this.searchTimer);
        window.visualViewport?.removeEventListener('resize', this.viewportHandler);
        window.visualViewport?.removeEventListener('scroll', this.viewportHandler);
        window.removeEventListener('resize', this.viewportHandler);
        this.resizeObserver?.disconnect();
        this.sheets?.dispose();
        this.editor?.dispose();
        this.apiSettings?.cancelModelFetch();
        this.promptSettings?.dispose();
        this.historyUI?.dispose();
        this.scrollbars?.dispose();
        this.root.removeEventListener('wb-layout', this.layoutHandler);
        this.root = null; this.popup = null; this.editor = null; this.opening = null;
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
        if (this.view === 'entries' && this.currentBook && books.some(book => book.name === this.currentBook)) {
            await this.selectBook(this.currentBook, { fresh: true });
        } else if (this.tab === 'entries' && !['editor', 'create'].includes(this.view)) this.renderLibrary();
        this.editor?.update(); this.scheduler?.refreshBooks();
        this.notify('世界书库已刷新，没有调用模型。');
    }

    async selectBook(book, { fresh = false } = {}) {
        if (this.store.busy) throw new Error('请等待保存完成。');
        this.rememberView();
        const request = ++this.request;
        this.useBook(book);
        this.workspaceView = 'entries'; this.tab = 'entries';
        this.sheets?.close();
        this.mountPage('loading', element('div', { class: 'wb-empty' }, icon('book'), element('p', { text: '正在读取原世界书…' })));
        try {
            const data = await this.store.loadBook(book, { fresh, signal: this.readController.signal });
            if (!this.root || request !== this.request) return;
            if (fresh) this.store.observeBook(book, data);
            if (this.tab === 'entries' && this.workspaceView === 'entries' && this.currentBook === book) this.renderEntries();
        } catch (error) {
            if (!this.root || request !== this.request || error?.name === 'AbortError') return;
            if (this.tab === 'entries' && this.workspaceView === 'entries' && this.currentBook === book) {
                this.showReadError(error.message, () => this.run(() => this.selectBook(book, { fresh: true })));
            } else this.notify(error.message, true);
        }
    }

    mountPage(view, content, { top = null, actions = null, help = null } = {}) {
        if (!this.root) return;
        this.view = view;
        const nodes = this.nodes;
        nodes.editorTop.hidden = !top;
        nodes.editorTop.replaceChildren(...(top ? [top] : []));
        nodes.actions.hidden = !actions;
        nodes.actions.replaceChildren(...(actions ? [actions] : []));
        nodes.footer.hidden = Boolean(actions);
        nodes.help.hidden = !help;
        nodes.help.replaceChildren(...(help ? [help] : []));
        nodes.view.replaceChildren(content);
        this.root.classList.toggle('wb-editor-expanded', ['editor', 'create'].includes(view) && Boolean(this.editor?.expanded));
        this.updateTabs(); this.updateContextLabel();
        if (this.compact && this.navOpen) this.setNavigation(false, true);
        this.root.dispatchEvent(new Event('wb-layout'));
    }

    showReadError(message, retry) {
        this.tab = 'entries'; this.workspaceView = 'library';
        const content = element('section', { class: 'wb-feature-view' }, scrollRegion(element('div', { class: 'wb-reading-page' },
            errorView(message, retry), button('返回世界书列表', { glyph: 'back', onclick: () => this.renderLibrary() })), 'wb-fill-scroll'));
        this.mountPage('library', content);
    }

    rememberView() {
        if (this.view === 'entries') {
            this.listScroll = this.listViewport?.scrollTop || 0;
            this.categoryScroll = this.categoryStrip?.scrollLeft || 0;
        } else if (this.view === 'library') this.libraryScroll = this.libraryViewport?.scrollTop || 0;
        else if (['editor', 'create'].includes(this.view)) this.editor?.rememberPosition();
        else if (this.view === 'scheduler') this.scheduler?.rememberPosition();
        else if (this.view === 'api') this.apiSettings?.rememberPosition();
        else if (this.view === 'prompts') this.promptSettings?.rememberPosition();
        else if (this.view === 'history') this.historyUI?.rememberPosition();
    }

    useBook(book) {
        if (this.currentBook === book) return;
        if (this.currentBook) this.bookViews.set(this.currentBook, {
            query: this.query, filter: this.filter, categoryFilter: this.categoryFilter,
            page: this.page, listScroll: this.listScroll, categoryScroll: this.categoryScroll,
        });
        this.currentBook = book;
        Object.assign(this, this.bookViews.get(book) || {
            query: '', filter: 'all', categoryFilter: CATEGORY_ALL, page: 0, listScroll: 0, categoryScroll: 0,
        });
    }

    async setTab(tab) {
        if (!this.root || !['entries', 'scheduler', 'history', 'api', 'prompts'].includes(tab)) return;
        this.rememberView();
        this.tab = tab;
        if (tab === 'entries') {
            if (['editor', 'create'].includes(this.workspaceView) && this.store.session) this.renderEditor();
            else if (this.workspaceView === 'entries' && this.currentBook) {
                if (this.store.loaded.has(this.currentBook)) this.renderEntries();
                else await this.selectBook(this.currentBook);
            } else this.renderLibrary();
        } else if (tab === 'scheduler') {
            this.scheduler ||= new SchedulerUI(this);
            this.scheduler.refreshBooks(); this.scheduler.update();
            this.mountPage('scheduler', this.scheduler.view, { actions: this.scheduler.actions });
            this.scheduler.restorePosition();
        } else if (tab === 'history') {
            this.historyUI ||= new SchedulerHistoryUI(this);
            this.historyUI.update();
            this.mountPage('history', this.historyUI.view);
            this.historyUI.restorePosition();
        } else if (tab === 'api') {
            this.apiSettings ||= new APISettingsUI(this);
            this.apiSettings.refreshProfiles(); this.apiSettings.update();
            this.mountPage('api', this.apiSettings.view, { actions: this.apiSettings.actions });
            this.apiSettings.queueModels();
            this.apiSettings.restorePosition();
        } else {
            this.promptSettings ||= new PromptSettingsUI(this);
            this.promptSettings.update();
            this.mountPage('prompts', this.promptSettings.view, {
                actions: this.promptSettings.actions, help: this.promptSettings.helpButton,
            });
            this.promptSettings.restorePosition();
        }
    }

    updateTabs() {
        if (!this.root) return;
        for (const name of ['entries', 'scheduler', 'history', 'api', 'prompts']) {
            const control = this.root.querySelector(`[data-wb="${name}-tab"]`);
            if (name === this.tab) control.setAttribute('aria-current', 'page');
            else control.removeAttribute('aria-current');
        }
        this.nodes.title.textContent = PAGE_TITLES[this.view] || '世界书工作台';
    }

    renderLibrary() {
        if (!this.root) return;
        this.rememberView();
        this.workspaceView = 'library'; this.tab = 'entries';
        const search = element('input', {
            id: 'wb-library-search', type: 'search', value: this.libraryQuery,
            placeholder: '搜索世界书', 'aria-label': '搜索全部世界书', autocomplete: 'off',
        });
        search.addEventListener('input', () => {
            this.libraryQuery = search.value; this.libraryScroll = 0; this.libraryViewport.scrollTop = 0; this.renderBooks();
        });
        this.libraryCount = element('span', { class: 'wb-help' });
        const filters = element('div', { class: 'wb-pill-row' });
        for (const [value, label] of [['all', '全部世界书'], ['mounted', '当前启用']]) filters.append(button(label, {
            class: 'wb-button wb-pill', 'data-library-filter': value, 'aria-pressed': this.libraryFilter === value,
            onclick: () => {
                this.libraryFilter = value; this.libraryScroll = 0; this.libraryViewport.scrollTop = 0;
                for (const control of filters.querySelectorAll('button')) control.setAttribute('aria-pressed', String(control.dataset.libraryFilter === value));
                this.renderBooks();
            },
        }));
        filters.append(this.libraryCount);
        this.libraryList = element('div', { class: 'wb-book-library' });
        this.libraryViewport = element('div', { class: 'wb-browse-content', tabIndex: 0 }, this.libraryList);
        this.libraryViewport.addEventListener('scroll', () => { this.libraryScroll = this.libraryViewport.scrollTop; }, { passive: true });
        this.libraryNotice = element('div', { class: 'wb-draft-notices' });
        const toolbar = element('div', { class: 'wb-browse-toolbar' },
            element('p', { class: 'wb-help', text: '先选择一本世界书，再浏览和编辑其中的条目。当前聊天启用的书优先展示。' }),
            element('div', { class: 'wb-browse-search' },
                element('div', { class: 'wb-search' }, icon('search'), search),
                button('刷新书库', { glyph: 'refresh', onclick: () => this.run(() => this.refreshLibrary()) })),
            filters, this.libraryNotice);
        this.mountPage('library', element('section', { class: 'wb-feature-view' }, toolbar, scrollRegion(this.libraryViewport, 'wb-fill-scroll')));
        this.renderBooks({ restore: true });
    }

    renderBooks({ restore = false } = {}) {
        if (!this.root || this.view !== 'library' || !this.libraryList?.isConnected) return;
        const scroll = restore ? this.libraryScroll : this.libraryViewport.scrollTop;
        const query = this.libraryQuery.trim().toLocaleLowerCase();
        const matches = this.books.filter(book => (this.libraryFilter !== 'mounted' || book.mounted)
            && `${book.name} ${book.displayName} ${book.source}`.toLocaleLowerCase().includes(query));
        this.libraryCount.textContent = `${matches.length} / ${this.books.length} 本`;
        this.libraryList.replaceChildren();
        for (const [label, group] of [
            ['当前聊天启用', matches.filter(book => book.mounted)],
            ['其他世界书', matches.filter(book => !book.mounted)],
        ]) {
            if (!group.length) continue;
            this.libraryList.append(element('h3', { class: 'wb-group-heading' }, label, element('small', { text: `${group.length} 本` })));
            for (const book of group) {
                const count = this.store.loaded.has(book.name) ? `${this.store.entries(book.name).length} 个条目` : '';
                const row = button('', { class: 'wb-book-row', onclick: () => this.run(() => this.selectBook(book.name)) });
                row.append(icon('book'), element('span', { class: 'wb-entry-main' },
                    element('strong', { class: 'wb-entry-title', text: book.displayName || book.name }),
                    element('span', { class: 'wb-entry-meta' }, badge(book.source), book.managed ? badge('已托管') : null, count)),
                element('span', { class: 'wb-row-link', text: '查看条目' }));
                this.libraryList.append(row);
            }
        }
        if (!matches.length) this.libraryList.append(element('div', { class: 'wb-empty' }, icon('book'),
            element('strong', { text: this.books.length ? '没有符合条件的世界书' : '世界书库为空' }),
            element('p', { class: 'wb-help', text: this.books.length ? '试试其他关键词，或切回全部世界书。' : '先在酒馆里创建或导入世界书，再刷新这里的书库。' })));
        this.updateDraftNotices();
        this.libraryViewport.scrollTop = scroll;
        this.scrollbars?.refresh();
    }

    renderEntries() {
        if (!this.root) return;
        if (!this.currentBook) { this.renderLibrary(); return; }
        this.workspaceView = 'entries'; this.tab = 'entries';
        const book = this.bookInfo(this.currentBook);
        this.bookSourceNode = element('small', { class: 'wb-option-meta', text: book?.source || '未挂载到当前聊天' });
        const search = element('input', {
            id: 'wb-entry-search', type: 'search', value: this.query,
            placeholder: '搜索这本书的标题、关键词或正文', 'aria-label': '搜索当前世界书条目', autocomplete: 'off',
        });
        this.clearSearch = button('清除搜索', { glyph: 'close', iconOnly: true, onclick: () => { search.value = ''; this.query = ''; this.page = 0; this.renderRows(); search.focus(); } });
        search.addEventListener('input', () => {
            this.query = search.value; this.page = 0;
            clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.renderRows(), 100);
        });
        const targetBook = this.currentBook;
        const create = button('新增条目', { glyph: 'plus', kind: 'primary', onclick: () => this.run(() => this.newEntry(targetBook)) });
        this.listCount = element('span', { class: 'wb-help' });
        this.list = element('div', { class: 'wb-list' });
        this.pager = element('div', { class: 'wb-pagination' });
        const filters = element('div', { class: 'wb-pill-row', 'aria-label': '条目状态' });
        for (const [value, label] of FILTERS) filters.append(button(label, {
            class: 'wb-button wb-pill', 'data-status-filter': value, 'aria-pressed': this.filter === value,
            onclick: () => {
                this.filter = value; this.page = 0; this.listViewport.scrollTop = 0;
                for (const control of filters.querySelectorAll('button')) control.setAttribute('aria-pressed', String(control.dataset.statusFilter === value));
                this.renderRows();
            },
        }));
        filters.append(this.listCount);
        this.categoryStrip = element('nav', { class: 'wb-category-strip', 'data-wb-horizontal': '', 'aria-label': '条目分类' });
        this.categoryStrip.addEventListener('scroll', () => { this.categoryScroll = this.categoryStrip.scrollLeft; }, { passive: true });
        this.listNotice = element('div', { class: 'wb-draft-notices' });
        this.listViewport = element('div', { class: 'wb-browse-content', tabIndex: 0 }, this.list);
        this.listViewport.addEventListener('scroll', () => { this.listScroll = this.listViewport.scrollTop; }, { passive: true });
        const toolbar = element('div', { class: 'wb-browse-toolbar' },
            element('div', { class: 'wb-book-source-row' },
                button('世界书列表', { glyph: 'back', onclick: () => this.renderLibrary() }),
                element('div', { class: 'wb-option-main' }, element('strong', { text: this.currentBook }), this.bookSourceNode)),
            element('div', { class: 'wb-browse-search' }, element('div', { class: 'wb-search' }, icon('search'), search, this.clearSearch), create),
            filters, this.categoryStrip, this.listNotice);
        this.mountPage('entries', element('section', { class: 'wb-feature-view' }, toolbar,
            scrollRegion(this.listViewport, 'wb-fill-scroll'), this.pager));
        this.renderCategories(); this.renderRows(); this.listViewport.scrollTop = this.listScroll;
        this.categoryStrip.scrollLeft = this.categoryScroll;
    }

    renderCategories() {
        if (!this.categoryStrip?.isConnected) return;
        const data = this.store.loaded.get(this.currentBook);
        const definitions = bookCategories(data);
        if (![CATEGORY_ALL, CATEGORY_CONSTANT, ...definitions.map(value => value.id)].includes(this.categoryFilter)) this.categoryFilter = CATEGORY_ALL;
        const scroll = this.categoryStrip.scrollLeft;
        const entries = this.store.entries(this.currentBook);
        this.categoryStrip.replaceChildren();
        for (const [id, label] of [[CATEGORY_ALL, '全部'], [CATEGORY_CONSTANT, '常驻'], ...definitions.map(value => [value.id, value.name])]) {
            const count = entries.filter(record => id === CATEGORY_ALL || (id === CATEGORY_CONSTANT
                ? Boolean(record.entry.constant) : entryCategory(data, record.key) === id)).length;
            const control = button('', {
                class: `wb-button wb-pill${id === CATEGORY_CONSTANT ? ' wb-constant-pill' : ''}`,
                'data-category': id, 'aria-pressed': this.categoryFilter === id,
                onclick: () => {
                    this.categoryFilter = id; this.page = 0; this.listViewport.scrollTop = 0;
                    for (const chip of this.categoryStrip.querySelectorAll('[data-category]')) chip.setAttribute('aria-pressed', String(chip.dataset.category === id));
                    this.renderRows();
                },
            });
            control.append(element('span', { text: label }), element('small', { text: count }));
            this.categoryStrip.append(control);
        }
        this.categoryStrip.append(button('新增分类', {
            class: 'wb-button wb-pill wb-category-add', glyph: 'plus', disabled: this.store.busy,
            onclick: () => this.addCategorySheet(this.currentBook),
        }));
        this.categoryStrip.scrollLeft = scroll;
        this.scrollbars?.refresh();
    }

    recordMatches(record) {
        const entry = record.entry;
        const id = entryId({ world: this.currentBook, uid: record.key });
        const overrides = this.director.state().overrides;
        const data = this.store.loaded.get(this.currentBook);
        if (this.categoryFilter === CATEGORY_CONSTANT && !entry.constant) return false;
        if (![CATEGORY_ALL, CATEGORY_CONSTANT].includes(this.categoryFilter) && entryCategory(data, record.key) !== this.categoryFilter) return false;
        if (this.filter === 'enabled' && entry.disable) return false;
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
        const scroll = this.listViewport.scrollTop;
        const all = this.store.entries(this.currentBook);
        const data = this.store.loaded.get(this.currentBook);
        const matches = this.visibleRecords();
        const pages = Math.max(1, Math.ceil(matches.length / this.pageSize));
        this.page = Math.min(this.page, pages - 1);
        this.listCount.textContent = `${matches.length} / ${all.length} 个条目`;
        this.clearSearch.hidden = !this.query;
        this.list.replaceChildren();
        if (this.categoryFilter === CATEGORY_CONSTANT) this.list.append(element('p', { class: 'wb-group-note', text: '常驻展示原书中开启蓝灯的条目；已禁用的蓝灯条目也会显示。' }));
        if (!matches.length) {
            this.list.append(element('div', { class: 'wb-empty' }, icon('search'), element('strong', { text: all.length ? '没有找到条目' : '这本书还没有条目' }),
                element('p', { class: 'wb-help', text: all.length ? '换一个关键词，或清除当前筛选。' : '点击新增条目，进入单独的创建页。' }),
                all.length ? button('清除筛选', { onclick: () => { this.query = ''; this.filter = 'all'; this.categoryFilter = CATEGORY_ALL; this.page = 0; this.renderEntries(); } }) : null));
        }
        const overrides = this.director.state().overrides;
        let previousGroup = null;
        for (const record of matches.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize)) {
            const entry = record.entry;
            const id = entryId({ world: this.currentBook, uid: record.key });
            const badges = [];
            const category = entryCategory(data, record.key);
            const group = this.categoryFilter === CATEGORY_CONSTANT ? CATEGORY_CONSTANT : (categoryName(data, category) ? category : '');
            if (group !== previousGroup) {
                previousGroup = group;
                const label = group === CATEGORY_CONSTANT ? '常驻条目' : categoryName(data, group) || '其他条目';
                this.list.append(element('h3', { class: 'wb-group-heading', text: label }));
            }
            if (!record.editable) badges.push(badge('格式异常'));
            if (entry.constant) badges.push(badge('常驻 · 蓝灯'));
            else badges.push(badge(entry.vectorized ? '向量触发' : '绿灯 · 关键词'));
            if (categoryName(data, category)) badges.push(badge(categoryName(data, category)));
            if (overrides[id] === 'pin') badges.push(badge('本聊天固定', 'pin'));
            if (overrides[id] === 'exclude') badges.push(badge('本聊天排除', 'ban'));
            if (this.lastActual.has(id)) badges.push(badge('最近构造接纳', 'check'));
            const rawExcerpt = displayText(entry.content).replace(/\s+/g, ' ').slice(0, 500);
            const content = element('span', { class: 'wb-entry-main' },
                element('span', { class: 'wb-entry-title' }, entryTitle(entry, record.key)),
                element('span', { class: 'wb-excerpt', text: rawExcerpt || '暂无正文' }),
                element('span', { class: 'wb-entry-meta' }, badges),
                element('span', { class: 'wb-entry-keywords', text: `关键词：${Array.isArray(entry.key) ? entry.key.map(displayText).join('、') || '未填写' : displayText(entry.key) || '未填写'}` }));
            const book = this.currentBook;
            const open = () => record.editable ? this.run(() => this.openEntry(book, record.key, 'entries')) : this.rawEntry(record, book);
            const entryOpen = button('', { class: 'wb-entry-open', onclick: open });
            entryOpen.append(content);
            const toggle = button('', {
                class: 'wb-entry-toggle', role: 'switch', 'aria-checked': !entry.disable,
                'aria-label': `${entryTitle(entry, record.key)}的启用开关`, disabled: !record.editable || this.store.busy,
                onclick: () => this.run(() => this.toggleEntry(book, record.key, Boolean(entry.disable))),
            });
            toggle.append(element('span', { text: entry.disable ? '已禁用' : '已启用' }), element('span', { class: 'wb-toggle-track', 'aria-hidden': 'true' }));
            const edit = button(record.editable ? '编辑' : '查看原数据', { class: 'wb-row-link', onclick: open });
            this.list.append(element('article', {
                class: 'wb-entry-card', 'data-enabled': !entry.disable,
                'data-current': this.store.session?.book === book && this.store.session.uid === record.key,
            }, entryOpen, element('div', { class: 'wb-entry-side' }, toggle, edit)));
        }
        this.pager.replaceChildren();
        if (pages > 1) {
            const previous = button('上一页', { disabled: this.page === 0, onclick: () => { this.page--; this.renderRows(); this.listViewport.scrollTop = 0; } });
            const next = button('下一页', { disabled: this.page >= pages - 1, onclick: () => { this.page++; this.renderRows(); this.listViewport.scrollTop = 0; } });
            this.pager.append(previous, element('span', { class: 'wb-help', text: `${this.page + 1} / ${pages}` }), next);
        }
        this.pager.hidden = pages <= 1;
        this.updateDraftNotices();
        this.listViewport.scrollTop = scroll;
        this.scrollbars?.refresh();
    }

    visibleRecords() {
        const data = this.store.loaded.get(this.currentBook);
        const definitions = bookCategories(data);
        const rank = new Map(definitions.map((value, index) => [value.id, index]));
        const matches = this.store.entries(this.currentBook).filter(record => this.recordMatches(record));
        if (this.categoryFilter === CATEGORY_ALL) matches.sort((a, b) =>
            (rank.get(entryCategory(data, a.key)) ?? definitions.length) - (rank.get(entryCategory(data, b.key)) ?? definitions.length));
        return matches;
    }

    updateDraftNotices() {
        const host = this.view === 'library' ? this.libraryNotice : this.listNotice;
        if (!host?.isConnected) return;
        host.replaceChildren();
        const session = this.store.session;
        if (session && (this.store.dirty || session.pending)) {
            const text = session.editKind === 'toggle' ? `《${session.book}》的启用修改${session.pending ? '结果待确认' : '尚未保存'}`
                : `已保留《${session.book}》${session.isNew ? '的新条目草稿' : '的编辑草稿'}`;
            host.append(element('div', { class: 'wb-draft-notice' }, element('span', { text }),
                button('继续处理', { kind: 'text', disabled: this.store.busy, onclick: () => {
                    this.rememberView(); this.renderEditor();
                } })));
        }
        if (this.categories.pending) host.append(element('div', { class: 'wb-draft-notice' },
            element('span', { text: `《${this.categories.operation.book}》的分类保存结果待确认` }),
            button('处理分类', { kind: 'text', disabled: this.store.busy, onclick: () => this.addCategorySheet(this.categories.operation.book) })));
        host.hidden = !host.childElementCount;
    }

    addCategorySheet(book, { onAdded } = {}) {
        if (!this.root || this.store.busy) return;
        const pending = this.categories.pending;
        const operation = this.categories.operation;
        if (pending) book = operation.book;
        const name = element('input', {
            id: 'wb-category-name', type: 'text', autocomplete: 'off', maxLength: 64,
            placeholder: '填写你需要的分类名称', value: pending ? operation.name : '', disabled: pending,
        });
        const problem = element('p', { class: 'wb-help', role: 'alert' });
        const save = button(pending ? '确认并重试保存' : '保存分类', { kind: 'primary', onclick: () => this.run(async () => {
            name.disabled = true; save.disabled = true;
            try {
                const result = this.categories.pending ? await this.categories.retry() : await this.categories.add(book, name.value);
                if (this.sheets.body.contains(form)) this.sheets.close();
                if (this.view === 'entries' && this.currentBook === result.book) {
                    this.categoryFilter = result.id; this.page = 0; this.renderCategories(); this.renderRows();
                }
                this.editor?.refreshCategories(); onAdded?.(result.id, result.book);
                this.notify(result.warning || `已在《${result.book}》新增分类“${result.name}”。`);
            } catch (error) {
                problem.textContent = error.message;
                save.textContent = this.categories.pending ? '确认并重试保存' : '保存分类';
                throw error;
            } finally {
                name.disabled = this.categories.pending; save.disabled = this.store.busy;
            }
        }) });
        const form = element('form', { class: 'wb-settings-body' },
            element('p', { class: 'wb-help', text: `分类仅用于整理《${book}》里的条目。常驻由蓝灯状态自动识别，不需要手动创建。` }),
            pending ? element('p', { class: 'wb-help', text: '上次保存响应未确认。重试会先读取原书，已经保存的分类不会重复创建。' }) : null,
            element('div', { class: 'wb-field' }, element('label', { htmlFor: name.id, text: '分类名称' }), name), problem, save);
        form.addEventListener('submit', event => { event.preventDefault(); if (!save.disabled) save.click(); });
        this.sheets.open(pending ? '确认分类保存' : '新增分类', form);
    }

    async openEntry(book, uid, returnTo = this.tab) {
        if (this.store.busy) throw new Error('请等待当前保存完成。');
        this.rememberView();
        if (this.store.session?.book === book && this.store.session.uid === String(uid)) {
            this.editorReturn = returnTo; this.renderEditor(); return;
        }
        const sequence = this.currentBook === book && this.view === 'entries'
            ? this.visibleRecords().filter(record => record.editable).map(record => record.key)
            : this.currentBook === book && ['editor', 'create'].includes(this.view) ? this.editorSequence
                : this.store.entries(book).filter(record => record.editable).map(record => record.key);
        if (!(await this.guardDraft())) return;
        if (!this.root) return;
        const request = ++this.request;
        const origin = contextKey(this.getContext());
        if (!this.store.loaded.has(book)) await this.store.loadBook(book, { signal: this.readController.signal });
        if (!this.root || request !== this.request) return;
        if (this.store.session) this.store.discard();
        this.useBook(book);
        this.editorReturn = returnTo;
        this.editorSequence = sequence?.length ? sequence : this.store.entries(book).filter(record => record.editable).map(record => record.key);
        const session = this.store.begin(book, String(uid));
        session.context = origin;
        this.renderEditor();
    }

    rawEntry(record, book) {
        const input = element('textarea', { id: 'wb-raw-entry', readOnly: true, rows: 12, value: JSON.stringify(record.raw, null, 2) ?? String(record.raw) });
        this.sheets.open('原格式条目查看', element('div', { class: 'wb-field' },
            element('p', { class: 'wb-help', text: `${book} · ${record.key}：ID 或格式异常，提供只读原始数据，不覆盖保存。` }),
            element('label', { htmlFor: input.id, text: '原始条目数据' }), scrollRegion(input, 'wb-raw-scroll')));
    }

    async newEntry(book = this.currentBook) {
        if (!book) throw new Error('先打开一本世界书。');
        if (this.store.busy) throw new Error('请等待当前保存完成。');
        this.rememberView();
        if (this.store.session?.book === book && this.store.session.isNew) { this.renderEditor(); return; }
        if (!(await this.guardDraft())) return;
        if (!this.root) return;
        const request = ++this.request;
        if (!this.store.loaded.has(book)) await this.store.loadBook(book, { signal: this.readController.signal });
        if (!this.root || request !== this.request) return;
        if (this.store.session) this.store.discard();
        this.useBook(book);
        this.editorReturn = 'entries';
        this.store.begin(book);
        if (this.categoryFilter === CATEGORY_CONSTANT) this.store.set('constant', true);
        else if (bookCategories(this.store.loaded.get(book)).some(value => value.id === this.categoryFilter)) this.store.setCategory(this.categoryFilter);
        this.renderEditor();
    }

    renderEditor() {
        if (!this.root || !this.store.session) return;
        const session = this.store.session;
        this.tab = 'entries'; this.useBook(session.book);
        this.workspaceView = session.isNew ? 'create' : 'editor';
        const rebuild = !this.editor || this.editor.session !== session || this.editor.isNew !== session.isNew;
        try {
            if (rebuild) { this.editor?.dispose(); this.editor = new EntryEditor(this); }
            else this.editor.update();
        }
        catch (error) {
            this.editor = null;
            this.showReadError(`条目表单无法显示：${error.message}`);
            return;
        }
        this.mountPage(this.workspaceView, this.editor.view, { top: this.editor.top, actions: this.editor.actions });
        this.editor.restorePosition({ first: rebuild });
    }

    async saveEditor() {
        if (this.categories.pending) throw new Error('先处理分类保存结果，再保存条目。');
        const session = this.store.session;
        const result = await this.store.save();
        if (result.unchanged) return true;
        if (result.deleted) {
            if (this.tab === 'entries' && ['editor', 'create'].includes(this.workspaceView)) {
                this.currentBook = session.book; this.workspaceView = 'entries';
                this.page = 0; this.renderEntries();
            }
            this.notify(result.warning || `已确认从《${session.book}》删除条目。`);
        } else {
            if (result.wasNew && this.tab === 'entries' && ['editor', 'create'].includes(this.view)) this.renderEditor();
            else { this.editor?.syncValues(); this.editor?.update(); }
            this.notify(result.warning || `已保存到《${session.book}》原书，下次调度使用已保存内容。`);
        }
        return true;
    }

    async guardDraft({ closing = false } = {}) {
        if (this.store.busy) return false;
        if (!this.store.dirty && !this.store.session?.pending && !this.categories.pending) return true;
        if (this.guard) return this.guard;
        this.guard = (async () => {
            if (this.categories.pending) {
                const choice = await this.sheets.choose('分类保存结果待确认',
                    element('p', { class: 'wb-help', text: '重试会先读取原书，避免重复分类。离开不能撤销可能已完成的保存。' }),
                    [{ label: '确认并重试', value: 'retry', kind: 'primary' },
                        { label: '离开，不继续操作', value: 'discard' }, { label: '保持此页', value: 'cancel', kind: 'text' }]);
                if (choice === 'retry') {
                    try { await this.categories.retry(); }
                    catch (error) { this.notify(error.message, true); return false; }
                } else if (choice === 'discard') this.categories.abandon();
                else return false;
            }
            if (!this.store.dirty && !this.store.session?.pending) return true;
            const pending = this.store.session?.pending;
            const title = pending ? '上次操作结果待确认' : '有未保存的修改';
            const hint = pending ? '会先读取原书确认上次结果，再决定是否重试。直接离开不能撤销可能已经完成的写入。'
                : `${closing ? '即将关闭工作台' : '即将换一个编辑对象'}。已保留的草稿需要先保存或放弃，保存会直接修改原世界书。`;
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
        if (this.store.busy) return;
        this.rememberView();
        const target = this.editorReturn || 'entries';
        this.workspaceView = 'entries';
        if (target === 'scheduler') await this.setTab('scheduler');
        else this.renderEntries();
    }

    async guardSettings() {
        for (const [ui, label] of [[this.scheduler, '调度设置'], [this.apiSettings, 'API 设置'], [this.promptSettings, '提示词']]) {
            if (!ui?.dirty) continue;
            const choice = await this.sheets.choose(`${label}尚未保存`,
                element('p', { class: 'wb-help', text: '关闭工作台前，可以保存设置、放弃修改，或继续编辑。' }),
                [{ label: '保存设置并关闭', value: 'save', kind: 'primary' },
                    { label: '放弃设置修改', value: 'discard' }, { label: '继续编辑', value: 'cancel', kind: 'text' }]);
            if (choice === 'save') {
                try { await ui.apply(); }
                catch (error) { this.notify(error.message, true); return false; }
            } else if (choice === 'discard') ui.discard();
            else return false;
        }
        return true;
    }

    editorNeighbors() {
        const session = this.store.session;
        if (!session || session.isNew) return { previous: null, next: null, index: 0, total: 0 };
        const valid = new Set(this.store.entries(session.book).filter(record => record.editable).map(record => record.key));
        let sequence = (this.editorSequence || []).filter(uid => valid.has(uid));
        if (!sequence.includes(session.uid)) sequence = [...valid];
        const index = sequence.indexOf(session.uid);
        return { previous: sequence[index - 1] ?? null, next: sequence[index + 1] ?? null, index: index + 1, total: sequence.length };
    }

    async navigateEntry(direction) {
        const session = this.store.session;
        const neighbors = this.editorNeighbors();
        const uid = direction < 0 ? neighbors.previous : neighbors.next;
        if (session && uid != null) await this.openEntry(session.book, uid, this.editorReturn || 'entries');
    }

    async toggleEntry(book, uid, enabled) {
        if (this.store.busy) throw new Error('请等待当前保存完成。');
        if (!(await this.guardDraft())) return;
        if (!this.root) return;
        const request = ++this.request;
        if (!this.store.loaded.has(book)) await this.store.loadBook(book, { signal: this.readController.signal });
        if (!this.root || request !== this.request) return;
        if (this.store.session) this.store.discard();
        const session = this.store.begin(book, uid);
        session.editKind = 'toggle';
        this.store.set('disable', !enabled);
        const result = await this.store.save();
        if (this.store.session === session && !this.store.dirty && !session.pending) this.store.discard();
        this.editor?.dispose(); this.editor = null;
        if (this.view === 'entries') { this.renderCategories(); this.renderRows(); }
        this.notify(result.warning || `条目已${enabled ? '启用' : '禁用'}。`);
    }

    async copyEditorContent() {
        if (!this.store.session) return;
        await copyText(displayText(this.store.value('content')));
        this.notify('已复制当前条目的正文。');
    }

    async discardEditor() {
        const session = this.store.session;
        if (!session || this.store.busy) return;
        if (session.pending) { await this.reloadEditorSource(); return; }
        const choice = await this.sheets.choose(session.isNew ? '取消新增条目？' : '放弃本次修改？',
            element('p', { class: 'wb-help', text: session.isNew ? '新条目还没有写入原书，取消会丢弃这份草稿。' : '只放弃尚未保存的草稿，原书保持现有内容。' }),
            [{ label: '继续编辑', value: 'cancel' }, { label: session.isNew ? '取消新增' : '放弃修改', value: 'discard', kind: 'primary' }]);
        if (choice !== 'discard' || this.store.session !== session || !this.root) return;
        this.useBook(session.book);
        this.store.discard();
        if (!session.isNew && this.store.entries(session.book).some(record => record.key === session.uid && record.editable)) {
            this.store.begin(session.book, session.uid); this.renderEditor();
        } else this.renderEntries();
    }

    async reloadEditorSource() {
        const session = this.store.session;
        if (!session || this.store.busy) return;
        if (this.categories.pending) throw new Error('先确认分类保存结果，再重新读取条目。');
        const choice = await this.sheets.choose('重新读取原书？',
            element('p', { class: 'wb-help', text: '未保存的草稿会被放弃。若上次保存结果不确定，这里显示服务端当前版本，不重复新增。' }),
            [{ label: '取消', value: 'cancel' }, { label: '放弃草稿并读取', value: 'reload', kind: 'primary' }]);
        if (choice !== 'reload' || this.store.session !== session || !this.root) return;
        const uid = session.pending?.uid ?? session.uid;
        const request = ++this.request;
        await this.store.loadBook(session.book, { fresh: true, signal: this.readController.signal });
        if (!this.root || request !== this.request || this.store.session !== session) return;
        this.useBook(session.book);
        this.store.discard();
        if (uid != null && this.store.entries(session.book).some(record => record.key === String(uid) && record.editable)) {
            this.store.begin(session.book, uid);
            this.workspaceView = 'editor';
            if (this.tab === 'entries') this.renderEditor();
        } else {
            this.workspaceView = 'entries';
            if (this.tab === 'entries') this.renderEntries();
        }
        this.notify('已读取原书当前版本。');
    }

    async deleteEditorEntry() {
        const session = this.store.session;
        if (!session || session.isNew) return;
        if (this.categories.pending) throw new Error('先确认分类保存结果，再删除条目。');
        const title = entryTitle(session.baseline, session.uid);
        const choice = await this.sheets.choose('删除这个条目？',
            element('div', {}, element('strong', { text: title }), element('p', { class: 'wb-help', text: session.book }),
                element('p', { class: 'wb-help', text: '将从原世界书删除，其他聊天也受影响。当前未保存的修改一并放弃；这不是本聊天排除。' })),
            [{ label: '取消', value: 'cancel' }, { label: '确认删除', value: 'delete', kind: 'primary' }]);
        if (choice !== 'delete' || this.store.session !== session || !this.root) return;
        const result = await this.store.remove();
        this.useBook(session.book);
        this.page = 0; this.query = ''; this.filter = 'all'; this.listScroll = 0;
        this.workspaceView = 'entries';
        if (this.tab === 'entries') this.renderEntries();
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
                if (value !== 'auto' && !this.director.catalog.some(item => item.id === id && item.kind === 'green')) throw new Error('固定／排除只用于当前可调度的绿灯条目。');
                this.director.setOverride(id, value);
                this.notify({ auto: '已恢复本聊天自动选择。', pin: '已设为本聊天固定，仍受预算限制。', exclude: '已设为本聊天排除，失败回退时无效。' }[value]);
            }),
        }));
        host.append(segment, element('p', { class: 'wb-help', 'data-override-note': '' }));
        this.updateOverride(host, book, uid, origin);
    }

    updateOverride(host, book, uid, origin) {
        if (uid == null) return;
        const id = entryId({ world: book, uid });
        const context = this.getContext();
        const mode = this.director.state().overrides[id] || 'auto';
        const candidate = this.director.catalog.find(item => item.id === id);
        const eligible = candidate?.kind === 'green';
        const locked = !context.chatId || origin !== this.director.chatKey(context) || this.director.busy || this.store.busy;
        for (const control of host.querySelectorAll('[data-mode]')) {
            control.setAttribute('aria-pressed', String(control.dataset.mode === mode && (eligible || control.dataset.mode === 'auto')));
            control.disabled = locked || (!eligible && !(control.dataset.mode === 'auto' && mode !== 'auto'));
            if (control.dataset.mode === 'auto') control.textContent = !eligible && mode !== 'auto' ? '解除旧规则' : '自动';
        }
        const note = host.querySelector('[data-override-note]');
        if (note) note.textContent = candidate?.kind === 'blue'
            ? '蓝灯默认常驻，不使用固定／排除。旧规则暂时保留，切回绿灯后仍生效，也可手动解除。'
            : eligible ? '固定绿灯优先，仍受绿灯数量与 Token 上限；排除仅在成功调度时生效。'
                : '只有当前挂载、托管并符合条件的绿灯可以设置规则；已保存的旧规则仍可解除。';
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
            element('p', { class: 'wb-help', text: '会将新增或改动条目的原文发送给所选辅助模型，产生 API 用量。只生成用于展示的目录概括；调度筛选仍读取全文，不改写世界书正文。' }),
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
            const row = button('', { class: 'wb-option wb-theme-option', 'aria-pressed': this.settings.theme === value, onclick: () => {
                this.settings.setTheme(value); this.applyTheme(); this.themeSheet();
            } });
            row.append(icon('palette'), element('span', { class: 'wb-option-main' }, element('strong', { text: label }), element('small', { class: 'wb-option-meta', text: hint })),
                element('span', { class: 'wb-theme-marker', 'aria-hidden': true }));
            list.append(row);
        }
        const about = element('details', { class: 'wb-details' }, element('summary', {}, '关于回声书台与素材授权', icon('down')),
            element('div', { class: 'wb-details-body' },
                element('p', { class: 'wb-help', text: '回声系列原创 SVG 回环。世界书编辑保存原书；调度通过原生世界书扫描使用资料。' }),
                element('p', { class: 'wb-help', text: '整个插件沿用酒馆主题的字体，主题选项只调整配色。' }),
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
        this.apiSettings?.update();
        this.promptSettings?.update();
        this.historyUI?.update();
        if (this.view === 'entries') this.renderRows();
        else if (this.view === 'library') this.renderBooks();
    }

    onStoreChange() {
        if (!this.root) return;
        if (['editor', 'create'].includes(this.view) && !this.store.session) {
            this.editor?.dispose(); this.editor = null; this.renderEntries();
        } else this.editor?.update();
        this.scheduler?.update(); this.apiSettings?.update(); this.promptSettings?.update(); this.historyUI?.update();
        if (this.view === 'entries') { this.renderCategories(); this.renderRows(); }
        else if (this.view === 'library') this.updateDraftNotices();
    }

    onBookUpdated(book, data, metadata) {
        if (metadata?.source === MODULE) return;
        this.store.observeBook(book, data);
        if (this.root && this.store.loaded.has(book)) this.run(() => this.director.loadCatalog());
    }

    onBindingsChanged() {
        if (!this.root) return;
        this.historyUI?.update();
        const root = this.root;
        const request = this.bindingRequest = (this.bindingRequest || 0) + 1;
        this.run(async () => {
            const books = await this.api.books();
            if (this.root !== root || request !== this.bindingRequest) return;
            this.books = books;
            this.updateContextLabel();
            this.editor?.update(); this.scheduler?.refreshBooks(); this.scheduler?.update(); this.apiSettings?.update(); this.promptSettings?.update();
            if (this.view === 'library') this.renderBooks();
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
        this.historyUI?.update();
        if (this.store.session) { this.editor?.update(); this.onBindingsChanged(); return; }
        this.run(async () => {
            const request = ++this.directoryRequest;
            const books = await this.api.books({ fresh: true, signal: this.readController.signal });
            if (!this.root || request !== this.directoryRequest) return;
            this.books = books;
            if (this.store.session) { this.editor?.update(); return; }
            this.rememberView(); this.useBook(null); this.workspaceView = 'library';
            this.scheduler?.refreshBooks(); this.scheduler?.update(); this.apiSettings?.update(); this.promptSettings?.update();
            if (this.tab === 'entries') this.renderLibrary();
        });
    }
}
