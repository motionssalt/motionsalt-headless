/* =====================================================================
   MOTIONSALT — strategy.js  (v3 engine, cron-cycle aware)
   ─────────────────────────────────────────────────────────────────────
   This engine is purpose-built for a bot that runs ONCE per invocation
   in a fresh process with no shared memory between cycles. Cron may
   fire at 1m / 3m / 5m intervals (and may skip beats), so between two
   invocations 1..N bars may have closed on any given granularity.

   Three properties the engine guarantees, that the old in-memory
   engine could not:

     (1) STATE PERSISTENCE.  Per-(strategy × symbol) state is loaded
         from `last-status.json` at the start of every cycle, handed
         to the strategy as a mutable `ctx.state`, and serialised back
         after the cycle. The runner writes the file and CI commits it.
         Strategies write to `ctx.state` as if memory were perpetual.

     (2) GAP-TOLERANT BAR WALKING.  Strategies do NOT see "the most
         recent bar" any more. They see EVERY closed bar that is new
         since the last cycle (per granularity), in chronological order.
         If a 5-minute cron gap closed five 1-minute bars, the strategy
         is invoked five times with each bar in turn. This is what the
         old contract ("compare last two candles") silently corrupted
         under unpredictable scheduling.

     (3) WALL-CLOCK COOLDOWNS.  Cooldowns are enforced by the engine
         against real wall-clock (`Date.now()`), not bar epoch. Bar
         epoch drifts: it only advances when a new bar closes, so a
         cooldown of "45 seconds since last signal" measured in bar
         epoch can mean "45 seconds of TRADING TIME" not "45 seconds
         of real time."

   See `js/strategies/STRATEGY_SPEC.md` for the authoring contract.
   ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');
const ti   = require('technicalindicators');
const Logger = require('./logger');

/* =====================================================================
   1. Indicator catalogue (handed to strategies via ctx.indicators)
   ===================================================================== */
const INDICATORS = {
    RSI: ti.RSI, EMA: ti.EMA, SMA: ti.SMA, WMA: ti.WMA, WEMA: ti.WEMA,
    MACD: ti.MACD, BollingerBands: ti.BollingerBands, ATR: ti.ATR,
    TrueRange: ti.TrueRange, Stochastic: ti.Stochastic,
    StochasticRSI: ti.StochasticRSI, ADX: ti.ADX, PSAR: ti.PSAR,
    CCI: ti.CCI, WilliamsR: ti.WilliamsR, MFI: ti.MFI, ROC: ti.ROC,
    IchimokuCloud: ti.IchimokuCloud, KeltnerChannels: ti.KeltnerChannels,
    DonchianChannels: ti.DonchianChannels, OBV: ti.OBV,
    ChaikinMoneyFlow: ti.ChaikinMoneyFlow, VWAP: ti.VWAP,
    HeikinAshi: ti.HeikinAshi,
};

function pickIndicator(ctx, name) {
    const ind = ctx && ctx.indicators;
    if (!ind) return null;
    const cls = ind[name];
    return (cls && typeof cls.calculate === 'function') ? cls : null;
}

/* =====================================================================
   2. Plugin registry
   ===================================================================== */
const _plugins = [];
const _idIndex = new Map();

function _isStringedPositiveInt(s) { return /^\d+$/.test(s) && Number(s) > 0; }

