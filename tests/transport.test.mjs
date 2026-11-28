import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadTransport(createGenerationParameters) {
    const context = vm.createContext({ AbortController, structuredClone, setTimeout, clearTimeout });
    const source = await readFile(new URL('../src/api/transport.js', import.meta.url), 'utf8');
    const transport = new vm.SourceTextModule(source, { context });
    const dependency = new vm.SyntheticModule(['createGenerationParameters'], function () {
        this.setExport('createGenerationParameters', createGenerationParameters);
    }, { context });
    const connectionSource = await readFile(new URL('../src/api/api-connections.js', import.meta.url), 'utf8');
    const connections = new vm.SourceTextModule(connectionSource, { context });
    const core = new vm.SyntheticModule(['MODULE'], function () { this.setExport('MODULE', 'lorebook-director'); }, { context });
    await transport.link(specifier => {
        if (specifier.endsWith('/openai.js')) return dependency;
        if (specifier === './api-connections.js') return connections;
        if (specifier === '../scheduler/core.js') return core;
        throw new Error(`Unexpected test import: ${specifier}`);
    });
    await transport.evaluate();
    return transport.namespace.requestModel;
}

const messages = [{ role: 'system', content: 'select JSON' }, { role: 'user', content: 'catalog' }];
const config = { profileId: '', timeoutSeconds: 10 };

test('current connection uses a settings clone, disables tools/streaming and preserves endpoint routing', async () => {
    let received;
    let sent;
    const request = await loadTransport(async (settings, model, type, input) => {
        received = { settings, model, type, input };
        return { generate_data: { messages: input, model, custom_url: settings.custom_url,
            stream: true, n: 9, tools: [{}], stop: ['END'], logit_bias: { 1: 20 } } };
    });
    const settings = { custom_url: 'https://example.invalid/v1', openai_max_tokens: 8000, stream_openai: true, function_calling: true };
    const original = structuredClone(settings);
    const context = {
        mainApi: 'openai', chatCompletionSettings: settings,
        getChatCompletionModel: () => 'configured-model',
        ChatCompletionService: { sendRequest: async (data, extract, signal) => { sent = { data, extract, signal }; return { content: '{"selected":[]}' }; } },
    };
    await request(context, config, messages, new AbortController().signal, 1234);
    assert.deepEqual(settings, original);
    assert.equal(received.settings.openai_max_tokens, 1234);
    assert.equal(received.settings.function_calling, false);
    assert.equal(received.type, 'quiet');
    assert.equal(sent.data.custom_url, settings.custom_url);
    assert.equal(sent.data.stream, false);
    assert.equal(sent.data.n, 1);
    assert.equal(sent.data.tools, undefined);
    assert.equal(sent.data.stop, undefined);
    assert.equal(sent.data.logit_bias, undefined);
});

test('saved profile goes through connection manager without changing current connection', async () => {
    const request = await loadTransport(() => { throw new Error('must not build current connection'); });
    let args;
    const context = { ConnectionManagerRequestService: { sendRequest: async (...input) => { args = input; return { content: '{}' }; } } };
    await request(context, { ...config, profileId: 'profile-1' }, messages, new AbortController().signal);
    assert.equal(args[0], 'profile-1');
    assert.equal(args[3].stream, false);
    assert.equal(args[3].includePreset, true);
});

test('a missing saved profile fails, rather than falling back to the current connection', async () => {
    const request = await loadTransport(() => { throw new Error('unexpected fallback'); });
    const context = { ConnectionManagerRequestService: { sendRequest: async () => { throw new Error('Profile not found'); } } };
    await assert.rejects(() => request(context, { ...config, profileId: 'missing' }, messages, new AbortController().signal), /Profile not found/);
});

test('unsupported current API and empty/reasoning-only output produce explicit errors', async () => {
    const request = await loadTransport(async () => ({ generate_data: {} }));
    await assert.rejects(() => request({ mainApi: 'kobold' }, config, messages, new AbortController().signal), /仅支持聊天补全/);
    const context = { mainApi: 'openai', chatCompletionSettings: {}, getChatCompletionModel: () => 'm', ChatCompletionService: { sendRequest: async () => ({ content: '', reasoning: 'thinking' }) } };
    await assert.rejects(() => request(context, config, messages, new AbortController().signal), /未返回正文/);
});

test('pre-aborted signal sends no request', async () => {
    let called = false;
    const request = await loadTransport(() => { called = true; });
    const abort = new AbortController(); abort.abort(new Error('user cancelled'));
    await assert.rejects(() => request({}, config, messages, abort.signal), /user cancelled/);
    assert.equal(called, false);
});

test('abort and timeout settle even if underlying provider ignores AbortSignal', async () => {
    const request = await loadTransport(async () => ({ generate_data: {} }));
    const context = { mainApi: 'openai', chatCompletionSettings: {}, getChatCompletionModel: () => 'm', ChatCompletionService: { sendRequest: () => new Promise(() => {}) } };
    const abort = new AbortController();
    const pending = request(context, config, messages, abort.signal);
    abort.abort(new Error('cancelled'));
    await assert.rejects(() => pending, /cancelled/);
    await assert.rejects(() => request(context, { ...config, timeoutSeconds: 0.01 }, messages, new AbortController().signal), /超时/);
});
