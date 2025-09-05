export interface Env {
  TG_BOT_TOKEN: string;
  TG_CHAT_ID: string;        // default chat for cron alerts
  ADDRESSES_CSV: string;     // "0xabc..., 0xdef..., Team - 0x123..."
  HL_INFO?: string;          // optional override
  HL_ALERT_STATE: KVNamespace; // KV binding for cooldowns/state

  // Optional cron identifiers so we know which fired
  POLL_CRON?: string;        // default: "*/1 * * * *"
  DAILY_CRON?: string;       // first daily (e.g., 09:00 BKK = 02:00 UTC)
  DAILY_CRON_2?: string;     // second daily (e.g., 21:00 BKK = 14:00 UTC)
}

type Update = {
  update_id: number;
  message?: any;
  edited_message?: any;
  channel_post?: any;
};

const SEP = "────────────────────────────────────────────────────";
const HL_INFO_URL = (env: Env) => env.HL_INFO || "https://api.hyperliquid.xyz/info";

/* =================== Worker handlers =================== */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("ok");

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
          for (const chunk of chunkMessage("📅 <b>Daily Status</b>\n\n" + report)) await tgSend(env, chatId, chunk);
        } else if (text.startsWith("/positions")) {
          const { addresses, nameMap } = parseAddrBook(env.ADDRESSES_CSV || "");
          const report = await buildPositionsReport(env, addresses, nameMap);
          for (const chunk of chunkMessage(report)) await tgSend(env, chatId, chunk);
        } else if (text.startsWith("/ping")) {
          await tgSend(env, chatId, "pong");
        } else if (text.startsWith("/help")) {
          await tgSend(
            env,
            chatId,
            [
              "Commands:",
              "/status — per-account: 🔷 Cross (Leverage / Health), then 🟨 Isolated (coin / leverage / funding / health)",
              "/positions — same structure as /status",
              "/ping — check if bot is alive",
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
      const pollExpr  = env.POLL_CRON  || "*/1 * * * *";
      const dailyExpr = env.DAILY_CRON || "0 2 * * *";   // 09:00 Bangkok (UTC+7) = 02:00 UTC
      const dailyExpr2= env.DAILY_CRON_2 || "0 14 * * *"; // 21:00 Bangkok = 14:00 UTC
      const which = (event as any).cron as string | undefined;

      // Twice-daily summary (/status) — independent of near-liq alert gating
      if (which === dailyExpr || which === dailyExpr2) {
        const { addresses, nameMap } = parseAddrBook(env.ADDRESSES_CSV || "");
        if (!addresses.length) return;
        const report = await buildAccountOverviewReport(env, addresses, nameMap);
        for (const chunk of chunkMessage("📅 <b>Daily Status</b>\n\n" + report)) {
          await tgSend(env, env.TG_CHAT_ID, chunk);
        }
        return;
      }

      // Frequent poll (e.g., every minute): tiered health alerts with per-day gating
      if (which === pollExpr || which === undefined) {
        const { addresses } = parseAddrBook(env.ADDRESSES_CSV || "");
        if (!addresses.length) return;

        const today = todayKeyUTC(); // resets automatically at new UTC day

        for (let i = 0; i < addresses.length; i++) {
          const addr = addresses[i];
          const ov = await getAccountOverview(env, addr);
          if (!ov) continue;

          const balance = num(ov.accountValue);
          if (!isFinite(balance) || balance <= 0) continue; // skip empty accounts

          const maint = num(ov.crossMaintMargin);
          const upnl = num(ov.unrealizedPnl);
          const h = healthAccountPct(balance, maint, upnl);
          const tier = tierFor(h);
          if (tier === 0) continue; // no alert

          const key = `acct:${addr}:${today}`;
          const state = (await readState(env, key)) || { sent: {} as Record<string, boolean> };

          // Only send this tier once per day
          if (!state.sent[String(tier)]) {
            const idx = i + 1;
            const title = `<b>Account ${idx}</b>\n🔑 Address: <code>${addr}</code>`;
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
            await writeState(env, key, state, /*ttlSeconds=*/60 * 60 * 26); // ~26h to survive skews
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
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
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
  }
  return { addresses, nameMap };
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || !isFinite(x)) return "?";
  return `${x.toFixed(2)}%`;
}
function fmtSignedPctPerHour(x: number | null | undefined): string {
  if (x == null || !isFinite(x)) return "?";
  const pct = x * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(4)}%/h`;
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
  const r = await fetch(HL_INFO_URL(env), {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "hl-liq-alerts/worker" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HL info ${r.status}`);
  return await r.json();
}

/** Fetch both mark prices and funding rates in one call. */
async function getMarksAndFunding(env: Env): Promise<{ marks: Record<string, number>, funding: Record<string, number> }> {
  try {
    const meta_ctxs = await hlInfo(env, { type: "metaAndAssetCtxs" });
    let universe: any[] = [], ctxs: any[] = [];
    if (Array.isArray(meta_ctxs)) {
      if (meta_ctxs[0] && typeof meta_ctxs[0] === "object") universe = meta_ctxs[0].universe || [];
      if (Array.isArray(meta_ctxs[1])) ctxs = meta_ctxs[1];
    }
    const names = universe.map(u => u?.name);
    const marks: Record<string, number> = {};
    const funding: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
      const nm = names[i];
      const mp = Number(ctxs[i]?.markPx);
      const fr = Number(ctxs[i]?.funding); // HL provides 'funding' in asset ctxs
      if (nm && isFinite(mp) && mp > 0) marks[nm] = mp;
      if (nm && isFinite(fr)) funding[nm] = fr; // hourly funding rate (decimal), per HL info
    }
    return { marks, funding };
  } catch (e) {
    console.warn("getMarksAndFunding failed:", e);
    return { marks: {}, funding: {} };
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

/* ===== compute overview directly from raw clearinghouse ===== */

function computeOverviewFromRaw(resp: any) {
  const ms = resp?.marginSummary || {};
  const cross_mm_used = Number(resp?.crossMaintenanceMarginUsed || 0);
  const accountValue = Number(ms?.accountValue || 0);
  const totalNtlPos = Number(ms?.totalNtlPos || 0);
  const totalMarginUsed = Number(ms?.totalMarginUsed || 0);

  let upnl = 0;
  for (const ap of (resp?.assetPositions || [])) {
    const v = Number(ap?.position?.unrealizedPnl || 0);
    if (isFinite(v)) upnl += v;
  }

  const cmrPct = accountValue > 0 ? (cross_mm_used / accountValue) * 100 : null;
  const crossLev = accountValue > 0 ? (totalNtlPos / accountValue) : null;

  return {
    accountValue,
    totalNtlPos,
    totalMarginUsed,
    crossMaintMargin: cross_mm_used,
    unrealizedPnl: upnl,
    crossMarginRatioPct: cmrPct,
    crossLeverage: crossLev,
  };
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

// cross-account health: (Balance - Maintenance) / (Balance - UPNL), clamped [0,100]
function healthAccountPct(balance: number, maint: number, upnl: number): number | null {
  const denom = balance - upnl;
  if (!(isFinite(balance) && isFinite(maint) && isFinite(upnl))) return null;
  if (denom <= 0) return 0;
  const pct = ((balance - maint) / denom) * 100;
  return clamp01pct(pct);
}

// isolated per-position health with leverage multiplier, clamped [0,100]
// long: ((mark - liq)/entry) * leverage * 100, leverage = entry/(entry - liq)
// short: ((liq - mark)/entry) * leverage * 100, leverage = entry/(liq - entry)
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

/* =================== Rendering helpers =================== */

async function buildAccountOverviewReport(env: Env, addresses: string[], _nameMap: Record<string, string>): Promise<string> {
  const lines: string[] = ["📊 <b>Per-Account Overview</b>"];
  const total = addresses.length;
  // fetch marks + funding once
  const { marks, funding } = await getMarksAndFunding(env);

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const ov = await getAccountOverview(env, addr);
    const title = `<b>Account ${i + 1}</b>\n🔑 Address: <code>${addr}</code>`;

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

    const crossBlock: string[] = ["🔷 <b>Cross</b>", ""];
    if (!mmUsed) {
      crossBlock.push("( no cross exposure )");
    } else {
      crossBlock.push(
        `📈 Leverage: ${lev == null ? "?" : fmtX(lev)}`,
        `❤️ Health: ${h == null ? "?" : fmtPct(h)}`
      );
    }

    // Isolated block: coin / leverage / funding / health
    const raw = ov.raw;
    const { isoPos } = classifyPositions(raw, mmUsed);
    const isoBlock: string[] = ["🟨 <b>Isolated</b>", ""];
    if (!isoPos.length) {
      isoBlock.push("( no open positions )");
    } else {
      for (const p of isoPos) isoBlock.push(...renderPositionLines(p, marks, funding), "");
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
  const { marks, funding } = await getMarksAndFunding(env);
  const lines: string[] = ["📄 <b>Per-Position Status</b>"];
  const total = addresses.length;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const raw = await hlInfo(env, { type: "clearinghouseState", user: addr });
    const ov = computeOverviewFromRaw(raw);

    const mmUsed = Number(ov.crossMaintMargin || 0) > 0;
    const { isoPos } = classifyPositions(raw, mmUsed);

    const title = `<b>Account ${i + 1}</b>\n🔑 Address: <code>${addr}</code>`;
    const h = healthAccountPct(ov.accountValue, ov.crossMaintMargin, ov.unrealizedPnl);

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
      for (const p of isoPos) isoBlock.push(...renderPositionLines(p, marks, funding), "");
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

/* ----- isolated position lines (coin, leverage, funding, health) ----- */
function renderPositionLines(p: any, marks: Record<string, number>, fundingMap: Record<string, number>): string[] {
  const coin = p.coin;
  const liq = p.liquidationPx as number | null;
  const entry = p.entryPx as number;
  const side = (p.side || "").toLowerCase();
  const mark = marks[coin];

  // Compute leverage from entry & liq (preferred)
  let levRaw = NaN;
  if (isFinite(entry) && entry > 0 && isFinite(liq ?? NaN) && (liq as number) > 0) {
    const denom = side.startsWith("long") ? (entry - (liq as number)) : ((liq as number) - entry);
    if (denom > 0) levRaw = entry / denom;
  }
  // Fallback: try leverage-like fields from payload
  if (!isFinite(levRaw) || levRaw <= 0) {
    const cands = [p.raw?.leverage, p.raw?.lev, p.raw?.x, p.raw?.risk?.leverage];
    for (const v of cands) {
      const n = Number(v);
      if (isFinite(n) && n > 0) { levRaw = n; break; }
    }
  }
  const levDisplay = (isFinite(levRaw) && levRaw > 0) ? Math.round(levRaw) : NaN;

  // Health with leverage multiplier (capped [0,100]) — uses current mark
  const h = (isFinite(mark) && isFinite(entry) && isFinite(liq ?? NaN))
    ? healthPosPct(mark, liq as number, entry, side)
    : null;

  const fr = fundingMap[coin]; // hourly decimal, e.g. 0.0002 => 0.02%/h

  return [
    `🪙 ${coin}`,
    `📈 Leverage: ${isFinite(levDisplay) ? `${levDisplay}x` : "?"}`,
    `🔁 Funding: ${fr == null ? "?" : fmtSignedPctPerHour(fr)}`,
    `❤️ Health: ${h == null ? "?" : fmtPct(h)}`
  ];
}
