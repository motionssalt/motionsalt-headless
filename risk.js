/* =====================================================================
   MOTIONSALT — pluggable risk manager
   ─────────────────────────────────────────────────────────────────────
   Single public entry point:

     computeStake(mode, balance, signal, state, config) → number

   Modes:
     fixed          → always config.risk.fixed_stake
     fractional     → balance × fractional_pct%, capped at max_stake
     antimartingale → grow after WIN, reset after LOSS
     martingale     → grow after LOSS, reset after WIN
                      (capped at martingale_max_steps)
     confidence     → fixed_stake × signal.confidence  (0–1)

   Global enforcement (always):
     • stake never exceeds config.risk.max_stake
     • stake never below 0.35 (Deriv minimum)

   `state` is the persistent session object from last-status.json. It is
   read-only here; the runner mutates it after settlement.
   ===================================================================== */

const MIN_STAKE = 0.35;

function clamp(n, lo, hi) {
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
}

function _round2(n) { return Math.round(n * 100) / 100; }

function computeStake(mode, balance, signal, state, config) {
    const r       = (config && config.risk) || {};
    const baseFix = Number(r.fixed_stake) || 1;
    const maxStk  = Number(r.max_stake)   || 10;

    let stake;
    switch (mode) {
        case 'fixed':
            stake = baseFix;
            break;

        case 'fractional': {
            const pct = Number(r.fractional_pct) || 2;
            stake = (Number(balance) || 0) * (pct / 100);
            break;
        }

        case 'antimartingale': {
            // Grow after a win, reset on a loss
            const mult  = Number(r.antimartingale_multiplier) || 2;
            const wins  = Math.max(0, (state && state.win_streak) || 0);
            stake = baseFix * Math.pow(mult, wins);
            break;
        }

        case 'martingale': {
            // Grow after a loss, reset on a win (capped to max_steps)
            const mult     = Number(r.martingale_multiplier) || 2;
            const maxSteps = Math.max(0, Number(r.martingale_max_steps) || 3);
            const losses   = clamp(
                Math.max(0, (state && state.loss_streak) || 0),
                0, maxSteps
            );
            stake = baseFix * Math.pow(mult, losses);
            break;
        }

        case 'confidence': {
            const conf = clamp(
                Number(signal && signal.confidence) || 0,
                0, 1
            );
            // If confidence_scale is off, behave like fixed
            if (r.confidence_scale === false) {
                stake = baseFix;
            } else {
                stake = baseFix * (conf > 0 ? conf : 0.5);
            }
            break;
        }

        default:
            stake = baseFix;
    }

    // Global enforcement
    stake = clamp(stake, MIN_STAKE, maxStk);
    return _round2(stake);
}

/* ─────────────────────────────────────────────────────────────────
   Risk gate — answers "may we trade right now?" based on limits.
   Returns { ok: bool, reason?: string }.
   ───────────────────────────────────────────────────────────────── */
function checkLimits({ session, config, balance }) {
    const lim = (config && config.limits) || {};
    if (session && session.halted) {
        return { ok: false, reason: session.halt_reason || 'session halted' };
    }
    if (Number.isFinite(lim.max_loss_streak) && lim.max_loss_streak > 0 &&
        (session.loss_streak || 0) >= lim.max_loss_streak) {
        return { ok: false, reason: `max_loss_streak reached (${session.loss_streak})` };
    }
    if (Number.isFinite(lim.daily_loss_pct) && lim.daily_loss_pct > 0 &&
        session.day_start_balance > 0) {
        const dropPct = ((session.day_start_balance - balance) /
                          session.day_start_balance) * 100;
        if (dropPct >= lim.daily_loss_pct) {
            return { ok: false, reason: `daily loss limit hit (-${dropPct.toFixed(1)}%)` };
        }
    }
    if (Number.isFinite(lim.stop_loss) && lim.stop_loss > 0 &&
        session.pnl <= -Math.abs(lim.stop_loss)) {
        return { ok: false, reason: `stop_loss reached (P/L ${session.pnl.toFixed(2)})` };
    }
    if (Number.isFinite(lim.take_profit) && lim.take_profit > 0 &&
        session.pnl >= Math.abs(lim.take_profit)) {
        return { ok: false, reason: `take_profit reached (P/L ${session.pnl.toFixed(2)})` };
    }
    return { ok: true };
}

module.exports = {
    computeStake,
    checkLimits,
    MIN_STAKE,
};
