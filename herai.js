/**
 * HerAI — Multi-Agent Stock Q&A Orchestrator (Cloudflare Worker module)
 *
 * Free-tier stack:
 *   - LLM primary: Cloudflare Workers AI binding (env.AI)
 *   - LLM fallback: Gemini -> Groq -> Cerebras -> OpenRouter (optional secrets)
 *   - Grounding: reads already-deployed static assets (stock HTMLs, /_fred_cache.json)
 *   - Web fallback: DuckDuckGo (no key) — used only when internal data is thin
 *   - Optional answer cache: env.HERAI_KV (falls back to no-cache if unbound)
 *   - Region-aware asset routing: env.STOCK_MANIFEST (KV namespace) for
 *     sub-millisecond ticker resolution across USA/India markets.
 *
 * Public entry: handleHeraiRequest(request, env, ctx)
 *   Routes:
 *     POST /api/herai/chat   { message, region, history? } -> { answer, ... }
 *     GET  /api/herai/health -> { ok, providers }
 *
 * Design: docs/HERAI_MULTI_AGENT_DESIGN.md
 */

import {
  extractStockContext,
  stockContextToText,
  parseScreenerTable,
  extractPriceHistory,
  computeTechnicals,
  technicalsToText,
  buildScreenPool,
} from "./herai_extract.js";

// ── LLM provider chain (mirrors HerAI/engine/query_engine.py) ───────────────
const PROVIDERS = [
  { id: "gemini",     model: "gemini-2.5-flash",                       keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  { id: "groq",       model: "llama-3.3-70b-versatile",                keys: ["GROQ_API_KEY"] },
  { id: "cerebras",   model: "llama3.1-70b",                           keys: ["CEREBRAS_API_KEY"] },
  { id: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", keys: ["OPENROUTER_API_KEY"] },
];

const ALLOWED_REGIONS = new Set(["usa", "india"]);
const MAX_MESSAGE = 1500;
const MAX_HISTORY = 6;          // last N turns sent for context
const CACHE_TTL_SECONDS = 900;  // 15 min answer cache

const DISCLAIMER =
  "This is informational analysis generated from HeRAI's own data, not investment advice. " +
  "Data may be delayed or incomplete. Always do your own research.";

// ── Two-stage model pipeline ─────────────────────────────────────────
// Stage 1 — Analysis: high-context model for reading HTML data & running specialists.
//   Uses Kimi K2.7 Code (Moonshot AI) for its large context window.
// Stage 2 — Synthesis: latest generation model for polished final output.
//   Uses Gemma 4 (Google) for its superior instruction-following & presentation.
// Both can be overridden via env vars:
//   HERAI_AI_MODEL       (default: @cf/moonshotai/kimi-k2.7-code)
//   HERAI_SYNTHESIS_MODEL (default: @cf/google/gemma-4-26b-a4b-it)
const DEFAULT_CF_MODEL = "@cf/moonshotai/kimi-k2.7-code";
const DEFAULT_SYNTHESIS_MODEL = "@cf/google/gemma-4-26b-a4b-it";

// Workers AI text generation models (names verified to exist on the platform).
// Ordered by quality/speed — the function tries each in sequence, so a fast
// working model is found quickly.
const CF_MODEL_FALLBACKS = [
  // ── Large chat / instruction models ───────────────────────────────────
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-70b-instruct",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.2-11b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",

  // ── Mistral family ───────────────────────────────────────────────────
  "@cf/mistral/mistral-7b-instruct-v0.3",
  "@cf/mistral/mistral-7b-instruct-v0.2",
  "@cf/mistral/mistral-7b-instruct-v0.1",

  // ── Google Gemma family ──────────────────────────────────────────────
  "@cf/google/gemma-2-27b-it",
  "@cf/google/gemma-2-9b-it",
  "@cf/google/gemma-2-2b-it",

  // ── Microsoft Phi family ─────────────────────────────────────────────
  "@cf/microsoft/phi-3.5-mini-instruct",
  "@cf/microsoft/phi-3-mini-4k-instruct",
  "@cf/microsoft/phi-3-mini-128k-instruct",
  "@cf/microsoft/phi-2",
];

// ── Helpers ────────────────────────────────────────────────────────────────
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}
function firstKey(env, keys) {
  for (const k of keys) {
    if (env && env[k]) return env[k];
  }
  return null;
}
function availableProviders(env) {
  return PROVIDERS.filter((p) => firstKey(env, p.keys));
}
function hasWorkersAI(env) {
  return !!(env && env.AI && typeof env.AI.run === "function");
}
function workersAiModel(env) {
  const m = String(env?.HERAI_AI_MODEL || "").trim();
  return m || DEFAULT_CF_MODEL;
}
function workersAiModelCandidates(env) {
  const cfg = String(env?.HERAI_AI_MODEL || "").trim();
  const ordered = [cfg, ...CF_MODEL_FALLBACKS].filter(Boolean);
  return [...new Set(ordered)];
}
function synthesisWorkersAiModel(env) {
  const m = String(env?.HERAI_SYNTHESIS_MODEL || "").trim();
  return m || DEFAULT_SYNTHESIS_MODEL;
}
function clip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) : s;
}
function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[#]?[a-zA-Z0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Unified LLM call across the free chain ──────────────────────────────────
async function callLLM(env, system, user, { wantJson = false, maxTokens = 900, model } = {}) {
  const providers = availableProviders(env);
  let workersAiErr = null;

  // Primary path: Workers AI binding
  if (hasWorkersAI(env)) {
    try {
      const text = await callWorkersAI(env, system, user, wantJson, maxTokens, model);
      if (text && text.trim()) return { text: text.trim(), provider: "workers-ai" };
    } catch (e) {
      workersAiErr = e;
      // fall through to provider-chain fallback
    }
  }

  if (!providers.length) {
    if (workersAiErr) throw new Error(`WORKERS_AI_FAILED: ${workersAiErr.message || workersAiErr}`);
    throw new Error("NO_LLM_KEYS");
  }

  let lastErr = null;
  for (const p of providers) {
    const key = firstKey(env, p.keys);
    try {
      const text = await callOne(p, key, system, user, wantJson, maxTokens);
      if (text && text.trim()) return { text: text.trim(), provider: p.id };
    } catch (e) {
      lastErr = e;
      // try next provider
    }
  }
  throw lastErr || new Error("LLM_ALL_FAILED");
}

/**
 * Extract text response from any Workers AI model output shape.
 *
 * Workers AI text-generation models return one of several shapes depending on
 * model family and whether the request used `messages` or `prompt`:
 *
 *   { result: { response: "..." } }        — most common with messages
 *   { response: "..." }                    — some models return at top level
 *   { result: [{ text: "..." }, ...] }     — legacy array format
 *   { result: { output_text: "..." } }     — some non-chat models
 *   { choices: [{ message: { content } }] } — OpenAI-compat (rare on Workers AI)
 *   { output_text: "..." }                 — embeddings / some text models
 */
function extractWAIResponse(out) {
  if (!out) return "";

  // 1) Most common: { result: { response: "..." } }
  if (out.result && typeof out.result.response === "string") {
    const t = out.result.response.trim();
    if (t) return t;
  }

  // 2) Top-level response field
  if (typeof out.response === "string") {
    const t = out.response.trim();
    if (t) return t;
  }

  // 3) OpenAI-compatible format: { choices: [{ message: { content } }] }
  if (Array.isArray(out.choices)) {
    for (const c of out.choices) {
      if (c && c.message && typeof c.message.content === "string") {
        const t = c.message.content.trim();
        if (t) return t;
      }
    }
  }

  // 4) Array result: { result: [{ text: "..." }, ...] }
  if (Array.isArray(out.result)) {
    const parts = out.result
      .map((x) => (x && typeof x.text === "string" ? x.text : ""))
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }

  // 5) output_text field (some non-chat models)
  if (typeof out.output_text === "string") {
    const t = out.output_text.trim();
    if (t) return t;
  }

  // 6) Nested result.output_text
  if (out.result && typeof out.result.output_text === "string") {
    const t = out.result.output_text.trim();
    if (t) return t;
  }

  return "";
}

/**
 * Call Workers AI with model fallback.
 *
 * Tries each model in the candidate list in sequence until one returns a
 * non-empty response. On error (any error) it moves to the next model.
 * Only throws after ALL models have been exhausted.
 */
async function callWorkersAI(env, system, user, wantJson, maxTokens, overrideModel) {
  const models = overrideModel
    ? [overrideModel]
    : workersAiModelCandidates(env);
  const jsonTail = wantJson
    ? "\n\nReturn ONLY a valid JSON object. Do not add markdown fences or extra text."
    : "";
  const promptUser = `${user}${jsonTail}`;

  let lastErr = null;
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: promptUser },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: false,
      });

      const text = extractWAIResponse(out);
      if (text) return text;
    } catch (e) {
      lastErr = e;
      // Try the next model on ANY error
      continue;
    }
  }
  throw lastErr || new Error("workers ai returned empty output");
}

