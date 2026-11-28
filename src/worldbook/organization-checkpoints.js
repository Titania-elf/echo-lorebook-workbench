import { accountsEnabled, currentUser, getCurrentUserHandle } from '../../../../../user.js';

const SERVER_ROOT = new URL('../../../../../../', import.meta.url).href;
const STORE = 'books';

/** Local drafts only. A checkpoint contains validated spans and metadata, not the original book or credentials. */
export class OrganizationCheckpointStore {
    key(book) {
        if (accountsEnabled && !currentUser?.handle) throw new Error('尚未取得当前酒馆账号，无法保存整理进度。');
        return JSON.stringify([SERVER_ROOT, getCurrentUserHandle(), book]);
    }

    async open() {
        this.database ||= new Promise((resolve, reject) => {
            if (!globalThis.indexedDB) { reject(new Error('当前浏览器无法保存整理进度。')); return; }
            const request = globalThis.indexedDB.open('echo-workbench-organization', 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); this.database = null; };
                resolve(db);
            };
        });
        try { return await this.database; }
        catch (error) { this.database = null; throw error; }
    }

    async read(book) {
        const key = this.key(book);
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readonly');
            const request = transaction.objectStore(STORE).get(key);
            transaction.oncomplete = () => resolve(request.result ?? null);
            transaction.onabort = () => reject(transaction.error || new Error('读取整理进度失败。'));
        });
    }

    /** Do not overwrite or clear a more recent draft from another tab. */
    async replace(book, previous, next) {
        const key = this.key(book);
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE);
            const request = store.get(key);
            let updated = null;
            let conflict = false;
            request.onsuccess = () => {
                const actual = request.result;
                if (actual?.backup !== previous?.backup || actual?.revision !== previous?.revision) {
                    conflict = true;
                    transaction.abort();
                    return;
                }
                if (next) {
                    updated = { ...next, revision: (actual?.revision || 0) + 1 };
                    store.put(updated, key);
                } else store.delete(key);
            };
            transaction.oncomplete = () => resolve(updated);
            transaction.onabort = () => reject(conflict ? new Error('本机另一窗口已更新整理进度，请重新打开整理页。')
                : transaction.error || new Error('未能保存整理进度。'));
        });
    }
}
