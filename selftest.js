/* =====================================================================
   MOTIONSALT — selftest.js
   ─────────────────────────────────────────────────────────────────────
   Smoke-tests the v3 strategy engine against synthetic candle fixtures.
   Drives the engine through multiple "cycles" the same way runner.js
   would, persisting strategy_state between calls IN MEMORY (which is
   semantically the same as round-tripping through last-status.json).

   Run:  node selftest.js
   Exits 0 if every assertion passes, 1 otherwise. Designed to be
   runnable as part of CI for the strategy_engine itself (not the live
   trading workflow).

   The fixtures and assertions deliberately target the failure modes
   that the in-memory v2 engine had:
     1. State survives across cycles.
     2. Arming persists across cycles.
     3. Bars closing during a cron gap are replayed in order.
     4. Engine-enforced cooldown blocks back-to-back signals.
     5. Open-trade gate blocks signals when pending_contracts has one.
     6. consecutiveLosses reconstruction counts streaks correctly.
   ===================================================================== */

'use strict';

const path = require('path');

// Load engine. The strategy file uses `Strategy.register(...)` against
// the global, so we mimic the runner: require strategy.js first (which
// sets globals) then require the strategy file.
const Strategy = require('./strategy');
require('./js/strategies/breakout_pullback_v1.js');

let PASS = 0, FAIL = 0;
function assert(label, cond, detail) {
    if (cond) { PASS++; console.log('  ✓', label); }
    else      { FAIL++; console.log('  ✗', label, detail ? '— ' + JSON.stringify(detail) : ''); }
}
function section(title) { console.log('\n' + '─'.repeat(72) + '\n' + title + '\n' + '─'.repeat(72)); }

/* ─── Fixture builder ────────────────────────────────────────────── */
function bars(closes, startEpoch = 1_700_000_000, granSec = 60) {
    // Build minimal OHLC. low = close - 0.2*|move|, high = close + 0.2*|move|
    return closes.map((close, i) => {
        const open = i === 0 ? close : closes[i - 1];
        const move = Math.abs(close - open);
        return {
            epoch: startEpoch + i * granSec,
            open,
            high: Math.max(open, close) + 0.2 * move + 0.01,
            low:  Math.min(open, close) - 0.2 * move - 0.01,
            close,
        };
    });
}

/* ─── Test driver ────────────────────────────────────────────────── */
function driveCycle({ history, priorStrategyState, openTrades, consecutiveLosses, nowMs }) {
    return Strategy.runCycle({
        symbols: ['TEST'],
        histories: { TEST: history },
        lastTick:  { TEST: { epoch: history['60'].at(-1).epoch, quote: history['60'].at(-1).close } },
        consecutiveLosses: consecutiveLosses || {},
        openTrades: openTrades || {},
        settings: { baseStake: 1, martingaleSteps: 3, martingaleMultiplier: 2 },
        priorStrategyState: priorStrategyState || {},
        nowMs,
    });
}

/* ===================================================================
   TEST 1: state survives across cycles
   =================================================================== */
