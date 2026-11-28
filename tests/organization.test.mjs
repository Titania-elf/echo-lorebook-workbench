import test from 'node:test';
import assert from 'node:assert/strict';
import { BookOrganizer } from '../src/worldbook/book-organizer.js';
import { readOrganizationIndex } from '../src/worldbook/organization-index.js';
import {
    materializeOrganization, organizationBatches, organizationMessages, organizationSources, parseOrganizationBatch,
} from '../src/worldbook/organization-plan.js';

const entry = (overrides = {}) => ({ uid: 2, comment: '港口', content: '雾季须持蓝印。\r\n守灯人负责巡灯。\r\n\r\n', key: ['旧港'], keysecondary: [], position: 1, ...overrides });
const book = (overrides = {}) => ({ entries: { 2: entry(overrides) }, extensions: { untouched: { value: true } } });
const numberedBook = count => ({ entries: Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const uid = index + 1;
    return [uid, entry({ uid, comment: `条目 ${uid}` })];
})) });
const part = (overrides = {}) => ({ title: '港规', category: '地点', keywords: ['蓝印'], summary: '雾季夜泊的证件要求', ...overrides });
const encoded = (id, ...parts) => JSON.stringify({ items: [{ id, parts }] });

function materialize(data, received) {
    const sources = organizationSources(data);
    const { plans, failures } = parseOrganizationBatch(encoded('2', ...received), sources);
    assert.deepEqual(failures, []);
    return materializeOrganization(data, sources, plans, {
        book: '原书', backupName: '备份', nextUid: () => 12, synchronize: () => {},
    });
}

