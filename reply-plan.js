/** Pure director-plan validation and formatting. Planned events never enter scene memory. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function planText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`导演方案的 ${label} 必须是非空文本。`);
    if (value.length > 3000) throw new Error(`导演方案的 ${label} 过长，请缩短安排而不是输出正文。`);
    return value.trim();
}

function planTexts(values, label, min, max) {
    if (!Array.isArray(values) || values.length < min || values.length > max) {
        throw new Error(`导演方案的 ${label} 必须是包含 ${min}～${max} 项的数组。`);
    }
    return values.map((value, index) => planText(value, `${label}[${index}]`));
}

export function validateReplyPlan(value, allowedIds) {
    if (!record(value)) throw new Error('调度返回缺少导演方案 replyPlan；请更新“剧情导演与资料统筹”的提示词与输出协议。');
    const direction = planText(value.direction, 'direction');
    const beats = planTexts(value.beats, 'beats', 1, 8);
    const constraints = planTexts(value.constraints, 'constraints', 0, 12);
    const ending = planText(value.ending, 'ending');
    if (!Array.isArray(value.requiredEntryIds)) throw new Error('导演方案缺少 requiredEntryIds 数组。');
    const known = new Set(allowedIds);
    const requiredEntryIds = [];
    const seen = new Set();
    for (const id of value.requiredEntryIds) {
        if (typeof id !== 'string' || !known.has(id)) {
            throw new Error('导演方案引用了未知、未入选或未纳入的世界书条目 ID。');
        }
        if (seen.has(id)) continue;
        seen.add(id);
        requiredEntryIds.push(id);
    }
    return { direction, beats, constraints, ending, requiredEntryIds };
}

export function missingReplyPlanEntries(plan, includedIds) {
    const included = new Set(includedIds);
    return (plan?.requiredEntryIds || []).filter(id => !included.has(id));
}

/** Host macro expansion must not execute strings copied into an AI-generated plan. */
const literal = value => String(value).replace(/\{\{/g, '{⁠{').replace(/\}\}/g, '}⁠}');

export function replyPlanMarkers(nonce) {
    if (typeof nonce !== 'string' || !/^[a-zA-Z0-9-]+$/.test(nonce)) throw new Error('导演方案缺少有效的本轮标识。');
    return { start: `[echo_reply_plan:${nonce}]`, end: `[/echo_reply_plan:${nonce}]` };
}

/** Only execution guidance is injected, not IDs, reasons, raw JSON, or a replacement for lore. */
export function buildReplyPlanPrompt(plan, nonce) {
    const { start, end } = replyPlanMarkers(nonce);
    return [
        start,
        '本轮导演方案（幕后执行指导，不是已发生的剧情）',
        '剧情主方向、事件顺序与收束位置已经由导演确定。请依据本轮世界书原文和角色设定完成正文，不再自行另开剧情分支、追加关键事件或越过收束位置。语言、对话、动作、心理描写及表现节奏由你自然呈现，不要把提纲逐条翻译成正文。',
        '先接住用户本轮已经表达的行动和意图；不得替用户角色决定尚未作出的选择。方案不能改写世界书硬约束、已经发生的事实或角色认知；若有冲突，只作守住这些边界所必需的调整，不扩展出另一条剧情。不要补造缺失的关键设定，不要在正文提及导演、提纲或资料检索。续写时承接已有正文，不要重写已经完成的节点。',
        `主方向：${literal(plan.direction)}`,
        '情节节点：',
        ...plan.beats.map((beat, index) => `${index + 1}. ${literal(beat)}`),
        ...(plan.constraints.length ? ['设定与认知边界：', ...plan.constraints.map(value => `- ${literal(value)}`)] : []),
        `本轮收束：${literal(plan.ending)}`,
        end,
    ].join('\n');
}