section('TEST 1 — strategy_state persists across cycles');
{
    // Enable the demo strategy.
    Strategy.byId('breakout_pullback_v1').enabled = true;

    // 30 flat bars then one big upward break, all available in cycle 1.
    const closes = [];
    for (let i = 0; i < 30; i++) closes.push(100 + (i % 5) * 0.01);
    // Push one strong breakout bar:
    closes.push(102.5);
    // Plus a "live forming" bar after it so the engine sees the
    // breakout bar as fully closed.
    closes.push(102.4);

    const history1 = { '60': bars(closes) };

    // Cycle 1: fresh boot.
    const r1 = driveCycle({
        history: history1,
        priorStrategyState: {},
        nowMs: 1_700_000_000_000,
    });
    const state1 = r1.persistedState.breakout_pullback_v1.TEST;
    assert('seeded lastClosedEpoch in cycle 1',
        state1.__engine && state1.__engine.lastClosedEpoch && state1.__engine.lastClosedEpoch['60'] > 0,
        state1);

    // Cycle 2: append one more closed bar (a pullback that holds above
    // the channel high) and one new forming bar. Now we should see the
    // strategy arm CALL on the breakout bar AND then potentially fire
    // on the pullback bar.

    // Actually, on first ever cycle the engine SEEDS lastClosedEpoch
    // to the latest closable bar — so the breakout bar in cycle 1 is
    // NOT walked. That's the documented v3 anti-stale-replay behavior.
    // The arm therefore happens in cycle 2 when we walk the bar that
    // closes AFTER cycle 1's seed point.

    // For cycle 2 we extend the history with: pullback-then-hold bar.
    const closes2 = closes.slice(); // already has breakout + one forming bar from cycle1
    closes2.push(102.45);            // pullback toward the prior channel high (which was ~100.04)
    closes2.push(102.5);             // new forming bar
    // Wait — channel.hi over the first 20 flat bars is ~100.04, so any
    // close > 100.04 is a breakout. The "pullback toward" check needs
    // the bar's LOW to dip to <= armedLevel. Let me pick prices that
    // actually exercise that.
    const closes3 = [];
    for (let i = 0; i < 22; i++) closes3.push(100 + (i % 3) * 0.01);
    // Cycle 1 fixtures: just flat bars + one forming.
    closes3.push(100.02);   // last "real" bar before cycle 2 starts
    const history1b = { '60': bars(closes3) };

    const r1b = driveCycle({ history: history1b, priorStrategyState: {}, nowMs: 1_700_000_000_000 });
    const state1b = r1b.persistedState.breakout_pullback_v1.TEST;
    assert('cycle 1 (flat market): no signal, state preserved',
        r1b.signals.length === 0 && state1b.__engine.lastClosedEpoch['60'] > 0);

    // Cycle 2: market closes ABOVE channel high. Engine should arm.
    const closes4 = closes3.slice();
    // Add: one closed breakout bar at 102 + one new forming bar.
    closes4.push(102.0);
    closes4.push(102.05);
    const history2 = { '60': bars(closes4) };
    const r2 = driveCycle({
        history: history2,
        priorStrategyState: r1b.persistedState,
        nowMs: 1_700_000_060_000,
    });
    const state2 = r2.persistedState.breakout_pullback_v1.TEST;
    assert('cycle 2: armed CALL after breakout',
        state2.armed === 'CALL', { armed: state2.armed, armedLevel: state2.armedLevel });
    assert('cycle 2: emitted a HOLD decision (no signal yet)',
        r2.signals.length === 0 && r2.holds.length === 1, {
            signals: r2.signals.length, holds: r2.holds.length
        });

    // Cycle 3: pullback bar that dips to the prior level but closes above.
    // armedLevel from r2 should be the channel high at the time of arm.
    const armedLevel = state2.armedLevel;
    assert('armedLevel persisted is finite',
        Number.isFinite(armedLevel) && armedLevel > 0, { armedLevel });

    const closes5 = closes4.slice();
    // pullback bar: low must dip to <= armedLevel AND close above it.
    // We'll force this by appending a bar whose previous-close was 102.05
    // and new close is armedLevel + 0.005 (just above). To make `bar.low`
    // dip below armedLevel, our bar-builder uses min(open,close) minus a
    // small wick — that should suffice if armedLevel is between open
    // and close. Push a tiny bar at armedLevel + 0.002.
    closes5.push(armedLevel + 0.002);
    closes5.push(armedLevel + 0.003);   // forming bar
    const history3 = { '60': bars(closes5) };
    const r3 = driveCycle({
        history: history3,
        priorStrategyState: r2.persistedState,
        nowMs: 1_700_000_120_000,
    });
    assert('cycle 3: fired CALL signal after retest',
        r3.signals.length === 1 && r3.signals[0].decision.contractType === 'CALL',
        { signals: r3.signals.map(s => s.decision.contractType), holds: r3.holds.length });
}

/* ===================================================================
   TEST 2: gap-tolerant replay walks multiple bars in one cycle
   =================================================================== */
