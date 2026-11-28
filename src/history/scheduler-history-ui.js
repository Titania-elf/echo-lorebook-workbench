import { element, button } from '../workbench/workbench-utils.js';
import { scrollRegion } from '../workbench/workbench-scroll.js';
import { historyChatInfo } from './scheduler-history.js';
import { replyPlanPresentation, replyPlanFields } from '../scheduler/scheduler-report.js';

const REQUEST_STATES = {
    pending: { label: '进行中', tone: 'active' },
    returned: { label: '已返回', tone: 'success' },
    failed: { label: '失败', tone: 'danger' },
    timeout: { label: '超时', tone: 'danger' },
    cancelled: { label: '取消', tone: 'muted' },
};
const APPLICATION_STATES = {
    pending: '本轮采用尚未确定',
    preview: '手动试运行，不用于正文注入',
    waiting: '等待正文构造',
    applied: '本轮调度已用于正文构造',
    unused: '本轮调度未采用',
};
const GENERATION_TYPES = {
    normal: '普通回复', regenerate: '重新生成', swipe: '滑动重写', continue: '续写',
};
const ERROR_STAGES = {
    prepare: '请求准备', prompt: '提示词准备', request: '接口请求', parse: '返回解析', validation: '返回校验',
    application: '正文采用', apply: '正文采用', context: '聊天变化', timeout: '请求超时',
    cancelled: '请求取消', recovery: '历史请求恢复', memory: '场景参考保存',
};
const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const text = value => typeof value === 'string' ? value : value == null ? '' : String(value);
const writeText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const unconfirmed = record => Boolean(record?.recoveryUnconfirmed && record.requestStatus === 'pending');

function dateValue(value) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function timeText(value) {
    const date = dateValue(value);
    return date ? TIME_FORMAT.format(date) : '未记录';
}

