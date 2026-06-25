# MOTIONSALT Deriv Bot — Setup Guide

A headless, serverless trading bot for the Deriv platform.
Runs on GitHub Actions, controlled 100 % from Telegram.

This document walks you through every step needed to get from a fresh
fork to a fully working bot — no prior infrastructure required.

---

## 1. Fork / create the repo on GitHub

* Name suggestion: **`motionsalt-headless`**
* Visibility: **private** is recommended (keeps your state file out of public view).
* Make sure the default branch is `main`.

If you already cloned this scaffold, just `git init` + push to a new GitHub repo.

---

## 2. Get your Deriv OAuth credentials

The bot does NOT use a simple API token. It uses an **OAuth Bearer token**
that can authorize multiple accounts.

1. Sign in at <https://app.deriv.com/>.
2. Create a Deriv App: <https://app.deriv.com/account/api-token> → *Manage Apps*.
3. Note the **App ID** (`DERIV_APP_ID`, e.g. `98200`).
4. Generate / obtain your **Bearer token** (`DERIV_BEARER_TOKEN`).
   This is the token used in `Authorization: Bearer <token>` headers.
5. Find your account login IDs:
   * **Real** account looks like `ROT91874193`
   * **Demo** account looks like `DOT93176227`

   You can confirm the IDs by calling, with the bearer token:
   ```
   GET https://api.derivws.com/trading/v1/options/accounts
   Authorization: Bearer <DERIV_BEARER_TOKEN>
   Deriv-App-ID:  <DERIV_APP_ID>
   ```

---

## 3. Create a Telegram bot

1. Open Telegram and message **@BotFather**.
2. Send `/newbot`, follow the prompts. Copy the API token — that's `TELEGRAM_BOT_TOKEN`.
3. Message **@userinfobot** to discover your numeric chat ID — that's `TELEGRAM_CHAT_ID`.
   This is the **only** chat allowed to control the bot.

---

## 4. Create the GitHub Personal Access Token

The bot needs to commit state files (and to be triggered by the worker).

1. GitHub → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens*.
2. Create a token with:
   * **Repository access**: only the `motionsalt-headless` repo.
   * **Permissions** → *Actions: Read & Write*, *Contents: Read & Write*,
     *Metadata: Read*.
3. Copy the token. Save it as `PAT_TOKEN` later.

---

## 5. Add GitHub Secrets

Repo → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*.

| Secret name            | Value                                  |
|------------------------|----------------------------------------|
| `DERIV_BEARER_TOKEN`   | your Deriv OAuth bearer token          |
| `DERIV_APP_ID`         | your Deriv App ID (e.g. `98200`)       |
| `DERIV_REAL_ID`        | real account loginid (e.g. `ROT9…`)    |
| `DERIV_DEMO_ID`        | demo account loginid (e.g. `DOT9…`)    |
| `TELEGRAM_BOT_TOKEN`   | from @BotFather                        |
| `TELEGRAM_CHAT_ID`     | from @userinfobot                      |
| `PAT_TOKEN`            | the fine-grained token from step 4     |

> 💡 The workflow file references `secrets.PAT_TOKEN` (not `GITHUB_PAT`)
> for clarity — make sure the secret is named exactly **`PAT_TOKEN`**.

---

## 6. Update `config.json`

Edit `config.json` in the repo and put your actual `real_id` / `demo_id`
into the `account` block. Set `account.mode` to `"demo"` until you're
confident everything works.

Toggle which strategies you want enabled in the `strategies` map.

---

## 7. Deploy the Cloudflare Worker

The worker is the Telegram webhook + GitHub relay.

1. Sign up at <https://cloudflare.com/> (free tier is enough).
2. Workers & Pages → **Create Worker**.
3. Open the worker editor and **replace the default code** with the
   contents of `worker/index.js` from this repo.
