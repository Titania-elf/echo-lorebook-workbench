import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const unexpected = () => { throw new Error('unexpected dependency call'); };

async function loadRelay({ createGenerationParameters = unexpected, fetch = unexpected } = {}) {
    const context = vm.createContext({ AbortController, URL, structuredClone, setTimeout, clearTimeout, fetch });
    const stub = exports => new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    const dependencies = new Map([
        ['../../../../../openai.js', stub({ createGenerationParameters })],
        ['../../../../../../script.js', stub({ extractMessageFromData: (data, type) => {
            assert.equal(type, 'openai');
            return data?.choices?.[0]?.message?.content || '';
        } })],
        ['../../../../../../lib.js', stub({ yaml: { parse: JSON.parse } })],
        ['../scheduler/core.js', stub({ MODULE: 'lorebook-director' })],
    ]);
    const files = ['transport.js', 'api-connections.js', 'tavern-backend.js'];
    await Promise.all(files.map(async name => {
        const source = await readFile(new URL(`../src/api/${name}`, import.meta.url), 'utf8');
        dependencies.set(`./${name}`, new vm.SourceTextModule(source, { context }));
    }));
    const transport = dependencies.get('./transport.js');
    await transport.link(specifier => {
        if (!dependencies.has(specifier)) throw new Error(`Unexpected test import: ${specifier}`);
        return dependencies.get(specifier);
    });
    await transport.evaluate();
    return {
        requestModel: transport.namespace.requestModel,
        fetchAPIModels: dependencies.get('./api-connections.js').namespace.fetchAPIModels,
        fetchMainAPIModels: dependencies.get('./api-connections.js').namespace.fetchMainAPIModels,
    };
}

const messages = [{ role: 'system', content: 'select JSON' }, { role: 'user', content: 'catalog' }];
const config = { apiMode: 'main', profileId: '', timeoutSeconds: 10 };
const getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'mock-csrf' });
const completion = content => ({ choices: [{ message: { content } }] });
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const scheme = {
    id: 'local', name: 'local gateway', source: 'custom', model: 'gateway-model', apiKey: 'mock-key',
    url: 'http://127.0.0.1:8000/gateway/v1/chat/completions///',
    forwardHeaders: '{"authorization":"Basic mock-auth", "X-Gateway-Token":"mock-router-token"}',
    forwardBody: '{"chat_template_kwargs":{"enable_thinking":false}}', forwardExclude: '["temperature"]',
};
const customConfig = value => ({ ...config, apiMode: 'scheme', apiSchemeId: value.id, apiSchemes: [value] });

