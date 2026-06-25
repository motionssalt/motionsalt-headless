/* =====================================================================
   STRATEGY · breakout_pullback_v1   —   "Donchian Breakout + Pullback"
   ─────────────────────────────────────────────────────────────────────
   PURPOSE OF THIS FILE.  This strategy is the v3 engine's
   proof-of-correctness test case. Its trading premise is honest but
   secondary; what matters is that it exercises every feature of v3
   that the in-memory v2 engine silently broke:

     • MULTI-BAR MEMORY ACROSS CYCLES
         We compute a Donchian-style high/low over the last LOOKBACK
         closed bars. The breakout level itself depends on bars that
         closed many cycles ago.

     • ARMED/WAITING STATE ACROSS CYCLES
         When price closes above the Donchian high, we don't fire —
         we ARM a long pullback watch. The arm persists across cycles
         and survives cron gaps. We only fire on a subsequent bar that
         pulls back AND holds above the breakout level.

     • GAP-TOLERANT REPLAY
         If 5 bars closed during a 5-minute cron gap, the engine calls
         us once per bar, oldest first. We might arm on bar 1, watch
         pullback on bar 2, and confirm on bar 3 — emitting a signal
         for the bar-3 event even though "bar 3" is already in the
         past relative to the current cycle. The engine takes care of
         keeping only the most recent signal.

     • REAL-TIME (epoch-based) ARM TIMEOUT
         Arm expires after ARM_TIMEOUT_SEC of REAL seconds, computed
         from `bar.epoch - state.armedAtEpoch`. NOT from bar count.
         Cron gaps eat bar counts.

     • ENGINE-OWNED COOLDOWN
         `cooldownMs: 120000` on the plugin object — the engine handles
         it. We do not roll a manual cooldown in onClosedBar.

   TRADING IDEA (in words).  Compute the highest high and lowest low
   over the last N closed bars (Donchian channel). When a bar closes
   above the channel high, ARM for a CALL: wait for a pullback bar
   (low briefly dips toward the prior channel high) that nonetheless
   CLOSES above the prior channel high. That's the entry. Mirror for
   PUT. This is a simple breakout-retest pattern; it is NOT a tuned
   production system.

   For trading-strategy critique we'd discuss things like multi-TF
   confirmation, ATR-based filtering, etc. — out of scope here.
   ===================================================================== */

