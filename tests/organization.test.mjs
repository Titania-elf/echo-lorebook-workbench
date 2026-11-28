import test from 'node:test';
import assert from 'node:assert/strict';
import { BookOrganizer } from '../src/worldbook/book-organizer.js';
import { readOrganizationIndex } from '../src/worldbook/organization-index.js';
import { materializeOrganization, organizationBatches, organizationSources, parseOrganizationParts } from '../src/worldbook/organization-plan.js';

const entry = (overrides = {}) => ({ uid: 2, comment: '港口', content: '雾季须持蓝印。\r\n守灯人负责巡灯。', key: ['旧港'], keysecondary: [], position: 1, ...overrides });
const book = (overrides = {}) => ({ entries: { 2: entry(overrides) }, extensions: { untouched: { value: true } } });
const part = (first, last, overrides = {}) => ({ first, last, title: '港规', category: '地点', keywords: ['蓝印'], summary: '雾季夜泊的证件要求', ...overrides });
const encoded = (id, ...parts) => JSON.stringify({ items: [{ id, parts }] });

function materialize(data, received) {
    const sources = organizationSources(data);
    const [items] = organizationBatches(sources, { input: 6000, output: 4000 });
    const plans = parseOrganizationParts(encoded(items[0].id, ...received), items);
    return materializeOrganization(data, sources, new Map([['2', plans.get(items[0].id)]]), {
        book: '原书', backupName: '备份', labels: new Map(), nextUid: () => 12, synchronize: () => {},
    });
}

test('partition preserves literal source, reallocates only split children and detects stale directory', () => {
    const before = book();
    const { data } = materialize(before, [part(1, 1), part(2, 2, { title: '守灯人', keywords: ['巡灯'], category: '人物', content: '模型补写，不得保存' })]);
    assert.equal(data.entries[2].content + data.entries[12].content, before.entries[2].content);
    assert.equal(data.entries[2].content, '雾季须持蓝印。\r\n');
    assert.deepEqual(data.entries[2].key, ['蓝印']);
    assert.deepEqual(data.entries[12].key, ['巡灯']);
    assert.equal(data.entries[12].position, 1);
    assert.deepEqual(Object.keys(before.entries), ['2']);
    assert.deepEqual(data.extensions.untouched, before.extensions.untouched);
    const index = readOrganizationIndex(data);
    assert.deepEqual(index.get('12').ancestors, ['2']);
    assert.equal(index.get('12').category, '人物');
    assert.equal(readOrganizationIndex({ ...data, entries: { ...data.entries, 12: { ...data.entries[12], key: ['新词'] } } }), null);
});

test('does not accept holes, overlaps, invented IDs or a split of protected triggers', () => {
    const [items] = organizationBatches(organizationSources(book()), { input: 6000, output: 4000 });
    assert.throws(() => parseOrganizationParts(encoded(items[0].id, part(1, 1)), items), /遗漏/);
    assert.throws(() => parseOrganizationParts(encoded(items[0].id, part(1, 1), part(1, 2)), items), /边界/);
    assert.throws(() => parseOrganizationParts(encoded('unknown', part(1, 2)), items), /未知/);
    assert.throws(() => materialize(book({ keysecondary: ['夜间'] }), [part(1, 1), part(2, 2)]), /不允许拆分/);
});

test('protected entries retain regex and secondary conditions but can replace ordinary green keys', () => {
    const data = book({ key: ['/旧港/u', '旧词'], keysecondary: ['夜间'], cooldown: 3 });
    const { data: after } = materialize(data, [part(1, 2)]);
    assert.deepEqual(after.entries[2].key, ['/旧港/u', '蓝印']);
    assert.deepEqual(after.entries[2].keysecondary, ['夜间']);
    assert.equal(after.entries[2].cooldown, 3);
    assert.equal(after.entries[2].content, data.entries[2].content);
});

test('source windows send all text even when JSON request budget forces batching', () => {
    const full = 'Port records are intact. '.repeat(750) + '\r\n守灯人。';
    const [source] = organizationSources(book({ content: full }));
    const batches = organizationBatches([source], { input: 1700, output: 1600 });
    assert.ok(batches.length > 1);
    assert.equal(batches.flat().flatMap(input => input.blocks).join(''), full);
});

function fixture({ failBackup = false, loseAcknowledgment = false } = {}) {
    const events = [];
    const rows = new Map([['原书', book()]]);
    const context = { chatId: 'chat' };
    const getContext = () => context;
    const api = {
        cachedBook: () => null,
        readBook: async name => structuredClone(rows.get(name)),
        createOrganizationBackup: async (_name, data) => {
            events.push('backup');
            if (failBackup) throw new Error('backup failed');
            rows.set('备份', structuredClone(data));
            return '备份';
        },
        synchronizeOriginalData: () => {},
        writeBook: async (name, data) => {
            events.push('write');
            rows.set(name, structuredClone(data));
            if (loseAcknowledgment) throw Object.assign(new Error('lost ack'), { uncertain: true });
            return { data };
        },
        acceptSaved: async (_name, data) => ({ data }),
    };
    const store = { api, inFlight: 0, settings: { reserve: () => {}, watermark: () => -1 },
        nextUid: () => 12, notify: () => {}, onBegin: () => {}, onCommit: () => {},
        remember: () => {}, observeBook: () => {}, serialized: (_name, f) => f() };
    const organizer = new BookOrganizer({ store, getContext, requestModel: async (_context, _config, messages) => {
        events.push('model');
        const items = JSON.parse(messages[1].content);
        return JSON.stringify({ items: items.map(item => ({ id: item.id, parts: [part(1, item.blocks.length)] })) });
    } });
    const prepare = () => organizer.prepare('原书', { context, config: { apiMode: 'main' }, signal: new AbortController().signal });
    return { organizer, rows, events, prepare };
}

test('failed backup prevents model dispatch; conflict after preview prevents writes', async () => {
    const failed = fixture({ failBackup: true });
    await assert.rejects(failed.prepare, /backup failed/);
    assert.deepEqual(failed.events, ['backup']);
    const caseData = fixture();
    const draft = await caseData.prepare();
    assert.deepEqual(caseData.events, ['backup', 'model']);
    caseData.rows.get('原书').entries[2].content += '新内容';
    await assert.rejects(() => caseData.organizer.apply(draft), /发生变化/);
    assert.deepEqual(caseData.events, ['backup', 'model']);
});

test('an uncertain write is reconciled by reading, without dispatching a duplicate write', async () => {
    const { organizer, events, prepare } = fixture({ loseAcknowledgment: true });
    const draft = await prepare();
    await assert.rejects(() => organizer.apply(draft), /核对保存结果/);
    assert.equal(draft.pending, true);
    assert.deepEqual(await organizer.apply(draft), { written: true, warning: '' });
    assert.deepEqual(events, ['backup', 'model', 'write']);
});

test('restore uses the confirmed backup and rejects edits made after its preview', async () => {
    const { organizer, rows, prepare } = fixture();
    const before = structuredClone(rows.get('原书'));
    await organizer.apply(await prepare());
    assert.notDeepEqual(rows.get('原书').entries[2].key, before.entries[2].key);
    const saved = structuredClone(rows.get('原书'));
    const preview = await organizer.prepareRestore('原书');
    rows.get('原书').entries[2].content += '\nNew edit';
    await assert.rejects(() => organizer.apply(preview), /发生变化/);
    rows.set('原书', saved);
    assert.equal((await organizer.apply(await organizer.prepareRestore('原书'))).written, true);
    assert.deepEqual(rows.get('原书').entries, before.entries);
    assert.deepEqual(rows.get('备份'), before);
});
