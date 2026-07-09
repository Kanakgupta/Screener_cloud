/**
 * HerAI Extract — structured parsers for HeRAI's own built HTML assets.
 *
 * Mirrors SCREENER_WEB_PRIV_OPTIMIZD/HerAI/engine/stock_extract.py and
 * screener_extract.py in plain JavaScript so the Cloudflare Worker can ground
 * answers in the SAME rich data the local Python service uses, instead of a
 * crude stripped-HTML blob.
 *
 * Public:
 *   extractStockContext(html, url) -> structured snapshot
 *   parseScreenerTable(html, limit) -> array of row objects
 */

function stripHtml(s) {
  if (!s) return "";
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[#]?[a-zA-Z0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/"/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : "";
}

function allMatches(html, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    out.push(m.slice(1));
  }
  return out;
}

// ── Per-stock page extraction ───────────────────────────────────────────────
function headerStats(html) {
  const out = {};
  const price = firstMatch(html, /<div class="price">([^<]+)<\/div>/i);
  if (price) out.Price = stripTags(price);
  const tiles = allMatches(html, /<div class="ps-tile"><span>([^<]+)<\/span><strong[^>]*>([^<]+)<\/strong><\/div>/gi);
  for (const [label, val] of tiles) {
    out[stripTags(label)] = stripTags(val);
  }
  return out;
}

function faqBlock(html) {
  const m = html.match(/"@type":\s*"FAQPage".*?"mainEntity":\s*\[(.*?)\]\s*\}\s*<\/script>/is);
  if (!m) return [];
  const body = m[1];
  const out = [];
  const re = /"name":\s*"((?:[^"\\]|\\.)*)".*?"text":\s*"((?:[^"\\]|\\.)*)"/gis;
  let qm;
  while ((qm = re.exec(body)) !== null) {
    const q = qm[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
    const a = qm[2].replace(/\\"/g, '"').replace(/\\n/g, " ");
    if (q && a) out.push({ q: stripTags(q), a: stripTags(a) });
  }
  return out;
}

function reasons(html) {
  const out = [];
  const re = /<div class="co-reason-title">([^<]+)<\/div>\s*<p class="co-reason-text">([^<]+)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ title: stripTags(m[1]), text: stripTags(m[2]) });
  }
  return out;
}

function recentDevelopments(html) {
  const out = [];
  const re = /<span class="co-tl-period">([^<]+)<\/span>\s*<span class="co-tl-text">([^<]+)<\/span>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ period: stripTags(m[1]), text: stripTags(m[2]) });
  }
  return out;
}

function technicalSnapshot(html) {
  const snap = {};
  const m = html.match(/<div class="co-snap-card">(.*?)Auto-generated from price history and fundamentals/is);
  if (!m) return snap;
  const block = m[1];
  const trend = firstMatch(block, /<span class="co-snap-trend[^"]*">([^<]+)<\/span>/i);
  if (trend) snap.trend = stripTags(trend);
  const rangePos = firstMatch(block, /<strong>([\d.]+% of range)<\/strong>/i);
  if (rangePos) snap.range_position = rangePos;

  const signals = {};
  const sigRe = /<li><span>([^<]+)<\/span><strong[^>]*>([^<]+)<\/strong><\/li>/gi;
  let sm;
  while ((sm = sigRe.exec(block)) !== null) signals[stripTags(sm[1])] = stripTags(sm[2]);
  if (Object.keys(signals).length) snap.signals = signals;

  const returns = {};
  const retRe = /<div class="co-snap-ret"><span>([^<]+)<\/span><strong[^>]*>([^<]+)<\/strong><\/div>/gi;
  let rm;
  while ((rm = retRe.exec(block)) !== null) returns[stripTags(rm[1])] = stripTags(rm[2]);
  if (Object.keys(returns).length) snap.returns = returns;

  const val = firstMatch(block, /<p class="co-snap-val">(.*?)<\/p>/is);
  if (val) snap.valuation_vs_sector = stripTags(val);
  return snap;
}

