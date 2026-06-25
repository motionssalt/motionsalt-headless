/* =====================================================================
   MOTIONSALT — Cloudflare Worker (Telegram webhook → GitHub Actions)
   ─────────────────────────────────────────────────────────────────────
   Receives every Telegram update from the bot's webhook and:

     • Whitelists messages: only TELEGRAM_CHAT_ID is allowed in
     • For simple settings changes (toggle strategy, set risk mode,
       set stake, switch account): mutates config.json IN-PLACE via
       the GitHub Contents API — no workflow run needed
     • For "trigger cycle" and other actions that need real bot work:
       calls the GitHub workflow_dispatch endpoint, forwarding the
       Telegram update payload as workflow input
     • For .js file uploads: downloads the file from Telegram CDN,
       validates it, commits to js/strategies/, and replies
     • Heartbeat check: when ANY message arrives, look at the last
       cycle timestamp in last-status.json — if older than 15 min and
       config.enabled === true, send a "BOT SILENT" warning

   ─────────────────────────────────────────────────────────────────────
   Environment variables (set in Cloudflare → Worker → Settings):
     TELEGRAM_BOT_TOKEN     — from @BotFather
     TELEGRAM_CHAT_ID       — your personal chat id (whitelist)
     GITHUB_PAT             — Personal Access Token with repo+workflow
     GITHUB_OWNER           — e.g. "motionssalt"
     GITHUB_REPO            — e.g. "motionsalt-headless"
     GITHUB_WORKFLOW        — e.g. "motionsalt-cron.yml"
     GITHUB_REF             — e.g. "main"

   Deployment:
     1. Workers & Pages → Create Worker
     2. Paste this file's contents in the editor
     3. Settings → Variables → add the env vars above
     4. Visit  https://api.telegram.org/bot<TOKEN>/setWebhook?url=<worker_url>
   ===================================================================== */

const GH_API = 'https://api.github.com';

/* ─────────────────────────────────────────────────────────────────
   SYMBOL_CATALOG — fixed list of Deriv symbols selectable from
   Telegram (Add Symbol picker). No free-form text input — users only
   pick from this list. Add to this array to expose more symbols.
   ───────────────────────────────────────────────────────────────── */
const SYMBOL_CATALOG = [
    // Crypto
    'cryBTCUSD', 'cryETHUSD', 'cryBNBUSD', 'cryXRPUSD',
    'cryLTCUSD', 'cryBCHUSD', 'cryDOTUSD', 'cryADAUSD', 'crySOLUSD',
    // Forex — majors
    'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD',
    'frxUSDCAD', 'frxUSDCHF', 'frxNZDUSD',
    // Forex — crosses
    'frxEURJPY', 'frxEURGBP', 'frxGBPJPY', 'frxAUDJPY',
    'frxEURAUD', 'frxEURCAD', 'frxEURCHF',
    // Volatility (2s)
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    // Volatility (1s)
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
    // Boom / Crash
    'BOOM300N', 'BOOM500',  'BOOM1000',
    'CRASH300N','CRASH500', 'CRASH1000',
    // Jump
    'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
    // Step
    'stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5',
];

/* ─────────────────────────────────────────────────────────────────
   Worker entry
   ───────────────────────────────────────────────────────────────── */
export default {
    async fetch(request, env, ctx) {
        if (request.method !== 'POST') {
            return new Response('motionsalt webhook ok', { status: 200 });
        }
        let update;
        try { update = await request.json(); }
        catch (e) { return new Response('bad json', { status: 400 }); }

        try {
            await handleUpdate(update, env);
        } catch (e) {
            console.error('handleUpdate error', e);
            // Best-effort error notification (only if we know the chat is whitelisted)
            try {
                const chatId = extractChatId(update);
                if (chatId && String(chatId) === String(env.TELEGRAM_CHAT_ID)) {
                    await tgSend(env, `🚨 <b>Worker error</b>\n${escapeHtml(e.message)}`);
                }
            } catch (e2) {}
        }
        // Telegram doesn't care about body — return 200 fast so it doesn't retry
        return new Response('ok', { status: 200 });
    }
};

/* ─────────────────────────────────────────────────────────────────
   Update router
   ───────────────────────────────────────────────────────────────── */
function extractChatId(update) {
    if (update.message)         return update.message.chat && update.message.chat.id;
    if (update.callback_query)  return update.callback_query.message
                                    && update.callback_query.message.chat
                                    && update.callback_query.message.chat.id;
    if (update.edited_message)  return update.edited_message.chat && update.edited_message.chat.id;
    return null;
}

async function handleUpdate(update, env) {
    const chatId = extractChatId(update);
    if (!chatId || String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
        // Silently drop (security)
        return;
    }

    // Heartbeat alert (best-effort)
    await maybeAlertSilent(env);

    if (update.callback_query)        return handleCallback(update.callback_query, env);
    if (update.message) {
        const m = update.message;
        if (m.document)               return handleDocument(m, env);
        if (m.text)                   return handleText(m, env);
    }
}

