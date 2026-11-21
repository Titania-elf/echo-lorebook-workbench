export function catalogScope(director) {
    if (director.catalogError) return `条目读取未完成：${director.catalogError}`;
    const blue = director.catalog.filter(item => item.kind === 'blue').length;
    const green = director.catalog.filter(item => item.kind === 'green').length;
    const missing = director.config.books.filter(book => !director.activeBooks.includes(book));
    return `可用蓝灯 ${blue} 条、绿灯 ${green} 条；绿灯上限 ${director.config.maxEntries} 条 / ${director.config.tokenBudget} tokens。${missing.length ? `未挂载：${missing.join('、')}` : '仅当前挂载且勾选托管的书参与。'}`;
}

export function apiReport(report) {
    if (report.apiSucceeded) return '筛选 API 已返回';
    if (report.apiDispatched) return '筛选请求已提交酒馆发送';
    if (report.apiSubmitted) return '筛选请求已交给酒馆连接，发出情况未确认';
    if (report.apiAttempted) return '筛选请求未能提交';
    return `未调用筛选 API${report.apiSkipReason ? `：${report.apiSkipReason}` : ''}`;
}

export function resultSummary(report) {
    const history = `读取 ${report.historyCount ?? 0} 层完整聊天`;
    const api = apiReport(report);
    if (report.mode === 'cancelled') return `${history}；${api}。${report.error || '本轮生成已取消，待注入结果已清理。'}`;
    if (report.mode === 'fallback') return `${history}；${api}。本轮调度结果已丢弃，正文按原生规则继续。${report.error || ''}`;
    if (report.mode === 'preview-error') return `${history}；${api}。${report.error || '试选未完成。'}`;
    const blue = report.blue?.length || 0;
    const green = report.selected?.length || 0;
    const counts = `蓝灯常驻 ${blue} 条、绿灯候选 ${report.greenCandidates ?? 0} 条、入选 ${green} 条；世界书之前 ${report.beforeCount ?? 0} 条、之后 ${report.afterCount ?? 0} 条`;
    const budget = `绿灯约 ${report.tokens ?? 0} tokens，蓝灯约 ${report.blueTokens ?? 0} tokens（不占绿灯预算）`;
    const action = report.mode === 'preview' ? '仅试选，未注入正文或更新场景记忆。'
        : report.construction === 'empty' ? '本轮没有可接管的条目。'
            : report.construction === 'waiting' ? '等待世界书构造。'
                : `世界书构造接纳 ${new Set(report.actual || []).size} 条${report.promptPrepared ? '，已继续正文请求' : ''}。`;
    return `${history}；${api}。${counts}；${budget}。${action}${report.memoryError || ''}${report.stale ? ' 此结果已过期，请重新试选。' : ''}`;
}

export function choiceState(report, id) {
    if (report.mode === 'preview') return '试选计划';
    if (report.construction === 'waiting') return '待世界书构造';
    return (report.actual || []).includes(id) ? '世界书构造接纳' : '未被构造接纳';
}
