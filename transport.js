import { createGenerationParameters } from '../../../openai.js';
import { selectedAPIScheme, customAPIData } from './api-connections.js';

/** Send directly through ST's backend, without Generate/quiet-prompt recursion or global setting changes. */
export async function requestModel(context, config, messages, parentSignal, maxTokens = 1800, { onDispatch = () => {} } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason || new Error('请求已取消。'));
    parentSignal.addEventListener('abort', onAbort, { once: true });
    if (parentSignal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('辅助模型请求超时；请检查连接或提高超时秒数。')), config.timeoutSeconds * 1000);
    let rejectOnAbort;
    const cancelled = new Promise((_, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason || new Error('请求已取消。'));
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
        if (controller.signal.aborted) rejectOnAbort();
    });
    const send = async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (typeof context.ChatCompletionService?.sendRequest !== 'function') throw new Error('酒馆的辅助请求服务尚未准备好。');
        let result;
        const scheme = selectedAPIScheme(config);
        if (scheme?.source === 'custom') {
            const data = {
                ...customAPIData(scheme), model: scheme.model, messages: structuredClone(messages),
                max_tokens: maxTokens, temperature: 0.2, stream: false, n: 1,
            };
            onDispatch({ model: scheme.model });
            result = await context.ChatCompletionService.sendRequest(data, true, controller.signal);
        } else if (!scheme && (config.apiMode === 'profile' || (!config.apiMode && config.profileId))) {
            if (!config.profileId || !context.ConnectionManagerRequestService?.sendRequest) {
                throw new Error('所选酒馆连接已失效，请在调度器 API 设置中重新选择。');
            }
            const profiles = context.ConnectionManagerRequestService.getSupportedProfiles();
            const profile = profiles.find(value => value.id === config.profileId);
            if (!profile) throw new Error('所选酒馆连接已失效，请在调度器 API 设置中重新选择。');
            // This service may still prepare a saved preset before making its HTTP call.
            onDispatch({ model: profile.model || profile.name || '', submittedOnly: true });
            // Saved connection profiles keep provider selection and secrets inside SillyTavern.
            result = await context.ConnectionManagerRequestService.sendRequest(config.profileId, messages, maxTokens, {
                stream: false, signal: controller.signal, extractData: true, includePreset: true,
            }, {
                stream: false, n: 1, enable_web_search: false, request_images: false,
                tools: undefined, tool_choice: undefined, stop: [], logit_bias: {},
            });
        } else {
            if (context.mainApi !== 'openai') {
                throw new Error('跟随主连接需要酒馆使用聊天补全；也可以选择已有连接或新建独立 API 方案。');
            }
            const settings = structuredClone(context.chatCompletionSettings);
            Object.assign(settings, {
                openai_max_tokens: maxTokens, stream_openai: false, n: 1, function_calling: false,
                enable_web_search: false, request_images: false,
            });
            const model = context.getChatCompletionModel(settings);
            if (!model) throw new Error('当前聊天补全连接未选择模型。');
            const { generate_data: data } = await createGenerationParameters(settings, model, 'quiet', structuredClone(messages));
            // Do not inherit roleplay stop strings, token bias, tools, or multiple samples.
            for (const key of ['tools', 'tool_choice', 'stop', 'logit_bias', 'logprobs', 'top_logprobs']) delete data[key];
            data.stream = false;
            data.n = 1;
            onDispatch({ model });
            result = await context.ChatCompletionService.sendRequest(data, true, controller.signal);
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
        if (error.cause?.message) throw new Error(`${error.message}：${error.cause.message}`, { cause: error });
        throw error;
    } finally {
        clearTimeout(timer);
        parentSignal.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', rejectOnAbort);
    }
}