/* ─────────────────────────────────────────────────────────────────
   Text command handler
   ───────────────────────────────────────────────────────────────── */
async function handleText(message, env) {
    const text = (message.text || '').trim();
    const [cmd, ...args] = text.split(/\s+/);

    const config = await ghReadJSON(env, 'config.json').catch(() => null);
    const state  = await ghReadJSON(env, 'last-status.json').catch(() => null);

    switch (cmd) {
        case '/start':
        case '/menu':
            return tgSend(env, renderMenu(config, state), { reply_markup: KB.mainMenu() });

        case '/status':
            return tgSend(env, renderStatus(config, state), { reply_markup: KB.statusScreen() });

        case '/balance':
            return tgSend(env,
                `${badge(config)} Balance: <b>$${fmt2(state && state.balance)}</b>`);

        case '/trigger':
            await dispatchWorkflow(env, { task: 'cycle' });
            return tgSend(env, '▶️ Cycle triggered. Watch GitHub Actions for the run.');

        case '/pause':
            return tgSend(env, '⏸️ Pause bot? No new trades will be placed.',
                { reply_markup: KB.confirm('do:pause', 'menu') });

        case '/resume': {
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.enabled = true;
            await ghWriteJSON(env, 'config.json', cfg, 'bot: resume');
            return tgSend(env, '▶️ Bot resumed.');
        }

        case '/logs':
            return tgSend(env, renderLogs(state, 1, 'all'), { reply_markup: KB.logs(1) });

        case '/setstake': {
            const v = Number(args[0]);
            if (!Number.isFinite(v) || v <= 0) return tgSend(env, '⚠️ Usage: <code>/setstake 2.5</code>');
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.risk.fixed_stake = v;
            await ghWriteJSON(env, 'config.json', cfg, `bot: set fixed_stake=${v}`);
            return tgSend(env, `✅ Fixed stake set to <b>$${fmt2(v)}</b>.`);
        }

        case '/setrisk': {
            const mode = String(args[0] || '').toLowerCase();
            const allowed = ['fixed', 'fractional', 'martingale', 'antimartingale', 'confidence'];
            if (!allowed.includes(mode))
                return tgSend(env, `⚠️ Usage: <code>/setrisk &lt;${allowed.join('|')}&gt;</code>`);
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.risk.mode = mode;
            await ghWriteJSON(env, 'config.json', cfg, `bot: set risk.mode=${mode}`);
            return tgSend(env, `✅ Risk mode set to <b>${mode}</b>.`);
        }

        case '/setlimit': {
            const key = args[0], v = Number(args[1]);
            const map = { dailyloss: 'daily_loss_pct', maxstreak: 'max_loss_streak',
                          maxtrades: 'max_trades_per_cycle', takeprofit: 'take_profit',
                          stoploss: 'stop_loss', minpayout: 'min_payout_pct' };
            if (!map[key] || !Number.isFinite(v))
                return tgSend(env, `⚠️ Usage: <code>/setlimit ${Object.keys(map).join('|')} &lt;value&gt;</code>`);
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.limits[map[key]] = v;
            await ghWriteJSON(env, 'config.json', cfg, `bot: set limit ${map[key]}=${v}`);
            return tgSend(env, `✅ Limit <b>${map[key]}</b> set to <b>${v}</b>.`);
        }

        case '/chart': {
            // If symbol + tf supplied: /chart cryBTCUSD 1m → fire directly
            if (args[0] && args[1]) {
                const sym = args[0], tf = args[1];
                await dispatchWorkflow(env, {
                    task: 'manual',
                    payload: JSON.stringify({ action: 'chart', symbol: sym, tf }),
                });
                return tgSend(env, `📈 Chart for <b>${escapeHtml(sym)}</b> <code>${tf}</code> queued.`);
            }
            // Otherwise show picker built from the user's enabled symbols
            return tgSend(env, '📈 <b>Chart — Select Symbol</b>', { reply_markup: KB.chartSymbol(config) });
        }

        case '/mode': {
            const m = String(args[0] || '').toLowerCase();
            if (m !== 'demo' && m !== 'real')
                return tgSend(env, '⚠️ Usage: <code>/mode demo</code> or <code>/mode real</code>');
            if (m === 'real') {
                return tgSend(env, '⚠️ <b>Switch to REAL account?</b>\nReal money will be traded.',
                    { reply_markup: KB.confirm('do:mode:real', 'menu') });
            }
            const cfg = await ghReadJSON(env, 'config.json');
            cfg.account.mode = 'demo';
            await ghWriteJSON(env, 'config.json', cfg, 'bot: switch to DEMO');
            return tgSend(env, '🟡 Switched to <b>DEMO</b>.');
        }

        default:
            return tgSend(env, renderMenu(config, state), { reply_markup: KB.mainMenu() });
    }
}

