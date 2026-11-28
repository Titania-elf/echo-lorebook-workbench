import { element, button } from './workbench-utils.js';
import { scrollRegion } from './workbench-scroll.js';
import { sameValue, clone } from './workbench-state.js';
import { apiSelection, apiSelectionPatch, normalizeAPISchemes } from '../scheduler/core.js';
import { fetchAPIModels, normalizeAPIURL, validateAPIScheme } from '../api/api-connections.js';

export class APISettingsUI {
    constructor(workbench) {
        this.workbench = workbench;
        this.director = workbench.director;
        this.scrollTop = 0;
        this.modelRequest = 0;
        this.fetching = false;
        this.baseline = this.savedSettings();
        this.draft = clone(this.baseline);
        this.build();
    }

    savedSettings() {
        const config = this.director.config;
        return {
            apiMode: config.apiMode, apiSchemeId: config.apiSchemeId, profileId: config.profileId,
            apiSchemes: clone(config.apiSchemes), timeoutSeconds: config.timeoutSeconds,
        };
    }

    get dirty() {
        // A fetched model list is a display cache, not an unsaved connection change.
        const settings = value => ({
            ...value, apiSchemes: value.apiSchemes.map(({ models, ...scheme }) => scheme),
        });
        return !sameValue(settings(this.draft), settings(this.baseline));
    }
    get locked() { return this.director.busy || this.workbench.store.busy; }
    get scheme() {
        return this.draft.apiMode === 'scheme' ? this.draft.apiSchemes.find(value => value.id === this.draft.apiSchemeId) : null;
    }

