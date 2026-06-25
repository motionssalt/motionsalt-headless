# CHANGES — Telegram notification overhaul (v3.1)

## Scope
Three files changed, no engine logic touched:
- `telegram.js` — new templates + retry-once on transient send failure.
- `runner.js` — wires the new placement ping; enriches settlement
  messages with duration / balance / session info; cleans up
  the end-of-cycle summary gate.
- `deriv.js` — **one additive change only**: `placeTrade()` now accepts
  an optional `onPlaced` callback in its second arg. The return shape
  is unchanged. Nothing else in `deriv.js` was modified.

Files explicitly **not** changed:
- `strategy.js`, `js/strategies/*`, `runner.js`'s engine wiring
  (bar walking, state hydration, signal validation).
- `worker/index.js` — the Telegram UI / command set didn't need
  changes for any of the requested fixes.
- `.github/workflows/motionsalt-cron.yml`, `config.json`,
  `chart.js`, `risk.js`, `logger.js`.

Selftest after the change: **19 / 19 passing** (`node selftest.js`).

---

## What was actually wrong

### Issue 1 — "Cycles run but I'm not getting notified"

The code does send a Telegram message on every cycle, but the gate
at step 14 of `runner.js` was wrong:

```js
// OLD
if (placed === 0 && cycleResult.holds.length === 0) {
    await Telegram.send(Telegram.templates.cycleSummary(...));
}
```

That meant:

- **`placed > 0` AND settled in-cycle** → only the WIN/LOSS message
  was sent (fine).
- **`placed > 0` AND NOT settled in-cycle** → a stray inline
  `cycleSummary` was sent from inside `placeTradeNonBlocking` with
  **hardcoded `placed:1, holds:0, monitored:0`** — wrong numbers,
  no session info. The real end-of-cycle summary was suppressed.
- **`placed === 0` AND `holds.length > 0`** → only the first hold's
  `holdSignal` went out. No balance / session info ever appeared
  on hold-only cycles.
- **Idle cycles** → the proper `cycleSummary` went out (the only
  path that actually worked correctly).

I also looked at the other two things the prompt asked about:

- **Silent send failures.** `telegram.js`'s `_api` already logged
  failures via `Logger.warn`, but had no retry. A single transient
  network blip or Telegram 502/429 would drop the message and the
  user would just see "Telegram sendMessage failed" buried in the
  cycle log. Now there is one retry on transient failure (network
  error, 5xx, or 429 — honouring Telegram's `retry_after` if
  present). Permanent 4xx is logged with the description and
  error_code so the cause is visible.
- **Rate limits.** At the project's 5-minute cron, even a busy
  cycle (placement ping + settlement + summary = 3 messages) is
  far below Telegram's ~1/sec-per-chat soft limit. **No real risk
  at 5-min cadence.** If the user ever moves to a 1-minute cron,
  the placement+settlement+summary triple could approach the limit
  during a burst — flagged below under "What to watch."

### Issue 2 — No notification when a trade is actually placed

Confirmed by reading the code. Before this change, the only
notifications around a trade were:

- `Proposal accepted …` / `Trade placed: contract_id=…` — these
  were **internal logs only** (`Logger.trade`), not Telegram messages.
- The win/loss `cycleResult` Telegram message, sent only AFTER
  `Deriv.placeTrade` finished its bounded settlement wait.

For a contract that takes more than the in-cycle wait budget
(`waitBudgetMs`, capped at 15s), the user could go several minutes
between "the bot placed something" and "here is the result," with
no Telegram acknowledgement in between.

### Issue 3 — Trade duration isn't shown anywhere

Confirmed: `cycleResult` only emitted `Entry / Exit / P/L / Strategy`.
No duration label, and no way to tell from the message whether a
contract crossed cycles.

### Issue 4 — "Other necessary info"

The settlement message didn't include the post-trade balance or
the running session line. The end-of-cycle summary didn't include
session P/L either. Both were genuinely missing context for someone
monitoring on a phone.

---

## What changed, per file

### `telegram.js`

1. **`_api()` retry-once.** Transient failures (thrown fetch error,
   HTTP 5xx, HTTP 429) are retried exactly once, with a short
   back-off that honours Telegram's `retry_after` if returned.
   Permanent 4xx is **not** retried (it would just fail again) but
   is logged loudly with `description` / `error_code`. The function
   still returns the parsed JSON (or `null` on hard failure) — no
   behaviour change for callers that already check `json.ok`.

2. **New template: `tradePlaced({ symbol, mode, direction, stake,
   duration, durationUnit, strategy, contractId })`.** Fires the
   second Deriv accepts the buy. Shows direction with an arrow
   (`⬆ CALL` / `⬇ PUT`), stake in dollars, duration label
   (`1m`, `30s`, …), strategy id, and the Deriv contract id.

3. **`cycleResult` enriched.** Now also accepts `duration`,
   `durationUnit`, `cyclesToSettle`, `balance`, `currency`, and
   `session`. Shape is **additive only** — old call sites that
   don't pass these fields just skip the optional lines, so
   nothing breaks. Includes a `Duration: 1m · 3 cycles` line when
   `cyclesToSettle > 1`, and a `Session : 3W/1L · +$1.20` line
   when session counters are non-zero.

4. **`cycleSummary` enriched.** Now also accepts `session` and
   `pending`. Adds the running session line and a `Pending : N`
   line when there are open contracts being watched across cycles.