test('internal cuts preserve literal source including trailing blank lines and reallocate only split children', () => {
    const before = book();
    const { data } = materialize(before, [part(), part({ startsWith: '守灯人负责巡灯。', title: '守灯人', keywords: ['巡灯'], category: '人物', content: '模型补写，不得保存' })]);
    assert.equal(data.entries[2].content + data.entries[12].content, before.entries[2].content);
    assert.equal(data.entries[2].content, '雾季须持蓝印。\r\n');
    assert.equal(data.entries[12].content, '守灯人负责巡灯。\r\n\r\n');
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

test('a failed or invented proposal does not invalidate another entry in the batch', () => {
    const data = numberedBook(3);
    data.entries[1].content = '重复标题\n重复标题\n尾部';
    data.entries[3].keysecondary = ['夜间'];
    const sources = organizationSources(data);
    const { plans, failures } = parseOrganizationBatch(JSON.stringify({ items: [
        { id: '1', parts: [part(), part({ startsWith: '重复标题' })] },
        { id: '2', parts: [part()] },
        { id: '3', parts: [part(), part({ startsWith: '守灯人负责巡灯。' })] },
        { id: 'invented', parts: [part()] },
    ] }), sources);
    assert.deepEqual([...plans.keys()], ['2']);
    assert.equal(plans.get('2')[0].end, data.entries[2].content.length);
    assert.match(failures[0].message, /不唯一/);
    assert.match(failures[1].message, /不允许拆分/);
    const duplicates = parseOrganizationBatch(JSON.stringify({ items: [
        { id: '2', parts: [part()] }, { id: '2', parts: [part()] },
    ] }), [sources[1]]);
    assert.equal(duplicates.plans.size, 0);
    assert.match(duplicates.failures[0].message, /重复/);
});

test('protected entries retain regex and secondary conditions but can replace ordinary green keys', () => {
    const data = book({ key: ['/旧港/u', '旧词'], keysecondary: ['夜间'], cooldown: 3 });
    const { data: after } = materialize(data, [part()]);
    assert.deepEqual(after.entries[2].key, ['/旧港/u', '蓝印']);
    assert.deepEqual(after.entries[2].keysecondary, ['夜间']);
    assert.equal(after.entries[2].cooldown, 3);
    assert.equal(after.entries[2].content, data.entries[2].content);
});

test('30 entries are sent in three batches of ten without fragmenting even a long entry', () => {
    const data = numberedBook(30);
    const full = 'Port records are intact. '.repeat(750) + '\r\n守灯人。';
    data.entries[2].content = full;
    const batches = organizationBatches(organizationSources(data));
    assert.deepEqual(batches.map(batch => batch.length), [10, 10, 10]);
    const sent = batches.flatMap(batch => JSON.parse(organizationMessages(batch)[1].content).items);
    assert.deepEqual(sent.map(item => item.id), Object.keys(data.entries));
    assert.equal(sent.find(item => item.id === '2').content, full);
    assert.ok(sent.every(item => !Object.hasOwn(item, 'blocks')));
});

function fixture({ initial = book(), failBackup = false, loseAcknowledgment = false, reply } = {}) {
    const events = [];
    const requests = [];
    const rows = new Map([['原书', initial]]);
    const context = { chatId: 'chat' };
    const getContext = () => context;
    let backupCount = 0;
    let checkpoint = null;
    const checkpoints = {
        read: async () => structuredClone(checkpoint),
        replace: async (_book, previous, next) => {
            assert.equal(previous?.revision, checkpoint?.revision);
            assert.equal(previous?.backup, checkpoint?.backup);
            checkpoint = next ? structuredClone({ ...next, revision: (previous?.revision || 0) + 1 }) : null;
            return structuredClone(checkpoint);
        },
    };
    const api = {
        cachedBook: () => null,
        readBook: async name => structuredClone(rows.get(name)),
        createOrganizationBackup: async (_name, data) => {
            events.push('backup');
            if (failBackup) throw new Error('backup failed');
            const name = `备份-${++backupCount}`;
            rows.set(name, structuredClone(data));
            return name;
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
        nextUid: () => 1000, notify: () => {}, onBegin: () => {}, onCommit: () => {},
        remember: () => {}, observeBook: () => {}, serialized: (_name, f) => f() };
    const createOrganizer = () => new BookOrganizer({ store, getContext, checkpoints, requestModel: async (_context, _config, messages) => {
        events.push('model');
        const input = JSON.parse(messages[1].content);
        requests.push(input);
        const items = input.items.map(item => ({ id: item.id, parts: [part()] }));
        return JSON.stringify({ items: reply ? reply(items, requests.length) : items });
    } });
    const organizer = createOrganizer();
    const prepare = (instance = organizer) => instance.prepare('原书', { context, config: { apiMode: 'main' }, signal: new AbortController().signal });
    return { organizer, createOrganizer, rows, events, requests, prepare, checkpoints };
}

test('one action organizes an entire book without a fourth classification request', async () => {
    const { events, requests, prepare, rows } = fixture({ initial: numberedBook(30) });
    const before = structuredClone(rows.get('原书'));
    const draft = await prepare();
    assert.equal(draft.afterCount, 30);
    assert.deepEqual(events, ['backup', 'model', 'model', 'model']);
    assert.ok(requests[1].categories.includes('地点'));
    assert.deepEqual(rows.get('原书'), before);
});

test('later batches finish after a malformed entry; reopening only requests that entry', async () => {
    const { events, requests, prepare, rows, checkpoints, createOrganizer } = fixture({ initial: numberedBook(12),
        reply: (items, call) => call === 1 ? items.filter(item => item.id !== '3') : items });
    const before = structuredClone(rows.get('原书'));
    await assert.rejects(prepare, /还有 1 条未完成/);
    assert.equal(Object.keys((await checkpoints.read()).records).length, 11);
    assert.deepEqual(rows.get('原书'), before);
    const draft = await prepare(createOrganizer());
    assert.equal(draft.afterCount, 12);
    assert.deepEqual(requests[2].items.map(item => item.id), ['3']);
    assert.deepEqual(events, ['backup', 'model', 'model', 'model']);
});

test('a request failure retains the completed batch and reuses its verified backup', async () => {
    const { events, requests, prepare, checkpoints } = fixture({ initial: numberedBook(12), reply: (items, call) => {
        if (call === 2) throw new Error('connection unavailable');
        return items;
    } });
    await assert.rejects(prepare, /本机草稿已有 10 条/);
    assert.equal(Object.keys((await checkpoints.read()).records).length, 10);
    assert.equal((await prepare()).afterCount, 12);
    assert.deepEqual(requests[2].items.map(item => item.id), ['11', '12']);
    assert.equal(events.filter(event => event === 'backup').length, 1);
});

test('edited source gets a fresh backup and only the changed entry is processed again', async () => {
    const { prepare, rows, requests, events } = fixture({ initial: numberedBook(3) });
    const first = await prepare();
    rows.get('原书').entries[2].content += '\n新规则。';
    const next = await prepare();
    assert.notEqual(next.backup, first.backup);
    assert.deepEqual(requests[1].items.map(item => item.id), ['2']);
    assert.deepEqual(events, ['backup', 'model', 'backup', 'model']);
});

test('failed backup prevents model dispatch; conflict after preview prevents writes', async () => {
    const failed = fixture({ failBackup: true });
    await assert.rejects(failed.prepare, /backup failed/);
    assert.deepEqual(failed.events, ['backup']);
    const sample = fixture();
    const draft = await sample.prepare();
    assert.deepEqual(sample.events, ['backup', 'model']);
    sample.rows.get('原书').entries[2].content += '新内容';
    await assert.rejects(() => sample.organizer.apply(draft), /发生变化/);
    assert.deepEqual(sample.events, ['backup', 'model']);
});

test('an uncertain write is reconciled without a duplicate write, then clears the draft', async () => {
    const { organizer, events, prepare, checkpoints } = fixture({ loseAcknowledgment: true });
    const draft = await prepare();
    await assert.rejects(() => organizer.apply(draft), /核对保存结果/);
    assert.equal(draft.pending, true);
    assert.ok(await checkpoints.read());
    assert.deepEqual(await organizer.apply(draft), { written: true, warning: '' });
    assert.equal(await checkpoints.read(), null);
    assert.deepEqual(events, ['backup', 'model', 'write']);
});

test('restore uses the confirmed backup and rejects edits made after its preview', async () => {
    const { organizer, rows, prepare } = fixture();
    const before = structuredClone(rows.get('原书'));
    const draft = await prepare();
    await organizer.apply(draft);
    assert.notDeepEqual(rows.get('原书').entries[2].key, before.entries[2].key);
    const saved = structuredClone(rows.get('原书'));
    const preview = await organizer.prepareRestore('原书');
    rows.get('原书').entries[2].content += '\nNew edit';
    await assert.rejects(() => organizer.apply(preview), /发生变化/);
    rows.set('原书', saved);
    assert.equal((await organizer.apply(await organizer.prepareRestore('原书'))).written, true);
    assert.deepEqual(rows.get('原书').entries, before.entries);
    assert.deepEqual(rows.get(draft.backup), before);
});
