/* =====================================================================
   STRATEGY · Hexa Reversal  (v3 contract)   —   2-minute timeframe
   ─────────────────────────────────────────────────────────────────────
   Implements "The Hexa Reversal Strategy" (Hexa_Reversal_Strategy.pdf):

   Core premise
   ------------
   1. Observe the most recent block of 6 fully-closed candles on the
      primary granularity (2-minute bars here).
   2. Reject if the block is "monochrome" (all 6 green or all 6 red).
      A valid block MUST contain at least one bullish AND one bearish
      candle.
   3. Build an inverted directional plan of length 6:
        bullish (close > open)  →  PUT  signal
        bearish (close < open)  →  CALL signal
        doji   (close == open)  →  PUT  (default; PDF is silent on this)
   4. Trade the 6 inverted directions IN ORDER, one trade per new bar,
      each with duration matching the chart timeframe (2 minutes here).
   5. Stop on the FIRST WIN in the sequence — that single win recovers
      all cumulative losses in the cycle and locks in baseline profit.
   6. If all 6 steps lose, the cycle is "fully lost". Either way, after
      the cycle ends the strategy returns to IDLE and must wait for a
      completely fresh 6-bar block to form (i.e. 6 new bars must close
      after the cycle-end epoch) before considering a new pattern.

   Martingale
   ----------
   Step sizing is delegated to the engine via Strategy.computeStake(),
   which uses ctx.settings.baseStake, ctx.consecutiveLosses, and
   ctx.settings.martingaleMultiplier. This is mandated by R3 of the
   v3 spec; it also lets the operator tune the geometric progression
   to their broker's payout instead of hard-coding $1 / $2.50 / $6 / ...

   Timeframe
   ---------
   primaryGranularity = '120' (2 minutes). Trade duration = 2m.
   The PDF rule "chart timeframe must equal expiration" is honoured.
   ===================================================================== */
