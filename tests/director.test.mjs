import test from 'node:test';
import assert from 'node:assert/strict';
import { LorebookDirector } from '../src/scheduler/director.js';
import { MODULE, entryId, entryVersion, settingsWithDefaults } from '../src/scheduler/core.js';

const optional = { world: '商会', uid: 6, comment: '问候礼仪', content: '贵客见面击掌', key: ['行礼'], position: 0 };
const sorted = payload => payload.globalLore.map(entry => ({ ...structuredClone(entry), decorators: [], hash: entryId(entry) }));
const decision = (selected = []) => JSON.stringify({ selected });
const choice = entry => ({ id: entryId(entry), reason: '与当前行动直接相关' });

function fixture(settings = {}) {
    const entries = [
        { world: '商会', uid: 1, comment: '交易规则', content: '赃物不可出售', key: ['交易'], position: 4, depth: 2 },
        { world: '商会', uid: 2, comment: '历史', content: '三百年前的历史', key: ['历史'], constant: true },
        { world: '商会', uid: 3, content: '保留原生向量设定', vectorized: true },
        { world: '外部', uid: 4, content: '不受接管的规则', constant: true },
        { world: '无目录', uid: 5, content: '未整理原文', key: ['交易'] },
    ];
    const cards = new Map(entries.map(entry => [entryId(entry), { summary: '用于检索的说明', category: '商贸', ancestors: [] }]));
    const ctx = {
        chatId: 'chat-1', characterId: 0, groupId: null, eventTypes: { WORLDINFO_SCAN_DONE: 'scan' },
        chat: [{ is_user: false, name: '店主', mes: '你来到柜台。' }, { is_user: true, name: '玩家', mes: '出售戒指。' }],
        chatMetadata: {}, extensionSettings: { [MODULE]: settingsWithDefaults({
            enabled: true, books: ['商会', '无目录'], promptRoleVersion: 2,
            promptTemplates: { selector: [{ id: 'wire', name: '本轮数据', role: 'user', content: '{{echo_selection_input}}' }] },
            ...settings,
        }) },
        getTokenCountAsync: async () => 20, substituteParams: text => text,
        saveSettingsDebounced() {}, saveMetadataDebounced() { this.saves = (this.saves || 0) + 1; },
    };
    const payload = () => ({ globalLore: structuredClone(entries), characterLore: [], chatLore: [], personaLore: [] });
    const requests = [];
    let responder = async () => decision([choice(entries[0])]);
    const native = {
        positions: { before: 0, after: 1 },
        unindexed: new Set(['无目录']),
        associations: () => new Map(entries.map(entry => [entry.world, {}])),
        schedulerBooks: books => books.filter(book => native.associations().has(book)).sort(),
        schedulerSnapshot: async managed => {
            const mountedBooks = native.schedulerBooks(managed);
            const books = mountedBooks.filter(book => !native.unindexed.has(book));
            const source = entries.filter(entry => books.includes(entry.world));
            return {
                mountedBooks, books, unindexedBooks: mountedBooks.filter(book => native.unindexed.has(book)),
                versions: new Map(source.map(entry => [entryId(entry), entryVersion(entry)])),
                cards: new Map(source.map(entry => [entryId(entry), structuredClone(cards.get(entryId(entry)))])),
            };
        },
        schedulerApplicable: (entry, type) => !entry.triggers?.length || entry.triggers.includes(type),
        assertSchedulerSlots() {},
        recoverSchedulerScan: async (_chat, _size, _type, _entries, guard) => { guard(); return [entries[0]]; },
    };
    const director = new LorebookDirector({
        getContext: () => ctx, native,
        getEntries: async () => {
            const raw = payload();
            director.onEntriesLoaded(raw);
            return sorted(raw);
        },
        requestModel: async (...args) => {
            requests.push(args);
            args[5].onDispatch({ model: 'fixture' });
            return responder(...args);
        },
    });
    const add = entry => { entries.push(entry); cards.set(entryId(entry), { summary: '补充说明', category: '礼仪', ancestors: [] }); };
    return { director, native, ctx, entries, cards, add, requests, payload, respond: fn => { responder = fn; } };
}