function _validate(p) {
    if (!p || typeof p !== 'object')                   return 'plugin is not an object';
    if (typeof p.id !== 'string' || !p.id.trim())      return 'plugin.id missing';
    if (!/^[a-z0-9_]+$/i.test(p.id))                   return `plugin.id "${p.id}" must be snake_case`;
    if (typeof p.name !== 'string' || !p.name.trim())  return 'plugin.name missing';

    const hasOnClosedBar = typeof p.onClosedBar === 'function';
    const hasOnCycle     = typeof p.onCycle     === 'function';
    if (!hasOnClosedBar && !hasOnCycle) {
        return 'plugin must define onClosedBar(bar, ctx) and/or onCycle(ctx)';
    }
    if (typeof p.primaryGranularity !== 'string' || !_isStringedPositiveInt(p.primaryGranularity)) {
        return 'plugin.primaryGranularity must be a stringified positive integer (seconds, e.g. "60")';
    }
    if (!p.historyRequest || typeof p.historyRequest !== 'object') {
        return 'plugin.historyRequest must be an object { "<seconds>": <count> }';
    }
    for (const [k, v] of Object.entries(p.historyRequest)) {
        if (!_isStringedPositiveInt(k))        return `historyRequest key "${k}" must be stringified positive integer (seconds)`;
        if (!Number.isFinite(v) || v <= 0)     return `historyRequest["${k}"] must be a positive number`;
    }
    if (!p.historyRequest[p.primaryGranularity]) {
        return `historyRequest must include the primaryGranularity "${p.primaryGranularity}"`;
    }
    if (p.cooldownMs != null && (!Number.isFinite(p.cooldownMs) || p.cooldownMs < 0)) {
        return 'plugin.cooldownMs must be a non-negative number (milliseconds)';
    }
    if (p.maxBarsPerCycle != null && (!Number.isInteger(p.maxBarsPerCycle) || p.maxBarsPerCycle < 1)) {
        return 'plugin.maxBarsPerCycle must be a positive integer';
    }
    return null;
}

function register(plugin) {
    const err = _validate(plugin);
    if (err) {
        Logger.error('Strategy registration rejected', { reason: err, id: plugin && plugin.id });
        return false;
    }
    if (_idIndex.has(plugin.id)) {
        Logger.warn(`Duplicate strategy id "${plugin.id}" — keeping first`);
        return false;
    }
    if (typeof plugin.enabled !== 'boolean') plugin.enabled = false;
    if (plugin.cooldownMs == null)           plugin.cooldownMs = 60000;
    if (plugin.maxBarsPerCycle == null)      plugin.maxBarsPerCycle = 50;
    if (typeof plugin.contractSymbols !== 'function' && !Array.isArray(plugin.contractSymbols)) {
        plugin.contractSymbols = null;  // null = all symbols accepted
    }
    _plugins.push(plugin);
    _idIndex.set(plugin.id, plugin);
    Logger.info(`Strategy registered: ${plugin.name}`, { id: plugin.id });
    return true;
}

function unregister(id) {
    const p = _idIndex.get(id);
    if (!p) return false;
    _idIndex.delete(id);
    const i = _plugins.indexOf(p);
    if (i >= 0) _plugins.splice(i, 1);
    return true;
}

function list()   { return _plugins.slice(); }
function byId(id) { return _idIndex.get(id) || null; }
function count()  { return _plugins.length; }

/* =====================================================================
   3. Stake helper (martingale ladder)
   ===================================================================== */
function computeStake(baseStake, consecutiveLosses, multiplier = 2) {
    const m  = (Number.isFinite(multiplier) && multiplier >= 1) ? multiplier : 2;
    const cl = Math.max(0, Math.floor(Number(consecutiveLosses) || 0));
    const stake = baseStake * Math.pow(m, cl);
    return Math.max(0.35, Math.round(stake * 100) / 100);
}

/* =====================================================================
   4. consecutiveLosses reconstruction (per-(strategy × symbol))
   ─────────────────────────────────────────────────────────────────────
   Walk the trade_history newest-first per key; count the tail run of
   `result === 'loss'`; stop at first non-loss. Trades with result
   'unknown' break the streak (we can't know if the trade actually
   won, so we don't martingale on top of it).
   ===================================================================== */
