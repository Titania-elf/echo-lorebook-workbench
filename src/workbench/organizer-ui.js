import { historyConnectionInfo } from '../history/scheduler-history.js';
import { organizationBackupName, organizationMetadata } from '../worldbook/organization-index.js';
import { clone, contextKey } from './workbench-state.js';
import { scrollRegion } from './workbench-scroll.js';
import { button, element } from './workbench-utils.js';

const PAGE_SIZE = 24;
const keysText = keys => keys.length ? keys.join('、') : '未填写';
const KIND_LABEL = { green: '绿灯', blue: '蓝灯', vector: '向量' };

export class OrganizerUI {
    constructor(board) {
        this.board = board;
        this.view = element('section', { class: 'wb-feature-view' });
        this.actions = element('div', { class: 'wb-organize-actions' });
        this.message = '';
    }

    open(book) {
        if (book !== this.book) {
            if (this.draft?.pending) throw new Error(`请先回到《${this.book}》核对上次写回结果。`);
            this.cancel();
            Object.assign(this, { book, job: null, draft: null, message: '', error: '', page: 0 });
        }
        this.render();
    }

    cancel() {
        this.job?.abort();
    }

    contextChanged() {
        this.cancel();
        if (this.draft && !this.saving && !this.draft.pending) {
            this.draft = null;
            this.error = '';
            this.message = '当前聊天已切换，已放弃预览。原书未写回。';
            this.render();
        }
    }

    data() { return this.board.store.loaded.get(this.book); }

    connection(context = this.board.getContext(), config = this.board.director.config) {
        const info = historyConnectionInfo(context, config);
        return [info.schemeName, info.model].filter(Boolean).join(' / ');
    }

    assertAvailable() {
        if (this.board.categories.pending) throw new Error('请先核对上次分类保存结果。');
        this.board.organizer.assertIdle();
    }

    async start() {
        this.assertAvailable();
        if (this.board.apiSettings?.dirty) throw new Error('请先保存或放弃尚未保存的 API 设置。');
        const { board, book } = this;
        const current = board.getContext();
        // Use the connection settings shown here even if the host UI changes while making the backup.
        const context = { ...current, chatCompletionSettings: clone(current.chatCompletionSettings) };
        const config = clone(board.director.config);
        const origin = contextKey(context);
        const choice = await board.sheets.choose('备份并发送全文？', element('div', {},
            element('p', { text: `世界书：《${book}》` }),
            element('p', { text: `API 方案：${this.connection(context, config)}` }),
            element('p', { class: 'wb-help', text: '先确认整本备份保存成功，再向此连接发送已保存的条目全文（含禁用条目）。分析完成只展示预览，不会直接写回原书。' })),
        [{ label: '取消', value: 'cancel' }, { label: '备份并发送全文', value: 'start', kind: 'primary' }]);
        if (choice !== 'start' || book !== this.book || board.view !== 'organizer' || contextKey(board.getContext()) !== origin) return;
        await this.prepare((signal, progress) => board.organizer.prepare(book, { context, config, signal, onProgress: progress }));
    }

    async restore() {
        this.assertAvailable();
        const book = this.book;
        await this.prepare(signal => this.board.organizer.prepareRestore(book, signal));
    }

    async prepare(action) {
        if (this.job || this.saving || this.draft?.pending) return;
        const job = new AbortController();
        Object.assign(this, { job, error: '', message: '', page: 0, draft: null });
        this.progress = '正在读取世界书…';
        this.render();
        try {
            const draft = await action(job.signal, text => {
                if (this.job !== job || job.signal.aborted) return;
                this.progress = text;
                if (this.progressNode) this.progressNode.textContent = text;
            });
            if (this.job === job && !job.signal.aborted) this.draft = draft;
        } catch (error) {
            if (this.job === job && !job.signal.aborted) this.error = error.message || '整理未完成，原书未写回。';
        } finally {
            if (this.job === job) {
                this.job = null;
                if (job.signal.aborted) this.message = '已取消。没有写回原书；已创建的备份会保留。';
                this.render();
            }
        }
    }

    async apply() {
        const draft = this.draft;
        if (!draft || this.saving) return;
        this.assertAvailable();
        const restoring = draft.action === 'restore';
        if (!draft.pending) {
            const label = restoring ? '恢复同名原书' : '确认写回原书';
            const choice = await this.board.sheets.choose(`${label}？`, element('div', {},
                element('p', { text: `《${draft.book}》将保存为 ${draft.afterCount} 个条目。备份：《${draft.backup}》。` }),
                element('p', { class: 'wb-help', text: restoring
                    ? '这会用备份替换当前原书，备份之后新增或修改的内容不会留在原书中。请先另存还需要的改动。'
                    : '会替换原书中的拆分条目、分类、绿灯关键词和目录，影响所有使用此书的聊天。' })),
            [{ label: '取消', value: 'cancel' }, { label, value: 'write', kind: restoring ? 'danger' : 'primary' }]);
            if (choice !== 'write' || draft !== this.draft || this.board.view !== 'organizer') return;
        }
        this.saving = true;
        this.error = '';
        this.message = '';
        this.render();
        try {
            const result = await this.board.organizer.apply(draft);
            if (result.written) {
                this.draft = null;
                this.message = restoring ? `已从《${draft.backup}》恢复原书。` : `已写回 ${draft.afterCount} 个条目。备份《${draft.backup}》已保留。`;
                if (result.warning) this.message += ` ${result.warning}`;
                this.board.onBindingsChanged();
            } else this.message = '原书仍是写回前的版本。可重新确认写回，或放弃预览。';
        } catch (error) {
            this.error = error.message || '未能保存，请重新读取原书。';
        } finally {
            this.saving = false;
            this.render();
        }
    }