async function callOne(p, key, system, user, wantJson, maxTokens) {
  if (p.id === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingBudget: 0 },
        ...(wantJson ? { responseMimeType: "application/json" } : {}),
      },
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`gemini ${r.status}`);
    const data = await r.json();
    return data?.candidates?.[0]?.content?.parts?.map((x) => x.text).join("") || "";
  }

  // OpenAI-compatible: groq / cerebras / openrouter
  const bases = {
    groq: "https://api.groq.com/openai/v1",
    cerebras: "https://api.cerebras.ai/v1",
    openrouter: "https://openrouter.ai/api/v1",
  };
  const url = `${bases[p.id]}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
  if (p.id === "openrouter") {
    headers["HTTP-Referer"] = "https://heraiscreener.com";
    headers["X-Title"] = "HeRAI Screener";
  }
  const body = {
    model: p.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
    ...(wantJson ? { response_format: { type: "json_object" } } : {}),
  };
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p.id} ${r.status}`);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "";
}

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* try to extract */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* noop */ } }
  return null;
}

// ── Router: intent + entities + which specialists are needed ────────────────
const ROUTER_SYSTEM = `You are the routing brain of a senior stock-market analyst assistant.
Classify the user's question and extract entities. Return ONLY JSON:
{
  "intent": "PRICE_TARGET|SCREEN_PICK|STOCK_DEEP_DIVE|SECTOR_ANALYSIS|MARKET_REGIME|COMPARE_STOCKS|NEWS_QUERY|GENERAL_QUERY",
  "tickers": ["AAPL"],
  "sectors": [],
  "universe": "SPX|NDX|R2K|ALL",
  "count": 10,
  "timeframe": "short|medium|long|unspecified",
  "needs": ["technical","fundamental","news","macro"],
  "confidence": 0.0
}
Intent guide:
- PRICE_TARGET: user asks the right/fair/good entry or buy price, buy zone, support level, or "when/at what price to buy X" for a specific company. Put that company in "tickers".
- SCREEN_PICK: user wants a LIST of stocks to buy/invest/watch (e.g. "give me 10 stocks to invest", "best S&P 500 stocks", "top picks tomorrow"). Set "count" (default 10) and "universe" (SPX for S&P 500, NDX for Nasdaq-100, R2K for Russell 2000, ALL otherwise).
- STOCK_DEEP_DIVE: analyse one or more named companies (no explicit price ask).
- MARKET_REGIME: overall market mood / is it a bull or bear market.
Rules: "needs" lists ONLY the specialists required. For a single-stock analysis include technical+fundamental+news.
Tickers must be plain symbols (uppercase, no exchange suffix). Map company names to tickers (e.g. Reliance->RELIANCE, Apple->AAPL). If none, return [].`;

async function routeQuery(env, message, history, region) {
  const historyText = (history || [])
    .slice(-MAX_HISTORY)
    .map((h) => `${h.role === "user" ? "User" : "HerAI"}: ${clip(h.content, 300)}`)
    .join("\n");
  const user = `Region: ${region}\n${historyText ? "Conversation so far:\n" + historyText + "\n" : ""}New question: ${message}`;

  try {
    const { text } = await callLLM(env, ROUTER_SYSTEM, user, { wantJson: true, maxTokens: 300 });
    const parsed = parseJsonLoose(text);
    if (parsed) return enrichRouteWithTicker(normalizeRoute(parsed), message);
  } catch (e) {
    if (String(e.message).includes("NO_LLM_KEYS")) throw e;
  }
  return enrichRouteWithTicker(ruleRoute(message), message);
}

// ── Universe / count parsing shared by router + handlers ────────────────────
const UNIVERSE_LABELS = { SPX: "S&P 500", NDX: "Nasdaq-100", R2K: "Russell 2000", ALL: "the full market" };

function parseUniverse(message) {
  const m = String(message || "");
  if (/\b(s\s*&\s*p\s*500|sp\s?500|spx|s and p 500)\b/i.test(m)) return "SPX";
  if (/\b(nasdaq[-\s]?100|ndx|nasdaq 100)\b/i.test(m)) return "NDX";
  if (/\b(russell\s?2000|r2k|russell 2k)\b/i.test(m)) return "R2K";
  return "ALL";
}

function parseCount(message, fallback = 10) {
  const m = String(message || "").match(/\b(\d{1,3})\b/);
  let n = m ? parseInt(m[1], 10) : fallback;
  if (!Number.isFinite(n) || n <= 0) n = fallback;
  return Math.min(Math.max(n, 1), 25);
}

const RE_PRICE_TARGET =
  /(right|fair|good|best|ideal|entry|target|correct)\s+(price|entry|level|point)|price\s+to\s+buy|when\s+to\s+buy|at\s+what\s+price|buy\s+(price|zone|level|point|target)|support\s+(level|price|zone)|good\s+entry|entry\s+point/i;
const RE_SCREEN_PICK =
  /(give|show|find|list|suggest|recommend|top|best)\b[\s\S]*\b(stocks?|picks?|ideas?|names?|companies)|stocks?\s+to\s+(buy|invest|watch|trade)|what\s+(should\s+i|to)\s+buy|invest\s+(in\b|tomorrow|today|now)|\b\d{1,3}\s+(stocks?|picks?)\b/i;
const RE_BREAKOUT = /\b(break(?:ing)?\s*out|breakout|golden\s+cross)\b/i;

function isStockSpecific(message) {
  if (RE_SCREEN_PICK.test(message)) return false;
  if (/\b(stocks|shares|ideas|names|companies|picks|list|screener|screen)\b/i.test(message)) return false;
  return true;
}


function enrichRouteWithTicker(route, message) {
  const out = { ...route };
  out.universe = ["SPX", "NDX", "R2K", "ALL"].includes(out.universe) ? out.universe : parseUniverse(message);
  out.count = parseCount(message, typeof out.count === "number" ? out.count : 10);

  if (RE_SCREEN_PICK.test(message) && !RE_PRICE_TARGET.test(message)) {
    out.intent = "SCREEN_PICK";
    out.tickers = [];
    out.needs = ["technical", "fundamental", "news"];
    return out;
  }

  const tokens = Array.from(new Set((message.match(/\b[A-Z]{2,5}\b/g) || []).slice(0, 4)))
    .filter((t) => !["AND", "THE", "FOR", "USA", "SP", "ETF", "IPO", "CEO", "USD", "INR"].includes(t));
  if ((!out.tickers || !out.tickers.length) && out.intent !== "SCREEN_PICK") {
    out.tickers = tokens;
  }

  if (RE_PRICE_TARGET.test(message) && (out.tickers && out.tickers.length || out.intent === "PRICE_TARGET")) {
    out.intent = "PRICE_TARGET";
    out.needs = ["technical", "fundamental", "news"];
    return out;
  }

  if (out.tickers && out.tickers.length && (!out.needs || !out.needs.length)) {
    out.needs = ["technical", "fundamental", "news"];
  }
  if (
    out.tickers && out.tickers.length &&
    (!out.intent || out.intent === "GENERAL_QUERY") &&
    /(overview|about|analy[sz]e|analysis|deep\s*dive|look\s*at)/i.test(message)
  ) {
    out.intent = "STOCK_DEEP_DIVE";
  }
  return out;
}

function normalizeRoute(r) {
  const validNeeds = new Set(["technical", "fundamental", "news", "macro"]);
  const validIntents = new Set([
    "PRICE_TARGET", "SCREEN_PICK", "STOCK_DEEP_DIVE", "SECTOR_ANALYSIS",
    "MARKET_REGIME", "COMPARE_STOCKS", "NEWS_QUERY", "GENERAL_QUERY",
  ]);
  const needs = (r.needs || []).filter((n) => validNeeds.has(n));
  const intent = validIntents.has(r.intent) ? r.intent : "GENERAL_QUERY";
  return {
    intent,
    tickers: (r.tickers || []).map((t) => String(t).toUpperCase().replace(/\.(NS|BO)$/i, "")).slice(0, 4),
    sectors: (r.sectors || []).slice(0, 3),
    universe: ["SPX", "NDX", "R2K", "ALL"].includes(r.universe) ? r.universe : "ALL",
    count: typeof r.count === "number" ? r.count : 10,
    timeframe: r.timeframe || "unspecified",
    needs: needs.length ? needs : ["fundamental"],
    confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
  };
}

