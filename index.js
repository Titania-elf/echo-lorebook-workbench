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
import { element } from './workbench-utils.js';
import { showSchedulerWarning } from './scheduler-notice.js';

const native = new NativeWorldbookAdapter(getContext);
const director = new LorebookDirector({
    getContext, getEntries: getSortedEntries, native, requestModel,
    onWarning: showSchedulerWarning,
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
    const api = native;
    const store = new EntryStore({
        api, settings,
        onBegin: () => director.invalidate('正在保存原世界书，旧调度选择已失效。'),
        onCommit: change => director.sourceSaved(change),
    });
    const workbench = new WorldbookWorkbench({ getContext, director, api, store, settings });
    const mountMenu = () => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById(`${MODULE}-menu`)) return Boolean(menu);
        const entry = element('div', {
            id: `${MODULE}-menu`, class: 'list-group-item flex-container flexGap5',
            title: '打开世界书工作台',
            onclick: () => workbench.run(() => workbench.open()),
        }, element('div', { class: 'fa-solid fa-book-open extensionsMenuExtensionButton', 'aria-hidden': 'true' }),
        element('span', { text: '回声书台' }));
        menu.append(entry);
        return true;
    };
    if (!mountMenu() && eventTypes.APP_READY) {
        if (typeof eventSource.once === 'function') eventSource.once(eventTypes.APP_READY, mountMenu);
        else eventSource.on(eventTypes.APP_READY, mountMenu);
    }
    // Start events also cover dry/quiet requests. Invalidate instead of letting them inherit
    // a foreground allowlist. WI's loaded event unfortunately has no request ID.
    eventSource.on(eventTypes.GENERATION_STARTED, (...args) => director.startGeneration(...args));
    eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, payload => director.onEntriesLoaded(payload));
    if (eventTypes.WORLDINFO_SCAN_DONE) eventSource.on(eventTypes.WORLDINFO_SCAN_DONE, args => director.onScanDone(args));
    eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, entries => director.onActivated(entries));
    if (eventTypes.CHAT_COMPLETION_PROMPT_READY) eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, data => director.onChatCompletionReady(data));
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, (...args) => director.onPromptReady(...args));
    eventSource.on(eventTypes.GENERATION_STOPPED, () => director.stopGeneration());
    eventSource.on(eventTypes.GENERATION_ENDED, () => director.endGeneration());
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
        if (type) eventSource.on(type, () => {
            director.invalidate('角色、人设或挂载已改变，下次生成重新选择。');
            workbench.onBindingsChanged();
        });
    }
    try {
        await mountUI(director);
        workbench.applyTheme();
    } catch (error) {
        console.error('[Echo Lorebook Workbench] 设置面板加载失败', error);
        // An invisible enabled interceptor must not silently incur API calls.
        director.updateSettings({ enabled: false });
    }
});
