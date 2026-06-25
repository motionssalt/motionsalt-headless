/* =====================================================================
   STRATEGY · eth_edge_v1   —   "ETH Edge"
   ─────────────────────────────────────────────────────────────────────
   ETH variant of btc_edge with slightly tighter RSI thresholds and a
   wider ATR-aware breakout filter.

   Logic:
     • HTF (5m) EMA(50) defines bias.
     • 1m EMA(21) for entry trend alignment.
     • RSI(14) pullback into trend + ATR-aware breakout.
     • Volume proxy: candle range vs ATR ⇒ "expansion" confirmation.
   ===================================================================== */
(function () {

    const plugin = {
        id:       'eth_edge_v1',
        name:     'ETH Edge',
        enabled:  true,
        historyRequest: { '60': 120, '300': 80 },

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
            let g = 0, l = 0;
            for (let i = 1; i <= period; i++) {
                const d = values[i] - values[i - 1];
                if (d >= 0) g += d; else l -= d;
            }
            let avgG = g / period, avgL = l / period;
            const out = [];
            out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
            for (let i = period + 1; i < values.length; i++) {
                const d = values[i] - values[i - 1];
                const gg = d > 0 ?  d : 0;
                const ll = d < 0 ? -d : 0;
                avgG = (avgG * (period - 1) + gg) / period;
                avgL = (avgL * (period - 1) + ll) / period;
                out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
            }
            return out;
        },
        _atrSeries(candles, period = 14) {
            if (candles.length < period + 1) return [];
            const trs = [];
            for (let i = 1; i < candles.length; i++) {
                const h  = candles[i].high, l = candles[i].low;
                const pc = candles[i - 1].close;
                trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            }
            // Wilder smoothing
            let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
            const out = [atr];
            for (let i = period; i < trs.length; i++) {
                atr = (atr * (period - 1) + trs[i]) / period;
                out.push(atr);
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
            const ATR = Strategy.pickIndicator(ctx, 'ATR');

            const ema50h = EMA
                ? EMA.calculate({ values: closes5, period: 50 })
                : this._emaSeries(closes5, 50);
            const ema21  = EMA
                ? EMA.calculate({ values: closes1, period: 21 })
                : this._emaSeries(closes1, 21);
            const rsi    = RSI
                ? RSI.calculate({ values: closes1, period: 14 })
                : this._rsiSeries(closes1, 14);
            const atr    = ATR
                ? ATR.calculate({
                    high:   c1m.map(c => c.high),
                    low:    c1m.map(c => c.low),
                    close:  c1m.map(c => c.close),
                    period: 14
                  })
                : this._atrSeries(c1m, 14);

            if (!ema50h.length || !ema21.length || rsi.length < 2 || !atr.length) {
                return { type: null, displayData: { Status: 'indicators not ready' } };
            }

            const price   = closes1.at(-1);
            const priceH  = closes5.at(-1);
            const htfEma  = ema50h.at(-1);
            const ltfEma  = ema21.at(-1);
            const rsiNow  = rsi.at(-1);
            const rsiPrv  = rsi.at(-2);
            const atrNow  = atr.at(-1);

            const htfTrend = priceH > htfEma ? 'Bullish'
                           : priceH < htfEma ? 'Bearish' : 'Flat';

            const dd = {
                Price:        price.toFixed(2),
                'EMA(21)/1m': ltfEma.toFixed(2),
                'EMA(50)/5m': htfEma.toFixed(2),
                'HTF Trend':  htfTrend,
                'RSI(14)':    rsiNow.toFixed(2),
                'ATR(14)':    atrNow.toFixed(2),
                Losses:       String(ctx.consecutiveLosses || 0),
            };

            // Lazy + warm-up barrier
            if (st.lastSignalEpoch == null) st.lastSignalEpoch = 0;
            const lastClosed = c1m.length >= 2 ? c1m[c1m.length - 2] : null;
            if (st.seededFromHistory == null) {
                st.seededFromHistory = true;
                st.lastClosedEpoch   = lastClosed ? lastClosed.epoch : 0;
                log('info', 'eth_edge seeded', { trend: htfTrend });
            }

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

            const prevBar = c1m[c1m.length - 3];
            const curBar  = c1m[c1m.length - 2];
            if (!prevBar || !curBar) {
                return { type: null, displayData: { ...dd, Status: 'no bars' } };
            }
            const range = curBar.high - curBar.low;
            const expansion = range > atrNow * 0.9;
            const mult = ctx.settings.martingaleMultiplier;

            // Bullish breakout: HTF bullish + RSI dip-and-rebound + range expansion
            if (htfTrend === 'Bullish' && price > ltfEma &&
                rsiPrv < 48 && rsiNow > rsiPrv && expansion &&
                curBar.close > prevBar.high) {
                st.lastSignalEpoch = now;
                log('trade', 'FIRE CALL (eth_edge bullish expansion)');
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
            // Bearish breakdown
            if (htfTrend === 'Bearish' && price < ltfEma &&
                rsiPrv > 52 && rsiNow < rsiPrv && expansion &&
                curBar.close < prevBar.low) {
                st.lastSignalEpoch = now;
                log('trade', 'FIRE PUT (eth_edge bearish expansion)');
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

            return { type: null, displayData: dd };
        }
    };

    Strategy.register(plugin);
})();
