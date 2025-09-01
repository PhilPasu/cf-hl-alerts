hl-alerts — Hyperliquid → Telegram (Cloudflare Worker, zero-key)

A tiny Cloudflare Worker that watches **Hyperliquid** accounts using **public endpoints only** (no API keys) and sends alerts & status to **Telegram**.

---

Features
- ✅ Runs 24/7 on Cloudflare’s edge (free tier friendly)
- ✅ No private keys; read-only via Hyperliquid `info` API
- ✅ Telegram commands: `/status`, `/positions`, `/ping`, `/help`
- ✅ Tiered **near-liquidation alerts** with **per-day gating** (one alert per tier per account per day):
  - Thresholds: **<50%**, **<20%**, **<5%**, **=0%**
- ✅ Output
  - **Cross (account)**: `Leverage`, `Health`
  - **Isolated (per position)**: `🪙 coin`, `Leverage`, `Health`

Health formulas
- **Cross (account)**:  
  `Health = (Balance − Maintenance) / (Balance − Unrealized PnL)` → clamp to **[0, 100]%**
- **Isolated (position)**:  
  - Long:  `((mark − liq) / entry) × leverage × 100`  
  - Short: `((liq − mark) / entry) × leverage × 100`  
  where `leverage = entry / (entry − liq)` (long) or `entry / (liq − entry)` (short), then clamp **[0, 100]%**

---

Requirements
- Cloudflare account
- Node.js 18+
- Wrangler CLI: `npm i -g wrangler`
- Telegram Bot token (from **@BotFather**)
- Telegram chat ID (your user ID or a group ID — group IDs are negative like `-1001234…`)

---
