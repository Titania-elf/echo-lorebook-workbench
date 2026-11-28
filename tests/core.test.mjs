import test from 'node:test';
import assert from 'node:assert/strict';
import {
    settingsWithDefaults, entryId, entryVersion, sourceFingerprint, makeCatalog,
    validateSelection, parseJsonObject, allocateSelection, resolveOverride, selectorPayload,
} from '../src/scheduler/core.js';

const entry = (uid, extra = {}) => ({ world: '北境', uid, comment: `条目 ${uid}`, content: `原文 ${uid}`, key: ['商会'], ...extra });
const card = (uid, ancestors = []) => ({ category: '地点', summary: `检索说明 ${uid}`, ancestors });
const config = settingsWithDefaults({ books: ['北境'], maxEntries: 2, tokenBudget: 128, recentMessages: 1 });
const chat = [
    { is_user: false, name: '旁白', mes: '本轮不读取的较旧回复。' },
    { is_system: true, mes: '系统消息不纳入。' },
    { is_user: false, name: '店主', mes: '你来到商会。' },
    { is_user: false, mes: '  ' },
    { is_user: true, name: '玩家', mes: '我递出戒指。' },
];
const catalogFor = entries => makeCatalog(entries, config.books, {
    cards: new Map(entries.map(item => [entryId(item), card(item.uid)])),
});
const choice = item => ({ id: item.id, reason: '当前需要' });

test('settings opt in, normalize values, and migrate away from pre-v2 custom roles and prompts', () => {
    const legacy = {
        books: ['a', 'a', null], maxEntries: -5, tokenBudget: Infinity, timeoutSeconds: 900,
        apiMode: 'scheme', apiSchemeId: 'custom', apiSchemes: [{ id: 'custom', model: 'configured' }],
        promptRoleVersion: 1, promptTemplates: { selector: [{ id: 'custom', name: '自定义', role: 'assistant', content: '旧提示词' }] },
    };
    const defaults = settingsWithDefaults();
    const value = settingsWithDefaults(legacy);
    assert.equal(defaults.enabled, false);
    assert.deepEqual(value.books, ['a']);
    assert.equal(value.maxEntries, 1);
    assert.equal(value.tokenBudget, 1800);
    assert.equal(value.timeoutSeconds, 180);
    assert.equal(value.apiMode, 'scheme');
    assert.equal(value.apiSchemeId, 'custom');
    assert.equal(value.apiSchemes[0].model, 'configured');
    assert.equal(value.promptRoleVersion, 2);
    assert.deepEqual(value.promptTemplates, defaults.promptTemplates);
    assert.equal(settingsWithDefaults({ ...legacy, promptRoleVersion: 2 }).promptTemplates.selector[0].role, 'assistant');
});

test('entry IDs and saved-source comparisons remain stable', () => {
    assert.notEqual(entryId({ world: 'a.1', uid: 2 }), entryId({ world: 'a', uid: '1.2' }));
    assert.deepEqual(JSON.parse(entryId({ world: '北境"/书', uid: 0 })), ['北境"/书', '0']);
    const a = entry(1);
    assert.equal(entryVersion(a), entryVersion({ key: a.key, uid: '1', comment: a.comment, content: a.content }));
    assert.notEqual(sourceFingerprint(a), sourceFingerprint({ ...a, content: '已修改' }));
});

test('only managed, indexed, enabled, applicable and supported entries enter the catalog', () => {
    const entries = [entry(1), entry(1), entry(2, { disable: true }), entry(3, { content: '' }),
        entry(4, { world: '未托管' }), entry(5, { vectorized: true }),
        entry(6, { constant: true, vectorized: true }), entry(7), entry(8)];
    const cards = new Map(entries.filter(item => item.uid !== 7).map(item => [entryId(item), card(item.uid)]));
    const before = structuredClone(entries);
    const catalog = makeCatalog(entries, config.books, { cards, applicable: item => item.uid !== 8 });
    assert.deepEqual(catalog.map(x => [x.entry.uid, x.kind, x.summary]), [[1, 'green', '检索说明 1'], [6, 'blue', '检索说明 6']]);
    assert.deepEqual(entries, before);
});