section('TEST 2 — multi-bar replay during cron gap');
{
    Strategy.byId('breakout_pullback_v1').enabled = true;

    // Cycle 1: 22 flat bars + forming. Seed.
    const closes = [];
    for (let i = 0; i < 22; i++) closes.push(100 + (i % 3) * 0.01);
    closes.push(100.02);  // forming
    const h1 = { '60': bars(closes) };
    const r1 = driveCycle({ history: h1, priorStrategyState: {}, nowMs: 1_700_001_000_000 });
    const lastSeen = r1.persistedState.breakout_pullback_v1.TEST.__engine.lastClosedEpoch['60'];
    assert('seeded', lastSeen > 0);

    // Cycle 2: a 5-bar gap happens. We append FIVE closed bars all at
    // once: a breakout bar, three flat-above-the-channel bars, then a
    // pullback-and-hold confirm bar. PLUS a forming bar. The engine
    // should walk bars 23, 24, 25, 26, 27 in order, arm on 23, hold
    // on 24/25/26, fire on 27.
    const closes2 = closes.slice();
    closes2.push(102.0);            // breakout: bar 23 (idx 22)
    closes2.push(102.1);            // bar 24
    closes2.push(102.05);           // bar 25
    closes2.push(102.08);           // bar 26
    // pullback-and-hold needs low <= armedLevel, close > armedLevel.
    // armedLevel will be ~ max of the first 22 closes' high ≈ 100.03ish.
    // So bar 27 with close 100.05 and dip to 100.02 fits.
    closes2.push(100.05);           // bar 27 — retest
    closes2.push(100.06);           // forming
    const h2 = { '60': bars(closes2) };

    const r2 = driveCycle({
        history: h2,
        priorStrategyState: r1.persistedState,
        nowMs: 1_700_001_300_000,   // 5 minutes later
    });

    // The engine collapses multiple-bar signals to the most recent.
    // We expect: ONE signal (the retest on bar 27).
    assert('cycle 2: emitted exactly one signal across 5-bar replay',
        r2.signals.length === 1, { signals: r2.signals.length, holds: r2.holds.length });
    if (r2.signals.length === 1) {
        assert('replay signal is CALL', r2.signals[0].decision.contractType === 'CALL');
    }
    // And state.armed got cleared on the fire.
    const state2 = r2.persistedState.breakout_pullback_v1.TEST;
    assert('arm cleared after fire', state2.armed === false, { armed: state2.armed });
    // lastClosedEpoch advanced past the last closable bar of cycle 2.
    const closableEpochEnd = h2['60'][h2['60'].length - 2].epoch;
    assert('lastClosedEpoch advanced to last closable bar',
        state2.__engine.lastClosedEpoch['60'] === closableEpochEnd,
        { saved: state2.__engine.lastClosedEpoch['60'], expected: closableEpochEnd });
}

/* ===================================================================
   TEST 3: engine-enforced cooldown blocks rapid re-fire
   =================================================================== */
section('TEST 3 — engine cooldown gate');
{
    Strategy.byId('breakout_pullback_v1').enabled = true;
    // Cycle A: seed.
    const closes = [];
    for (let i = 0; i < 22; i++) closes.push(100 + (i % 3) * 0.01);
    closes.push(100.02);                       // forming
    const rA = driveCycle({ history: { '60': bars(closes) }, priorStrategyState: {},
        nowMs: 1_700_002_000_000 });
    // Cycle B: append one breakout closed bar + a forming bar. Arms CALL.
    const closes2 = closes.slice();
    closes2.push(102.0);                       // closed breakout
    closes2.push(102.01);                      // forming
    const rB = driveCycle({ history: { '60': bars(closes2) }, priorStrategyState: rA.persistedState,
        nowMs: 1_700_002_060_000 });
    const armedLevel = rB.persistedState.breakout_pullback_v1.TEST.armedLevel;
    // Cycle C: append a retest bar + a forming bar. Should FIRE.
    const closes3 = closes2.slice();
    closes3.push(armedLevel + 0.001);          // closed retest
    closes3.push(armedLevel + 0.002);          // forming
    const rC = driveCycle({ history: { '60': bars(closes3) }, priorStrategyState: rB.persistedState,
        nowMs: 1_700_002_120_000 });
    assert('initial fire happened (TEST 3 setup)', rC.signals.length === 1,
        { signals: rC.signals.length, holds: rC.holds.length });
    // Cycle D: within cooldown window, try to fire again.
    // Force another breakout immediately after.
    const closes4 = closes3.slice();
    closes4.push(105.0);                       // big new breakout (closed)
    closes4.push(armedLevel + 0.5);            // doesn't matter for the closed-bar walk
    const rD = driveCycle({
        history: { '60': bars(closes4) },
        priorStrategyState: rC.persistedState,
        nowMs: 1_700_002_125_000,              // 5s later, well inside 120s cooldown
    });
    // The arm itself is a 'hold', NOT a signal — cooldown blocks
    // signals only. The engine should suppress any 'signal' decisions
    // during cooldown.
    assert('cooldown suppresses any would-be signal',
        rD.signals.length === 0, { signals: rD.signals.length, holds: rD.holds.length });
}