    field(input, label, hint = '') {
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), input,
            hint ? element('p', { class: 'wb-help', text: hint }) : null);
    }

    build() {
        const workbench = this.workbench;
        this.profile = element('select', { id: 'wb-profile', 'aria-label': '调度器 API 方案' });
        this.profile.addEventListener('change', () => {
            Object.assign(this.draft, apiSelectionPatch(this.profile.value));
            this.renderScheme(); this.update(); this.queueModels();
        });
        this.addButton = button('新增方案', { glyph: 'plus', onclick: () => workbench.run(() => this.addScheme()) });
        this.deleteButton = button('删除方案', { glyph: 'trash', 'data-tone': 'danger', onclick: () => workbench.run(() => this.removeScheme()) });
        this.name = element('input', { id: 'wb-api-name', type: 'text', autocomplete: 'off', maxLength: 64, placeholder: '为方案起一个名字' });
        this.source = element('select', { id: 'wb-api-source' },
            element('option', { value: 'custom', text: '自定义 API（OpenAI 兼容）' }),
            element('option', { value: 'main', text: '跟随酒馆主连接' }));
        this.url = element('input', { id: 'wb-api-url', type: 'url', autocomplete: 'off', placeholder: 'https://example.com/v1', spellcheck: false });
        this.key = element('input', { id: 'wb-api-key', type: 'password', autocomplete: 'off', placeholder: '无需密钥的本地接口可留空', spellcheck: false });
        this.model = element('input', { id: 'wb-api-model', type: 'text', autocomplete: 'off', placeholder: '选择模型，或手动填写模型 ID', spellcheck: false });
        this.modelSelect = element('select', { id: 'wb-api-model-list', 'aria-label': '可用模型' });
        this.modelSelect.addEventListener('change', () => {
            if (!this.scheme || !this.modelSelect.value) return;
            this.scheme.model = this.modelSelect.value; this.model.value = this.scheme.model; this.update();
        });
        this.refreshModelsButton = button('获取模型列表', { glyph: 'refresh', onclick: () => workbench.run(() => this.fetchModels()) });
        this.autoModels = button('自动获取模型列表', {
            class: 'wb-entry-toggle wb-api-auto', role: 'switch', 'aria-checked': true,
            onclick: () => {
                if (!this.scheme || this.locked) return;
                this.scheme.autoModels = !this.scheme.autoModels;
                if (!this.scheme.autoModels) this.cancelModelFetch();
                this.update(); this.queueModels();
            },
        });
        this.autoModels.append(element('span', { class: 'wb-toggle-track', 'aria-hidden': 'true' }));
        this.modelStatus = element('p', { class: 'wb-help', role: 'status', 'aria-live': 'polite' });
        this.source.addEventListener('change', () => {
            if (!this.scheme) return;
            this.scheme.source = this.source.value; this.renderScheme(); this.update(); this.queueModels();
        });
        for (const [key, input] of [['name', this.name], ['url', this.url], ['apiKey', this.key], ['model', this.model]]) {
            const change = () => {
                const scheme = this.scheme;
                if (!scheme || scheme[key] === input.value) return;
                scheme[key] = input.value;
                if (key === 'name') {
                    const option = [...this.profile.options].find(value => value.value === `scheme:${scheme.id}`);
                    if (option) option.textContent = scheme.name || '未命名方案';
                }
                if (key === 'url' || key === 'apiKey') {
                    this.cancelModelFetch(); this.lastModelFetch = '';
                    scheme.models = []; this.renderModels(); this.queueModels();
                }
                if (key === 'model') this.modelSelect.value = scheme.models.includes(input.value) ? input.value : '';
                this.update();
            };
            input.addEventListener('input', change);
            input.addEventListener('change', change);
        }
        this.timeout = element('input', {
            id: 'wb-api-timeout', type: 'number', min: 10, max: 180, step: 1,
            inputMode: 'numeric', value: this.draft.timeoutSeconds,
        });
        this.timeout.addEventListener('input', () => {
            this.draft.timeoutSeconds = this.timeout.value.trim() ? Number(this.timeout.value) : null;
            this.update();
        });
        this.mainSummary = element('div', { class: 'wb-status', role: 'status' });
        this.schemeGroup = element('section', { class: 'wb-settings-body' },
            element('div', { class: 'wb-api-grid' }, this.field(this.name, '方案名称'), this.field(this.source, '连接方式')));
        this.customGroup = element('section', { class: 'wb-settings-body' },
            this.field(this.url, 'API 基础地址'),
            this.field(this.key, 'API 密钥', '密钥以明文随方案保存在当前用户的酒馆设置中。'),
            element('div', { class: 'wb-api-model-row' }, this.field(this.modelSelect, '可用模型'), this.refreshModelsButton),
            this.field(this.model, '模型 ID（可手动填写）'),
            this.autoModels, this.modelStatus);
        this.schemeGroup.append(this.customGroup);
        this.state = element('span', { class: 'wb-dirty-status', role: 'status' });
        this.discardButton = button('放弃修改', { onclick: () => this.discard() });
        this.save = button('保存 API 设置', { kind: 'primary', onclick: () => workbench.run(() => this.apply()) });
        this.actions = element('div', { class: 'wb-action-row' }, this.state,
            element('div', { class: 'wb-action-buttons' }, this.discardButton, this.save));
        const form = element('form', { class: 'wb-api-settings' },
            element('p', { class: 'wb-help', text: '为世界书目录筛选和 AI 整理保存独立 API 方案，或直接跟随酒馆主连接。' }),
            element('div', { class: 'wb-api-toolbar' }, this.field(this.profile, '当前 API 方案'),
                element('div', { class: 'wb-api-scheme-actions' }, this.addButton, this.deleteButton)),
            this.schemeGroup, this.mainSummary,
            this.field(this.timeout, '等待上限（秒）', '限制生成前调度的总等待时间，也用于单次辅助请求与模型列表获取。'),
            element('p', { class: 'wb-help', text: '新增、删除和修改方案后，点击保存 API 设置生效。' }));
        form.addEventListener('submit', event => { event.preventDefault(); workbench.run(() => this.apply()); });
        this.viewport = form;
        this.view = element('section', { class: 'wb-feature-view' }, scrollRegion(form, 'wb-fill-scroll'));
        this.refreshProfiles(); this.renderScheme(); this.update(); this.queueModels();
    }

    refreshProfiles() {
        const selected = apiSelection(this.draft);
        this.profile.replaceChildren(element('option', { value: 'main', text: '跟随酒馆主连接' }));
        if (this.draft.apiSchemes.length) {
            this.profile.append(element('optgroup', { label: '自建 API 方案' },
                this.draft.apiSchemes.map(value => element('option', { value: `scheme:${value.id}`, text: value.name || '未命名方案' }))));
        }
        let profiles = [];
        try { profiles = this.workbench.getContext().ConnectionManagerRequestService?.getSupportedProfiles() || []; }
        catch { /* Saved connections are an optional host feature. */ }
        if (profiles.length) this.profile.append(element('optgroup', { label: '酒馆已有连接' },
            profiles.map(value => element('option', { value: `profile:${value.id}`, text: value.name }))));
        if (![...this.profile.options].some(option => option.value === selected)) {
            this.profile.append(element('option', { value: selected, text: '所选连接已失效（请重新选择）' }));
        }
        this.profile.value = selected;
    }

    renderScheme() {
        this.cancelModelFetch();
        const scheme = this.scheme;
        this.schemeGroup.hidden = !scheme;
        this.customGroup.hidden = !scheme || scheme.source !== 'custom';
        this.mainSummary.hidden = Boolean(scheme && scheme.source === 'custom');
        this.name.value = scheme?.name || '';
        this.source.value = scheme?.source || 'main';
        this.url.value = scheme?.url || '';
        this.key.value = scheme?.apiKey || '';
        this.model.value = scheme?.model || '';
        this.timeout.value = this.draft.timeoutSeconds ?? '';
        this.modelStatus.textContent = scheme?.models.length ? `已有 ${scheme.models.length} 个模型，可以重新获取。` : '填写 API 地址后自动获取模型列表，也可以手动填写模型 ID。';
        this.renderModels();
    }

    renderModels() {
        const scheme = this.scheme;
        const models = scheme?.models || [];
        this.modelSelect.replaceChildren(element('option', { value: '', text: models.length ? '选择模型' : '尚未获取模型列表' }),
            ...models.map(id => element('option', { value: id, text: id })));
        if (scheme?.model && !models.includes(scheme.model)) this.modelSelect.append(element('option', { value: scheme.model, text: `当前模型：${scheme.model}` }));
        this.modelSelect.value = scheme?.model || '';
    }

    queueModels() {
        clearTimeout(this.autoTimer);
        const scheme = this.scheme;
        if (!scheme || scheme.source !== 'custom' || !scheme.autoModels || scheme.models.length) return;
        try { normalizeAPIURL(scheme.url); } catch { return; }
        const signature = JSON.stringify([scheme.id, scheme.url, scheme.apiKey]);
        if (signature === this.lastModelFetch) return;
        this.autoTimer = setTimeout(() => {
            this.autoTimer = null;
            this.fetchModels({ automatic: true }).catch(() => {});
        }, 700);
    }

    cancelModelFetch() {
        clearTimeout(this.autoTimer);
        this.autoTimer = null;
        if (this.fetching) this.lastModelFetch = '';
        ++this.modelRequest;
        this.modelController?.abort();
        this.modelController = null;
        this.fetching = false;
    }

    async fetchModels({ automatic = false } = {}) {
        const scheme = this.scheme;
        if (!scheme || scheme.source !== 'custom') throw new Error('请选择一个自定义 API 方案。');
        if (!automatic && this.locked) throw new Error('先完成当前请求或原书保存。');
        let snapshot;
        try {
            snapshot = validateAPIScheme({ ...clone(scheme), name: scheme.name.trim() || 'API 方案' });
            normalizeAPIURL(snapshot.url);
        } catch (error) {
            this.modelStatus.textContent = error.message;
            if (automatic) return;
            throw error;
        }
        this.cancelModelFetch();
        const request = ++this.modelRequest;
        this.lastModelFetch = JSON.stringify([scheme.id, scheme.url, scheme.apiKey]);
        const controller = new AbortController();
        this.modelController = controller;
        this.fetching = true; this.modelStatus.textContent = '正在获取模型列表…'; this.update();
        try {
            const timeout = Number.isInteger(this.draft.timeoutSeconds) && this.draft.timeoutSeconds >= 10 && this.draft.timeoutSeconds <= 180
                ? this.draft.timeoutSeconds : this.director.config.timeoutSeconds;
            const models = await fetchAPIModels(this.workbench.getContext(), snapshot, timeout, controller.signal);
            if (request !== this.modelRequest || this.scheme !== scheme) return;
            scheme.models = models; this.renderModels();
            this.modelStatus.textContent = `已获取 ${models.length} 个模型。选择后保存 API 设置。`;
        } catch (error) {
            if (request !== this.modelRequest) return;
            this.modelStatus.textContent = `${error.message || '获取失败。'} 也可以手动填写模型 ID。`;
            if (!automatic) throw error;
        } finally {
            if (request === this.modelRequest) { this.fetching = false; this.modelController = null; this.update(); }
        }
    }

    addScheme() {
        if (this.locked) throw new Error('先完成当前请求或原书保存。');
        let index = 1;
        while (this.draft.apiSchemes.some(value => value.name === `API 方案 ${index}`)) index++;
        const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const scheme = { id: `scheme-${random}`, name: `API 方案 ${index}`, source: 'custom', url: '', apiKey: '', model: '', models: [], autoModels: true };
        this.draft.apiSchemes.push(scheme);
        Object.assign(this.draft, apiSelectionPatch(`scheme:${scheme.id}`));
        this.refreshProfiles(); this.renderScheme(); this.update();
        this.name.focus({ preventScroll: true }); this.name.select();
    }

    async removeScheme() {
        const scheme = this.scheme;
        if (!scheme || this.locked) return;
        const choice = await this.workbench.sheets.choose('删除这个 API 方案？',
            element('div', {}, element('strong', { text: scheme.name || '未命名方案' }),
                element('p', { class: 'wb-help', text: '保存 API 设置后会删除此方案及其密钥，调度器改为跟随酒馆主连接。' })),
            [{ label: '保留方案', value: 'cancel' }, { label: '删除方案', value: 'delete', kind: 'primary' }]);
        if (choice !== 'delete' || this.scheme !== scheme || this.locked) return;
        this.cancelModelFetch();
        this.draft.apiSchemes = this.draft.apiSchemes.filter(value => value !== scheme);
        Object.assign(this.draft, apiSelectionPatch('main'));
        this.refreshProfiles(); this.renderScheme(); this.update();
    }

    update() {
        const saved = this.savedSettings();
        if (!this.dirty && !sameValue(saved, this.baseline)) {
            this.baseline = saved; this.draft = clone(saved);
            this.refreshProfiles(); this.renderScheme();
        }
        const scheme = this.scheme;
        const custom = Boolean(scheme && scheme.source === 'custom');
        this.profile.disabled = this.locked;
        this.timeout.disabled = this.locked;
        this.addButton.disabled = this.locked;
        this.deleteButton.disabled = this.locked || !scheme;
        this.name.disabled = this.locked || !scheme;
        this.source.disabled = this.locked || !scheme;
        for (const input of [this.url, this.key, this.model]) input.disabled = this.locked || !custom;
        this.modelSelect.disabled = this.locked || !custom || !scheme.models.length;
        this.refreshModelsButton.disabled = this.locked || !custom || this.fetching;
        this.autoModels.disabled = this.locked || !custom;
        this.autoModels.setAttribute('aria-checked', String(scheme?.autoModels !== false));
        this.save.disabled = this.locked || !this.dirty;
        this.discardButton.disabled = this.locked || !this.dirty;
        this.state.textContent = this.dirty ? '有未保存的设置' : '已保存';
        this.state.dataset.dirty = String(this.dirty);
        if (!custom) {
            const context = this.workbench.getContext();
            if (this.draft.apiMode === 'profile') {
                const option = [...this.profile.options].find(value => value.value === this.profile.value);
                this.mainSummary.textContent = `使用酒馆已有连接：${option?.textContent || '所选连接已失效'}。`;
            } else {
                let model = '';
                try { model = context.getChatCompletionModel(context.chatCompletionSettings) || ''; } catch { /* A non-chat-completion connection has no such model. */ }
                this.mainSummary.textContent = context.mainApi === 'openai'
                    ? `跟随酒馆主连接，当前模型：${model || '尚未选择模型'}。主连接修改后会自动跟随。`
                    : '当前主连接不是聊天补全。请切换酒馆主连接，或选择一个独立 API 方案。';
            }
        }
        this.workbench.scrollbars?.refresh();
    }

    apply() {
        if (this.locked) throw new Error('请先完成当前请求或原书保存。');
        const timeoutSeconds = Number(this.timeout.value);
        if (!this.timeout.value.trim() || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 180) {
            throw new Error('请求超时请填写 10 到 180 秒之间的整数。');
        }
        const names = new Set();
        const apiSchemes = this.draft.apiSchemes.map(value => {
            const scheme = validateAPIScheme(value, { requireModel: this.draft.apiMode === 'scheme' && this.draft.apiSchemeId === value.id && value.source === 'custom' });
            const name = scheme.name.toLocaleLowerCase();
            if (names.has(name)) throw new Error('API 方案名称不能重复，请换一个名称。');
            names.add(name); return scheme;
        });
        if (this.draft.apiMode === 'scheme' && !apiSchemes.some(value => value.id === this.draft.apiSchemeId)) throw new Error('所选方案已不存在，请重新选择。');
        this.cancelModelFetch();
        this.director.updateSettings({
            ...apiSelectionPatch(this.profile.value), timeoutSeconds, apiSchemes: normalizeAPISchemes(apiSchemes),
        });
        this.baseline = this.savedSettings(); this.draft = clone(this.baseline);
        this.refreshProfiles(); this.renderScheme(); this.update(); this.queueModels();
        this.workbench.notify('辅助 API 设置已保存。');
        return true;
    }

    discard() {
        if (this.locked) return;
        this.cancelModelFetch();
        this.baseline = this.savedSettings(); this.draft = clone(this.baseline);
        this.refreshProfiles(); this.renderScheme(); this.update(); this.queueModels();
    }

    rememberPosition() {
        if (this.viewport.isConnected) this.scrollTop = this.viewport.scrollTop;
    }

    restorePosition() {
        cancelAnimationFrame(this.restoreFrame);
        this.restoreFrame = requestAnimationFrame(() => {
            if (this.workbench.root?.contains(this.viewport)) this.viewport.scrollTop = this.scrollTop;
        });
    }
}