4. *Settings* → *Variables and Secrets* → add **all** of:

   | Name                 | Value                                         |
   |----------------------|-----------------------------------------------|
   | `TELEGRAM_BOT_TOKEN` | from @BotFather                               |
   | `TELEGRAM_CHAT_ID`   | from @userinfobot                             |
   | `GITHUB_PAT`         | the same fine-grained PAT from step 4         |
   | `GITHUB_OWNER`       | your GitHub username/org (e.g. `motionssalt`) |
   | `GITHUB_REPO`        | `motionsalt-headless`                         |
   | `GITHUB_WORKFLOW`    | `motionsalt-cron.yml`                         |
   | `GITHUB_REF`         | `main`                                        |

5. Deploy. Copy your worker URL, e.g. `https://motionsalt.<you>.workers.dev`.

---

## 8. Register the Telegram webhook

Open this URL in your browser (substitute your values):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>
```

You should see:

```json
{ "ok": true, "result": true, "description": "Webhook was set" }
```

To confirm later:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
```

---

## 9. Set up cron-job.org (the 5-minute trigger)

GitHub Actions has no native 5-minute cron (and even built-in `schedule:` is
unreliable), so we use **<https://cron-job.org>** (free).

### 9a. Main cycle every 5 minutes

* URL: `https://api.github.com/repos/<OWNER>/<REPO>/actions/workflows/motionsalt-cron.yml/dispatches`
* Method: **POST**
* Headers:
  * `Authorization: Bearer <PAT_TOKEN>`
  * `Accept: application/vnd.github+json`
  * `Content-Type: application/json`
* Body:
  ```json
  { "ref": "main" }
  ```
* Schedule: **every 5 minutes**

### 9b. Daily summary at 00:00 UTC

Same URL, same headers, body:

```json
{ "ref": "main", "inputs": { "task": "daily_summary" } }
```

Schedule: **daily at 00:00 UTC**.

---

## 10. Test the bot

1. Open Telegram, talk to your bot, send `/start`.
2. You should see the main menu with inline buttons.
3. Tap **📊 Status** — should display balance, mode, last cycle.
4. Tap **▶️ Trigger** — fires a manual cycle.
5. Watch the **Actions** tab on GitHub for the workflow run.
6. After the run completes, you should receive a cycle summary in Telegram.

If something doesn't work, check:

* Cloudflare Worker logs (real-time tab).
* GitHub Actions run logs.
* Telegram webhook info (`getWebhookInfo`).

---

## 11. Upload custom strategies via Telegram

1. Author a new strategy in a single `.js` file following the contract in
   `js/strategies/STRATEGY_SPEC.md`.
2. Send the `.js` file to your Telegram bot as an attachment.
3. The worker validates it (must contain `id:`, `name:`, `onTick`) and
   commits it to `js/strategies/`.
4. Reply with `✅ Deploy` and then `✅ Enable` to turn it on.

---

## 12. Switching to REAL money

Tap **⚙️ Settings → 🔄 Account → Switch to 🔴 REAL** and confirm.
You'll see the status badge change to `🔴 REAL`.

> ⚠️ Always test thoroughly on `🟡 DEMO` first. Real money is at risk.

---

## 13. Common troubleshooting

| Symptom                         | Likely cause |
|---------------------------------|--------------|
| Bot replies "Worker error: gh read config.json: 404" | Wrong `GITHUB_OWNER` or `GITHUB_REPO` env var on the worker. |
| Webhook returns 401 from Telegram | `TELEGRAM_BOT_TOKEN` wrong on the worker. |
| Workflow says `gh push` failed | `PAT_TOKEN` lacks `Contents: Write` permission. |
| Cycle exits early, no trades | Either `config.enabled` is `false` or no strategy is enabled. |
| "OTP 401" or "otp 403" in logs | `DERIV_BEARER_TOKEN` revoked or wrong `DERIV_APP_ID`. |
| `placeTrade: invalid opts` | Signal returned bad stake / duration — check the strategy. |

---

You're done. Have fun, and trade responsibly.
