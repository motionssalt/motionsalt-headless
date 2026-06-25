# Motionsalt — Strategy Plugin Authoring Spec (v3)

> **Authoritative.** If anything in this spec contradicts code comments
> or older docs, this document wins. v2 and earlier are superseded.
>
> **Audience.** Anyone (human or LLM) writing a Motionsalt strategy
> plugin. The full v3 prompt for LLMs is in §12.

---

## 0. What you need to internalise before writing a single line

This bot **does not run continuously.** Every cycle is a fresh process
spun up by GitHub Actions, runs once, writes state back to a JSON file
in the repo, and exits. The container is destroyed. Nothing — *nothing*
— is retained in memory between cycles.

That is the entire reason this spec exists in a v3 form. Strategies
that rely on tick-by-tick or in-memory state break silently here. The
v3 engine fixes this by **persisting every strategy's state to disk
between cycles** and by **walking forward through every bar that closed
during the cron gap, in order**, not just comparing "the last bar" to
"the bar before it."

Three concrete consequences for you, the strategy author:

| #  | Reality                                                                                     | What it means for your code                                                                                                                          |
|----|---------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | Cycles fire at **unpredictable** real-time intervals (1m / 3m / 5m, sometimes more).        | You **cannot** compute cooldowns or "fresh enough" checks from bar epoch. Use what the engine gives you, not your own wall-clock math.              |
| 2  | Between two cycles, **multiple bars** on your primary granularity may have closed.          | You **must not** look at "the last closed bar" in isolation. The engine calls you once per new closed bar — write your logic at the bar level.       |
| 3  | All cross-cycle memory lives in `ctx.state`, which is hydrated from disk and saved to disk. | You **must** put every variable you'd otherwise hold in a module-level `let` into `ctx.state`. The engine serialises it to JSON between cycles.      |

Get those three right and the rest of this document is implementation
detail.

---

## 1. The contract at a glance

A v3 plugin is a plain object exported into the registry via
`Strategy.register(plugin)`. It must declare:

```js
{
    id:                 'snake_case_v1',
    name:               'Human Friendly Name',
    enabled:            false,
    primaryGranularity: '60',          // string, seconds (e.g. '60' for 1m)
    historyRequest:     { '60': 100 }, // {<gran>: <count>}; must include primaryGranularity
    cooldownMs:         60000,         // optional (default 60000). Wall-clock.
    maxBarsPerCycle:    50,            // optional (default 50). Safety cap.
    contractSymbols:    null,          // optional whitelist (array or predicate)

    onClosedBar(bar, ctx) { /* ... */ },  // REQUIRED (unless you use onCycle)
    onSeed(ctx)           { /* ... */ },  // OPTIONAL: one-shot, called once ever
    onMonitor(ctx)        { /* ... */ },  // OPTIONAL: monitor displayData on no-signal cycles
    onCycle(ctx)          { /* ... */ },  // ESCAPE HATCH: see §6
}
```

`Strategy.register` validates the shape at registration time. Plugins
that fail validation are loudly rejected and not invoked. The engine
never silently swallows a broken plugin.

---

## 2. The execution model (read this carefully)

For each enabled `(strategy × symbol)` pair, every cycle:

1. The engine **loads your saved state** from `last-status.json` into
   `ctx.state`. This is the same object reference your code mutated
   last cycle.
2. The engine determines the **set of bars on your `primaryGranularity`
   that have closed since the last cycle**. Concretely, that's every
   bar whose `epoch` is greater than the `lastClosedEpoch` the engine
   recorded for you last cycle.
3. **First run ever?** The engine seeds `lastClosedEpoch` to the most
   recent currently-closed bar — it does **not** replay historical
   bars that closed before the strategy was enabled. That would emit
   trades on stale data. If you defined an `onSeed(ctx)` hook, it's
   called once now so you can prime any history-derived state.
4. **Normal run?** The engine calls `onClosedBar(bar, ctx)` once per
   new closed bar, **oldest first**, in chronological order. The
   passed `ctx.history[gran]` is **sliced as-of that bar's close** —
   the most recent entry in `ctx.history[primaryGranularity]` is the
   bar you're currently processing. There is no future-leak.
