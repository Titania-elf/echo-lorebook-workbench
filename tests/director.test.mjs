import test from 'node:test';
import assert from 'node:assert/strict';
import { LorebookDirector } from '../director.js';
import { MODULE, entryId, settingsWithDefaults, historyChain, recordSnapshot } from '../core.js';

function fixture(overrides = {}) {
    const entries = [
        { world: '商会', uid: 1, comment: '交易规则', content: '赃物不可出售', key: ['交易'], constant: false, position: 4, depth: 2 },
        { world: '商会', uid: 2, comment: '历史', content: '三百年前的历史', key: ['历史'], constant: true },
        { world: '外部', uid: 3, content: '不受接管的规则', constant: true },
    ];
    const ctx = {
        chatId: 'chat-1', characterId: 0, groupId: null,
        chat: [{ is_user: false, name: '店主', mes: '你来到柜台。' }, { is_user: true, name: '玩家', mes: '出售戒指。' }],
        chatMetadata: {}, extensionSettings: { [MODULE]: settingsWithDefaults({ enabled: true, books: ['商会'], ...overrides }) },
        getTokenCountAsync: async () => 20, substituteParams: text => text,
        saveSettingsDebounced() {}, saveMetadataDebounced() { this.saves = (this.saves || 0) + 1; },
    };
    const requests = [];
    let responder = async () => JSON.stringify({ scene: '商会柜台', selected: [{ id: entryId(entries[0]), scope: 'scene', reason: '正在出售物品' }] });
    const director = new LorebookDirector({
        getContext: () => ctx,
        getEntries: async () => structuredClone(entries),
        requestModel: async (...args) => { requests.push(args); return responder(...args); },
    });
    const payload = () => ({ globalLore: structuredClone(entries), characterLore: [], chatLore: [], personaLore: [] });
    return { director, ctx, entries, requests, payload, respond: fn => { responder = fn; } };
}
const run = (f, type = 'normal') => f.director.intercept(f.ctx.chat, 32000, () => {}, type);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('disabled extension, no managed books, and non-foreground modes send no request', async () => {
    for (const config of [{ enabled: false }, { books: [] }]) {
        const f = fixture(config); await run(f); assert.equal(f.requests.length, 0);
    }
    for (const type of ['quiet', 'impersonate']) {
        const f = fixture(); await run(f, type); assert.equal(f.requests.length, 0);
    }
    const f = fixture(); f.ctx.extensionSettings.disabledExtensions = ['third-party/lorebook-director'];
    await run(f); assert.equal(f.requests.length, 0);
});

test('generation selects before scan, preserves native placement, and saves only actually activated scene entries', async () => {
    const f = fixture();
    await run(f);
    assert.equal(f.requests.length, 1);
    const sent = JSON.parse(f.requests[0][2][1].content);
    assert.equal(sent.recentChat.at(-1).text, '出售戒指。');
    const scan = f.payload(); f.director.onEntriesLoaded(scan);
    assert.equal(scan.globalLore[0].constant, true);
    assert.equal(scan.globalLore[0].depth, 2);
    assert.equal(scan.globalLore[1].disable, true);
    assert.equal(scan.globalLore[2].disable, undefined);
    assert.equal(f.entries[1].disable, undefined);
    f.director.onActivated([scan.globalLore[0], scan.globalLore[2]]);
    f.director.onPromptReady();
    assert.equal(f.director.gate, null);
    assert.equal(f.ctx.saves, 1);
    assert.equal(f.director.state().snapshots[0].selected.length, 1);
    assert.match(f.director.status, /原生激活 1/);
    const later = f.payload(); f.director.onEntriesLoaded(later);
    assert.equal(later.globalLore[1].disable, undefined);
});

test('selected but native-filtered entries are not reported as activated or retained', async () => {
    const f = fixture(); await run(f); f.director.onPromptReady();
    assert.deepEqual(f.director.report.actual, []);
    assert.equal(f.director.state().snapshots[0].selected.length, 0);
});

test('preview performs selection but does not gate, write metadata or inject', async () => {
    const f = fixture({ enabled: false }); await f.director.preview();
    assert.equal(f.requests.length, 1);
    assert.equal(f.director.gate, null);
    assert.equal(f.ctx.saves, undefined);
    assert.equal(f.director.report.mode, 'preview');
    const scan = f.payload(); f.director.onEntriesLoaded(scan);
    assert.equal(scan.globalLore[1].disable, undefined);
});

test('invalid JSON, invented ID, and API failure explicitly fail open', async () => {
    for (const responder of [async () => 'invalid', async () => '{"scene":"x","selected":[{"id":"fake","scope":"scene"}]}', async () => { throw new Error('API down'); }]) {
        const f = fixture(); f.respond(responder); await run(f);
        assert.equal(f.director.gate, null);
        assert.equal(f.director.report.mode, 'fallback');
        const scan = f.payload(); f.director.onEntriesLoaded(scan);
        assert.equal(scan.globalLore[1].disable, undefined);
        assert.match(f.director.status, /回退原生/);
        assert.equal(f.ctx.saves, undefined);
    }
});

test('empty selection suppresses all managed entries; pin/exclude-only mode skips model call', async () => {
    const f = fixture(); f.respond(async () => '{"scene":"离开了商会","selected":[]}');
    await run(f); const scan = f.payload(); f.director.onEntriesLoaded(scan);
    assert.equal(scan.globalLore[0].disable, true);
    assert.equal(scan.globalLore[1].disable, true);
    const manual = fixture();
    manual.director.state().overrides = { [entryId(manual.entries[0])]: 'pin', [entryId(manual.entries[1])]: 'exclude' };
    await run(manual);
    assert.equal(manual.requests.length, 0);
    assert.deepEqual(manual.director.report.selected.map(x => x.id), [entryId(manual.entries[0])]);
});