test('independent generation and model listing use the same-origin host relay and share only connection fields', async () => {
    const requests = [];
    const { requestModel, fetchAPIModels } = await loadRelay({ fetch: async (path, options) => {
        requests.push({ path, options, data: JSON.parse(options.body) });
        return path.endsWith('/status') ? response({ models: [{ name: 'model-b' }, { id: 'model-a' }] }) : response(completion('{}'));
    } });
    const context = { getRequestHeaders };
    assert.equal(await requestModel(context, customConfig(scheme), messages, new AbortController().signal, 2400), '{}');
    assert.equal((await fetchAPIModels(context, scheme)).join(','), 'model-a,model-b');
    assert.deepEqual(requests.map(item => item.path), ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status']);
    const [generation, listing] = requests;
    for (const item of requests) {
        assert.equal(item.options.method, 'POST');
        assert.equal(item.options.credentials, 'same-origin');
        assert.equal(item.options.headers['X-CSRF-Token'], 'mock-csrf');
        assert.equal(item.data.custom_url, 'http://127.0.0.1:8000/gateway/v1');
        assert.equal(item.data.chat_completion_source, 'custom');
        assert.equal(item.data.secret_id, 'lorebook-director:independent-api');
        assert.deepEqual(JSON.parse(item.data.custom_include_headers), { Authorization: 'Basic mock-auth', 'X-Gateway-Token': 'mock-router-token' });
    }
    assert.deepEqual(generation.data.messages, messages);
    assert.equal(generation.data.max_tokens, 2400);
    assert.equal(generation.data.stream, false);
    assert.deepEqual(JSON.parse(generation.data.custom_include_body), { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(JSON.parse(generation.data.custom_exclude_body), ['temperature']);
    for (const name of ['messages', 'custom_include_body', 'custom_exclude_body']) assert.equal(listing.data[name], undefined);
});

test('keyless custom relay does not inherit native credentials or allow overriding the generation contract', async () => {
    let sent;
    const { requestModel } = await loadRelay({ fetch: async (_path, options) => {
        sent = JSON.parse(options.body);
        return response({ content: '{}' });
    } });
    const withoutKey = { ...scheme, apiKey: '', forwardHeaders: '' };
    await requestModel({ getRequestHeaders }, customConfig(withoutKey), messages, new AbortController().signal);
    assert.deepEqual(JSON.parse(sent.custom_include_headers), { Authorization: '' });
    sent = undefined;
    const invalid = customConfig({ ...withoutKey, forwardBody: '{"stream":true}' });
    await assert.rejects(() => requestModel({ getRequestHeaders }, invalid, messages, new AbortController().signal), /不能改写/);
    assert.equal(sent, undefined);
});

test('current connection clones settings and preserves native reverse proxy and prompt processing', async () => {
    let received;
    let sent;
    const { requestModel } = await loadRelay({
        createGenerationParameters: async (settings, model, type, input) => {
            received = { settings, model, type, input };
            return { generate_data: { messages: input, model, reverse_proxy: settings.reverse_proxy,
                proxy_password: settings.proxy_password, custom_prompt_post_processing: settings.custom_prompt_post_processing,
                stream: true, n: 9, tools: [{}], stop: ['END'], logit_bias: { 1: 20 } } };
        },
        fetch: async (url, { body }) => {
            assert.equal(url, '/api/backends/chat-completions/generate');
            sent = JSON.parse(body);
            return response(completion('{"selected":[]}'));
        },
    });
    const settings = { reverse_proxy: 'http://127.0.0.1:8001/v1', proxy_password: 'mock-proxy-password',
        custom_prompt_post_processing: 'merge', openai_max_tokens: 8000, stream_openai: true, function_calling: true };
    const original = structuredClone(settings);
    const context = { mainApi: 'openai', chatCompletionSettings: settings, getChatCompletionModel: () => 'configured-model', getRequestHeaders };
    await requestModel(context, config, messages, new AbortController().signal, 1234);
    assert.deepEqual(settings, original);
    assert.equal(received.settings.openai_max_tokens, 1234);
    assert.equal(received.settings.function_calling, false);
    assert.equal(received.type, 'quiet');
    assert.equal(sent.reverse_proxy, settings.reverse_proxy);
    assert.equal(sent.proxy_password, settings.proxy_password);
    assert.equal(sent.custom_prompt_post_processing, 'merge');
    assert.equal(sent.stream, false);
    assert.equal(sent.n, 1);
    for (const field of ['tools', 'stop', 'logit_bias']) assert.equal(sent[field], undefined);
});

test('default and named main connections can select separate models without changing host settings', async () => {
    const sent = [];
    const { requestModel } = await loadRelay({
        createGenerationParameters: async (settings, model) => ({ generate_data: { model, custom_url: settings.custom_url } }),
        fetch: async (_path, options) => { sent.push(JSON.parse(options.body)); return response(completion('{}')); },
    });
    const settings = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:8001/v1', custom_model: 'body-model' };
    const context = { mainApi: 'openai', chatCompletionSettings: settings, getChatCompletionModel: value => value.custom_model, getRequestHeaders };
    const named = { id: 'reuse', name: 'reuse main', source: 'main', model: 'old-custom-model' };
    const root = { ...config, mainModel: 'root-auxiliary' };
    const namedConfig = selection => ({ ...customConfig(selection), mainModel: root.mainModel });
    for (const options of [root, namedConfig({ ...named, mainModel: 'scheme-auxiliary' }), namedConfig(named)]) {
        await requestModel(context, options, messages, new AbortController().signal);
    }
    assert.deepEqual(sent.map(item => item.model), ['root-auxiliary', 'scheme-auxiliary', 'body-model']);
    assert.ok(sent.every(item => item.custom_url === settings.custom_url));
    assert.equal(settings.custom_model, 'body-model');
});

test('main connection model lists use its native custom address and headers without overriding credentials', async () => {
    let sent;
    const { fetchMainAPIModels } = await loadRelay({ fetch: async (path, options) => {
        assert.equal(path, '/api/backends/chat-completions/status');
        sent = JSON.parse(options.body);
        return response({ data: [{ id: 'body-model' }, { id: 'aux-model' }] });
    } });
    const settings = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:8000/v1',
        custom_include_headers: 'X-Local: preserved', custom_include_body: 'foo: bar', custom_model: 'body-model' };
    const context = { mainApi: 'openai', chatCompletionSettings: settings, getRequestHeaders };
    assert.equal((await fetchMainAPIModels(context)).join(','), 'aux-model,body-model');
    assert.deepEqual(sent, { chat_completion_source: 'custom', custom_url: settings.custom_url,
        custom_include_headers: settings.custom_include_headers });
});

test('saved profiles leave provider, connection and prompt options to the host service', async () => {
    const { requestModel } = await loadRelay();
    let args;
    const context = { ConnectionManagerRequestService: {
        getSupportedProfiles: () => [{ id: 'profile-1', model: 'preset-model' }],
        sendRequest: async (...input) => { args = input; return { content: '{}' }; },
    } };
    await requestModel(context, { ...config, apiMode: 'profile', profileId: 'profile-1' }, messages, new AbortController().signal);
    assert.equal(args[0], 'profile-1');
    assert.equal(args[3].includePreset, true);
    assert.equal(args[3].stream, false);
    assert.equal(Object.hasOwn(args[4], 'custom_prompt_post_processing'), false);
    assert.equal(Object.hasOwn(args[4], 'reverse_proxy'), false);
});

test('a missing saved profile fails without falling back to another connection', async () => {
    const { requestModel } = await loadRelay();
    const context = { ConnectionManagerRequestService: { getSupportedProfiles: () => [], sendRequest: unexpected } };
    await assert.rejects(() => requestModel(context, { ...config, apiMode: 'profile', profileId: 'missing' }, messages, new AbortController().signal), /连接已失效/);
});

test('server error envelopes redact scheme credentials even on HTTP 200', async () => {
    const { requestModel } = await loadRelay({ fetch: async () => response({ error: { message: 'proxy failed: mock-key mock-router-token Basic mock-auth' } }) });
    await assert.rejects(() => requestModel({ getRequestHeaders }, customConfig(scheme), messages, new AbortController().signal), error => {
        assert.match(error.message, /酒馆后端生成失败：proxy failed/);
        assert.doesNotMatch(error.message, /mock-key|mock-router-token|mock-auth/);
        return true;
    });
});

test('unsupported current API and reasoning-only output fail explicitly', async () => {
    const { requestModel } = await loadRelay({ createGenerationParameters: async () => ({ generate_data: {} }),
        fetch: async () => response({ choices: [{ message: { content: '', reasoning: 'thinking' } }] }) });
    await assert.rejects(() => requestModel({ mainApi: 'kobold' }, config, messages, new AbortController().signal), /仅支持酒馆的聊天补全/);
    const context = { mainApi: 'openai', chatCompletionSettings: {}, getChatCompletionModel: () => 'm', getRequestHeaders };
    await assert.rejects(() => requestModel(context, config, messages, new AbortController().signal), /未返回正文/);
});

test('pre-abort sends no request; cancellation and timeout still settle a pending backend call', async () => {
    let requests = 0;
    const { requestModel } = await loadRelay({ fetch: () => { requests++; return new Promise(() => {}); } });
    const context = { getRequestHeaders };
    const abort = new AbortController();
    abort.abort(new Error('already cancelled'));
    await assert.rejects(() => requestModel(context, customConfig(scheme), messages, abort.signal), /already cancelled/);
    assert.equal(requests, 0);
    const active = new AbortController();
    const pending = requestModel(context, customConfig(scheme), messages, active.signal);
    active.abort(new Error('cancelled'));
    await assert.rejects(() => pending, /cancelled/);
    const quick = { ...customConfig(scheme), timeoutSeconds: 0.01 };
    await assert.rejects(() => requestModel(context, quick, messages, new AbortController().signal), /超时/);
});
