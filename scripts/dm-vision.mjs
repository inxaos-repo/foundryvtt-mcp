#!/usr/bin/env node
/**
 * dm-vision: screenshot what a PLAYER sees in Foundry VTT.
 *
 * Logs in as a non-GM Foundry user with headless Chromium (Playwright), waits
 * for the canvas to be ready and saves a PNG of the player's view: the scene
 * the player is on (normally the active scene), with that user's vision/fog,
 * optionally panned onto one token.
 *
 * Credentials come from an env file (never from argv, never printed):
 *   FOUNDRY_URL=http://192.168.2.157/
 *   FOUNDRY_USER=dm-vision
 *   FOUNDRY_PASS=...
 * Default file: ~/.config/foundry-dm-vision/creds.env (keep it mode 600).
 *
 * Usage:
 *   node scripts/dm-vision.mjs [--out shot.png] [--token <id|name>] [--scale 1]
 *        [--scene <id|name>] [--hide-ui] [--width 1600 --height 1000]
 *        [--wait-ms 2500] [--env <file>] [--login-only] [--print-combat]
 *
 * Exit codes: 0 ok, 2 bad args/creds file, 3 login failed, 4 canvas not ready.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const a = { out: 'dm-vision.png', width: 1600, height: 1000, waitMs: 2500, scale: undefined };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    switch (k) {
      case '--out': a.out = v(); break;
      case '--token': a.token = v(); break;
      case '--scale': a.scale = Number(v()); break;
      case '--scene': a.scene = v(); break;
      case '--hide-ui': a.hideUi = true; break;
      case '--width': a.width = Number(v()); break;
      case '--height': a.height = Number(v()); break;
      case '--wait-ms': a.waitMs = Number(v()); break;
      case '--env': a.env = v(); break;
      case '--login-only': a.loginOnly = true; break;
      case '--print-combat': a.printCombat = true; break;
      case '-h':
      case '--help':
        console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
        process.exit(0);
        break;
      default:
        console.error(`unknown argument: ${k}`);
        process.exit(2);
    }
  }
  return a;
}

function loadCreds(file) {
  let text;
  try {
    const st = statSync(file);
    if ((st.mode & 0o077) !== 0) {
      console.error(`warning: ${file} is readable by group/others; chmod 600 it`);
    }
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`cannot read creds file ${file}`);
    process.exit(2);
  }
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const k of ['FOUNDRY_URL', 'FOUNDRY_USER', 'FOUNDRY_PASS']) {
    if (!env[k]) {
      console.error(`creds file missing ${k}`);
      process.exit(2);
    }
  }
  return env;
}

const args = parseArgs(process.argv.slice(2));
const creds = loadCreds(args.env ?? join(homedir(), '.config/foundry-dm-vision/creds.env'));
const base = creds.FOUNDRY_URL.replace(/\/+$/, '');

const browser = await chromium.launch({
  headless: true,
  // WebGL in headless Chromium: software GL so the PIXI canvas renders.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
  await page.goto(`${base}/join`, { waitUntil: 'domcontentloaded' });

  // Pick the user (v14: select[name=userId]; older: userid), then password.
  const sel = page.locator('select[name="userId"], select[name="userid"]');
  await sel.waitFor({ timeout: 20000 });
  const userId = await sel.evaluate(
    (el, name) => [...el.options].find((o) => o.textContent.trim() === name)?.value ?? '',
    creds.FOUNDRY_USER,
  );
  if (!userId) {
    console.error(`user "${creds.FOUNDRY_USER}" is not in the join list (world not running or user missing)`);
    process.exit(3);
  }
  await sel.selectOption(userId);
  await page.fill('input[name="password"]', creds.FOUNDRY_PASS);
  await Promise.all([
    page.waitForURL(/\/game/, { timeout: 30000 }).catch(() => null),
    page.click('button[name="join"]'),
  ]);
  if (!/\/game/.test(page.url())) {
    console.error('login failed (still on /join) — check password');
    process.exit(3);
  }
  const ready = await page
    .waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    console.error('logged in but game never became ready');
    process.exit(4);
  }
  const who = await page.evaluate(() => ({
    user: game.user.name,
    isGM: game.user.isGM,
    world: game.world.id,
    scene: canvas.scene ? { id: canvas.scene.id, name: canvas.scene.name, active: canvas.scene.active } : null,
  }));
  console.log(`logged in as ${who.user} (GM=${who.isGM}) world=${who.world} scene=${who.scene?.name ?? 'none'} [${who.scene?.id ?? '-'}]`);
  if (args.printCombat) {
    // Turn order as THIS client's Foundry computes it (system _sortCombatants),
    // i.e. what the player's combat tracker shows. Hidden combatants are
    // filtered by Foundry for players.
    const combats = await page.evaluate(() =>
      game.combats.contents.map((c) => ({
        id: c.id,
        scene: c.scene?.name ?? null,
        sceneId: c.scene?.id ?? null,
        round: c.round,
        turn: c.turn,
        current: c.combatant?.name ?? null,
        turns: c.turns.map((t) => `${t.name} [${t.initiative ?? '-'}]`),
      })),
    );
    console.log(JSON.stringify(combats, null, 2));
  }
  if (args.loginOnly || args.printCombat) {
    process.exit(0);
  }

  if (args.scene) {
    const r = await page.evaluate(async (q) => {
      const s = game.scenes.get(q) ?? game.scenes.find((x) => x.name === q);
      if (!s) return 'scene not found or not visible to this user';
      await s.view();
      return null;
    }, args.scene);
    if (r) {
      console.error(r);
      process.exit(2);
    }
  }
  const canvasOk = await page
    .waitForFunction(() => canvas?.ready === true && !!canvas.scene, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!canvasOk) {
    console.error('canvas not ready (no viewed scene?)');
    process.exit(4);
  }

  if (args.token) {
    const r = await page.evaluate(
      async ({ q, scale }) => {
        const t =
          canvas.tokens.get(q) ?? canvas.tokens.placeables.find((p) => p.document.name === q);
        if (!t) return 'token not found / not visible to this user';
        await canvas.animatePan({ x: t.center.x, y: t.center.y, scale: scale ?? canvas.stage.scale.x, duration: 0 });
        return null;
      },
      { q: args.token, scale: args.scale },
    );
    if (r) {
      console.error(r);
      process.exit(2);
    }
  } else if (args.scale) {
    await page.evaluate((scale) => canvas.animatePan({ scale, duration: 0 }), args.scale);
  }
  // Close pop-ups a fresh player login opens (e.g. User Configuration when no
  // character is assigned) and clear notifications (headless has no GPU, so
  // Foundry warns about hardware acceleration).
  await page.evaluate(async () => {
    const apps = [
      ...(foundry.applications?.instances?.values?.() ?? []),
      ...Object.values(ui.windows ?? {}),
    ];
    for (const app of apps) {
      if (app?.rendered && app.options?.window?.frame !== false && app.close) {
        try {
          await app.close({ animate: false });
        } catch {}
      }
    }
    ui.notifications?.clear?.();
    for (const el of document.querySelectorAll('#notifications li')) el.remove();
  });
  if (args.hideUi) {
    await page.addStyleTag({ content: '#interface, #ui-left, #ui-right, #ui-top, #ui-bottom, #hud, #notifications { display:none !important }' });
  }
  await page.waitForTimeout(args.waitMs);
  const vis = await page.evaluate(() => ({
    tokenVision: canvas.scene.tokenVision,
    sources: canvas.effects?.visionSources?.size ?? null,
  }));
  if (vis.tokenVision && vis.sources === 0) {
    console.error(
      'note: this user has no vision source on this scene (owns/observes no token with sight), so the map renders black — that IS what this user sees. Give it Observer on the party actors to see through their eyes.',
    );
  }
  await page.screenshot({ path: args.out });
  console.log(`saved ${args.out}`);
} finally {
  await browser.close();
}