function prosCons(html) {
  const out = { pros: [], cons: [] };
  const m = html.match(/<section class="proscons">(.*?)<\/section>/is);
  if (!m) return out;
  const block = m[1];
  const prosM = block.match(/<div class="pros">.*?<ul>(.*?)<\/ul>/is);
  const consM = block.match(/<div class="cons">.*?<ul>(.*?)<\/ul>/is);
  if (prosM) {
    out.pros = allMatches(prosM[1], /<li>(.*?)<\/li>/gi).map((x) => stripTags(x[0]));
  }
  if (consM) {
    out.cons = allMatches(consM[1], /<li>(.*?)<\/li>/gi).map((x) => stripTags(x[0]));
  }
  return out;
}

function ratioTiles(html) {
  const out = {};
  const re = /<section class="ratio-tile">\s*<h3 class="ratio-tile-title">([^<]+)<\/h3>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = stripTags(m[1]);
    const block = m[2];
    const rows = {};
    // Each row is wrapped in an extra <div>: <div><div class="ratio-label">...</div><div class="ratio-val">...</div></div>
    const rowRe = /<div[^>]*>\s*<div class="ratio-label">([^<]+)<\/div>\s*<div class="ratio-val">([^<]+)<\/div>\s*<\/div>/gi;
    let rm;
    while ((rm = rowRe.exec(block)) !== null) rows[stripTags(rm[1])] = stripTags(rm[2]);
    if (Object.keys(rows).length) out[title] = rows;
  }
  return out;
}

function peerTable(html) {
  const m = html.match(/<h2 id="peers">Peer comparison<\/h2>([\s\S]*?)<\/table>/is);
  if (!m) return [];
  const block = m[1];
  const headers = allMatches(block, /<th[^>]*>(.*?)<\/th>/gis).map((h) => stripTags(h[0]));
  const rows = allMatches(block, /<tr[^>]*>([\s\S]*?)<\/tr>/gi).map((r) => r[0]);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const rawCells = allMatches(rows[i], /<td[^>]*>(.*?)<\/td>/gis).map((c) => c[0]);
    if (!rawCells.length || rawCells.length < 2) continue;
    const row = {};
    for (let j = 0; j < rawCells.length; j++) {
      const h = headers[j] || `col${j}`;
      if (h === "#" || h === "") continue;
      let val = rawCells[j];
      // First cell contains <a><strong>TICKER</strong> <span class="muted">Name</span></a>
      if (j === 1) {
        const tickerM = val.match(/<strong>([^<]+)<\/strong>/i);
        const nameM = val.match(/<span class="muted">([^<]+)<\/span>/i);
        if (tickerM && nameM) {
          row.Ticker = stripTags(tickerM[1]);
          row.Name = stripTags(nameM[1]);
          continue;
        }
      }
      row[h] = stripTags(val);
    }
    if (Object.keys(row).length) out.push(row);
  }
  return out.slice(0, 8);
}

export function extractStockContext(html, url) {
  return {
    url,
    header: headerStats(html),
    faq: faqBlock(html),
    reasons: reasons(html),
    recent_developments: recentDevelopments(html),
    technical_snapshot: technicalSnapshot(html),
    pros_cons: prosCons(html),
    ratios: ratioTiles(html),
    peers: peerTable(html),
  };
}

