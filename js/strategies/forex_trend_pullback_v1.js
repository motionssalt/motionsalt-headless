/* =====================================================================
   STRATEGY · FOREX TREND PULLBACK  (v3 contract)
   ─────────────────────────────────────────────────────────────────────
   Idea:
     • Higher timeframe (15m) EMA(50) defines trend direction.
     • Lower timeframe (5m) RSI(14) finds pullbacks against that trend.
     • Arm on a pullback into oversold/overbought, fire when RSI
       crosses back out — i.e. the pullback has exhausted and price
       is resuming with the trend.
     • 15-minute expiry (3 × 5m bars) suits forex intraday rhythm.

   Forex-only via contractSymbols whitelist.
   ===================================================================== */
(function () {

    const plugin = {
        /* ===== Identity ============================================== */
        id:       'forex_trend_pullback_v1',
        name:     'Forex Trend Pullback (15m)',
        enabled:  false,

        /* ===== Timeframes ============================================
           Primary = 5-minute bars (decision granularity).
           Secondary = 15-minute bars (trend filter).
           Both must appear in historyRequest. */
        primaryGranularity: '300',                       // 5m
        historyRequest:     { '300': 200, '900': 120 },  // 5m + 15m

        /* ===== Engine-enforced cooldown & safety ====================
           15-minute cooldown so we never overlap a 15m contract. */
        cooldownMs:       15 * 60 * 1000,
        maxBarsPerCycle:  50,

        /* ===== Forex pairs only ===================================== */
        contractSymbols: [
            'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD',
            'frxUSDCAD', 'frxUSDCHF', 'frxNZDUSD',
            'frxEURJPY', 'frxEURGBP', 'frxGBPJPY',
        ],

        /* ===== Helpers (prefixed _ by convention) =================== */
        _customEMA(values, period) {
            if (!Array.isArray(values) || values.length < period) return [];
            const k = 2 / (period + 1);
            const out = [];
            // seed with SMA of first `period` values
            let sum = 0;
            for (let i = 0; i < period; i++) sum += values[i];
            let ema = sum / period;
            out.push(ema);
            for (let i = period; i < values.length; i++) {
                ema = (values[i] - ema) * k + ema;
                out.push(ema);
            }
            return out;
        },

        _customRSI(values, period = 14) {
            if (!Array.isArray(values) || values.length < period + 1) return [];
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
                const gain = d > 0 ? d : 0;
                const loss = d < 0 ? -d : 0;
                avgGain = (avgGain * (period - 1) + gain) / period;
                avgLoss = (avgLoss * (period - 1) + loss) / period;
                out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
            }
            return out;
        },

        /* ===== onMonitor: keep the card alive on quiet cycles ======= */
        onMonitor(ctx) {
            const c = ctx.history['300'] || [];
            const last = c.at(-1);
            const s = ctx.state || {};
            return {
                Price:  last ? last.close.toFixed(5) : '—',
                Armed:  s.armed ? String(s.armed) : '—',
                Losses: String(ctx.consecutiveLosses || 0),
            };
        },

        /* ===== REQUIRED: onClosedBar(bar, ctx) ====================== */
        onClosedBar(bar, ctx) {
            try {
                const c5  = ctx.history['300'] || [];
                const c15 = ctx.history['900'] || [];

                // ── Length guard (R5) ────────────────────────────────
                if (c5.length < 30 || c15.length < 55) {
                    return { type: 'warmup', reason: 'need 30×5m + 55×15m bars' };
                }

                const closes5  = c5.map(x => x.close);
                const closes15 = c15.map(x => x.close);

                // ── 15m trend filter (EMA 50) ────────────────────────
                const EMA = Strategy.pickIndicator(ctx, 'EMA');
                const ema15Series = EMA
                    ? EMA.calculate({ values: closes15, period: 50 })
                    : this._customEMA(closes15, 50);
                if (ema15Series.length < 3) {
                    return { type: 'warmup', reason: 'ema warming up' };
                }
                const ema15Now  = ema15Series[ema15Series.length - 1];
                const ema15Prev = ema15Series[ema15Series.length - 3]; // 2-bar slope
                const last15Close = closes15[closes15.length - 1];

                // Trend direction: only trade WITH the trend
                const trendUp   = (ema15Now > ema15Prev) && (last15Close > ema15Now);
                const trendDown = (ema15Now < ema15Prev) && (last15Close < ema15Now);

                // ── 5m momentum (RSI 14) ─────────────────────────────
                const RSI = Strategy.pickIndicator(ctx, 'RSI');
                const rsiSeries = RSI
                    ? RSI.calculate({ values: closes5, period: 14 })
                    : this._customRSI(closes5, 14);
                if (rsiSeries.length < 2) {
                    return { type: 'warmup', reason: 'rsi warming up' };
                }
                const rsi    = rsiSeries[rsiSeries.length - 1];
                const rsiPrv = rsiSeries[rsiSeries.length - 2];

                // ── Lazy-init persistent state (R2) ──────────────────
                const s = ctx.state;
                if (s.armed        == null) s.armed        = false; // false | 'CALL' | 'PUT'
                if (s.armedAtEpoch == null) s.armedAtEpoch = 0;
                if (s.armedRsi     == null) s.armedRsi     = 0;

                // ── Display readout ──────────────────────────────────
                const trendLabel = trendUp ? 'UP' : (trendDown ? 'DOWN' : 'flat');
                const displayData = {
                    Price:       bar.close.toFixed(5),
                    'EMA50(15m)': ema15Now.toFixed(5),
                    Trend:        trendLabel,
                    'RSI(5m)':    rsi.toFixed(2),
                    Armed:        s.armed ? String(s.armed) : '—',
                    Losses:       String(ctx.consecutiveLosses || 0),
                };

                /* ── Arm timeout: 15 real minutes (R7) ───────────────
                   Use seconds via bar.epoch, NEVER bar count. */
                const ARM_TIMEOUT_SEC = 15 * 60;
                if (s.armed && (bar.epoch - s.armedAtEpoch) > ARM_TIMEOUT_SEC) {
                    ctx.log('info', `arm ${s.armed} expired (>${ARM_TIMEOUT_SEC}s)`);
                    s.armed = false;
                    s.armedAtEpoch = 0;
                    s.armedRsi = 0;
                }

                /* ── Disarm if trend flipped against us ─────────────── */
                if (s.armed === 'CALL' && !trendUp) {
                    ctx.log('info', 'arm CALL cancelled — trend lost');
                    s.armed = false; s.armedAtEpoch = 0; s.armedRsi = 0;
                }
                if (s.armed === 'PUT' && !trendDown) {
                    ctx.log('info', 'arm PUT cancelled — trend lost');
                    s.armed = false; s.armedAtEpoch = 0; s.armedRsi = 0;
                }

                /* ── ARM CALL: uptrend pullback into oversold ──────── */
                if (!s.armed && trendUp && rsi < 35 && rsiPrv >= 35) {
                    s.armed = 'CALL';
                    s.armedAtEpoch = bar.epoch;
                    s.armedRsi = rsi;
                    ctx.log('signal', `arm CALL @ RSI ${rsi.toFixed(1)} (uptrend pullback)`);
                    return {
                        type: 'hold',
                        reason: `armed CALL (RSI dip ${rsi.toFixed(1)} in uptrend)`,
                        displayData: { ...displayData, Status: 'armed CALL' },
                    };
                }

                /* ── ARM PUT: downtrend pullback into overbought ───── */
                if (!s.armed && trendDown && rsi > 65 && rsiPrv <= 65) {
                    s.armed = 'PUT';
                    s.armedAtEpoch = bar.epoch;
                    s.armedRsi = rsi;
                    ctx.log('signal', `arm PUT @ RSI ${rsi.toFixed(1)} (downtrend pullback)`);
                    return {
                        type: 'hold',
                        reason: `armed PUT (RSI pop ${rsi.toFixed(1)} in downtrend)`,
                        displayData: { ...displayData, Status: 'armed PUT' },
                    };
                }

                /* ── CONFIRM CALL: RSI crosses back up through 40 ──── */
                if (s.armed === 'CALL' && trendUp && rsi > 40 && rsiPrv <= 40) {
                    const stake = Strategy.computeStake(
                        ctx.settings.baseStake,
                        ctx.consecutiveLosses,
                        ctx.settings.martingaleMultiplier);
                    ctx.log('trade',
                        `FIRE CALL — RSI ${rsiPrv.toFixed(1)}→${rsi.toFixed(1)}, ` +
                        `EMA15 ${ema15Now.toFixed(5)}, stake ${stake}`);
                    s.armed = false; s.armedAtEpoch = 0; s.armedRsi = 0;
                    return {
                        type: 'signal',
                        contractType: 'CALL',
                        stake,
                        duration: 15,
                        durationUnit: 'm',
                        displayData: { ...displayData, Status: 'FIRING CALL' },
                    };
                }

                /* ── CONFIRM PUT: RSI crosses back down through 60 ─── */
                if (s.armed === 'PUT' && trendDown && rsi < 60 && rsiPrv >= 60) {
                    const stake = Strategy.computeStake(
                        ctx.settings.baseStake,
                        ctx.consecutiveLosses,
                        ctx.settings.martingaleMultiplier);
                    ctx.log('trade',
                        `FIRE PUT — RSI ${rsiPrv.toFixed(1)}→${rsi.toFixed(1)}, ` +
                        `EMA15 ${ema15Now.toFixed(5)}, stake ${stake}`);
                    s.armed = false; s.armedAtEpoch = 0; s.armedRsi = 0;
                    return {
                        type: 'signal',
                        contractType: 'PUT',
                        stake,
                        duration: 15,
                        durationUnit: 'm',
                        displayData: { ...displayData, Status: 'FIRING PUT' },
                    };
                }

                /* ── No decision — keep monitor alive ──────────────── */
                return { type: null, displayData };

            } catch (err) {
                // R10: never throw
                ctx.log('error', `unexpected: ${err && err.message ? err.message : err}`);
                return { type: null, displayData: { Status: 'error — bailed' } };
            }
        },
    };

    Strategy.register(plugin);

})();