function durationText(record) {
    if (unconfirmed(record)) return '未确认';
    let value = record.durationMs;
    if (!Number.isFinite(value)) {
        const start = dateValue(record.startedAt);
        const end = dateValue(record.finishedAt);
        value = start && end ? end.getTime() - start.getTime() : null;
    }
    if (!Number.isFinite(value)) return record.requestStatus === 'pending' ? '进行中' : '未记录';
    value = Math.max(0, value);
    if (value < 1000) return `${Math.round(value)} 毫秒`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`;
    return `${Math.floor(value / 60000)} 分 ${Math.floor(value % 60000 / 1000)} 秒`;
}

function sourceText(record) {
    if (record.kind === 'preview') return '手动试运行';
    const type = GENERATION_TYPES[record.generationType];
    return type ? `自动调度（${type}）` : '自动调度';
}

function recordState(record) {
    if (unconfirmed(record)) return { label: '最终结果未确认', tone: 'muted' };
    if (record.requestStatus === 'returned' && record.validationStatus === 'invalid') {
        return { label: '返回无效', tone: 'danger' };
    }
    return REQUEST_STATES[record.requestStatus] || { label: '状态未记录', tone: 'muted' };
}

function matchesStatus(record, status) {
    if (status === 'all') return true;
    if (status === 'invalid') return record.validationStatus === 'invalid';
    if (status === 'returned') return record.requestStatus === 'returned' && record.validationStatus !== 'invalid';
    if (status === 'pending') return record.requestStatus === 'pending' && !unconfirmed(record);
    return record.requestStatus === status;
}

function entrySnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.blue) || !Array.isArray(value.green)) return null;
    return Object.fromEntries(['blue', 'green'].map(kind => [kind, value[kind]
        .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(entry => ({ id: text(entry.id), book: text(entry.book), title: text(entry.title) }))]));
}

function entryPresentation(record) {
    const planned = entrySnapshot(record.plannedEntries);
    const effective = entrySnapshot(record.effectiveEntries);
    // A valid response can arrive before the final budget allocation completes.
    const allocationComplete = Number.isFinite(record.counts?.selected) && record.counts.selected >= 0;
    const preliminary = record.requestStatus === 'pending' || record.validationStatus !== 'valid' || !allocationComplete;
    if (record.applicationStatus === 'applied' && effective) {
        return {
            snapshot: effective, effective: true, preliminary: false,
            heading: '本次生效条目', note: '以酒馆世界书扫描接纳的条目 ID 为依据，不代表上游正文 API 已接收全部字符。',
        };
    }
    if (!planned) {
        return {
            snapshot: null, heading: '条目标题', note: '',
            missing: '这条历史未记录条目标题。',
        };
    }
    if (record.applicationStatus === 'applied') {
        return {
            snapshot: planned, preliminary, heading: '本次拟纳入条目',
            note: `这条历史未记录实际接纳的条目标题。下方仅显示当时拟纳入的条目。${preliminary ? '候选绿灯的最终入选情况尚未记录。' : ''}`,
        };
    }
    if (record.applicationStatus === 'unused') {
        return {
            snapshot: planned, preliminary,
            heading: preliminary ? '本次已准备条目（未采用）' : '本次拟纳入条目（未采用）',
            note: `本次调度未采用下方条目。无法从这份调度记录判断哪些条目由原生规则激活。${preliminary ? '候选绿灯的最终入选情况尚未记录。' : ''}`,
        };
    }
    if (preliminary) {
        return {
            snapshot: planned, preliminary: true, heading: '本次已准备条目',
            note: `${unconfirmed(record) ? '最终结果未确认。' : ''}目前仅记录已准备的蓝灯和固定绿灯；候选绿灯的最终入选结果尚未记录。`,
        };
    }
    if (record.kind === 'preview' || record.applicationStatus === 'preview') {
        return {
            snapshot: planned, preliminary: false, heading: '本次试运行条目',
            note: '仅为手动试运行结果，未用于正文注入。',
        };
    }
    return {
        snapshot: planned, preliminary: false, heading: '本次拟纳入条目',
        note: record.applicationStatus === 'waiting'
            ? '正在等待酒馆构造，尚未确认接纳条目。'
            : '下方是拟纳入的条目，尚未确认实际接纳。',
    };
}

function emptyEntryText(kind, presentation) {
    const label = kind === 'blue' ? '蓝灯' : '绿灯';
    if (presentation.effective) return `本次调度没有被酒馆构造接纳的${label}条目。`;
    if (presentation.preliminary) return kind === 'blue'
        ? '当前记录未包含已准备的蓝灯条目。'
        : '当前记录未包含已准备的固定绿灯；候选绿灯的最终入选情况尚未记录。';
    return `记录中没有拟纳入的${label}条目。`;
}

/** Reads browser-local history without replacing the response being examined. */
export class SchedulerHistoryUI {
    constructor(workbench) {
        this.workbench = workbench;
        this.store = workbench.history;
        this.scope = 'current';
        this.status = 'all';
        this.query = '';
        this.selectedId = '';
        this.rows = new Map();
        this.responsePositions = new Map();
        this.scrollTop = 0;
        this.listScrollTop = 0;
        this.listPageScrollTop = 0;
        this.mobileDetail = false;
        const ready = this.store?.ready || this.store?.initialize?.();
        this.loading = Boolean(ready?.then);
        this.build();
        if (this.loading) Promise.resolve(ready).then(() => {
            this.loading = false;
            this.update();
        }).catch(error => {
            this.loading = false;
            this.loadError = error?.message || '历史记录读取失败。';
            this.update();
        });
    }

    get records() {
        const records = this.store?.records;
        return Array.isArray(records) ? records : [];
    }

    currentChat() {
        try { return historyChatInfo(this.workbench.getContext()); }
        catch { return { chatKey: '', chatName: '' }; }
    }

    field(input, label) {
        return element('div', { class: 'wb-field' }, element('label', { htmlFor: input.id, text: label }), input);
    }

    build() {
        this.scopeSelect = element('select', { id: 'wb-history-scope' },
            element('option', { value: 'current', text: '当前聊天' }),
            element('option', { value: 'all', text: '全部聊天' }));
        this.scopeSelect.addEventListener('change', () => {
            this.scope = this.scopeSelect.value;
            this.update({ refilter: true });
        });
        this.statusSelect = element('select', { id: 'wb-history-status' },
            [['all', '全部'], ['pending', '进行中'], ['returned', '已返回'], ['invalid', '返回无效'],
                ['failed', '失败'], ['timeout', '超时'], ['cancelled', '取消']]
                .map(([value, label]) => element('option', { value, text: label })));
        this.statusSelect.addEventListener('change', () => {
            this.status = this.statusSelect.value;
            this.update({ refilter: true });
        });
        this.search = element('input', {
            id: 'wb-history-search', type: 'search', autocomplete: 'off',
            placeholder: '搜索模型、聊天、条目或错误', 'aria-label': '搜索调度历史',
        });
        this.search.addEventListener('input', () => {
            this.query = this.search.value.trim().toLocaleLowerCase();
            this.update({ refilter: true });
        });
        this.count = element('small', { class: 'wb-help', role: 'status', 'aria-live': 'polite' });
        this.list = element('div', {
            id: 'wb-history-list', class: 'wb-history-list', role: 'group', 'aria-label': '调度历史记录',
        });
        this.listEmptyTitle = element('strong');
        this.listEmptyText = element('p', { class: 'wb-help' });
        this.listEmpty = element('div', { class: 'wb-empty wb-history-list-empty' }, this.listEmptyTitle, this.listEmptyText);
        const listPanel = element('aside', { class: 'wb-history-list-panel' },
            element('div', { class: 'wb-history-filters' },
                this.field(this.scopeSelect, '查看范围'), this.field(this.statusSelect, '记录状态')),
            this.field(this.search, '搜索记录'), this.count,
            scrollRegion(this.list, 'wb-history-list-scroll'));

        this.backButton = button('返回记录列表', {
            id: 'wb-history-back', class: 'wb-button wb-secondary wb-history-back', glyph: 'back',
            onclick: () => this.returnToList(),
        });
        this.detailTitle = element('h3', { id: 'wb-history-detail-title', tabIndex: -1, text: '记录详情' });
        this.detailStatus = element('span', { class: 'wb-history-state' });
        this.selectionNote = element('p', {
            class: 'wb-help', hidden: true,
            text: '这条记录的状态已变化，不再符合当前列表筛选；详情仍保留供你查看。',
        });
        this.detailEmpty = element('div', { class: 'wb-empty wb-history-detail-empty' },
            element('strong', { text: '选择一条记录查看详情' }),
            element('p', { class: 'wb-help', text: '这里会显示请求状态、世界书接纳结果与模型返回原文。' }));
        this.facts = new Map();
        const factNodes = [
            ['chat', '来源聊天'], ['source', '触发方式'], ['scheme', 'API 方案'], ['model', '模型'],
            ['started', '开始时间'], ['submitted', '提交时间'], ['finished', '结束时间'], ['duration', '耗时'],
            ['request', '接口状态'], ['validation', '返回校验'], ['application', '本轮采用'],
        ].map(([key, label]) => {
            const value = element('dd');
            this.facts.set(key, value);
            return element('div', { class: `wb-history-fact${key === 'application' ? ' wb-history-application' : ''}` },
                element('dt', { text: label }), value);
        });
        this.planStatus = element('span', { class: 'wb-reply-plan-state' });
        this.planTokens = element('p', { class: 'wb-help' });
        this.planNote = element('p', { class: 'wb-help' });
        this.planReason = element('p', { class: 'wb-help wb-reply-plan-reason' });
        this.planEmpty = element('p', { class: 'wb-help' });
        this.planBody = element('dl', { class: 'wb-reply-plan-body' });
        this.planDisclaimer = element('p', { class: 'wb-help', text: '这是当时的拟议走向，不是已发生的场景事实；采用时用于隐藏的深度 0 System 指令，不生成可见聊天消息。依赖条目只是方案的要求，不表示已被构造接纳。' });
        this.planTokenNote = element('p', { class: 'wb-help', text: 'Token 数包含方案、执行提示、标记与消息开销，仍占正文上下文；预算不足时省略，不截断。' });
        this.planSection = element('section', { class: 'wb-reply-plan wb-history-plan', 'aria-labelledby': 'wb-history-plan-title', hidden: true },
            element('div', { class: 'wb-reply-plan-heading' }, element('h4', { id: 'wb-history-plan-title', text: '旧版导演方案' }), this.planStatus),
            this.planDisclaimer, this.planTokens, this.planTokenNote,
            this.planNote, this.planReason, this.planEmpty, this.planBody);
        this.entriesHeading = element('h4');
        this.entriesNote = element('p', { class: 'wb-help' });
        this.entriesMissing = element('p', { class: 'wb-help' });
        this.entryGroups = new Map();
        const entryGroupNodes = ['blue', 'green'].map(kind => {
            const heading = element('h5', { id: `wb-history-entries-${kind}` });
            const list = element('ul', { class: 'wb-history-entry-list', 'aria-labelledby': heading.id });
            const empty = element('p', { class: 'wb-help wb-history-entry-empty' });
            const shell = scrollRegion(list, 'wb-history-entry-scroll');
            this.entryGroups.set(kind, { heading, list, empty, shell });
            return element('section', {
                class: 'wb-history-entry-group', 'data-kind': kind, 'aria-labelledby': heading.id,
            }, heading, shell, empty);
        });
        this.entriesGrid = element('div', { class: 'wb-history-entries-grid' }, entryGroupNodes);
        this.entriesSection = element('section', { class: 'wb-history-entries' },
            this.entriesHeading, this.entriesNote, this.entriesMissing, this.entriesGrid);
        this.failureTitle = element('h4');
        this.failureStage = element('p', { class: 'wb-help' });
        this.failureText = element('p');
        this.failure = element('section', { class: 'wb-history-failure', hidden: true },
            this.failureTitle, this.failureStage, this.failureText);
        this.lateNote = element('p', { class: 'wb-help wb-history-late', hidden: true });
        this.response = element('textarea', {
            id: 'wb-history-response', class: 'wb-history-response', readOnly: true, rows: 14,
            autocomplete: 'off', spellcheck: false, 'aria-label': '模型返回原文',
        });
        for (const event of ['select', 'click', 'keyup', 'blur']) {
            this.response.addEventListener(event, () => this.rememberResponsePosition());
        }
        this.response.addEventListener('scroll', () => this.rememberResponsePosition(), { passive: true });
        this.responseEmpty = element('p', { class: 'wb-help wb-history-response-empty' });
        this.responseShell = scrollRegion(this.response, 'wb-history-response-scroll');
        this.detailContent = element('div', { class: 'wb-history-detail-content' },
            element('dl', { class: 'wb-history-facts' }, factNodes),
            this.planSection, this.entriesSection, this.failure,
            element('section', { class: 'wb-history-response-section wb-field' },
                element('label', { htmlFor: this.response.id, text: '模型返回原文' }),
                this.lateNote, this.responseEmpty, this.responseShell));
        const detailPanel = element('section', { id: 'wb-history-details', class: 'wb-history-detail-panel' },
            this.backButton,
            element('div', { class: 'wb-history-detail-heading' }, this.detailTitle, this.detailStatus),
            this.selectionNote, this.detailEmpty, this.detailContent);
        this.storageText = element('p');
        this.storageNotice = element('section', { class: 'wb-history-storage wb-error', role: 'status', hidden: true },
            element('strong', { text: '历史记录暂未能完整保存在浏览器' }), this.storageText);
        this.viewport = element('div', { class: 'wb-history-page' },
            element('p', { class: 'wb-help', text: '查看浏览器保存的目录筛选请求与世界书接纳结果。未调用筛选 API 的轮次不产生请求记录。' }),
            this.storageNotice, element('div', { class: 'wb-history-grid' }, listPanel, detailPanel));
        this.view = element('section', { class: 'wb-feature-view wb-history-view', 'data-history-detail': 'false' },
            scrollRegion(this.viewport, 'wb-fill-scroll'));
        this.update();
    }

    createRow(id) {
        const time = element('time', { class: 'wb-history-record-time' });
        const state = element('span', { class: 'wb-history-state' });
        const source = element('strong', { class: 'wb-history-record-source' });
        const model = element('span', { class: 'wb-history-record-model' });
        const chat = element('span', { class: 'wb-history-record-chat' });
        const application = element('span', { class: 'wb-history-record-application' });
        const plan = element('span', { class: 'wb-history-record-plan' });
        const footer = element('span', { class: 'wb-history-record-footer' }, chat, application, plan);
        const node = button('', {
            class: 'wb-history-record', 'aria-controls': 'wb-history-details',
            onclick: () => this.selectRecord(id),
        });
        node.append(element('span', { class: 'wb-history-record-heading' }, time, state), source, model, footer);
        return { node, time, state, source, model, chat, application, plan, footer };
    }

    update({ refilter = false } = {}) {
        const records = this.records;
        const current = this.currentChat();
        this.visible = records.filter(record => {
            if (this.scope === 'current' && record.chatKey !== current.chatKey) return false;
            if (!matchesStatus(record, this.status)) return false;
            if (!this.query) return true;
            const snapshot = entryPresentation(record).snapshot;
            const titles = ['blue', 'green'].flatMap(kind => (snapshot?.[kind] || []).flatMap(entry => [entry.title, entry.book]));
            const plan = replyPlanPresentation(record)?.plan;
            return [record.model, record.schemeName, record.chatName, record.error, record.applicationReason, record.replyPlanReason,
                plan?.direction, plan?.ending, ...(plan?.beats || []), ...(plan?.constraints || []), ...(plan?.requiredEntryIds || []), ...titles]
                .map(text).join('\n').toLocaleLowerCase().includes(this.query);
        });
        let selected = records.find(record => record.id === this.selectedId);
        if (!selected || (refilter && !this.visible.some(record => record.id === this.selectedId))
            || (this.scope === 'current' && selected.chatKey !== current.chatKey)) {
            this.rememberResponsePosition();
            this.selectedId = this.visible[0]?.id || '';
            selected = this.visible[0];
            this.mobileDetail = false;
        }
        this.renderList(records, current);
        this.renderDetails(selected);
        this.selectionNote.hidden = !selected || this.visible.some(record => record.id === selected.id);
        const storageError = text(this.store?.storageError) || this.loadError || '';
        writeText(this.storageText, storageError);
        this.storageNotice.hidden = !storageError;
        this.view.dataset.historyDetail = String(this.mobileDetail && Boolean(this.selectedId));
        this.workbench.scrollbars?.refresh();
    }

    renderList(records, current) {
        const nodes = this.visible.map(record => {
            let row = this.rows.get(record.id);
            if (!row) {
                row = this.createRow(record.id);
                this.rows.set(record.id, row);
            }
            const state = recordState(record);
            const date = dateValue(record.startedAt);
            writeText(row.time, timeText(record.startedAt));
            row.time.dateTime = date?.toISOString() || '';
            writeText(row.state, state.label);
            row.state.dataset.tone = state.tone;
            writeText(row.source, sourceText(record));
            writeText(row.model, text(record.model) || '模型尚未确定');
            writeText(row.chat, text(record.chatName) || '未命名聊天');
            row.chat.hidden = this.scope !== 'all';
            const application = { applied: '本轮构造已采用', unused: '本轮未采用', waiting: '等待正文构造' }[record.applicationStatus];
            writeText(row.application, application || '');
            row.application.dataset.application = record.applicationStatus || '';
            row.application.hidden = !application;
            const plan = replyPlanPresentation(record);
            row.plan.hidden = !plan;
            if (plan) {
                writeText(row.plan, `旧版方案：${plan.label}`);
                row.plan.dataset.tone = plan.tone;
            }
            row.footer.hidden = row.chat.hidden && row.application.hidden && row.plan.hidden;
            const selected = record.id === this.selectedId;
            row.node.dataset.selected = String(selected);
            row.node.setAttribute('aria-pressed', String(selected));
            return row.node;
        });
        const validIds = new Set(records.map(record => record.id));
        for (const [id, row] of this.rows) {
            if (!validIds.has(id)) { row.node.remove(); this.rows.delete(id); }
        }
        if (!nodes.length) this.renderEmpty(records, current);
        const signature = JSON.stringify(this.visible.map(record => record.id));
        if (signature !== this.listSignature) {
            const scrollTop = this.list.scrollTop;
            this.list.replaceChildren(...(nodes.length ? nodes : [this.listEmpty]));
            this.list.scrollTop = scrollTop;
            this.listSignature = signature;
        }
        writeText(this.count, `显示 ${this.visible.length} 条，本地共 ${records.length} 条`);
    }

    renderEmpty(records, current) {
        let title = '暂无历史记录';
        let description = '自动调度或手动试运行调用筛选 API 后，会在这里留下请求记录。';
        if (this.loading && !records.length) {
            title = '正在读取历史记录…';
            description = '正在加载当前浏览器中的记录。';
        } else if (this.scope === 'current' && !current.chatKey) {
            title = '当前没有打开聊天';
            description = '切换到“全部聊天”可查看当前浏览器中的记录。';
        } else if (records.length && (this.query || this.status !== 'all')) {
            title = '没有符合筛选的记录';
            description = '调整查看范围、记录状态或搜索词后再查看。';
        } else if (records.length && this.scope === 'current') {
            title = '当前聊天暂无记录';
            description = '切换到“全部聊天”可查看其他聊天的本地记录。';
        }
        writeText(this.listEmptyTitle, title);
        writeText(this.listEmptyText, description);
    }

    renderDetails(record) {
        const changed = this.detailId !== record?.id;
        if (changed) this.rememberResponsePosition();
        this.detailId = record?.id || '';
        this.detailEmpty.hidden = Boolean(record);
        this.detailContent.hidden = !record;
        this.detailStatus.hidden = !record;
        if (!record) {
            writeText(this.detailTitle, '记录详情');
            if (this.response.value) this.response.value = '';
            this.renderedRaw = '';
            return;
        }
        const state = recordState(record);
        writeText(this.detailTitle, `${sourceText(record)}记录`);
        writeText(this.detailStatus, state.label);
        this.detailStatus.dataset.tone = state.tone;
        const requestLabel = unconfirmed(record) ? '最终结果未确认' : REQUEST_STATES[record.requestStatus]?.label || '未记录';
        const validationLabel = unconfirmed(record) ? '未确认'
            : { pending: record.requestStatus === 'pending' ? '等待模型返回' : '等待校验', valid: '有效', invalid: '无效', 'not-run': '未校验' }[record.validationStatus] || '未记录';
        const applicationLabel = unconfirmed(record) ? '未确认' : APPLICATION_STATES[record.applicationStatus] || '未记录';
        const facts = {
            chat: text(record.chatName) || '未命名聊天',
            source: sourceText(record),
            scheme: text(record.schemeName) || '未记录',
            model: text(record.model) || '尚未确定',
            started: timeText(record.startedAt),
            submitted: record.submittedAt != null ? timeText(record.submittedAt) : '尚未提交',
            finished: record.finishedAt != null ? timeText(record.finishedAt) : unconfirmed(record) ? '未确认' : record.requestStatus === 'pending' ? '尚未结束' : '未记录',
            duration: durationText(record),
            request: requestLabel,
            validation: validationLabel,
            application: applicationLabel,
        };
        for (const [key, value] of Object.entries(facts)) writeText(this.facts.get(key), value);
        this.facts.get('application').dataset.application = record.applicationStatus || '';
        this.renderReplyPlan(record);
        this.renderEntryTitles(record);
        this.renderFailure(record);
        this.lateNote.hidden = !record.lateResponse;
        writeText(this.lateNote, '这份返回在请求结束后才收到，原文已保留。');
        const raw = typeof record.rawResponse === 'string' ? record.rawResponse : '';
        const responseChanged = changed || this.renderedRaw !== raw;
        const position = responseChanged ? (changed || !this.response.getClientRects().length
            ? this.responsePositions.get(record.id) : this.readResponsePosition()) : null;
        this.responseShell.hidden = !raw.length;
        this.responseEmpty.hidden = Boolean(raw.length);
        if (responseChanged) {
            this.response.value = raw;
            this.renderedRaw = raw;
            this.restoreResponsePosition(position);
        }
        writeText(this.responseEmpty, this.emptyResponseText(record));
    }

    renderReplyPlan(record) {
        const presentation = replyPlanPresentation(record);
        this.planSection.hidden = !presentation;
        if (!presentation) return;
        writeText(this.planStatus, presentation.label);
        this.planStatus.dataset.tone = presentation.tone;
        writeText(this.planTokens, presentation.tokens);
        this.planTokens.hidden = !presentation.hasTokens && !presentation.plan;
        this.planTokenNote.hidden = this.planTokens.hidden;
        this.planDisclaimer.hidden = !presentation.plan;
        writeText(this.planNote, presentation.note);
        this.planNote.hidden = !record.replyPlanStatus && !presentation.plan;
        writeText(this.planReason, presentation.reason);
        this.planReason.hidden = !presentation.reason;
        writeText(this.planEmpty, presentation.empty);
        this.planEmpty.hidden = Boolean(presentation.plan);
        this.planBody.hidden = !presentation.plan;
        const entries = ['plannedEntries', 'effectiveEntries'].flatMap(key => {
            const snapshot = entrySnapshot(record[key]);
            return [...(snapshot?.blue || []), ...(snapshot?.green || [])];
        });
        const byId = new Map(entries.map(entry => [entry.id, entry]));
        const fields = replyPlanFields(presentation.plan, id => {
            const entry = byId.get(id);
            return entry ? `${entry.title || '条目标题未记录'}（${entry.book || '世界书名未记录'}）` : id;
        });
        const signature = JSON.stringify(fields);
        if (signature !== this.planSignature) {
            this.planBody.replaceChildren(...fields.map(field => {
                const content = field.values?.length
                    ? element(field.ordered ? 'ol' : 'ul', { class: 'wb-reply-plan-list' }, field.values.map(value => element('li', { text: value })))
                    : field.value || field.empty;
                return element('div', { class: 'wb-reply-plan-field', 'data-field': field.key },
                    element('dt', { text: field.label }), element('dd', {}, content));
            }));
            this.planSignature = signature;
        }
    }

    renderEntryTitles(record) {
        const presentation = entryPresentation(record);
        const changedRecord = this.entriesRecordId !== record.id;
        this.entriesRecordId = record.id;
        writeText(this.entriesHeading, presentation.heading);
        writeText(this.entriesNote, presentation.note);
        this.entriesNote.hidden = !presentation.note;
        this.entriesMissing.hidden = Boolean(presentation.snapshot);
        this.entriesGrid.hidden = !presentation.snapshot;
        if (!presentation.snapshot) {
            writeText(this.entriesMissing, presentation.missing);
            this.entriesSignature = null;
            return;
        }
        const signature = JSON.stringify(presentation.snapshot);
        if (signature !== this.entriesSignature) {
            for (const kind of ['blue', 'green']) {
                const group = this.entryGroups.get(kind);
                const groupSignature = JSON.stringify(presentation.snapshot[kind]);
                if (group.signature === groupSignature) continue;
                const scrollTop = changedRecord ? 0 : group.list.scrollTop;
                group.list.replaceChildren(...presentation.snapshot[kind].map(entry => element('li', { class: 'wb-history-entry-item' },
                    element('strong', { class: 'wb-history-entry-title', text: entry.title || '条目标题未记录' }),
                    element('small', { class: 'wb-history-entry-book', text: entry.book || '世界书名未记录' }))));
                group.list.scrollTop = scrollTop;
                group.signature = groupSignature;
            }
            this.entriesSignature = signature;
        }
        for (const kind of ['blue', 'green']) {
            const group = this.entryGroups.get(kind);
            const count = presentation.snapshot[kind].length;
            if (changedRecord) group.list.scrollTop = 0;
            writeText(group.heading, `${kind === 'blue' ? '蓝灯' : '绿灯'}条目（${count}）`);
            group.shell.hidden = !count;
            group.empty.hidden = Boolean(count);
            writeText(group.empty, emptyEntryText(kind, presentation));
        }
    }

    renderFailure(record) {
        let title = '';
        let reason = text(record.error);
        let tone = 'danger';
        if (unconfirmed(record)) {
            title = '最终结果未确认';
            reason ||= '浏览器保留了此前的请求记录，无法确认其最终结果。';
            tone = 'notice';
        } else if (record.validationStatus === 'invalid') {
            title = '返回解析或校验失败';
            reason ||= '模型返回未通过解析或结果校验，原文保留在下方。';
        } else if (record.requestStatus === 'failed') {
            title = '失败原因';
            reason ||= '接口请求失败，尚未取得可用返回。';
        } else if (record.requestStatus === 'timeout') {
            title = '超时原因';
            reason ||= '等待模型返回超时。';
        } else if (record.requestStatus === 'cancelled') {
            title = '取消原因';
            reason ||= '本次请求已取消。';
            tone = 'notice';
        } else if (record.applicationStatus === 'unused') {
            title = '未采用原因';
            reason = text(record.applicationReason) || reason || (record.lateResponse
                ? '本轮调度已结束，迟到的返回未采用。' : '本次结果未用于正文构造，记录中未提供更详细的原因。');
            tone = 'notice';
        } else if (reason) {
            title = '记录说明';
            tone = 'notice';
        }
        this.failure.hidden = !title;
        this.failure.dataset.tone = tone;
        writeText(this.failureTitle, title);
        writeText(this.failureText, reason);
        const stage = ERROR_STAGES[record.errorStage] || text(record.errorStage);
        writeText(this.failureStage, stage ? `发生阶段：${stage}` : '');
        this.failureStage.hidden = !stage;
    }

    emptyResponseText(record) {
        if (unconfirmed(record)) return '最终结果未确认，尚无模型返回原文。';
        if (record.requestStatus === 'pending') return '尚未收到模型返回内容。';
        if (record.requestStatus === 'returned') return '模型返回内容为空。';
        if (record.requestStatus === 'timeout') return '请求已超时，尚未收到模型返回内容。';
        if (record.requestStatus === 'cancelled') return '请求已取消，尚未收到模型返回内容。';
        return '未收到模型返回内容。';
    }

    selectRecord(id) {
        if (!this.visible.some(record => record.id === id)) return;
        const compact = this.compactLayout();
        if (compact && !this.mobileDetail) {
            this.listPageScrollTop = this.viewport.scrollTop;
            this.listScrollTop = this.list.scrollTop;
        }
        this.rememberResponsePosition();
        this.selectedId = id;
        this.mobileDetail = true;
        this.update();
        if (compact) this.viewport.scrollTop = 0;
        this.detailTitle.focus({ preventScroll: true });
    }

    returnToList() {
        this.rememberResponsePosition();
        this.mobileDetail = false;
        this.view.dataset.historyDetail = 'false';
        if (this.compactLayout()) {
            this.viewport.scrollTop = this.listPageScrollTop;
            this.list.scrollTop = this.listScrollTop;
        }
        this.workbench.scrollbars?.refresh();
        const row = this.rows.get(this.selectedId)?.node;
        (row && this.list.contains(row) ? row : this.statusSelect).focus({ preventScroll: true });
    }

    compactLayout() {
        return this.workbench.root?.dataset.compact === 'true'
            || Boolean(globalThis.matchMedia?.('(max-width: 760px)').matches);
    }

    readResponsePosition() {
        return {
            start: this.response.selectionStart, end: this.response.selectionEnd,
            direction: this.response.selectionDirection, scrollTop: this.response.scrollTop,
        };
    }

    rememberResponsePosition() {
        if (this.detailId && this.response?.getClientRects().length) {
            this.responsePositions.set(this.detailId, this.readResponsePosition());
        }
    }

    restoreResponsePosition(position) {
        const length = this.response.value.length;
        this.response.setSelectionRange(Math.min(position?.start || 0, length), Math.min(position?.end || 0, length), position?.direction || 'none');
        this.response.scrollTop = position?.scrollTop || 0;
    }

    rememberPosition() {
        if (!this.viewport.isConnected) return;
        this.scrollTop = this.viewport.scrollTop;
        const compact = this.compactLayout();
        if (!compact || !this.mobileDetail) this.listScrollTop = this.list.scrollTop;
        if (compact && !this.mobileDetail) this.listPageScrollTop = this.viewport.scrollTop;
        this.rememberResponsePosition();
    }

    restorePosition() {
        cancelAnimationFrame(this.restoreFrame);
        this.restoreFrame = requestAnimationFrame(() => {
            if (!this.workbench.root?.contains(this.viewport)) return;
            this.viewport.scrollTop = this.scrollTop;
            this.list.scrollTop = this.listScrollTop;
            if (this.detailId) this.restoreResponsePosition(this.responsePositions.get(this.detailId));
        });
    }

    dispose() {
        cancelAnimationFrame(this.restoreFrame);
    }
}