const sent = (fixture, index = 0) => JSON.parse(fixture.requests[index][2][0].content);
const run = (f, type = 'normal', chat = f.ctx.chat) => {
    f.director.startGeneration(type);
    return f.director.intercept(chat, 32000, () => {}, type);
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const scanArgs = raw => ({ sortedEntries: sorted(raw), activated: { entries: new Map(), text: '' }, state: { next: 1 } });

test('disabled, unmounted-only and non-foreground operations make no auxiliary request', async () => {
    const disabled = fixture({ enabled: false });
    const unmounted = fixture({ books: ['未挂载'] });
    const extensionDisabled = fixture();
    extensionDisabled.ctx.extensionSettings.disabledExtensions = ['third-party/lorebook-director'];
    for (const f of [disabled, unmounted, extensionDisabled]) {
        await run(f);
        assert.equal(f.requests.length, 0);
        assert.equal(f.director.gate, null);
    }
    for (const type of ['quiet', 'impersonate']) {
        const f = fixture();
        await run(f, type);
        assert.equal(f.requests.length, 0);
    }
});

test('generation sends only green cards, maps selected lore into host slots, and leaves native lore alone', async () => {
    const f = fixture();
    const legacy = { snapshots: [{ scene: '旧场景不读取' }], overrides: {} };
    f.ctx.chatMetadata[MODULE] = structuredClone(legacy);
    await run(f);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(sent(f).recentChat, [{ name: '店主', role: 'assistant', text: '你来到柜台。' }]);
    assert.equal(sent(f).latestUserMessage.text, '出售戒指。');
    assert.deepEqual(sent(f).greenCandidates, [{
        id: entryId(f.entries[0]), book: '商会', title: '交易规则', category: '商贸', keywords: ['交易'], summary: '用于检索的说明',
    }]);
    const messages = JSON.stringify(f.requests[0][2]);
    for (const entry of f.entries) assert.equal(messages.includes(entry.content), false);
    for (const field of ['replyPlan', 'scene', 'characterContext', 'blueEntries', 'fixedGreenEntries']) assert.equal(Object.hasOwn(sent(f), field), false);
    assert.deepEqual(f.director.report.unindexedBooks, ['无目录']);
    const raw = f.payload();
    const originals = [...raw.globalLore];
    f.director.onEntriesLoaded(raw);
    assert.deepEqual(raw.globalLore.map(entry => entry.disable), [true, true, undefined, undefined, undefined]);
    for (const entry of originals.slice(2)) assert.equal(raw.globalLore.find(item => item.uid === entry.uid), entry);
    const scan = scanArgs(raw);
    scan.activated.entries.set('外部.4', scan.sortedEntries[3]);
    await f.director.onScanDone(scan);
    const included = [...scan.activated.entries.values()];
    assert.deepEqual(included.filter(entry => entry.world === '商会').map(entry => [entry.content, entry.position]),
        [['三百年前的历史', 1], ['赃物不可出售', 1]]);
    assert.equal(raw.globalLore[0], originals[0]);
    assert.equal(f.entries[0].position, 4);
    f.director.onActivated(included);
    f.director.onPromptReady({ prompt: '正文' });
    assert.equal(f.director.gate, null);
    assert.equal(f.director.report.construction, 'prepared');
    assert.deepEqual(f.director.report.actual, [entryId(f.entries[1]), entryId(f.entries[0])]);
    assert.deepEqual(f.ctx.chatMetadata[MODULE], legacy);
    assert.equal(f.ctx.saves, undefined);
});

test('all unindexed books fail open with no auxiliary model and no scan gate', async () => {
    const f = fixture({ books: ['无目录'] });
    await run(f);
    assert.equal(f.requests.length, 0);
    assert.equal(f.director.gate, null);
    assert.deepEqual(f.director.report.unindexedBooks, ['无目录']);
    assert.equal(f.director.report.construction, 'empty');
    const raw = f.payload();
    f.director.onEntriesLoaded(raw);
    assert.equal(raw.globalLore[4].disable, undefined);
});

test('inherited rules apply only to eligible greens; per-child auto can exempt a parent exclusion', async () => {
    const f = fixture();
    const parent = entryId({ world: '商会', uid: 10 });
    const child = entryId(f.entries[0]);
    f.cards.get(child).ancestors = ['10'];
    f.ctx.chatMetadata[MODULE] = { overrides: { [parent]: 'exclude', [entryId(f.entries[1])]: 'exclude' } };
    await f.director.preview();
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.director.report.skipped.map(item => item.id), [child]);
    assert.deepEqual(f.director.report.blue.map(item => item.id), [entryId(f.entries[1])]);
    assert.equal(f.director.overrideMode(child), 'exclude');
    f.director.setOverride(child, 'auto', ['10']);
    assert.equal(f.director.state().overrides[parent], 'exclude');
    assert.equal(f.director.state().overrides[child], 'auto');
    assert.equal(f.director.overrideMode(child), 'auto');
    await f.director.preview();
    assert.deepEqual(sent(f).greenCandidates.map(item => item.id), [child]);
    assert.deepEqual(f.director.report.selected.map(item => item.id), [child]);
});