// Rule-based fallback if LLM classification fails
function ruleRoute(message) {
  const m = message.toLowerCase();
  const tickers = Array.from(new Set((message.match(/\b[A-Z]{1,5}\b/g) || []).slice(0, 4)));
  const needs = [];
  if (/\b(rsi|sma|ema|support|resistance|breakout|chart|trend|momentum|moving average)\b/.test(m)) needs.push("technical");
  if (/\b(pe|p\/e|valuation|revenue|earnings|profit|roe|margin|debt|growth|fundamental)\b/.test(m)) needs.push("fundamental");
  if (/\b(news|announce|headline|catalyst|report|result)\b/.test(m)) needs.push("news");
  if (/\b(market|macro|fed|rate|inflation|sentiment|mood|economy)\b/.test(m)) needs.push("macro");

  if (tickers.length && !needs.length) {
    needs.push("technical", "fundamental", "news");
  }

  const intent = tickers.length
    ? (/(overview|about|analy[sz]e|analysis|deep\s*dive|look\s*at)/i.test(message)
      ? "STOCK_DEEP_DIVE"
      : "GENERAL_QUERY")
    : "GENERAL_QUERY";

  return {
    intent,
    tickers,
    sectors: [],
    timeframe: "unspecified",
    needs: needs.length ? needs : ["fundamental", "news"],
    confidence: 0.3,
  };
}