/* ─────────────────────────────────────────────────────────────────
   Callback (button) handler
   ───────────────────────────────────────────────────────────────── */
async function handleCallback(cb, env) {
    const data = String(cb.data || '');
    await tgAnswerCallback(env, cb.id);

    const config = await ghReadJSON(env, 'config.json').catch(() => null);
    const state  = await ghReadJSON(env, 'last-status.json').catch(() => null);

    // Simple navigation
    if (data === 'menu')
        return tgEdit(env, cb, renderMenu(config, state),    KB.mainMenu());
    if (data === 'status')
        return tgEdit(env, cb, renderStatus(config, state),  KB.statusScreen());
    if (data === 'settings' || data === 'set:open')
        return tgEdit(env, cb, '⚙️ <b>Settings</b>',         KB.settings());
    if (data === 'set:risk')
        return tgEdit(env, cb, '🎯 <b>Risk Mode</b>',        KB.riskMode(config));
    if (data === 'set:strats')
        return tgEdit(env, cb, '📊 <b>Strategies</b>',       KB.strategies(config));
    if (data === 'set:symbols')
        return tgEdit(env, cb, '📡 <b>Symbols</b>',           KB.symbols(config));
    if (data === 'set:account')
        return tgEdit(env, cb, renderAccount(config),        KB.account(config));
    if (data === 'set:limits')
        return tgEdit(env, cb, renderLimits(config),         KB.settings());
    if (data === 'set:stake')
        return tgEdit(env, cb, renderStake(config),          KB.settings());
    if (data === 'set:payout')
        return tgEdit(env, cb, renderPayout(config),         KB.settings());
    if (data === 'logs')
        return tgEdit(env, cb, renderLogs(state, 1, 'all'),  KB.logs(1));

    if (data === 'trigger') {
        await dispatchWorkflow(env, { task: 'cycle' });
        return tgEdit(env, cb, '▶️ Cycle triggered.', KB.mainMenu());
    }
    if (data === 'pause') {
        return tgEdit(env, cb, '⏸️ <b>Pause bot?</b>\nNo new trades will be placed.',
            KB.confirm('do:pause', 'menu'));
    }
    if (data === 'do:pause') {
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.enabled = false;
        await ghWriteJSON(env, 'config.json', cfg, 'bot: pause');
        return tgEdit(env, cb, '⏸️ Bot paused.', KB.mainMenu());
    }
    if (data === 'chart')
        return tgEdit(env, cb, '📈 <b>Chart — Select Symbol</b>', KB.chartSymbol(config));

    if (data.startsWith('chart:sym:')) {
        const sym = data.slice('chart:sym:'.length);
        return tgEdit(env, cb,
            `📈 <b>${escapeHtml(sym)}</b> — Select Timeframe`,
            KB.chartTf(sym));
    }

    if (data.startsWith('chart:go:')) {
        const parts = data.split(':');
        // format: chart:go:SYMBOL:TF  (symbol may contain colons — rejoin)
        const tf  = parts[parts.length - 1];
        const sym = parts.slice(2, parts.length - 1).join(':');
        await dispatchWorkflow(env, {
            task: 'manual',
            payload: JSON.stringify({ action: 'chart', symbol: sym, tf }),
        });
        return tgEdit(env, cb,
            `📈 Chart for <b>${escapeHtml(sym)}</b> <code>${tf}</code> queued.\nIt will arrive shortly.`,
            KB.mainMenu());
    }

    // Risk mode toggle
    if (data.startsWith('risk:')) {
        const mode = data.slice(5);
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.risk.mode = mode;
        await ghWriteJSON(env, 'config.json', cfg, `bot: risk.mode=${mode}`);
        return tgEdit(env, cb, `✅ Risk mode → <b>${mode}</b>`, KB.riskMode(cfg));
    }

    // Strategy toggle
    if (data.startsWith('strat:')) {
        const sid = data.slice(6);
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.strategies = cfg.strategies || {};
        cfg.strategies[sid] = !cfg.strategies[sid];
        await ghWriteJSON(env, 'config.json', cfg,
            `bot: ${cfg.strategies[sid] ? 'enable' : 'disable'} ${sid}`);
        return tgEdit(env, cb, '📊 <b>Strategies</b>', KB.strategies(cfg));
    }

    // Symbols — open Add picker (catalog minus already-present)
    if (data === 'sym:add') {
        return tgEdit(env, cb,
            '➕ <b>Add Symbol</b> — pick one to add (enabled by default)',
            KB.symbolsAdd(config));
    }
    // Symbols — open Remove picker
    if (data === 'sym:rm') {
        return tgEdit(env, cb,
            '🗑 <b>Remove Symbol</b> — pick one to remove from config',
            KB.symbolsRemove(config));
    }
    // Symbols — add a symbol from the catalog
    if (data.startsWith('symadd:')) {
        const sym = data.slice('symadd:'.length);
        if (!SYMBOL_CATALOG.includes(sym)) {
            return tgEdit(env, cb, '⚠️ Unknown symbol.', KB.symbols(config));
        }
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.symbols = cfg.symbols || {};
        if (Object.prototype.hasOwnProperty.call(cfg.symbols, sym)) {
            return tgEdit(env, cb,
                `ℹ️ <code>${escapeHtml(sym)}</code> already in config.`,
                KB.symbols(cfg));
        }
        cfg.symbols[sym] = true;
        await ghWriteJSON(env, 'config.json', cfg, `bot: add symbol ${sym}`);
        return tgEdit(env, cb,
            `✅ Added <code>${escapeHtml(sym)}</code> (enabled).`,
            KB.symbols(cfg));
    }
    // Symbols — remove confirm prompt
    if (data.startsWith('symrm:ask:')) {
        const sym = data.slice('symrm:ask:'.length);
        return tgEdit(env, cb,
            `🗑 <b>Remove <code>${escapeHtml(sym)}</code> from config?</b>\nThis deletes the key (not just disables).`,
            KB.confirm(`symrm:do:${sym}`, 'set:symbols'));
    }
    // Symbols — remove confirm action
    if (data.startsWith('symrm:do:')) {
        const sym = data.slice('symrm:do:'.length);
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.symbols = cfg.symbols || {};
        if (!Object.prototype.hasOwnProperty.call(cfg.symbols, sym)) {
            return tgEdit(env, cb,
                `ℹ️ <code>${escapeHtml(sym)}</code> not in config.`,
                KB.symbols(cfg));
        }
        delete cfg.symbols[sym];
        await ghWriteJSON(env, 'config.json', cfg, `bot: remove symbol ${sym}`);
        return tgEdit(env, cb,
            `🗑 Removed <code>${escapeHtml(sym)}</code>.`,
            KB.symbols(cfg));
    }
    // Symbol enable/disable toggle (must come AFTER sym:add / sym:rm /
    // symadd: / symrm: branches since 'sym:' is a prefix of all of them)
    if (data.startsWith('sym:')) {
        const sym = data.slice(4);
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.symbols = cfg.symbols || {};
        if (!Object.prototype.hasOwnProperty.call(cfg.symbols, sym)) {
            return tgEdit(env, cb,
                `⚠️ <code>${escapeHtml(sym)}</code> not in config. Add it first.`,
                KB.symbols(cfg));
        }
        cfg.symbols[sym] = !cfg.symbols[sym];
        await ghWriteJSON(env, 'config.json', cfg,
            `bot: ${cfg.symbols[sym] ? 'enable' : 'disable'} ${sym}`);
        return tgEdit(env, cb, '📡 <b>Symbols</b>', KB.symbols(cfg));
    }

    // Account switch confirmations
    if (data === 'acct:real') {
        return tgEdit(env, cb,
            '⚠️ <b>Switch to REAL account?</b>\nReal money will be traded.',
            KB.confirm('do:mode:real', 'set:account'));
    }
    if (data === 'acct:demo') {
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.account.mode = 'demo';
        await ghWriteJSON(env, 'config.json', cfg, 'bot: switch to DEMO');
        return tgEdit(env, cb, '🟡 Switched to <b>DEMO</b>.', KB.account(cfg));
    }
    if (data === 'do:mode:real') {
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.account.mode = 'real';
        await ghWriteJSON(env, 'config.json', cfg, 'bot: switch to REAL');
        return tgEdit(env, cb, '🔴 Switched to <b>REAL</b>.', KB.account(cfg));
    }

    // Strategy deploy (after upload)
    if (data.startsWith('deploy:')) {
        const filename = data.slice(7);
        return tgEdit(env, cb,
            `✅ Strategy <code>${escapeHtml(filename)}</code> already committed. Enable it?`,
            KB.confirm(`enable:${filename}`, 'menu'));
    }
    if (data.startsWith('enable:')) {
        const filename = data.slice(7);
        const id = filename.replace(/\.js$/, '');
        const cfg = await ghReadJSON(env, 'config.json');
        cfg.strategies = cfg.strategies || {};
        cfg.strategies[id] = true;
        await ghWriteJSON(env, 'config.json', cfg, `bot: enable ${id}`);
        return tgEdit(env, cb, `✅ <code>${escapeHtml(id)}</code> enabled.`, KB.mainMenu());
    }

    // Logs pagination
    if (data.startsWith('logs:')) {
        const [, page, filter] = data.split(':');
        return tgEdit(env, cb,
            renderLogs(state, Number(page) || 1, filter || 'all'),
            KB.logs(Number(page) || 1, filter || 'all'));
    }

    return tgEdit(env, cb, renderMenu(config, state), KB.mainMenu());
}