export function stockContextToText(snap, ticker, maxChars = 4500) {
  const lines = [`### ${ticker}`];
  if (snap.header && Object.keys(snap.header).length) {
    lines.push("Header: " + Object.entries(snap.header).map(([k, v]) => `${k}: ${v}`).join(" | "));
  }
  if (snap.faq && snap.faq.length) {
    for (const qa of snap.faq.slice(0, 5)) {
      lines.push(`Q: ${qa.q}\nA: ${qa.a}`);
    }
  }
  if (snap.reasons && snap.reasons.length) {
    lines.push("Why investors should care:");
    for (const r of snap.reasons) lines.push(`- ${r.title}: ${r.text}`);
  }
  if (snap.recent_developments && snap.recent_developments.length) {
    lines.push("Recent developments:");
    for (const d of snap.recent_developments) lines.push(`- ${d.period}: ${d.text}`);
  }
  const ts = snap.technical_snapshot || {};
  if (ts.trend || ts.range_position || Object.keys(ts.signals || {}).length || Object.keys(ts.returns || {}).length) {
    const bits = [];
    if (ts.trend) bits.push(`trend: ${ts.trend}`);
    if (ts.range_position) bits.push(`52w range position: ${ts.range_position}`);
    if (ts.signals) bits.push(Object.entries(ts.signals).map(([k, v]) => `${k}: ${v}`).join("; "));
    if (ts.returns) bits.push("returns " + Object.entries(ts.returns).map(([k, v]) => `${k}: ${v}`).join(", "));
    if (ts.valuation_vs_sector) bits.push(ts.valuation_vs_sector);
    if (bits.length) lines.push("Technical snapshot: " + bits.join(" | "));
  }
  const pc = snap.pros_cons || {};
  if (pc.pros && pc.pros.length) lines.push("Pros: " + pc.pros.join("; "));
  if (pc.cons && pc.cons.length) lines.push("Cons: " + pc.cons.join("; "));
  for (const [section, rows] of Object.entries(snap.ratios || {})) {
    lines.push(`${section}: ` + Object.entries(rows).map(([k, v]) => `${k}: ${v}`).join(" | "));
  }
  if (snap.peers && snap.peers.length) {
    lines.push(`Peer comparison (${snap.peers.length} companies): ` +
      snap.peers.slice(0, 5).map((p) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(", ")).join("; "));
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

// ── Screener table extraction ───────────────────────────────────────────────
function firstTable(html) {
  const m = html.match(/<table class="data-table.*?<\/table>/is);
  return m ? m[0] : null;
}

function tableHeaders(table) {
  const thead = table.match(/<thead>(.*?)<\/thead>/is);
  if (!thead) return [];
  return allMatches(thead[1], /<th[^>]*>(.*?)<\/th>/gis).map((h) => stripTags(h[0]));
}

function parseNumber(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function findMetric(metrics, ...names) {
  const set = new Set(names.map((n) => n.toLowerCase()));
  for (let i = 0; i < metrics.length; i++) {
    if (set.has(metrics[i][0].toLowerCase())) return [i, metrics[i][1]];
  }
  return null;
}

function augmentWithPeg(row) {
  const metrics = row.metrics || [];
  const peHit = findMetric(metrics, "p/e");
  const growthHit = findMetric(metrics, "profit cagr 5y %", "rev cagr 5y %");
  if (!peHit || !growthHit) return row;
  const pe = parseNumber(peHit[1]);
  const growth = parseNumber(growthHit[1]);
  if (pe === null || !growth || growth <= 0) return row;
  const peg = Math.round((pe / growth) * 100) / 100;
  const newMetrics = [...metrics];
  newMetrics.splice(peHit[0] + 1, 0, ["PEG", String(peg)]);
  row.metrics = newMetrics;
  return row;
}

export function parseScreenerTable(html, limit = 8) {
  const table = firstTable(html);
  if (!table) return [];
  const headers = tableHeaders(table);
  const tbodyMatch = table.match(/<tbody[^>]*>(.*?)<\/tbody>/is);
  const body = tbodyMatch ? tbodyMatch[1] : table;
  const rowBlocks = allMatches(body, /<tr(\s[^>]*)?>(.*?)<\/tr>/gis);
  const out = [];
  for (const [attrStr, rh] of rowBlocks) {
    const tk = rh.match(/stocks\/([A-Za-z0-9.\-]+)\.html/);
    if (!tk) continue;
    const ticker = tk[1].replace(".NS", "").replace(".BO", "");
    const cells = allMatches(rh, /<td[^>]*>(.*?)<\/td>/gis).map((c) => stripTags(c[0]));
    const pairs = [];
    let name = "";
    for (let i = 0; i < cells.length; i++) {
      const head = headers[i] || "";
      const hl = head.toLowerCase();
      const cell = cells[i];
      if (hl === "name") { name = cell; continue; }
      if (["#", "", "charts", "ticker"].includes(hl) || !cell) continue;
      pairs.push([head, cell]);
    }
    const attrs = {};
    if (attrStr) {
      const attrRe = /([\w-]+)="([^"]*)"/gi;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) attrs[am[1]] = am[2];
    }
    out.push(augmentWithPeg({ ticker, name, metrics: pairs, attrs }));
    if (out.length >= limit) break;
  }
  return out;
}

// ── Price-history extraction & technical math ───────────────────────────────
// Stock pages embed a full daily OHLCV array as `const HIST = [{d,o,h,l,c,v}]`.
// This lets HerAI derive REAL support / swing-low / breakout / moving-average
// levels from actual closes instead of guessing.
export function extractPriceHistory(html) {
  if (!html) return [];
  const m = html.match(/const\s+HIST\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((b) => ({
      d: b.d,
      o: Number(b.o),
      h: Number(b.h),
      l: Number(b.l),
      c: Number(b.c),
      v: Number(b.v),
    }))
    .filter((b) => Number.isFinite(b.c) && Number.isFinite(b.h) && Number.isFinite(b.l));
}

function _sma(vals, n) {
  if (!vals.length || vals.length < 1) return null;
  const slice = vals.slice(-n);
  if (!slice.length) return null;
  const s = slice.reduce((a, b) => a + b, 0);
  return s / slice.length;
}

function _round(x, dp = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const p = Math.pow(10, dp);
  return Math.round(x * p) / p;
}

// Local pivot lows over a lookback window: a bar whose low is the lowest within
// +/- `span` neighbours. Returns the pivot low prices, most-recent first.
function _pivotLows(hist, span = 3, lookback = 120) {
  const h = hist.slice(-lookback);
  const lows = [];
  for (let i = span; i < h.length - span; i++) {
    let isPivot = true;
    for (let j = 1; j <= span; j++) {
      if (h[i].l > h[i - j].l || h[i].l > h[i + j].l) { isPivot = false; break; }
    }
    if (isPivot) lows.push({ d: h[i].d, l: h[i].l });
  }
  return lows.reverse();
}

/**
 * Derive a compact, evidence-rich technical picture from daily OHLCV.
 * Everything returned is computed from real closes — no invented numbers.
 */
export function computeTechnicals(hist) {
  if (!hist || hist.length < 20) return null;
  const closes = hist.map((b) => b.c);
  const highs = hist.map((b) => b.h);
  const lows = hist.map((b) => b.l);
  const last = closes[closes.length - 1];

  const sma20 = _sma(closes, 20);
  const sma50 = _sma(closes, 50);
  const sma200 = _sma(closes, 200);

  const win252 = hist.slice(-252);
  const hi52 = Math.max(...win252.map((b) => b.h));
  const lo52 = Math.min(...win252.map((b) => b.l));
  const rangePos = hi52 > lo52 ? ((last - lo52) / (hi52 - lo52)) * 100 : null;

  // Recent swing low (20 bars) and 20-day breakout level (prior 20 highs).
  const swingLow = Math.min(...lows.slice(-20));
  const priorHighs = highs.slice(-21, -1);
  const breakout20 = priorHighs.length ? Math.max(...priorHighs) : null;

  // Nearest support below current price from pivot lows + key MAs + swing low.
  const supportCandidates = [];
  for (const p of _pivotLows(hist)) if (p.l < last) supportCandidates.push(p.l);
  if (swingLow < last) supportCandidates.push(swingLow);
  if (sma50 && sma50 < last) supportCandidates.push(sma50);
  if (sma200 && sma200 < last) supportCandidates.push(sma200);
  const nearestSupport = supportCandidates.length ? Math.max(...supportCandidates) : null;

  // Simple 14-period RSI from closes (Wilder-style average).
  let rsi = null;
  if (closes.length >= 15) {
    let gain = 0, loss = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
    }
    const ag = gain / 14, al = loss / 14;
    rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  const pctTo = (lvl) => (lvl && last ? _round(((lvl - last) / last) * 100, 2) : null);

  return {
    last: _round(last),
    sma20: _round(sma20),
    sma50: _round(sma50),
    sma200: _round(sma200),
    above_sma50: sma50 != null ? last >= sma50 : null,
    above_sma200: sma200 != null ? last >= sma200 : null,
    hi52: _round(hi52),
    lo52: _round(lo52),
    range_position_pct: _round(rangePos, 1),
    swing_low: _round(swingLow),
    breakout_20d: _round(breakout20),
    nearest_support: _round(nearestSupport),
    support_pct_from_price: pctTo(nearestSupport),
    sma50_pct_from_price: pctTo(sma50),
    sma200_pct_from_price: pctTo(sma200),
    rsi14: _round(rsi, 1),
    bars: hist.length,
  };
}

export function technicalsToText(t) {
  if (!t) return "";
  const bits = [];
  bits.push(`last close ${t.last}`);
  if (t.sma20 != null) bits.push(`SMA20 ${t.sma20}`);
  if (t.sma50 != null) bits.push(`SMA50 ${t.sma50} (${t.above_sma50 ? "price above" : "price below"})`);
  if (t.sma200 != null) bits.push(`SMA200 ${t.sma200} (${t.above_sma200 ? "price above" : "price below"})`);
  if (t.rsi14 != null) bits.push(`RSI(14) ${t.rsi14}`);
  if (t.hi52 != null && t.lo52 != null) bits.push(`52w range ${t.lo52}–${t.hi52} (${t.range_position_pct}% of range)`);
  if (t.nearest_support != null) bits.push(`nearest support ${t.nearest_support} (${t.support_pct_from_price}% from price)`);
  if (t.swing_low != null) bits.push(`20-bar swing low ${t.swing_low}`);
  if (t.breakout_20d != null) bits.push(`20-day breakout above ${t.breakout_20d}`);
  return "Computed technicals: " + bits.join(", ") + ".";
}

// ── Screen-pool builder ─────────────────────────────────────────────────────
// Merge rows from several prebuilt screener HTMLs into one candidate pool
// keyed by ticker, unioning setup tags, index-universe membership and metrics.
// `screens` is an array of { name, html }.
export function buildScreenPool(screens, perScreenLimit = 60) {
  const pool = new Map();
  for (const s of screens || []) {
    if (!s || !s.html) continue;
    const rows = parseScreenerTable(s.html, perScreenLimit);
    for (const r of rows) {
      const key = r.ticker;
      if (!key) continue;
      const idx = (r.attrs && r.attrs["data-idx"] ? r.attrs["data-idx"].split(",") : [])
        .map((x) => x.trim()).filter(Boolean);
      const metrics = {};
      for (const [k, v] of r.metrics || []) metrics[k] = v;
      let entry = pool.get(key);
      if (!entry) {
        entry = {
          ticker: key,
          name: r.name || "",
          screens: new Set(),
          universes: new Set(),
          setups: new Set(),
          metrics: {},
        };
        pool.set(key, entry);
      }
      if (r.name && !entry.name) entry.name = r.name;
      entry.screens.add(s.name);
      for (const u of idx) entry.universes.add(u);
      // Setup column contains emoji-labelled tags; capture distinct phrases.
      const setup = metrics["Setup"] || metrics["Setups"] || "";
      for (const tag of String(setup).split(/\s{2,}|\u{1F680}|\u{1F4C8}|\u{1F525}/u)) {
        const cleaned = tag.trim();
        if (cleaned && cleaned.length > 2) entry.setups.add(cleaned);
      }
      // Keep the union of metric values (first non-empty wins).
      for (const [k, v] of Object.entries(metrics)) {
        if (v && entry.metrics[k] === undefined) entry.metrics[k] = v;
      }
    }
  }
  // Materialise sets to arrays.
  return Array.from(pool.values()).map((e) => ({
    ticker: e.ticker,
    name: e.name,
    screens: Array.from(e.screens),
    universes: Array.from(e.universes),
    setups: Array.from(e.setups),
    metrics: e.metrics,
  }));
}