(function () {

    const plugin = {
        /* ===== Identity ============================================== */
        id:       'hexa_reversal_v1',
        name:     'Hexa Reversal (2m)',
        enabled:  false,

        /* ===== Timeframes ============================================ */
        primaryGranularity: '120',           // 2-minute bars
        historyRequest:     { '120': 100 },  // need ≥ 6; ask for 100 for safety

        /* ===== Engine-enforced cooldown & safety ===================== */
        // Bars are 120 s apart; a 60 s cooldown comfortably allows one
        // fire per closed bar without ever blocking a legitimate step
        // transition inside a sequence.
        cooldownMs:       60000,
        maxBarsPerCycle:  50,

        /* ===== Constants ============================================= */
        _BLOCK_SIZE:   6,         // candles in the observed block
        _MAX_STEPS:    6,         // matches block size — 6-step martingale
        _BAR_SECONDS:  120,       // primaryGranularity in seconds

        /* ===== Helpers =============================================== */
        // Classify a candle: +1 bullish, -1 bearish, 0 doji.
        _candleSign(c) {
            if (c.close > c.open) return  1;
            if (c.close < c.open) return -1;
            return 0;
        },

        // Invert a candle into its trade direction per the Hexa rule.
        // bullish → PUT, bearish → CALL, doji → PUT (sensible default).
        _invert(c) {
            return (c.close < c.open) ? 'CALL' : 'PUT';
        },

        // Build the 6-direction plan from a 6-bar block. Returns null
        // if the block is monochrome (hard reject from the PDF).
        _buildPlan(block) {
            let bulls = 0, bears = 0;
            for (const c of block) {
                const s = this._candleSign(c);
                if (s > 0) bulls++;
                else if (s < 0) bears++;
            }
            if (bulls === 0 || bears === 0) return null; // monochrome
            return block.map(c => this._invert(c));
        },

        // Pretty-print a plan as e.g. "P,C,P,P,C,C" with a cursor marker.
        _planString(plan, step) {
            if (!Array.isArray(plan)) return '—';
            return plan
                .map((d, i) => {
                    const ch = d === 'CALL' ? 'C' : 'P';
                    return i === step ? `[${ch}]` : ch;
                })
                .join(',');
        },

        /* ===== onSeed: prime on the very first cycle ================= */
        // Nothing history-derived to seed; just establish phase = IDLE
        // and a virgin cycleEndedAtEpoch (0 = no prior cycle).
        onSeed(ctx) {
            const s = ctx.state;
            if (s.phase             == null) s.phase             = 'IDLE';
            if (s.plan              == null) s.plan              = null;
            if (s.step              == null) s.step              = 0;
            if (s.inFlight          == null) s.inFlight          = false;
            if (s.lossesBeforeFire  == null) s.lossesBeforeFire  = 0;
            if (s.cycleEndedAtEpoch == null) s.cycleEndedAtEpoch = 0;
            if (s.armedAtEpoch      == null) s.armedAtEpoch      = 0;
            if (s.cyclesWon         == null) s.cyclesWon         = 0;
            if (s.cyclesLost        == null) s.cyclesLost        = 0;
            ctx.log('info', 'hexa_reversal seeded, phase=IDLE');
        },

        /* ===== onMonitor: no-bar-this-cycle readout ================== */
        onMonitor(ctx) {
            const c    = ctx.history[this.primaryGranularity] || [];
            const last = c.at(-1);
            const s    = ctx.state || {};
            return {
                Price:  last ? last.close.toFixed(5) : '—',
                Phase:  s.phase || 'IDLE',
                Step:   String((s.step ?? 0) + 1) + '/' + this._MAX_STEPS,
                Plan:   this._planString(s.plan, s.step ?? 0),
                Losses: String(ctx.consecutiveLosses || 0),
                Won:    String(s.cyclesWon  || 0),
                Lost:   String(s.cyclesLost || 0),
            };
        },

        /* ===== REQUIRED: onClosedBar ================================= */
        onClosedBar(bar, ctx) {
            const gran = this.primaryGranularity;
            const c    = ctx.history[gran] || [];

            // ── Length guard (R5) ────────────────────────────────────
            if (c.length < this._BLOCK_SIZE) {
                return {
                    type: 'warmup',
                    reason: `need ${this._BLOCK_SIZE}+ bars (have ${c.length})`,
                };
            }

            // ── Lazy-init persistent state (R2) ──────────────────────
            const s = ctx.state;
            if (s.phase             == null) s.phase             = 'IDLE';
            if (s.plan              == null) s.plan              = null;
            if (s.step              == null) s.step              = 0;
            if (s.inFlight          == null) s.inFlight          = false;
            if (s.lossesBeforeFire  == null) s.lossesBeforeFire  = 0;
            if (s.cycleEndedAtEpoch == null) s.cycleEndedAtEpoch = 0;
            if (s.armedAtEpoch      == null) s.armedAtEpoch      = 0;
            if (s.cyclesWon         == null) s.cyclesWon         = 0;
            if (s.cyclesLost        == null) s.cyclesLost        = 0;

            // ── Common displayData ──────────────────────────────────
            const buildDisplay = (extra) => ({
                Price:   bar.close.toFixed(5),
                Phase:   s.phase,
                Step:    String((s.step ?? 0) + 1) + '/' + this._MAX_STEPS,
                Plan:    this._planString(s.plan, s.step ?? 0),
                Losses:  String(ctx.consecutiveLosses || 0),
                Won:     String(s.cyclesWon  || 0),
                Lost:    String(s.cyclesLost || 0),
                ...(extra || {}),
            });

            /* =========================================================
               BRANCH A — we are inside a sequence and a step was fired
               last bar. Resolve win/loss before doing anything else.
               ========================================================= */
            if (s.phase === 'IN_SEQUENCE' && s.inFlight) {
                // Engine still reports an open trade → contract hasn't
                // settled yet. Wait one more bar.
                if (ctx.hasOpenTrade) {
                    return {
                        type: 'hold',
                        reason: `step ${s.step + 1} in flight, awaiting settlement`,
                        displayData: buildDisplay({ Status: 'AWAITING SETTLEMENT' }),
                    };
                }

                // No open trade → most recent step has settled. Compare
                // the loss streak now vs. the snapshot we took right
                // before firing. A growth ⇒ loss. Anything else ⇒ win
                // (the engine resets the streak on a win).
                const lossesNow = ctx.consecutiveLosses || 0;
                const wasLoss   = lossesNow > (s.lossesBeforeFire || 0);
                s.inFlight = false;

                if (!wasLoss) {
                    // WIN — cycle ends immediately per PDF rules.
                    ctx.log('trade',
                        `cycle WIN at step ${s.step + 1}/${this._MAX_STEPS} ` +
                        `(plan ${this._planString(s.plan, s.step)})`);
                    s.cyclesWon         = (s.cyclesWon || 0) + 1;
                    s.cycleEndedAtEpoch = bar.epoch;
                    s.phase             = 'IDLE';
                    s.plan              = null;
                    s.step              = 0;
                    s.armedAtEpoch      = 0;
                    return {
                        type: 'hold',
                        reason: 'cycle complete (WIN) — waiting for fresh 6-bar block',
                        displayData: buildDisplay({
                            Phase:  'IDLE',
                            Status: 'CYCLE WIN — cooldown',
                        }),
                    };
                }

                // LOSS — advance to next step.
                s.step++;
                ctx.log('info',
                    `step lost, advancing to step ${s.step + 1}/${this._MAX_STEPS}`);

                if (s.step >= this._MAX_STEPS) {
                    // All 6 steps lost — cycle "fully lost".
                    ctx.log('warn',
                        `cycle EXHAUSTED — all ${this._MAX_STEPS} steps lost ` +
                        `(plan ${this._planString(s.plan, this._MAX_STEPS - 1)})`);
                    s.cyclesLost        = (s.cyclesLost || 0) + 1;
                    s.cycleEndedAtEpoch = bar.epoch;
                    s.phase             = 'IDLE';
                    s.plan              = null;
                    s.step              = 0;
                    s.armedAtEpoch      = 0;
                    return {
                        type: 'hold',
                        reason: 'cycle complete (FULL LOSS) — waiting for fresh 6-bar block',
                        displayData: buildDisplay({
                            Phase:  'IDLE',
                            Status: 'CYCLE LOST — cooldown',
                        }),
                    };
                }
                // Otherwise fall through to firing the next step below.
            }

            /* =========================================================
               BRANCH B — we are IDLE. Look for a fresh, valid 6-bar
               block to arm a new sequence.
               ========================================================= */
            if (s.phase === 'IDLE') {
                // Enforce "wait for an entirely new 6-candle block":
                // require at least 6 × bar-seconds to have elapsed since
                // the prior cycle ended. (0 means no prior cycle.)
                if (s.cycleEndedAtEpoch > 0) {
                    const minGap = this._BLOCK_SIZE * this._BAR_SECONDS;
                    const gap    = bar.epoch - s.cycleEndedAtEpoch;
                    if (gap < minGap) {
                        return {
                            type: 'hold',
                            reason:
                                `awaiting fresh block (${gap}s of ${minGap}s elapsed)`,
                            displayData: buildDisplay({
                                Status: `WAIT NEW BLOCK ${gap}/${minGap}s`,
                            }),
                        };
                    }
                }

                // Inspect the most recent 6 fully-closed bars. The bar
                // currently being processed IS one of them (the newest).
                const block = c.slice(-this._BLOCK_SIZE);
                if (block.length < this._BLOCK_SIZE) {
                    return {
                        type: 'warmup',
                        reason: 'insufficient block size after slice',
                        displayData: buildDisplay({ Status: 'warmup' }),
                    };
                }

                const plan = this._buildPlan(block);
                if (!plan) {
                    // Monochrome block — hard reject. Stay idle and wait
                    // for the next closed bar to reshape the window.
                    return {
                        type: null,
                        displayData: buildDisplay({
                            Status: 'monochrome block — rejected',
                        }),
                    };
                }

                // Arm a new sequence at step 0 and proceed to fire below.
                s.phase         = 'IN_SEQUENCE';
                s.plan          = plan;
                s.step          = 0;
                s.armedAtEpoch  = bar.epoch;
                s.inFlight      = false;
                ctx.log('signal',
                    `arm sequence — plan ${plan.join(',')} ` +
                    `(observed colors ${block.map(b =>
                        b.close > b.open ? 'G' :
                        b.close < b.open ? 'R' : 'D').join('')})`);
                // Fall through to firing step 0.
            }

            /* =========================================================
               BRANCH C — fire the current step of the active sequence.
               ========================================================= */
            if (s.phase !== 'IN_SEQUENCE' || !Array.isArray(s.plan)
                || s.step < 0 || s.step >= this._MAX_STEPS) {
                // Should never happen; bail cleanly per R10.
                return {
                    type: null,
                    displayData: buildDisplay({ Status: 'inconsistent state — bailing' }),
                };
            }

            // Defensive: the engine suppresses signals while a trade is
            // open for this (strategy, symbol). If somehow still open,
            // hold rather than fire.
            if (ctx.hasOpenTrade) {
                return {
                    type: 'hold',
                    reason: 'open trade present — cannot fire yet',
                    displayData: buildDisplay({ Status: 'BLOCKED (open trade)' }),
                };
            }

            const direction = s.plan[s.step];
            if (direction !== 'CALL' && direction !== 'PUT') {
                ctx.log('error', `invalid plan direction at step ${s.step}: ${direction}`);
                // Bail cleanly without throwing.
                s.phase             = 'IDLE';
                s.plan              = null;
                s.step              = 0;
                s.inFlight          = false;
                s.cycleEndedAtEpoch = bar.epoch;
                return {
                    type: null,
                    displayData: buildDisplay({ Status: 'plan error — reset' }),
                };
            }

            // Snapshot loss streak BEFORE firing so we can resolve the
            // win/loss outcome on the next bar by comparing deltas.
            s.lossesBeforeFire = ctx.consecutiveLosses || 0;
            s.inFlight         = true;

            const stake = Strategy.computeStake(
                ctx.settings.baseStake,
                ctx.consecutiveLosses,
                ctx.settings.martingaleMultiplier);

            ctx.log('trade',
                `FIRE ${direction} step ${s.step + 1}/${this._MAX_STEPS} ` +
                `stake=${stake} plan=${this._planString(s.plan, s.step)}`);

            return {
                type:         'signal',
                contractType: direction,
                stake,
                duration:     2,            // 2 minutes — matches the 2m chart
                durationUnit: 'm',
                displayData:  buildDisplay({
                    Status: `FIRE ${direction} step ${s.step + 1}/${this._MAX_STEPS}`,
                }),
            };
        },
    };

    Strategy.register(plugin);

})();