5. The engine collects every decision you returned. If multiple bars
   produced `'signal'`, the engine keeps **only the most recent one**
   — older signals are stale by the time we'd place a trade. If none
   produced a signal but some produced `'hold'`, it keeps the most
   recent `'hold'`.
6. **Engine-level gates** apply ONLY to signals:
   - If a trade is already open for `(this strategy, this symbol)`
     in `state.pending_contracts`, the signal is suppressed.
   - If `Date.now() < state.__engine.lastSignalAt + cooldownMs`, the
     signal is suppressed.
   - If the signal's shape is invalid (`stake`, `duration`, etc.),
     it's rejected with a warning.
7. The engine **serialises your `ctx.state` back to disk** as part of
   the cycle's output. GitHub Actions commits `last-status.json` and
   the next cycle starts from there.

> **The one rule that subsumes all the others.** Write `onClosedBar`
> as if it were running once, the moment that bar closed. Use only
> the history available "as of that bar." Use `ctx.state` for memory.
> The engine takes care of replaying it for the bars you missed.

---

## 3. The `ctx` Object

```ts
type Candle = { epoch: number, open: number, high: number, low: number, close: number };

type Ctx = {
    symbol:             string;                   // e.g. 'R_100', 'frxEURUSD'
    symbolName:         string;
    tick:               { epoch: number, quote: number };  // last-fetched tick proxy
    history:            { [granSec: string]: Candle[] };
    indicators:         Record<string, { calculate: (opts: any) => any[] }>;
    settings:           { baseStake, martingaleSteps, martingaleMultiplier };
    state:              Record<string, any>;      // YOUR PERSISTENT MEMORY
    hasOpenTrade:       boolean;                  // open trade on (this strategy, this symbol)?
    consecutiveLosses:  number;                   // per-(strategy, symbol) loss streak
    log:                (level, msg, meta?) => void;

    // Only on onClosedBar(bar, ctx):
    barIndex:           number;                   // index into history[primaryGranularity]
    barEpoch:           number;                   // === bar.epoch
};
```

### 3.1 `ctx.history`

* `ctx.history[primaryGranularity]` is an array of candles ending with
  the bar you're currently processing. **There is no "forming bar"
  in this view.** The last entry IS the bar that just closed.
* For other granularities you declared in `historyRequest`, the array
  is trimmed to bars whose close time was ≤ this primary bar's close.
  No future-leak.
* Oldest first. `arr[0]` is the oldest available, `arr.at(-1)` is the
  bar currently being processed.

### 3.2 `ctx.state` — what you can and cannot put in it

`ctx.state` round-trips through `JSON.stringify`. That means:

| OK                                                  | NOT OK                                |
|-----------------------------------------------------|---------------------------------------|
| numbers, strings, booleans, null                    | `undefined` (gets dropped)            |
| arrays, plain objects                               | `Map`, `Set`, `Date`, class instances |
| nested arrays/objects of the above                  | functions, symbols, `BigInt`          |

Soft size limit: **4 KB per (strategy × symbol)**. The engine warns
above that. Hard limit (refuses to persist): there isn't one, but
`last-status.json` is committed to git every cycle, so keep it lean.

The engine reserves `state.__engine` for its own bookkeeping
(`lastClosedEpoch`, `lastSignalAt`, …). **Don't write to anything
under `__engine`.** Read it if you want — fields are documented in
`strategy.js`.

### 3.3 `ctx.consecutiveLosses`

