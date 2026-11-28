import { extractMessageFromData } from '../../../../../../script.js';
import { createGenerationParameters } from '../../../../../openai.js';
import { selectedAPIScheme, customAPIData } from './api-connections.js';
import { requestTavernBackend } from './tavern-backend.js';

async function sendChat(context, data, signal, secret) {
    const result = await requestTavernBackend(context, 'generate', data, signal, { secret });
    const content = typeof result?.content === 'string' ? result.content
        : typeof result?.message?.content === 'string' ? result.message.content
            : extractMessageFromData(result, 'openai');
    return { content };
}

/** No browser-to-provider connection, Generate recursion or global setting changes. */
export async function requestModel(context, config, messages, parentSignal, maxTokens = 1800, { onDispatch = () => {}, onResponse = () => {} } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason || new Error('请求已取消。'));
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) onAbort();
    const timer = setTimeout(() => {
        const error = new Error('辅助模型请求超时；请检查连接或提高超时秒数。');
        error.code = 'ECHO_REQUEST_TIMEOUT';
        controller.abort(error);
    }, config.timeoutSeconds * 1000);
    let rejectOnAbort;
    const cancelled = new Promise((_, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason || new Error('请求已取消。'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
        if (controller.signal.aborted) rejectOnAbort();
    });
    const send = async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        let result;
        const scheme = selectedAPIScheme(config);
        if (scheme?.source === 'custom') {
            const data = {
                ...customAPIData(scheme), model: scheme.model, messages: structuredClone(messages),
                max_tokens: maxTokens, temperature: 0.2, stream: false, n: 1,
            };
            onDispatch({ model: scheme.model });
            result = await sendChat(context, data, controller.signal, scheme.apiKey);
        } else if (!scheme && (config.apiMode === 'profile' || (!config.apiMode && config.profileId))) {
            const service = context.ConnectionManagerRequestService;
            if (!config.profileId || !service?.sendRequest || !service?.getSupportedProfiles) {
                throw new Error('所选酒馆连接已失效，请在调度器 API 设置中重新选择。');
            }
            const profile = service.getSupportedProfiles().find(value => value.id === config.profileId);
            if (!profile) throw new Error('所选酒馆连接已失效，请在调度器 API 设置中重新选择。');
            // Keep the host's provider, authentication, proxy preset and prompt processing intact.
            onDispatch({ model: profile.model || profile.name || '', submittedOnly: true });
            result = await service.sendRequest(config.profileId, structuredClone(messages), maxTokens, {
                stream: false, signal: controller.signal, extractData: true, includePreset: true,
            }, {
                stream: false, n: 1, enable_web_search: false, request_images: false,
                tools: undefined, tool_choice: undefined, stop: [], logit_bias: {},
            });
        } else {
            if (context.mainApi !== 'openai') {
                throw new Error('跟随主连接仅支持酒馆的聊天补全；也可选择已有连接或新建独立 API 方案。');
            }
            const settings = structuredClone(context.chatCompletionSettings);
            Object.assign(settings, {
                openai_max_tokens: maxTokens, stream_openai: false, n: 1, function_calling: false,
                enable_web_search: false, request_images: false,
            });
            const model = context.getChatCompletionModel(settings);
            if (!model) throw new Error('当前聊天补全连接未选择模型。');
            const { generate_data: data } = await createGenerationParameters(settings, model, 'quiet', structuredClone(messages));
            // Preserve native routing and prompt processing, but not roleplay stops, tools or swipes.
            for (const key of ['tools', 'tool_choice', 'stop', 'logit_bias', 'logprobs', 'top_logprobs']) delete data[key];
            if (controller.signal.aborted) throw controller.signal.reason;
            data.stream = false;
            data.n = 1;
            onDispatch({ model });
            result = await sendChat(context, data, controller.signal);
        }
        try {
            const observation = onResponse({
                content: typeof result?.content === 'string' ? result.content : '',
                receivedAt: Date.now(),
                late: controller.signal.aborted,
            });
            Promise.resolve(observation).catch(() => {
                console.warn('[回声书台] 辅助请求返回记录失败。');
            });
        } catch {
            console.warn('[回声书台] 辅助请求返回记录失败。');
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        if (typeof result?.content !== 'string' || !result.content.trim()) {
            throw new Error('辅助模型未返回正文；可能只产生了推理文本，或输出额度不足。');
        }
        return result.content;
    };
    try {
        return await Promise.race([send(), cancelled]);
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason || error;
        if (error.cause?.message) {
            const wrapped = new Error(`${error.message}：${error.cause.message}`, { cause: error });
            const code = error.code ?? error.cause.code;
            if (code !== undefined) wrapped.code = code;
            throw wrapped;
        }
        throw error;
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', rejectOnAbort);
    }
}
