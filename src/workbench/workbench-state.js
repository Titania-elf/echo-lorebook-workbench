import { MODULE } from '../scheduler/core.js';

export const WORKBENCH_SETTINGS = `${MODULE}-workbench`;
export const THEMES = Object.freeze(['tavern', 'light', 'dark']);
export const UID_LIMIT = 1000000;

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const validWatermark = value => Number.isInteger(value) && value >= -1 && value < UID_LIMIT;

export function bookWatermark(data) {
    const native = data.extensions?.[WORKBENCH_SETTINGS]?.uidWatermark;
    const original = data.originalData?.extensions?.[WORKBENCH_SETTINGS]?.uidWatermark;
    return Math.max(validWatermark(native) ? native : -1, validWatermark(original) ? original : -1);
}

/** Identity retirement is committed atomically with the entry change, not only via UI debounce. */
export function reserveBookWatermark(data, uid) {
    if (!validWatermark(uid) || uid < 0) throw new Error('条目身份超出原生安全范围。');
    const write = target => {
        if (target.extensions != null && !record(target.extensions)) throw new Error('世界书 extensions 格式异常，未覆盖其原始数据。');
        const extensions = target.extensions || {};
        const namespace = extensions[WORKBENCH_SETTINGS];
        if (namespace != null && !record(namespace)) throw new Error('世界书身份元数据命名空间冲突，未覆盖原始数据。');
        if (namespace && Object.hasOwn(namespace, 'uidWatermark') && !validWatermark(namespace.uidWatermark)) throw new Error('世界书身份水位无效，请检查原书元数据。');
        target.extensions = { ...extensions, [WORKBENCH_SETTINGS]: {
            ...(namespace || {}), uidWatermark: Math.max(namespace?.uidWatermark ?? -1, uid),
        } };
    };
    write(data);
    if (Array.isArray(data.originalData?.entries) && (data.originalData.extensions == null || record(data.originalData.extensions))) write(data.originalData);
}

/** UI preferences never pass through the scheduler's settings normalizer. */
export class WorkbenchSettings {
    constructor(getContext) {
        this.getContext = getContext;
    }

    get value() {
        const raw = this.getContext().extensionSettings[WORKBENCH_SETTINGS];
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    get theme() {
        return THEMES.includes(this.value.theme) ? this.value.theme : 'tavern';
    }

    setTheme(theme) {
        if (!THEMES.includes(theme)) return;
        this.write({ theme });
    }

    watermark(book) {
        const key = JSON.stringify([book]);
        const table = this.value.uidWatermarks;
        const value = table && typeof table === 'object' && Object.hasOwn(table, key) ? table[key] : -1;
        return Number.isInteger(value) && value >= -1 && value < UID_LIMIT ? value : -1;
    }

    reserve(book, uid) {
        if (!Number.isInteger(uid) || uid < 0 || uid >= UID_LIMIT) return;
        const key = JSON.stringify([book]);
        const raw = this.value.uidWatermarks;
        const table = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
        table[key] = Math.max(this.watermark(book), uid);
        this.write({ uidWatermarks: table });
    }

    write(patch) {
        const context = this.getContext();
        context.extensionSettings[WORKBENCH_SETTINGS] = { ...this.value, ...patch };
        context.saveSettingsDebounced();
    }
}

export function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

export function sameValue(left, right) {
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function contextKey(context) {
    return JSON.stringify([context.groupId ?? null, context.characterId ?? null, context.chatId ?? null]);
}
