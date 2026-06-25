/* =====================================================================
   STRATEGY · TEMPLATE  (v3 contract)   —   "Rename Me"
   ─────────────────────────────────────────────────────────────────────
   Copy this file, rename, and edit the marked sections. The full
   contract is in `js/strategies/STRATEGY_SPEC.md`. The example
   strategy in `breakout_pullback_v1.js` is worth reading too.

   This template is NOT registered: filename starts with "_" so the
   discovery loader skips it.
   ===================================================================== */
(function () {

    const plugin = {
        /* ===== Identity ============================================== */
        id:       'template_v1',           // ^[a-z0-9_]+$, unique
        name:     'Template Strategy',     // shown in UI
        enabled:  false,                   // default toggle

        /* ===== Timeframes ============================================
           primaryGranularity is the one onClosedBar will be invoked on.
           historyRequest must include it AND any other gran you read. */
        primaryGranularity: '60',          // 1-minute bars
        historyRequest:     { '60': 100 }, // ask for 100 × 1m candles

        /* ===== Engine-enforced cooldown & safety ==================== */
        cooldownMs:       60000,           // 1 minute since last signal
        maxBarsPerCycle:  50,              // cap on replay walk size

        /* ===== Optional helpers (prefix _ by convention) ============ */
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

        /* ===== Optional onSeed: runs ONCE EVER ====================== */
        // Called the first cycle this (strategy × symbol) is seen, so you
        // can prime any history-derived state. NEVER returns a decision.
        onSeed(ctx) {
            // Example: precompute a baseline price from the last 60 bars.
            const c = ctx.history['60'] || [];
            if (c.length >= 60) {
                ctx.state.baselineClose = c[c.length - 1].close;
            }
        },

        /* ===== Optional onMonitor: displayData on no-bar cycles ===== */
        // Called when no new bars closed this cycle so the Live Monitor
        // still has something to render. Return a flat key/value object.
        onMonitor(ctx) {
            const c = ctx.history[this.primaryGranularity] || [];
            const last = c.at(-1);
            return {
                Price:  last ? last.close.toFixed(5) : '—',
                Losses: String(ctx.consecutiveLosses || 0),
            };
        },

        /* ===== REQUIRED: onClosedBar(bar, ctx) ======================
           Called once per newly closed bar, oldest first. `bar` is the
           bar that just closed; `ctx.history[primaryGranularity].at(-1)`
           is the same bar. There is no future-leak. */
        onClosedBar(bar, ctx) {
            const c = ctx.history['60'];
            const closes = c.map(x => x.close);

            // ── Length guard (R5) ────────────────────────────────────
            if (closes.length < 30) {
                return { type: 'warmup', reason: 'need 30+ bars' };
            }

            // ── Indicator with fallback (R4) ─────────────────────────
            const RSI = Strategy.pickIndicator(ctx, 'RSI');
            const rsiSeries = RSI
                ? RSI.calculate({ values: closes, period: 14 })
                : this._customRSI(closes, 14);
            if (rsiSeries.length < 2) {
                return { type: 'warmup', reason: 'rsi warming up' };
            }
            const rsi    = rsiSeries[rsiSeries.length - 1];
            const rsiPrv = rsiSeries[rsiSeries.length - 2];

            // ── Lazy-init persistent state (R2) ──────────────────────
            const s = ctx.state;
            if (s.armed       == null) s.armed       = false;
            if (s.armedAtEpoch == null) s.armedAtEpoch = 0;

            // ── Live monitor readout (R6/R8 compliant) ───────────────
            const displayData = {
                Price:     bar.close.toFixed(5),
                'RSI(14)': rsi.toFixed(2),
                Armed:     s.armed ? String(s.armed) : '—',
                Losses:    String(ctx.consecutiveLosses || 0),
            };

            /* ===== YOUR LOGIC HERE ===================================
               Replace the example below.

               Example (replace me): arm CALL on RSI dip <28; expire arm
               after 180 real seconds; fire on RSI cross back above 30. */

            // Arm
            if (!s.armed && rsi < 28 && rsiPrv >= 28) {
                s.armed = 'CALL';
                s.armedAtEpoch = bar.epoch;
                ctx.log('signal', `arm CALL @ RSI ${rsi.toFixed(1)}`);
                return {
                    type: 'hold',
                    reason: `armed CALL (RSI ${rsi.toFixed(1)})`,
                    displayData: { ...displayData, Status: 'armed CALL' },
                };
            }

            // Arm timeout (R7: REAL seconds via bar.epoch — never bar count)
            if (s.armed && (bar.epoch - s.armedAtEpoch) > 180) {
                ctx.log('info', 'arm expired (>180s)');
                s.armed = false;
                s.armedAtEpoch = 0;
            }

            // Confirm -> fire
            if (s.armed === 'CALL' && rsi > 30 && rsiPrv <= 30) {
                s.armed = false;
                s.armedAtEpoch = 0;
                ctx.log('trade', `FIRE CALL (RSI cross up ${rsiPrv.toFixed(1)}→${rsi.toFixed(1)})`);
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

            // No decision — but keep the monitor alive.
            return { type: null, displayData };
        }
    };

    /* Uncomment ONLY after you've renamed `id` and `name` and saved the
       file as something OTHER than `_template.js`.                    */
    // Strategy.register(plugin);

})();
