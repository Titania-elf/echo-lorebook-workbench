/** Non-blocking top notice, independent of whether the workbench is open. */
export function showSchedulerWarning(message) {
    let host = document.getElementById('echo-scheduler-notifications');
    if (!host) {
        host = document.createElement('div');
        host.id = 'echo-scheduler-notifications';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        if (typeof host.showPopover === 'function') host.setAttribute('popover', 'manual');
        document.body.append(host);
    }
    const notice = document.createElement('div');
    notice.className = 'echo-scheduler-notice';
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = '回声书台';
    const text = document.createElement('div');
    text.textContent = String(message).slice(0, 900);
    body.append(title, text);
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭调度失败通知');
    close.textContent = '×';
    let timer;
    const dismiss = () => {
        clearTimeout(timer);
        notice.remove();
        if (!host.childElementCount) {
            try { host.hidePopover?.(); } catch { /* Older browser/no open popover. */ }
            host.remove();
        }
    };
    close.addEventListener('click', dismiss);
    notice.append(body, close);
    host.append(notice);
    while (host.childElementCount > 3) host.firstElementChild.remove();
    try { host.showPopover?.(); } catch { /* A fixed notice is still visible. */ }
    timer = setTimeout(dismiss, 10000);
}
