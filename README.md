# MOTIONSALT Deriv Bot — Headless Edition

A **headless, serverless** binary-options trading bot for
[Deriv](https://www.deriv.com).

* No web dashboard, no HTML, no local server.
* Lives entirely in GitHub Actions (the cycle worker) and Cloudflare
  Workers (the Telegram webhook relay).
* Controlled 100 % from Telegram via inline buttons + slash commands.

> **First time here?** Jump straight to [`SETUP.md`](./SETUP.md) for the
> step-by-step deployment guide.

---

## Architecture

```
                ┌────────────────────────┐
                │ Telegram (your phone)  │
                └────────────┬───────────┘
                             │ webhook
                ┌────────────▼───────────┐
                │  Cloudflare Worker     │  ◄── inbound UI
                │  worker/index.js       │
                └──┬───────────────┬─────┘
                   │ workflow_dispatch │ Contents API (config.json edits)
                   │                   │
        ┌──────────▼───────────────────▼──────────┐
        │      GitHub Actions Workflow            │
        │  .github/workflows/motionsalt-cron.yml  │
        │              ↓                          │
        │           runner.js                     │
        │       ┌──────┴──────┐                   │
        │       │  Deriv WS   │ ──► OAuth + OTP   │
        │       │  Strategies │ ──► technicalindicators
        │       │  Risk mgr   │                   │
        │       └─────────────┘                   │
        └────────────┬────────────────────────────┘
                     │ commit state
                     ▼
            last-status.json (rolling logs, trade history)
```

* **`runner.js`** runs each cycle (≤ 60 s). Triggered by
  cron-job.org every 5 minutes and on-demand by the worker.
* **`worker/index.js`** is the only thing facing Telegram. It does
  whitelist checks, button routing, and forwards heavier work
  (trigger, chart) to GitHub Actions.
* **`config.json`** is the single source of truth for bot settings.
  Both the worker and the runner read/write it via GitHub's Contents
  API or local FS respectively.

---

## Project structure

```
motionsalt-headless/
├── .github/
│   └── workflows/
│       └── motionsalt-cron.yml   ← workflow (5-min cron + daily_summary)
├── js/
│   └── strategies/
│       ├── STRATEGY_SPEC.md      ← authoring contract (port of old bot)
│       ├── _template.js          ← starter template
│       ├── rsi_reversal_v1.js
│       ├── ema_momentum_v1.js
│       ├── btc_edge_v1.js
│       └── eth_edge_v1.js
├── worker/
│   └── index.js                  ← Cloudflare Worker (webhook + relay)
├── runner.js                     ← main entry point (Node 22)
├── deriv.js                      ← WebSocket + OAuth/OTP auth
├── strategy.js                   ← strategy registry + cycle engine
├── risk.js                       ← pluggable risk manager
├── telegram.js                   ← Telegram Bot API client
├── logger.js                     ← structured logger
├── config.json                   ← bot settings
├── last-status.json              ← cycle state + logs + trade history
├── package.json
├── SETUP.md                      ← deployment walkthrough
└── README.md
```

---

## What the bot does each cycle

1. Reads `config.json`. If `enabled === false` it exits cleanly.
2. Authenticates with Deriv:
   1. `GET /trading/v1/options/accounts` → list accounts.
   2. Selects `real_id` or `demo_id` based on `config.account.mode`.
   3. `POST /trading/v1/options/accounts/{id}/otp` → pre-auth WS URL.
   4. Opens the WebSocket. No `authorize` call needed.
3. Pulls `ticks_history` for every (symbol × granularity) declared by
   the enabled strategies.
4. Runs each strategy once. Honours the Strategy Spec contract:
   per-(strategy × symbol) state, warm-up barrier, indicator fallback.
5. Applies the **risk manager**:
   - Determines stake based on `risk.mode` (`fixed | fractional |
     antimartingale | martingale | confidence`).
   - Blocks trading if any global limit (daily loss %, max loss streak,
     stop loss, take profit) is breached.
6. Places up to `limits.max_trades_per_cycle` trades, polling
   `proposal_open_contract` until settled.
7. Updates `last-status.json` (logs ring-buffered at 200 entries) and
   sends a Telegram update.
8. Closes the WebSocket and exits.

Hard cycle budget: **60 s** (GitHub Actions safety).

---

## Telegram UI

All controls live in inline-button menus reachable from `/start`:

* **📊 Status** — balance, P/L, last cycle.
* **📈 Chart** — Chart.js screenshot (queued via workflow).
* **▶️ Trigger** — fire a cycle immediately.
* **⏸️ Pause / Resume** — flips `config.enabled`.
* **⚙️ Settings** — risk mode, stake, strategies, limits, account.
* **📋 Logs** — paginated logs from `last-status.json`.

Slash commands (for things easier to type):

```
/start             /status            /balance
/trigger           /pause             /resume
/logs              /chart cryBTCUSD 1m
/setstake 2.5      /setrisk fractional
/setlimit dailyloss 10
/mode demo|real
```

You can also **upload a `.js` file** to the bot to add a strategy on the fly.

---

## Adding a new strategy

1. Read `js/strategies/STRATEGY_SPEC.md` carefully (R1 – R10 are
   non-negotiable).
2. Copy `js/strategies/_template.js` to `js/strategies/<your_id>.js`.
3. Implement `onTick`. Use `Strategy.computeStake(...)` for stake and
   `Strategy.pickIndicator(ctx, 'NAME')` for indicators (fallback math
   should always be present).
4. Drop it into the repo via PR, **or** upload the `.js` file in
   Telegram — the worker validates and commits it for you.
5. Toggle it on in **⚙️ Settings → 📊 Strategies** (or edit
   `config.json` directly).

---

## Dependencies

* Node 22+
* [`technicalindicators`](https://www.npmjs.com/package/technicalindicators)
* [`ws`](https://www.npmjs.com/package/ws)
* [`node-fetch`](https://www.npmjs.com/package/node-fetch) (only used on
  Node < 18)
* [`puppeteer`](https://www.npmjs.com/package/puppeteer) (used for chart
  screenshots — optional)

No browser, no CDN, no front-end build step.

---

## Safety notes

* **Always start in DEMO mode**. Tap *Switch to REAL* only after a few
  cycles look healthy.
* `limits.daily_loss_pct`, `limits.max_loss_streak`, `limits.stop_loss`
  and `limits.take_profit` should be set conservatively.
* Binary options are extremely high-risk. This software ships **without
  warranty**; you alone are responsible for any losses.

---

## Licence

Personal use. Not for resale. No warranty.