A correctly-computed count of consecutive losses for `(this strategy,
this symbol)`, walking `state.trade_history` newest-first and stopping
at the first non-loss. Trades with `result === 'unknown'` (e.g. a
contract that fell off Deriv's radar) **break** the streak — we don't
martingale on top of an unknown outcome.

### 3.4 `ctx.hasOpenTrade`

`true` iff there's a contract in `state.pending_contracts` whose
`(strategyId, symbol)` matches. Other strategies' open trades are
invisible to you — the bot can hold multiple concurrent positions
across (strategy, symbol) pairs as long as `max_trades_per_cycle`
permits.

---

## 4. Return shape

`onClosedBar` (and `onCycle`) returns one of:

```ts
type Decision =
    | null                                          // no opinion this bar
    | { type: null;    displayData?: object }       // pure monitor update
    | { type: 'warmup'; reason: string;
                       displayData?: object }       // not enough data yet
    | { type: 'hold';  reason: string;
                       displayData?: object }       // pre-signal indication
    | { type: 'signal';
        contractType:  'CALL' | 'PUT';
        stake:         number;        // computed via Strategy.computeStake(...)
        duration:      number;        // positive integer
        durationUnit:  's' | 'm';
        displayData?:  object;
      };
```

You may return `null` to mean "no opinion and don't update the
monitor." Most strategies should return `{ type: null, displayData }`
instead, to keep their Live Monitor card alive.

If you return `'warmup'`, the engine treats it as "this bar wasn't
fully evaluable yet"; the monitor will show your `reason` and no
`lastClosedEpoch` regression happens. (Internally the engine always
advances `lastClosedEpoch` after each bar — it doesn't revisit a bar.
Warmup just means "I didn't have enough indicator history to act on
this one." That's fine; the next bar will probably be evaluable.)

---

## 5. Hard rules (R1 – R10)

These are non-negotiable. The engine enforces some, but not all.

| #   | Rule                                                                                                                                                                            |
|-----|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R1  | **`onClosedBar` is pure.** No DOM, no `fetch`, no `setTimeout/setInterval`, no `Math.random` for control flow, no I/O. The engine isolates plugins; you must not break that out. |
| R2  | **All cross-tick memory lives on `ctx.state`.** Module-level `let`/`var` leak across symbols (every symbol calls the same plugin function) AND vanish between cycles. Don't.    |
| R3  | **Stake MUST be computed via `Strategy.computeStake(ctx.settings.baseStake, ctx.consecutiveLosses, ctx.settings.martingaleMultiplier)`.** Manual stakes defeat the risk layer.  |
| R4  | **Guard `ctx.indicators` lookups via `Strategy.pickIndicator(ctx, 'NAME')`** and provide a custom-math fallback. Don't crash if `technicalindicators` ships a different export.  |
| R5  | **Check `ctx.history[gran].length` before indexing.** Return `{ type: 'warmup' }` if you don't have enough bars. The engine guarantees you AT LEAST 1 closed bar, no more.      |
| R6  | **Cooldowns are the engine's job.** Declare `cooldownMs: N` on the plugin object. Do NOT roll your own cooldown using `Date.now()` or bar epochs.                                |
| R7  | **No bar-count-based timeouts for arming state.** Use bar `epoch` deltas (real seconds) — `barEpoch - state.armedAtEpoch >= 180` not `state.barsSinceArmed >= 3`. Cron gaps eat bar counts. |
| R8  | **Don't read `ctx.history` past the current bar.** Treat `ctx.history[primaryGranularity].at(-1)` as the bar you're processing; everything before it is allowed; everything after it isn't there. (The engine slices it out.)                                                          |
| R9  | **Use `ctx.log(level, msg, meta?)` for everything.** Levels: `info`, `signal`, `trade`, `warn`, `error`, `debug`, `network`. No `console.*`.                                     |
| R10 | **Never throw.** Return `{ type: null, displayData: { Status: '<reason>' } }` on any unexpected condition. The engine has a try/catch but a clean bail keeps the monitor sane. |

---

## 6. The `onCycle` escape hatch

If your trading idea genuinely doesn't fit the "evaluate each closed
bar in turn" model — e.g. it scans 5 most recent bars together for a
pattern, or coordinates cross-symbol — you can declare `onCycle(ctx)`
instead of `onClosedBar`. The engine then calls it **once per cycle**
with the full untrimmed `ctx.history` and an additional `ctx.engine`
field describing which bars are "new":

```ts
ctx.engine = {
    lastClosedEpoch:  { '60': 1729382400, ... }, // last bar epoch you saw, per gran
    lastSignalAt:     1729384100123,             // ms since epoch; 0 if never fired
    cooldownLeftMs:   0,                         // engine-enforced cooldown remaining
    newClosedRange:   { startIdx, endIdx,        // null if no new bars
                        startEpoch, endEpoch },
    primaryGran:      '60',
};
```

You're expected to:
* respect `ctx.engine.cooldownLeftMs` (if you fire a signal while > 0
  the engine will still suppress it, but informational logs are nicer);
* avoid acting on already-seen bars yourself (the engine still bumps
  `lastClosedEpoch` to the latest closable bar after your call, but
  YOU decide which bars to act on).

**Default to `onClosedBar`.** Use `onCycle` only when you really need
the holistic view.

---

## 7. Indicators

Same as v2 — `ctx.indicators` is a namespaced map of
`technicalindicators@3.x` classes. Always guard:

```js
const RSI = Strategy.pickIndicator(ctx, 'RSI');
const rsiSeries = RSI
    ? RSI.calculate({ values: closes, period: 14 })
    : this._customRSI(closes, 14);
```

For values aligned to the "as of this bar" view, just slice `ctx.history`
in the usual way; the engine already trimmed it.

---

## 8. Canonical structure for `onClosedBar`

```js
onClosedBar(bar, ctx) {
    const c = ctx.history[ '60' ];        // already sliced to end at `bar`
    if (c.length < 30) {
        return { type: 'warmup', reason: 'need 30+ bars' };
    }
    const closes = c.map(x => x.close);

    // Indicator with fallback (R4)
    const RSI = Strategy.pickIndicator(ctx, 'RSI');
    const rsi = (RSI ? RSI.calculate({ values: closes, period: 14 })
                     : this._customRSI(closes, 14)).at(-1);

    // Lazy-init persistent state (R2)
    const s = ctx.state;
    if (s.armed == null)         s.armed = false;
    if (s.armedAtEpoch == null)  s.armedAtEpoch = 0;

    // Build the live-monitor readout (kept fresh every bar)
    const displayData = {
        Price:     bar.close.toFixed(5),
        'RSI(14)': rsi.toFixed(2),
        Armed:     s.armed ? 'YES' : 'no',
        Losses:    String(ctx.consecutiveLosses || 0),
    };

    // Arming logic (the kind of multi-bar state v3 makes safe)
    if (!s.armed && rsi < 28) {
        s.armed = true;
        s.armedAtEpoch = bar.epoch;
        return {
            type: 'hold',
            reason: `RSI(${rsi.toFixed(1)}) — armed CALL`,
            displayData: { ...displayData, Status: 'armed CALL' },
        };
    }

    // Arm timeout — measure in REAL seconds via bar.epoch, not bar count (R7)
    if (s.armed && (bar.epoch - s.armedAtEpoch) > 180) {
        s.armed = false;
        ctx.log('info', 'arm expired (>180s)');
    }

    // Confirmation -> signal
    if (s.armed && rsi > 30) {
        s.armed = false;
        ctx.log('trade', `FIRE CALL (RSI ${rsi.toFixed(1)})`);
        return {
            type: 'signal',
            contractType: 'CALL',
            stake: Strategy.computeStake(
                ctx.settings.baseStake,
                ctx.consecutiveLosses,
                ctx.settings.martingaleMultiplier),
            duration: 1,
            durationUnit: 'm',
            displayData: { ...displayData, Status: 'FIRING CALL' },
        };
    }

    return { type: null, displayData };
}
```

Compare this to the v2 template: gone is the manual `seededFromHistory`
warm-up barrier, gone is the manual `lastClosedEpoch === bar.epoch`
dedup gate, gone is the `now - lastSignalEpoch < 45` cooldown. The
engine owns all of that.

---

## 9. Stake sizing

Same v2 rule, same helper:

```js
const stake = Strategy.computeStake(
    ctx.settings.baseStake,
    ctx.consecutiveLosses,
    ctx.settings.martingaleMultiplier
);
```

`ctx.consecutiveLosses` is correctly reconstructed from
`state.trade_history` by the engine (the old runner had a bug here
that silently capped it at 0 or 1).

---

## 10. Logging

```js
ctx.log('info',    'seeded from history', { rsi: 32.1 });
ctx.log('signal',  'HOLD arm CALL (RSI 28.4)');
ctx.log('trade',   'FIRE CALL');
ctx.log('warn',    'macd histogram missing');
ctx.log('error',   'unexpected gap');
```

Tags `[strategyId/symbol]` are prepended automatically. Entries get
mirrored to stdout (visible in GitHub Actions logs) and ring-buffered
into `last-status.json.logs`.

---

## 11. Common pitfalls (read at least once)

| Pitfall                                                                                                | Why it bites                                                                                                          |
|--------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| "I'll keep a counter at module scope, just one per strategy."                                          | Every symbol shares the module; counters cross-pollute. Worse, the module is reloaded fresh each cycle — counters reset. |
| Computing cooldown from `ctx.tick.epoch` or `bar.epoch`.                                               | Those advance only when bars close. Use the engine's cooldown via `cooldownMs`. Do not roll your own.                  |
| "Armed for 3 bars" / "expire after 3 bars."                                                            | A 5-minute cron gap might skip 5 bars at once. Use **seconds** via `bar.epoch - armedAtEpoch`.                          |
| Writing a `Date` or `Map` into `ctx.state`.                                                            | They don't round-trip JSON. Use numbers (epochs) and plain objects.                                                    |
| Returning a signal from a bar in the middle of a multi-bar walk.                                        | That's fine — the engine keeps only the most recent signal in the walk. But don't ALSO update `ctx.state` past it as if the trade already settled. |
| Relying on `ctx.hasOpenTrade` being authoritative for OTHER strategies.                                 | It's only `true` for `(this strategy, this symbol)`. The bot is multi-position by design.                              |

---

## 12. The LLM prompt (paste verbatim)

````
You are a senior quant engineer authoring a Motionsalt v3 strategy
plugin for a cron-driven (not perpetual) Deriv trading bot. Read the
spec below and emit a SINGLE JavaScript file that I can save as
`js/strategies/<your_id>.js` and run unmodified. Output ONLY the file
contents — no markdown, no prose.

Mandatory shape:

1. Wrap the entire file in a single IIFE: `(function () { ... })();`
2. Define one plugin object with these fields:
     id (snake_case_v{n}, unique), name, enabled (boolean),
     primaryGranularity (string of seconds, e.g. '60'),
     historyRequest ({ '<gran>': <count>, ... } — must include primaryGranularity),
     cooldownMs (number, ms; default 60000),
     maxBarsPerCycle (positive integer; default 50),
     contractSymbols (array or null),
     onClosedBar(bar, ctx) → Decision.
3. The last statement inside the IIFE must be: Strategy.register(plugin);
4. onClosedBar must be PURE: no DOM, no fetch, no timers, no random for
   control flow, no module-level let. All cross-bar memory lives on
   ctx.state (JSON-serialisable only — no Map/Set/Date/functions).
5. The engine slices ctx.history so that ctx.history[primaryGranularity].at(-1)
   IS the bar you're processing. There is no future-leak. There is no
   forming-bar entry in this view.
6. The engine owns cooldowns (via cooldownMs) and dedup. Do NOT roll
   your own. Engine owns `hasOpenTrade` gating too.
7. Time-based logic must use bar.epoch (real seconds), not bar counts.
   E.g. arm timeout: `bar.epoch - state.armedAtEpoch > 180`. NEVER
   "expire after N bars".
8. Stake MUST be Strategy.computeStake(ctx.settings.baseStake,
   ctx.consecutiveLosses, ctx.settings.martingaleMultiplier).
9. Always guard ctx.indicators with Strategy.pickIndicator(ctx, '<Name>'),
   and provide a custom-math fallback when reasonable.
10. Always populate displayData with short formatted strings: Price,
    indicator readouts, Status. The monitor truncates long values.
11. Never throw — on unexpected conditions, return
    `{ type: null, displayData: { Status: '<reason>' } }`.

The strategy I want is:
  <DESCRIBE THE STRATEGY: what it watches, when it fires CALL, when it
   fires PUT, what HOLD conditions arm it, what timeframe(s), any
   exit/cooldown rules>

Use `id: '<snake_case>_v1'`, `name: '<Human Name>'`, default
`enabled: false`. Pick a sensible historyRequest. Output the full file.
````

---

## 13. Minimal starter (copy/paste)

See `js/strategies/_template.js` for a working stub. The example
strategy in `js/strategies/breakout_pullback_v1.js` is a richer
proof-of-correctness — it deliberately exercises every piece of v3
the in-memory engine got wrong (multi-bar memory, armed/waiting state
across cycles, cooldowns across cycles, gap-tolerant replay). Read it
once before writing your own.
