/* =====================================================================
   MOTIONSALT — Deriv WebSocket + OAuth/OTP authentication
   ─────────────────────────────────────────────────────────────────────
   Two-phase auth (no naked api_token):

     1) GET  https://api.derivws.com/trading/v1/options/accounts
        Header:  Authorization: Bearer <DERIV_BEARER_TOKEN>
                 Deriv-App-ID:  <DERIV_APP_ID>
        → { data: [{ loginid, currency, account_type, ... }, ...] }

     2) Pick the loginid that matches config.account.mode
        (real → DERIV_REAL_ID, demo → DERIV_DEMO_ID)

     3) POST https://api.derivws.com/trading/v1/options/accounts/{loginid}/otp
        Same headers.
        → { data: { url: "wss://..." } }   ← pre-authenticated WS

     4) Open WebSocket on that URL. NO `authorize` call needed.

   Public surface:
     connect({ bearer, appId, loginid })     → { ws, accountId }
     request(ws, payload, timeoutMs)         → resolves with full reply
     ticksHistory(ws, symbol, gran, count)   → Candle[]
     getBalance(ws)                          → { balance, currency, loginid }
     placeTrade(ws, opts)                    → settled-contract object
     close(ws)
   ===================================================================== */

const WebSocket = require('ws');
const Logger    = require('./logger');

const DEFAULT_TIMEOUT = 15000;

/* ─────────────────────────────────────────────────────────────────
   Forex (frx*) intraday duration floor — verified against Deriv's
   contracts_for response for this account:
     • expiry_type "intraday": min_contract_duration = 15m
     • expiry_type "daily":    min_contract_duration = 1d
   There is no sub-15m option for forex CALL/PUT/CALLE/PUTE. Other
   asset classes (synthetic indices R_*, crypto cry*, etc.) keep
   whatever the strategy asked for — this constraint is forex-only.

   _normaliseForexDuration is the single shared chokepoint. Every
   trade goes through placeTrade() below, so clamping here covers
   all current and future strategies without per-call-site patches.
   ───────────────────────────────────────────────────────────────── */
const FOREX_MIN_INTRADAY_MINUTES = 15;

function _isForexSymbol(symbol) {
    return typeof symbol === 'string' && symbol.startsWith('frx');
}

function _normaliseForexDuration(symbol, duration, durationUnit) {
    if (!_isForexSymbol(symbol)) {
        return { duration, durationUnit, clamped: false };
    }
    // Convert whatever the caller passed into minutes for comparison.
    // Forex on this account supports only m/h/d (intraday >= 15m, or
    // daily). Anything sub-minute (e.g. ticks/seconds) or below 15m
    // gets clamped up to the 15m intraday floor with unit 'm'.
    let minutes;
    switch (durationUnit) {
        case 't': // ticks — not valid for forex, treat as < 15m
            minutes = 0;
            break;
        case 's':
            minutes = duration / 60;
            break;
        case 'm':
            minutes = duration;
            break;
        case 'h':
            minutes = duration * 60;
            break;
        case 'd':
            // Daily contracts are a separate expiry_type with its own
            // valid range — leave untouched.
            return { duration, durationUnit, clamped: false };
        default:
            minutes = duration; // unknown unit, be conservative
    }
    if (minutes < FOREX_MIN_INTRADAY_MINUTES) {
        return {
            duration: FOREX_MIN_INTRADAY_MINUTES,
            durationUnit: 'm',
            clamped: true,
            originalDuration: duration,
            originalUnit: durationUnit,
        };
    }
    return { duration, durationUnit, clamped: false };
}

/* ─────────────────────────────────────────────────────────────────
   REST helpers — list accounts + request OTP-WS URL
   ───────────────────────────────────────────────────────────────── */
async function _getFetch() {
    if (typeof fetch === 'function') return fetch;
    const mod = await import('node-fetch');
    return mod.default;
}