// ── Grounding fetchers (read deployed static assets) ────────────────────────
async function assetGet(env, origin, path) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") return null;
  try {
    let res = await env.ASSETS.fetch(new Request(origin + path));
    let hops = 0;
    while (res && res.status >= 300 && res.status < 400 && hops < 3) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = /^https?:\/\//i.test(loc) ? loc : origin + (loc.startsWith("/") ? loc : "/" + loc);
      res = await env.ASSETS.fetch(new Request(next));
      hops += 1;
    }
    if (!res || !res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

async function fetchStockContext(env, origin, region, ticker) {
  const resolved = await resolveStockPath(env, ticker, region);
  const candidates = [];
  if (resolved) {
    candidates.push({ path: resolved.path, region: resolved.region, ticker: resolved.ticker, name: resolved.name });
  }
  if (region === "india") {
    candidates.push({ path: `/${region}/stocks/${ticker}.NS.html`, region, ticker, name: "" });
    candidates.push({ path: `/${region}/stocks/${ticker}.html`, region, ticker, name: "" });
  } else {
    candidates.push({ path: `/${region}/stocks/${ticker}.html`, region, ticker, name: "" });
  }

  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const res = await assetGet(env, origin, c.path);
    if (!res) continue;
    const html = await res.text();
    const meta = (html.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || "";
    const snap = extractStockContext(html, `https://heraiscreener.com${c.path}`);
    const structuredText = stockContextToText(snap, c.ticker, 4500);
    return {
      ticker: c.ticker,
      name: c.name || ticker,
      url: `https://heraiscreener.com${c.path}`,
      summary: clip(meta, 400),
      text: structuredText || clip(stripHtml(html), 4500),
      rawSnapshot: snap,
      rawHtml: html,
      region: c.region,
    };
  }
  return null;
}

// ── Region-aware ticker routing engine ───────────────────────────────────────
const MANIFEST_KV_KEY = "stock_master_final";

async function loadManifest(env) {
  if (!env.STOCK_MANIFEST) return null;
  try {
    const raw = await env.STOCK_MANIFEST.get(MANIFEST_KV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function resolveStockPath(env, ticker, preferredRegion) {
  const manifest = await loadManifest(env);
  const t = ticker.toUpperCase().replace(/\.(NS|BO)$/i, "");

  if (manifest && manifest.records) {
    const record = manifest.records[t];
    if (record) {
      if (record[preferredRegion]) {
        return {
          path: record[preferredRegion].path,
          region: preferredRegion,
          ticker: t,
          name: record[preferredRegion].name,
        };
      }
      for (const region of ["usa", "india"]) {
        if (record[region]) {
          return {
            path: record[region].path,
            region,
            ticker: t,
            name: record[region].name,
          };
        }
      }
    }
  }

  const candidates = preferredRegion === "india"
    ? [`/${preferredRegion}/stocks/${t}.NS.html`, `/${preferredRegion}/stocks/${t}.html`]
    : [`/${preferredRegion}/stocks/${t}.html`];
  const otherRegion = preferredRegion === "india" ? "usa" : "india";
  const otherCandidates = otherRegion === "india"
    ? [`/${otherRegion}/stocks/${t}.NS.html`, `/${otherRegion}/stocks/${t}.html`]
    : [`/${otherRegion}/stocks/${t}.html`];

  const allCandidates = [
    ...candidates.map((p) => ({ path: p, region: preferredRegion })),
    ...otherCandidates.map((p) => ({ path: p, region: otherRegion })),
  ];

  for (const c of allCandidates) {
    try {
      const req = new Request(`https://heraiscreener.com${c.path}`);
      const res = await env.ASSETS.fetch(req);
      if (res.ok) {
        return { ...c, ticker: t };
      }
    } catch {
      // try next
    }
  }

  return null;
}

// ── Deterministic company-name / fuzzy-ticker resolution ────────────────────
const _NAME_INDEX_CACHE = new Map();
const NAME_INDEX_TTL = 3600 * 1000;

const RESOLVE_STOP = new Set([
  "what", "is", "the", "a", "an", "latest", "about", "news", "on", "for", "of",
  "tell", "me", "any", "today", "recent", "recently", "update", "updates",
  "happening", "with", "give", "show", "whats", "how", "to", "at",
]);
const RESOLVE_GENERIC_SKIP = new Set([
  "stock", "stocks", "share", "shares", "price", "prices", "buy", "sell", "hold",
  "breakout", "breaking", "today", "now", "fundamental", "fundamentals", "technical",
  "which", "what", "best", "top", "good", "right", "fair", "analysis", "analyse",
  "analyze", "list", "ideas", "idea", "screen", "screener", "market", "markets",
  "sector", "sectors", "value", "growth", "dividend", "momentum", "target", "entry",
  "level", "levels", "zone", "should", "give", "show", "tell", "about", "latest",
  "news", "how",
]);

function cleanBase(t) {
  return String(t || "").toUpperCase().replace(/\.(NS|BO)$/i, "");
}

async function loadNameIndex(env, origin, region) {
  const now = Date.now();
  const cached = _NAME_INDEX_CACHE.get(region);
  if (cached && now - cached.ts < NAME_INDEX_TTL) return cached;
  let index = [];
  let alias = {};
  const res = await assetGet(env, origin, `/${region}/heraiai.html`);
  if (res) {
    try {
      const html = await res.text();
      const im = html.match(/const STOCK_INDEX = (\[[\s\S]*?\]);/);
      const am = html.match(/const TICKER_ALIAS = (\{[\s\S]*?\});/);
      if (im) index = JSON.parse(im[1]);
      if (am) alias = JSON.parse(am[1]);
    } catch {
      index = [];
      alias = {};
    }
  }
  const entry = { ts: now, index, alias };
  _NAME_INDEX_CACHE.set(region, entry);
  return entry;
}

async function resolveNameToTicker(env, origin, region, message) {
  const { index, alias } = await loadNameIndex(env, origin, region);
  if (!index.length && !Object.keys(alias).length) return null;
  const t = String(message || "").trim();
  const tl = t.toLowerCase();

  const toks = tl.match(/[a-z0-9&]+/g) || [];
  for (const tok of toks) {
    if (alias[tok]) {
      const tk = cleanBase(alias[tok]);
      const hit = index.find((s) => cleanBase(s.t) === tk);
      return { ticker: tk, name: (hit && hit.n) || tk };
    }
  }

  for (const tok of t.match(/\b[A-Z]{1,5}\b/g) || []) {
    const hit = index.find((s) => cleanBase(s.t) === tok);
    if (hit) return { ticker: tok, name: hit.n || tok };
  }

  const tokens = toks.filter(
    (x) => x.length >= 3 && !RESOLVE_STOP.has(x) && !RESOLVE_GENERIC_SKIP.has(x)
  );
  if (!tokens.length) return null;
  let best = null;
  for (const s of index) {
    const base = cleanBase(s.t);
    if (!base) continue;
    const blow = base.toLowerCase();
    const nameWords = String(s.n || "").toLowerCase().match(/[a-z0-9&]+/g) || [];
    const first = nameWords[0] || "";
    for (const tok of tokens) {
      let score = 0;
      if (tok === blow) score = 100;
      else if (first && tok === first) score = 90;
      else if (tok.length >= 4 && first.startsWith(tok)) score = 70;
      else if (tok.length >= 4 && nameWords.includes(tok)) score = 60;
      else if (
        tok.length >= 4 && blow.length >= 4 &&
        (tok.startsWith(blow) || blow.startsWith(tok)) &&
        Math.abs(tok.length - blow.length) <= 2
      ) score = 50;
      if (score && (!best || score > best[0])) best = [score, base, s.n || base];
    }
  }
  if (best && best[0] >= 50) return { ticker: best[1], name: best[2] };
  return null;
}

async function fetchMacro(env, origin) {
  const res = await assetGet(env, origin, "/_fred_cache.json");
  if (!res) return null;
  try {
    const data = await res.json();
    return { url: "https://heraiscreener.com/_fred_cache.json", text: clip(JSON.stringify(data), 3000) };
  } catch {
    return null;
  }
}

async function fetchNews(env, origin, region) {
  const paths = [`/_news_feeds_${region}.json`, `/${region}/_news_feeds.json`];
  for (const p of paths) {
    const res = await assetGet(env, origin, p);
    if (res) {
      try {
        const data = await res.json();
        return { url: `https://heraiscreener.com${p}`, text: clip(JSON.stringify(data), 3500) };
      } catch { /* try next */ }
    }
  }
  return null;
}

// ── Web fallback (DuckDuckGo, no key) ───────────────────────────────────────
async function webSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&t=herai`;
    const r = await fetch(url, { headers: { "User-Agent": "HeRAI/1.0" } });
    if (!r.ok) return null;
    const d = await r.json();
    const bits = [];
    if (d.AbstractText) bits.push(d.AbstractText);
    for (const t of d.RelatedTopics || []) {
      if (t.Text) bits.push(t.Text);
      if (bits.length >= 6) break;
    }
    const text = bits.join("\n");
    return text ? { url: d.AbstractURL || "https://duckduckgo.com", text: clip(text, 2500) } : null;
  } catch {
    return null;
  }
}

// ── Specialist agents (focused LLM prompts over grounded context) ───────────
const SPECIALIST_SYSTEMS = {
  technical:
    "You are a Senior Technical Analyst (CMT charterholder equivalent) writing an internal research note. " +
    "Using ONLY the provided data, write one short paragraph that states the trend/momentum regime and cites exact readings inline " +
    "(e.g., 'price is 4% above the 50-DMA, RSI(14) reads 62, and the stock sits at 78% of its 52-week range'). " +
    "Use institutional phrasing: momentum regime, support/resistance, moving-average structure, breadth. " +
    "Never invent numbers. Always attribute each data point to its source.",
  fundamental:
    "You are a Senior Fundamental Analyst (CFA charterholder equivalent) writing an internal research note. " +
    "Using ONLY the provided data, write one short paragraph summarizing valuation, capital efficiency, and growth trajectory. " +
    "Cite exact ratios inline (e.g., 'trailing P/E of 14.2x versus sector 22x, ROE of 18%, and revenue growth of 12%'). " +
    "Frame in institutional terminology: capital efficiency, margin structure, earnings trajectory, fair-value context. " +
    "Never invent numbers. Always attribute each data point to its source.",
  news:
    "You are a Senior News Analyst (equity research desk equivalent). " +
    "Using ONLY the provided items, summarize the most relevant recent catalysts and their likely tone. " +
    "Cite dates/sources when present. Distinguish between material news and promotional content. " +
    "3-5 sentences. Always attribute each data point to its source.",
  macro:
    "You are a Senior Macro Strategist. " +
    "Using ONLY the provided macro data, describe the current market backdrop in one short paragraph. " +
    "Frame in terms of regime (risk-on/risk-off, inflation trajectory, rate expectations, sector rotation). " +
    "Cite exact data points inline. Always attribute each data point to its source.",
};

async function runSpecialist(env, kind, question, contextText) {
  if (!contextText) return null;
  const user = `Question: ${question}\n\nData:\n${contextText}`;
  try {
    const { text } = await callLLM(env, SPECIALIST_SYSTEMS[kind], user, { maxTokens: 350 });
    return text;
  } catch {
    return null;
  }
}

// ── Synthesizer ─────────────────────────────────────────────────────────────
const SYNTH_SYSTEM = `You are HerAI, a senior equity research analyst at an institutional desk. You write concise, evidence-based research notes for professional investors.

You are given specialist notes and source snippets. Produce a final answer in short paragraphs with the following labelled sections, but ONLY include sections for which data is actually present:

**Thesis** — one-sentence bottom-line take on the question.
**Technical Read** — trend/momentum regime with exact readings cited inline.
**Fundamental Read** — valuation, capital efficiency, and growth trajectory with exact ratios cited inline.
**News / Catalysts** — only if news data is provided; cite dates/sources.
**Macro / Regime** — only if macro data is provided; cite exact data points.
**Key Risks** — balanced risks visible in the data (e.g., stretched valuation, weakening momentum, leverage).
**Conclusion** — data-driven framing, never a direct buy/sell recommendation.

Rules:
- Use ONLY facts present in the specialist notes / sources. Do not invent numbers, prices, or dates.
- Cite exact figures inline so the reader sees the evidence (e.g., "RSI(14) at 62", "P/E of 14.2x", "52-week range position of 78%").
- Use institutional terminology: momentum regime, capital efficiency, margin structure, earnings trajectory, fair-value context, support/resistance.
- Be balanced; never say "buy" or "sell" as advice. Reframe "should I buy?" into "the data suggests...".
- Keep each section to 1-3 short paragraphs. Do NOT append a disclaimer (the app adds one).`;

// ── Screening / picks synthesizer ───────────────────────────────────────────
const SCREEN_SYNTH_SYSTEM = `You are HerAI, a senior portfolio strategist presenting a ranked shortlist of stock ideas to an investment committee.
You are given a PRE-RANKED, PRE-SCORED candidate pool built from HeRAI's own screeners and price history, plus the prevailing market regime and the weights it implies.

Write a professional shortlist, best-to-good, using ONLY the supplied data. Structure:

Open with one sentence stating the universe, the market regime, and how it shaped your weighting (e.g., "In the current bull regime I have tilted toward technical momentum...").

Then, for EACH stock in the given order, a compact block:
**N. TICKER — Company**
- **Technical:** trend vs 50/200-DMA, RSI, 52-week range position, breakout/support levels — cite the exact computed numbers provided.
- **Fundamental:** valuation (P/E, PEG), returns (ROE/ROCE), growth (revenue/profit CAGR), yield — cite exact figures provided.
- **Sentiment/Momentum:** which momentum/near-high screens and setups it triggered, recent price performance.
- **Why it ranks here:** one line tying the composite score to the regime.

Close with a short "How to read this list" note on the regime tilt and diversification.

Rules:
- Use ONLY facts present in the supplied pool. NEVER invent numbers, prices, targets or dates.
- Preserve the given ranking order.
- Institutional tone; concise. No direct "buy/sell" imperatives — frame as "the data ranks..." / "screens favour...".
- Do NOT append a disclaimer (the app adds one).`;

// ── Price-target / buy-zone synthesizer ─────────────────────────────────────
const PRICE_TARGET_SYNTH_SYSTEM = `You are HerAI, a senior equity analyst answering "what is the right price to buy X" for a professional client.
HeRAI has ALREADY computed a buy zone deterministically from its own data (technical support/moving-averages, valuation vs sector, analyst targets) and weighted it by the market regime. Your job is to present that answer with a transparent, senior-analyst walkthrough.

Structure:
**Bottom line** — state the computed buy zone and the single blended fair-entry figure up front, clearly labelled as data-derived, not personal advice.
**Technical case** — support, swing low, 50/200-DMA, RSI, 52-week range position, breakout trigger — cite the exact numbers supplied.
**Fundamental case** — P/E vs sector median (and forward P/E if given), the implied re-rated fair value — cite exact numbers.
**Analyst context** — mean/high/low targets and consensus IF supplied; otherwise say analyst data was unavailable.
**How the regime tips the scale** — explain that in a bull regime technicals carry more weight, otherwise fundamentals do, and how that shaped the blend.
**Key risks** — 1-2 risks visible in the data (stretched valuation, below-200-DMA, extended RSI, etc.).

Rules:
- Use ONLY the computed numbers supplied. NEVER invent figures. Reproduce the supplied buy zone exactly.
- You MAY state the concrete computed price/zone — it is a data-derived estimate, framed as informational, not a personal recommendation.
- Show the reasoning; be transparent about how each anchor contributed.
- Do NOT append a disclaimer (the app adds one).`;

async function synthesize(env, question, notes, sources) {
  const notesText = notes.map((n) => `[${n.kind}] ${n.text}`).join("\n\n");
  const srcText = sources.map((s, i) => `(${i + 1}) ${s.url}`).join("\n");
  const user = `User question: ${question}\n\nSpecialist notes:\n${notesText || "(none)"}\n\nSources:\n${srcText || "(none)"}`;
  const synthesisModel = synthesisWorkersAiModel(env);
  const { text } = await callLLM(env, SYNTH_SYSTEM, user, { maxTokens: 900, model: synthesisModel });
  return text;
}

// ── Verifier / guardrails (rule-based, cheap; upgradeable to LLM) ────────────
function verify(answer) {
  let out = String(answer || "").trim();
  out = out.split(/\n\nIs that\b/i)[0];
  out = out.split(/\n\nNow, let's\b/i)[0];
  out = out.split(/\n\nWould you like\b/i)[0];
  out = out.replace(/^HerAI:\s*/i, "");
  out = out.replace(/\byou should (buy|sell)\b/gi, "the data suggests you might consider researching");
  return out;
}

// ── Cache helpers (optional KV) ─────────────────────────────────────────────
async function cacheGet(env, key) {
  if (!env.HERAI_KV) return null;
  try {
    const raw = await env.HERAI_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function cachePut(env, key, value) {
  if (!env.HERAI_KV) return;
  try {
    await env.HERAI_KV.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  } catch { /* noop */ }
}
async function cacheKey(region, message) {
  const norm = `${region}::${message.toLowerCase().replace(/\s+/g, " ").trim()}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return "herai:" + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ── Numeric helpers ─────────────────────────────────────────────────────────
function parseNum(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// ── Market-regime detection (breadth-based, grounded in built screeners) ─────
async function detectMarketRegime(env, origin, region) {
  const countRows = async (name) => {
    const res = await assetGet(env, origin, `/${region}/screens/${name}.html`);
    if (!res) return null;
    try { return parseScreenerTable(await res.text(), 500).length; } catch { return null; }
  };
  const [hi, lo, gc, dc] = await Promise.all([
    countRows("near-52w-high"),
    countRows("near-52w-low"),
    countRows("golden-cross"),
    countRows("death-cross"),
  ]);

  const have = [hi, lo, gc, dc].some((x) => x !== null);
  const H = hi || 0, L = lo || 0, G = gc || 0, D = dc || 0;
  let regime = "neutral";
  if (have) {
    const breadthBull = H > L * 1.4 && G >= D;
    const breadthBear = L > H * 1.4 && D >= G;
    if (breadthBull) regime = "bull";
    else if (breadthBear) regime = "bear";
  }

  const weights = {
    bull: { tech: 0.6, fund: 0.3, sent: 0.1 },
    neutral: { tech: 0.4, fund: 0.45, sent: 0.15 },
    bear: { tech: 0.25, fund: 0.6, sent: 0.15 },
  }[regime];

  return {
    regime,
    weights,
    breadth: { near_52w_high: H, near_52w_low: L, golden_cross: G, death_cross: D, measured: have },
    note:
      regime === "bull"
        ? "Broad breadth is expansionary (more 52-week highs than lows) — a technical/momentum tilt is favoured."
        : regime === "bear"
        ? "Breadth is deteriorating (more 52-week lows than highs) — a defensive, fundamentals-first tilt is favoured."
        : "Breadth is mixed — balancing technical and fundamental signals.",
  };
}

// ── Best-effort analyst targets (not in static HTML; via public API) ─────────
async function fetchAnalystTargets(origin, region, ticker) {
  try {
    const url = `${origin}/api/analyst?ticker=${encodeURIComponent(ticker)}&region=${encodeURIComponent(region)}`;
    const r = await fetch(url, { headers: { "User-Agent": "HeRAI/1.0" } });
    if (!r.ok) return null;
    const d = await r.json();
    const t = d && d.targets ? d.targets : d;
    if (!t) return null;
    const out = {
      mean: parseNum(t.target_mean),
      median: parseNum(t.target_median),
      high: parseNum(t.target_high),
      low: parseNum(t.target_low),
      recommendation: t.recommendation || d.recommendation || null,
    };
    return out.mean || out.median ? out : null;
  } catch {
    return null;
  }
}

// ── Build-time precomputed screening pool (scalability) ─────────────────────
async function loadScreenPoolCache(env, origin, region) {
  const res = await assetGet(env, origin, `/${region}/herai_picks.json`);
  if (!res) return null;
  try {
    const data = await res.json();
    const pool = Array.isArray(data) ? data : (data && data.pool) || null;
    return Array.isArray(pool) && pool.length ? pool : null;
  } catch {
    return null;
  }
}

// ── Screening pool: which screens feed technical vs fundamental strength ─────
const TECH_SCREENS = [
  "high-momentum", "momentum-3m", "near-52w-high", "golden-cross",
  "ema-multi-up-5d", "top-ytd", "high-rev-growth",
];
const FUND_SCREENS = [
  "high-roe", "high-fcf", "high-earnings-growth", "high-margin",
  "low-debt", "low-pe", "low-ev-ebitda", "high-dividend", "high-rev-growth",
];
const TECH_SET = new Set(TECH_SCREENS);
const FUND_SET = new Set(FUND_SCREENS);

function scoreCandidate(c, weights) {
  const m = c.metrics || {};
  const inScreens = new Set(c.screens || []);
  const setups = (c.setups || []).join(" ").toLowerCase();

  let tech = 0;
  for (const s of inScreens) if (TECH_SET.has(s)) tech += 1;
  if (/breakout|52w high|52-week high|golden/.test(setups)) tech += 1.5;
  const oneY = parseNum(m["1Y %"] || m["1Y%"] || m["YTD %"]);
  if (oneY !== null) tech += Math.max(-1, Math.min(2, oneY / 50));

  let fund = 0;
  for (const s of inScreens) if (FUND_SET.has(s)) fund += 1;
  const roe = parseNum(m["ROE %"]);
  const roce = parseNum(m["ROCE %"]);
  if (roe !== null && roe >= 15) fund += 1;
  if (roce !== null && roce >= 15) fund += 0.5;
  const revC = parseNum(m["Rev CAGR 5Y %"]);
  const proC = parseNum(m["Profit CAGR 5Y %"]);
  if (revC !== null && revC >= 12) fund += 1;
  if (proC !== null && proC >= 15) fund += 1;
  const peg = parseNum(m["PEG"]);
  if (peg !== null && peg > 0 && peg <= 1.5) fund += 1;

  let sent = 0;
  if (inScreens.has("momentum-3m") || inScreens.has("high-momentum")) sent += 1;
  if (inScreens.has("near-52w-high")) sent += 1;
  if (/breakout/.test(setups)) sent += 0.5;

  const techN = Math.min(1, tech / 5);
  const fundN = Math.min(1, fund / 5);
  const sentN = Math.min(1, sent / 2.5);
  const composite = weights.tech * techN + weights.fund * fundN + weights.sent * sentN;
  return { composite, tech: techN, fund: fundN, sent: sentN, screens: c.screens, setups: c.setups, metrics: m };
}

async function runScreenPick(env, origin, region, route, regime) {
  const wantAll = route.universe === "ALL";
  const screenNames = Array.from(new Set([...TECH_SCREENS, ...FUND_SCREENS]));

  let pool = await loadScreenPoolCache(env, origin, region);
  if (!pool || !pool.length) {
    const fetched = await Promise.all(
      screenNames.map(async (name) => {
        const res = await assetGet(env, origin, `/${region}/screens/${name}.html`);
        if (!res) return null;
        try { return { name, html: await res.text() }; } catch { return null; }
      })
    );
    const screens = fetched.filter(Boolean);
    if (!screens.length) return null;
    pool = buildScreenPool(screens, 80);
  }
  if (!pool.length) return null;

  if (!wantAll) pool = pool.filter((c) => (c.universes || []).includes(route.universe));
  if (!pool.length) return null;

  const scored = pool
    .map((c) => ({ ...c, ...scoreCandidate(c, regime.weights) }))
    .sort((a, b) => b.composite - a.composite);

  const topN = scored.slice(0, route.count);

  const enriched = await Promise.all(
    topN.map(async (c) => {
      const ctx = await fetchStockContext(env, origin, region, c.ticker);
      let technicals = null;
      if (ctx && ctx.rawHtml) technicals = computeTechnicals(extractPriceHistory(ctx.rawHtml));
      return { ...c, name: c.name || (ctx && ctx.name) || c.ticker, technicals, summary: ctx ? ctx.summary : "" };
    })
  );

  const sources = enriched.map((c) => ({
    title: c.ticker,
    url: `https://heraiscreener.com/${region}/stocks/${c.ticker}${region === "india" ? ".NS" : ""}.html`,
  }));

  const evidence = enriched
    .map((c, i) => {
      const m = c.metrics || {};
      const keep = ["Price", "P/E", "PEG", "ROE %", "ROCE %", "Rev CAGR 5Y %", "Profit CAGR 5Y %", "Div %", "1Y %", "Sector"];
      const metricLine = keep
        .filter((k) => m[k])
        .map((k) => `${k} ${m[k]}`)
        .join(", ");
      const techLine = c.technicals
        ? technicalsToText(c.technicals)
        : "";
      return [
        `${i + 1}. ${c.ticker} — ${c.name}`,
        `   universes: ${(c.universes || []).join(", ") || "n/a"}`,
        `   screens hit: ${(c.screens || []).join(", ")}`,
        c.setups && c.setups.length ? `   setups: ${c.setups.join(", ")}` : "",
        metricLine ? `   fundamentals: ${metricLine}` : "",
        techLine ? `   ${techLine}` : "",
        `   scores → technical ${c.tech.toFixed(2)}, fundamental ${c.fund.toFixed(2)}, sentiment ${c.sent.toFixed(2)}, composite ${c.composite.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const user =
    `User question: ${route.rawMessage || "top stock ideas"}\n` +
    `Universe: ${UNIVERSE_LABELS[route.universe]}\n` +
    `Market regime: ${regime.regime.toUpperCase()} — ${regime.note} (weights: technical ${regime.weights.tech}, fundamental ${regime.weights.fund}, sentiment ${regime.weights.sent}).\n\n` +
    `Ranked candidate pool (already scored from HeRAI's own screeners and price history):\n${evidence}`;

  const synthesisModel = synthesisWorkersAiModel(env);
  const { text } = await callLLM(env, SCREEN_SYNTH_SYSTEM, user, { maxTokens: 1400, model: synthesisModel });
  return { answer: text, sources, picks: enriched, regime };
}

// ── Breakout composer: conviction-filtered, pattern-grouped ─────────────────
const BREAKOUT_PATTERNS = [
  ["new_high", "near-52w-high", "New 52-week-high breakout",
    "price breaking to fresh 52-week highs — the most literal, 'absolute' breakout"],
  ["golden", "golden-cross", "Golden-cross breakout",
    "50-DMA crossing above the 200-DMA — a fresh long-term trend breakout"],
  ["multi_ema", "ema-multi-up-5d", "Multi-EMA stacked breakout",
    "short-, medium- and long-term EMAs newly stacked bullishly"],
];
const MIN_CONVICTION = 2;

function rowMetric(row, ...names) {
  const d = {};
  for (const [h, v] of row.metrics || []) d[String(h).toLowerCase()] = v;
  for (const n of names) {
    const v = d[n.toLowerCase()];
    if (v !== undefined) return v;
  }
  return null;
}

function breakoutConviction(row) {
  let score = 0;
  const tags = [];
  const oneY = parseNum(rowMetric(row, "1Y %"));
  if (oneY !== null) {
    if (oneY >= 30) { score += 2; tags.push(`1Y +${Math.round(oneY)}%`); }
    else if (oneY >= 10) { score += 1; tags.push(`1Y +${Math.round(oneY)}%`); }
    else if (oneY < 0) score -= 1;
  }
  const pc = parseNum(rowMetric(row, "Profit CAGR 5Y %"));
  if (pc !== null) {
    if (pc >= 10) { score += 1; tags.push("earnings growing"); }
    else if (pc < 0) { score -= 1; tags.push("earnings shrinking"); }
  }
  const roce = parseNum(rowMetric(row, "ROCE %"));
  if (roce !== null) {
    if (roce >= 15) { score += 1; tags.push(`ROCE ${Math.round(roce)}%`); }
    else if (roce < 8) score -= 1;
  }
  const pe = parseNum(rowMetric(row, "P/E"));
  if (pe !== null && (pe < 0 || pe > 150)) { score -= 2; tags.push("valuation/earnings stretched"); }
  return { score, tags };
}

async function breakoutIdeas(env, origin, region, limit = 6) {
  const sections = [];
  const citations = {};
  let anyHits = false;

  for (const [key, name, title, blurb] of BREAKOUT_PATTERNS) {
    const res = await assetGet(env, origin, `/${region}/screens/${name}.html`);
    if (!res) continue;
    let rows;
    try { rows = parseScreenerTable(await res.text(), 400); } catch { continue; }
    if (!rows || !rows.length) continue;

    if (key === "golden") {
      const dates = rows.map((r) => rowMetric(r, "Signal Date")).filter(Boolean);
      if (dates.length) {
        const latest = dates.slice().sort().slice(-1)[0];
        rows = rows.filter((r) => rowMetric(r, "Signal Date") === latest);
      }
    }

    const scored = [];
    for (const r of rows) {
      const { score, tags } = breakoutConviction(r);
      if (score >= MIN_CONVICTION) scored.push({ score, oneY: parseNum(rowMetric(r, "1Y %")) || 0, row: r, tags });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.oneY - a.oneY));
    const top = scored.slice(0, limit);
    if (!top.length) continue;

    anyHits = true;
    citations[title] = `https://heraiscreener.com/${region}/screens/${name}.html`;
    const block = [`**${title}** — ${blurb}:`];
    for (const { score, row, tags } of top) {
      const conv = score >= 4 ? "High conviction" : "Medium conviction";
      const price = rowMetric(row, "Price") || "";
      const nm = row.name || "";
      const head = `- **${row.ticker}**${nm ? ` — ${nm}` : ""}`;
      const extra = [];
      if (price) extra.push(region === "india" ? `₹${price}` : `$${price}`);
      extra.push(conv);
      if (tags.length) extra.push(tags.join(", "));
      block.push(`${head}  \n  ${extra.join(" · ")}`);
    }
    sections.push(block.join("\n"));
  }

  if (!anyHits) return null;
  const intro =
    "Here are today's genuine breakouts from HeRAI's screeners, grouped by pattern " +
    "and filtered to only medium/high-conviction names (strong momentum, growing " +
    "earnings, sane valuation — weak or loss-making breakouts are dropped):";
  const note =
    "\n\n'Absolute' breakouts (new 52-week highs) are listed first. This is a research " +
    "shortlist, not a buy/sell call — confirm volume and your own risk levels on the chart before acting.";
  const answer = intro + "\n\n" + sections.join("\n\n") + note;
  const cites = Object.entries(citations).map(([title, url]) => ({ title, url }));
  return { answer, citations: cites };
}

// ── Price-target / buy-zone computation (deterministic, then narrated) ───────
function computeBuyZone({ price, tech, pe, sectorPe, fwdPe, analyst, regime }) {
  const anchors = [];
  const rationale = [];
  const w = regime.weights;

  let techEntry = null;
  if (tech && price) {
    if (tech.above_sma50) {
      const pullbackFloor = Math.max(
        tech.nearest_support || 0,
        tech.sma50 || 0
      ) || tech.sma50 || tech.nearest_support;
      if (pullbackFloor) {
        techEntry = (pullbackFloor + price * 0.98) / 2;
        rationale.push(
          `Uptrend (price ${price} above SMA50 ${tech.sma50}); a healthy pullback toward support/50-DMA near ${tech.nearest_support ?? tech.sma50} offers a lower-risk entry.`
        );
      }
    } else if (tech.nearest_support) {
      techEntry = tech.nearest_support;
      rationale.push(
        `Price ${price} is below SMA50 ${tech.sma50 ?? "n/a"} — waiting for a reclaim/hold of nearest support ${tech.nearest_support} (20-bar swing low ${tech.swing_low}) is prudent.`
      );
    }
    if (tech.breakout_20d) {
      rationale.push(`Momentum breakout trigger sits above ${tech.breakout_20d} (prior 20-day high).`);
    }
  }
  if (techEntry) anchors.push({ kind: "technical", value: techEntry, weight: w.tech });

  let fundEntry = null;
  if (price && pe && sectorPe && pe > 0 && pe <= 150 && sectorPe > 0 && sectorPe <= 150) {
    let fairPe = price * (sectorPe / pe);
    fairPe = Math.max(fairPe, price * 0.65);
    fundEntry = Math.min(fairPe, price);
    rationale.push(
      `On valuation, P/E ${pe} vs sector median ${sectorPe} implies a re-rated fair value near ${_r(fairPe)}${
        fairPe < price ? " (currently above fair value)" : " (currently at/below fair value)"
      }.`
    );
  }
  if (fundEntry) anchors.push({ kind: "fundamental", value: fundEntry, weight: w.fund });

  let analystEntry = null;
  if (analyst && (analyst.mean || analyst.median) && price) {
    const target = analyst.mean || analyst.median;
    const mos = regime.regime === "bear" ? 0.1 : regime.regime === "bull" ? 0.05 : 0.08;
    analystEntry = target * (1 - mos);
    const upside = ((target / price - 1) * 100).toFixed(1);
    rationale.push(
      `Analyst mean target ${_r(target)} (≈ ${upside}% vs spot ${price}); applying a ${(mos * 100).toFixed(0)}% margin of safety gives ${_r(analystEntry)}.`
    );
  }
  if (analystEntry) anchors.push({ kind: "analyst", value: analystEntry, weight: w.sent + 0.05 });

  if (!anchors.length) return null;

  const totW = anchors.reduce((s, a) => s + a.weight, 0) || 1;
  const buy = anchors.reduce((s, a) => s + a.value * a.weight, 0) / totW;
  const zoneLow = _r(buy * 0.985);
  const zoneHigh = _r(buy * 1.01);

  return {
    buy: _r(buy),
    zone: [zoneLow, zoneHigh],
    anchors: anchors.map((a) => ({ kind: a.kind, value: _r(a.value), weight: _r(a.weight) })),
    rationale,
    price,
    fwdPe: fwdPe || null,
  };
}
function _r(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

async function runPriceTarget(env, origin, region, ticker, route, regime) {
  const ctx = await fetchStockContext(env, origin, region, ticker);
  if (!ctx || !ctx.rawHtml) return null;

  const snap = ctx.rawSnapshot || {};
  const tech = computeTechnicals(extractPriceHistory(ctx.rawHtml));

  const price =
    parseNum((snap.header && (snap.header.Price || snap.header.price)) || "") ||
    (tech ? tech.last : null);

  const ratios = snap.ratios || {};
  const valTile = ratios["Valuation"] || {};
  const pe = parseNum(valTile["Stock P/E"] || valTile["P/E"] || valTile["PE"] || valTile["P/E (TTM)"]);
  const fwdPe = parseNum(valTile["Forward P/E"] || valTile["Fwd P/E"] || valTile["Forward PE"]);
  let sectorPe = parseNum(valTile["Industry PE"] || valTile["Industry P/E"] || valTile["Sector P/E"] || valTile["Sector median P/E"]);
  const valVsSector = (snap.technical_snapshot && snap.technical_snapshot.valuation_vs_sector) || "";
  if (sectorPe === null) {
    const smv = String(valVsSector).match(/sector median of\s*([\d.]+)/i);
    if (smv) sectorPe = parseNum(smv[1]);
  }
  const pemv = String(valVsSector).match(/P\/E of\s*([\d.]+)/i);
  const peFromSnap = pemv ? parseNum(pemv[1]) : null;

  const analyst = await fetchAnalystTargets(origin, region, ticker);

  const zone = computeBuyZone({
    price,
    tech,
    pe: pe || peFromSnap,
    sectorPe,
    fwdPe,
    analyst,
    regime,
  });
  if (!zone) return null;

  const peShow = pe || peFromSnap;
  const peSane = peShow && peShow > 0 && peShow <= 150;
  let valLine = "";
  if (peSane) {
    valLine = `Valuation: P/E ${peShow}${sectorPe ? `, sector median P/E ${sectorPe}` : ""}${fwdPe ? `, forward P/E ${fwdPe}` : ""}.`;
  } else if (fwdPe) {
    valLine = `Valuation: forward P/E ${fwdPe}${sectorPe ? ` vs sector median P/E ${sectorPe}` : ""} (trailing P/E distorted by one-off earnings — using forward P/E).`;
  }

  const factLines = [
    `Ticker: ${ticker}${ctx.name ? " (" + ctx.name + ")" : ""}`,
    `Spot price: ${zone.price}`,
    tech ? technicalsToText(tech) : "",
    valLine,
    analyst ? `Analyst targets: ${analyst.mean ? "mean " + _r(analyst.mean) : ""}${analyst.high ? ", high " + _r(analyst.high) : ""}${analyst.low ? ", low " + _r(analyst.low) : ""}${analyst.recommendation ? ", consensus " + analyst.recommendation : ""}.` : "Analyst targets: not available in dataset.",
    "",
    `Computed buy zone: ${zone.zone[0]}–${zone.zone[1]} (blended fair entry ≈ ${zone.buy}).`,
    `Anchors used (regime-weighted, ${regime.regime}): ${zone.anchors.map((a) => `${a.kind} ${a.value}`).join(", ")}.`,
    "Reasoning points:",
    ...zone.rationale.map((r) => `- ${r}`),
  ].filter(Boolean).join("\n");

  const user =
    `User question: ${route.rawMessage || `right price to buy ${ticker}`}\n` +
    `Market regime: ${regime.regime.toUpperCase()} — ${regime.note}\n\n` +
    `HeRAI computed the following from its own data:\n${factLines}`;

  const sources = [{ title: ticker, url: ctx.url }];
  const synthesisModel = synthesisWorkersAiModel(env);
  const { text } = await callLLM(env, PRICE_TARGET_SYNTH_SYSTEM, user, { maxTokens: 1000, model: synthesisModel });
  return { answer: text, sources, zone, regime, ticker };
}

// ── Main orchestration ──────────────────────────────────────────────────────
async function orchestrate(env, origin, message, region, history, mode = "analysis") {
  if (mode !== "news" && RE_BREAKOUT.test(message) && !RE_SCREEN_PICK.test(message)) {
    try {
      const bo = await breakoutIdeas(env, origin, region);
      if (bo && bo.answer) {
        return {
          answer: verify(bo.answer),
          disclaimer: DISCLAIMER,
          intent: "SCREEN_QUERY",
          agents: ["technical", "screener"],
          tickers: [],
          citations: bo.citations || [],
          usedWeb: false,
        };
      }
    } catch (e) {
      // fall through to the LLM-routed pipeline
    }
  }

  const route = await routeQuery(env, message, history, region);
  route.rawMessage = message;

  if (mode === "news") {
    route.needs = ["news"];
  }

  if (mode !== "news") {
    const isPrice = RE_PRICE_TARGET.test(message) && !RE_SCREEN_PICK.test(message);
    if (isPrice) {
      if (!route.tickers || !route.tickers.length) {
        const nm = await resolveNameToTicker(env, origin, region, message);
        if (nm) route.tickers = [nm.ticker];
      }
      if (route.tickers && route.tickers.length) {
        route.intent = "PRICE_TARGET";
        route.needs = ["technical", "fundamental", "news"];
      } else {
        const label = region === "india" ? "India" : "USA";
        return {
          answer:
            `I couldn't tell which stock you're asking about. Which ${label} stock would you like a ` +
            `fair-entry / buy-zone read on? Type the company name or its ticker ` +
            `(for example \u201cRELIANCE\u201d or \u201cInfosys\u201d).`,
          disclaimer: DISCLAIMER,
          intent: "CLARIFY",
          agents: [],
          tickers: [],
          citations: [],
          usedWeb: false,
        };
      }
    } else if (
      route.intent !== "SCREEN_PICK" &&
      isStockSpecific(message) &&
      (!route.tickers || !route.tickers.length)
    ) {
      const nm = await resolveNameToTicker(env, origin, region, message);
      if (nm) {
        route.tickers = [nm.ticker];
        route.intent = "STOCK_DEEP_DIVE";
        route.needs = ["technical", "fundamental", "news"];
      }
    }
  }

  if (mode !== "news" && (route.intent === "SCREEN_PICK" || route.intent === "PRICE_TARGET")) {
    try {
      const regime = await detectMarketRegime(env, origin, region);

      if (route.intent === "SCREEN_PICK") {
        const res = await runScreenPick(env, origin, region, route, regime);
        if (res && res.answer) {
          return {
            answer: verify(res.answer),
            disclaimer: DISCLAIMER,
            intent: route.intent,
            agents: ["screener", "technical", "fundamental"],
            tickers: (res.picks || []).map((p) => p.ticker),
            universe: route.universe,
            regime: regime.regime,
            citations: res.sources || [],
            usedWeb: false,
          };
        }
      }

      if (route.intent === "PRICE_TARGET" && route.tickers.length) {
        const res = await runPriceTarget(env, origin, region, route.tickers[0], route, regime);
        if (res && res.answer) {
          return {
            answer: verify(res.answer),
            disclaimer: DISCLAIMER,
            intent: route.intent,
            agents: ["technical", "fundamental", "valuation"],
            tickers: [res.ticker],
            regime: regime.regime,
            buyZone: res.zone ? { buy: res.zone.buy, zone: res.zone.zone } : null,
            citations: res.sources || [],
            usedWeb: false,
          };
        }
      }
    } catch (e) {
      // Fall through to the generic grounded pipeline on any failure.
    }
  }

  // 2) Gather grounding in parallel
  const groundingTasks = [];
  const sources = [];
  const contextByKind = {};

  const wantTech = route.needs.includes("technical");
  const wantFund = route.needs.includes("fundamental");
  const wantNews = route.needs.includes("news");
  const wantMacro = route.needs.includes("macro");

  let stockContexts = [];
  if ((wantTech || wantFund) && route.tickers.length) {
    groundingTasks.push(
      Promise.all(route.tickers.map((t) => fetchStockContext(env, origin, region, t))).then((arr) => {
        stockContexts = arr.filter(Boolean);
      })
    );
  }
  let macroCtx = null;
  if (wantMacro) groundingTasks.push(fetchMacro(env, origin).then((m) => { macroCtx = m; }));
  let newsCtx = null;
  if (wantNews) groundingTasks.push(fetchNews(env, origin, region).then((n) => { newsCtx = n; }));

  await Promise.all(groundingTasks);

  if (stockContexts.length) {
    const joined = stockContexts.map((s) => `${s.ticker}: ${s.summary}\n${s.text}`).join("\n\n---\n\n");
    contextByKind.technical = joined;
    contextByKind.fundamental = joined;
    stockContexts.forEach((s) => sources.push({ title: s.ticker, url: s.url }));
  }
  if (macroCtx) { contextByKind.macro = macroCtx.text; sources.push({ title: "Macro (FRED)", url: macroCtx.url }); }
  if (newsCtx) { contextByKind.news = newsCtx.text; sources.push({ title: "Market news", url: newsCtx.url }); }

  let usedWeb = false;
  const internalThin =
    (wantTech || wantFund) && !stockContexts.length &&
    !contextByKind.news && !contextByKind.macro;
  if (internalThin) {
    const web = await webSearch(`${message} stock`);
    if (web) {
      usedWeb = true;
      contextByKind.web = web.text;
      sources.push({ title: "Web (DuckDuckGo)", url: web.url });
    }
  }

  const specialistJobs = [];
  if (wantTech && contextByKind.technical) specialistJobs.push(runSpecialist(env, "technical", message, contextByKind.technical).then((t) => ({ kind: "technical", text: t })));
  if (wantFund && contextByKind.fundamental) specialistJobs.push(runSpecialist(env, "fundamental", message, contextByKind.fundamental).then((t) => ({ kind: "fundamental", text: t })));
  if (wantNews && contextByKind.news) specialistJobs.push(runSpecialist(env, "news", message, contextByKind.news).then((t) => ({ kind: "news", text: t })));
  if (wantMacro && contextByKind.macro) specialistJobs.push(runSpecialist(env, "macro", message, contextByKind.macro).then((t) => ({ kind: "macro", text: t })));

  let notes = (await Promise.all(specialistJobs)).filter((n) => n && n.text);

  if (!notes.length && contextByKind.web) {
    notes = [{ kind: "web", text: contextByKind.web }];
  }

  let answer;
  if (notes.length) {
    answer = await synthesize(env, message, notes, sources);
  } else {
    const needsSpecificData =
      route.tickers.length ||
      ["STOCK_DEEP_DIVE", "PRICE_TARGET", "SCREEN_PICK", "COMPARE_STOCKS", "SECTOR_ANALYSIS"].includes(route.intent);
    if (needsSpecificData) {
      const askedFor = route.tickers.length ? route.tickers.join(", ") : "that";
      answer =
        `I ground every answer in HeRAI's own built data (per-stock pages, screeners, macro), and I could not locate the specific data needed for ${askedFor} in the ${region.toUpperCase()} dataset right now. ` +
        `Please give me an exact ticker we cover (e.g., AAPL, RELIANCE), ask for a screen-based shortlist (e.g., "10 S&P 500 stocks to consider"), or ask for a buy zone on a named stock, and I'll analyse it from the data.`;
    } else {
      const synthesisModel = synthesisWorkersAiModel(env);
      const { text } = await callLLM(
        env,
        "You are HerAI, a senior stock-market analyst acting as an educator. Explain the CONCEPT the user asked about (e.g., what RSI/P-E/support means) in 1-3 short paragraphs, using institutional terminology. " +
          "Do NOT invent specific prices, tickers, targets, or figures. Do NOT give buy/sell advice. Do not role-play a dialogue or ask follow-up questions. " +
          "If the question actually requires specific stock data, say it should be asked about a named ticker or via a screen.",
        message,
        { maxTokens: 600, model: synthesisModel }
      );
      answer = text;
    }
  }

  answer = verify(answer);

  return {
    answer,
    disclaimer: DISCLAIMER,
    intent: route.intent,
    agents: notes.map((n) => n.kind),
    tickers: route.tickers,
    citations: sources,
    usedWeb,
  };
}

// ── Question bank (analytics) — capture every customer question ─────────────
const QLOG_PREFIX = "q:";
const QLOG_MAX_READ = 5000;

function isFallbackAnswer(result) {
  if (!result) return true;
  if (result.error) return true;
  if (result.intent === "CLARIFY") return true;
  const a = String(result.answer || "");
  if (!a.trim()) return true;
  return /could not locate the specific data|not configured yet|hit an error|AI narrative unavailable|couldn't tell which stock|no recent headlines/i.test(a);
}

function logQuestion(env, ctx, meta, result) {
  try {
    const kv = env && env.HERAI_KV;
    if (!kv) return;
    const entry = {
      ts: new Date().toISOString(),
      region: meta.region,
      mode: meta.mode,
      q: String(meta.message || "").slice(0, 500),
      intent: result ? (result.intent || null) : null,
      fellBack: isFallbackAnswer(result),
      cached: !!(result && result.cached),
      usedWeb: !!(result && result.usedWeb),
      agents: (result && result.agents) || [],
      sourceKeys: (result && result.sourceKeys) || [],
      tickers: (result && result.tickers) || [],
      sources: ((result && result.citations) || []).map((c) => ({ t: c.title, u: c.url })),
      answerPreview: String((result && result.answer) || (result && result.error) || "").slice(0, 400),
    };
    const key = QLOG_PREFIX + Date.now() + ":" + Math.random().toString(36).slice(2, 8);
    const p = kv.put(key, JSON.stringify(entry));
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
  } catch {
    /* logging must never break the chat */
  }
}

function csvCell(v) {
  let s;
  if (Array.isArray(v)) {
    s = v.map((x) => (x && typeof x === "object" ? `${x.t || ""} (${x.u || ""})` : String(x))).join(" | ");
  } else if (v === null || v === undefined) {
    s = "";
  } else {
    s = String(v);
  }
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function handleQuestionsAdmin(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-admin-key") || "";
  const adminKey = env && env.HERAI_ADMIN_KEY;
  const hasConfiguredKey = Boolean(adminKey);
  if (hasConfiguredKey && key && key !== adminKey) {
    return json({ error: "unauthorized" }, 401);
  }
  const kv = env && env.HERAI_KV;
  if (!kv) return json({ error: "HERAI_KV not bound — question logging is disabled.", entries: [] }, 200);

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "2000", 10) || 2000, QLOG_MAX_READ);
  const entries = [];
  let cursor;
  while (entries.length < QLOG_MAX_READ) {
    const res = await kv.list({ prefix: QLOG_PREFIX, cursor, limit: 1000 });
    const gets = await Promise.all(res.keys.map((k) => kv.get(k.name)));
    for (const g of gets) { if (g) { try { entries.push(JSON.parse(g)); } catch { /* skip */ } } }
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const trimmed = entries.slice(0, limit);

  if (url.searchParams.get("format") === "csv") {
    const cols = ["ts", "region", "mode", "q", "intent", "fellBack", "cached", "usedWeb", "agents", "sourceKeys", "tickers", "sources", "answerPreview"];
    const rows = [cols.join(",")];
    for (const e of trimmed) rows.push(cols.map((c) => csvCell(e[c])).join(","));
    return new Response(rows.join("\n"), {
      status: 200,
      headers: { ...cors(), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="herai_questions.csv"' },
    });
  }

  const byIntent = {}; const byRegion = {}; const byQuestion = {}; let fallbacks = 0;
  for (const e of trimmed) {
    byIntent[e.intent || "?"] = (byIntent[e.intent || "?"] || 0) + 1;
    byRegion[e.region || "?"] = (byRegion[e.region || "?"] || 0) + 1;
    if (e.fellBack) fallbacks++;
    const qn = String(e.q || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 140);
    if (!byQuestion[qn]) byQuestion[qn] = { q: e.q, count: 0, fell: 0 };
    byQuestion[qn].count++; if (e.fellBack) byQuestion[qn].fell++;
  }
  const top = Object.values(byQuestion).sort((a, b) => b.count - a.count).slice(0, 100);
  return json({ total: trimmed.length, fallbacks, byIntent, byRegion, top, entries: trimmed });
}

// ── HTTP entry ──────────────────────────────────────────────────────────────
export async function handleHeraiRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (url.pathname === "/api/herai/health" && request.method === "GET") {
    const providers = [];
    if (hasWorkersAI(env)) providers.push("workers-ai");
    providers.push(...availableProviders(env).map((p) => p.id));
    return json({
      ok: true,
      providers,
      model: hasWorkersAI(env) ? workersAiModel(env) : null,
      modelCandidates: hasWorkersAI(env) ? workersAiModelCandidates(env) : [],
      synthesisModel: hasWorkersAI(env) ? synthesisWorkersAiModel(env) : null,
    });
  }

  if (url.pathname === "/api/herai/questions" && request.method === "GET") {
    return handleQuestionsAdmin(request, env);
  }

  if (url.pathname === "/api/herai/chat" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* empty */ }

    const message = clip(body.message, MAX_MESSAGE).trim();
    const region = ALLOWED_REGIONS.has(body.region) ? body.region : "usa";
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
    const mode = body.mode === "news" ? "news" : "analysis";

    if (!message) return json({ error: "Please enter a question." }, 400);
    if (!hasWorkersAI(env) && !availableProviders(env).length) {
      return json({ error: "HerAI is not configured yet (no Workers AI binding or provider key set)." }, 503);
    }

    const key = await cacheKey(region, `${mode}::${message}`);
    const cached = history.length ? null : await cacheGet(env, key);
    if (cached) {
      logQuestion(env, ctx, { message, region, mode }, cached);
      return json({ ...cached, cached: true });
    }

    try {
      const result = await orchestrate(env, url.origin, message, region, history, mode);
      logQuestion(env, ctx, { message, region, mode }, result);
      if (!history.length) ctx.waitUntil(cachePut(env, key, result));
      return json(result);
    } catch (e) {
      const msg = String(e && e.message);
      logQuestion(env, ctx, { message, region, mode }, { error: msg, intent: "ERROR" });
      if (msg.includes("NO_LLM_KEYS")) {
        return json({ error: "HerAI is not configured yet (no Workers AI binding or provider key set)." }, 503);
      }
      if (msg.includes("WORKERS_AI_FAILED")) {
        return json({ error: "Workers AI inference failed", detail: msg.slice(0, 500) }, 502);
      }
      return json({ error: "HerAI hit an error. Please try again." }, 500);
    }
  }

  return json({ error: "unknown herai route" }, 404);
}