test('strict JSON parser allows fences but rejects chatter and partial output', () => {
    assert.deepEqual(parseJsonObject('```json\n{"x":1}\n```'), { x: 1 });
    for (const bad of ['好的 {"x":1}', '{"x":', '[]', 'null']) assert.throws(() => parseJsonObject(bad));
});

test('selector validates candidate IDs and reasons and returns only those fields', () => {
    const catalog = catalogFor([entry(1), entry(2, { constant: true })]);
    const [green, blue] = catalog;
    const select = selected => JSON.stringify({ scene: ['ignored'], replyPlan: { ignored: true }, selected });
    assert.deepEqual(validateSelection(select([]), catalog), { selected: [] });
    assert.deepEqual(validateSelection(select([{ ...choice(green), scope: 'ignored' }, choice(green)]), catalog), { selected: [choice(green)] });
    for (const invalid of [{ id: 'invented', reason: '有理由' }, choice(blue), { id: green.id, reason: '  ' }]) {
        assert.throws(() => validateSelection(select([invalid]), catalog));
    }
    assert.throws(() => validateSelection('{}', catalog));
});

test('fixed greens have priority; exclusions and budget omissions are reported without truncation', async () => {
    const catalog = catalogFor([entry(1), entry(2), entry(3)]);
    const [excluded, optional, fixed] = catalog;
    const result = await allocateSelection({ selected: catalog.map(choice) }, catalog,
        { [fixed.id]: 'pin', [excluded.id]: 'exclude' }, config, async () => 70);
    assert.deepEqual(result.selected.map(x => x.id), [fixed.id]);
    assert.equal(result.tokens, 74);
    assert.deepEqual(result.skipped.map(x => x.id), [excluded.id, optional.id]);
    assert.match(result.skipped[1].reason, /预算/);
    assert.equal(optional.entry.content, '原文 2');
});

test('count limits and oversized fixed entries remain visible; an omitted fixed entry does not consume budget', async () => {
    const catalog = catalogFor([entry(1), entry(2), entry(3)]);
    const choices = { selected: catalog.map(choice) };
    const countLimited = await allocateSelection(choices, catalog, {}, config, async () => 5);
    assert.equal(countLimited.selected.length, 2);
    assert.match(countLimited.skipped[0].reason, /数量/);
    const oversized = await allocateSelection(choices, catalog, { [catalog[0].id]: 'pin' }, config,
        async text => text === '原文 1' ? 1000 : 5);
    assert.match(oversized.skipped[0].reason, /预算/);
    assert.deepEqual(oversized.selected.map(x => x.id), catalog.slice(1).map(x => x.id));
    await assert.rejects(() => allocateSelection(choices, catalog, {}, config, async () => NaN));
});

test('legacy split rules prefer nearest pins/exclusions, with a per-entry auto exemption', () => {
    const [root, parent, child] = [1, 2, 3].map(uid => entryId(entry(uid)));
    const overrides = { [root]: 'pin', [parent]: 'exclude' };
    assert.equal(resolveOverride(overrides, child, ['2', '1']), 'exclude');
    assert.equal(resolveOverride({ ...overrides, [child]: 'pin' }, child, ['2', '1']), 'pin');
    assert.equal(resolveOverride({ ...overrides, [child]: 'auto' }, child, ['2', '1']), 'auto');
    assert.equal(resolveOverride({ ...overrides, [parent]: 'auto' }, child, ['2', '1']), 'pin');
    assert.equal(resolveOverride(overrides, entryId({ world: '别处', uid: 3 }), ['2', '1']), 'auto');
});

test('selector payload contains only directory cards, chat text and budget data', () => {
    const [item, blue] = catalogFor([entry(1, { keysecondary: ['辅助', '商会'] }), entry(2, { constant: true })]);
    assert.deepEqual(selectorPayload([{ ...item, content: '额外原文' }, blue], chat, config, { selected: [{ id: 'fixed' }], tokens: 24 }), {
        greenCandidates: [{ id: item.id, book: '北境', title: '条目 1', category: '地点', keywords: ['商会', '辅助'], summary: '检索说明 1' }],
        recentChat: [{ role: 'assistant', name: '店主', text: '你来到商会。' }],
        latestUserMessage: { role: 'user', name: '玩家', text: '我递出戒指。' },
        maxAdditionalGreenEntries: 1, remainingGreenTokenBudget: 104, greenTokenBudget: 128,
        history: { requested: 1, read: 1 },
    });
});