    groupView(group) {
        const count = group.children.length;
        const details = element('details', { class: 'wb-organize-group' }, element('summary', {},
            element('strong', { text: group.title }), element('span', { class: 'wb-help', text: `#${group.uid}　${KIND_LABEL[group.kind]}　${count > 1 ? `拆为 ${count} 条` : '不拆分'}` })));
        details.addEventListener('toggle', () => {
            if (!details.open || details.childElementCount > 1) return;
            const rows = group.children.map(part => element('li', { class: 'wb-organize-part' },
                element('strong', { text: `${part.title}　#${part.uid}` }),
                element('p', { text: `分类：${part.category}` }),
                group.kind === 'green' ? element('p', { text: `主关键词：${keysText(part.keywords)}` }) : null,
                element('p', { class: 'wb-help', text: `摘要：${part.summary}` }),
                element('details', { class: 'wb-organize-slice' }, element('summary', { text: '查看对应原文' }),
                    part.content ? element('pre', { text: part.content }) : element('p', { class: 'wb-help', text: '原条目无正文' }))));
            details.append(element('div', { class: 'wb-organize-group-body' },
                element('p', { class: 'wb-help', text: `原分类：${group.category || '未分类'}${group.kind === 'green' ? `；原关键词：${keysText(group.keywords)}` : ''}` }),
                group.restriction ? element('p', { class: 'wb-help', text: `保留整条：${group.restriction}。` }) : null,
                element('ol', {}, rows)));
        });
        return details;
    }

    render() {
        const { board, draft } = this;
        const data = this.data();
        const ready = board.organizationDirectory(data);
        const backup = organizationBackupName(data, this.book);
        const state = ready ? '调度目录已就绪' : organizationMetadata(data) ? '目录已过期 · 使用原生触发' : '尚无调度目录 · 使用原生触发';
        const title = element('div', { class: 'wb-organize-title' },
            element('h2', { text: this.book }), element('p', { class: 'wb-help', text: state }));
        const content = element('div', { class: 'wb-organize-body' }, title);
        this.progressNode = element('p', { class: 'wb-help wb-organize-status', role: 'status', text: this.job ? this.progress : this.saving ? '正在处理写回…' : this.message });
        const controls = [button('返回条目列表', { glyph: 'back', disabled: this.saving,
            onclick: () => { this.cancel(); board.renderEntries(); } })];
        if (this.job) {
            content.append(this.progressNode);
            controls.push(button('取消分析', { onclick: () => this.cancel() }));
        } else if (draft) {
            const restoring = draft.action === 'restore';
            const beforeCount = Object.keys(draft.baseline.entries).length;
            content.append(element('p', { class: 'wb-organize-preview', text: restoring
                ? `恢复预览：${beforeCount} 个当前条目将替换为备份中的 ${draft.afterCount} 个条目。`
                : `整理预览：${beforeCount} 个原条目 → ${draft.afterCount} 个条目。原文可按顺序完整拼回。` }),
            element('p', { class: 'wb-help', text: `独立备份：《${draft.backup}》` }), this.progressNode);
            if (!restoring) {
                content.append(element('p', { class: 'wb-help', text: '展开条目可核对分类、原词／新词和对应原文。旧固定和排除继承到子条，固定仍受调度预算限制。' }));
                const pages = Math.max(1, Math.ceil(draft.groups.length / PAGE_SIZE));
                const page = this.page;
                if (pages > 1) content.append(element('div', { class: 'wb-organize-pages' },
                    button('上一页', { disabled: page === 0, onclick: () => { this.page--; this.render(); } }),
                    element('span', { class: 'wb-help', text: `${page + 1} / ${pages}` }),
                    button('下一页', { disabled: page + 1 >= pages, onclick: () => { this.page++; this.render(); } })));
                const list = element('div', { class: 'wb-organize-groups' }, draft.groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(group => this.groupView(group)));
                content.append(list);
            }
            if (!draft.pending) controls.push(button('放弃预览', { disabled: this.saving, onclick: () => {
                this.draft = null; this.error = ''; this.message = '已放弃预览，未写回原书。'; this.render();
            } }));
            if (!draft.conflict) controls.push(button(draft.pending ? '核对保存结果' : restoring ? '恢复同名原书' : '确认写回原书', {
                kind: restoring && !draft.pending ? 'danger' : 'primary', glyph: draft.pending ? 'refresh' : 'save',
                disabled: this.saving, onclick: () => board.run(() => this.apply()),
            }));
        } else {
            content.append(element('p', { text: '先保存独立备份，再使用辅助模型通读整本书。模型只建议拆分位置、分类、绿灯主关键词和短摘要，不改写正文。' }),
                element('p', { class: 'wb-help', text: `当前 API 方案：${this.connection()}` }));
            if (backup) {
                content.append(element('p', { class: 'wb-help', text: `最近备份：《${backup}》` }));
                controls.push(button('预览恢复备份', { glyph: 'refresh', onclick: () => board.run(() => this.restore()) }));
            }
            content.append(this.progressNode);
            controls.push(button('备份并整理', { kind: 'primary', glyph: 'layers', onclick: () => board.run(() => this.start()) }));
        }
        if (this.error) title.after(element('p', { class: 'wb-error wb-organize-error', role: 'alert', text: this.error }));
        this.view.replaceChildren(scrollRegion(content, 'wb-fill-scroll'));
        this.actions.replaceChildren(...controls);
        if (board.view === 'organizer') board.scrollbars?.refresh();
    }
}
