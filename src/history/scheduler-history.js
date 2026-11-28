const text = value => typeof value === 'string' ? value : '';

/** Capture names and stable chat identity before any asynchronous request starts. */
export function historyChatInfo(context = {}) {
    if (!context.chatId) return { chatKey: '', chatName: '未打开聊天' };
    const character = context.characters?.[context.characterId];
    const group = Array.isArray(context.groups)
        ? context.groups.find(value => String(value.id) === String(context.groupId)) : null;
    const integrity = text(context.chatMetadata?.integrity);
    const identity = context.groupId != null
        ? ['group', String(context.groupId), String(context.chatId)]
        : ['character', text(character?.avatar) || String(context.characterId ?? ''), String(context.chatId)];
    const chatKey = JSON.stringify(integrity ? [...identity, 'integrity', integrity] : identity);
    const name = context.groupId != null ? text(group?.name) || '群聊'
        : text(character?.name) || text(context.name2) || '角色聊天';
    return { chatKey, chatName: `${name} · ${context.chatId}` };
}

/** History only receives a connection label and model, never connection credentials. */
export function historyConnectionInfo(context = {}, config = {}) {
    let mainModel = '';
    try { mainModel = text(context.getChatCompletionModel?.(context.chatCompletionSettings)); }
    catch { /* A missing or non-chat-completion connection has no model name. */ }
    if (config.apiMode === 'scheme') {
        const scheme = config.apiSchemes?.find(value => value.id === config.apiSchemeId);
        if (!scheme) return { schemeName: '已失效的 API 方案', model: '' };
        return {
            schemeName: text(scheme.name) || '未命名 API 方案',
            model: scheme.source === 'main' ? mainModel : text(scheme.model),
        };
    }
    if (config.apiMode === 'profile' || (!config.apiMode && config.profileId)) {
        let profile;
        try {
            profile = context.ConnectionManagerRequestService?.getSupportedProfiles()
                ?.find(value => value.id === config.profileId);
        } catch { /* Keep the failed attempt record when a saved connection is unavailable. */ }
        return { schemeName: text(profile?.name) || '酒馆已有连接', model: text(profile?.model) };
    }
    return { schemeName: '跟随酒馆主连接', model: mainModel };
}

/** Keep only the names captured for this request, with blue and green kept separate. */
export function historyEntryGroups(catalog = [], blue = [], green = []) {
    const byId = new Map(catalog.map(entry => [entry.id, {
        id: entry.id, book: text(entry.book), title: text(entry.title),
    }]));
    const seen = new Set();
    const group = entries => entries.flatMap(entry => {
        const id = typeof entry === 'string' ? entry : entry.id;
        const item = byId.get(id);
        if (!item || seen.has(id)) return [];
        seen.add(id);
        return [{ ...item }];
    });
    return { blue: group(blue), green: group(green) };
}

/** An effective title must belong both to this request's plan and its accepted IDs. */
export function historyEffectiveEntries(planned, acceptedIds) {
    if (!planned) return undefined;
    const accepted = new Set(acceptedIds);
    const group = entries => entries.filter(entry => accepted.has(entry.id)).map(entry => ({ ...entry }));
    return { blue: group(planned.blue), green: group(planned.green) };
}

export function historyAbortError(message, code = 'ECHO_CONTEXT_CHANGED') {
    const error = new Error(text(message) || '辅助请求已取消。');
    error.code = code;
    return error;
}

/** Preserve useful error text while removing any known independent-API key it echoed. */
export function historyFailure(error, config = {}) {
    const source = typeof error === 'string' ? error : text(error?.message) || '调度请求未完成。';
    const cause = text(error?.cause?.message);
    let message = cause && !source.includes(cause) ? `${source}：${cause}` : source;
    const secrets = (Array.isArray(config.apiSchemes) ? config.apiSchemes : [])
        .map(value => text(value.apiKey).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) message = message.split(secret).join('（密钥已隐藏）');
    const errorCode = typeof error?.code === 'string' ? error.code
        : typeof error?.cause?.code === 'string' ? error.cause.code : '';
    return { error: message, errorCode };
}
