import test from 'node:test';
import assert from 'node:assert/strict';
import {
    settingsWithDefaults, entryId, makeCatalog, validateSelection, parseJsonObject,
    allocateSelection, historyChain, previousSnapshot, recordSnapshot, recentContext,
    overlayEntries, selectorPayload, CATALOG_LIMIT,
} from '../core.js';

const entry = (uid, extra = {}) => ({ world: '北境', uid, comment: `条目 ${uid}`, content: '原文内容', key: ['商会'], ...extra });
const config = settingsWithDefaults({ books: ['北境'], maxEntries: 2, tokenBudget: 128 });
const chat = [
    { is_user: false, name: '店主', mes: '你来到商会。' },
    { is_user: true, name: '玩家', mes: '我递出戒指。' },
];
const json = (selected = [], scene = '商会') => JSON.stringify({ scene, selected });
const choice = (item, scope = 'scene') => ({ id: item.id, scope, reason: '当前需要' });

test('settings opt in, clamp values, and deduplicate books', () => {
    assert.equal(settingsWithDefaults().enabled, false);
    const value = settingsWithDefaults({ books: ['a', 'a', null], maxEntries: -5, tokenBudget: Infinity, timeoutSeconds: 900 });
    assert.deepEqual(value.books, ['a']);
    assert.equal(value.maxEntries, 1);
    assert.equal(value.tokenBudget, 1800);
    assert.equal(value.timeoutSeconds, 180);
});

test('entry IDs are unambiguous for punctuation and Unicode', () => {
    assert.notEqual(entryId({ world: 'a.1', uid: 2 }), entryId({ world: 'a', uid: '1.2' }));
    assert.deepEqual(JSON.parse(entryId({ world: '北境"/书', uid: 0 })), ['北境"/书', '0']);
});

test('catalog only includes enabled, nonempty, managed entries; original stays intact', () => {
    const inputs = [entry(1), entry(1), entry(2, { disable: true }), entry(3, { content: '' }), entry(4, { world: '未托管' })];
    const before = structuredClone(inputs);
    const catalog = makeCatalog(inputs, ['北境']);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].summaryKind, '原文摘录');
    assert.deepEqual(inputs, before);
});

test('AI summary is invalidated when source changes', () => {
    const original = entry(1);
    const [card] = makeCatalog([original], ['北境']);
    const cache = { [card.id]: { fingerprint: card.fingerprint, text: '交易规则' } };
    assert.equal(makeCatalog([original], ['北境'], cache)[0].summaryKind, 'AI 概括');
    assert.equal(makeCatalog([{ ...original, content: '修改后的设定' }], ['北境'], cache)[0].summaryKind, '原文摘录');
});

test('strict JSON parser allows fences but rejects chatter and partial output', () => {
    assert.deepEqual(parseJsonObject('```json\n{"x":1}\n```'), { x: 1 });
    for (const bad of ['好的 {"x":1}', '{"x":', '[]', 'null']) assert.throws(() => parseJsonObject(bad));
});

test('selector validates IDs, scope and shape; empty selection is valid', () => {
    const catalog = makeCatalog([entry(1)], ['北境']);
    assert.equal(validateSelection(json(), catalog).selected.length, 0);
    assert.equal(validateSelection(json([choice(catalog[0]), choice(catalog[0])]), catalog).selected.length, 1);
    assert.throws(() => validateSelection(json([{ id: 'invented', scope: 'scene' }]), catalog));
    assert.throws(() => validateSelection(json([choice(catalog[0], 'forever')]), catalog));
    assert.throws(() => validateSelection('{}', catalog));
});

test('budget prioritizes pins, rejects excluded entries, and does not truncate originals', async () => {
    const catalog = makeCatalog([entry(1), entry(2), entry(3)], ['北境']);
    const result = await allocateSelection({ scene: '商会', selected: catalog.map(x => choice(x)) }, catalog,
        { [catalog[2].id]: 'pin', [catalog[0].id]: 'exclude' }, config, async () => 70);
    assert.deepEqual(result.selected.map(x => x.id), [catalog[2].id]);
    assert.equal(result.tokens, 74);
    assert.equal(result.skipped.length, 2);
    assert.equal(catalog[2].entry.content, '原文内容');
});

