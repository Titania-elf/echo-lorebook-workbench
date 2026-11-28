import { yaml } from '../../../../../../lib.js';

const ROUTES = {
    generate: ['/api/backends/chat-completions/generate', '酒馆后端生成失败'],
    status: ['/api/backends/chat-completions/status', '酒馆后端获取模型列表失败'],
};

function describeError(error, payload, secret) {
    const message = typeof error === 'string' ? error : error?.message;
    if (typeof message !== 'string') return '';
    const sensitive = [secret, payload.proxy_password];
    // Both native presets (YAML) and independent schemes (JSON) can carry credentials in custom headers.
    if (payload.custom_include_headers) {
        try {
            const headers = yaml.parse(payload.custom_include_headers, { maxAliasCount: 0 });
            for (const row of Array.isArray(headers) ? headers : [headers]) {
                if (row && typeof row === 'object') sensitive.push(...Object.values(row));
            }
        } catch { /* The server may have ignored a malformed native preset. */ }
    }
    let safe = message;
    for (const value of sensitive.filter(value => typeof value === 'string' && value.trim()).sort((a, b) => b.length - a.length)) {
        safe = safe.replaceAll(value, '（已隐藏）');
    }
    return safe.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '鉴权信息已隐藏').trim().slice(0, 360);
}

/** Only the same-origin SillyTavern endpoint is called by the browser. */
export async function requestTavernBackend(context, action, payload, signal, { secret } = {}) {
    const [path, label] = ROUTES[action];
    if (typeof context.getRequestHeaders !== 'function') throw new Error('酒馆后端会话尚未就绪，请刷新酒馆后重试。');
    const response = await fetch(path, {
        method: 'POST', headers: context.getRequestHeaders(), credentials: 'same-origin',
        cache: 'no-cache', signal, body: JSON.stringify(payload),
    });
    let data;
    try { data = await response.json(); }
    catch (error) { if (signal?.aborted || error?.name === 'AbortError') throw error; }
    if (!response.ok || data?.error || data?.quota_error) {
        const detail = describeError(data?.error, payload, secret);
        const status = response.ok ? '' : `（HTTP ${response.status}）`;
        throw new Error(`${label}${status}${detail ? `：${detail}` : '，请检查目标地址、密钥和酒馆服务端能否访问反代。'}`);
    }
    if (data == null) throw new Error(`${label}：后端未返回 JSON。`);
    return data;
}
