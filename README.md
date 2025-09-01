# ======================================================================
# FILE: wrangler.toml
# ======================================================================
name = "hl-alerts"
main = "src/index.ts"
compatibility_date = "2025-09-02"

# Bind your KV namespace id after creating it with:
#   wrangler kv namespace create HL_ALERT_STATE
kv_namespaces = [
  { binding = "HL_ALERT_STATE", id = "REPLACE_WITH_YOUR_NAMESPACE_ID" }
]

[triggers]
# Frequent risk polling + daily status (UTC midnight)
crons = ["*/1 * * * *", "0 0 * * *"]


# ======================================================================
# FILE: package.json
# ======================================================================
{
  "name": "cf-hl-alerts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "types": "wrangler types"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240829.0",
    "typescript": "^5.5.4",
    "wrangler": "^4.33.1"
  }
}


# ======================================================================
# FILE: tsconfig.json
# ======================================================================
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}


# ======================================================================
# FILE: src/index.ts
# ======================================================================
export interface Env {
  TG_BOT_TOKEN: string;
  TG_CHAT_ID: string;         // default chat for cron alerts
  ADDRESSES_CSV: string;      // comma-separated addresses (labels optional, not shown)
  HL_INFO?: string;           // optional override for HL info endpoint
  HL_ALERT_STATE: KVNamespace; // KV for gating state

  // Optional: identify cron expressions (so we know which fired) — not required to set
  POLL_CRON?: string;         // default: "*/1 * * * *"
  DAILY_CRON?: string;        // default: "0 0 * * *"
}

type Update = {
  update_id: number;
  message?: any;
  edited_message?: any;
  channel_post?: any;
};

const SEP = "────────────────────────────────────────────────────";
const HL_INFO = (env: Env) => env.HL_INFO || "https://api.hyperliquid.xyz/info";

/* =================== Worker handlers =================== */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("ok");

    // Telegram webhook endpoint
    if (url.pathname === "/tg" && req.method === "POST") {
      try {
        const update = (await req.json()) as Update;
        const msg = update.message || update.edited_message || update.channel_post;
        if (!msg) return new Response("ok");

        const chatId = String(msg.chat?.id ?? env.TG_CHAT_ID);
        const text: string = (msg.text || "").trim();

        if (text.startsWith("/status")) {
          const { addresses, nameMap } = parseAddrBook(env.ADDRESSES_CSV || "");
          const report = await buildAccountOverviewReport(env, addresses, nameMap);
          for (const chunk of chunkMessage("📅 <b>Daily Status</b>\n\n" + report)) {
            await tgSend(env, chatId, chunk);
          }
        } else if (text.startsWith("/positions")) {
          const { addresses, nameMap } = parseAddrBook(env.ADDRESSES_CSV || "");
          const report = await buildPositionsReport(env, addresses, nameMap);
          for (const chunk of chunkMessage(report)) {
            await tgSend(env, chatId, chunk);
          }
        } else if (text.startsWith("/ping")) {
          await tgSend(env, chatId, "pong");
        } else if (text.startsWith("/help")) {
          await tgSend(
            env,
            chatId,
            [
              "Commands:",
              "/status — per-account: 🔷 Cross (Leverage / Health), then 🟨 Isolated (coin / leverage / health)",
              "/positions — same structure as /status",
              "/ping — liveness check"
            ].join("\n")
          );
        }
      } catch (e) {
        console.error("webhook error:", e);
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const pollExpr = env.POLL_CRON || "*/1 * * * *";
      const dailyExpr = env.DAILY_CRON || "0 0 * * *";
      const which = (event as any).cron as string | undefined;

      // Daily summary (/status) — independent of alert gating
      if (which === dailyExpr) {
        const { addresses, nameMap } = parseAddrBook(env.ADDRESSES_CSV || "");
        if (!addresses.length) return;
        const report = await buildAccountOverviewReport(env, addresses, nameMap);
        for (const chunk of chunkMessage("📅 <b>Daily Status</b>\n\n" + report)) {
          await tgSend(env, env.TG_CHAT_ID, chunk);
        }
        return;
      }

      // Frequent poll: tiered health alerts with per-day gating
      if (which === pollExpr || which === undefined) {
        const { addresses } = parseAddrBook(env.ADDRESSES_CSV || "");
        if (!addresses.length) return;

        const today = todayKeyUTC(); // resets daily at UTC midnight

        for (let i = 0; i < addresses.length; i++) {
          const addr = addresses[i];
          const ov = await getAccountOverview(env, addr);
          if (!ov) continue;

          const balance = num(ov.accountValue);
          if (!isFinite(balance) || balance <= 0) continue; // skip empty accounts

          const maint = num(ov.crossMaintMargin);
          const upnl = num(ov.unrealizedPnl);
          const h = healthAccountPct(balance, maint, upnl);
          const tier = tierFor(h); // 1:<50, 2:<20, 3:<5, 4:=0

          if (tier === 0) continue;

          const key = `acct:${addr}:${today}`;
          const state = (await readState(env, key)) || { sent: {} as Record<string, boolean> };

          // Only send this tier once per day; allow escalation later the same day
          if (!state.sent[String(tier)]) {
            const idx = i + 1;
            const title = `<b>Account ${idx}</b>`;
            const threshTxt = tierThreshText(tier);
            const msg = [
              `⚠️ <b>Near Liquidation</b> — Level ${tier}/4 (${threshTxt})`,
              `${title}`,
              "",
              `📈 Leverage: ${ov.crossLeverage == null ? "?" : fmtX(ov.crossLeverage)}`,
              `❤️ Health: ${h == null ? "?" : fmtPct(h)}`
            ].join("\n");

            await tgSend(env, env.TG_CHAT_ID, msg);
            state.sent[String(tier)] = true;
            // ~26h TTL so the key expires even if there's slight clock skew
            await writeState(env, key, state, 60 * 60 * 26);
          }
        }
      }
    } catch (e) {
      console.error("scheduled error:", e);
    }
  },
} satisfies ExportedHandler<Env>;

