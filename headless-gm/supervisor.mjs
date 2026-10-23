// Headless GM supervisor: keeps one headless Chromium logged into Foundry's active
// world as a dedicated GM user so system-side bridge code (e.g. covert-ops-d20's
// derived cache / damage relay) runs without a human GM browser.
// Env: FOUNDRY_URL, GM_USER (default gm-headless), GM_PASSWORD, PORT (8080),
//      BRIDGE_FLAG_VALUE (default "headless"), CHECK_MS (5000).
import http from 'node:http';
import { chromium } from 'playwright-core';

const URL_ = (process.env.FOUNDRY_URL || '').replace(/\/+$/, '');
const USER = process.env.GM_USER || 'gm-headless';
const PASS = process.env.GM_PASSWORD || '';
const PORT = Number(process.env.PORT || 8080);
const FLAG = process.env.BRIDGE_FLAG_VALUE || 'headless';
const CHECK_MS = Number(process.env.CHECK_MS || 5000);
// System id -> user flag that marks this client as a bridge-serving GM browser.
const BRIDGE_FLAGS = { 'covert-ops-d20': 'bridgeClient' };

const st = { state: 'starting', world: null, system: null, flagged: false, since: Date.now(), tick: Date.now(), lastErr: null, logins: 0 };
let browser = null;
let page = null;
let backoff = 5000;
let cdp = null;
let lastTask = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
function setState(s, extra = {}) {
  if (s !== st.state) { log(`state ${st.state} -> ${s}`, Object.keys(extra).length ? JSON.stringify(extra) : ''); st.since = Date.now(); }
  Object.assign(st, { state: s }, extra);
}

http.createServer((req, res) => {
  const ok = req.url.startsWith('/livez') ? Date.now() - st.tick < 180000 : st.state === 'ready';
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok, ...st, lastErr: st.lastErr?.slice(0, 200) }));
}).listen(PORT, () => log(`listening :${PORT} url=${URL_} user=${USER}`));

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'] });
  browser.on('disconnected', () => { log('browser disconnected'); browser = null; page = null; });
  log('browser launched');
}

async function newPage() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  const ctx = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 720 } }));
  page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  // No canvas: this client only needs the data layer + system hooks.
  await page.addInitScript(() => { try { localStorage.setItem('core.noCanvas', 'true'); } catch {} });
  // Nobody watches this page: collapse CSS animations/transitions (spinners etc. otherwise keep the
  // software compositor busy, ~250m CPU -> ~10m). 1ms + single iteration keeps *end events firing.
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important}';
    document.head.append(s);
  }));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  cdp = await ctx.newCDPSession(page).catch(() => null);
  lastTask = null;
  await cdp?.send('Performance.enable').catch(() => {});
  page.on('pageerror', (e) => log('pageerror', String(e).slice(0, 160)));
}

/** One login attempt. Returns ms to wait before the next attempt (0 = logged in). */
async function login() {
  await ensureBrowser();
  await newPage();
  await page.goto(`${URL_}/join`, { waitUntil: 'domcontentloaded' });
  const path = new URL(page.url()).pathname;
  if (!path.endsWith('/join')) { setState('no-world', { world: null, flagged: false, lastErr: `redirected to ${path}` }); return 60000; }
  await page.waitForSelector('select[name=userId]', { timeout: 30000 });
  const world = await page.evaluate(() => document.querySelector('meta[name="world"]')?.content || document.title);
  const opt = await page.evaluate((n) => { const o = [...document.querySelectorAll('select[name=userId] option')].find((o) => o.textContent.trim() === n); return o && { id: o.value, disabled: o.disabled }; }, USER);
  if (!opt) { setState('user-not-in-world', { world, flagged: false, lastErr: `user ${USER} not in world` }); return 120000; }
  // Disabled = Foundry still sees an active session for this user (e.g. old pod not yet timed out).
  if (opt.disabled) { setState('user-busy', { world, flagged: false, lastErr: `user ${USER} already connected elsewhere` }); return 15000; }
  const id = opt.id;
  await page.selectOption('select[name=userId]', id);
  await page.fill('input[name=password]', PASS);
  await page.click('button[name=join]');
  try {
    await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 90000 });
  } catch (e) {
    const msg = await page.evaluate(() => document.querySelector('#notifications .error, .notification.error')?.textContent?.trim()).catch(() => null);
    throw new Error(`join failed: ${msg || e.message.split('\n')[0]}`);
  }
  st.logins++;
  const info = await page.evaluate(async (flags) => {
    const key = flags[game.system.id];
    if (!game.user.isGM) return { world: game.world.id, system: game.system.id, err: 'user is not a GM' };
    if (key && game.user.getFlag(game.system.id, key) !== flags.__v) await game.user.setFlag(game.system.id, key, flags.__v);
    return { world: game.world.id, system: game.system.id, flagged: !!key && game.user.getFlag(game.system.id, key) === flags.__v };
  }, { ...BRIDGE_FLAGS, __v: FLAG });
  if (info.err) { setState('not-gm', { ...info, lastErr: info.err }); return 300000; }
  if (!info.flagged) { setState('no-bridge-system', { ...info, lastErr: `system ${info.system} has no bridge flag` }); return 0; }
  setState('ready', { ...info, lastErr: null });
  return 0;
}

async function healthy() {
  if (!browser?.isConnected() || !page || page.isClosed()) return false;
  if (!new URL(page.url()).pathname.endsWith('/game')) return false;
  const h = await page.evaluate(() => ({ ok: !!(window.game?.ready && game.socket?.connected), noCanvas: game.settings.get('core', 'noCanvas'), canvas: !!window.canvas?.ready })).catch(() => null);
  if (h) Object.assign(st, { noCanvas: h.noCanvas, canvas: h.canvas });
  if (h?.ok && cdp) {
    const m = (await cdp.send('Performance.getMetrics').catch(() => null))?.metrics?.find((x) => x.name === 'TaskDuration')?.value;
    if (m != null) { const now = Date.now(); if (lastTask) st.rendererBusy = +((m - lastTask.v) / ((now - lastTask.t) / 1000)).toFixed(3); lastTask = { v: m, t: now }; }
  }
  return !!h?.ok;
}

async function main() {
  if (!URL_ || !PASS) { setState('misconfigured', { lastErr: 'FOUNDRY_URL / GM_PASSWORD missing' }); }
  for (;;) {
    st.tick = Date.now();
    if (st.state === 'misconfigured') { await sleep(60000); continue; }
    if (['ready', 'no-bridge-system'].includes(st.state)) {
      if (await healthy()) { await sleep(CHECK_MS); continue; }
      // Foundry's own client reconnects after brief socket drops; give it ~30s first.
      let ok = false;
      for (let i = 0; i < 6 && !ok && browser?.isConnected(); i++) { await sleep(5000); st.tick = Date.now(); ok = await healthy(); }
      if (ok) continue;
      setState('reconnecting', { flagged: false });
    }
    try {
      const wait = await login();
      backoff = 5000;
      if (wait) await sleep(wait);
    } catch (e) {
      setState('error', { flagged: false, lastErr: String(e.message || e).split('\n')[0] });
      log('login error:', st.lastErr, `retry in ${backoff / 1000}s`);
      if (!browser?.isConnected()) browser = null;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 120000);
    }
  }
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await browser?.close().catch(() => {}); process.exit(0); });
main();
