\# cf-hl-alerts



Cloudflare Worker for Hyperliquid liquidation + health alerts and Telegram commands (/status, /positions).

\- Deployed with Wrangler

\- Secrets stored on Cloudflare (do NOT commit .env)



\## Commands

\- `/status` — per-account: 🔷 Cross (portfolio overview), then 🟨 Isolated (per-coin)

\- `/positions` — same structure

\- `/ping` — bot liveness



\## Deploy

\- `wrangler deploy`



