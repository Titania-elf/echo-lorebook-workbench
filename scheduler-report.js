const REPLY_PLAN_STATES = {
    waiting: { label: '等待隐藏注入', tone: 'active', note: '方案尚未用于正文，等待本轮隐藏指令处理。' },
    preview: { label: '仅试运行', tone: 'muted', note: '仅供查看，未注入正文或更新场景记忆。' },
    injected: { label: '已注入隐藏指令', tone: 'success', note: '已放入本轮深度 0 System 指令，不代表正文 API 已接收全部字符。' },
    omitted: { label: '未注入', tone: 'muted', note: '导演方案与世界书条目分别处理；条目仍可能被构造接纳。' },
    cancelled: { label: '已取消', tone: 'muted', note: '本轮待用方案已清理，不再用于正文。' },
};
const replyPlanState = (status, report = {}) => {
    if (!Object.hasOwn(REPLY_PLAN_STATES, status)) return null;
    if (status === 'injected' && (['pending', 'waiting'].includes(report.applicationStatus)
        || ['waiting', 'scan-accepted'].includes(report.construction))) {
        return { label: '已放入隐藏指令，待正文确认', tone: 'active', note: '深度 0 指令已暂存，尚待正文提示词确认；不表示上游已接收或剧情已经发生。' };
    }
    return REPLY_PLAN_STATES[status];
};

/** Clone only returned plan display fields; never copy inputs, entry bodies or arbitrary objects. */
export function replyPlanSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const text = key => Object.hasOwn(value, key) && typeof value[key] === 'string' ? value[key] : '';
    const list = key => Object.hasOwn(value, key) && Array.isArray(value[key])
        ? value[key].filter(item => typeof item === 'string' && item.trim()) : [];
    const plan = {
        direction: text('direction'), beats: list('beats'), constraints: list('constraints'),
        ending: text('ending'), requiredEntryIds: [...new Set(list('requiredEntryIds'))],
    };
    return plan.direction.trim() || plan.ending.trim() || plan.beats.length || plan.constraints.length || plan.requiredEntryIds.length
        ? plan : null;
}

export function replyPlanPresentation(report, { history = false } = {}) {
    const plan = replyPlanSnapshot(report.replyPlan);
    const state = replyPlanState(report.replyPlanStatus, report) || {
        label: '状态未记录', tone: 'muted', note: '不能从这份记录判断导演方案是否注入。',
    };
    const tokens = typeof report.replyPlanTokens === 'number' && Number.isFinite(report.replyPlanTokens) && report.replyPlanTokens >= 0
        ? `整段注入约 ${report.replyPlanTokens.toLocaleString('en-US')} tokens` : '注入 Token 未记录';
    const reason = typeof report.replyPlanReason === 'string' ? report.replyPlanReason : '';
    const empty = history && !replyPlanState(report.replyPlanStatus)
        ? '这条历史未记录导演方案'
        : report.replyPlanStatus === 'waiting' ? '尚未收到可读的导演方案。' : '本次未记录可读的导演方案。';
    return { plan, ...state, tokens, reason, empty };
}

export function replyPlanFields(plan, entryLabel = id => id) {
    if (!plan) return [];
    return [
        { key: 'direction', label: '本轮主方向', value: plan.direction || '未记录主方向' },
        { key: 'beats', label: '拟议推进', values: plan.beats, ordered: true, empty: '未记录推进步骤' },
        { key: 'constraints', label: '写作约束', values: plan.constraints, empty: '未记录额外约束' },
        { key: 'ending', label: '收束方式', value: plan.ending || '未记录收束方式' },
        { key: 'requiredEntryIds', label: '方案要求的依赖条目', values: plan.requiredEntryIds.map(entryLabel), empty: '未列出依赖条目' },
    ];
}

export function catalogScope(director) {
    if (director.catalogError) return `条目读取未完成：${director.catalogError}`;
    const blue = director.catalog.filter(item => item.kind === 'blue').length;
    const green = director.catalog.filter(item => item.kind === 'green').length;
    const missing = director.config.books.filter(book => !director.activeBooks.includes(book));
    return `可用蓝灯 ${blue} 条、绿灯 ${green} 条；绿灯上限 ${director.config.maxEntries} 条 / ${director.config.tokenBudget} tokens；导演方案整段隐藏注入上限 ${director.config.replyPlanTokenBudget ?? 1000} tokens。${missing.length ? `未挂载、不读取：${missing.join('、')}。` : '世界书只读取当前挂载且勾选托管的书。'}没有托管条目、没有候选绿灯或固定绿灯占满预算时，仍会调用导演 API 规划本轮回复。`;
}

export function apiReport(report) {
    if (report.apiSucceeded) return '导演 API 已返回';
    if (report.apiDispatched) return '导演请求已提交酒馆发送';
    if (report.apiSubmitted) return '导演请求已交给酒馆连接，发出情况未确认';
    if (report.apiAttempted) return '导演请求未能提交';
    return `未调用导演 API${report.apiSkipReason ? `：${report.apiSkipReason}` : ''}`;
}

export function resultSummary(report) {
    const latestUser = report.latestUserRead === true ? '，另读最新已发送用户消息（不占 AI 层数）'
        : report.latestUserRead === false ? '；没有可读的已发送用户消息' : '（用户消息不占 AI 层数）';
    const history = `读取 ${report.historyCount ?? 0} 层 AI 消息全文${latestUser}`;
    const api = apiReport(report);
    if (report.mode === 'cancelled') return `${history}；${api}。${report.error || '本轮生成已取消，待注入结果已清理。'}`;
    if (report.mode === 'fallback') return `${history}；${api}。本轮调度结果已丢弃，正文按原生规则继续。${report.error || ''}`;
    if (report.mode === 'preview-error') return `${history}；${api}。${report.error || '试运行未完成。'}`;
    const blue = report.blue?.length || 0;
    const green = report.selected?.length || 0;
    const counts = `蓝灯常驻 ${blue} 条、绿灯候选 ${report.greenCandidates ?? 0} 条、入选 ${green} 条；世界书之前 ${report.beforeCount ?? 0} 条、之后 ${report.afterCount ?? 0} 条`;
    const budget = `绿灯约 ${report.tokens ?? 0} tokens，蓝灯约 ${report.blueTokens ?? 0} tokens（不占绿灯预算）`;
    const action = report.mode === 'preview' ? '仅试运行，未注入正文或更新场景记忆。'
        : report.construction === 'empty' ? '本轮没有可接管的条目，导演方案仍可独立处理。'
            : report.construction === 'waiting' ? '等待世界书构造。'
                : `世界书构造接纳 ${new Set(report.actual || []).size} 条${report.promptPrepared ? '，已继续正文请求' : ''}。`;
    const plan = replyPlanState(report.replyPlanStatus, report);
    return `${history}；${api}。${counts}；${budget}。${action}${plan ? `导演方案：${plan.label}。` : ''}${report.memoryError || ''}${report.stale ? ' 此结果已过期，请重新试运行。' : ''}`;
}

export function choiceState(report, id) {
    if (report.mode === 'preview') return '试运行计划';
    if (report.construction === 'waiting') return '待世界书构造';
    return (report.actual || []).includes(id) ? '世界书构造接纳' : '未被构造接纳';
}
