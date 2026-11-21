import { MODULE, EXTENSION_FOLDER, apiSelection, apiSelectionPatch } from './core.js';
import { assetUrl } from './workbench-utils.js';
import { catalogScope, resultSummary, choiceState } from './scheduler-report.js';

export async function mountUI(director) {
    const context = director.getContext();
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) throw new Error('找不到酒馆扩展设置面板。');
    host.insertAdjacentHTML('beforeend', await context.renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`, 'settings'));
    const root = document.getElementById(MODULE);
    const element = name => root.querySelector(`#ld-${name}`);
    element('brand-mark').src = assetUrl('echo-mark.svg');
    const fieldNames = ['maxEntries', 'tokenBudget', 'recentMessages', 'timeoutSeconds'];
    let connectionSignature = '';
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
        refreshConnections(config, true);
        const books = element('books');
        books.replaceChildren();
        const names = [...new Set([...current.getWorldInfoNames(), ...config.books])].sort((a, b) => a.localeCompare(b));
        for (const name of names) addOption(books, name, name, config.books.includes(name));
    }

    function refreshConnections(config, force = false) {
        const select = element('profile');
        let supported = [];
        try { supported = director.getContext().ConnectionManagerRequestService?.getSupportedProfiles() || []; }
        catch { /* Saved profiles are an optional host feature. */ }
        const signature = JSON.stringify([config.apiSchemes.map(value => [value.id, value.name]), supported.map(value => [value.id, value.name])]);
        if (force || signature !== connectionSignature) {
            connectionSignature = signature;
            select.replaceChildren();
            addOption(select, 'main', '跟随酒馆主连接');
            if (config.apiSchemes.length) {
                const group = document.createElement('optgroup'); group.label = '自建 API 方案';
                for (const scheme of config.apiSchemes) addOption(group, `scheme:${scheme.id}`, scheme.name || '未命名方案');
                select.append(group);
            }
            if (supported.length) {
                const group = document.createElement('optgroup'); group.label = '酒馆已有连接';
                for (const profile of supported) addOption(group, `profile:${profile.id}`, profile.name);
                select.append(group);
            }
        }
        const selected = apiSelection(config);
        if (![...select.options].some(option => option.value === selected)) addOption(select, selected, '所选连接已失效（请重新选择）');
        select.value = selected;
    }

    function syncSavedChoices(config) {
        refreshConnections(config);
        const books = element('books');
        const known = new Set([...books.options].map(option => option.value));
        const selected = new Set(config.books);
        for (const name of selected) if (!known.has(name)) addOption(books, name, name);
        for (const option of books.options) option.selected = selected.has(option.value);
    }

    function renderEntries() {
        const filter = element('search').value.trim().toLocaleLowerCase();
        const report = currentReport();
        const selected = new Map([...(report?.blue || []), ...(report?.selected || [])].map(x => [x.id, x]));
        const skipped = new Map((report?.skipped || []).map(x => [x.id, x]));
        const overrides = director.state().overrides;
        const container = element('entries');
        container.replaceChildren();
        const matches = director.catalog.filter(item => `${item.title} ${item.entry.world} ${item.summary}`.toLocaleLowerCase().includes(filter));
        const fragment = document.createDocumentFragment();
        for (const item of matches.slice(0, 150)) {
            const card = document.createElement('div'); card.className = 'ld-entry';
            const title = document.createElement('div'); title.className = 'ld-entry-title'; title.textContent = item.title;
            const source = document.createElement('small'); source.className = 'ld-help';
            source.textContent = `${item.entry.world} · #${item.entry.uid} · ${item.kind === 'blue' ? '蓝灯常驻' : '绿灯候选'} · ${item.summaryKind}（仅展示）`;
            const summary = document.createElement('div'); summary.className = 'ld-help'; summary.textContent = item.summary;
            const mode = document.createElement('select'); mode.className = 'text_pole';
            mode.setAttribute('aria-label', `${item.title} 的调度方式`);
            const blue = item.kind === 'blue';
            const oldRule = (overrides[item.id] || 'auto') !== 'auto';
            for (const [value, label] of [
                ['auto', blue ? oldRule ? '解除旧规则，保持蓝灯常驻' : '蓝灯默认常驻' : '自动筛选绿灯'],
                ['pin', blue ? '旧固定规则（蓝灯期间不生效）' : '本聊天固定（仍受绿灯预算限制）'],
                ['exclude', blue ? '旧排除规则（蓝灯期间不生效）' : '本聊天排除（失败回退时无效）'],
            ]) {
                addOption(mode, value, label, (overrides[item.id] || 'auto') === value);
                if (blue && value !== 'auto') mode.lastElementChild.disabled = true;
            }
            mode.disabled = director.busy || !director.getContext().chatId || (blue && !oldRule);
            mode.addEventListener('change', () => director.setOverride(item.id, mode.value));
            const reason = document.createElement('div'); reason.className = 'ld-entry-reason';
            const choice = selected.get(item.id);
            if (choice) {
                const state = choiceState(report, item.id);
                reason.textContent = `${report.stale ? '结果已过期，请重新试选 · ' : ''}${state} · ${choice.kind === 'blue' ? '蓝灯常驻' : '绿灯入选'} · ${choice.position === 'before' ? '世界书之前' : '世界书之后'} · 约 ${choice.tokens} tokens — ${choice.reason}`;
            } else if (skipped.has(item.id)) {
                reason.textContent = `未纳入：${skipped.get(item.id).reason}`;
            } else if (blue) {
                reason.textContent = '已启用的蓝灯默认常驻，不由模型选择，也不使用旧固定／排除规则。';
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
        syncSavedChoices(config);
        for (const name of fieldNames) element(name).value = config[name];
        root.querySelectorAll('[data-ld-lock]').forEach(input => { input.disabled = director.busy; });
        element('cancel').disabled = !director.operation && (!director.gate || director.gate.committed);
        element('status').textContent = director.status;
        element('book-note').textContent = catalogScope(director);
        const report = currentReport();
        element('scene').textContent = report?.scene ? `当前场景：${report.scene}` : '';
        element('result').textContent = report ? resultSummary(report) : '';
        renderEntries();
    }

    element('enabled').addEventListener('change', () => director.updateSettings({ enabled: element('enabled').checked }));
    element('profile').addEventListener('change', () => director.updateSettings(apiSelectionPatch(element('profile').value)));
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