/* ─────────────────────────────────────────────────────────────────
   Document upload (strategy .js)
   ───────────────────────────────────────────────────────────────── */
async function handleDocument(message, env) {
    const doc = message.document;
    const name = String(doc.file_name || '').trim();
    if (!name.endsWith('.js')) {
        return tgSend(env, `⚠️ Only .js files are accepted (got <code>${escapeHtml(name)}</code>).`);
    }
    // Resolve file path via Telegram
    const r = await tgApi(env, 'getFile', { file_id: doc.file_id });
    if (!r || !r.ok) return tgSend(env, '⚠️ Could not fetch file from Telegram.');
    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${r.result.file_path}`;
    const src = await fetch(fileUrl).then(x => x.text());

    // Basic validation
    const checks = ['id:', 'name:'];
    const missing = checks.filter(s => !src.includes(s));
    // Accept either v2 (onTick) or v3 (onClosedBar) contract
    if (!src.includes('onTick') && !src.includes('onClosedBar')) {
        missing.push('onTick or onClosedBar');
    }
    if (missing.length) {
        return tgSend(env, `❌ Validation failed — missing: <code>${missing.join(', ')}</code>`);
    }

    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const ghPath = `js/strategies/${safeName}`;
    await ghPutFile(env, ghPath, src, `bot: upload strategy ${safeName}`);
    return tgSend(env,
        `✅ Validated and committed <code>${escapeHtml(safeName)}</code>. Deploy?`,
        { reply_markup: KB.confirm(`deploy:${safeName}`, 'menu') });
}

/* ─────────────────────────────────────────────────────────────────
   Heartbeat — warn if no cycle in 15+ min and bot says enabled
   ───────────────────────────────────────────────────────────────── */
async function maybeAlertSilent(env) {
    try {
        const cfg   = await ghReadJSON(env, 'config.json');
        const state = await ghReadJSON(env, 'last-status.json');
        if (!cfg || !cfg.enabled || !state || !state.last_cycle) return;
        const ageMs = Date.now() - new Date(state.last_cycle).getTime();
        if (ageMs > 15 * 60 * 1000) {
            // Throttle: only alert once per 15-min window via a marker file
            const marker = await ghReadFile(env, '.heartbeat-alert').catch(() => null);
            const lastWarn = marker ? Number(marker.trim()) : 0;
            if (Date.now() - lastWarn < 15 * 60 * 1000) return;
            await ghPutFile(env, '.heartbeat-alert', String(Date.now()), 'bot: heartbeat alert');
            await tgSend(env,
                `⚠️ <b>MOTIONSALT BOT SILENT</b>\nNo cycle detected in 15 minutes.\nLast seen: <code>${escapeHtml(state.last_cycle)}</code>\nCheck cron-job.org and GitHub Actions.`);
        }
    } catch (e) {
        console.warn('heartbeat check failed', e.message);
    }
}

/* ─────────────────────────────────────────────────────────────────
   GitHub Contents API helpers
   ───────────────────────────────────────────────────────────────── */
function ghHeaders(env) {
    return {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept:        'application/vnd.github+json',
        'User-Agent':  'motionsalt-worker',
        'Content-Type':'application/json',
    };
}

async function ghReadFile(env, path) {
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${env.GITHUB_REF || 'main'}`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) throw new Error(`gh read ${path}: ${r.status}`);
    const j = await r.json();
    const txt = atob(j.content.replace(/\n/g, ''));
    return txt;
}

