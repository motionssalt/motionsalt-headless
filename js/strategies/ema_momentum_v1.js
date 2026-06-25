/* =====================================================================
   STRATEGY · ema_momentum_v1   —   "EMA Trend + Momentum (MTF)"
   ─────────────────────────────────────────────────────────────────────
   Multi-timeframe: 1m EMA(21) for entry + 15m EMA(21) as trend filter.
   Demonstrates the historyRequest MTF schema.

   Falls back to a custom EMA series + custom MACD histogram if the
   indicator library is unavailable — so this strategy, too, is
   self-contained even without the CDN.

   See `js/strategies/STRATEGY_SPEC.md` for the full authoring contract.
   ===================================================================== */
(function () {

    const emaMomentum = {
        id:       'ema_momentum_v1',
        name:     'EMA Trend + Momentum (MTF)',
        enabled:  false,
        historyRequest: { '60': 80, '900': 50 }, // 1m + 15m

        /* ---- Custom EMA series --------------------------------------- */
        _emaSeries(values, period) {
            if (!Array.isArray(values) || values.length === 0) return [];
            const k = 2 / (period + 1);
            const out = [values[0]];
            for (let i = 1; i < values.length; i++) {
                out.push(values[i] * k + out[i - 1] * (1 - k));
            }
            return out;
        },

        /* ---- Custom MACD histogram (last value only) ---------------- */
        _macdHistSeries(values, fast = 12, slow = 26, signal = 9) {
            if (values.length < slow + signal) return [];
            const emaFast = this._emaSeries(values, fast);
            const emaSlow = this._emaSeries(values, slow);
            const macdLine = values.map((_, i) => emaFast[i] - emaSlow[i]);
            const signalLine = this._emaSeries(macdLine.slice(slow - 1), signal);
            const padded = new Array(slow - 1).fill(null).concat(signalLine);
            const out = [];
            for (let i = 0; i < macdLine.length; i++) {
                if (padded[i] == null) continue;
                out.push({
                    MACD: macdLine[i],
                    signal: padded[i],
                    histogram: macdLine[i] - padded[i]
                });
            }
            return out;
        },

        onTick(ctx) {
            const c1m  = ctx.history['60']  || [];
            const c15m = ctx.history['900'] || [];

            if (c1m.length < 30 || c15m.length < 22) {
                return { type: null, displayData: { Status: 'warming up' } };
            }

            const closes1  = c1m.map(c  => c.close);
            const closes15 = c15m.map(c => c.close);

            const EMA  = Strategy.pickIndicator(ctx, 'EMA');
            const MACD = Strategy.pickIndicator(ctx, 'MACD');

            const ema21  = EMA
                ? EMA.calculate({ values: closes1,  period: 21 })
                : this._emaSeries(closes1,  21);
            const ema21h = EMA
                ? EMA.calculate({ values: closes15, period: 21 })
                : this._emaSeries(closes15, 21);
            const macd   = MACD
                ? MACD.calculate({
                    values: closes1,
                    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
                    SimpleMAOscillator: false, SimpleMASignalLine: false
                })
                : this._macdHistSeries(closes1, 12, 26, 9);

            const sourceTag = (EMA && MACD) ? 'TI' : (EMA || MACD) ? 'mixed' : 'custom';

            if (!ema21.length || !ema21h.length || !macd.length) {
                return { type: null, displayData: { Status: 'warming up', Source: sourceTag } };
            }

            const price    = closes1[closes1.length - 1];
            const emaNow   = ema21[ema21.length - 1];
            const emaHNow  = ema21h[ema21h.length - 1];
            const priceH   = closes15[closes15.length - 1];
            const mNow     = macd[macd.length - 1];
            const mPrv     = macd[macd.length - 2] ?? mNow;

            const htfTrend = priceH > emaHNow ? 'Bullish'
                           : priceH < emaHNow ? 'Bearish' : 'Flat';
            const ltfBias  = price   > emaNow  ? 'Bullish'
                           : price   < emaNow  ? 'Bearish' : 'Flat';

            const displayData = {
                Price:         price.toFixed(5),
                'EMA(21)/1m':  emaNow.toFixed(5),
                'EMA(21)/15m': emaHNow.toFixed(5),
                'HTF Trend':   htfTrend,
                'LTF Bias':    ltfBias,
                'MACD Hist':   (mNow.histogram ?? 0).toFixed(6),
                Source:        sourceTag,
                Losses:        String(ctx.consecutiveLosses || 0)
            };

            if (ctx.hasOpenTrade) {
                return { type: null, displayData: { ...displayData, Status: 'trade open' } };
            }

            const st  = ctx.state;
            const log = ctx.log || function(){};
            if (st.lastSignalEpoch == null) st.lastSignalEpoch = 0;
            const now = ctx.tick.epoch;

            const lastClosed1m  = c1m.length  >= 2 ? c1m[c1m.length - 2]  : null;
            const lastClosed15m = c15m.length >= 2 ? c15m[c15m.length - 2] : null;

            /* WARM-UP BARRIER (R7) — seed previous-histogram + lastClosedEpoch
               from history on the first tick so pre-session MACD crosses
               cannot fire. */
            if (st.seededFromHistory == null) {
                st.seededFromHistory = true;
                st.lastClosedEpoch   = lastClosed1m ? lastClosed1m.epoch : 0;
                st.lastHist          = (mPrv && mPrv.histogram != null) ? mPrv.histogram : 0;
                log('info', 'seeded from history', {
                    hist: st.lastHist, lastClosed: st.lastClosedEpoch
                });
            }

            if (now - st.lastSignalEpoch < 60) {
                return { type: null, displayData: { ...displayData, Status: 'cooldown' } };
            }
            if (ctx.sessionEpoch && lastClosed1m && lastClosed1m.epoch <= ctx.sessionEpoch) {
                return { type: null, displayData: { ...displayData, Status: 'pre-session bar' } };
            }
            if (lastClosed1m && st.lastClosedEpoch === lastClosed1m.epoch) {
                return { type: null, displayData: { ...displayData, Status: 'awaiting new bar' } };
            }
            if (lastClosed1m) st.lastClosedEpoch = lastClosed1m.epoch;

            const mult = ctx.settings.martingaleMultiplier;
            const prevHist = (mPrv.histogram ?? 0);
            const nowHist  = (mNow.histogram ?? 0);

            // Bullish MTF: HTF bullish + LTF cross up + MACD hist flips positive
            if (htfTrend === 'Bullish' && price > emaNow &&
                prevHist <= 0 && nowHist > 0) {
                st.lastSignalEpoch = now;
                log('trade', 'FIRE CALL (MTF bullish + MACD flip)');
                return {
                    type: 'signal',
                    contractType: 'CALL',
                    stake: Strategy.computeStake(ctx.settings.baseStake, ctx.consecutiveLosses, mult),
                    duration: 2,
                    durationUnit: 'm',
                    displayData: { ...displayData, Status: 'FIRING CALL' }
                };
            }
            if (htfTrend === 'Bearish' && price < emaNow &&
                prevHist >= 0 && nowHist < 0) {
                st.lastSignalEpoch = now;
                log('trade', 'FIRE PUT (MTF bearish + MACD flip)');
                return {
                    type: 'signal',
                    contractType: 'PUT',
                    stake: Strategy.computeStake(ctx.settings.baseStake, ctx.consecutiveLosses, mult),
                    duration: 2,
                    durationUnit: 'm',
                    displayData: { ...displayData, Status: 'FIRING PUT' }
                };
            }

            st.lastHist = nowHist;
            return { type: null, displayData };
        }
    };

    Strategy.register(emaMomentum);
})();
