// Runs a real browser against an isolated loopback fixture, never the user's chat or API.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const candidates = [process.argv[2],
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
let browser;
for (const candidate of candidates) {
    try { await access(candidate); browser = candidate; break; } catch { /* Try next browser. */ }
}
if (!browser) throw new Error('Pass a Chrome/Edge executable as the first argument.');
const allowed = new Set([
    '/core.js', '/director.js', '/ui.js', '/workbench-utils.js', '/settings.html', '/style.css', '/tests/browser-smoke.html',
    ...['tokens', 'themes', 'base', 'workbench', 'books', 'entries', 'editor', 'scheduler', 'overlays', 'settings'].map(name => `/styles/${name}.css`),
    '/assets/echo-mark.svg', '/assets/echo-rounded.ttf',
]);
const root = new URL('../', import.meta.url);
const server = createServer(async (req, res) => {
    try {
        if (!allowed.has(req.url)) { res.writeHead(404).end(); return; }
        const content = await readFile(new URL(req.url.slice(1), root));
        const contentType = req.url.endsWith('.js') ? 'text/javascript; charset=utf-8' :
            req.url.endsWith('.css') ? 'text/css; charset=utf-8' :
                req.url.endsWith('.svg') ? 'image/svg+xml' : req.url.endsWith('.ttf') ? 'font/ttf' : 'text/html; charset=utf-8';
        res.setHeader('Content-Type', contentType);
        res.end(content);
    } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'echo-lorebook-workbench-browser-'));
let child;
try {
    const url = `http://127.0.0.1:${server.address().port}/tests/browser-smoke.html`;
    child = spawn(browser, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=5000', '--window-size=390,844', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child.kill(), 30000);
    try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        assert.equal(code, 0, `Browser failed: ${errors.slice(-1500)}`);
        const result = output.match(/<pre id="test-result" data-state="([^"]+)">([\s\S]*?)<\/pre>/);
        assert.equal(result?.[1], 'passed', result?.[2] || output.slice(-1500));
        console.log(result[2]);
    } finally { clearTimeout(timer); }
} finally {
    if (child?.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
