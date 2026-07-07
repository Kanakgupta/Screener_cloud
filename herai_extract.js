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
  const headers = allMatches(block, /<th[^>]*>(.*?)<\/th>/gi).map((h) => stripTags(h[0]));
  const rows = allMatches(block, /<tr[^>]*>([\s\S]*?)<\/tr>/gi).map((r) => r[0]);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const rawCells = allMatches(rows[i], /<td[^>]*>(.*?)<\/td>/gi).map((c) => c[0]);
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
  return allMatches(thead[1], /<th[^>]*>(.*?)<\/th>/gi).map((h) => stripTags(h[0]));
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
  const rowBlocks = allMatches(body, /<tr(\s[^>]*)?>(.*?)<\/tr>/gi);
  const out = [];
  for (const [attrStr, rh] of rowBlocks) {
    const tk = rh.match(/stocks\/([A-Za-z0-9.\-]+)\.html/);
    if (!tk) continue;
    const ticker = tk[1].replace(".NS", "").replace(".BO", "");
    const cells = allMatches(rh, /<td[^>]*>(.*?)<\/td>/gi).map((c) => stripTags(c[0]));
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