test('stop / chat switch / disable discards late response without leaving an injection gate', async () => {
    for (const action of ['stop', 'chat', 'disable']) {
        const f = fixture(); const pending = deferred(); const entered = deferred();
        f.respond(() => { entered.resolve(); return pending.promise; });
        const running = run(f); await entered.promise;
        if (action === 'chat') { f.ctx.chatId = 'chat-2'; f.ctx.chatMetadata = {}; }
        if (action === 'disable') f.director.updateSettings({ enabled: false });
        else f.director.invalidate('cancel', action === 'chat');
        pending.resolve('{"scene":"旧场景","selected":[]}'); await running;
        assert.equal(f.director.gate, null);
        assert.equal(f.director.state().snapshots.length, 0);
        assert.equal(f.requests[0][3].aborted, true);
    }
});

test('context edit during model response is caught even without an event', async () => {
    const f = fixture();
    f.respond(async () => { f.ctx.chat[1].mes = '现在去城门'; return '{"scene":"柜台","selected":[]}'; });
    await run(f); assert.equal(f.director.gate, null); assert.equal(f.director.report.mode, 'fallback');
});

test('late old operation cannot replace a newer selection', async () => {
    const f = fixture(); const pending = deferred(); const entered = deferred(); let first = true;
    f.respond(async () => {
        if (first) { first = false; entered.resolve(); return pending.promise; }
        return '{"scene":"新请求场景","selected":[]}';
    });
    const old = run(f); await entered.promise;
    f.director.invalidate('another generation, including dry/quiet');
    await run(f);
    pending.resolve('{"scene":"旧请求场景","selected":[]}'); await old;
    assert.equal(f.director.report.scene, '新请求场景');
    assert.equal(f.director.gate.result.scene, '新请求场景');
});

test('native preview/quiet start invalidates foreground gate instead of inheriting it', async () => {
    const f = fixture(); await run(f);
    f.director.invalidate('GENERATION_STARTED dry run');
    const scan = f.payload(); f.director.onEntriesLoaded(scan);
    assert.equal(scan.globalLore[1].disable, undefined);
    f.director.onPromptReady(); assert.equal(f.ctx.saves, undefined);
});

test('continue sees continuation prefix; regenerate/swipe use supplied coreChat rather than rejected answer', async () => {
    const f = fixture(); f.ctx.chat.push({ is_user: false, mes: '不希望延续的旧回答' });
    const coreChat = f.ctx.chat.slice(0, -1);
    await f.director.intercept(coreChat, 32000, () => {}, 'swipe');
    const payload = JSON.parse(f.requests[0][2][1].content);
    assert.equal(payload.recentChat.at(-1).text, '出售戒指。');
    f.director.invalidate(); await run(f, 'continue');
    assert.equal(JSON.parse(f.requests[1][2][1].content).recentChat.at(-1).text, '不希望延续的旧回答');
});

test('scene working set follows matching chat prefix; an edited branch drops old state', async () => {
    const f = fixture();
    f.director.state().snapshots = recordSnapshot([], f.ctx.chat, { scene: '旧柜台', selected: [{ id: entryId(f.entries[0]), scope: 'scene', reason: '交易' }] });
    f.ctx.chat.push({ is_user: false, mes: '店主问你价格。' });
    await run(f);
    assert.equal(JSON.parse(f.requests[0][2][1].content).previousScene, '旧柜台');
    f.director.invalidate(); f.ctx.chat[1].mes = '去城门'; await run(f);
    assert.equal(JSON.parse(f.requests[1][2][1].content).previousScene, '');
    assert.ok(historyChain(f.ctx.chat).at(-1));
});

test('AI directory is cached per source and malformed batches are not partially saved', async () => {
    const f = fixture();
    f.respond(async (_ctx, _config, messages) => {
        const items = JSON.parse(messages[1].content);
        return JSON.stringify({ summaries: items.map(x => ({ id: x.id, text: '说明：' + x.title })) });
    });
    await f.director.summarize(); assert.equal(f.requests.length, 1);
    assert.equal(f.director.catalog.every(x => x.summaryKind === 'AI 概括'), true);
    await f.director.summarize(); assert.equal(f.requests.length, 1);
    f.entries[0].content = '修改过的交易规则';
    await f.director.summarize(); assert.equal(f.requests.length, 2);
    assert.equal(JSON.parse(f.requests[1][2][1].content).length, 1);
    const invalid = fixture(); invalid.respond(async () => '{"summaries":[{"id":"fake","text":"bad"}]}');
    await invalid.director.summarize(); assert.deepEqual(invalid.director.config.summaries, {});
});

test('AI directory does not send truncated long entries pretending to summarize the full content', async () => {
    const f = fixture(); f.entries[0].content = '很'.repeat(10001);
    f.respond(async (_ctx, _config, messages) => JSON.stringify({ summaries: JSON.parse(messages[1].content).map(x => ({ id: x.id, text: '历史' })) }));
    await f.director.summarize();
    assert.equal(JSON.parse(f.requests[0][2][1].content).length, 1);
    assert.equal(f.director.catalog[0].summaryKind, '原文摘录');
    assert.match(f.director.status, /1 条超过/);
});
