/* =====================================================================
   MOTIONSALT — runner.js  (v3, cron-cycle aware)
   ─────────────────────────────────────────────────────────────────────
   Lifecycle of ONE cycle (≤ 60 s wall clock):
     1. Read config.json + last-status.json
     2. Bail early if enabled === false
     3. Detect task mode (regular cycle | daily_summary | manual)
     4. Authenticate with Deriv (OAuth → OTP → WS)
     5. SETTLE any pending contracts from previous cycles
     6. Pull balance + candle history for all required (symbol × gran)
     7. Run enabled strategies once (state hydrated from disk)
     8. Apply risk gate + risk.computeStake()
     9. Place up to max_trades_per_cycle trades
    10. Persist last-status.json (incl. strategy_state, pending_contracts)
    11. Send Telegram cycle summary
    12. Close WS cleanly, exit 0
   ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const Logger    = require('./logger');
const Strategy  = require('./strategy');
const Deriv     = require('./deriv');
const Risk      = require('./risk');
const Telegram  = require('./telegram');
const Chart     = require('./chart');

const CFG_PATH    = path.join(__dirname, 'config.json');
const STATE_PATH  = path.join(__dirname, 'last-status.json');

const HARD_BUDGET_MS         = 55000;     // leave 5s for git commit + push
const HEARTBEAT_MAX_GAP_MIN  = 15;

// Pending contracts: poll budget per pending contract during the
// settle-step at the start of a cycle.
const PENDING_POLL_BUDGET_MS_PER_CONTRACT = 4000;
// A pending contract that's been around for >5x its expected duration
// gets dropped as 'unknown' — it has clearly fallen off Deriv's radar.
const PENDING_HARD_DROP_FACTOR = 5;

/* ─────────────────────────────────────────────────────────────────
   IO helpers
   ───────────────────────────────────────────────────────────────── */