async function ghReadJSON(env, path) {
    const txt = await ghReadFile(env, path);
    return JSON.parse(txt);
}

async function ghGetSha(env, path) {
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${env.GITHUB_REF || 'main'}`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`gh sha ${path}: ${r.status}`);
    const j = await r.json();
    return j.sha;
}

async function ghPutFile(env, path, content, message) {
    const sha = await ghGetSha(env, path);
    const body = {
        message: message || `bot: update ${path}`,
        content: btoa(unescape(encodeURIComponent(content))),
        branch:  env.GITHUB_REF || 'main',
    };
    if (sha) body.sha = sha;
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const r = await fetch(url, {
        method: 'PUT', headers: ghHeaders(env), body: JSON.stringify(body)
    });
    if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`gh put ${path}: ${r.status} ${txt.slice(0,120)}`);
    }
    return r.json();
}

async function ghWriteJSON(env, path, obj, message) {
    return ghPutFile(env, path, JSON.stringify(obj, null, 2) + '\n', message);
}

/* ─────────────────────────────────────────────────────────────────
   workflow_dispatch
   ───────────────────────────────────────────────────────────────── */
async function dispatchWorkflow(env, inputs = {}) {
    const wf = env.GITHUB_WORKFLOW || 'motionsalt-cron.yml';
    const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(wf)}/dispatches`;
    const body = { ref: env.GITHUB_REF || 'main', inputs };
    const r = await fetch(url, {
        method: 'POST', headers: ghHeaders(env), body: JSON.stringify(body)
    });
    if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`workflow_dispatch: ${r.status} ${txt.slice(0,120)}`);
    }
    return true;
}

