/* =====================================================================
   STRATEGY · FIVE_MIN_CRAZY_V1   (Motionsalt v3 contract)
   ─────────────────────────────────────────────────────────────────────
   Implements the “5 Minute Crazy Method” (binary options) as specified
   in the accompanying configuration sheet:

     1) Schaff Trend Cycle (STC)
          fastLength = 25, slowLength = 47, cycleLength = 10,
          %D (MACD) length = 3, %D (PF) length = 3
          oversold band = 25, overbought band = 75
     2) ZigZag
          deviation = 5 (%), depth = 11, backstep = 3
     3) EMA(7)

   Timeframe        : 1-minute candles (primaryGranularity '60')
   Trade expiration : 3 minutes (mid of the spec’s “3–5 min” range)

   Trade logic (CALL is mirror of PUT):

     • ARM CALL   when
            STC crosses UP through 25  (oversold exit, bullish trigger)
        AND price (bar.close) is ABOVE EMA(7)        (trend filter)
        AND most-recent ZigZag pivot is a LOW         (structure flip)
     • FIRE CALL  when, within 180 real seconds of arming,
            bar.close > EMA(7)  AND STC still rising
     • Mirror conditions for PUT
            (STC crosses DOWN through 75, price BELOW EMA(7),
             most-recent ZigZag pivot is a HIGH).
     • Arm auto-expires after 180 s (`bar.epoch - armedAtEpoch > 180`).

   This file is fully R1–R10 compliant: pure onClosedBar, no DOM, no
   fetch, no timers, no random for control flow, no module-level let,
   all cross-bar memory on ctx.state, JSON-serialisable only, stake via
   Strategy.computeStake, indicator guards w/ custom-math fallback.

   The spec for the engine that runs this is in STRATEGY_SPEC.md.
   ===================================================================== */