function reconstructConsecutiveLosses(tradeHistory) {
    const out = {};
    const seenKey = new Set();
    const hist = Array.isArray(tradeHistory) ? tradeHistory : [];
    // Walk newest-first
    for (let i = hist.length - 1; i >= 0; i--) {
        const t = hist[i];
        if (!t || !t.strategy || !t.symbol) continue;
        const key = `${t.strategy}::${t.symbol}`;
        if (seenKey.has(key)) continue;
        // We treat this key as "currently being counted." Walk further
        // back collecting consecutive losses until we hit a non-loss.
        let streak = 0;
        let saw = false;
        for (let j = hist.length - 1; j >= 0; j--) {
            const u = hist[j];
            if (!u || u.strategy !== t.strategy || u.symbol !== t.symbol) continue;
            saw = true;
            if (u.result === 'loss') {
                streak++;
            } else {
                break;  // first non-loss breaks the tail run
            }
        }
        if (saw) out[key] = streak;
        seenKey.add(key);
    }
    return out;
}

/* =====================================================================
   5. State serialisation guards
   ─────────────────────────────────────────────────────────────────────
   `ctx.state` must round-trip cleanly through JSON.  We disallow
   functions, Maps, Sets, undefined values, and reject anything > 4 KB
   per (strategy × symbol) slot with a warning.
   ===================================================================== */
const STATE_SLOT_SOFT_LIMIT_BYTES = 4096;

function _safeStateSnapshot(stateObj, tag) {
    if (stateObj == null) return {};
    let json;
    try {
        json = JSON.stringify(stateObj, (k, v) => {
            if (typeof v === 'function') return undefined;
            if (v instanceof Map || v instanceof Set) return undefined;
            return v;
        });
    } catch (e) {
        Logger.warn(`State for ${tag} not JSON-serialisable — dropping`, { error: e.message });
        return {};
    }
    if (json == null) return {};
    if (json.length > STATE_SLOT_SOFT_LIMIT_BYTES) {
        Logger.warn(`State for ${tag} exceeds soft limit`, {
            bytes: json.length, limit: STATE_SLOT_SOFT_LIMIT_BYTES
        });
    }
    let out;
    try { out = JSON.parse(json); }
    catch (e) {
        Logger.warn(`State for ${tag} failed re-parse — dropping`, { error: e.message });
        return {};
    }
    return (out && typeof out === 'object') ? out : {};
}

/* =====================================================================
   6. Bar walker — the core of the new engine
   ─────────────────────────────────────────────────────────────────────
   For a given (strategy × symbol):
     • Read engine bookkeeping from state.__engine.
     • Determine which closed bars are new on the PRIMARY granularity
       since the last cycle. (Other granularities are passed whole as
       historical context; only the primary triggers `onClosedBar`.)
     • If the strategy declares `onClosedBar`, call it once per new
       closed bar, OLDEST FIRST, with a "view as of that bar closing"
       in `ctxForBar`. Collect decisions.
     • Final decision policy: if multiple bars produced 'signal',
       keep the MOST RECENT only (older signals are stale by now).
       If any produced 'hold' but no 'signal', keep the most recent
       'hold'. Otherwise no decision.
     • Update state.__engine.lastClosedEpoch[gran] to the epoch of the
       last bar processed (or, if no bars to process, leave untouched).
     • The engine enforces cooldownMs via state.__engine.lastSignalAt
       against Date.now(), so authors don't have to track this.

   Strategies that declare `onCycle` (escape hatch) get a single call
   per cycle with the full multi-timeframe history; the engine does
   not walk bars for them. They get the same engine bookkeeping in
   ctx.engine so they can opt in to gap-tolerant logic themselves.
   ===================================================================== */

function _viewAsOfBar(history, primaryGran, closedIdx) {
    // Return a shallow copy of `history` where the PRIMARY granularity
    // is sliced up to and including `closedIdx` (inclusive). For other
    // granularities we keep the full available history — at higher
    // timeframes the "as of" is approximated as "the most recent
    // higher-TF bar whose close <= this primary bar's close." We
    // implement that by trimming each non-primary array to entries
    // whose epoch <= primary[closedIdx].epoch.
    const view = {};
    const primary = history[primaryGran] || [];
    const cutoffEpoch = primary[closedIdx] ? primary[closedIdx].epoch : Number.POSITIVE_INFINITY;
    for (const [g, arr] of Object.entries(history)) {
        if (g === primaryGran) {
            view[g] = primary.slice(0, closedIdx + 1);
        } else {
            // Higher-TF: only include bars that had closed by cutoffEpoch.
            // (Bar `b` is considered closed at b.epoch + granularitySeconds.)
            const gSec = Number(g);
            let end = arr.length;
            for (let i = arr.length - 1; i >= 0; i--) {
                if ((arr[i].epoch + gSec) <= cutoffEpoch) { end = i + 1; break; }
                end = i;
            }
            view[g] = arr.slice(0, end);
        }
    }
    return view;
}

