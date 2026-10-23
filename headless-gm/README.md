# headless-gm

Keeps a headless Chromium logged into Foundry's active world as a dedicated GM user
(default `gm-headless`) so system-side bridge code runs without a human GM browser
(e.g. covert-ops-d20's derived-data cache and damage relay for the MCP bridge).

- Env: `FOUNDRY_URL`, `GM_USER` (default `gm-headless`), `GM_PASSWORD`, `PORT` (8080).
- `/healthz` 200 only when `game.ready`, socket connected and the system's bridge flag
  is set (`flags.covert-ops-d20.bridgeClient = "headless"`); `/livez` 200 while the
  supervisor loop is ticking (use for liveness so idle states never crashloop).
- States: `ready`, `no-world` (setup screen; retry 60s), `user-not-in-world` (retry 120s),
  `no-bridge-system`, `reconnecting`, `error` (backoff 5s..120s), `not-gm`.
- Canvas is disabled (`core.noCanvas`) to keep memory/CPU low.
- GM selection: covert-ops-d20 >= 0.4.1 elects among active flagged GM clients, human
  browsers (flag `true`) before headless (flag `"headless"`), then lowest user id. A human GM
  therefore takes over automatically; the headless client serves when no human GM is on.
- The user must exist in the world; create it as a GM only in worlds that should be served.