(function () {

    const plugin = {
        /* ===== Identity ============================================== */
        id:       'five_min_crazy_v1',
        name:     '5-Minute Crazy Method (STC + ZigZag + EMA7)',
        enabled:  false,                  // flip to true once back-tested

        /* ===== Timeframes ============================================ */
        primaryGranularity: '60',                 // 1-minute bars
        historyRequest:     { '60': 200 },        // STC(25/47/10) needs ~120+ bars to settle

        /* ===== Engine-enforced cooldown & safety ==================== */
        cooldownMs:       180000,                 // 3 min between signals (matches expiry)
        maxBarsPerCycle:  50,
        contractSymbols:  null,                   // any symbol the bot enables

        /* =================================================================
           CUSTOM-MATH HELPERS  (pure, deterministic, JSON-safe outputs)
           All prefixed `_` by convention.
           ================================================================= */

        /* ----- EMA ------------------------------------------------------ */
        _ema(values, period) {
            if (!Array.isArray(values) || values.length < period) return [];
            const k = 2 / (period + 1);
            const out = [];
            // seed with SMA of first `period` values
            let sum = 0;
            for (let i = 0; i < period; i++) sum += values[i];
            let prev = sum / period;
            out.push(prev);
            for (let i = period; i < values.length; i++) {
                prev = values[i] * k + prev * (1 - k);
                out.push(prev);
            }
            return out;       // length = values.length - period + 1
        },

        /* ----- Schaff Trend Cycle --------------------------------------
           Faithful implementation of Doug Schaff’s STC:

             macd        = EMA(close, fast) - EMA(close, slow)
             %K_macd     = stochastic(macd, cycleLen)
             %D_macd     = EMA(%K_macd, dLenMacd)        // smoothing #1
             %K_pf       = stochastic(%D_macd, cycleLen)
             STC         = EMA(%K_pf, dLenPf)            // smoothing #2

           Output is bounded ~[0, 100]. Typical bands: 25 / 75.
           ---------------------------------------------------------------- */
        _stc(closes, fast, slow, cycle, dMacd, dPf) {
            const need = slow + cycle + dMacd + dPf + 5;
            if (closes.length < need) return [];

            const emaFast = this._ema(closes, fast);
            const emaSlow = this._ema(closes, slow);
            // align tails (EMA arrays have different start offsets)
            const tail = Math.min(emaFast.length, emaSlow.length);
            const macd = new Array(tail);
            const offF = emaFast.length - tail;
            const offS = emaSlow.length - tail;
            for (let i = 0; i < tail; i++) macd[i] = emaFast[i + offF] - emaSlow[i + offS];

            const stoch = (series, len) => {
                const out = [];
                for (let i = len - 1; i < series.length; i++) {
                    let mn = series[i], mx = series[i];
                    for (let j = i - len + 1; j <= i; j++) {
                        if (series[j] < mn) mn = series[j];
                        if (series[j] > mx) mx = series[j];
                    }
                    const range = mx - mn;
                    out.push(range === 0 ? 0 : ((series[i] - mn) / range) * 100);
                }
                return out;
            };

            const kMacd  = stoch(macd, cycle);
            if (kMacd.length < dMacd) return [];
            const dMacdS = this._ema(kMacd, dMacd);
            if (dMacdS.length < cycle) return [];
            const kPf    = stoch(dMacdS, cycle);
            if (kPf.length < dPf) return [];
            const stc    = this._ema(kPf, dPf);
            return stc;
        },

        /* ----- ZigZag --------------------------------------------------
           Simplified MT4-style ZigZag: walks the series, marks a new
           pivot whenever price reverses by `depth` bars AND by at least
           `deviation` percent from the last pivot, with `backstep`
           protection against immediate flips.

           Returns the LAST pivot only (sufficient for our trigger):
             { type: 'high' | 'low', index, price, epoch }
           or null if not enough data.
           ---------------------------------------------------------------- */
        _lastZigZagPivot(bars, deviationPct, depth, backstep) {
            if (!Array.isArray(bars) || bars.length < depth + backstep + 2) return null;
            const devFrac = deviationPct / 100;

            let lastPivotIdx   = 0;
            let lastPivotPrice = bars[0].close;
            let lastPivotType  = null;       // 'high' | 'low' | null
            let lastPivotEpoch = bars[0].epoch;

            for (let i = depth; i < bars.length; i++) {
                // local high/low over [i-depth+1 .. i]
                let hi = -Infinity, lo = Infinity, hiIdx = i, loIdx = i;
                for (let j = i - depth + 1; j <= i; j++) {
                    if (bars[j].high > hi) { hi = bars[j].high; hiIdx = j; }
                    if (bars[j].low  < lo) { lo = bars[j].low;  loIdx = j; }
                }

                // candidate HIGH
                if (hiIdx === i &&
                    (lastPivotType !== 'high') &&
                    (i - lastPivotIdx >= backstep) &&
                    Math.abs(hi - lastPivotPrice) / lastPivotPrice >= devFrac) {
                    lastPivotIdx   = i;
                    lastPivotPrice = hi;
                    lastPivotType  = 'high';
                    lastPivotEpoch = bars[i].epoch;
                }
                // candidate LOW
                else if (loIdx === i &&
                    (lastPivotType !== 'low') &&
                    (i - lastPivotIdx >= backstep) &&
                    Math.abs(lo - lastPivotPrice) / lastPivotPrice >= devFrac) {
                    lastPivotIdx   = i;
                    lastPivotPrice = lo;
                    lastPivotType  = 'low';
                    lastPivotEpoch = bars[i].epoch;
                }
            }

            return lastPivotType
                ? { type: lastPivotType, index: lastPivotIdx,
                    price: lastPivotPrice, epoch: lastPivotEpoch }
                : null;
        },

        /* =================================================================
           Optional onSeed — prime baseline closes (NEVER returns a decision)
           ================================================================= */
        onSeed(ctx) {
            const c = ctx.history['60'] || [];
            if (c.length) ctx.state.seedClose = c.at(-1).close;
        },

        /* =================================================================
           Optional onMonitor — shown on cycles with no new bars
           ================================================================= */
        onMonitor(ctx) {
            const c = ctx.history[this.primaryGranularity] || [];
            const last = c.at(-1);
            return {
                Price:  last ? last.close.toFixed(5) : '—',
                Losses: String(ctx.consecutiveLosses || 0),
                Armed:  ctx.state && ctx.state.armed ? String(ctx.state.armed) : '—',
            };
        },

        /* =================================================================
           REQUIRED: onClosedBar(bar, ctx)
           ================================================================= */
        onClosedBar(bar, ctx) {
            const c = ctx.history['60'];

            // ── Length guard (R5) ─────────────────────────────────────────
            // STC(25/47/10/3/3) needs ≈ slow + cycle + dMacd + dPf + 5 ≈ 68
            // plus a buffer for EMA seeding → require 120.
            if (!c || c.length < 120) {
                return { type: 'warmup', reason: 'need 120+ 1m bars for STC' };
            }
            const closes = c.map(x => x.close);

            // ── EMA(7) — prefer engine indicator, fall back to custom (R4)
            const EMA = Strategy.pickIndicator(ctx, 'EMA');
            const emaSeries = EMA
                ? EMA.calculate({ values: closes, period: 7 })
                : this._ema(closes, 7);
            if (!emaSeries || emaSeries.length < 2) {
                return { type: 'warmup', reason: 'ema warming up' };
            }
            const ema    = emaSeries[emaSeries.length - 1];
            const emaPrv = emaSeries[emaSeries.length - 2];

            // ── STC(25, 47, 10, 3, 3) — custom math (technicalindicators
            //    does not ship STC; no engine indicator to guard for) ─────
            const stcSeries = this._stc(closes, 25, 47, 10, 3, 3);
            if (stcSeries.length < 3) {
                return { type: 'warmup', reason: 'stc warming up' };
            }
            const stc    = stcSeries[stcSeries.length - 1];
            const stcPrv = stcSeries[stcSeries.length - 2];

            // ── ZigZag(dev 5%, depth 11, backstep 3) ─────────────────────
            const pivot = this._lastZigZagPivot(c, 5, 11, 3);  // may be null early

            // ── Lazy-init persistent state (R2) ───────────────────────────
            const s = ctx.state;
            if (s.armed         == null) s.armed         = false;   // false | 'CALL' | 'PUT'
            if (s.armedAtEpoch  == null) s.armedAtEpoch  = 0;
            if (s.armEntryStc   == null) s.armEntryStc   = 0;

            // ── Live monitor readout (always populated) ───────────────────
            const displayData = {
                Price:    bar.close.toFixed(5),
                'EMA(7)': ema.toFixed(5),
                'STC':    stc.toFixed(1),
                ZZ:       pivot ? `${pivot.type}@${pivot.price.toFixed(5)}` : '—',
                Armed:    s.armed ? String(s.armed) : '—',
                Losses:   String(ctx.consecutiveLosses || 0),
            };

            /* ─────────────────────────────────────────────────────────────
               1. ARM TIMEOUT  (R7: real seconds via bar.epoch — not bars)
               ───────────────────────────────────────────────────────────── */
            if (s.armed && (bar.epoch - s.armedAtEpoch) > 180) {
                ctx.log('info', `arm ${s.armed} expired (>180s)`);
                s.armed = false;
                s.armedAtEpoch = 0;
                s.armEntryStc  = 0;
            }

            /* ─────────────────────────────────────────────────────────────
               2. ARM logic — only when not currently armed
               ───────────────────────────────────────────────────────────── */
            if (!s.armed) {
                const stcCrossedUp25   = stcPrv <= 25 && stc > 25;
                const stcCrossedDown75 = stcPrv >= 75 && stc < 75;
                const priceAboveEma    = bar.close > ema;
                const priceBelowEma    = bar.close < ema;
                const lastPivotIsLow   = pivot && pivot.type === 'low';
                const lastPivotIsHigh  = pivot && pivot.type === 'high';

                if (stcCrossedUp25 && priceAboveEma && lastPivotIsLow) {
                    s.armed        = 'CALL';
                    s.armedAtEpoch = bar.epoch;
                    s.armEntryStc  = stc;
                    ctx.log('signal',
                        `arm CALL · STC ${stcPrv.toFixed(1)}→${stc.toFixed(1)} ` +
                        `· px ${bar.close.toFixed(5)} > EMA ${ema.toFixed(5)} · ZZ low`);
                    return {
                        type: 'hold',
                        reason: `armed CALL (STC↑${stc.toFixed(1)})`,
                        displayData: { ...displayData, Status: 'armed CALL' },
                    };
                }
                if (stcCrossedDown75 && priceBelowEma && lastPivotIsHigh) {
                    s.armed        = 'PUT';
                    s.armedAtEpoch = bar.epoch;
                    s.armEntryStc  = stc;
                    ctx.log('signal',
                        `arm PUT · STC ${stcPrv.toFixed(1)}→${stc.toFixed(1)} ` +
                        `· px ${bar.close.toFixed(5)} < EMA ${ema.toFixed(5)} · ZZ high`);
                    return {
                        type: 'hold',
                        reason: `armed PUT (STC↓${stc.toFixed(1)})`,
                        displayData: { ...displayData, Status: 'armed PUT' },
                    };
                }
            }

            /* ─────────────────────────────────────────────────────────────
               3. CONFIRM & FIRE
                  Bar after arming, require:
                    • STC still trending in arm direction
                    • EMA(7) trending in arm direction (ema vs emaPrv)
                    • price stays on correct side of EMA(7)
               ───────────────────────────────────────────────────────────── */
            if (s.armed === 'CALL') {
                const stcRising   = stc > s.armEntryStc;
                const emaRising   = ema >= emaPrv;
                const priceAbove  = bar.close > ema;
                if (stcRising && emaRising && priceAbove) {
                    const armed = s.armed;
                    s.armed = false; s.armedAtEpoch = 0; s.armEntryStc = 0;
                    ctx.log('trade',
                        `FIRE CALL · STC ${stc.toFixed(1)} · px ${bar.close.toFixed(5)}`);
                    return {
                        type: 'signal',
                        contractType: 'CALL',
                        stake: Strategy.computeStake(
                            ctx.settings.baseStake,
                            ctx.consecutiveLosses,
                            ctx.settings.martingaleMultiplier),
                        duration: 3,
                        durationUnit: 'm',
                        displayData: { ...displayData, Status: `FIRING ${armed}` },
                    };
                }
            }

            if (s.armed === 'PUT') {
                const stcFalling = stc < s.armEntryStc;
                const emaFalling = ema <= emaPrv;
                const priceBelow = bar.close < ema;
                if (stcFalling && emaFalling && priceBelow) {
                    const armed = s.armed;
                    s.armed = false; s.armedAtEpoch = 0; s.armEntryStc = 0;
                    ctx.log('trade',
                        `FIRE PUT · STC ${stc.toFixed(1)} · px ${bar.close.toFixed(5)}`);
                    return {
                        type: 'signal',
                        contractType: 'PUT',
                        stake: Strategy.computeStake(
                            ctx.settings.baseStake,
                            ctx.consecutiveLosses,
                            ctx.settings.martingaleMultiplier),
                        duration: 3,
                        durationUnit: 'm',
                        displayData: { ...displayData, Status: `FIRING ${armed}` },
                    };
                }
            }

            // No decision — but keep monitor alive (R10-friendly).
            return { type: null, displayData };
        },
    };

    Strategy.register(plugin);

})();