function _runStrategyForSymbol(plugin, symbol, history, sharedCtxFields, perKeyCtxFields, log, nowMs) {
    const stateKey = `${plugin.id}::${symbol}`;
    const state = perKeyCtxFields.state;            // mutable; we serialise it after
    state.__engine = state.__engine || {};
    state.__engine.lastClosedEpoch = state.__engine.lastClosedEpoch || {};

    const primaryGran = plugin.primaryGranularity;
    const primary     = (history && history[primaryGran]) || [];

    // ── Cooldown gate (wall-clock) ─────────────────────────────────
    const lastSignalAt = Number(state.__engine.lastSignalAt) || 0;
    const cooldownLeft = Math.max(0, (lastSignalAt + plugin.cooldownMs) - nowMs);

    // ── Open-trade gate ────────────────────────────────────────────
    const hasOpenTrade = !!perKeyCtxFields.hasOpenTrade;

    // ── Determine the closed-bar window for this cycle ─────────────
    // The "live forming bar" is the last entry. A bar is fully closed
    // once a NEWER bar exists, i.e. all but the last entry. So our
    // closable index range is [0 .. primary.length - 2].
    if (primary.length < 2) {
        return _emitMonitor(plugin, symbol, log, {
            ...perKeyCtxFields, ...sharedCtxFields,
            history, displayDataExtra: { Status: 'no closed bar yet' }
        });
    }
    const lastClosableIdx = primary.length - 2;
    const lastSeenEpoch   = Number(state.__engine.lastClosedEpoch[primaryGran]) || 0;

    // Find startIdx: first index whose epoch > lastSeenEpoch.
    let startIdx = -1;
    for (let i = 0; i <= lastClosableIdx; i++) {
        if (primary[i].epoch > lastSeenEpoch) { startIdx = i; break; }
    }

    // ── Branch: onCycle escape-hatch strategies ────────────────────
    if (typeof plugin.onCycle === 'function') {
        const engineCtx = {
            lastClosedEpoch: { ...state.__engine.lastClosedEpoch },
            lastSignalAt,
            cooldownLeftMs: cooldownLeft,
            newClosedRange: (startIdx === -1)
                ? null
                : { startIdx, endIdx: lastClosableIdx,
                    startEpoch: primary[startIdx].epoch,
                    endEpoch:   primary[lastClosableIdx].epoch },
            primaryGran,
        };
        let dec = null;
        try {
            dec = plugin.onCycle({
                ...sharedCtxFields,
                ...perKeyCtxFields,
                history,
                engine: engineCtx,
            });
        } catch (e) {
            Logger.error(`Strategy ${plugin.id} onCycle threw`, {
                symbol, error: e.message, stack: e.stack
            });
            return { decision: null };
        }
        // Engine still owns: bumping lastClosedEpoch (if author didn't),
        // gating cooldown, and gating hasOpenTrade.
        if (lastClosableIdx >= 0) {
            state.__engine.lastClosedEpoch[primaryGran] = Math.max(
                lastSeenEpoch,
                primary[lastClosableIdx].epoch
            );
        }
        return _finaliseDecision(plugin, symbol, state, dec, hasOpenTrade, cooldownLeft, log, nowMs);
    }

    // ── Branch: onClosedBar (the recommended path) ─────────────────
    // The very first time we ever see this (strategy × symbol), we
    // CANNOT replay history blindly — that would fire on bars that
    // happened before the strategy was enabled. Instead we seed
    // lastClosedEpoch to the most recent closable bar, so future
    // cycles only see bars that actually closed AFTER we started.
    if (lastSeenEpoch === 0) {
        state.__engine.lastClosedEpoch[primaryGran] = primary[lastClosableIdx].epoch;
        // Give the strategy ONE warm-up call so it can seed its own
        // history-derived state from the available bars without
        // emitting a decision based on a bar it never "saw close".
        if (typeof plugin.onSeed === 'function') {
            try {
                plugin.onSeed({
                    ...sharedCtxFields,
                    ...perKeyCtxFields,
                    history,
                });
            } catch (e) {
                Logger.error(`Strategy ${plugin.id} onSeed threw`, {
                    symbol, error: e.message, stack: e.stack
                });
            }
        }
        log('info', `seeded — lastClosedEpoch[${primaryGran}] = ${primary[lastClosableIdx].epoch}`);
        return _emitMonitor(plugin, symbol, log, {
            ...perKeyCtxFields, ...sharedCtxFields,
            history,
            displayDataExtra: { Status: 'seeded' }
        });
    }

    // Walk new closed bars
    if (startIdx === -1) {
        // No new closed bars since last cycle.
        return _emitMonitor(plugin, symbol, log, {
            ...perKeyCtxFields, ...sharedCtxFields,
            history,
            displayDataExtra: { Status: 'no new bar' }
        });
    }

    // Cap on bars-per-cycle so a long gap doesn't blow the 55s budget.
    let walkEnd = lastClosableIdx;
    if ((walkEnd - startIdx + 1) > plugin.maxBarsPerCycle) {
        const dropped = (walkEnd - startIdx + 1) - plugin.maxBarsPerCycle;
        walkEnd = startIdx + plugin.maxBarsPerCycle - 1;
        log('warn', `bar gap exceeds maxBarsPerCycle — replaying ${plugin.maxBarsPerCycle} newest of ${dropped + plugin.maxBarsPerCycle}`);
    }

    const decisionsPerBar = [];
    let lastDisplayData = null;
    let warmupReason = null;

    for (let i = startIdx; i <= walkEnd; i++) {
        const bar = primary[i];
        const view = _viewAsOfBar(history, primaryGran, i);
        let dec = null;
        try {
            dec = plugin.onClosedBar(bar, {
                ...sharedCtxFields,
                ...perKeyCtxFields,
                history: view,
                barIndex: i,
                barEpoch: bar.epoch,
            });
        } catch (e) {
            Logger.error(`Strategy ${plugin.id} onClosedBar threw`, {
                symbol, epoch: bar.epoch, error: e.message, stack: e.stack
            });
            // We don't stop the walk — the engine refuses to let one bar
            // break the rest.
            continue;
        }
        // Track displayData even on null returns so the monitor stays alive.
        if (dec && dec.displayData) lastDisplayData = dec.displayData;
        if (dec && dec.type === 'signal') {
            decisionsPerBar.push({ kind: 'signal', dec, epoch: bar.epoch });
        } else if (dec && dec.type === 'hold') {
            decisionsPerBar.push({ kind: 'hold', dec, epoch: bar.epoch });
        } else if (dec && dec.type === 'warmup') {
            warmupReason = dec.reason || 'warmup';
        }
        // Engine bumps lastClosedEpoch AFTER each successful bar so
        // crashes mid-walk don't cause infinite replays of the same bar.
        state.__engine.lastClosedEpoch[primaryGran] = bar.epoch;
    }

    // Pick the final decision. Most-recent-wins.
    let chosen = null;
    for (let i = decisionsPerBar.length - 1; i >= 0; i--) {
        if (decisionsPerBar[i].kind === 'signal') { chosen = decisionsPerBar[i].dec; break; }
    }
    if (!chosen) {
        for (let i = decisionsPerBar.length - 1; i >= 0; i--) {
            if (decisionsPerBar[i].kind === 'hold') { chosen = decisionsPerBar[i].dec; break; }
        }
    }
    if (!chosen && warmupReason) {
        chosen = { type: null, displayData: { ...(lastDisplayData || {}), Status: warmupReason } };
    }
    if (!chosen) {
        chosen = { type: null, displayData: { ...(lastDisplayData || {}), Status: `walked ${walkEnd - startIdx + 1} bar(s), no signal` } };
    }
    return _finaliseDecision(plugin, symbol, state, chosen, hasOpenTrade, cooldownLeft, log, nowMs);
}

