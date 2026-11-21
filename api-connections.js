import { MODULE } from './core.js';

export function normalizeAPIURL(value) {
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch { throw new Error('请填写完整的 API 地址，例如 https://example.com/v1。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('API 地址请使用 http 或 https 基础地址，密钥填写在单独的输入框中。');
    }
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
}

export function validateAPIScheme(scheme, { requireModel = false } = {}) {
    const name = String(scheme.name || '').trim();
    if (!name || Array.from(name).length > 64) throw new Error('方案名称请填写 1 到 64 个字符。');
    if (scheme.source === 'main') return { ...scheme, name };
    const apiKey = String(scheme.apiKey || '').trim();
    if (/[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error(`方案“${name}”的密钥包含换行或无效字符，请重新填写。`);
    const model = String(scheme.model || '').trim();
    if (requireModel && !model) throw new Error(`请为方案“${name}”选择或填写模型。`);
    const url = (scheme.url || requireModel) ? normalizeAPIURL(scheme.url) : '';
    return { ...scheme, name, apiKey, model, url };
}

export function selectedAPIScheme(config) {
    if (config.apiMode !== 'scheme') return null;
    const scheme = config.apiSchemes?.find(value => value.id === config.apiSchemeId);
    if (!scheme) throw new Error('所选 API 方案已不存在，请到调度器 API 设置中重新选择。');
    return validateAPIScheme(scheme, { requireModel: scheme.source !== 'main' });
}

export function customAPIData(scheme) {
    const apiKey = String(scheme.apiKey || '').trim();
    if (/[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error('API 密钥包含无效字符，请重新填写。');
    return {
        chat_completion_source: 'custom',
        custom_url: normalizeAPIURL(scheme.url),
        // Always override auth, including for keyless local APIs. Do not borrow the main custom key.
        secret_id: `${MODULE}:independent-api`,
        custom_include_headers: JSON.stringify({ Authorization: apiKey ? `Bearer ${apiKey}` : '' }),
        custom_include_body: '', custom_exclude_body: '', custom_prompt_post_processing: 'none',
        reverse_proxy: '', proxy_password: '',
    };
}

export async function fetchAPIModels(context, scheme, timeoutSeconds = 60, parentSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason || new Error('模型列表获取已取消。'));
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('获取模型列表超时，请检查地址或稍后重试。')), timeoutSeconds * 1000);
    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST', headers: context.getRequestHeaders(), credentials: 'same-origin',
            cache: 'no-cache', signal: controller.signal, body: JSON.stringify(customAPIData(scheme)),
        });
        if (!response.ok) throw new Error(`获取模型列表失败（HTTP ${response.status}），请检查 API 地址和密钥。`);
        const result = await response.json();
        if (result?.error || !Array.isArray(result?.data)) throw new Error('此 API 未返回可用的模型列表，可以手动填写模型 ID。');
        const ids = [...new Set(result.data.map(model => typeof model === 'string' ? model : model?.id)
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