(function () {

    const LOOKBACK         = 20;      // Donchian channel length, in primary bars
    const ARM_TIMEOUT_SEC  = 600;     // 10 real-time minutes
    const MIN_BARS         = LOOKBACK + 2;
    const DURATION         = 3;       // expiration: 3 minutes (multi-cycle on 1m cron)
    const DURATION_UNIT    = 'm';

    const plugin = {
        /* ── Identity ─────────────────────────────────────────────── */
        id:       'breakout_pullback_v1',
        name:     'Donchian Breakout + Pullback',
        enabled:  false,            // turn on via config.strategies

        /* ── Timeframes ───────────────────────────────────────────── */
        primaryGranularity: '60',
        historyRequest:     { '60': Math.max(60, MIN_BARS + 5) },

        /* ── Engine-enforced policies ─────────────────────────────── */
        // 2 minutes cooldown after firing — gives the next trade
        // breathing room and (importantly) lets the pending contract
        // from the prior fire actually settle before we'd fire again.
        cooldownMs:      120000,
        maxBarsPerCycle: 20,        // hard cap on replay walk

        /* ── Pure helpers ─────────────────────────────────────────── */
        _channel(bars, lookback) {
            // High/low over the LOOKBACK bars ENDING at the bar just
            // BEFORE the current one (i.e. the channel as it would
            // have been "right before" the current bar closed). This
            // matches the classic Donchian breakout convention.
            if (bars.length < lookback + 1) return null;
            const end = bars.length - 1;          // index of current bar
            const start = end - lookback;         // exclusive on `end`
            let hi = -Infinity, lo = Infinity;
            for (let i = start; i < end; i++) {
                if (bars[i].high > hi) hi = bars[i].high;
                if (bars[i].low  < lo) lo = bars[i].low;
            }
            return { hi, lo };
        },

        /* ── Optional one-shot seed ───────────────────────────────── */
        onSeed(ctx) {
            // Nothing crucial to seed; the bar walker will compute the
            // channel from history naturally. Logging is helpful so an
            // operator can see the seed event in last-status.json.
            ctx.log('info', `seeded breakout_pullback_v1 (lookback=${LOOKBACK})`);
        },

        /* ── Monitor on no-new-bar cycles ─────────────────────────── */
        onMonitor(ctx) {
            const c = ctx.history['60'] || [];
            const last = c.at(-1);
            return {
                Price:  last ? last.close.toFixed(5) : '—',
                Armed:  ctx.state && ctx.state.armed ? String(ctx.state.armed) : '—',
                Losses: String(ctx.consecutiveLosses || 0),
            };
        },

        /* ── Core decision: ONE invocation PER NEWLY CLOSED BAR ───── */
        onClosedBar(bar, ctx) {
            const bars = ctx.history['60'];
            if (!Array.isArray(bars) || bars.length < MIN_BARS) {
                return { type: 'warmup', reason: `need ${MIN_BARS}+ bars` };
            }

            const channel = this._channel(bars, LOOKBACK);
            if (!channel) return { type: 'warmup', reason: 'channel warmup' };

            const s = ctx.state;
            if (s.armed         == null) s.armed         = false;        // false | 'CALL' | 'PUT'
            if (s.armedAtEpoch  == null) s.armedAtEpoch  = 0;
            if (s.armedLevel    == null) s.armedLevel    = 0;            // the level we broke through
            if (s.lastBreakDir  == null) s.lastBreakDir  = null;          // for displayData only

            // Build the live-monitor readout (kept fresh every bar)
            const displayData = {
                Price:        bar.close.toFixed(5),
                'Don Hi':     channel.hi.toFixed(5),
                'Don Lo':     channel.lo.toFixed(5),
                Armed:        s.armed ? s.armed : '—',
                Losses:       String(ctx.consecutiveLosses || 0),
            };

            /* ── Arm timeout (R7: real seconds via bar.epoch) ───────── */
            if (s.armed && (bar.epoch - s.armedAtEpoch) > ARM_TIMEOUT_SEC) {
                ctx.log('info', `arm expired (>${ARM_TIMEOUT_SEC}s) — was ${s.armed} @ ${s.armedLevel}`);
                s.armed = false; s.armedAtEpoch = 0; s.armedLevel = 0;
            }

            /* ── If armed, look for the retest/pullback confirmation ─ */
            if (s.armed === 'CALL') {
                // Retest pattern: bar dipped toward or below the prior
                // channel high but its CLOSE held above. That's the
                // pullback that confirms the breakout.
                const pulledBack  = bar.low <= s.armedLevel;
                const heldAbove   = bar.close > s.armedLevel;
                if (pulledBack && heldAbove) {
                    s.armed = false; s.armedAtEpoch = 0; s.armedLevel = 0;
                    ctx.log('trade',
                        `FIRE CALL @ ${bar.close.toFixed(5)} (retested ${s.armedLevel || channel.hi.toFixed(5)})`);
                    return {
                        type: 'signal',
                        contractType: 'CALL',
                        stake: Strategy.computeStake(
                            ctx.settings.baseStake,
                            ctx.consecutiveLosses,
                            ctx.settings.martingaleMultiplier),
                        duration: DURATION,
                        durationUnit: DURATION_UNIT,
                        displayData: { ...displayData, Status: 'FIRING CALL' },
                    };
                }
                // Still waiting — emit a hold so the operator sees it.
                return {
                    type: 'hold',
                    reason: `awaiting CALL retest of ${s.armedLevel.toFixed(5)}`,
                    displayData: { ...displayData, Status: 'awaiting CALL retest' },
                };
            }

            if (s.armed === 'PUT') {
                const pulledBack  = bar.high >= s.armedLevel;
                const heldBelow   = bar.close < s.armedLevel;
                if (pulledBack && heldBelow) {
                    const lvl = s.armedLevel;
                    s.armed = false; s.armedAtEpoch = 0; s.armedLevel = 0;
                    ctx.log('trade',
                        `FIRE PUT @ ${bar.close.toFixed(5)} (retested ${lvl.toFixed(5)})`);
                    return {
                        type: 'signal',
                        contractType: 'PUT',
                        stake: Strategy.computeStake(
                            ctx.settings.baseStake,
                            ctx.consecutiveLosses,
                            ctx.settings.martingaleMultiplier),
                        duration: DURATION,
                        durationUnit: DURATION_UNIT,
                        displayData: { ...displayData, Status: 'FIRING PUT' },
                    };
                }
                return {
                    type: 'hold',
                    reason: `awaiting PUT retest of ${s.armedLevel.toFixed(5)}`,
                    displayData: { ...displayData, Status: 'awaiting PUT retest' },
                };
            }

            /* ── Not armed: look for a fresh breakout to arm on ─────── */
            // We require the CLOSE to break the prior channel — the
            // close is the most stable price point of the bar.
            if (bar.close > channel.hi) {
                s.armed        = 'CALL';
                s.armedAtEpoch = bar.epoch;
                s.armedLevel   = channel.hi;
                s.lastBreakDir = 'up';
                ctx.log('signal', `arm CALL — close ${bar.close.toFixed(5)} > Don Hi ${channel.hi.toFixed(5)}`);
                return {
                    type: 'hold',
                    reason: `armed CALL above ${channel.hi.toFixed(5)}`,
                    displayData: { ...displayData, Status: 'armed CALL' },
                };
            }
            if (bar.close < channel.lo) {
                s.armed        = 'PUT';
                s.armedAtEpoch = bar.epoch;
                s.armedLevel   = channel.lo;
                s.lastBreakDir = 'down';
                ctx.log('signal', `arm PUT — close ${bar.close.toFixed(5)} < Don Lo ${channel.lo.toFixed(5)}`);
                return {
                    type: 'hold',
                    reason: `armed PUT below ${channel.lo.toFixed(5)}`,
                    displayData: { ...displayData, Status: 'armed PUT' },
                };
            }

            // Inside the channel, not armed — just keep the monitor alive.
            return { type: null, displayData: { ...displayData, Status: 'scanning' } };
        },
    };

    Strategy.register(plugin);

})();