function _finaliseDecision(plugin, symbol, state, decision, hasOpenTrade, cooldownLeft, log, nowMs) {
    if (!decision) return { decision: null };
    // Engine-level gates apply only to 'signal' emissions.
    if (decision.type === 'signal') {
        if (hasOpenTrade) {
            log('info', 'signal suppressed — open trade on this (strategy, symbol)');
            return { decision: {
                type: null,
                displayData: { ...(decision.displayData || {}), Status: 'trade open' }
            }};
        }
        if (cooldownLeft > 0) {
            log('info', `signal suppressed — cooldown ${(cooldownLeft / 1000).toFixed(1)}s left`);
            return { decision: {
                type: null,
                displayData: { ...(decision.displayData || {}), Status: `cooldown ${(cooldownLeft / 1000).toFixed(0)}s` }
            }};
        }
        // Validate the signal shape
        const valErr = _validateSignalShape(decision);
        if (valErr) {
            Logger.warn(`Strategy ${plugin.id} produced invalid signal — dropped`, {
                symbol, reason: valErr
            });
            return { decision: {
                type: null,
                displayData: { ...(decision.displayData || {}), Status: `bad signal: ${valErr}` }
            }};
        }
        state.__engine.lastSignalAt = nowMs;
    }
    return { decision };
}

