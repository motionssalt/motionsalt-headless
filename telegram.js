/* =====================================================================
   MOTIONSALT — Telegram Bot API client
   ─────────────────────────────────────────────────────────────────────
   Outbound only (the inbound webhook lives in worker/index.js).
   All messages are sent to TELEGRAM_CHAT_ID (whitelist enforced).

   Public surface:
     send(text, opts?)                  → sendMessage with HTML parse
     sendPhoto(buffer, caption?)        → sendPhoto (multipart)
     answerCallback(callback_id, text?) → answerCallbackQuery
     editMessage(chat_id, msg_id, text, kb?) → editMessageText
     buildKeyboard(rows)                → inline keyboard helper

     formatBadge(mode)                  → '🟡 DEMO' | '🔴 REAL'
     templates.* — message template helpers

   v3.1 (notification overhaul):
     • _api now retries ONCE on transient failure (network error, 5xx,
       or 429). Permanent 4xx is logged loudly and NOT retried — those
       would just fail the same way.
     • New template:  tradePlaced  — fires the moment a buy is accepted.
     • Enriched templates: cycleResult (now shows duration, balance,
       running session P/L, optional cyclesToSettle for cross-cycle
       contracts), cycleSummary (now shows running session P/L).
   ===================================================================== */

const Logger = require('./logger');

const TG_TOKEN   = () => process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = () => process.env.TELEGRAM_CHAT_ID;

