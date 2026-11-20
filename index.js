import { getContext } from '../../../extensions.js';
import { getSortedEntries } from '../../../world-info.js';
import { MODULE, EXTENSION_NAME, EXTENSION_FOLDER, settingsWithDefaults } from './core.js';
import { LorebookDirector } from './director.js';
import { requestModel } from './transport.js';
import { mountUI } from './ui.js';
import { NativeWorldbookAdapter } from './native-adapter.js';
import { EntryStore } from './entry-store.js';
import { WorkbenchSettings } from './workbench-state.js';
import { WorldbookWorkbench } from './workbench.js';
import { element, assetUrl } from './workbench-utils.js';

const director = new LorebookDirector({
    getContext, getEntries: getSortedEntries, requestModel,
    onWarning: () => globalThis.toastr?.warning('选书失败，本轮已回退原生触发；详情见回声书台的调度页或扩展设置。', '回声书台'),
});
globalThis.lorebookDirectorInterceptor = (...args) => director.intercept(...args);

jQuery(async () => {
    const context = getContext();
    context.extensionSettings[MODULE] = settingsWithDefaults(context.extensionSettings[MODULE]);
    const disabled = context.extensionSettings.disabledExtensions;
    if (Array.isArray(disabled)) {
        const aliases = new Set([MODULE, EXTENSION_NAME, EXTENSION_FOLDER,
            `third-party/${MODULE}`, `third-party/${EXTENSION_NAME}`]);
        const normalized = [...new Set(disabled.map(name => aliases.has(name) ? `third-party/${EXTENSION_FOLDER}` : name))];
        if (JSON.stringify(normalized) !== JSON.stringify(disabled)) {
            context.extensionSettings.disabledExtensions = normalized;
            context.saveSettingsDebounced();
        }
    }
    const { eventSource, eventTypes } = context;
    const settings = new WorkbenchSettings(getContext);
    const api = new NativeWorldbookAdapter(getContext);
    const store = new EntryStore({
        api, settings,
        onBegin: () => director.invalidate('正在保存原世界书，旧调度选择已失效。'),
        onCommit: change => director.sourceSaved(change),
    });
    const workbench = new WorldbookWorkbench({ getContext, director, api, store, settings });
    const mountMenu = () => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById(`${MODULE}-menu`)) return Boolean(menu);
        const entry = element('button', {
            id: `${MODULE}-menu`, type: 'button', class: 'list-group-item wb-menu-entry',
            onclick: () => workbench.run(() => workbench.open()),
        }, element('img', { class: 'wb-brand-mark', src: assetUrl('echo-mark.svg'), alt: '', 'aria-hidden': 'true' }),
        element('span', { class: 'wb-brand-name', text: '回声书台' }));
        menu.append(entry);
        workbench.applyTheme();
        return true;
    };
    if (!mountMenu() && eventTypes.APP_READY) {
        if (typeof eventSource.once === 'function') eventSource.once(eventTypes.APP_READY, mountMenu);
        else eventSource.on(eventTypes.APP_READY, mountMenu);
    }
    // Start events also cover dry/quiet requests. Invalidate instead of letting them inherit
    // a foreground allowlist. WI's loaded event unfortunately has no request ID.
    eventSource.on(eventTypes.GENERATION_STARTED, () => director.invalidate('生成请求开始，等待本轮调度。'));
    eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, payload => director.onEntriesLoaded(payload));
    eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, entries => director.onActivated(entries));
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, () => director.onPromptReady());
    eventSource.on(eventTypes.GENERATION_STOPPED, () => director.invalidate('生成已停止，辅助请求和待注入选择已清理。'));
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        if (director.gate || director.operation?.kind === 'generation') director.invalidate('生成结束，待处理调度已清理。');
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        director.invalidate('聊天已切换，下次生成重新建立工作集。', true);
        void director.loadCatalog();
        workbench.onChatChanged();
    });
    for (const type of [eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPED]) {
        if (type) eventSource.on(type, () => director.invalidate('对话已改变，下次生成重新选择。'));
    }
    if (eventTypes.WORLDINFO_UPDATED) eventSource.on(eventTypes.WORLDINFO_UPDATED, (name, data, metadata) => {
        if (director.report) director.report = { ...director.report, stale: true };
        director.invalidate('世界书内容已改变，下次生成重新选择。');
        workbench.onBookUpdated(name, data, metadata);
    });
    if (eventTypes.WORLDINFO_SETTINGS_UPDATED) eventSource.on(eventTypes.WORLDINFO_SETTINGS_UPDATED, () => {
        director.invalidate('世界书挂载或设置已改变，下次生成重新选择。');
        workbench.onBindingsChanged();
    });
    for (const type of [eventTypes.CHARACTER_EDITED, eventTypes.PERSONA_CHANGED, eventTypes.PERSONA_UPDATED, eventTypes.GROUP_UPDATED, eventTypes.APP_READY]) {
        if (type) eventSource.on(type, () => workbench.onBindingsChanged());
    }
    try {
        await mountUI(director, { openWorkbench: () => workbench.run(() => workbench.open()) });
        workbench.applyTheme();
    } catch (error) {
        console.error('[Echo Lorebook Workbench] 设置面板加载失败', error);
        // An invisible enabled interceptor must not silently incur API calls.
        director.updateSettings({ enabled: false });
    }
});