function _validateSignalShape(d) {
    if (!d || typeof d !== 'object') return 'not an object';
    if (d.type !== 'signal') return 'type != signal';
    if (d.contractType !== 'CALL' && d.contractType !== 'PUT') return 'contractType must be CALL or PUT';
    if (!Number.isFinite(d.stake) || d.stake <= 0) return 'stake invalid';
    if (!Number.isInteger(d.duration) || d.duration <= 0) return 'duration invalid';
    if (d.durationUnit !== 's' && d.durationUnit !== 'm') return 'durationUnit must be s or m';
    return null;
}

function _emitMonitor(plugin, symbol, log, ctxLike) {
    // Build a no-decision result with whatever displayData seed the
    // engine can synthesise. Strategies that want a richer "warming
    // up" monitor can implement onMonitor(ctx) but it's optional.
    let displayData = ctxLike.displayDataExtra || {};
    if (typeof plugin.onMonitor === 'function') {
        try {
            const m = plugin.onMonitor(ctxLike);
            if (m && typeof m === 'object') displayData = { ...m, ...displayData };
        } catch (e) {
            Logger.warn(`Strategy ${plugin.id} onMonitor threw`, { symbol, error: e.message });
        }
    }
    return { decision: { type: null, displayData } };
}

/* =====================================================================
   7. Public cycle entry point
   ===================================================================== */