async function _fetch() {
    if (typeof fetch === 'function') return fetch;
    const mod = await import('node-fetch');
    return mod.default;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────────────────────────────────────────────────────────
   _api — POST a Telegram Bot API method with one retry on transient
   failure. We treat the following as transient:
     • thrown fetch error (network blip / DNS hiccup)
     • HTTP 5xx
     • HTTP 429 (rate limited) — honour retry_after if Telegram sends one
   Permanent 4xx errors are logged once and NOT retried.
   ───────────────────────────────────────────────────────────────── */
async function _api(method, payload) {
    const token = TG_TOKEN();
    if (!token) { Logger.warn('TELEGRAM_BOT_TOKEN not set — skipping'); return null; }
    const f = await _fetch();
    const url = `https://api.telegram.org/bot${token}/${method}`;

    async function attempt() {
        let res;
        try {
            res = await f(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (e) {
            // Network / DNS / TLS error — surface as transient.
            return { transient: true, error: e.message, json: null, status: 0 };
        }
        const json = await res.json().catch(() => ({}));
        const transient = (res.status >= 500 && res.status < 600) || res.status === 429;
        return { transient, error: null, json, status: res.status };
    }

    let r = await attempt();
    if ((r.transient || (r.json && !r.json.ok)) && (r.transient)) {
        // Honour Telegram's retry_after if present (in seconds).
        let waitMs = 1500;
        if (r.json && r.json.parameters && Number.isFinite(r.json.parameters.retry_after)) {
            waitMs = Math.min(8000, r.json.parameters.retry_after * 1000 + 200);
        }
        Logger.warn(`Telegram ${method} transient failure — retrying once`, {
            status: r.status, error: r.error,
            retry_after_ms: waitMs,
        });
        await _sleep(waitMs);
        r = await attempt();
    }

    if (r.error) {
        Logger.warn(`Telegram ${method} network error (after retry)`, { error: r.error });
        return null;
    }
    if (r.json && !r.json.ok) {
        Logger.warn(`Telegram ${method} failed`, {
            status: r.status,
            description: r.json.description,
            error_code: r.json.error_code,
        });
    }
    return r.json;
}

/* ─────────────────────────────────────────────────────────────────
   send / edit / answer
   ───────────────────────────────────────────────────────────────── */
async function send(text, opts = {}) {
    const chatId = opts.chat_id || TG_CHAT_ID();
    if (!chatId) { Logger.warn('TELEGRAM_CHAT_ID not set — skipping'); return null; }
    const payload = {
        chat_id: chatId,
        text:    String(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    };
    if (opts.reply_markup) payload.reply_markup = opts.reply_markup;
    return _api('sendMessage', payload);
}

async function editMessage(chatId, messageId, text, replyMarkup) {
    return _api('editMessageText', {
        chat_id:    chatId,
        message_id: messageId,
        text:       String(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
    });
}

async function answerCallback(callbackId, text) {
    return _api('answerCallbackQuery', {
        callback_query_id: callbackId,
        text: text || '',
        show_alert: false,
    });
}

/* ─────────────────────────────────────────────────────────────────
   sendPhoto — multipart upload of a Buffer
   ───────────────────────────────────────────────────────────────── */
async function sendPhoto(buffer, caption) {
    const token = TG_TOKEN();
    const chatId = TG_CHAT_ID();
    if (!token || !chatId) return null;
    const f = await _fetch();
    // node-fetch v3 / global fetch both support FormData + Blob via undici
    const fd = new FormData();
    fd.append('chat_id', chatId);
    if (caption) {
        fd.append('caption', caption);
        fd.append('parse_mode', 'HTML');
    }
    fd.append('photo', new Blob([buffer], { type: 'image/png' }), 'chart.png');
    const url = `https://api.telegram.org/bot${token}/sendPhoto`;
    try {
        const res = await f(url, { method: 'POST', body: fd });
        const json = await res.json().catch(() => ({}));
        if (!json.ok) Logger.warn('Telegram sendPhoto failed', { json });
        return json;
    } catch (e) {
        Logger.warn('Telegram sendPhoto threw', { error: e.message });
        return null;
    }
}

/* ─────────────────────────────────────────────────────────────────
   Inline keyboard helper
   ───────────────────────────────────────────────────────────────── */
function buildKeyboard(rows) {
    return {
        inline_keyboard: rows.map(row =>
            row.map(btn => ({
                text: btn.text,
                callback_data: btn.data || btn.callback_data || '',
                ...(btn.url ? { url: btn.url } : {}),
            }))
        )
    };
}

/* ─────────────────────────────────────────────────────────────────
   Formatting helpers
   ───────────────────────────────────────────────────────────────── */
function formatBadge(mode) {
    return (mode === 'real') ? '🔴 REAL' : '🟡 DEMO';
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _money(n, cur = 'USD') {
    const sign = n < 0 ? '-' : '';
    const v = Math.abs(Number(n) || 0).toFixed(2);
    return cur === 'USD' ? `${sign}$${v}` : `${sign}${v} ${cur}`;
}

// Human-readable duration label from (duration, unit) — e.g. (1,'m') → '1m'
function _durationLabel(duration, unit) {
    const n = Number(duration);
    const u = String(unit || '').toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (u === 'm' || u === 'min' || u === 'minutes') return `${n}m`;
    if (u === 's' || u === 'sec' || u === 'seconds') {
        // collapse 60/120/... to "1m"/"2m" for prettier output
        if (n >= 60 && n % 60 === 0) return `${n / 60}m`;
        return `${n}s`;
    }
    if (u === 'h' || u === 'hour' || u === 'hours')   return `${n}h`;
    if (u === 'd' || u === 'day'  || u === 'days')    return `${n}d`;
    if (u === 't' || u === 'tick' || u === 'ticks')   return `${n}t`;
    return `${n}${u || ''}`;
}

function _directionArrow(direction) {
    const d = String(direction || '').toUpperCase();
    if (d === 'CALL' || d === 'CALLE') return '⬆ CALL';
    if (d === 'PUT'  || d === 'PUTE')  return '⬇ PUT';
    return _esc(d || '—');
}

function _sessionLine(session) {
    if (!session || typeof session !== 'object') return null;
    const w = Number(session.wins   || 0);
    const l = Number(session.losses || 0);
    const t = Number(session.trades || (w + l));
    const pnl = Number(session.pnl || 0);
    const sign = pnl >= 0 ? '+' : '';
    if (t === 0 && pnl === 0) return null;
    return `Session : ${w}W/${l}L · ${sign}${_money(pnl)}`;
}

/* ─────────────────────────────────────────────────────────────────
   Message templates
   ───────────────────────────────────────────────────────────────── */
const templates = {

    /* NEW in v3.1 — fires immediately when a buy is accepted by Deriv,
       BEFORE we wait for settlement. Gives the user a same-second
       confirmation that the bot placed a real order. */
    tradePlaced({ symbol, mode, direction, stake, duration, durationUnit,
                  strategy, contractId }) {
        const badge = formatBadge(mode);
        const lines = [
            `🎯 <b>TRADE PLACED</b> — ${_esc(symbol)} ${badge}`,
            `Direction: <b>${_directionArrow(direction)}</b>`,
            `Stake    : ${_money(stake)}`,
            `Duration : <b>${_durationLabel(duration, durationUnit)}</b>`,
            `Strategy : <code>${_esc(strategy)}</code>`,
        ];
        if (contractId) lines.push(`Contract : <code>${_esc(contractId)}</code>`);
        return lines.join('\n');
    },

    /* Enriched in v3.1:
       • Duration line (e.g. "1m" or "1m · 2 cycles")
       • Balance after settle
       • Running session line (W/L · P/L)
     */
    cycleResult({ result, symbol, mode, entry, exit, pnl, strategy,
                  duration, durationUnit, cyclesToSettle,
                  balance, currency, session }) {
        const badge = formatBadge(mode);
        const head  = (result === 'win')
            ? `✅ <b>WIN</b> — ${_esc(symbol)} ${badge}`
            : (result === 'loss')
                ? `❌ <b>LOSS</b> — ${_esc(symbol)} ${badge}`
                : `➖ <b>${_esc(String(result || 'unknown').toUpperCase())}</b> — ${_esc(symbol)} ${badge}`;
        const sign = (pnl >= 0 ? '+' : '');

        const lines = [
            head,
            `Entry   : <code>${_esc(entry)}</code>`,
            `Exit    : <code>${_esc(exit)}</code>`,
        ];

        // Duration line — show whenever we know the duration. If the
        // trade was tracked across multiple cycles, append "· N cycles".
        if (duration != null || cyclesToSettle != null) {
            const dlabel = (duration != null)
                ? _durationLabel(duration, durationUnit) : '—';
            const n = Number(cyclesToSettle);
            const cycSuffix = (Number.isFinite(n) && n > 1)
                ? ` · ${n} cycles` : '';
            lines.push(`Duration: <b>${dlabel}</b>${cycSuffix}`);
        }

        lines.push(`P/L     : <b>${sign}${_money(pnl)}</b>`);
        if (Number.isFinite(Number(balance))) {
            lines.push(`Balance : ${_money(balance, currency || 'USD')}`);
        }
        const sess = _sessionLine(session);
        if (sess) lines.push(sess);
        lines.push(`Strategy: <code>${_esc(strategy)}</code>`);
        return lines.join('\n');
    },

    holdSignal({ symbol, reason }) {
        return `⏸️ <b>HOLD</b> — ${_esc(symbol)}\n${_esc(reason)}`;
    },

    dailySummary({ date, mode, trades, wins, losses, pnl }) {
        const badge   = formatBadge(mode);
        const winPct  = trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : '—';
        const sign    = pnl >= 0 ? '+' : '';
        return [
            `📊 <b>Daily Summary</b> — ${_esc(date)} ${badge}`,
            `Trades  : ${trades}`,
            `Wins    : ${wins}`,
            `Losses  : ${losses}`,
            `Win %   : ${winPct}`,
            `P/L     : ${sign}${_money(pnl)}`,
        ].join('\n');
    },

    heartbeatSilent({ lastSeen }) {
        return [
            '⚠️ <b>MOTIONSALT BOT SILENT</b>',
            'No cycle detected in 15 minutes.',
            `Last seen: <code>${_esc(lastSeen)}</code>`,
            'Check cron-job.org and GitHub Actions.',
        ].join('\n');
    },

    errorAlert({ where, message, cycleTs }) {
        return [
            '🚨 <b>BOT ERROR</b>',
            `[${_esc(where)}] ${_esc(message)}`,
            `Cycle: <code>${_esc(cycleTs)}</code>`,
        ].join('\n');
    },

    /* Enriched in v3.1 — adds the running session line so the user
       sees a meaningful summary even on quiet cycles. */
    cycleSummary({ mode, balance, currency, placed, holds, monitored,
                   session, pending }) {
        const badge = formatBadge(mode);
        const lines = [
            `🟢 <b>Cycle</b> ${badge}`,
            `Balance : ${_money(balance, currency)}`,
            `Placed  : ${placed}    Holds: ${holds}    Live: ${monitored}`,
        ];
        if (Number.isFinite(Number(pending)) && Number(pending) > 0) {
            lines.push(`Pending : ${pending}`);
        }
        const sess = _sessionLine(session);
        if (sess) lines.push(sess);
        return lines.join('\n');
    },

    mainMenu({ mode, balance, currency }) {
        const badge = formatBadge(mode);
        return [
            `⚡ <b>MOTIONSALT BOT</b> ${badge}`,
            `Balance: ${_money(balance, currency)}`,
        ].join('\n');
    },

    statusScreen({ mode, balance, currency, lastCycle, tradesToday, pnlToday,
                   winStreak, enabled }) {
        const badge = formatBadge(mode);
        const sign  = pnlToday >= 0 ? '+' : '';
        return [
            `📊 <b>Status</b> ${badge}`,
            '',
            `Balance     : ${_money(balance, currency)}`,
            `Last cycle  : <code>${_esc(lastCycle || '—')}</code>`,
            `Trades today: ${tradesToday}`,
            `P/L today   : ${sign}${_money(pnlToday)}`,
            `Win streak  : ${winStreak}`,
            `Bot         : ${enabled ? '✅ Active' : '⏸️ Paused'}`,
        ].join('\n');
    },
};

/* ─────────────────────────────────────────────────────────────────
   Pre-built inline keyboards
   ───────────────────────────────────────────────────────────────── */
const keyboards = {
    mainMenu: () => buildKeyboard([
        [{ text: '📊 Status',  data: 'status'  }, { text: '📈 Chart',    data: 'chart'   }],
        [{ text: '▶️ Trigger', data: 'trigger' }, { text: '⏸️ Pause',    data: 'pause'   }],
        [{ text: '⚙️ Settings',data: 'settings'}, { text: '📋 Logs',     data: 'logs'    }],
    ]),
    statusScreen: () => buildKeyboard([
        [{ text: '🔄 Refresh', data: 'status' }, { text: '🏠 Menu', data: 'menu' }],
    ]),
    settings: () => buildKeyboard([
        [{ text: '🎯 Risk Mode',  data: 'set:risk'    }, { text: '💰 Stake',    data: 'set:stake'   }],
        [{ text: '📊 Strategies', data: 'set:strats'  }, { text: '🚦 Limits',   data: 'set:limits'  }],
        [{ text: '🔄 Account',    data: 'set:account' }, { text: '⬅️ Back',     data: 'menu'        }],
    ]),
    confirm: (yesData, noData) => buildKeyboard([
        [{ text: '✅ Confirm', data: yesData }, { text: '❌ Cancel', data: noData }],
    ]),
};

module.exports = {
    send,
    sendPhoto,
    editMessage,
    answerCallback,
    buildKeyboard,
    formatBadge,
    templates,
    keyboards,
    _api, // exposed for advanced/raw calls
};
