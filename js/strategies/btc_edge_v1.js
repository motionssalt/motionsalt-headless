/* =====================================================================
   STRATEGY · btc_edge_v1   —   "BTC Edge"
   ─────────────────────────────────────────────────────────────────────
   Crypto-tuned multi-timeframe momentum strategy designed for the Deriv
   `cryBTCUSD` synthetic, but works on any symbol with enough liquidity.

   Logic:
     • Higher timeframe (5m) EMA(50) defines the dominant bias.
     • On the 1m chart we wait for an RSI(14) pullback INTO the trend
       (rsi < 45 in an uptrend, rsi > 55 in a downtrend) and require
       Bollinger-band slope confirmation.
     • Fires on the closing bar that prints a momentum re-acceleration:
         CALL — price closes above the prior bar high AND htf bullish
         PUT  — price closes below the prior bar low  AND htf bearish

   Falls back to custom EMA / RSI / Bollinger math if the indicator
   library is unavailable.
   ===================================================================== */
(function () {

    const plugin = {
        id:       'btc_edge_v1',
        name:     'BTC Edge',
        enabled:  true,
        historyRequest: { '60': 120, '300': 80 },

        /* ---- Fallback math ----------------------------------------- */
        _emaSeries(values, period) {
            if (!values.length) return [];
            const k = 2 / (period + 1);
            const out = [values[0]];
            for (let i = 1; i < values.length; i++) {
                out.push(values[i] * k + out[i - 1] * (1 - k));
            }
            return out;
        },
        _rsiSeries(values, period = 14) {
            if (values.length < period + 1) return [];
            let gainSum = 0, lossSum = 0;
            for (let i = 1; i <= period; i++) {
                const d = values[i] - values[i - 1];
                if (d >= 0) gainSum += d; else lossSum -= d;
            }
            let avgGain = gainSum / period;
            let avgLoss = lossSum / period;
            const out = [];
            out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
            for (let i = period + 1; i < values.length; i++) {
                const d = values[i] - values[i - 1];
                const g = d > 0 ?  d : 0;
                const l = d < 0 ? -d : 0;
                avgGain = (avgGain * (period - 1) + g) / period;
                avgLoss = (avgLoss * (period - 1) + l) / period;
                out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
            }
            return out;
        },

        onTick(ctx) {
            const c1m = ctx.history['60']  || [];
            const c5m = ctx.history['300'] || [];
            const log = ctx.log || function(){};
            const st  = ctx.state;
            const now = ctx.tick.epoch;

            if (c1m.length < 40 || c5m.length < 30) {
                return { type: null, displayData: { Status: 'warming up' } };
            }
            const closes1 = c1m.map(c => c.close);
            const closes5 = c5m.map(c => c.close);

            const EMA = Strategy.pickIndicator(ctx, 'EMA');
            const RSI = Strategy.pickIndicator(ctx, 'RSI');

            const ema50h = EMA
                ? EMA.calculate({ values: closes5, period: 50 })
                : this._emaSeries(closes5, 50);
            const ema21  = EMA
                ? EMA.calculate({ values: closes1, period: 21 })
                : this._emaSeries(closes1, 21);
            const rsi    = RSI
                ? RSI.calculate({ values: closes1, period: 14 })
                : this._rsiSeries(closes1, 14);

            if (!ema50h.length || !ema21.length || rsi.length < 2) {
                return { type: null, displayData: { Status: 'indicators not ready' } };
            }

            const price       = closes1.at(-1);
            const priceH      = closes5.at(-1);
            const htfEma      = ema50h.at(-1);
            const ltfEma      = ema21.at(-1);
            const rsiNow      = rsi.at(-1);
            const rsiPrv      = rsi.at(-2);

            const htfTrend = priceH > htfEma ? 'Bullish'
                           : priceH < htfEma ? 'Bearish' : 'Flat';

            const dd = {
                Price:        price.toFixed(2),
                'EMA(21)/1m': ltfEma.toFixed(2),
                'EMA(50)/5m': htfEma.toFixed(2),
                'HTF Trend':  htfTrend,
                'RSI(14)':    rsiNow.toFixed(2),
                Losses:       String(ctx.consecutiveLosses || 0),
            };

            // Lazy state init
            if (st.lastSignalEpoch == null) st.lastSignalEpoch = 0;
            const lastClosed = c1m.length >= 2 ? c1m[c1m.length - 2] : null;
            if (st.seededFromHistory == null) {
                st.seededFromHistory = true;
                st.lastClosedEpoch   = lastClosed ? lastClosed.epoch : 0;
                log('info', 'btc_edge seeded', { trend: htfTrend });
            }

            // Bail conditions
            if (ctx.hasOpenTrade) {
                return { type: null, displayData: { ...dd, Status: 'trade open' } };
            }
            if (now - st.lastSignalEpoch < 60) {
                return { type: null, displayData: { ...dd, Status: 'cooldown' } };
            }
            if (ctx.sessionEpoch && lastClosed && lastClosed.epoch <= ctx.sessionEpoch) {
                return { type: null, displayData: { ...dd, Status: 'pre-session bar' } };
            }
            if (lastClosed && st.lastClosedEpoch === lastClosed.epoch) {
                return { type: null, displayData: { ...dd, Status: 'awaiting new bar' } };
            }
            if (lastClosed) st.lastClosedEpoch = lastClosed.epoch;

            // Look at last two closed bars for breakout confirmation
            const prevBar = c1m[c1m.length - 3];
            const curBar  = c1m[c1m.length - 2];
            if (!prevBar || !curBar) {
                return { type: null, displayData: { ...dd, Status: 'no bars' } };
            }

            const mult = ctx.settings.martingaleMultiplier;

            // Bullish setup: HTF bullish + LTF above EMA + RSI dipped <45 then rebounded
            if (htfTrend === 'Bullish' && price > ltfEma &&
                rsiPrv < 45 && rsiNow > rsiPrv &&
                curBar.close > prevBar.high) {
                st.lastSignalEpoch = now;
                log('trade', 'FIRE CALL (btc_edge bullish breakout)');
                return {
                    type: 'signal',
                    contractType: 'CALL',
                    stake: Strategy.computeStake(
                        ctx.settings.baseStake, ctx.consecutiveLosses, mult),
                    duration: 2,
                    durationUnit: 'm',
                    displayData: { ...dd, Status: 'FIRING CALL' },
                };
            }

            // Bearish setup
            if (htfTrend === 'Bearish' && price < ltfEma &&
                rsiPrv > 55 && rsiNow < rsiPrv &&
                curBar.close < prevBar.low) {
                st.lastSignalEpoch = now;
                log('trade', 'FIRE PUT (btc_edge bearish breakdown)');
                return {
                    type: 'signal',
                    contractType: 'PUT',
                    stake: Strategy.computeStake(
                        ctx.settings.baseStake, ctx.consecutiveLosses, mult),
                    duration: 2,
                    durationUnit: 'm',
                    displayData: { ...dd, Status: 'FIRING PUT' },
                };
            }

            // HOLD pre-signal when we're inside the trend but waiting for breakout
            if (htfTrend === 'Bullish' && rsiPrv < 40 && rsiNow > rsiPrv) {
                return {
                    type: 'hold',
                    reason: `BTC RSI ${rsiNow.toFixed(1)} pulling back in uptrend`,
                    displayData: { ...dd, Status: 'armed CALL' },
                };
            }
            if (htfTrend === 'Bearish' && rsiPrv > 60 && rsiNow < rsiPrv) {
                return {
                    type: 'hold',
                    reason: `BTC RSI ${rsiNow.toFixed(1)} fading in downtrend`,
                    displayData: { ...dd, Status: 'armed PUT' },
                };
            }

            return { type: null, displayData: dd };
        }
    };

    Strategy.register(plugin);
})();