function runCycle(opts) {
    const {
        symbols,
        histories,             // { symbol: { '<gran>': Candle[] } }
        lastTick,              // { symbol: { epoch, quote } }
        consecutiveLosses,     // { 'strategyId::symbol': number }
        openTrades,            // { 'strategyId::symbol': true }
        settings,              // { baseStake, martingaleSteps, martingaleMultiplier }
        priorStrategyState,    // { strategyId: { symbol: {...} } }  from last-status.json
        nowMs = Date.now(),
    } = opts;

    const persistedState = {};         // what we'll write back into last-status.json
    const signals  = [];
    const holds    = [];
    const monitors = [];

    for (const plugin of _plugins) {
        if (!plugin.enabled) continue;
        const strategySlot = (priorStrategyState && priorStrategyState[plugin.id]) || {};
        persistedState[plugin.id] = {};

        for (const symbol of symbols) {
            // Symbol whitelist check
            if (Array.isArray(plugin.contractSymbols)
                    && plugin.contractSymbols.length > 0
                    && !plugin.contractSymbols.includes(symbol)) {
                continue;
            }
            if (typeof plugin.contractSymbols === 'function'
                    && !plugin.contractSymbols(symbol)) {
                continue;
            }

            const hist = (histories && histories[symbol]) || {};
            const tk   = (lastTick && lastTick[symbol]) || null;
            if (!tk) continue;
            // Need the primary granularity to have at least loaded;
            // otherwise we cannot run.
            if (!Array.isArray(hist[plugin.primaryGranularity])) {
                Logger.warn(`Skipping ${plugin.id}/${symbol}: primary gran "${plugin.primaryGranularity}" not loaded`);
                continue;
            }

            // Hydrate state — DEEP CLONE so strategy mutations don't
            // accidentally cross-pollute other slots before we serialise.
            const lossKey = `${plugin.id}::${symbol}`;
            const hydrated = JSON.parse(JSON.stringify(strategySlot[symbol] || {}));

            const tag = `${plugin.id}/${symbol}`;
            const log = (level, msg, meta) =>
                (Logger[level] || Logger.info)(`[${tag}] ${msg}`, meta);

            const sharedCtxFields = {
                indicators: INDICATORS,
                settings,
                symbol,
                symbolName: symbol,
                log,
            };
            const perKeyCtxFields = {
                tick: tk,
                state: hydrated,
                hasOpenTrade: !!(openTrades && openTrades[lossKey]),
                consecutiveLosses: (consecutiveLosses && consecutiveLosses[lossKey]) || 0,
            };

            const { decision } = _runStrategyForSymbol(
                plugin, symbol, hist,
                sharedCtxFields, perKeyCtxFields,
                log, nowMs
            );

            // Serialise mutated state back. We always re-snapshot the
            // mutable `hydrated` even if no decision was made — the
            // strategy may have updated its bookkeeping.
            persistedState[plugin.id][symbol] = _safeStateSnapshot(hydrated, tag);

            if (!decision) continue;
            if (decision.type === 'signal') {
                signals.push({ plugin, symbol, decision });
            } else if (decision.type === 'hold') {
                holds.push({ plugin, symbol, decision });
            } else {
                monitors.push({ plugin, symbol, decision });
            }
        }
    }

    return { signals, holds, monitors, persistedState };
}

/* =====================================================================
   8. Discovery — load js/strategies/*.js (skipping _-prefixed files)
   ===================================================================== */
function discover(dir, enabledMap = {}) {
    const folder = dir || path.join(__dirname, 'js', 'strategies');
    if (!fs.existsSync(folder)) {
        Logger.warn(`Strategy folder not found: ${folder}`);
        return;
    }
    const files = fs.readdirSync(folder)
        .filter(f => f.endsWith('.js') && !f.startsWith('_'))
        .sort();
    for (const f of files) {
        const full = path.join(folder, f);
        try {
            delete require.cache[require.resolve(full)];
            require(full);
        } catch (e) {
            Logger.error(`Strategy load failed: ${f}`, { error: e.message, stack: e.stack });
        }
    }
    for (const p of _plugins) {
        if (Object.prototype.hasOwnProperty.call(enabledMap, p.id)) {
            p.enabled = !!enabledMap[p.id];
        }
    }
    Logger.info(`Strategy discovery complete: ${_plugins.length} loaded`,
        { enabled: _plugins.filter(p => p.enabled).map(p => p.id) });
}

/* =====================================================================
   9. Public surface
   ===================================================================== */
const Strategy = {
    // registry
    register, unregister, list, byId, count,
    // helpers exposed to plugins
    computeStake, pickIndicator,
    // runner glue
    reconstructConsecutiveLosses,
    runCycle,
    discover,
    // diagnostics
    indicators: INDICATORS,
    STATE_SLOT_SOFT_LIMIT_BYTES,
};

// Self-registering plugins still need globals.
global.Strategy = Strategy;
global.Logger   = Logger;

module.exports = Strategy;
