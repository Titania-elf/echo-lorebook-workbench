import { element } from './workbench-utils.js';

export function scrollRegion(viewport, className = '') {
    viewport.dataset.wbScroll = '';
    return element('div', { class: `wb-scroll-shell ${className}`.trim() }, viewport);
}

function horizontalDrag(viewport) {
    const events = new AbortController();
    const options = { signal: events.signal };
    let drag = null;
    let suppressClickUntil = 0;
    viewport.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX, scroll: viewport.scrollLeft, moved: false };
    }, options);
    viewport.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (!(event.buttons & 1)) { drag = null; return; }
        const distance = event.clientX - drag.x;
        if (!drag.moved && Math.abs(distance) < 5) return;
        if (!drag.moved) { drag.moved = true; viewport.setPointerCapture(event.pointerId); }
        event.preventDefault();
        viewport.scrollLeft = drag.scroll - distance;
    }, options);
    const finish = event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (drag.moved) suppressClickUntil = performance.now() + 300;
        if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
        drag = null;
    };
    viewport.addEventListener('pointerup', finish, options);
    viewport.addEventListener('pointercancel', finish, options);
    viewport.addEventListener('lostpointercapture', finish, options);
    viewport.addEventListener('pointerleave', () => { if (drag && !drag.moved) drag = null; }, options);
    viewport.addEventListener('click', event => {
        if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { ...options, capture: true });
    viewport.addEventListener('wheel', event => {
        if (viewport.scrollWidth <= viewport.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        const previous = viewport.scrollLeft;
        viewport.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1);
        if (previous !== viewport.scrollLeft) event.preventDefault();
    }, { ...options, passive: false });
    return () => events.abort();
}

/** Only vertical scroll indicators are painted; horizontal strips stay undecorated. */
export class WorkbenchScrollbars {
    constructor(root) {
        this.root = root;
        this.targets = new Map();
        this.strips = new Map();
        this.frame = 0;
        this.disposed = false;
        this.layoutHandler = () => this.refresh();
        root.addEventListener('wb-layout', this.layoutHandler);
    }

    refresh() {
        if (this.disposed) return;
        for (const [viewport, controller] of this.targets) {
            if (!this.root.contains(viewport)) { controller.dispose(); this.targets.delete(viewport); }
        }
        for (const [viewport, dispose] of this.strips) {
            if (!this.root.contains(viewport)) { dispose(); this.strips.delete(viewport); }
        }
        this.root.querySelectorAll('[data-wb-horizontal]').forEach(viewport => {
            if (!this.strips.has(viewport)) this.strips.set(viewport, horizontalDrag(viewport));
        });
        this.root.querySelectorAll('[data-wb-scroll]').forEach(viewport => {
            if (this.targets.has(viewport) || !viewport.parentElement?.classList.contains('wb-scroll-shell')) return;
            this.targets.set(viewport, this.mount(viewport));
        });
        if (!this.frame) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            if (!this.disposed) for (const controller of this.targets.values()) controller.paint();
        });
    }

    mount(viewport) {
        const shell = viewport.parentElement;
        const thumb = element('i', { class: 'wb-scroll-thumb' });
        const rail = element('span', { class: 'wb-scroll-rail', 'aria-hidden': 'true', hidden: true }, thumb);
        shell.append(rail);
        const events = new AbortController();
        let timer;
        const paint = () => {
            const overflow = viewport.scrollHeight - viewport.clientHeight;
            rail.hidden = viewport.clientHeight <= 0 || overflow <= 1;
            if (rail.hidden) return;
            const track = Math.max(0, shell.clientHeight - 12);
            const height = Math.min(track, Math.max(16, track * viewport.clientHeight / viewport.scrollHeight));
            thumb.style.height = `${height}px`;
            thumb.style.top = `${Math.min(1, Math.max(0, viewport.scrollTop / overflow)) * (track - height)}px`;
        };
        const hideAfter = delay => {
            clearTimeout(timer);
            timer = setTimeout(() => shell.classList.remove('wb-scrolling'), delay);
        };
        viewport.addEventListener('scroll', () => { shell.classList.add('wb-scrolling'); paint(); hideAfter(360); }, { signal: events.signal, passive: true });
        viewport.addEventListener('scrollend', () => hideAfter(120), { signal: events.signal, passive: true });
        const observer = new ResizeObserver(() => this.refresh());
        observer.observe(viewport);
        observer.observe(shell);
        return {
            paint,
            dispose: () => { events.abort(); observer.disconnect(); clearTimeout(timer); rail.remove(); shell.classList.remove('wb-scrolling'); },
        };
    }

    dispose() {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        this.root.removeEventListener('wb-layout', this.layoutHandler);
        for (const controller of this.targets.values()) controller.dispose();
        for (const dispose of this.strips.values()) dispose();
        this.targets.clear(); this.strips.clear();
    }
}
