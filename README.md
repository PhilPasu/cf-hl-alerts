hl-alerts — Hyperliquid → Telegram alerts (Cloudflare Worker, zero-key)

A lightweight Cloudflare Worker that watches Hyperliquid accounts using public endpoints only (no API keys), and sends alerts & status to Telegram.

✅ No private keys (public info + clearinghouse state only)

✅ 24/7 on Cloudflare’s edge (free tier friendly)

✅ Telegram webhook commands: /status, /positions, /ping

✅ Tiered risk alerts with daily gating (50% / 20% / 5% / 0%)

✅ Cross view (Leverage, Health) & Isolated rows (🪙 coin, Leverage, Health)

Health definitions

Cross (account): (Balance − Maintenance) / (Balance − Unrealized PnL), capped [0, 100%].

Isolated (per position):

Long: ((mark − liq)/entry) × leverage × 100

Short: ((liq − mark)/entry) × leverage × 100
(with leverage = entry / (entry − liq) or entry / (liq − entry)), capped [0, 100%].

1) What you need

A Cloudflare account (free is fine)

Node.js 18+

Wrangler CLI:

npm i -g wrangler


A Telegram Bot token from @BotFather

A Telegram chat to receive messages:

personal DM (your user ID), or

a group/supergroup (chat ID is negative, e.g. -1001234567890)

2) Deploy in 10 minutes
2.1 Clone & enter
git clone https://github.com/<you>/cf-hl-alerts.git
cd cf-hl-alerts

2.2 Login to Cloudflare
wrangler login

2.3 Create KV namespace
wrangler kv namespace create HL_ALERT_STATE


This prints an id (and a preview_id). Put the id into your wrangler.toml:

name = "hl-alerts"
main = "src/index.ts"
compatibility_date = "2024-09-01"

kv_namespaces = [
  { binding = "HL_ALERT_STATE", id = "YOUR_NAMESPACE_ID_HERE" }
]

[triggers]
# frequent risk polling + daily status (UTC midnight)
crons = ["*/1 * * * *", "0 0 * * *"]


If your repo uses wrangler.jsonc, add the same fields there in JSON form.

2.4 Add secrets (Telegram + addresses)
wrangler secret put TG_BOT_TOKEN
# paste your bot token, e.g. 123456:AA...

wrangler secret put TG_CHAT_ID
# paste your chat id (e.g. -1001234567890 for a group, or your user id)

wrangler secret put ADDRESSES_CSV
# paste a comma-separated list of addresses:
# 0xabc...,0xdef...,My Desk|0x123...  (labels are optional; not shown by default)


How to get a group chat id: add your bot to the group, send a message in the group, then open
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates and find message.chat.id (negative number).

2.5 Set Telegram webhook to your Worker

After you deploy the first time (next step), you’ll have a URL like
https://hl-alerts.<your-subdomain>.workers.dev

Set the webhook:

https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://hl-alerts.<your-subdomain>.workers.dev/tg

2.6 Deploy
wrangler deploy


You should see:

Uploaded hl-alerts
Deployed hl-alerts triggers
https://hl-alerts.<your-subdomain>.workers.dev
schedule: */1 * * * *
schedule: 0 0 * * *

3) What you get
3.1 Commands (Telegram → your bot)

/status — for each account:

Cross: Leverage, Health

Isolated: for each position → 🪙 coin, Leverage, Health

/positions — same structure as /status

/ping — quick liveness check

/help — command list

Output uses separators between accounts for readability.

3.2 Automatic alerts (cron)

Risk alerts every minute:

Tiers: <50%, <20%, <5%, =0%

Per-day gating: each tier fires once per UTC day per account

If it worsens into a new tier later the same day, the new tier fires

Gating resets automatically at UTC midnight

Daily status report at 00:00 UTC (independent of alert gating)

Want gating based on Bangkok time (UTC+7)?
Change the todayKeyUTC() helper in src/index.ts to compute local date in Asia/Bangkok.

4) Data & security

Uses Hyperliquid public info API (metaAndAssetCtxs, clearinghouseState)

No API keys, no signing — read-only by design

Health logic is derived from account/position fields; leverage is computed from entry & liq price when possible

Secrets live in Cloudflare’s encrypted secrets store, not in code or git

5) Updating addresses / config later
# Update addresses (comma separated). Labels optional (Label|0x...).
wrangler secret put ADDRESSES_CSV

# Change Telegram chat
wrangler secret put TG_CHAT_ID

# Re-deploy
wrangler deploy

6) Troubleshooting

Bot can’t DM you

Telegram error: Forbidden: bots can't send messages to bots
→ Make sure TG_CHAT_ID is a human or group chat, not another bot.

No messages in group

Did you add the bot to the group?

Check getUpdates to confirm the chat id you’re using is correct (negative).

Webhook not firing

Re-set webhook after deploy:
.../bot<TOKEN>/setWebhook?url=https://hl-alerts.<sub>.workers.dev/tg

Clear any old webhook:
.../bot<TOKEN>/deleteWebhook then set again.

wrangler: “fetch failed” / timeouts

Re-run wrangler login

Try again; sometimes a transient network issue.

KV errors

Ensure kv_namespaces in wrangler.toml has the correct id returned by
wrangler kv namespace create HL_ALERT_STATE.

Nothing in /status

Make sure the addresses actually have positions / balance.

Remember: Cross section shows Leverage & Health only; Isolated shows per-coin rows.

7) Dev & contribute

Code: TypeScript Worker (src/index.ts)

Format & build are handled by Wrangler during deploy

PRs welcome: tests, new commands (e.g. toggling output style), or docs improvements

8) Disclaimer

This tool is for operational alerts only. No financial advice. Hyperliquid APIs, symbols, or field names may change; verify outputs before relying on them for trading decisions.

Quick command recap (Windows PowerShell friendly)
wrangler login
wrangler kv namespace create HL_ALERT_STATE
notepad .\wrangler.toml   # paste KV id + triggers, save

wrangler secret put TG_BOT_TOKEN
wrangler secret put TG_CHAT_ID
wrangler secret put ADDRESSES_CSV

wrangler deploy

# set webhook (open in browser):
# https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://hl-alerts.<your-subdomain>.workers.dev/tg