test('a full fixed count or token budget skips the model while fixed and blue lore stay included', async () => {
    for (const budget of ['count', 'tokens']) {
        const f = fixture(budget === 'count' ? { maxEntries: 1 } : { tokenBudget: 128 });
        f.add(optional);
        if (budget === 'tokens') f.ctx.getTokenCountAsync = async text => text === f.entries[0].content ? 124 : 20;
        f.director.state().overrides[entryId(f.entries[0])] = 'pin';
        await run(f);
        assert.equal(f.requests.length, 0);
        assert.equal(f.director.report.greenCandidates, 1);
        assert.match(f.director.report.apiSkipReason, /固定绿灯/);
        assert.deepEqual(f.director.report.selected.map(item => item.id), [entryId(f.entries[0])]);
        assert.equal(f.director.report.blue.length, 1);
        assert.equal(f.director.gate.prepared.length, 2);
    }
});

test('preview shows remaining budget after fixed choices without sending fixed bodies or writing metadata', async () => {
    const f = fixture({ enabled: false });
    f.add(optional);
    f.director.state().overrides[entryId(f.entries[0])] = 'pin';
    f.respond(async () => decision([choice(optional)]));
    await f.director.preview();
    assert.deepEqual(sent(f).greenCandidates.map(item => item.id), [entryId(optional)]);
    assert.equal(sent(f).remainingGreenTokenBudget, 1776);
    assert.equal(sent(f).maxAdditionalGreenEntries, 7);
    assert.equal(f.director.gate, null);
    assert.equal(f.director.report.mode, 'preview');
    assert.equal(f.ctx.saves, undefined);
});

test('invalid response, unknown ID, API failure or changed index fails open', async () => {
    for (const responder of [async () => 'invalid', async () => decision([{ id: 'fake', reason: '无效' }]), async () => { throw new Error('API down'); }]) {
        const f = fixture();
        f.respond(responder);
        await run(f);
        assert.equal(f.director.gate, null);
        assert.equal(f.director.report.mode, 'fallback');
        const raw = f.payload();
        f.director.onEntriesLoaded(raw);
        assert.equal(raw.globalLore[0].disable, undefined);
    }
    const f = fixture();
    f.respond(async () => {
        f.cards.get(entryId(f.entries[0])).summary = '等待期间目录改变';
        return decision([choice(f.entries[0])]);
    });
    await run(f);
    assert.equal(f.director.gate, null);
    assert.equal(f.director.report.mode, 'fallback');
});

test('latest raw source verification blocks masking, and a cancelled masked scan recovers native entries', async () => {
    const f = fixture();
    await run(f);
    const changed = f.payload();
    changed.globalLore[0].content = '等待扫描时原生来源变化';
    f.director.onEntriesLoaded(changed);
    assert.equal(changed.globalLore[0].disable, undefined);
    assert.equal(f.director.report.mode, 'fallback');

    await run(f);
    const raw = f.payload();
    f.director.onEntriesLoaded(raw);
    const scan = scanArgs(raw);
    assert.equal(scan.sortedEntries[0].disable, true);
    f.director.invalidate('同一聊天的调度设置改变');
    await f.director.onScanDone(scan);
    assert.equal(raw.globalLore[0].disable, undefined);
    assert.equal(scan.sortedEntries[0].disable, undefined);
    assert.deepEqual([...scan.activated.entries.values()], [f.entries[0]]);
    assert.equal(scan.state.next, 0);
});

test('a stop or chat edit during an in-flight request cannot create a stale gate', async () => {
    for (const action of ['stop', 'edit']) {
        const f = fixture();
        const pending = deferred();
        const entered = deferred();
        f.respond(async () => { entered.resolve(); return pending.promise; });
        const running = run(f);
        await entered.promise;
        if (action === 'stop') f.director.stopGeneration();
        else f.ctx.chat[1].mes = '前往城门。';
        pending.resolve(decision([choice(f.entries[0])]));
        await running;
        assert.equal(f.director.gate, null);
        assert.equal(f.director.report.mode, action === 'stop' ? 'cancelled' : 'fallback');
    }
});

test('swipe and continue use host-provided chat rather than a rejected reply or unsent draft', async () => {
    const f = fixture();
    f.ctx.chat.push({ is_user: false, mes: '已有的 AI 回复前缀' });
    await run(f, 'swipe', f.ctx.chat.slice(0, -1));
    assert.equal(sent(f).recentChat.at(-1).text, '你来到柜台。');
    assert.equal(sent(f).latestUserMessage.text, '出售戒指。');
    await run(f, 'continue');
    assert.equal(sent(f, 1).recentChat.at(-1).text, '已有的 AI 回复前缀');
});