async function listAccounts({ bearer, appId }) {
    if (!bearer) throw new Error('DERIV_BEARER_TOKEN missing');
    if (!appId)  throw new Error('DERIV_APP_ID missing');
    const f = await _getFetch();
    const res = await f('https://api.derivws.com/trading/v1/options/accounts', {
        method: 'GET',
        headers: {
            Authorization:  `Bearer ${bearer}`,
            'Deriv-App-ID': String(appId),
            Accept:         'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`list-accounts ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json && (json.data || json.accounts || [])) || [];
}

async function getOtpUrl({ bearer, appId, loginid }) {
    if (!loginid) throw new Error('account loginid missing');
    const f = await _getFetch();
    const url = `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(loginid)}/otp`;
    const res = await f(url, {
        method: 'POST',
        headers: {
            Authorization:  `Bearer ${bearer}`,
            'Deriv-App-ID': String(appId),
            Accept:         'application/json',
            'Content-Type': 'application/json',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`otp ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const wss  = json && json.data && json.data.url;
    if (!wss) throw new Error('OTP response missing data.url');
    return wss;
}

/* ─────────────────────────────────────────────────────────────────
   WebSocket — open, request/reply, ping/pong watchdog
   ───────────────────────────────────────────────────────────────── */
function _attachHandlers(ws) {
    ws.__reqId = 1;
    ws.__pending = new Map();   // req_id → { resolve, reject, timer }
    ws.__stream  = new Map();   // subscription id → handler

    ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch (e) { return; }

        // Streamed subscriptions (ticks_history with subscribe=1)
        if (data.subscription && data.subscription.id && ws.__stream.has(data.subscription.id)) {
            try { ws.__stream.get(data.subscription.id)(data); } catch (e) {}
        }

        const id = data.req_id;
        if (id != null && ws.__pending.has(id)) {
            const slot = ws.__pending.get(id);
            ws.__pending.delete(id);
            clearTimeout(slot.timer);
            if (data.error) slot.reject(new Error(`${data.error.code}: ${data.error.message}`));
            else            slot.resolve(data);
        }
    });

    ws.on('close', () => {
        for (const [, slot] of ws.__pending) {
            clearTimeout(slot.timer);
            slot.reject(new Error('WebSocket closed'));
        }
        ws.__pending.clear();
    });

    ws.on('error', (err) => Logger.error('Deriv WS error', { error: err.message }));
}

function request(ws, payload, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
            return reject(new Error(`WS not open (state=${ws.readyState})`));
        }
        const id = ws.__reqId++;
        const body = Object.assign({}, payload, { req_id: id });
        const timer = setTimeout(() => {
            if (ws.__pending.has(id)) {
                ws.__pending.delete(id);
                reject(new Error(`request timeout: ${JSON.stringify(payload).slice(0, 80)}`));
            }
        }, timeoutMs);
        ws.__pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify(body)); }
        catch (e) {
            clearTimeout(timer);
            ws.__pending.delete(id);
            reject(e);
        }
    });
}

function _openWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            try { ws.terminate(); } catch (e) {}
            reject(new Error('WS open timeout'));
        }, 20000);
        ws.on('open', () => {
            clearTimeout(timer);
            _attachHandlers(ws);
            resolve(ws);
        });
        ws.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/* ─────────────────────────────────────────────────────────────────
   Public connect() — runs the full OAuth + OTP flow
   ───────────────────────────────────────────────────────────────── */
async function connect({ bearer, appId, mode, realId, demoId }) {
    const loginid = (mode === 'real') ? realId : demoId;
    if (!loginid) throw new Error(`account loginid for mode="${mode}" not set`);

    Logger.network(`Deriv: requesting OTP for ${loginid} (${mode})`);
    const url = await getOtpUrl({ bearer, appId, loginid });
    Logger.network('Deriv: opening WebSocket', { url: url.replace(/token=[^&]+/, 'token=***') });

    const ws = await _openWs(url);
    Logger.network('Deriv: WebSocket open');
    return { ws, accountId: loginid };
}

/* ─────────────────────────────────────────────────────────────────
   ticksHistory — fetch OHLC candles (or raw ticks) for a symbol
   ───────────────────────────────────────────────────────────────── */
async function ticksHistory(ws, symbol, granularity, count = 100) {
    const reply = await request(ws, {
        ticks_history: symbol,
        end:           'latest',
        count:         count,
        style:         'candles',
        granularity:   Number(granularity),
        adjust_start_time: 1,
    }, 20000);
    const candles = reply.candles || [];
    return candles.map(c => ({
        epoch: Number(c.epoch),
        open:  Number(c.open),
        high:  Number(c.high),
        low:   Number(c.low),
        close: Number(c.close),
    }));
}

async function rawTicks(ws, symbol, count = 50) {
    const reply = await request(ws, {
        ticks_history: symbol,
        end:           'latest',
        count:         count,
        style:         'ticks',
    }, 15000);
    const history = reply.history || {};
    const prices  = (history.prices || []).map(Number);
    const times   = (history.times  || []).map(Number);
    return { prices, times };
}

/* ─────────────────────────────────────────────────────────────────
   Balance
   ───────────────────────────────────────────────────────────────── */
async function getBalance(ws) {
    const r = await request(ws, { balance: 1 }, 10000);
    const b = r.balance || {};
    return {
        balance:  Number(b.balance) || 0,
        currency: b.currency || 'USD',
        loginid:  b.loginid  || null,
    };
}

/* ─────────────────────────────────────────────────────────────────
   getProposal — quote-only fetch. Same shape as the proposal call
   placeTrade() makes internally, but never buys. Used by the runner's
   payout-threshold gate so we can skip signals whose live payout is
   too thin without burning an order.

   Returns: { askPrice, payout, payoutPct, spot, longcode, raw }
   where payoutPct = (payout - stake) / stake * 100   (>= 0)
   ───────────────────────────────────────────────────────────────── */
async function getProposal(ws, opts) {
    const symbol       = opts.symbol;
    const contractType = String(opts.contractType || '').toUpperCase();
    const stake        = Number(opts.stake);
    const rawDuration     = Number(opts.duration);
    const rawDurationUnit = opts.durationUnit || 'm';
    const _norm = _normaliseForexDuration(symbol, rawDuration, rawDurationUnit);
    const duration     = _norm.duration;
    const durationUnit = _norm.durationUnit;

    if (!symbol || !contractType || !Number.isFinite(stake) || stake <= 0) {
        throw new Error('getProposal: invalid opts');
    }
    const reply = await request(ws, {
        proposal:          1,
        amount:            stake,
        basis:             'stake',
        contract_type:     contractType,
        currency:          'USD',
        duration:          duration,
        duration_unit:     durationUnit,
        underlying_symbol: symbol,
    }, 15000);
    const prop = reply.proposal || {};
    const payout = Number(prop.payout) || 0;
    const payoutPct = stake > 0 ? ((payout - stake) / stake) * 100 : 0;
    return {
        askPrice:  Number(prop.ask_price) || 0,
        payout,
        payoutPct,
        spot:      Number(prop.spot) || null,
        longcode:  prop.longcode || '',
        raw:       prop,
    };
}

/* ─────────────────────────────────────────────────────────────────
   placeTrade — proposal → buy → poll proposal_open_contract until settled
   opts:
     symbol, contractType ('CALL'|'PUT'), stake, duration, durationUnit ('s'|'m')
   ───────────────────────────────────────────────────────────────── */
async function placeTrade(ws, opts, settleOpts) {
    const symbol       = opts.symbol;
    const contractType = String(opts.contractType || '').toUpperCase();
    const stake        = Number(opts.stake);
    const rawDuration     = Number(opts.duration);
    const rawDurationUnit = opts.durationUnit || 'm';
    // Forex (frx*) requires duration >= 15m for intraday CALL/PUT.
    // Clamp here so every trade path (any strategy, any caller) is
    // safe — see _normaliseForexDuration above.
    const _norm = _normaliseForexDuration(symbol, rawDuration, rawDurationUnit);
    const duration     = _norm.duration;
    const durationUnit = _norm.durationUnit;
    if (_norm.clamped) {
        Logger.warn('Forex duration below 15m floor — clamped to 15m', {
            symbol,
            requested: `${_norm.originalDuration}${_norm.originalUnit}`,
            used:      `${duration}${durationUnit}`,
        });
    }
    const settleWaitMs = (settleOpts && Number(settleOpts.settleWaitMs)) || null;
    // v3.1 additive: optional callback fired after the buy is accepted
    // but BEFORE we block on settlement. Used by the runner to push an
    // immediate "trade placed" Telegram ping. Errors thrown by the
    // callback are swallowed — notifications must not break a live trade.
    const onPlaced    = (settleOpts && typeof settleOpts.onPlaced === 'function')
        ? settleOpts.onPlaced : null;

    if (!symbol || !contractType || !Number.isFinite(stake) || stake <= 0) {
        throw new Error('placeTrade: invalid opts');
    }

    // 1) Proposal
    const propReply = await request(ws, {
        proposal:          1,
        amount:            stake,
        basis:             'stake',
        contract_type:     contractType,
        currency:          'USD',
        duration:          duration,
        duration_unit:     durationUnit,
        underlying_symbol: symbol,
    }, 15000);

    const prop = propReply.proposal;
    if (!prop || !prop.id) throw new Error('proposal: no id returned');
    Logger.trade(`Proposal accepted ${symbol} ${contractType}`,
        { stake, price: prop.ask_price, payout: prop.payout, spot: prop.spot });

    // 2) Buy
    const buyReply = await request(ws, {
        buy:   prop.id,
        price: Number(prop.ask_price),
    }, 15000);
    const buy = buyReply.buy;
    if (!buy || !buy.contract_id) throw new Error('buy: no contract_id');
    Logger.trade(`Trade placed: contract_id=${buy.contract_id}`,
        { transaction_id: buy.transaction_id, longcode: buy.longcode });

    // 2b) Notify caller that the buy is live (BEFORE settlement wait).
    if (onPlaced) {
        try {
            await onPlaced({ proposal: prop, buy });
        } catch (e) {
            Logger.warn('placeTrade onPlaced callback threw', { error: e.message });
        }
    }

    // 3) Wait for settlement (bounded). If the wait elapses before
    //    Deriv reports the contract as sold/won/lost, we return the
    //    best-effort snapshot — the runner will record it as pending
    //    and try again next cycle. This is what makes long-duration
    //    contracts safe in a cron-driven bot.
    const settled = await _waitForSettlement(ws, buy.contract_id,
        duration, durationUnit, settleWaitMs);
    return { proposal: prop, buy, settled };
}

async function _waitForSettlement(ws, contractId, duration, durationUnit, settleWaitMs) {
    const seconds = (durationUnit === 'm') ? duration * 60 : duration;
    // Default: bounded to a sensible duration. If the caller passed
    // settleWaitMs explicitly (the v3 runner does), honour that —
    // it knows whether the cron interval can let a contract span
    // multiple cycles.
    const budgetMs = Number.isFinite(settleWaitMs) && settleWaitMs > 0
        ? settleWaitMs
        : Math.min(55000, Math.max(20000, (seconds + 30) * 1000));
    const deadline = Date.now() + budgetMs;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
        try {
            const r = await request(ws, {
                proposal_open_contract: 1,
                contract_id:            contractId,
            }, 10000);
            const poc = r.proposal_open_contract || {};
            lastSnapshot = poc;
            if (poc.is_sold || poc.status === 'sold' ||
                poc.status === 'won'  || poc.status === 'lost') {
                return poc;
            }
        } catch (e) {
            Logger.warn('proposal_open_contract poll error', { error: e.message });
        }
        await _sleep(1500);
    }
    Logger.warn('Trade settlement timed out — returning best-effort snapshot', {
        contract_id: contractId
    });
    return lastSnapshot || { contract_id: contractId, status: 'timeout' };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────────
   Close
   ───────────────────────────────────────────────────────────────── */
function close(ws) {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'cycle complete');
    } catch (e) {}
}

module.exports = {
    listAccounts,
    getOtpUrl,
    connect,
    request,
    ticksHistory,
    rawTicks,
    getBalance,
    getProposal,
    placeTrade,
    close,
};
