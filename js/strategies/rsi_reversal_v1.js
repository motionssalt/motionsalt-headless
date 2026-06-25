/* =====================================================================
   STRATEGY · rsi_reversal_v1   —   "RSI Reversal"
   ─────────────────────────────────────────────────────────────────────
   Waits for RSI(14) on the 1-minute chart to enter OB/OS, then fires
   a HOLD pre-signal and a SIGNAL on reversal confirmation.

   Uses ctx.indicators.RSI when available, otherwise falls back to an
   internal Wilder-smoothed RSI implementation so the strategy still
   works if the CDN script failed to load.

   See `js/strategies/STRATEGY_SPEC.md` for the full authoring contract.
   ===================================================================== */
(function () {

    const rsiReversal = {
        id:       'rsi_reversal_v1',
        name:     'RSI Reversal',
        enabled:  true,
        historyRequest: { '60': 100 }, // 100 × 1-minute candles

        /* ---- Custom fallback RSI (Wilder smoothing) ----------------- */
        _customRSI(values, period = 14) {
            if (!Array.isArray(values) || values.length < period + 1) return [];
            let gainSum = 0, lossSum = 0;
            for (let i = 1; i <= period; i++) {
                const diff = values[i] - values[i - 1];
                if (diff >= 0) gainSum += diff; else lossSum -= diff;
            }
            let avgGain = gainSum / period;
            let avgLoss = lossSum / period;
            const out = [];
            out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
            for (let i = period + 1; i < values.length; i++) {
                const diff = values[i] - values[i - 1];
                const gain = diff > 0 ? diff : 0;
                const loss = diff < 0 ? -diff : 0;
                avgGain = (avgGain * (period - 1) + gain) / period;
                avgLoss = (avgLoss * (period - 1) + loss) / period;
                out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
            }
            return out;
        },

        onTick(ctx) {
            const candles = ctx.history['60'] || [];
            const closes  = candles.map(c => c.close);
            const log     = ctx.log || function(){};

            if (closes.length < 20) {
                return { type: null, displayData: { Status: 'warming up' } };
            }

            // Prefer the library; fall back to custom math transparently.
            const RSI = Strategy.pickIndicator(ctx, 'RSI');
            const rsiSeries = RSI
                ? RSI.calculate({ values: closes, period: 14 })
                : this._customRSI(closes, 14);
            const rsiSource = RSI ? 'TI' : 'custom';

            if (rsiSeries.length < 2) {
                return { type: null, displayData: { Status: 'warming up' } };
            }

            const rsi    = rsiSeries[rsiSeries.length - 1];
            const rsiPrv = rsiSeries[rsiSeries.length - 2] ?? rsi;

            // Identify the LAST CLOSED bar (not the forming one).
            const lastClosed = candles.length >= 2 ? candles[candles.length - 2] : null;

            const st  = ctx.state;
            const now = ctx.tick.epoch;
            if (st.lastSignalEpoch == null) st.lastSignalEpoch = 0;
            if (st.lastHoldEpoch == null)   st.lastHoldEpoch   = 0;
            if (st.holdArmed == null)       st.holdArmed       = false;

            /* WARM-UP BARRIER (R7) — seed from history on the very first
               tick so a pre-session RSI cross can never be mistaken for
               a live one. */
            if (st.seededFromHistory == null) {
                st.seededFromHistory = true;
                st.lastClosedEpoch   = lastClosed ? lastClosed.epoch : 0;
                st.lastRsi           = rsiPrv;
                log('info', 'seeded from history', {
                    rsi: rsi.toFixed(2), prv: rsiPrv.toFixed(2),
                    lastClosed: lastClosed ? lastClosed.epoch : null
                });
            }

            // Build a live-monitor readout for EVERY tick
            const displayData = {
                'RSI(14)':  rsi.toFixed(2),
                Source:     rsiSource,
                Zone:       rsi < 30 ? 'Oversold'
                          : rsi > 70 ? 'Overbought'
                          : 'Neutral',
                Armed:      st.holdArmed ? st.holdArmed : '—',
                Losses:     String(ctx.consecutiveLosses || 0)
            };

            // Bail AFTER building displayData so the monitor stays live
            if (ctx.hasOpenTrade) {
                return { type: null, displayData: { ...displayData, Status: 'trade open' } };
            }
            if (now - st.lastSignalEpoch < 45) {
                return { type: null, displayData: { ...displayData, Status: 'cooldown' } };
            }
            // Reject pre-session bars
            if (ctx.sessionEpoch && lastClosed && lastClosed.epoch <= ctx.sessionEpoch) {
                return { type: null, displayData: { ...displayData, Status: 'pre-session bar' } };
            }
            // Once-per-closed-bar decision gate (R8).
            if (lastClosed && st.lastClosedEpoch === lastClosed.epoch) {
                if (st.holdArmed && (now - st.lastHoldEpoch) > 180) {
                    log('info', 'hold disarm (timeout)');
                    st.holdArmed = false;
                }
                return { type: null, displayData: { ...displayData, Status: 'awaiting new bar' } };
            }
            if (lastClosed) st.lastClosedEpoch = lastClosed.epoch;

            // HOLD pre-signal
            if (!st.holdArmed) {
                if (rsi < 32 && rsiPrv >= 32) {
                    st.holdArmed = 'CALL';
                    st.lastHoldEpoch = now;
                    log('signal', `HOLD arm CALL (RSI ${rsi.toFixed(1)})`, { prv: rsiPrv.toFixed(1) });
                    return {
                        type: 'hold',
                        reason: `RSI dipping (${rsi.toFixed(1)}) — watching RISE setup`,
                        displayData
                    };
                }
                if (rsi > 68 && rsiPrv <= 68) {
                    st.holdArmed = 'PUT';
                    st.lastHoldEpoch = now;
                    log('signal', `HOLD arm PUT (RSI ${rsi.toFixed(1)})`, { prv: rsiPrv.toFixed(1) });
                    return {
                        type: 'hold',
                        reason: `RSI spiking (${rsi.toFixed(1)}) — watching FALL setup`,
                        displayData
                    };
                }
            }

            const STRATEGY_DURATION = 1;
            const STRATEGY_DURATION_UNIT = 'm';
            const mult = ctx.settings.martingaleMultiplier;

            if (st.holdArmed === 'CALL' && rsi > 30 && rsiPrv <= 30) {
                st.holdArmed = false;
                st.lastSignalEpoch = now;
                log('trade', `FIRE CALL (RSI ${rsi.toFixed(1)})`);
                return {
                    type: 'signal',
                    contractType: 'CALL',
                    stake: Strategy.computeStake(ctx.settings.baseStake, ctx.consecutiveLosses, mult),
                    duration: STRATEGY_DURATION,
                    durationUnit: STRATEGY_DURATION_UNIT,
                    displayData: { ...displayData, Status: 'FIRING CALL' }
                };
            }
            if (st.holdArmed === 'PUT' && rsi < 70 && rsiPrv >= 70) {
                st.holdArmed = false;
                st.lastSignalEpoch = now;
                log('trade', `FIRE PUT (RSI ${rsi.toFixed(1)})`);
                return {
                    type: 'signal',
                    contractType: 'PUT',
                    stake: Strategy.computeStake(ctx.settings.baseStake, ctx.consecutiveLosses, mult),
                    duration: STRATEGY_DURATION,
                    durationUnit: STRATEGY_DURATION_UNIT,
                    displayData: { ...displayData, Status: 'FIRING PUT' }
                };
            }

            // Expire stale arm after 3 minutes
            if (st.holdArmed && (now - st.lastHoldEpoch) > 180) {
                log('info', 'hold expire (timeout)');
                st.holdArmed = false;
            }

            st.lastRsi = rsi;
            return { type: null, displayData };
        }
    };

    Strategy.register(rsiReversal);
})();
