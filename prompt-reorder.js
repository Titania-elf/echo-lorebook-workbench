const ROW_SELECTOR = '.wb-prompt-entry-row[data-prompt-entry-id]';
const HANDLE_SELECTOR = '[data-prompt-drag]';
const MOVE_THRESHOLD = 5;
const EDGE_SIZE = 48;
const MAX_SCROLL_SPEED = 0.65;

const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Pointer gestures only mark a drop position; the draft changes once on release. */
export class PromptReorderController {
    constructor({ list, viewport, getIds, canReorder, onReorder, onAnnounce = () => {} }) {
        this.list = list;
        this.viewport = viewport;
        this.getIds = getIds;
        this.canReorder = canReorder;
        this.onReorder = onReorder;
        this.onAnnounce = onAnnounce;
        this.document = list.ownerDocument;
        this.window = this.document.defaultView;
        this.events = new AbortController();
        this.gesture = null;
        this.frame = 0;
        this.disposed = false;
        this.suppressClickUntil = 0;
        const options = { signal: this.events.signal };
        list.addEventListener('pointerdown', event => this.pointerDown(event), options);
        list.addEventListener('keydown', event => this.keyDown(event), options);
        list.addEventListener('click', event => {
            if (!this.handle(event.target) && this.window.performance.now() >= this.suppressClickUntil) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, { ...options, capture: true });
    }

    ids() {
        try {
            const ids = this.getIds();
            return Array.isArray(ids) && ids.every(id => typeof id === 'string') ? [...ids] : [];
        } catch { return []; }
    }

    allowed() {
        try {
            return !this.disposed && this.list.isConnected && this.list.getClientRects().length > 0
                && Boolean(this.canReorder());
        } catch { return false; }
    }

    handle(target) {
        const handle = target?.closest?.(HANDLE_SELECTOR);
        return handle && this.list.contains(handle) ? handle : null;
    }

    rows() {
        return [...this.list.querySelectorAll(ROW_SELECTOR)];
    }

    valid(gesture) {
        return this.gesture === gesture && this.allowed()
            && gesture.row.isConnected && gesture.handle.isConnected && this.list.contains(gesture.row)
            && !gesture.handle.disabled && gesture.row.dataset.promptEntryId === gesture.id
            && sameIds(this.ids(), gesture.ids)
            && sameIds(this.rows().map(row => row.dataset.promptEntryId), gesture.ids);
    }

    pointerDown(event) {
        if (this.gesture || event.isPrimary === false || event.button !== 0 || !this.allowed()) return;
        const handle = this.handle(event.target);
        const row = handle?.closest(ROW_SELECTOR);
        const ids = this.ids();
        const id = row?.dataset.promptEntryId;
        if (!handle || handle.disabled || !row || !ids.includes(id) || ids.length < 2
            || !sameIds(this.rows().map(value => value.dataset.promptEntryId), ids)) return;
        event.preventDefault();
        event.stopPropagation();
        handle.focus({ preventScroll: true });
        const gesture = {
            pointerId: event.pointerId, pointerType: event.pointerType,
            handle, row, id, ids, startX: event.clientX, startY: event.clientY,
            x: event.clientX, y: event.clientY, dragging: false, beforeId: undefined,
            marker: null, markerPosition: '', lastFrame: 0,
        };
        this.gesture = gesture;
        const events = new AbortController();
        this.gestureEvents = events;
        const options = { signal: events.signal };
        this.document.addEventListener('pointermove', event => this.pointerMove(event), { ...options, capture: true, passive: false });
        this.document.addEventListener('pointerup', event => this.pointerUp(event), { ...options, capture: true });
        this.document.addEventListener('pointercancel', event => {
            if (event.pointerId === gesture.pointerId) this.cancel();
        }, { ...options, capture: true });
        handle.addEventListener('lostpointercapture', event => {
            if (event.pointerId === gesture.pointerId) this.cancel();
        }, options);
        this.document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const dragged = gesture.dragging;
            this.cancel();
            if (dragged) this.announce('已取消拖动排序。');
        }, { ...options, capture: true });
        this.window.addEventListener('blur', () => this.cancel(), options);
        this.document.addEventListener('visibilitychange', () => {
            if (this.document.hidden) this.cancel();
        }, options);
        this.list.addEventListener('scroll', () => this.refreshTarget(gesture), { ...options, passive: true });
        if (this.viewport && this.viewport !== this.list) {
            this.viewport.addEventListener('scroll', () => this.refreshTarget(gesture), { ...options, passive: true });
        }
        try { handle.setPointerCapture(event.pointerId); }
        catch { /* Document listeners still track a pointer when capture is unavailable. */ }
        this.frame = this.window.requestAnimationFrame(time => this.tick(time));
    }

    pointerMove(event) {
        const gesture = this.gesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        if (!this.valid(gesture) || (gesture.pointerType === 'mouse' && !(event.buttons & 1))) {
            this.cancel();
            return;
        }
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        if (!gesture.dragging) {
            if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < MOVE_THRESHOLD) return;
            gesture.dragging = true;
            gesture.row.dataset.promptDragging = 'true';
            this.announce('正在拖动提示词，松开后放到插入线位置；按 Escape 可取消。');
        }
        event.preventDefault();
        this.refreshTarget(gesture);
    }

    pointerUp(event) {
        const gesture = this.gesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        if (!this.valid(gesture) || !gesture.dragging) {
            this.cancel();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        this.refreshTarget(gesture);
        if (this.gesture !== gesture) return;
        const { id, beforeId, ids } = gesture;
        const remaining = ids.filter(value => value !== id);
        const index = beforeId === null ? remaining.length : remaining.indexOf(beforeId);
        const next = index >= 0
            ? [...remaining.slice(0, index), id, ...remaining.slice(index)] : ids;
        this.cancel();
        if (beforeId === undefined || sameIds(next, ids)) return;
        this.reorder(id, beforeId);
    }

    visibleRect() {
        const list = this.list.getBoundingClientRect();
        const viewport = this.viewport?.getBoundingClientRect() || list;
        return {
            left: Math.max(list.left, viewport.left, 0),
            right: Math.min(list.right, viewport.right, this.window.innerWidth),
            top: Math.max(list.top, viewport.top, 0),
            bottom: Math.min(list.bottom, viewport.bottom, this.window.innerHeight),
        };
    }

    refreshTarget(gesture) {
        if (!this.valid(gesture)) {
            this.cancel();
            return;
        }
        if (!gesture.dragging) return;
        const rect = this.visibleRect();
        const within = rect.right > rect.left && rect.bottom > rect.top
            && gesture.x >= rect.left - EDGE_SIZE && gesture.x <= rect.right + EDGE_SIZE
            && gesture.y >= rect.top - EDGE_SIZE && gesture.y <= rect.bottom + EDGE_SIZE;
        const rows = this.rows().filter(row => row.dataset.promptEntryId !== gesture.id);
        const before = within ? rows.find(row => {
            const bounds = row.getBoundingClientRect();
            return gesture.y < (bounds.top + bounds.bottom) / 2;
        }) : null;
        const marker = within ? before || rows.at(-1) || null : null;
        const position = before ? 'before' : 'after';
        gesture.beforeId = within ? before?.dataset.promptEntryId ?? null : undefined;
        if (gesture.marker === marker && gesture.markerPosition === position) return;
        if (gesture.marker) delete gesture.marker.dataset.promptDrop;
        gesture.marker = marker;
        gesture.markerPosition = position;
        if (marker) marker.dataset.promptDrop = position;
    }

    edgeSpeed(y, top, bottom) {
        if (bottom <= top) return 0;
        const edge = Math.min(EDGE_SIZE, (bottom - top) / 3);
        if (y < top + edge) return -MAX_SCROLL_SPEED * clamp((top + edge - y) / edge, 0, 1);
        if (y > bottom - edge) return MAX_SCROLL_SPEED * clamp((y - bottom + edge) / edge, 0, 1);
        return 0;
    }

    scrollEdge(viewport, gesture, elapsed, rect) {
        if (!viewport || viewport.clientHeight <= 0 || viewport.scrollHeight <= viewport.clientHeight + 1
            || gesture.x < rect.left - EDGE_SIZE || gesture.x > rect.right + EDGE_SIZE
            || gesture.y < rect.top - EDGE_SIZE || gesture.y > rect.bottom + EDGE_SIZE) return false;
        const speed = this.edgeSpeed(gesture.y, rect.top, rect.bottom);
        if (!speed) return false;
        const previous = viewport.scrollTop;
        viewport.scrollTop = clamp(previous + speed * elapsed, 0, viewport.scrollHeight - viewport.clientHeight);
        return viewport.scrollTop !== previous;
    }

    tick(time) {
        this.frame = 0;
        const gesture = this.gesture;
        if (!gesture) return;
        if (!this.valid(gesture)) {
            this.cancel();
            return;
        }
        if (gesture.dragging) {
            const elapsed = gesture.lastFrame ? clamp(time - gesture.lastFrame, 0, 40) : 16;
            const scrolled = this.scrollEdge(this.list, gesture, elapsed, this.visibleRect());
            if (!scrolled && this.viewport && this.viewport !== this.list) {
                const bounds = this.viewport.getBoundingClientRect();
                this.scrollEdge(this.viewport, gesture, elapsed, {
                    left: Math.max(bounds.left, 0), right: Math.min(bounds.right, this.window.innerWidth),
                    top: Math.max(bounds.top, 0), bottom: Math.min(bounds.bottom, this.window.innerHeight),
                });
            }
            this.refreshTarget(gesture);
        }
        gesture.lastFrame = time;
        if (this.gesture === gesture) this.frame = this.window.requestAnimationFrame(next => this.tick(next));
    }

    keyDown(event) {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key) || this.gesture || !this.allowed()) return;
        const handle = this.handle(event.target);
        const row = handle?.closest(ROW_SELECTOR);
        const id = row?.dataset.promptEntryId;
        if (!handle || handle.disabled || !id) return;
        const ids = this.ids();
        const index = ids.indexOf(id);
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'ArrowUp' && index > 0) this.reorder(id, ids[index - 1]);
        else if (event.key === 'ArrowDown' && index < ids.length - 1) this.reorder(id, ids[index + 2] ?? null);
    }

    reorder(id, beforeId) {
        if (!this.allowed()) return;
        try {
            this.onReorder({ id, beforeId });
            const row = this.rows().find(value => value.dataset.promptEntryId === id);
            row?.querySelector(HANDLE_SELECTOR)?.focus({ preventScroll: true });
            const ids = this.ids();
            const index = ids.indexOf(id);
            if (index >= 0) this.announce(`提示词已移到第 ${index + 1} 项，共 ${ids.length} 项。`);
        } catch {
            this.announce('排序未完成，请重试。');
        }
    }

    announce(message) {
        try { this.onAnnounce(message); }
        catch { /* Announcements must not interrupt pointer cleanup or draft updates. */ }
    }

    cancel() {
        const gesture = this.gesture;
        this.gesture = null;
        this.gestureEvents?.abort();
        this.gestureEvents = null;
        if (this.frame) this.window.cancelAnimationFrame(this.frame);
        this.frame = 0;
        if (!gesture) return;
        if (gesture.dragging) this.suppressClickUntil = this.window.performance.now() + 350;
        delete gesture.row.dataset.promptDragging;
        if (gesture.marker) delete gesture.marker.dataset.promptDrop;
        for (const row of this.rows()) delete row.dataset.promptDrop;
        try {
            if (gesture.handle.hasPointerCapture(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);
        } catch { /* A removed handle or browser cancellation may already release capture. */ }
    }

    dispose() {
        this.cancel();
        this.disposed = true;
        this.events.abort();
    }
}