5. **`holdSignal`, `dailySummary`, `heartbeatSilent`, `errorAlert`,
   `mainMenu`, `statusScreen`** — untouched.

6. Module exports — unchanged shape, so `worker/index.js` and
   `runner.js` consumers see no surprise.

### `deriv.js` — single additive change

`placeTrade(ws, opts, settleOpts)`'s second argument now also
recognises `onPlaced: async ({ proposal, buy }) => {}`. The
callback is invoked exactly once, **after `buy` succeeds and
before** `_waitForSettlement` starts blocking. Errors thrown by
the callback are swallowed (with a `Logger.warn`) — a Telegram
hiccup must never abort a live trade.

No other code in `deriv.js` was modified. Return shape
(`{ proposal, buy, settled }`) is unchanged.

### `runner.js`

1. **`placeTradeNonBlocking` now sends a `tradePlaced` ping** the
   instant the buy is accepted, via `onPlaced` passed into
   `Deriv.placeTrade`. Failures are swallowed locally so they
   cannot interfere with the trade itself.

2. **In-cycle settlement message enriched.** When `Deriv.placeTrade`
   returns with a settled contract, the `cycleResult` Telegram now
   carries `duration`, `durationUnit`, `cyclesToSettle: 1`,
   `balance`, `currency`, and the live `session` snapshot.

3. **Misleading inline `cycleSummary` removed.** The old code path
   that fired a `cycleSummary` with hardcoded `placed:1, holds:0,
   monitored:0` from inside `placeTradeNonBlocking` (when the trade
   didn't settle in-cycle) is gone. The accurate end-of-cycle
   summary in `main()` now handles that case.

4. **`settlePendingContracts` enriched.** Each `pending_contracts`
   entry now also carries the human-friendly `duration` and
   `durationUnit` (the existing `durationSec` is preserved for
   back-compat with the watchdog logic). A new `cyclesPending`
   counter is bumped on every cycle the contract survives, and is
   used to render `Duration: 5m · 3 cycles` in the eventual
   settlement message. When a stuck contract is force-dropped
   after `PENDING_HARD_DROP_FACTOR × durationSec`, the user now
   gets an explicit `errorAlert` Telegram — silent drops were
   exactly the kind of gap the prompt was worried about.

5. **End-of-cycle summary gate fixed.** Old gate:
   `if (placed === 0 && cycleResult.holds.length === 0)` —
   suppressed the summary on hold-only and placed-but-pending
   cycles. New gate: send the summary on **every** cycle UNLESS
   a settlement message already went out this cycle (detected by
   comparing the tail `trade_history[].ts` against `cycleTs`). This
   guarantees one cycle-level message per cycle, never two.

6. **`runner.js`'s engine code (steps 4–11, `Strategy.runCycle`,
   `aggregateHistoryRequests`, `classifySettlement`,
   `applySettlementToSession`) was NOT touched.**

### `worker/index.js`

Not changed. None of the fixes required a new toggle or command —
the existing menu / commands still work, and the new Telegram
messages all come from the runner side. (Filename remains
`worker/index.js`, plain JavaScript.)

---

## Message shapes after the change

**Placement ping (new, fires the second a buy is accepted):**

```
🎯 TRADE PLACED — R_100 🟡 DEMO
Direction: ⬆ CALL
Stake    : $0.50
Duration : 1m
Strategy : breakout_pullback_v1
Contract : 271234567
```

**Settlement, same cycle:**

```
✅ WIN — R_100 🟡 DEMO
Entry   : 1234.5
Exit    : 1235.0
Duration: 1m
P/L     : +$0.45
Balance : $1023.55
Session : 3W/1L · +$1.20
Strategy: breakout_pullback_v1
```

**Settlement, cross-cycle (the `pending_contracts` case):**

```
❌ LOSS — cryBTCUSD 🔴 REAL
Entry   : 67000
Exit    : 66950
Duration: 5m · 3 cycles
P/L     : -$0.50
Balance : $998.00
Session : 1W/2L · -$0.60
Strategy: breakout_pullback_v1
```

**End-of-cycle summary (every cycle that didn't already settle
something):**

```
🟢 Cycle 🟡 DEMO
Balance : $1023.10
Placed  : 0    Holds: 1    Live: 0
Pending : 1
Session : 2W/1L · +$0.75
```

---

## Per-cycle message budget

At the project's 5-minute cron and `max_trades_per_cycle: 1`,
the worst-case cycle sends:

- 1× pending-settlement `cycleResult` (only if a pending finally
  resolved this cycle)
- 1× `tradePlaced` (only if a new trade fired)
- 1× in-cycle `cycleResult` (only if that new trade settled in 15s)
- 1× `holdSignal` (only if any plugin emitted a hold)
- 1× end-of-cycle `cycleSummary` (only if no settlement message
  went out this cycle)

In practice that bounds us to ~2–4 messages per cycle, well below
Telegram's ~1 msg/sec per chat soft limit. **Recommendation: keep
the cron at ≥ 5 minutes.** If you ever lower it to 1 minute,
consider a "digest" toggle (suppress `tradePlaced` + the end-of-
cycle summary on cycles where nothing happened, send a single
hourly summary instead) — happy to wire that into
`worker/index.js`'s settings menu as a follow-up if you want it.

---

## Verification

```
$ node selftest.js
… 19 passed / 0 failed
```

All template renders smoke-tested locally (the new fields render
correctly when present and are omitted cleanly when absent, so
nothing breaks for legacy call sites).