/* =================== helpers =================== */

function todayKeyUTC(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function chunkMessage(text: string): string[] {
  const MAX = 3800;
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > MAX) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function parseAddrBook(csv: string): { addresses: string[]; nameMap: Record<string, string> } {
  const items = (csv || "").split(",").map(s => s.trim()).filter(Boolean);
  const ADDR = /0x[a-fA-F0-9]{40}/;
  const addresses: string[] = [];
  const nameMap: Record<string, string> = {};
  for (const it of items) {
    const m = it.match(ADDR);
    if (!m) continue;
    const addr = m[0];
    if (!addresses.includes(addr)) addresses.push(addr);
    // Labels optional; not displayed currently. You can map here if desired.
  }
  return { addresses, nameMap };
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || !isFinite(x)) return "?";
  return `${x.toFixed(2)}%`;
}
function fmtX(x: number | null | undefined): string {
  if (x == null || !isFinite(x)) return "?";
  return `${x.toFixed(2)}x`;
}
const num = (v: any) => (v == null ? NaN : Number(v));

/* =================== Telegram =================== */

async function tgSend(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TG_BOT_TOKEN || !chatId) return;
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("tg send failed", r.status, t);
  }
}

/* =================== Hyperliquid REST =================== */

async function hlInfo(env: Env, body: any): Promise<any> {
  const r = await fetch(HL_INFO(env), {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "hl-liq-alerts/worker" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HL info ${r.status}`);
  return await r.json();
}

async function getMetaAndMarks(env: Env): Promise<Record<string, number>> {
  try {
    const meta_ctxs = await hlInfo(env, { type: "metaAndAssetCtxs" });
    let universe: any[] = [], ctxs: any[] = [];
    if (Array.isArray(meta_ctxs)) {
      if (meta_ctxs[0] && typeof meta_ctxs[0] === "object") universe = meta_ctxs[0].universe || [];
      if (Array.isArray(meta_ctxs[1])) ctxs = meta_ctxs[1];
    }
    const names = universe.map(u => u?.name);
    const marks: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
      const nm = names[i];
      const mp = Number(ctxs[i]?.markPx);
      if (nm && isFinite(mp) && mp > 0) marks[nm] = mp;
    }
    return marks;
  } catch (e) {
    console.warn("getMetaAndMarks failed:", e);
    return {};
  }
}

async function getAccountOverview(env: Env, addr: string) {
  try {
    const resp = await hlInfo(env, { type: "clearinghouseState", user: addr });
    const ov = computeOverviewFromRaw(resp);
    return { ...ov, raw: resp };
  } catch (e) {
    console.warn("getAccountOverview failed:", e);
    return null;
  }
}

/* ===== compute overview from raw clearinghouse ===== */

function computeOverviewFromRaw(resp: any) {
  const ms = resp?.marginSummary || {};
  // Some fields are in top-level, some in marginSummary; use both defensively
  const cross_mm_used = nco(resp?.crossMaintenanceMarginUsed, ms?.crossMaintenanceMarginUsed, 0);
  const accountValue = nco(ms?.accountValue, 0);
  const totalNtlPos = nco(ms?.totalNtlPos, 0);
  const totalMarginUsed = nco(ms?.totalMarginUsed, 0);

  let upnl = 0;
  for (const ap of (resp?.assetPositions || [])) {
    const v = Number(ap?.position?.unrealizedPnl ?? 0);
    if (isFinite(v)) upnl += v;
  }

  const crossLev = accountValue > 0 ? (totalNtlPos / accountValue) : null;

  return {
    accountValue,
    totalNtlPos,
    totalMarginUsed,
    crossMaintMargin: cross_mm_used,
    unrealizedPnl: upnl,
    crossLeverage: crossLev
  };
}

function nco(...vals: any[]) {
  for (const v of vals) {
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return 0;
}

/* =================== Position parsing & classification =================== */

function collectPositions(resp: any) {
  const out: any[] = [];
  const list = resp?.assetPositions || [];
  for (const ap of list) {
    const pos = ap?.position || {};
    const coin = pos.coin || pos.asset;
    if (!coin) continue;

    let szi = Number(pos.szi ?? pos.size ?? pos.positionSize ?? pos.sizeAbs);
    if (!isFinite(szi) || Math.abs(szi) < 1e-10) continue;

    const entryPx = Number(pos.entryPx ?? pos.entryPrice ?? pos.avgEntryPx ?? pos.avgEntryPrice ?? 0) || 0;
    let liq = Number(pos.liquidationPx ?? pos?.risk?.liquidationPx ?? pos?.risk?.liqPx);
    if (!isFinite(liq)) liq = null;

    const upnl = Number(pos.unrealizedPnl ?? pos.unrealizedPnlUsd ?? pos.uPnl ?? pos.pnl ?? 0) || 0;
    let side = pos.side || (szi >= 0 ? "long" : "short");

    out.push({ coin, side, szi, entryPx, liquidationPx: liq, unrealizedPnl: upnl, raw: pos });
  }
  return out;
}

function classifyPosition(rawPos: any, accountCrossUsed: boolean): "cross" | "isolated" {
  if (typeof rawPos?.cross === "boolean") return rawPos.cross ? "cross" : "isolated";
  if (typeof rawPos?.isCross === "boolean") return rawPos.isCross ? "cross" : "isolated";
  if (typeof rawPos?.risk?.cross === "boolean") return rawPos.risk.cross ? "cross" : "isolated";

  const str = (v: any) => (typeof v === "string" ? v.toLowerCase() : null);
  const mt =
    str(rawPos?.marginType) ||
    str(rawPos?.marginMode) ||
    str(rawPos?.leverageMode) ||
    str(rawPos?.risk?.marginType);
  if (mt === "cross") return "cross";
  if (mt === "isolated") return "isolated";

  return accountCrossUsed ? "cross" : "isolated";
}

function classifyPositions(resp: any, accountCrossUsed: boolean) {
  const positions = collectPositions(resp);
  const crossPos: any[] = [];
  const isoPos: any[] = [];
  for (const p of positions) {
    const cls = classifyPosition(p.raw, accountCrossUsed);
    if (cls === "cross") crossPos.push(p);
    else isoPos.push(p);
  }
  return { crossPos, isoPos };
}

/* =================== Health calculations =================== */

// Cross-account: (Balance - Maintenance) / (Balance - UPNL), clamped [0, 100]
function healthAccountPct(balance: number, maint: number, upnl: number): number | null {
  if (!(isFinite(balance) && isFinite(maint) && isFinite(upnl))) return null;
  const denom = balance - upnl;
  if (denom <= 0) return 0;
  return clamp01pct(((balance - maint) / denom) * 100);
}

// Isolated per-position with leverage multiplier, clamped [0, 100]
// long: ((mark - liq) / entry) * leverage * 100, leverage = entry / (entry - liq)
// short: ((liq - mark) / entry) * leverage * 100, leverage = entry / (liq - entry)
function healthPosPct(mark: number, liq: number, entry: number, side: string): number | null {
  if (!(isFinite(mark) && isFinite(entry) && isFinite(liq))) return null;
  if (mark <= 0 || entry <= 0 || liq <= 0) return null;

  let baseNum: number, denomLev: number;
  if ((side || "").toLowerCase().startsWith("long")) {
    baseNum = (mark - liq);
    denomLev = (entry - liq);
  } else {
    baseNum = (liq - mark);
    denomLev = (liq - entry);
  }
  if (denomLev <= 0) return null;

  const leverage = entry / denomLev;
  const base = baseNum / entry;
  return clamp01pct(100 * base * leverage);
}

function clamp01pct(x: number) { return Math.min(100, Math.max(0, x)); }

/* ===== 4-tier thresholds =====
   1: <50%
   2: <20%
   3: <5%
   4: =0%
*/
function tierFor(h?: number | null): number {
  if (h == null || !isFinite(h)) return 0;
  if (h <= 0) return 4;
  if (h < 5) return 3;
  if (h < 20) return 2;
  if (h < 50) return 1;
  return 0;
}
function tierThreshText(tier: number): string {
  return tier === 4 ? "= 0.00%" : tier === 3 ? "< 5.00%" : tier === 2 ? "< 20.00%" : "< 50.00%";
}

/* =================== KV state =================== */

async function readState(env: Env, key: string): Promise<any | null> {
  try {
    const s = await env.HL_ALERT_STATE.get(key);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
async function writeState(env: Env, key: string, obj: any, ttlSeconds?: number): Promise<void> {
  try {
    await env.HL_ALERT_STATE.put(key, JSON.stringify(obj), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch {}
}

/* =================== Rendering =================== */

async function buildAccountOverviewReport(env: Env, addresses: string[], _nameMap: Record<string, string>): Promise<string> {
  const lines: string[] = ["📊 <b>Per-Account Overview</b>"];
  const total = addresses.length;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const ov = await getAccountOverview(env, addr);
    const title = `<b>Account ${i + 1}</b>`;

    if (!ov) {
      lines.push(`${title}\n\n( no data )`);
      if (i < total - 1) lines.push(SEP);
      continue;
    }

    const bal = ov.accountValue;
    const upnl = ov.unrealizedPnl;
    const mm = ov.crossMaintMargin;
    const lev = ov.crossLeverage;
    const h = healthAccountPct(bal, mm, upnl);

    const mmUsed = Number(mm || 0) > 0;

    // Cross block: minimal (Leverage + Health)
    const crossBlock: string[] = ["🔷 <b>Cross</b>", ""];
    if (!mmUsed) {
      crossBlock.push("( no cross exposure )");
    } else {
      crossBlock.push(
        `📈 Leverage: ${lev == null ? "?" : fmtX(lev)}`,
        `❤️ Health: ${h == null ? "?" : fmtPct(h)}`
      );
    }

    // Isolated block: coin / leverage / health rows
    const raw = ov.raw;
    const { isoPos } = classifyPositions(raw, mmUsed);
    const marks = await getMetaAndMarks(env);
    const isoBlock: string[] = ["🟨 <b>Isolated</b>", ""];
    if (!isoPos.length) {
      isoBlock.push("( no open positions )");
    } else {
      for (const p of isoPos) isoBlock.push(...renderPositionLines(p, marks), "");
      if (isoBlock.at(-1) === "") isoBlock.pop();
    }

    const joined = [title, "", ...crossBlock, "", ...isoBlock]
      .join("\n")
      .replace(/\n\n\n+/g, "\n\n");
    lines.push(joined);

    if (i < total - 1) lines.push(SEP);
  }
  return lines.join("\n");
}

async function buildPositionsReport(env: Env, addresses: string[], _nameMap: Record<string, string>): Promise<string> {
  const marks = await getMetaAndMarks(env);
  const lines: string[] = ["📄 <b>Per-Position Status</b>"];
  const total = addresses.length;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const raw = await hlInfo(env, { type: "clearinghouseState", user: addr });
    const ov = computeOverviewFromRaw(raw);

    const mmUsed = Number(ov.crossMaintMargin || 0) > 0;
    const { isoPos } = classifyPositions(raw, mmUsed);

    const title = `<b>Account ${i + 1}</b>`;
    const h = healthAccountPct(ov.accountValue, ov.crossMaintMargin, ov.unrealizedPnl);

    // Cross minimal
    const crossBlock: string[] = ["🔷 <b>Cross</b>", ""];
    if (!mmUsed) {
      crossBlock.push("( no cross exposure )");
    } else {
      crossBlock.push(
        `📈 Leverage: ${ov.crossLeverage == null ? "?" : fmtX(ov.crossLeverage)}`,
        `❤️ Health: ${h == null ? "?" : fmtPct(h)}`
      );
    }

    const isoBlock: string[] = ["🟨 <b>Isolated</b>", ""];
    if (!isoPos.length) {
      isoBlock.push("( no open positions )");
    } else {
      for (const p of isoPos) isoBlock.push(...renderPositionLines(p, marks), "");
      if (isoBlock.at(-1) === "") isoBlock.pop();
    }

    const chunk = [title, "", ...crossBlock, "", ...isoBlock]
      .join("\n")
      .replace(/\n\n\n+/g, "\n\n");
    lines.push(chunk);

    if (i < total - 1) lines.push(SEP);
  }

  return lines.join("\n");
}

/* ----- isolated position lines (coin, leverage, health) ----- */
function renderPositionLines(p: any, marks: Record<string, number>): string[] {
  const coin = p.coin;
  const liq = p.liquidationPx as number | null;
  const entry = p.entryPx as number;
  const side = (p.side || "").toLowerCase();
  const mark = marks[coin];

  // Leverage from entry & liq when possible
  let levRaw = NaN;
  if (isFinite(entry) && entry > 0 && isFinite(liq ?? NaN) && (liq as number) > 0) {
    const denom = side.startsWith("long") ? (entry - (liq as number)) : ((liq as number) - entry);
    if (denom > 0) levRaw = entry / denom;
  }
  // Fallback to payload hints
  if (!isFinite(levRaw) || levRaw <= 0) {
    const cands = [p.raw?.leverage, p.raw?.lev, p.raw?.x, p.raw?.risk?.leverage];
    for (const v of cands) {
      const n = Number(v);
      if (isFinite(n) && n > 0) { levRaw = n; break; }
    }
  }
  const levDisplay = (isFinite(levRaw) && levRaw > 0) ? Math.round(levRaw) : NaN;

  // Health with leverage multiplier (capped [0,100]) using current mark
  const h = (isFinite(mark) && isFinite(entry) && isFinite(liq ?? NaN))
    ? healthPosPct(mark, liq as number, entry, side)
    : null;

  return [
    `🪙 ${coin}`,
    `📈 Leverage: ${isFinite(levDisplay) ? `${levDisplay}x` : "?"}`,
    `❤️ Health: ${h == null ? "?" : fmtPct(h)}`
  ];
}


# ======================================================================
# FILE: README.md
# ======================================================================
# hl-alerts — Hyperliquid → Telegram (Cloudflare Worker, zero-key)

A tiny Cloudflare Worker that watches **Hyperliquid** accounts using **public endpoints only** (no API keys) and sends alerts & status to **Telegram**.

---

## Features
- ✅ Runs 24/7 on Cloudflare’s edge (free tier friendly)
- ✅ No private keys; read-only via Hyperliquid `info` API
- ✅ Telegram commands: `/status`, `/positions`, `/ping`, `/help`
- ✅ Tiered **near-liquidation alerts** with **per-day gating** (one alert per tier per account per day):
  - Thresholds: **<50%**, **<20%**, **<5%**, **=0%**
- ✅ Output
  - **Cross (account)**: `Leverage`, `Health`
  - **Isolated (per position)**: `🪙 coin`, `Leverage`, `Health`

### Health formulas
- **Cross (account)**:  
  `Health = (Balance − Maintenance) / (Balance − Unrealized PnL)` → clamp to **[0, 100]%**
- **Isolated (position)**:  
  - Long:  `((mark − liq) / entry) × leverage × 100`  
  - Short: `((liq − mark) / entry) × leverage × 100`  
  where `leverage = entry / (entry − liq)` (long) or `entry / (liq − entry)` (short), then clamp **[0, 100]%**

---

## Requirements
- Cloudflare account
- Node.js 18+
- Wrangler CLI: `npm i -g wrangler`
- Telegram Bot token (from **@BotFather**)
- Telegram chat ID (your user ID or a group ID — group IDs are negative like `-1001234…`)

---

## Quick Start (10 minutes)

### 1) Clone & enter
```bash
git clone https://github.com/<you>/cf-hl-alerts.git
cd cf-hl-alerts
