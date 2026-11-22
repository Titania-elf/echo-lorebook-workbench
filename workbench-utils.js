export const assetUrl = name => new URL(`./assets/${name}`, import.meta.url).href;

export function displayText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return '[无法显示的数据]'; }
    }
    return String(value);
}

/** Text and values are properties, never interpolated into imported HTML. */
export function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = displayText(value);
        else if (key === 'value') node.value = displayText(value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') node.setAttribute(key, String(value));
        else if (key in node) node[key] = value;
        else node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(displayText(child)));
    }
    return node;
}

// Lucide / Feather-derived utility paths. Copyright and licenses: assets/icon-LICENSE.txt.
const paths = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    help: '<path d="M8 8a4 4 0 0 1 8 0c0 3-4 3-4 6"/><path d="M12 19h.01"/>',
    grip: '<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/>',
    code: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    book: '<path d="M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 22a10 10 0 1 1 10-10 4 4 0 0 1-4 4h-2a2 2 0 0 0-1.4 3.4A1.5 1.5 0 0 1 12 22Z"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    pin: '<path d="M16 3H8l1 7-3 3v2h12v-2l-3-3zM12 15v7"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    refresh: '<path d="M3 11a9 9 0 0 1 15.4-6.4L21 7M21 3v4h-4M21 13a9 9 0 0 1-15.4 6.4L3 17M3 21v-4h4"/>',
    message: '<path d="M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
};

export function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('wb-icon');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    svg.innerHTML = paths[name] || paths.file;
    return svg;
}

export function button(text, { glyph, kind = 'secondary', iconOnly = false, ...attributes } = {}) {
    const className = iconOnly ? 'wb-icon-button' : `wb-button wb-${kind}`;
    const result = element('button', { type: 'button', class: className, ...attributes });
    if (glyph) result.append(icon(glyph));
    if (text && !iconOnly) result.append(document.createTextNode(text));
    if (iconOnly) result.setAttribute('aria-label', text);
    return result;
}

export function badge(text, glyph) {
    return element('span', { class: 'wb-badge' }, glyph ? icon(glyph) : null, text);
}

export function entryTitle(entry, uid) {
    return displayText(entry.comment) || (Array.isArray(entry.key) ? entry.key.map(displayText).join('、') : '') || `条目 ${uid}`;
}

export function errorView(message, onRetry) {
    return element('div', { class: 'wb-error', role: 'alert' }, icon('info'),
        element('p', { text: message }), onRetry ? button('重新读取', { glyph: 'refresh', onclick: onRetry }) : null);
}

export class SheetController {
    constructor(root) {
        this.root = root;
        this.layer = root.querySelector('[data-wb="sheet-layer"]');
        this.panel = root.querySelector('[data-wb="sheet"]');
        this.title = root.querySelector('[data-wb="sheet-title"]');
        this.body = root.querySelector('[data-wb="sheet-body"]');
        this.focusBefore = null;
        this.onDismiss = null;
        this.root.querySelectorAll('[data-wb="sheet-close"]').forEach(control => control.addEventListener('click', () => this.close()));
        this.keyHandler = event => {
            if (this.layer.hidden) return;
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); this.close(); return;
            }
            if (event.key !== 'Tab') return;
            const controls = [...this.panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')]
                .filter(control => control.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        this.layer.addEventListener('keydown', this.keyHandler);
    }

    open(title, content, { onDismiss } = {}) {
        this.close();
        this.focusBefore = document.activeElement;
        this.title.textContent = title;
        this.body.replaceChildren(content);
        this.onDismiss = onDismiss || null;
        this.layer.hidden = false;
        for (const child of this.root.children) if (child !== this.layer && !child.classList.contains('wb-toast')) child.inert = true;
        this.panel.scrollTop = 0;
        this.body.scrollTop = 0;
        this.root.dispatchEvent(new Event('wb-layout'));
        queueMicrotask(() => { if (!this.layer.hidden) this.panel.querySelector('[data-wb="sheet-close"]')?.focus({ preventScroll: true }); });
    }

    close() {
        if (this.layer.hidden) return;
        this.layer.hidden = true;
        for (const child of this.root.children) child.inert = false;
        const dismiss = this.onDismiss;
        this.onDismiss = null;
        this.root.dispatchEvent(new Event('wb-layout'));
        if (this.focusBefore?.isConnected) this.focusBefore.focus({ preventScroll: true });
        dismiss?.();
    }

    choose(title, content, choices) {
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true; this.onDismiss = null; this.close(); resolve(value);
            };
            const controls = element('div', { class: 'wb-sheet-choice-actions' }, choices.map(choice => button(choice.label, {
                kind: choice.kind || 'secondary', onclick: () => finish(choice.value),
            })));
            const body = element('div', { class: 'wb-sheet-choice' }, content, controls);
            this.open(title, body, { onDismiss: () => finish('cancel') });
        });
    }

    dispose() {
        this.close();
        this.layer.removeEventListener('keydown', this.keyHandler);
    }
}