/* ─────────────────────────────────────────────────────────────────
   Telegram helpers (worker-side; mirrors telegram.js semantics)
   ───────────────────────────────────────────────────────────────── */
async function tgApi(env, method, payload) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return r.json().catch(() => ({}));
}
async function tgSend(env, text, opts = {}) {
    return tgApi(env, 'sendMessage', {
        chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: opts.reply_markup,
    });
}
async function tgEdit(env, cb, text, replyMarkup) {
    return tgApi(env, 'editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text, parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
    });
}
async function tgAnswerCallback(env, id, text) {
    return tgApi(env, 'answerCallbackQuery',
        { callback_query_id: id, text: text || '' });
}

/* ─────────────────────────────────────────────────────────────────
   Render helpers (mirror telegram.js templates)
   ───────────────────────────────────────────────────────────────── */
function badge(cfg) {
    const mode = cfg && cfg.account && cfg.account.mode;
    return mode === 'real' ? '🔴 REAL' : '🟡 DEMO';
}
function fmt2(n) { return (Number(n) || 0).toFixed(2); }
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMenu(cfg, state) {
    return [
        `⚡ <b>MOTIONSALT BOT</b> ${badge(cfg)}`,
        `Balance: <b>$${fmt2(state && state.balance)}</b>`,
    ].join('\n');
}
function renderStatus(cfg, state) {
    if (!state) return `${badge(cfg)} (no state)`;
    const s = state.session || {};
    const sign = (s.pnl || 0) >= 0 ? '+' : '';
    return [
        `📊 <b>Status</b> ${badge(cfg)}`,
        '',
        `Balance     : <b>$${fmt2(state.balance)}</b>`,
        `Last cycle  : <code>${escapeHtml(state.last_cycle || '—')}</code>`,
        `Trades today: ${s.trades || 0}`,
        `P/L today   : ${sign}$${fmt2(Math.abs(s.pnl || 0))}`,
        `Win streak  : ${s.win_streak || 0}`,
        `Bot         : ${cfg && cfg.enabled ? '✅ Active' : '⏸️ Paused'}`,
    ].join('\n');
}
function renderAccount(cfg) {
    const m = cfg && cfg.account && cfg.account.mode;
    const id = (m === 'real') ? cfg.account.real_id : cfg.account.demo_id;
    return [
        `🔄 <b>Account</b>`, '',
        `${badge(cfg)} Currently: <b>${m ? m.toUpperCase() : '—'}</b> (<code>${escapeHtml(id || '—')}</code>)`,
    ].join('\n');
}
function renderLimits(cfg) {
    const l = (cfg && cfg.limits) || {};
    return [
        `🚦 <b>Limits</b>`, '',
        `daily_loss_pct      : <b>${l.daily_loss_pct ?? '—'}</b>`,
        `max_loss_streak     : <b>${l.max_loss_streak ?? '—'}</b>`,
        `max_trades_per_cycle: <b>${l.max_trades_per_cycle ?? '—'}</b>`,
        `take_profit         : <b>${l.take_profit ?? 0}</b>`,
        `stop_loss           : <b>${l.stop_loss ?? 0}</b>`,
        `min_payout_pct      : <b>${l.min_payout_pct ?? 0}%</b>`,
        '',
        '<i>Edit with /setlimit dailyloss 10</i>',
        '<i>Or       /setlimit minpayout 80</i>',
    ].join('\n');
}
function renderPayout(cfg) {
    const l = (cfg && cfg.limits) || {};
    return [
        `💵 <b>Payout Threshold</b>`, '',
        `min_payout_pct: <b>${l.min_payout_pct ?? 0}%</b>`,
        '',
        'Trades below this payout % are skipped.',
        '',
        '<i>Edit with /setlimit minpayout 80</i>',
    ].join('\n');
}
function renderStake(cfg) {
    const r = (cfg && cfg.risk) || {};
    return [
        `💰 <b>Stake</b>`, '',
        `mode             : <b>${r.mode || '—'}</b>`,
        `fixed_stake      : <b>$${fmt2(r.fixed_stake)}</b>`,
        `fractional_pct   : <b>${r.fractional_pct ?? '—'}%</b>`,
        `max_stake        : <b>$${fmt2(r.max_stake)}</b>`,
        '',
        '<i>Edit with /setstake 2.5</i>',
    ].join('\n');
}
function renderLogs(state, page = 1, filter = 'all') {
    if (!state || !Array.isArray(state.logs)) return '📋 No logs yet.';
    const pageSize = 10;
    let logs = state.logs.slice().reverse();
    if (filter === 'trades')  logs = logs.filter(l => l.level === 'trade');
    if (filter === 'signals') logs = logs.filter(l => l.level === 'signal');
    if (filter === 'errors')  logs = logs.filter(l => l.level === 'error' || l.level === 'warn');
    const totalPages = Math.max(1, Math.ceil(logs.length / pageSize));
    page = Math.min(Math.max(1, page), totalPages);
    const slice = logs.slice((page - 1) * pageSize, page * pageSize);
    const lines = slice.map(l => {
        const t = (l.ts || '').slice(11, 16);
        const lvl = (l.level || '').padEnd(7);
        return `${t} ${lvl} ${escapeHtml(l.msg).slice(0, 80)}`;
    });
    return [
        `📋 <b>Logs — ${filter} (Page ${page}/${totalPages})</b>`,
        '',
        '<code>' + (lines.join('\n') || '(empty)') + '</code>',
    ].join('\n');
}

