import { MODULE, EXTENSION_FOLDER } from './core.js';
import { assetUrl } from './workbench-utils.js';

export async function mountUI(director, { openWorkbench } = {}) {
    const context = director.getContext();
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) throw new Error('找不到酒馆扩展设置面板。');
    host.insertAdjacentHTML('beforeend', await context.renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`, 'settings'));
    const root = document.getElementById(MODULE);
    const element = name => root.querySelector(`#ld-${name}`);
    element('brand-mark').src = assetUrl('echo-mark.svg');
    element('open-workbench').disabled = typeof openWorkbench !== 'function';
    if (openWorkbench) element('open-workbench').addEventListener('click', openWorkbench);
    const fieldNames = ['maxEntries', 'tokenBudget', 'recentMessages', 'timeoutSeconds'];
    const currentReport = () => {
        const report = director.report;
        return report?.chatKey && report.chatKey !== director.chatKey() ? null : report;
    };
    const addOption = (select, value, text, selected = false) => {
        const option = document.createElement('option');
        option.value = value; option.textContent = text; option.selected = selected;
        select.append(option);
    };

    function refreshLists() {
        const config = director.config;
        const current = director.getContext();
        const profiles = element('profile');
        profiles.replaceChildren();
        addOption(profiles, '', '当前聊天补全连接', !config.profileId);
        let supported = [];
        try { supported = current.ConnectionManagerRequestService.getSupportedProfiles(); } catch { /* Optional extension. */ }
        for (const profile of supported) addOption(profiles, profile.id, profile.name, config.profileId === profile.id);
        if (config.profileId && !supported.some(p => p.id === config.profileId)) {
            addOption(profiles, config.profileId, '所选连接已失效（请重新选择）', true);
        }
        const books = element('books');
        books.replaceChildren();
        const names = [...new Set([...current.getWorldInfoNames(), ...config.books])].sort((a, b) => a.localeCompare(b));
        for (const name of names) addOption(books, name, name, config.books.includes(name));
    }

    function renderEntries() {
        const filter = element('search').value.trim().toLocaleLowerCase();
        const report = currentReport();
        const selected = new Map((report?.selected || []).map(x => [x.id, x]));
        const skipped = new Map((report?.skipped || []).map(x => [x.id, x]));
        const actual = new Set(report?.actual || []);
        const overrides = director.state().overrides;
        const container = element('entries');
        container.replaceChildren();
        const matches = director.catalog.filter(item => `${item.title} ${item.entry.world} ${item.summary}`.toLocaleLowerCase().includes(filter));
        const fragment = document.createDocumentFragment();
        for (const item of matches.slice(0, 150)) {
            const card = document.createElement('div'); card.className = 'ld-entry';
            const title = document.createElement('div'); title.className = 'ld-entry-title'; title.textContent = item.title;
            const source = document.createElement('small'); source.className = 'ld-help';
            source.textContent = `${item.entry.world} · #${item.entry.uid} · ${item.summaryKind}`;
            const summary = document.createElement('div'); summary.className = 'ld-help'; summary.textContent = item.summary;
            const mode = document.createElement('select'); mode.className = 'text_pole';
            mode.setAttribute('aria-label', `${item.title} 的调度方式`);
            for (const [value, label] of [['auto', '自动调度'], ['pin', '本聊天固定（仍受预算限制）'], ['exclude', '本聊天排除（失败回退时无效）']]) {
                addOption(mode, value, label, (overrides[item.id] || 'auto') === value);
            }
            mode.disabled = director.busy || !director.getContext().chatId;
            mode.addEventListener('change', () => director.setOverride(item.id, mode.value));
            const reason = document.createElement('div'); reason.className = 'ld-entry-reason';
            const choice = selected.get(item.id);
            if (choice) {
                const state = report.mode === 'preview' ? '试选' : director.gate ? '等待原生扫描' : actual.has(item.id) ? '原生已激活' : '选中但未激活（检查原生预算/概率/过滤）';
                reason.textContent = `${report.stale ? '结果已过期，请重新试选 · ' : ''}${state} · ${choice.scope === 'scene' ? '场景资料' : '临时资料'} · 约 ${choice.tokens} tokens — ${choice.reason}`;
            } else if (skipped.has(item.id)) {
                reason.textContent = `未纳入：${skipped.get(item.id).reason}`;
            } else if (overrides[item.id] === 'exclude') {
                reason.textContent = '手动排除；正常调度不会加载。';
            } else {
                reason.textContent = report ? '最近一次未选中。' : '尚未试选。';
            }
            card.append(title, source, summary, mode, reason); fragment.append(card);
        }
        if (!matches.length || matches.length > 150) {
            const note = document.createElement('p'); note.className = 'ld-help';
            note.textContent = matches.length ? `共 ${matches.length} 条，显示前 150 条；请搜索以缩小范围。` : '没有条目。请选中世界书，并确认已通过酒馆原生方式挂载到当前聊天。';
            fragment.append(note);
        }
        container.append(fragment);
    }

    function render() {
        const config = director.config;
        element('enabled').checked = config.enabled;
        for (const name of fieldNames) element(name).value = config[name];
        root.querySelectorAll('[data-ld-lock]').forEach(input => { input.disabled = director.busy; });
        element('cancel').disabled = !director.busy;
        element('status').textContent = director.status;
        const missing = config.books.filter(book => !director.activeBooks.includes(book));
        element('book-note').textContent = `${director.catalog.length} 个可用条目。${missing.length ? `未挂载或为空：${missing.join('、')}` : '仅当前挂载的世界书参与调度。'}`;
        const report = currentReport();
        element('scene').textContent = report?.scene ? `当前场景：${report.scene}` : '';
        element('result').textContent = report && report.mode !== 'fallback'
            ? `最近${report.mode === 'preview' ? '试选' : '生成'}：${report.selected.length} 条，约 ${report.tokens} tokens；${report.skipped.length} 条因手动规则或预算未纳入。`
            : report?.mode === 'fallback' ? '本轮没有接管世界书，原生规则照常执行。' : '';
        renderEntries();
    }

    element('enabled').addEventListener('change', () => director.updateSettings({ enabled: element('enabled').checked }));
    element('profile').addEventListener('change', () => director.updateSettings({ profileId: element('profile').value }));
    element('books').addEventListener('change', async () => {
        director.updateSettings({ books: Array.from(element('books').selectedOptions, option => option.value) });
        await director.loadCatalog();
    });
    for (const name of fieldNames) {
        element(name).addEventListener('change', () => director.updateSettings({ [name]: Number(element(name).value) }));
    }
    element('refresh').addEventListener('click', async () => { refreshLists(); await director.loadCatalog(); render(); });
    element('preview').addEventListener('click', () => director.preview());
    element('summarize').addEventListener('click', () => director.summarize());
    element('cancel').addEventListener('click', () => director.invalidate('辅助请求已取消；若正文仍继续，本轮使用原生世界书规则。'));
    element('reset').addEventListener('click', () => director.clearState());
    element('search').addEventListener('input', renderEntries);
    director.onChange = render;
    refreshLists(); render();
    await director.loadCatalog();
}
