import { sourceFingerprint } from '../scheduler/core.js';
import { WORKBENCH_SETTINGS } from '../workbench/workbench-state.js';
import { bookCategories, entryCategory } from './book-categories.js';

export const ORGANIZATION_VERSION = 1;
export const SUMMARY_LIMIT = 120;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function organizationMetadata(data) {
    const value = data?.extensions?.[WORKBENCH_SETTINGS]?.organization;
    return object(value) && value.version === ORGANIZATION_VERSION && object(value.cards) ? value : null;
}

export function organizationAncestors(metadata, uid) {
    const card = metadata && Object.hasOwn(metadata.cards, uid) ? metadata.cards[uid] : null;
    const values = card?.ancestors;
    return Array.isArray(values) ? [...new Set(values.filter(id => typeof id === 'string' && id && id !== uid))] : [];
}

function readCard(metadata, entry, uid, categories, data) {
    if (!object(entry) || !['string', 'number'].includes(typeof entry.uid) || String(entry.uid) !== uid
        || !Object.hasOwn(metadata.cards, uid)) return null;
    const card = metadata.cards[uid];
    if (!card || typeof card.summary !== 'string' || !card.summary.trim() || card.summary.length > SUMMARY_LIMIT
        || card.fingerprint !== sourceFingerprint(entry)) return null;
    return { summary: card.summary, category: categories.get(entryCategory(data, uid)) || '',
        ancestors: organizationAncestors(metadata, uid) };
}

/** Do not take over part of a book whose source no longer matches its committed directory. */
export function readOrganizationIndex(data) {
    const metadata = organizationMetadata(data);
    if (!metadata || !object(data.entries)) return null;
    const rows = Object.entries(data.entries);
    if (Object.keys(metadata.cards).length !== rows.length) return null;
    const categories = new Map(bookCategories(data).map(value => [value.id, value.name]));
    const index = new Map();
    for (const [uid, entry] of rows) {
        const card = readCard(metadata, entry, uid, categories, data);
        if (!card) return null;
        index.set(uid, card);
    }
    return index;
}

/** A locally edited draft must not display an unrelated saved summary. */
export function organizationSummary(data, entry) {
    const metadata = organizationMetadata(data);
    const uid = String(entry.uid);
    const card = metadata && Object.hasOwn(metadata.cards, uid) ? metadata.cards[uid] : null;
    return card && card.fingerprint === sourceFingerprint(entry) && typeof card.summary === 'string'
        ? card.summary : '';
}

export function organizationBackupName(data, book) {
    const backup = organizationMetadata(data)?.backup;
    return backup?.book === book && typeof backup.name === 'string' && backup.name && backup.name !== book ? backup.name : '';
}