function readJSON(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return fallback; }
}
function writeJSON(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function isoDay(d = new Date()) { return d.toISOString().slice(0, 10); }

/* ─────────────────────────────────────────────────────────────────
   Trigger payload (workflow_dispatch inputs)
   ───────────────────────────────────────────────────────────────── */
function detectTask() {
    const task = (process.env.INPUT_TASK || process.env.TASK || 'cycle')
        .toString().toLowerCase().trim();
    return task;
}

/* ─────────────────────────────────────────────────────────────────
   Daily counter reset — shared helper used by both the cron
   `daily_summary` task and the auto day-rollover detector that runs
   at the start of every regular cycle. Returns the rendered summary
   payload so the caller can decide whether to push it to Telegram.
   ───────────────────────────────────────────────────────────────── */
function resetDailyCounters(state, todayIso, currentBalance) {
    const summary = {
        date:   state.session.day_start || todayIso,
        trades: state.session.trades || 0,
        wins:   state.session.wins   || 0,
        losses: state.session.losses || 0,
        pnl:    state.session.pnl    || 0,
    };
    state.session.day_start = todayIso;
    state.session.day_start_balance = Number.isFinite(Number(currentBalance))
        ? Number(currentBalance)
        : (state.balance || 0);
    state.session.trades = 0;
    state.session.wins   = 0;
    state.session.losses = 0;
    state.session.pnl    = 0;
    state.session.loss_streak = 0;
    state.session.win_streak  = 0;
    state.session.halted = false;
    state.session.halt_reason = null;
    return summary;
}

/* ─────────────────────────────────────────────────────────────────
   Daily summary task (cron `daily_summary` trigger)
   ───────────────────────────────────────────────────────────────── */
async function runDailySummary(config, state) {
    const today = isoDay();
    const summary = resetDailyCounters(state, today, state.balance);

    await Telegram.send(Telegram.templates.dailySummary({
        date:   summary.date,
        mode:   config.account.mode,
        trades: summary.trades,
        wins:   summary.wins,
        losses: summary.losses,
        pnl:    summary.pnl,
    }));

    state.last_cycle = new Date().toISOString();
    Logger.info('Daily summary sent; counters reset');
    return state;
}

/* ─────────────────────────────────────────────────────────────────
   Auto day-rollover — called at the start of every regular cycle so
   the session counters reset cleanly at UTC midnight even if the
   external cron `daily_summary` task never fires (or fires late).
   Sends the previous day's summary to Telegram before zeroing out.
   ───────────────────────────────────────────────────────────────── */
async function maybeAutoRolloverDay(config, state) {
    const today = isoDay();
    const prevDay = state.session.day_start;
    if (!prevDay || prevDay === today) return false;
    // Day has changed — push a summary for the closed day, then reset.
    Logger.info('Day rollover detected — auto-resetting daily counters', {
        prev_day: prevDay, today,
    });
    const summary = resetDailyCounters(state, today, state.balance);
    try {
        await Telegram.send(Telegram.templates.dailySummary({
            date:   summary.date,
            mode:   config.account.mode,
            trades: summary.trades,
            wins:   summary.wins,
            losses: summary.losses,
            pnl:    summary.pnl,
        }));
    } catch (e) {
        Logger.warn('day-rollover Telegram summary failed (continuing)',
            { error: e.message });
    }
    return true;
}

/* ─────────────────────────────────────────────────────────────────
   Build per-symbol history requirements from enabled plugins
   ───────────────────────────────────────────────────────────────── */
function aggregateHistoryRequests(plugins) {
    const result = {};
    for (const p of plugins) {
        if (!p.enabled || !p.historyRequest) continue;
        for (const [g, c] of Object.entries(p.historyRequest)) {
            const cur = result[g] || 0;
            result[g] = Math.max(cur, Number(c) || 0);
        }
    }
    return result;
}

/* ─────────────────────────────────────────────────────────────────
   Map a settled contract to win/loss + P/L
   ─────────────────────────────────────────────────────────────────
   We are strict about what counts as "settled". A reply with
   is_sold/status in {sold,won,lost} is settled; otherwise we mark it
   pending (the caller can choose to keep tracking it).
   ───────────────────────────────────────────────────────────────── */
function classifySettlement(poc) {
    if (!poc || typeof poc !== 'object') {
        return { state: 'pending', poc: null };
    }
    const status = String(poc.status || '').toLowerCase();
    const settled = poc.is_sold === true || status === 'sold'
                 || status === 'won' || status === 'lost';
    if (!settled) return { state: 'pending', poc };

    const profit = Number(poc.profit);
    let result;
    if (status === 'won')      result = 'win';
    else if (status === 'lost') result = 'loss';
    else if (Number.isFinite(profit)) result = profit > 0 ? 'win' : 'loss';
    else result = 'unknown';

    return {
        state: 'settled',
        result,
        profit: Number.isFinite(profit) ? profit : 0,
        entry:  poc.entry_spot_display_value || poc.entry_spot || '—',
        exit:   poc.exit_tick_display_value  || poc.exit_tick  || poc.current_spot || '—',
        poc,
    };
}

function applySettlementToSession(state, pending, summary) {
    state.session.trades = (state.session.trades || 0) + 1;
    state.session.pnl    = (state.session.pnl    || 0) + summary.profit;
    if (summary.result === 'win') {
        state.session.wins = (state.session.wins || 0) + 1;
        state.session.loss_streak = 0;
        state.session.win_streak  = (state.session.win_streak || 0) + 1;
    } else if (summary.result === 'loss') {
        state.session.losses = (state.session.losses || 0) + 1;
        state.session.loss_streak = (state.session.loss_streak || 0) + 1;
        state.session.win_streak  = 0;
    }
    const rec = {
        id:       String(pending.contractId),
        symbol:   pending.symbol,
        strategy: pending.strategyId,
        type:     pending.contractType,
        stake:    pending.stake,
        profit:   summary.profit,
        result:   summary.result,
        entry:    String(summary.entry),
        exit:     String(summary.exit),
        placedAt: pending.placedAt,
        ts:       new Date().toISOString(),
    };
    state.trade_history = (state.trade_history || []).concat([rec]);
    if (state.trade_history.length > 200) {
        state.trade_history = state.trade_history.slice(-200);
    }
    return rec;
}

/* ─────────────────────────────────────────────────────────────────
   Settle pending contracts from previous cycles
   ───────────────────────────────────────────────────────────────── */
async function settlePendingContracts(ws, state, config, cycleStart) {
    const pending = Array.isArray(state.pending_contracts) ? state.pending_contracts : [];
    if (pending.length === 0) return;
    Logger.info(`Settling ${pending.length} pending contract(s)`);
    const stillPending = [];

    for (const p of pending) {
        // Cross-cycle bookkeeping: count how many cycles this contract
        // has been watched. Used in the settlement Telegram message.
        p.cyclesPending = (Number(p.cyclesPending) || 1) + 1;

        if (Date.now() - cycleStart > HARD_BUDGET_MS - 5000) {
            // Out of time — keep the rest pending for next cycle.
            stillPending.push(p);
            continue;
        }
        try {
            const r = await Deriv.request(ws, {
                proposal_open_contract: 1,
                contract_id:            p.contractId,
            }, PENDING_POLL_BUDGET_MS_PER_CONTRACT);
            const poc = r.proposal_open_contract || {};
            const cls = classifySettlement(poc);
            if (cls.state === 'settled') {
                const rec = applySettlementToSession(state, p, cls);
                Logger.trade(`Pending settled ${p.symbol} ${p.contractType} → ${cls.result}`,
                    { contract_id: p.contractId, pnl: cls.profit });
                try {
                    await Telegram.send(Telegram.templates.cycleResult({
                        result:        cls.result,
                        symbol:        p.symbol,
                        mode:          config.account.mode,
                        entry:         cls.entry,
                        exit:          cls.exit,
                        pnl:           cls.profit,
                        strategy:      p.strategyId,
                        duration:      p.duration,
                        durationUnit:  p.durationUnit,
                        cyclesToSettle: p.cyclesPending,
                        balance:       state.balance,
                        currency:      state.currency,
                        session:       state.session,
                    }));
                } catch (e) {}
                continue;
            }
            // Still pending — but maybe stale enough to drop.
            const ageSec = (Date.now() - new Date(p.placedAt).getTime()) / 1000;
            if (ageSec > p.durationSec * PENDING_HARD_DROP_FACTOR) {
                Logger.warn(`Dropping stuck pending contract ${p.contractId}`,
                    { ageSec: ageSec.toFixed(0), expected: p.durationSec });
                state.trade_history = (state.trade_history || []).concat([{
                    id:       String(p.contractId),
                    symbol:   p.symbol,
                    strategy: p.strategyId,
                    type:     p.contractType,
                    stake:    p.stake,
                    profit:   0,
                    result:   'unknown',
                    entry:    '—',
                    exit:     '—',
                    placedAt: p.placedAt,
                    ts:       new Date().toISOString(),
                    note:     'dropped: stuck pending',
                }]);
                // Tell the user about the drop — silent drops are
                // exactly the kind of gap the user is worried about.
                try {
                    await Telegram.send(Telegram.templates.errorAlert({
                        where:   `pending(${p.symbol})`,
                        message: `Dropped stuck contract ${p.contractId} after ${p.cyclesPending} cycles`,
                        cycleTs: new Date().toISOString(),
                    }));
                } catch (e) {}
                continue;
            }
            stillPending.push(p);
        } catch (e) {
            Logger.warn(`Pending poll failed for ${p.contractId} — keeping`,
                { error: e.message });
            stillPending.push(p);
        }
    }
    state.pending_contracts = stillPending;
}

/* ─────────────────────────────────────────────────────────────────
   Place a new trade and (if it doesn't settle in-cycle) record it as
   pending so the NEXT cycle can finish it.
   ───────────────────────────────────────────────────────────────── */
async function placeTradeNonBlocking(ws, state, config, sig, stake) {
    const opts = {
        symbol:       sig.symbol,
        contractType: sig.decision.contractType,
        stake,
        duration:     sig.decision.duration,
        durationUnit: sig.decision.durationUnit,
    };
    const durationSec = (opts.durationUnit === 'm') ? opts.duration * 60 : opts.duration;
    // Cap blocking wait so we don't blow the cycle budget. For trades
    // that don't settle in this cap, we'll record them pending.
    const waitBudgetMs = Math.min(15000, Math.max(2000, (durationSec * 1000) + 2000));

    const placedAt = new Date().toISOString();

    // onPlaced fires the instant Deriv accepts the buy — BEFORE the
    // bounded settlement wait. This is the new "trade placed" ping that
    // closes the silent gap between order send and result.
    const onPlaced = async ({ buy }) => {
        try {
            await Telegram.send(Telegram.templates.tradePlaced({
                symbol:       sig.symbol,
                mode:         config.account.mode,
                direction:    sig.decision.contractType,
                stake,
                duration:     sig.decision.duration,
                durationUnit: sig.decision.durationUnit,
                strategy:     sig.plugin.id,
                contractId:   buy && buy.contract_id,
            }));
        } catch (e) {
            // Never let a Telegram failure abort a live trade.
        }
    };

    const trade = await Deriv.placeTrade(ws, opts, {
        settleWaitMs: waitBudgetMs,
        onPlaced,
    });
    const cls = classifySettlement(trade.settled);

    if (cls.state === 'settled') {
        applySettlementToSession(state, {
            contractId:   trade.buy.contract_id,
            symbol:       sig.symbol,
            strategyId:   sig.plugin.id,
            contractType: sig.decision.contractType,
            stake,
            placedAt,
            durationSec,
        }, cls);
        try {
            await Telegram.send(Telegram.templates.cycleResult({
                result:        cls.result,
                symbol:        sig.symbol,
                mode:          config.account.mode,
                entry:         cls.entry,
                exit:          cls.exit,
                pnl:           cls.profit,
                strategy:      sig.plugin.id,
                duration:      sig.decision.duration,
                durationUnit:  sig.decision.durationUnit,
                cyclesToSettle: 1,
                balance:       state.balance,
                currency:      state.currency,
                session:       state.session,
            }));
        } catch (e) {}
        return { placed: true, settledInCycle: true };
    }

    // Not settled in-cycle → enqueue as pending for the next cycle.
    state.pending_contracts = state.pending_contracts || [];
    state.pending_contracts.push({
        contractId:   String(trade.buy.contract_id),
        symbol:       sig.symbol,
        strategyId:   sig.plugin.id,
        contractType: sig.decision.contractType,
        stake,
        placedAt,
        durationSec,
        // Preserve original duration units so the settlement message
        // can render "1m" / "30s" / etc. accurately on later cycles.
        duration:     sig.decision.duration,
        durationUnit: sig.decision.durationUnit,
        cyclesPending: 1,
    });
    Logger.info(`Trade placed but not settled in-cycle — pending`, {
        contract_id: trade.buy.contract_id,
        symbol: sig.symbol, durationSec
    });
    // NOTE: we deliberately do NOT send an extra "cycle summary" here.
    // The new tradePlaced ping above already told the user the order
    // is live, and the end-of-cycle summary in main() will send the
    // accurate cycle wrap-up (with correct placed/holds/pending counts).
    return { placed: true, settledInCycle: false };
}

/* ─────────────────────────────────────────────────────────────────
   Main entry
   ───────────────────────────────────────────────────────────────── */
async function main() {
    const cycleStart = Date.now();
    const cycleTs    = new Date().toISOString();
    Logger.info('Cycle start', { ts: cycleTs });

    // 1) Load config + state
    const config = readJSON(CFG_PATH);
    if (!config) {
        Logger.error('config.json missing or invalid — aborting');
        return 0;
    }
    const state = readJSON(STATE_PATH, {
        last_cycle: null, balance: 0, currency: 'USD',
        account_mode: config.account.mode,
        session: { wins:0, losses:0, pnl:0, trades:0, loss_streak:0,
                   halted:false, halt_reason:null,
                   day_start:isoDay(), day_start_balance:0, win_streak:0 },
        logs: [], trade_history: [],
        pending_contracts: [],
        strategy_state: {},
    });
    if (!state.session.day_start) state.session.day_start = isoDay();
    if (state.session.win_streak == null) state.session.win_streak = 0;
    if (!Array.isArray(state.pending_contracts)) state.pending_contracts = [];
    if (!state.strategy_state || typeof state.strategy_state !== 'object') state.strategy_state = {};

    // 1b) Auto-detect day rollover and reset daily session counters.
    //     Runs every cycle so we don't depend on the external cron's
    //     `daily_summary` trigger firing on time. Posts the previous
    //     day's summary to Telegram before zeroing out counters and
    //     clearing any "max_loss_streak / daily_loss_pct" halt.
    try {
        await maybeAutoRolloverDay(config, state);
    } catch (e) {
        Logger.warn('maybeAutoRolloverDay failed (non-fatal)', { error: e.message });
    }

    // 2) Enabled?
    if (config.enabled === false) {
        Logger.info('Bot disabled (config.enabled=false). Exiting cleanly.');
        state.last_cycle = cycleTs;
        state.logs = Logger.mergeRing(state.logs);
        writeJSON(STATE_PATH, state);
        return 0;
    }

    // 3) Branch on task
    const task = detectTask();
    if (task === 'daily_summary') {
        try {
            const out = await runDailySummary(config, state);
            out.logs = Logger.mergeRing(out.logs);
            writeJSON(STATE_PATH, out);
        } catch (e) {
            Logger.error('daily_summary failed', { error: e.message });
            await Telegram.send(Telegram.templates.errorAlert({
                where: 'daily_summary', message: e.message, cycleTs,
            }));
            state.logs = Logger.mergeRing(state.logs);
            writeJSON(STATE_PATH, state);
        }
        return 0;
    }

    if (task === 'manual') {
        let payload = {};
        try { payload = JSON.parse(process.env.INPUT_PAYLOAD || '{}'); } catch (e) {}

        if (payload.action === 'chart') {
            const symbol = payload.symbol || 'cryBTCUSD';
            const tf     = payload.tf     || '1m';
            let ws = null;
            try {
                const conn = await Deriv.connect({
                    bearer: process.env.DERIV_BEARER_TOKEN,
                    appId:  process.env.DERIV_APP_ID,
                    mode:   config.account.mode,
                    realId: process.env.DERIV_REAL_ID || config.account.real_id,
                    demoId: process.env.DERIV_DEMO_ID || config.account.demo_id,
                });
                ws = conn.ws;
                const imgBuffer = await Chart.generateChart(ws, symbol, tf);
                const badge = Telegram.formatBadge(config.account.mode);
                await Telegram.sendPhoto(imgBuffer,
                    `📈 <b>${symbol}</b> ${tf} ${badge}`);
                Logger.info(`[chart] sent ${symbol} ${tf} to Telegram`);
            } catch (e) {
                Logger.error('[chart] failed', { error: e.message });
                await Telegram.send(Telegram.templates.errorAlert({
                    where: `chart(${symbol} ${tf})`, message: e.message, cycleTs,
                }));
            } finally {
                if (ws) Deriv.close(ws);
            }
            state.last_cycle = cycleTs;
            state.logs = Logger.mergeRing(state.logs);
            writeJSON(STATE_PATH, state);
            return 0;
        }
        // Unknown manual action — fall through to normal cycle
    }

    // 4) Discover strategies
    Strategy.discover(undefined, config.strategies || {});
    const enabledPlugins = Strategy.list().filter(p => p.enabled);
    if (enabledPlugins.length === 0 && state.pending_contracts.length === 0) {
        Logger.warn('No strategies enabled and no pending contracts — cycle no-op');
        state.last_cycle = cycleTs;
        state.logs = Logger.mergeRing(state.logs);
        writeJSON(STATE_PATH, state);
        return 0;
    }

    // 5) Connect to Deriv via OAuth + OTP
    let ws = null, accountId = null;
    try {
        const conn = await Deriv.connect({
            bearer: process.env.DERIV_BEARER_TOKEN,
            appId:  process.env.DERIV_APP_ID,
            mode:   config.account.mode,
            realId: process.env.DERIV_REAL_ID || config.account.real_id,
            demoId: process.env.DERIV_DEMO_ID || config.account.demo_id,
        });
        ws = conn.ws; accountId = conn.accountId;
    } catch (e) {
        Logger.error('Deriv connect failed', { error: e.message });
        await Telegram.send(Telegram.templates.errorAlert({
            where: 'deriv.connect', message: e.message, cycleTs,
        }));
        state.last_cycle = cycleTs;
        state.logs = Logger.mergeRing(state.logs);
        writeJSON(STATE_PATH, state);
        return 0;
    }

    // 6) Settle anything pending from prior cycles BEFORE we trade more.
    //    This both updates session counters and clears hasOpenTrade gates
    //    that the strategies will consult.
    try {
        await settlePendingContracts(ws, state, config, cycleStart);
    } catch (e) {
        Logger.error('settlePendingContracts failed', { error: e.message, stack: e.stack });
    }

    // 7) Balance
    let bal = { balance: state.balance || 0, currency: 'USD', loginid: accountId };
    try { bal = await Deriv.getBalance(ws); }
    catch (e) { Logger.warn('balance fetch failed', { error: e.message }); }
    state.balance      = bal.balance;
    state.currency     = bal.currency;
    state.account_mode = config.account.mode;
    if (!state.session.day_start_balance) state.session.day_start_balance = bal.balance;

    // 8) History fetch (per (symbol × granularity))
    const grans   = aggregateHistoryRequests(enabledPlugins);
    const symbols = Array.isArray(config.symbols)
        ? config.symbols
        : Object.entries(config.symbols || {}).filter(([,v]) => v).map(([k]) => k);
    const histories = {};
    const lastTick  = {};
    for (const sym of symbols) {
        histories[sym] = {};
        for (const [g, cnt] of Object.entries(grans)) {
            try {
                histories[sym][g] = await Deriv.ticksHistory(ws, sym, g, cnt);
            } catch (e) {
                Logger.warn(`ticksHistory ${sym}@${g} failed`, { error: e.message });
                histories[sym][g] = [];
            }
            if (Date.now() - cycleStart > HARD_BUDGET_MS) break;
        }
        const pickGran = Object.keys(histories[sym])[0];
        const cs = histories[sym][pickGran] || [];
        if (cs.length > 0) {
            const last = cs[cs.length - 1];
            lastTick[sym] = { epoch: last.epoch, quote: last.close };
        }
        if (Date.now() - cycleStart > HARD_BUDGET_MS) break;
    }

    // 9) Risk gate
    const gate = Risk.checkLimits({
        session: state.session, config, balance: bal.balance,
    });
    if (!gate.ok) {
        state.session.halted = true;
        state.session.halt_reason = gate.reason;
        Logger.warn(`Risk gate blocked trading: ${gate.reason}`);
    }

    // 10) Build per-(strategy × symbol) bookkeeping for the engine
    const consecutiveLosses = Strategy.reconstructConsecutiveLosses(state.trade_history || []);
    const openTrades = {};
    for (const p of state.pending_contracts) {
        const key = `${p.strategyId}::${p.symbol}`;
        openTrades[key] = true;
    }

    const settings = {
        baseStake:            (config.risk && Number(config.risk.fixed_stake)) || 1,
        martingaleSteps:      (config.risk && Number(config.risk.martingale_max_steps)) || 3,
        martingaleMultiplier: (config.risk && Number(config.risk.martingale_multiplier)) || 2,
    };

    // 11) Run strategies
    const cycleResult = Strategy.runCycle({
        symbols, histories, lastTick,
        consecutiveLosses, openTrades, settings,
        priorStrategyState: state.strategy_state,
        nowMs: Date.now(),
    });

    // Persist strategy_state regardless of whether anything fired —
    // the engine bumps internal bookkeeping (lastClosedEpoch etc.) on
    // every cycle.
    state.strategy_state = cycleResult.persistedState;

    Logger.info('Strategies executed', {
        signals: cycleResult.signals.length,
        holds:   cycleResult.holds.length,
        monitor: cycleResult.monitors.length,
    });

    // 12) Send a HOLD notification (max 1 per cycle to avoid spam)
    if (cycleResult.holds.length > 0) {
        const h = cycleResult.holds[0];
        try {
            await Telegram.send(Telegram.templates.holdSignal({
                symbol: h.symbol,
                reason: h.decision.reason || 'setup forming',
            }));
        } catch (e) {}
    }

    // 13) Place trades (capped by max_trades_per_cycle)
    const maxTrades = Math.max(0, Number(
        (config.limits && config.limits.max_trades_per_cycle) || 1));
    let placed = 0;

    // Payout threshold gate — if configured, fetch a live proposal
    // BEFORE buying and skip any signal whose payout pct is below the
    // user's floor. `min_payout_pct` is expressed as percent profit on
    // stake, i.e. 80 means “payout must be at least 1.8× the stake”.
    // 0 / unset disables the gate (legacy behaviour).
    const minPayoutPct = Number((config.limits && config.limits.min_payout_pct) || 0);
    let skippedLowPayout = 0;

    if (gate.ok) {
        for (const sig of cycleResult.signals) {
            if (placed >= maxTrades) break;
            if (Date.now() - cycleStart > HARD_BUDGET_MS) {
                Logger.warn('Budget exhausted — skipping further trades');
                break;
            }
            const mode = (config.risk && config.risk.mode) || 'fixed';
            const stake = Risk.computeStake(
                mode, bal.balance, sig.decision, state.session, config
            );

            // ── Payout pre-check (skipped when threshold is 0/unset) ──
            if (minPayoutPct > 0) {
                try {
                    const quote = await Deriv.getProposal(ws, {
                        symbol:       sig.symbol,
                        contractType: sig.decision.contractType,
                        stake,
                        duration:     sig.decision.duration,
                        durationUnit: sig.decision.durationUnit,
                    });
                    if (quote.payoutPct < minPayoutPct) {
                        skippedLowPayout++;
                        Logger.info('Signal skipped: payout below threshold', {
                            symbol:       sig.symbol,
                            strategy:     sig.plugin.id,
                            payout_pct:   Number(quote.payoutPct.toFixed(2)),
                            min_required: minPayoutPct,
                        });
                        try {
                            await Telegram.send(
                                `🚫 <b>SKIPPED</b> — <code>${sig.symbol}</code>\n` +
                                `Payout ${quote.payoutPct.toFixed(1)}% &lt; threshold ${minPayoutPct}%`
                            );
                        } catch (e) {}
                        continue;
                    }
                } catch (e) {
                    // If the proposal call itself fails we fall through
                    // to placeTrade which will surface the real error.
                    Logger.warn('Payout pre-check failed — attempting trade anyway', {
                        symbol: sig.symbol, error: e.message,
                    });
                }
            }

            try {
                const res = await placeTradeNonBlocking(ws, state, config, sig, stake);
                if (res.placed) placed++;
            } catch (e) {
                Logger.error('Trade failed', { error: e.message, symbol: sig.symbol });
                await Telegram.send(Telegram.templates.errorAlert({
                    where: `trade(${sig.symbol})`, message: e.message, cycleTs,
                }));
            }
        }
    }

    if (skippedLowPayout > 0) {
        Logger.info('Cycle filtered low-payout signals', {
            skipped: skippedLowPayout, min_payout_pct: minPayoutPct,
        });
    }

    // 14) End-of-cycle wrap-up.
    //
    //   v3.1 change: we used to only send this summary when NOTHING
    //   happened (placed===0 && holds===0). That meant cycles with a
    //   hold-only outcome, or with a placed-but-not-settled trade, did
    //   NOT produce a cycle wrap message — which contributed to the
    //   "cycles run but I'm not notified" feeling.
    //
    //   New rule: ALWAYS send the cycle summary, EXCEPT when at least
    //   one trade settled in-cycle (the cycleResult / WIN-LOSS message
    //   already carries balance + session info, so the summary would
    //   just be noise).
    //
    //   This guarantees at most ONE cycle summary message per cycle, on
    //   top of any settlement / hold messages — keeping us well below
    //   Telegram's per-chat rate limit at the project's 5-minute cron.
    const anySettledInCycle = state.trade_history && state.trade_history.length > 0
        && state.trade_history[state.trade_history.length - 1].ts >= cycleTs;
    if (!anySettledInCycle) {
        try {
            await Telegram.send(Telegram.templates.cycleSummary({
                mode:      config.account.mode,
                balance:   bal.balance,
                currency:  bal.currency,
                placed,
                holds:     cycleResult.holds.length,
                monitored: cycleResult.monitors.length,
                pending:   (state.pending_contracts || []).length,
                session:   state.session,
            }));
        } catch (e) {}
    }

    // 15) Heartbeat staleness check
    if (state.last_cycle) {
        const ageMin = (Date.now() - new Date(state.last_cycle).getTime()) / 60000;
        if (ageMin > HEARTBEAT_MAX_GAP_MIN) {
            Logger.warn('Previous cycle gap exceeded threshold', { ageMin: ageMin.toFixed(1) });
        }
    }

    // 16) Persist state
    state.last_cycle = cycleTs;
    state.logs = Logger.mergeRing(state.logs);
    writeJSON(STATE_PATH, state);

    // 17) Clean up WS
    Deriv.close(ws);
    Logger.info(`Cycle complete in ${((Date.now() - cycleStart) / 1000).toFixed(1)}s`,
        { placed, holds: cycleResult.holds.length, pending: state.pending_contracts.length });
    return 0;
}

const watchdog = setTimeout(() => {
    Logger.error('Cycle hard-timeout (60s) — forcing exit');
    process.exit(0);
}, 60000);
watchdog.unref();

main()
    .then(code => {
        clearTimeout(watchdog);
        process.exit(code || 0);
    })
    .catch(async (e) => {
        clearTimeout(watchdog);
        Logger.error('Uncaught error in main', { error: e.message, stack: e.stack });
        try {
            await Telegram.send(Telegram.templates.errorAlert({
                where: 'runner.main', message: e.message,
                cycleTs: new Date().toISOString(),
            }));
        } catch (e2) {}
        try {
            const state = readJSON(STATE_PATH, {});
            state.last_cycle = new Date().toISOString();
            state.logs = Logger.mergeRing(state.logs || []);
            writeJSON(STATE_PATH, state);
        } catch (e2) {}
        process.exit(0); // never fail the workflow
    });