test('count limit and oversized pinned entry are visible omissions', async () => {
    const catalog = makeCatalog([entry(1), entry(2), entry(3)], ['北境']);
    const choices = { scene: '', selected: catalog.map(x => choice(x)) };
    const countLimited = await allocateSelection(choices, catalog, {}, config, async () => 5);
    assert.equal(countLimited.selected.length, 2);
    assert.match(countLimited.skipped[0].reason, /数量/);
    const oversized = await allocateSelection({ scene: '', selected: [] }, catalog, { [catalog[0].id]: 'pin' }, config, async () => 1000);
    assert.equal(oversized.selected.length, 0);
    assert.match(oversized.skipped[0].reason, /预算/);
    await assert.rejects(() => allocateSelection(choices, catalog, {}, config, async () => NaN));
});

test('history follows matching prefixes, rejects edited/swiped branches and future snapshots', () => {
    const catalog = makeCatalog([entry(1), entry(2)], ['北境']);
    const snapshots = recordSnapshot([], chat, { scene: '柜台', selected: [choice(catalog[0]), choice(catalog[1], 'turn')] });
    assert.equal(snapshots[0].selected.length, 1);
    assert.equal(previousSnapshot(snapshots, historyChain([...chat, { mes: '然后呢' }])).scene, '柜台');
    const edited = structuredClone(chat); edited[1].mes = '我去了城门。';
    assert.equal(previousSnapshot(snapshots, historyChain(edited)), null);
    assert.equal(previousSnapshot(snapshots, historyChain(chat.slice(0, 1))), null);
    assert.equal(previousSnapshot(snapshots, historyChain(chat)).scene, '柜台');
});

test('snapshots are bounded and branch changes prune stale state', () => {
    let snapshots = [];
    const input = [];
    for (let i = 0; i < 25; i++) {
        input.push({ mes: String(i) });
        snapshots = recordSnapshot(snapshots, input, { scene: String(i), selected: [] });
    }
    assert.equal(snapshots.length, 16);
    const branch = [{ mes: '不同的开头' }];
    assert.equal(recordSnapshot(snapshots, branch, { scene: '新场景', selected: [] }).length, 1);
});

test('recent context bounds size and preserves latest action', () => {
    const result = recentContext([{ mes: 'x'.repeat(30000) + '最新行动', is_user: true }], 8);
    assert.ok(result[0].text.length < 6100);
    assert.ok(result[0].text.endsWith('最新行动'));
});

test('catalog never silently truncates, and old unknown working-set IDs are removed', () => {
    const catalog = makeCatalog([entry(1)], ['北境']);
    const payload = selectorPayload(catalog, chat, { scene: '', selected: [{ id: 'old', scope: 'scene' }] }, {}, config);
    assert.deepEqual(payload.previousWorkingSet, []);
    assert.throws(() => selectorPayload([{ ...catalog[0], summary: 'x'.repeat(CATALOG_LIMIT) }], chat, null, {}, config), /目录超过/);
});

test('overlay modifies source arrays, not original entries; gate blocks blue, sticky and disabled entries', () => {
    const selected = entry(1, { position: 4, depth: 2, role: 0, probability: 70, group: '互斥', characterFilter: { names: ['A'] } });
    const blue = entry(2, { constant: true, sticky: 5 });
    const disabled = entry(3, { disable: true });
    const unmanaged = entry(4, { world: '外部' });
    const before = structuredClone([selected, blue, disabled, unmanaged]);
    const payload = { globalLore: [selected, blue], characterLore: [disabled], chatLore: [unmanaged], personaLore: [] };
    const originalArray = payload.globalLore;
    overlayEntries(payload, ['北境'], new Set([entryId(selected), entryId(disabled)]));
    assert.equal(payload.globalLore, originalArray);
    assert.equal(payload.globalLore[0].constant, true);
    assert.equal(payload.globalLore[0].position, 4);
    assert.equal(payload.globalLore[0].probability, 70);
    assert.equal(payload.globalLore[1].disable, true);
    assert.equal(payload.characterLore[0].disable, true);
    assert.equal(payload.chatLore[0], unmanaged);
    payload.globalLore[0].characterFilter.names.push('B');
    assert.deepEqual([selected, blue, disabled, unmanaged], before);
});