/* ─────────────────────────────────────────────────────────────────
   Inline keyboards (worker-side mirror)
   ───────────────────────────────────────────────────────────────── */
function kb(rows) {
    return { inline_keyboard: rows.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) };
}
const KB = {
    mainMenu: () => kb([
        [{ text: '📊 Status',  data: 'status'  }, { text: '📈 Chart',    data: 'chart'   }],
        [{ text: '▶️ Trigger', data: 'trigger' }, { text: '⏸️ Pause',    data: 'pause'   }],
        [{ text: '⚙️ Settings',data: 'settings'}, { text: '📋 Logs',     data: 'logs'    }],
    ]),
    statusScreen: () => kb([
        [{ text: '🔄 Refresh', data: 'status' }, { text: '🏠 Menu', data: 'menu' }],
    ]),
    settings: () => kb([
        [{ text: '🎯 Risk Mode',  data: 'set:risk'    }, { text: '💰 Stake',    data: 'set:stake'   }],
        [{ text: '📊 Strategies', data: 'set:strats'  }, { text: '🚦 Limits',   data: 'set:limits'  }],
        [{ text: '📡 Symbols',    data: 'set:symbols' }, { text: '🔄 Account',  data: 'set:account' }],
        [{ text: '💵 Payout',     data: 'set:payout'  }],
        [{ text: '⬅️ Back',       data: 'menu'        }],
    ]),
    riskMode: (cfg) => {
        const m = (cfg && cfg.risk && cfg.risk.mode) || '';
        const mark = (x) => (m === x ? '✅ ' : '');
        return kb([
            [{ text: `${mark('fractional')}Fractional`, data: 'risk:fractional' },
             { text: `${mark('fixed')}Fixed`,           data: 'risk:fixed' }],
            [{ text: `${mark('antimartingale')}Anti-Martingale`, data: 'risk:antimartingale' },
             { text: `${mark('martingale')}Martingale`, data: 'risk:martingale' }],
            [{ text: `${mark('confidence')}Confidence`, data: 'risk:confidence' }],
            [{ text: '⬅️ Back', data: 'settings' }],
        ]);
    },
    strategies: (cfg) => {
        const s = (cfg && cfg.strategies) || {};
        const ids = Object.keys(s);
        const rows = [];
        for (let i = 0; i < ids.length; i += 2) {
            const row = [];
            for (const id of ids.slice(i, i + 2)) {
                row.push({ text: `${s[id] ? '✅' : '❌'} ${id}`, data: `strat:${id}` });
            }
            rows.push(row);
        }
        rows.push([{ text: '⬅️ Back', data: 'settings' }]);
        return kb(rows);
    },
    symbols: (cfg) => {
        const s = (cfg && cfg.symbols) || {};
        const ids = Object.keys(s);
        const rows = [];
        // Toggle row(s) for each symbol currently in config — 2 per row
        for (let i = 0; i < ids.length; i += 2) {
            const row = [];
            for (const sym of ids.slice(i, i + 2)) {
                row.push({
                    text: `${s[sym] ? '✅' : '❌'} ${sym}`,
                    data: `sym:${sym}`,
                });
            }
            rows.push(row);
        }
        if (ids.length === 0) {
            rows.push([{ text: '(no symbols — tap Add)', data: 'sym:add' }]);
        }
        rows.push([
            { text: '➕ Add',    data: 'sym:add' },
            { text: '🗑 Remove', data: 'sym:rm'  },
        ]);
        rows.push([{ text: '⬅️ Back', data: 'settings' }]);
        return kb(rows);
    },
    // Picker: catalog symbols NOT yet present in config — tap to add
    symbolsAdd: (cfg) => {
        const have = (cfg && cfg.symbols) || {};
        const available = SYMBOL_CATALOG.filter(
            sym => !Object.prototype.hasOwnProperty.call(have, sym)
        );
        const rows = [];
        for (let i = 0; i < available.length; i += 2) {
            const row = available.slice(i, i + 2).map(sym => ({
                text: `➕ ${sym}`, data: `symadd:${sym}`,
            }));
            rows.push(row);
        }
        if (available.length === 0) {
            rows.push([{ text: '(catalog exhausted)', data: 'set:symbols' }]);
        }
        rows.push([{ text: '⬅️ Back', data: 'set:symbols' }]);
        return kb(rows);
    },
    // Picker: symbols currently in config — tap to start remove flow
    symbolsRemove: (cfg) => {
        const have = (cfg && cfg.symbols) || {};
        const ids = Object.keys(have);
        const rows = [];
        for (let i = 0; i < ids.length; i += 2) {
            const row = ids.slice(i, i + 2).map(sym => ({
                text: `🗑 ${sym}`, data: `symrm:ask:${sym}`,
            }));
            rows.push(row);
        }
        if (ids.length === 0) {
            rows.push([{ text: '(nothing to remove)', data: 'set:symbols' }]);
        }
        rows.push([{ text: '⬅️ Back', data: 'set:symbols' }]);
        return kb(rows);
    },
    account: (cfg) => {
        const m = cfg && cfg.account && cfg.account.mode;
        const other = m === 'real' ? 'demo' : 'real';
        return kb([
            [{ text: `Switch to ${other === 'real' ? '🔴 REAL' : '🟡 DEMO'}`,
               data: `acct:${other}` }],
            [{ text: '⬅️ Back', data: 'settings' }],
        ]);
    },
    confirm: (yes, no) => kb([
        [{ text: '✅ Confirm', data: yes }, { text: '❌ Cancel', data: no }],
    ]),
    logs: (page = 1, filter = 'all') => kb([
        [{ text: 'All',     data: `logs:1:all`     },
         { text: 'Trades',  data: `logs:1:trades`  },
         { text: 'Signals', data: `logs:1:signals` },
         { text: 'Errors',  data: `logs:1:errors`  }],
        [{ text: '◀️ Prev', data: `logs:${Math.max(1, page-1)}:${filter}` },
         { text: `Page ${page}`, data: `logs:${page}:${filter}` },
         { text: '▶️ Next', data: `logs:${page+1}:${filter}` }],
        [{ text: '🏠 Menu', data: 'menu' }],
    ]),

    // Built dynamically from the user's currently ENABLED symbols in
    // config.symbols (not the hard-coded catalog). This means anything
    // the user adds via the Symbols menu — including custom additions
    // beyond SYMBOL_CATALOG — becomes chartable as long as it's toggled
    // on. If no symbols are enabled we fall back to a static safety
    // list so the chart button is never a dead end.
    chartSymbol: (cfg) => {
        const all = (cfg && cfg.symbols) || {};
        const enabled = Object.keys(all).filter(k => all[k]);
        const rows = [];
        if (enabled.length === 0) {
            // Fallback: a tiny safety set if the user hasn't enabled
            // anything yet (so /chart still works on a fresh install).
            const safety = ['cryBTCUSD', 'cryETHUSD',
                            'frxEURUSD', 'frxGBPUSD',
                            'R_10', 'R_100'];
            for (let i = 0; i < safety.length; i += 2) {
                rows.push(safety.slice(i, i + 2).map(sym => ({
                    text: sym, data: `chart:sym:${sym}`,
                })));
            }
            rows.push([{ text: '⚠️ No enabled symbols — add some in Settings',
                         data: 'set:symbols' }]);
        } else {
            // 2 per row, sorted so the order is stable across cycles.
            const sorted = enabled.slice().sort();
            for (let i = 0; i < sorted.length; i += 2) {
                rows.push(sorted.slice(i, i + 2).map(sym => ({
                    text: sym, data: `chart:sym:${sym}`,
                })));
            }
        }
        rows.push([{ text: '⬅️ Back', data: 'menu' }]);
        return kb(rows);
    },

    chartTf: (sym) => kb([
        [{ text: '1m',  data: `chart:go:${sym}:1m`  },
         { text: '5m',  data: `chart:go:${sym}:5m`  },
         { text: '15m', data: `chart:go:${sym}:15m` }],
        [{ text: '30m', data: `chart:go:${sym}:30m` },
         { text: '1h',  data: `chart:go:${sym}:1h`  }],
        [{ text: '⬅️ Back', data: 'chart' }],
    ]),
};

