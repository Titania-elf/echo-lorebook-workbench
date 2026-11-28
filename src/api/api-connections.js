import { yaml } from '../../../../../../lib.js';
import { MODULE } from '../scheduler/core.js';
import { requestTavernBackend } from './tavern-backend.js';

const LOCKED_BODY_FIELDS = new Set(['model', 'messages', 'prompt', 'stream', 'n', 'tools', 'tool_choice']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~\w-]+$/;

export function normalizeAPIURL(value) {
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch { throw new Error('请填写完整的 API 基础地址，例如 http://127.0.0.1:8000/v1。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('API 地址请使用 http 或 https 基础地址，鉴权信息填写在密钥或附加请求头中。');
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
    return url.toString().replace(/\/+$/, '');
}

function apiKeyFor(scheme) {
    const value = String(scheme.apiKey || '').trim();
    if (CONTROL.test(value)) throw new Error('API 密钥包含换行或无效字符，请重新填写。');
    return value;
}

function parseField(value, label) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    try { return yaml.parse(text, { maxAliasCount: 0 }); }
    catch { throw new Error(`${label}格式无效，请填写 YAML 或 JSON。`); }
}

function readMapping(value, label) {
    const fields = parseField(value, label);
    if (fields == null) return {};
    if (typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => UNSAFE_KEYS.has(key))) {
        throw new Error(`${label}必须是键值映射。`);
    }
    return fields;
}

function forwardedHeaders(scheme) {
    const apiKey = apiKeyFor(scheme);
    // Override auth even for a keyless scheme, without borrowing the user's main Custom key.
    const headers = { Authorization: apiKey ? `Bearer ${apiKey}` : '' };
    const seen = new Set();
    for (const [name, value] of Object.entries(readMapping(scheme.forwardHeaders, '附加请求头'))) {
        const lower = name.toLowerCase();
        if (!HEADER_NAME.test(name) || UNSAFE_KEYS.has(lower) || ['content-length', 'transfer-encoding'].includes(lower) || seen.has(lower)) {
            throw new Error('附加请求头包含无效、重复或由传输层管理的名称。');
        }
        if (!['string', 'number', 'boolean'].includes(typeof value) || CONTROL.test(String(value))) {
            throw new Error('附加请求头的值必须是单行文本或简单值。');
        }
        seen.add(lower);
        const key = lower === 'authorization' ? 'Authorization' : lower === 'content-type' ? 'Content-Type' : name;
        headers[key] = String(value);
    }
    return headers;
}

function forwardedBody(scheme) {
    const include = readMapping(scheme.forwardBody, '附加请求参数');
    const exclude = parseField(scheme.forwardExclude, '排除字段') ?? [];
    if (!Array.isArray(exclude) || exclude.some(key => typeof key !== 'string' || !key.trim())) {
        throw new Error('排除字段必须是字段名称列表。');
    }
    const omitted = [...new Set(exclude.map(key => key.trim()))];
    if ([...Object.keys(include), ...omitted].some(key => LOCKED_BODY_FIELDS.has(key))) {
        throw new Error('转发选项不能改写模型、消息、流式、多候选或工具字段。');
    }
    return { include, exclude: omitted };
}

export function validateAPIScheme(scheme, { requireModel = false } = {}) {
    const name = String(scheme.name || '').trim();
    if (!name || Array.from(name).length > 64) throw new Error('方案名称请填写 1 到 64 个字符。');
    if (scheme.source === 'main') return { ...scheme, name };
    const apiKey = apiKeyFor(scheme);
    const model = String(scheme.model || '').trim();
    if (requireModel && !model) throw new Error(`请为方案“${name}”选择或填写模型。`);
    const url = (scheme.url || requireModel) ? normalizeAPIURL(scheme.url) : '';
    forwardedHeaders(scheme);
    forwardedBody(scheme);
    return { ...scheme, name, apiKey, model, url };
}

export function selectedAPIScheme(config) {
    if (config.apiMode !== 'scheme') return null;
    const scheme = config.apiSchemes?.find(value => value.id === config.apiSchemeId);
    if (!scheme) throw new Error('所选 API 方案已不存在，请到调度器 API 设置中重新选择。');
    return validateAPIScheme(scheme, { requireModel: scheme.source !== 'main' });
}

export function customAPIData(scheme, { statusOnly = false } = {}) {
    const data = {
        chat_completion_source: 'custom',
        custom_url: normalizeAPIURL(scheme.url),
        secret_id: `${MODULE}:independent-api`,
        custom_include_headers: JSON.stringify(forwardedHeaders(scheme)),
    };
    if (!statusOnly) {
        const { include, exclude } = forwardedBody(scheme);
        data.custom_include_body = JSON.stringify(include);
        data.custom_exclude_body = JSON.stringify(exclude);
        data.custom_prompt_post_processing = 'none';
    }
    return data;
}

export async function fetchAPIModels(context, scheme, timeoutSeconds = 60, parentSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason || new Error('模型列表获取已取消。'));
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('获取模型列表超时，请检查地址或稍后重试。')), timeoutSeconds * 1000);
    try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const data = customAPIData(scheme, { statusOnly: true });
        const result = await requestTavernBackend(context, 'status', data, controller.signal, { secret: apiKeyFor(scheme) });
        if (controller.signal.aborted) throw controller.signal.reason;
        const list = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : result?.models;
        if (!Array.isArray(list)) throw new Error('此 API 未返回可用的模型列表，可以手动填写模型 ID。');
        const ids = [...new Set(list.map(model => typeof model === 'string' ? model : model?.id ?? model?.name)
            .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].sort((a, b) => a.localeCompare(b));
        if (!ids.length) throw new Error('模型列表为空，可以手动填写模型 ID。');
        return ids;
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason || error;
        throw error;
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onAbort);
    }
}