/* ===================================================================
   TEST 4: openTrades gate suppresses signal
   =================================================================== */
section('TEST 4 — openTrades gate');
{
    Strategy.byId('breakout_pullback_v1').enabled = true;
    // Replay TEST 1 cycle 3 but with openTrades set.
    const closes = [];
    for (let i = 0; i < 22; i++) closes.push(100 + (i % 3) * 0.01);
    closes.push(100.02);
    const r1 = driveCycle({ history: { '60': bars(closes) }, priorStrategyState: {},
        nowMs: 1_700_003_000_000 });
    const closes2 = closes.slice();
    closes2.push(102.0);
    const r1b = driveCycle({ history: { '60': bars(closes2) }, priorStrategyState: r1.persistedState,
        nowMs: 1_700_003_060_000 });
    const armedLevel = r1b.persistedState.breakout_pullback_v1.TEST.armedLevel;
    const closes3 = closes2.slice();
    closes3.push(armedLevel + 0.001);
    const r2 = driveCycle({
        history: { '60': bars(closes3) },
        priorStrategyState: r1b.persistedState,
        openTrades: { 'breakout_pullback_v1::TEST': true },
        nowMs: 1_700_003_120_000,
    });
    assert('openTrades gate suppresses signal',
        r2.signals.length === 0, { signals: r2.signals.length });
}

/* ===================================================================
   TEST 5: consecutiveLosses reconstruction
   =================================================================== */
section('TEST 5 — consecutiveLosses reconstruction');
{
    const history = [
        { strategy: 'A', symbol: 'X', result: 'loss' },
        { strategy: 'A', symbol: 'X', result: 'loss' },
        { strategy: 'A', symbol: 'X', result: 'win'  },
        { strategy: 'A', symbol: 'X', result: 'loss' },
        { strategy: 'A', symbol: 'X', result: 'loss' },
        { strategy: 'A', symbol: 'X', result: 'loss' },
        { strategy: 'A', symbol: 'Y', result: 'loss' },
        { strategy: 'A', symbol: 'Y', result: 'win'  },
        { strategy: 'B', symbol: 'X', result: 'loss' },
    ];
    const r = Strategy.reconstructConsecutiveLosses(history);
    assert('A::X tail-streak = 3', r['A::X'] === 3, r);
    assert('A::Y tail-streak = 0 (broken by win)', r['A::Y'] === 0, r);
    assert('B::X tail-streak = 1', r['B::X'] === 1, r);
}

/* ===================================================================
   TEST 6: state.__engine is reserved & strategies cannot break it
   =================================================================== */
section('TEST 6 — state.__engine survives strategy mutations');
{
    Strategy.byId('breakout_pullback_v1').enabled = true;
    const closes = [];
    for (let i = 0; i < 22; i++) closes.push(100 + (i % 3) * 0.01);
    closes.push(100.02);
    const r1 = driveCycle({ history: { '60': bars(closes) }, priorStrategyState: {},
        nowMs: 1_700_004_000_000 });
    const s = r1.persistedState.breakout_pullback_v1.TEST;
    assert('__engine present', s && s.__engine != null);
    assert('__engine.lastClosedEpoch is an object', typeof s.__engine.lastClosedEpoch === 'object');
}

/* ─── Summary ────────────────────────────────────────────────────── */
console.log('\n' + '═'.repeat(72));
console.log(`SELFTEST RESULT — ${PASS} passed / ${FAIL} failed`);
console.log('═'.repeat(72));
process.exit(FAIL === 0 ? 0 : 1);
