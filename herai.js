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

const USER_PROVIDER_DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  claude: "claude-3-5-sonnet-latest",
  openai: "gpt-4o-mini",
  ollama: "llama3.1:8b",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  groq: "llama-3.3-70b-versatile",
  cerebras: "llama3.1-70b",
};
const USER_PROVIDER_IDS = new Set(Object.keys(USER_PROVIDER_DEFAULT_MODELS));

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

function normalizeUserProviders(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim().toLowerCase();
    if (!USER_PROVIDER_IDS.has(id)) continue;
    const key = String(item.key || "").trim();
    if (!key) continue;
    const model = String(item.model || USER_PROVIDER_DEFAULT_MODELS[id] || "").trim();
    const endpoint = String(item.endpoint || "").trim();
    out.push({ id, key, model, endpoint });
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeModes(rawModes) {
  const allowed = new Set(["technical", "fundamental", "internet"]);
  const picked = new Set();
  if (Array.isArray(rawModes)) {
    for (const m of rawModes) {
      const v = String(m || "").trim().toLowerCase();
      if (allowed.has(v)) picked.add(v);
    }
  }
  if (!picked.size) {
    picked.add("technical");
    picked.add("fundamental");
  }
  return {
    technical: picked.has("technical"),
    fundamental: picked.has("fundamental"),
    internet: picked.has("internet"),
    list: Array.from(picked),
    cacheKey: Array.from(picked).sort().join("+"),
  };
}

function isInternetOnlyMode(mode) {
  return !!(mode && mode.internet && !mode.technical && !mode.fundamental);
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

const TRUSTED_COMMON_DOMAINS = [
  "finance.yahoo.com",
  "google.com",
  "tradingview.com",
  "sec.gov",
  "marketwatch.com",
  "investing.com",
  "morningstar.com",
  "nasdaq.com",
  "reuters.com",
  "bloomberg.com",
  "wsj.com",
];
const TRUSTED_INDIA_DOMAINS = [
  "moneycontrol.com",
  "nseindia.com",
  "bseindia.com",
  "economictimes.indiatimes.com",
  "livemint.com",
  "business-standard.com",
];
const TRUSTED_USA_DOMAINS = [
  "sec.gov",
  "nasdaq.com",
  "marketwatch.com",
  "fred.stlouisfed.org",
  "federalreserve.gov",
];

function safeHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostScore(host, region) {
  if (!host) return 0;
  if (host.includes("heraiscreener.com")) return 100;
  const regional = region === "india" ? TRUSTED_INDIA_DOMAINS : TRUSTED_USA_DOMAINS;
  if (regional.some((d) => host === d || host.endsWith(`.${d}`))) return 85;
  if (TRUSTED_COMMON_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 70;
  if (host.includes("duckduckgo.com")) return 20;
  return 35;
}

function rankAndFilterSources(region, sources, max = 10) {
  const seen = new Set();
  const rows = [];
  for (const s of sources || []) {
    const url = String((s && s.url) || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const host = safeHost(url);
    rows.push({
      title: String((s && s.title) || url),
      url,
      host,
      score: hostScore(host, region),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, max).map((r) => ({ title: r.title, url: r.url }));
}

function rankAndFilterSourcesForMode(region, sources, mode, max = 10) {
  const ranked = rankAndFilterSources(region, sources, max);
  if (!isInternetOnlyMode(mode)) return ranked;
  return ranked.filter((s) => !safeHost(s.url).includes("heraiscreener.com"));
}

function shouldAskClarifying(route, message, allowStructured) {
  if (!allowStructured) return false;
  const m = String(message || "");
  const asksScreenList = RE_SCREEN_PICK.test(m) || /\bwhich\s+stocks?\b/i.test(m);
  if (asksScreenList) return false;
  const asksStockSpecific =
    /\b(stock|ticker|share|company|buy\s+price|entry|support|target|should\s+i\s+buy|analyse|analyze)\b/i.test(m);
  if (!asksStockSpecific) return false;
  const hasTicker = Array.isArray(route.tickers) && route.tickers.length > 0;
  if (hasTicker) return false;
  const conf = Number(route.confidence || 0);
  return conf < 0.55;
}

function buildEvidencePack(route, region, contexts, contextByKind, regime, mode, sources) {
  return {
    region,
    mode: mode && mode.list ? mode.list : [],
    intent: route.intent,
    tickers: route.tickers || [],
    confidence: Number(route.confidence || 0),
    regime: regime ? { regime: regime.regime, note: regime.note, breadth: regime.breadth } : null,
    technical: contextByKind.technical ? clip(contextByKind.technical, 2200) : null,
    fundamental: contextByKind.fundamental ? clip(contextByKind.fundamental, 2200) : null,
    news: contextByKind.news ? clip(contextByKind.news, 1800) : null,
    macro: contextByKind.macro ? clip(contextByKind.macro, 1800) : null,
    stockSummaries: (contexts || []).map((s) => ({ ticker: s.ticker, summary: clip(s.summary, 260), url: s.url })),
    sources: sources || [],
  };
}

const VERIFY_SYSTEM = `You are an answer verifier for an equity research assistant.
You receive a drafted answer and an evidence JSON.
Task: correct any statement in the answer that is unsupported by the evidence.
Rules:
- Keep original structure and tone as much as possible.
- Remove or soften unsupported exact numbers/tickers/claims.
- Do not invent new facts.
- Return ONLY the corrected final answer text.`;

async function verifyAgainstEvidence(env, draft, evidence, userProviders = []) {
  if (!draft || !evidence) return draft;
  const evidenceText = clip(JSON.stringify(evidence), 5000);
  const prompt = `Draft answer:\n${clip(draft, 5000)}\n\nEvidence JSON:\n${evidenceText}`;
  try {
    const synthesisModel = synthesisWorkersAiModel(env);
    const { text } = await callLLM(env, VERIFY_SYSTEM, prompt, {
      maxTokens: 900,
      model: synthesisModel,
      userProviders,
    });
    return String(text || draft).trim() || draft;
  } catch {
    return draft;
  }
}

// ── Unified LLM call across the free chain ──────────────────────────────────
async function callLLM(env, system, user, { wantJson = false, maxTokens = 900, model, userProviders = [] } = {}) {
  const providers = availableProviders(env);
  const runtimeProviders = normalizeUserProviders(userProviders);
  let workersAiErr = null;
  let runtimeErr = null;

  for (const p of runtimeProviders) {
    try {
      const text = await callUserProvider(p, system, user, wantJson, maxTokens);
      if (text && text.trim()) return { text: text.trim(), provider: `${p.id} (user key)` };
    } catch (e) {
      runtimeErr = e;
    }
  }

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
    if (runtimeErr) throw new Error(`USER_PROVIDER_FAILED: ${runtimeErr.message || runtimeErr}`);
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

async function callOpenAICompatible(baseUrl, key, model, system, user, wantJson, maxTokens, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    ...extraHeaders,
  };
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
    ...(wantJson ? { response_format: { type: "json_object" } } : {}),
  };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`provider ${r.status}`);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callUserProvider(p, system, user, wantJson, maxTokens) {
  if (p.id === "gemini") {
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.gemini;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(p.key)}`;
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

  if (p.id === "claude") {
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.claude;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": p.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.3,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) throw new Error(`claude ${r.status}`);
    const data = await r.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.map((b) => (b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  }

  if (p.id === "ollama") {
    const endpoint = (p.endpoint || "").replace(/\/+$/, "");
    if (!endpoint) throw new Error("ollama endpoint missing");
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.ollama;
    const r = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
      }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const data = await r.json();
    return data?.message?.content || data?.response || "";
  }

  if (p.id === "openai") {
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.openai;
    return callOpenAICompatible("https://api.openai.com/v1", p.key, model, system, user, wantJson, maxTokens);
  }
  if (p.id === "openrouter") {
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.openrouter;
    return callOpenAICompatible(
      "https://openrouter.ai/api/v1",
      p.key,
      model,
      system,
      user,
      wantJson,
      maxTokens,
      { "HTTP-Referer": "https://heraiscreener.com", "X-Title": "HeRAI Screener" }
    );
  }
  if (p.id === "groq") {
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.groq;
    return callOpenAICompatible("https://api.groq.com/openai/v1", p.key, model, system, user, wantJson, maxTokens);
  }
  if (p.id === "cerebras") {
    const model = p.model || USER_PROVIDER_DEFAULT_MODELS.cerebras;
    return callOpenAICompatible("https://api.cerebras.ai/v1", p.key, model, system, user, wantJson, maxTokens);
  }
  throw new Error(`unsupported provider: ${p.id}`);
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
const ROUTER_SYSTEM = `You are a Senior Stock Market Analyst acting as the routing brain of this assistant.
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

async function routeQuery(env, message, history, region, userProviders = []) {
  const historyText = (history || [])
    .slice(-MAX_HISTORY)
    .map((h) => `${h.role === "user" ? "User" : "HerAI"}: ${clip(h.content, 300)}`)
    .join("\n");
  const user = `Region: ${region}\n${historyText ? "Conversation so far:\n" + historyText + "\n" : ""}New question: ${message}`;

  try {
    const { text } = await callLLM(env, ROUTER_SYSTEM, user, { wantJson: true, maxTokens: 300, userProviders });
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
  /(give|show|find|list|suggest|recommend|top|best|which)\b[\s\S]*\b(stocks?|shares?|picks?|ideas?|names?|companies)|stocks?\s+to\s+(buy|invest|watch|trade)|what\s+(should\s+i|to)\s+buy|which\s+stocks?\b|invest\s+(in\b|tomorrow|today|now)|\b\d{1,3}\s+(stocks?|picks?)\b/i;
const RE_BREAKOUT = /\b(break(?:ing)?\s*out|breakout|golden\s+cross)\b/i;

function isStockSpecific(message) {
  if (RE_SCREEN_PICK.test(message)) return false;
  if (/\b(stocks|shares|ideas|names|companies|picks|list|screener|screen)\b/i.test(message)) return false;
  return true;
}

function isMultiStockPriceQuery(message) {
  const m = String(message || "");
  const plural = /\b(stocks|shares|companies|names|picks)\b/i.test(m);
  return plural && RE_PRICE_TARGET.test(m);
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

  if (isMultiStockPriceQuery(message)) {
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

// ── Multi-intent extraction + corpus search + result coverage ──────────────
const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "with", "from",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these", "those",
  "which", "what", "when", "how", "why", "today", "now", "near", "good", "best",
  "stock", "stocks", "share", "shares", "price", "entry", "analysis", "analyse", "analyze",
]);

function extractSearchTerms(query) {
  const terms = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) || [];
  const out = [];
  const seen = new Set();
  for (const t of terms) {
    if (SEARCH_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function parseSitemapLocs(xml) {
  const out = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const v = String(m[1] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

async function listRegionHtmlPaths(env, origin, region) {
  const out = new Set([
    `/${region}/index.html`,
    `/${region}/screens.html`,
    `/${region}/technical.html`,
    `/${region}/funds.html`,
    `/${region}/stocks.html`,
    `/${region}/news.html`,
    `/${region}/learn.html`,
    `/${region}/heraiai.html`,
  ]);

  for (const sp of [`/${region}/sitemap.xml`, "/sitemap.xml"]) {
    const res = await assetGet(env, origin, sp);
    if (!res) continue;
    const xml = await res.text();
    for (const loc of parseSitemapLocs(xml)) {
      try {
        const p = new URL(loc).pathname;
        if (!p.includes(`/${region}/`)) continue;
        if (!/\.html$/i.test(p)) continue;
        out.add(p);
      } catch {
        // ignore invalid URL
      }
    }
  }
  return Array.from(out);
}

function pageTitleFromHtml(html, fallback) {
  const m = String(html || "").match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return fallback;
  return clip(m[1].replace(/\s+/g, " ").trim(), 120) || fallback;
}

function scoreTextAgainstTerms(text, terms) {
  const lower = String(text || "").toLowerCase();
  let score = 0;
  let firstHit = -1;
  for (const t of terms) {
    if (!t) continue;
    const idx = lower.indexOf(t);
    if (idx < 0) continue;
    if (firstHit < 0 || idx < firstHit) firstHit = idx;
    score += 1;
    if (new RegExp(`\\b${t}\\b`, "i").test(lower)) score += 1;
  }
  return { score, firstHit };
}

function snippetAround(text, idx, width = 240) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (idx < 0) return clip(s, width);
  const start = Math.max(0, idx - Math.floor(width / 3));
  return clip(s.slice(start), width);
}

async function searchHtmlCorpus(env, origin, region, query, options = {}) {
  const maxPages = Number(options.maxPages || env?.HERAI_HTML_SCAN_MAX || 5000);
  const maxResults = Number(options.maxResults || 12);
  const terms = extractSearchTerms(query);
  if (!terms.length) return { scanned: 0, results: [], sources: [] };

  const paths = await listRegionHtmlPaths(env, origin, region);
  const picked = paths.slice(0, Math.max(25, Math.min(maxPages, paths.length)));
  const results = [];
  let scanned = 0;

  for (const p of picked) {
    const res = await assetGet(env, origin, p);
    if (!res) continue;
    const html = await res.text();
    const plain = stripHtml(html);
    const { score, firstHit } = scoreTextAgainstTerms(plain, terms);
    scanned += 1;
    if (score <= 0) continue;
    let boost = 0;
    if (p.includes("/screens/")) boost += 2;
    else if (p.includes("/stocks/")) boost += 1;
    const total = score + boost;
    results.push({
      path: p,
      score: total,
      snippet: snippetAround(plain, firstHit),
      title: pageTitleFromHtml(html, p.split("/").pop() || p),
      url: `https://heraiscreener.com${p}`,
    });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, maxResults);
  return {
    scanned,
    totalPaths: paths.length,
    results: top,
    sources: top.map((r) => ({ title: r.title, url: r.url })),
  };
}

function detectIntents(message, route, mode) {
  const m = String(message || "");
  if (isInternetOnlyMode(mode)) return ["INTERNET_RESEARCH"];
  const out = [];

  if (RE_SCREEN_PICK.test(m) || isMultiStockPriceQuery(m) || route.intent === "SCREEN_PICK") out.push("SCREEN_PICK");
  if (RE_PRICE_TARGET.test(m) && !isMultiStockPriceQuery(m)) out.push("PRICE_TARGET");
  if ((route.tickers && route.tickers.length) || /\b(analyze|analyse|overview|deep\s*dive|compare)\b/i.test(m)) out.push("STOCK_DEEP_DIVE");
  if (/\b(news|headline|headlines|catalyst|catalysts|results?|earnings)\b/i.test(m) || route.intent === "NEWS_QUERY") out.push("NEWS_QUERY");
  if (/\b(macro|fed|inflation|rates?|market\s+regime|risk[-\s]?on|risk[-\s]?off)\b/i.test(m) || route.intent === "MARKET_REGIME") out.push("MARKET_REGIME");
  if (isInternetOnlyMode(mode) || /\b(internet|web|google|online|latest)\b/i.test(m)) out.push("INTERNET_RESEARCH");

  if (!out.length && route.intent) out.push(route.intent);
  return Array.from(new Set(out));
}

function intentLabel(kind) {
  const map = {
    SCREEN_PICK: "Screen-based Picks",
    PRICE_TARGET: "Buy Zone / Entry Price",
    STOCK_DEEP_DIVE: "Stock Deep Dive",
    NEWS_QUERY: "News / Catalysts",
    MARKET_REGIME: "Market Regime",
    INTERNET_RESEARCH: "Internet Research",
    GENERAL_QUERY: "General",
  };
  return map[kind] || kind;
}

function summarizeCoverage(intents, sections) {
  return intents.map((kind) => {
    const sec = sections.find((s) => s.kind === kind);
    return {
      kind,
      label: intentLabel(kind),
      met: !!(sec && sec.met),
      note: sec && sec.note ? sec.note : (sec && sec.met ? "Covered" : "No grounded evidence found"),
    };
  });
}

function composeMultiIntentAnswer(message, sections, coverage) {
  const lines = [];
  lines.push(`Question: ${message}`);
  lines.push("");
  for (const sec of sections) {
    lines.push(`### ${intentLabel(sec.kind)}`);
    lines.push(sec.answer || "No grounded evidence found for this intent.");
    lines.push("");
  }
  lines.push("### Intent Coverage");
  for (const c of coverage) {
    lines.push(`- ${c.label}: ${c.met ? "met" : "not met"}${c.note ? ` (${c.note})` : ""}`);
  }
  return lines.join("\n").trim();
}

async function runMultiIntentPlan(env, origin, message, region, route, mode, diagnostics, userProviders = []) {
  const intents = detectIntents(message, route, mode);
  const internetOnly = isInternetOnlyMode(mode);
  const regime = await detectMarketRegime(env, origin, region);
  const sections = [];
  const sources = [];
  const searchStats = [];
  const allTickers = new Set();
  let usedWeb = false;
  let providerUsed = null;

  for (const kind of intents) {
    let localHitCount = 0;
    let pagesScanned = 0;
    let totalPaths = 0;

    if (internetOnly) {
      const queryByIntent = {
        SCREEN_PICK: `${message} best stocks to buy now valuation momentum`,
        PRICE_TARGET: `${message} buy zone support resistance analyst target`,
        STOCK_DEEP_DIVE: `${message} stock analysis valuation technical`,
        NEWS_QUERY: `${message} latest stock news catalysts`,
        MARKET_REGIME: `${message} market regime breadth rates inflation`,
        INTERNET_RESEARCH: message,
      };
      const web = await webSearch(queryByIntent[kind] || message, region);
      if (web && web.text) {
        usedWeb = true;
        sections.push({
          kind,
          met: true,
          answer: `Internet scan results:\n${clip(web.text, 1400)}`,
          note: `Internet source: ${web.engine || "external"}`,
        });
        if (Array.isArray(web.sources)) for (const s of web.sources) sources.push(s);
        else if (web.url) sources.push({ title: `Web (${web.engine || "external"})`, url: web.url });
        searchStats.push({ kind, pagesScanned: 0, totalPaths: 0, localHitCount: 0, usedWeb: true, met: true });
      } else {
        sections.push({
          kind,
          met: false,
          answer: "I could not retrieve internet results for this request right now.",
          note: "Internet retrieval unavailable",
        });
        searchStats.push({ kind, pagesScanned: 0, totalPaths: 0, localHitCount: 0, usedWeb: true, met: false });
      }
      continue;
    }

    if (kind === "SCREEN_PICK" && (mode.technical || mode.fundamental)) {
      try {
        const seed = await searchHtmlCorpus(env, origin, region, `${message} screener technical fundamental stocks`, { maxResults: 8 });
        localHitCount = seed.results.length;
        pagesScanned = seed.scanned;
        totalPaths = seed.totalPaths || 0;
        for (const s of seed.sources || []) sources.push(s);

        const r = { ...route, intent: "SCREEN_PICK", count: route.count || 10, universe: route.universe || "ALL", rawMessage: message };
        const res = await runScreenPick(env, origin, region, r, regime, mode, userProviders);
        if (res && res.answer) {
          sections.push({ kind, met: true, answer: verify(res.answer), note: `Top ranked candidates produced; HTML hits ${localHitCount}` });
          for (const s of res.sources || []) sources.push(s);
          for (const p of res.picks || []) if (p.ticker) allTickers.add(p.ticker);
          if (!providerUsed && res.providerUsed) providerUsed = res.providerUsed;
          searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: true });
          continue;
        }
      } catch (e) {
        diagFail(diagnostics, "multi-screen-pick", e);
      }
      sections.push({ kind, met: false, answer: "I could not build a reliable screen-ranked list from current local data.", note: "Screen ranking unavailable" });
      searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: false });
      continue;
    }

    if (kind === "PRICE_TARGET" && (mode.technical || mode.fundamental)) {
      try {
        const seed = await searchHtmlCorpus(env, origin, region, `${message} buy zone support valuation`, { maxResults: 8 });
        localHitCount = seed.results.length;
        pagesScanned = seed.scanned;
        totalPaths = seed.totalPaths || 0;
        for (const s of seed.sources || []) sources.push(s);

        let tk = (route.tickers && route.tickers[0]) || null;
        if (!tk) {
          const nm = await resolveNameToTicker(env, origin, region, message);
          if (nm) tk = nm.ticker;
        }
        if (tk) {
          const res = await runPriceTarget(env, origin, region, tk, { ...route, rawMessage: message }, regime, userProviders);
          if (res && res.answer) {
            sections.push({ kind, met: true, answer: verify(res.answer), note: `Entry zone computed for ${tk}` });
            for (const s of res.sources || []) sources.push(s);
            allTickers.add(tk);
            if (!providerUsed && res.providerUsed) providerUsed = res.providerUsed;
            searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: true });
            continue;
          }
        }
      } catch (e) {
        diagFail(diagnostics, "multi-price-target", e);
      }
      sections.push({ kind, met: false, answer: "A price-target intent was detected but no specific ticker could be grounded.", note: "Ticker missing" });
      searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: false });
      continue;
    }

    if (kind === "STOCK_DEEP_DIVE" && route.tickers && route.tickers.length) {
      const seed = await searchHtmlCorpus(env, origin, region, `${message} stock analysis valuation technical`, { maxResults: 10 });
      localHitCount = seed.results.length;
      pagesScanned = seed.scanned;
      totalPaths = seed.totalPaths || 0;
      for (const s of seed.sources || []) sources.push(s);

      const lines = [];
      const ts = route.tickers.slice(0, 4);
      for (const tk of ts) {
        const ctx = await fetchStockContext(env, origin, region, tk);
        if (!ctx) continue;
        const snap = ctx.rawSnapshot || {};
        const valTile = (snap.ratios && snap.ratios["Valuation"]) || {};
        const pe = valTile["Stock P/E"] || valTile["P/E"] || valTile["PE"] || "n/a";
        const roe = (snap.ratios && snap.ratios["Returns"] && (snap.ratios["Returns"]["ROE %"] || snap.ratios["Returns"]["ROE"])) || "n/a";
        const tech = computeTechnicals(extractPriceHistory(ctx.rawHtml || ""));
        lines.push(`- ${tk}: ${ctx.summary || "grounded stock page found"}. ${tech ? technicalsToText(tech) : "Technical series unavailable"}. Valuation P/E ${pe}, ROE ${roe}.`);
        sources.push({ title: tk, url: ctx.url });
        allTickers.add(tk);
      }
      sections.push({
        kind,
        met: lines.length > 0,
        answer: lines.length ? lines.join("\n") : "No stock pages were found for the requested tickers.",
        note: lines.length ? "Stock pages analyzed" : "No stock pages matched",
      });
      searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: lines.length > 0 });
      continue;
    }

    if (kind === "NEWS_QUERY") {
      const n = await fetchNews(env, origin, region);
      if (n && n.text) {
        sections.push({ kind, met: true, answer: `I used local curated news feeds. Key payload snapshot:\n${clip(n.text, 1200)}`, note: "Local news feeds used" });
        sources.push({ title: "Market news", url: n.url });
        searchStats.push({ kind, pagesScanned: 0, totalPaths: 0, localHitCount: 1, usedWeb: false, met: true });
      } else {
        const htmlNews = await searchHtmlCorpus(env, origin, region, `${message} news catalysts`, { maxPages: 350, maxResults: 8 });
        localHitCount = htmlNews.results.length;
        pagesScanned = htmlNews.scanned;
        totalPaths = htmlNews.totalPaths || 0;
        if (htmlNews.results.length) {
          const lines = htmlNews.results.map((r, i) => `(${i + 1}) ${r.title}: ${r.snippet}`);
          sections.push({ kind, met: true, answer: `Local news feed was unavailable, so I searched regional HTML pages for catalysts:\n${lines.join("\n")}`, note: `HTML news hits: ${htmlNews.results.length}` });
          for (const s of htmlNews.sources) sources.push(s);
          searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: true });
        } else {
          const webNews = await webSearch(`${message} latest stock news catalysts`, region);
          if (webNews && webNews.text) {
            usedWeb = true;
            sections.push({ kind, met: true, answer: `Local feeds were unavailable, so I used internet news fallback:\n${clip(webNews.text, 1200)}`, note: "Internet news fallback used" });
            if (Array.isArray(webNews.sources)) for (const s of webNews.sources) sources.push(s);
            else if (webNews.url) sources.push({ title: `Web (${webNews.engine || "external"})`, url: webNews.url });
            searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: true, met: true });
          } else {
            sections.push({ kind, met: false, answer: "I could not locate recent catalyst evidence in local feeds, regional HTML pages, or internet fallback.", note: "No catalyst evidence found" });
            searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: false });
          }
        }
      }
      continue;
    }

    if (kind === "MARKET_REGIME") {
      sections.push({
        kind,
        met: true,
        answer: `Regime is ${regime.regime.toUpperCase()}. ${regime.note} Breadth: highs ${regime.breadth.near_52w_high}, lows ${regime.breadth.near_52w_low}, golden-cross ${regime.breadth.golden_cross}, death-cross ${regime.breadth.death_cross}.`,
        note: "Regime computed from screener breadth",
      });
      searchStats.push({ kind, pagesScanned: 0, totalPaths: 0, localHitCount: 1, usedWeb: false, met: true });
      continue;
    }

    // INTERNET_RESEARCH and general unresolved intents use full HTML corpus scan first.
    const html = await searchHtmlCorpus(env, origin, region, message, { maxPages: 350, maxResults: 10 });
    localHitCount = html.results.length;
    pagesScanned = html.scanned;
    totalPaths = html.totalPaths || 0;
    if (html.results.length) {
      const lines = html.results.map((r, i) => `(${i + 1}) ${r.title}: ${r.snippet}`);
      sections.push({ kind, met: true, answer: `Scanned ${html.scanned} HTML pages and matched these grounded passages:\n${lines.join("\n")}`, note: `HTML corpus hits: ${html.results.length}` });
      for (const s of html.sources) sources.push(s);
      searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: true });
      continue;
    }

    const web = await webSearch(message, region);
    if (web && web.text) {
      usedWeb = true;
      sections.push({ kind, met: true, answer: `Local HTML corpus had no direct hit, so I used internet fallback:\n${clip(web.text, 1200)}`, note: "Internet fallback used" });
      if (Array.isArray(web.sources)) for (const s of web.sources) sources.push(s);
      else if (web.url) sources.push({ title: `Web (${web.engine || "external"})`, url: web.url });
      searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: true, met: true });
    } else {
      sections.push({ kind, met: false, answer: "I could not find grounded matches in local HTML corpus or internet fallback.", note: "No evidence found" });
      searchStats.push({ kind, pagesScanned, totalPaths, localHitCount, usedWeb: false, met: false });
    }
  }

  const coverage = summarizeCoverage(intents, sections);
  const answer = verify(composeMultiIntentAnswer(message, sections, coverage));
  return {
    answer,
    intent: intents.length > 1 ? "MULTI_INTENT" : (intents[0] || route.intent || "GENERAL_QUERY"),
    intentCoverage: coverage,
    agents: Array.from(new Set(intents.map((k) => k.toLowerCase()))),
    tickers: Array.from(allTickers),
    citations: rankAndFilterSourcesForMode(region, sources, mode, 14),
    usedWeb,
    providerUsed: providerUsed || "rule engine",
    evidence: {
      region,
      mode: mode.list,
      intent: intents.length > 1 ? "MULTI_INTENT" : (intents[0] || route.intent || "GENERAL_QUERY"),
      intents,
      intentCoverage: coverage,
      searchStats,
      sources: rankAndFilterSourcesForMode(region, sources, mode, 14),
    },
    searchStats,
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
  const resolved = await resolveStockPath(env, origin, ticker, region);
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

async function resolveStockPath(env, origin, ticker, preferredRegion) {
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
      const req = new Request(`${origin}${c.path}`);
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
function buildWebQuery(query, region) {
  const common = "Yahoo Finance Google Finance TradingView";
  const regional = region === "india"
    ? "Moneycontrol NSE India Economic Times"
    : "SEC MarketWatch Nasdaq";
  return `${query} ${regional} ${common}`;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[|\]\]>/g, "");
}

function parseGoogleRssItems(xml, maxItems = 6) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && out.length < maxItems) {
    const chunk = m[1] || "";
    const t = (chunk.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const l = (chunk.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "";
    const d = (chunk.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "";
    const title = decodeXmlEntities(t).replace(/\s+/g, " ").trim();
    const link = decodeXmlEntities(l).trim();
    const desc = decodeXmlEntities(d).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || !link) continue;
    out.push({ title, url: link, snippet: desc });
  }
  return out;
}

async function googleSearchRss(query, region) {
  try {
    const q = buildWebQuery(query, region);
    const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(rss, { headers: { "User-Agent": "HeRAI/1.0" } });
    if (!r.ok) return null;
    const xml = await r.text();
    const items = parseGoogleRssItems(xml, 7);
    if (!items.length) return null;
    const text = items
      .map((it, i) => `(${i + 1}) ${it.title}${it.snippet ? ` — ${it.snippet}` : ""}`)
      .join("\n");
    return {
      engine: "google-rss",
      url: rss,
      text: clip(text, 3000),
      sources: items.map((it) => ({ title: it.title, url: it.url })),
    };
  } catch {
    return null;
  }
}

async function webSearch(query, region) {
  const g = await googleSearchRss(query, region);
  if (g) return g;
  try {
    const q = buildWebQuery(query, region);
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&t=herai`;
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
    if (!text) return null;
    const srcUrl = d.AbstractURL || "https://duckduckgo.com";
    return {
      engine: "duckduckgo",
      url: srcUrl,
      text: clip(text, 2500),
      sources: [{ title: "DuckDuckGo result", url: srcUrl }],
    };
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

async function runSpecialist(env, kind, question, contextText, userProviders = []) {
  if (!contextText) return null;
  const user = `Question: ${question}\n\nData:\n${contextText}`;
  try {
    const { text } = await callLLM(env, SPECIALIST_SYSTEMS[kind], user, { maxTokens: 350, userProviders });
    return text;
  } catch {
    return null;
  }
}

// ── Synthesizer ─────────────────────────────────────────────────────────────
const SYNTH_SYSTEM = `You are HerAI, a Senior Stock Market Analyst at an institutional desk. You write concise, evidence-based research notes for professional investors.

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
const SCREEN_SYNTH_SYSTEM = `You are HerAI, a Senior Stock Market Analyst and portfolio strategist presenting a ranked shortlist of stock ideas to an investment committee.
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
const PRICE_TARGET_SYNTH_SYSTEM = `You are HerAI, a Senior Stock Market Analyst answering "what is the right price to buy X" for a professional client.
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

async function synthesize(env, question, notes, sources, evidence, userProviders = []) {
  const notesText = notes.map((n) => `[${n.kind}] ${n.text}`).join("\n\n");
  const srcText = sources.map((s, i) => `(${i + 1}) ${s.url}`).join("\n");
  const evidenceText = evidence ? clip(JSON.stringify(evidence), 5000) : "(none)";
  const user = `User question: ${question}\n\nSpecialist notes:\n${notesText || "(none)"}\n\nEvidence JSON:\n${evidenceText}\n\nSources:\n${srcText || "(none)"}`;
  const synthesisModel = synthesisWorkersAiModel(env);
  const { text, provider } = await callLLM(env, SYNTH_SYSTEM, user, { maxTokens: 900, model: synthesisModel, userProviders });
  return { text, provider };
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

  const signalDateRaw = m["Signal Date"] || m["Date"] || m["As of"] || "";
  const signalDate = parseDateLoose(signalDateRaw);
  if (signalDate) {
    const days = Math.floor((Date.now() - signalDate.getTime()) / 86400000);
    if (days <= 1) tech += 1;
    else if (days >= 10) tech -= 0.4;
  }

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

function parseDateLoose(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const d1 = new Date(s);
  if (!Number.isNaN(d1.getTime())) return d1;
  const m = s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (!m) return null;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  let yy = parseInt(m[3], 10);
  if (yy < 100) yy += 2000;
  const d2 = new Date(Date.UTC(yy, mm - 1, dd));
  return Number.isNaN(d2.getTime()) ? null : d2;
}

function pickModeWeights(mode, regime) {
  const onlyTech = mode && mode.technical && !mode.fundamental;
  const onlyFund = mode && !mode.technical && mode.fundamental;
  if (onlyTech) return { tech: 0.75, fund: 0.15, sent: 0.10 };
  if (onlyFund) return { tech: 0.15, fund: 0.75, sent: 0.10 };
  return regime.weights;
}

function screenModeLabel(mode) {
  const onlyTech = mode && mode.technical && !mode.fundamental;
  const onlyFund = mode && !mode.technical && mode.fundamental;
  if (onlyTech) return "technical";
  if (onlyFund) return "fundamental";
  return "blended technical+fundamental";
}

function metricValue(c, ...keys) {
  const m = c.metrics || {};
  for (const k of keys) {
    if (m[k] !== undefined && m[k] !== null && String(m[k]).trim()) return String(m[k]).trim();
  }
  return null;
}

function metricPct(v) {
  if (!v) return null;
  return /%\s*$/i.test(String(v)) ? String(v) : `${v}%`;
}

function buildScreenPickFallbackAnswer(route, region, regime, picks, mode) {
  const lines = [];
  const modeLabel = screenModeLabel(mode);
  lines.push(`I screened ${UNIVERSE_LABELS[route.universe]} and ranked names with a ${modeLabel} lens using HeRAI screeners and stock pages.`);
  lines.push(`Market regime: ${regime.regime.toUpperCase()} (${regime.note})`);
  lines.push("");
  for (let i = 0; i < picks.length; i++) {
    const c = picks[i];
    const techLine = c.technicals ? technicalsToText(c.technicals) : "technical snapshot unavailable";
    const pe = metricValue(c, "P/E");
    const fwdPe = c.forwardPe != null ? String(c.forwardPe) : null;
    const roe = metricValue(c, "ROE %");
    const roce = metricValue(c, "ROCE %");
    const rev = metricValue(c, "Rev CAGR 5Y %");
    const prof = metricValue(c, "Profit CAGR 5Y %");
    const eps = c.epsTtm != null ? String(c.epsTtm) : metricValue(c, "EPS (TTM)");
    const scoreLine = `score ${c.composite.toFixed(2)} (tech ${c.tech.toFixed(2)}, fund ${c.fund.toFixed(2)}, sentiment ${c.sent.toFixed(2)})`;
    const setups = (c.setups || []).slice(0, 4).join(", ");
    const screens = (c.screens || []).slice(0, 5).join(", ");
    lines.push(`${i + 1}. ${c.ticker}${c.name ? ` (${c.name})` : ""}`);
    if (mode.technical) lines.push(`- Technical read: ${techLine}`);
    if (mode.fundamental) {
      const f = [
        pe ? `P/E ${pe}` : null,
        fwdPe ? `Forward P/E ${fwdPe}` : null,
        eps ? `EPS ${eps}` : null,
        roe ? `ROE ${metricPct(roe)}` : null,
        roce ? `ROCE ${metricPct(roce)}` : null,
        rev ? `Rev CAGR 5Y ${metricPct(rev)}` : null,
        prof ? `Profit CAGR 5Y ${metricPct(prof)}` : null,
      ].filter(Boolean).join(", ");
      lines.push(`- Fundamental read: ${f || "core valuation/growth ratios were limited in this row"}`);
    }
    if (setups || screens) lines.push(`- Signals used: ${setups || screens}`);
    lines.push(`- Why it ranks here: ${scoreLine}.`);
    lines.push("");
  }
  lines.push("Method: ranked from local HeRAI screener hits + stock-page context, with recency boost for fresh technical signals.");
  return lines.join("\n").trim();
}

async function runScreenPick(env, origin, region, route, regime, mode, userProviders = []) {
  const wantAll = route.universe === "ALL";
  const onlyTech = mode && mode.technical && !mode.fundamental;
  const onlyFund = mode && !mode.technical && mode.fundamental;
  const screenNames = onlyTech
    ? Array.from(new Set(TECH_SCREENS))
    : onlyFund
    ? Array.from(new Set(FUND_SCREENS))
    : Array.from(new Set([...TECH_SCREENS, ...FUND_SCREENS]));
  const activeWeights = pickModeWeights(mode, regime);

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
    .map((c) => ({ ...c, ...scoreCandidate(c, activeWeights) }))
    .sort((a, b) => b.composite - a.composite);

  const topN = scored.slice(0, route.count);

  const enriched = await Promise.all(
    topN.map(async (c) => {
      const ctx = await fetchStockContext(env, origin, region, c.ticker);
      let technicals = null;
      if (ctx && ctx.rawHtml) technicals = computeTechnicals(extractPriceHistory(ctx.rawHtml));
      const valTile = (ctx && ctx.rawSnapshot && ctx.rawSnapshot.ratios && ctx.rawSnapshot.ratios["Valuation"]) || {};
      const epsTtm = parseNum((ctx && ctx.rawSnapshot && ctx.rawSnapshot.header && (ctx.rawSnapshot.header["EPS (TTM)"] || ctx.rawSnapshot.header.EPS)) || valTile["EPS (TTM)"] || valTile["EPS"]);
      const forwardPe = parseNum(valTile["Forward P/E"] || valTile["Fwd P/E"] || valTile["Forward PE"]);
      return {
        ...c,
        name: c.name || (ctx && ctx.name) || c.ticker,
        technicals,
        summary: ctx ? ctx.summary : "",
        contextUrl: ctx ? ctx.url : null,
        epsTtm,
        forwardPe,
      };
    })
  );

  const sourcesRaw = enriched.map((c) => ({
    title: c.ticker,
    url: c.contextUrl || `https://heraiscreener.com/${region}/stocks/${c.ticker}${region === "india" ? ".NS" : ""}.html`,
  }));
  const sources = rankAndFilterSources(region, sourcesRaw, 12);

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
    `Scoring lens: ${screenModeLabel(mode)}\n` +
    `Market regime: ${regime.regime.toUpperCase()} — ${regime.note} (weights: technical ${activeWeights.tech}, fundamental ${activeWeights.fund}, sentiment ${activeWeights.sent}).\n\n` +
    `Ranked candidate pool (already scored from HeRAI's own screeners and price history):\n${evidence}`;

  try {
    const synthesisModel = synthesisWorkersAiModel(env);
    const { text, provider } = await callLLM(env, SCREEN_SYNTH_SYSTEM, user, { maxTokens: 1400, model: synthesisModel, userProviders });
    return { answer: text, sources, picks: enriched, regime, providerUsed: provider };
  } catch {
    const fallback = buildScreenPickFallbackAnswer(route, region, regime, enriched, mode || { technical: true, fundamental: true });
    return { answer: fallback, sources, picks: enriched, regime, providerUsed: "rule engine" };
  }
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

async function runPriceTarget(env, origin, region, ticker, route, regime, userProviders = []) {
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

  const sources = rankAndFilterSources(region, [{ title: ticker, url: ctx.url }], 6);
  const synthesisModel = synthesisWorkersAiModel(env);
  const { text, provider } = await callLLM(env, PRICE_TARGET_SYNTH_SYSTEM, user, { maxTokens: 1000, model: synthesisModel, userProviders });
  return { answer: text, sources, zone, regime, ticker, providerUsed: provider };
}

// ── Main orchestration ──────────────────────────────────────────────────────
async function orchestrate(env, origin, message, region, history, modeConfig, userProviders = []) {
  const mode = normalizeModes(modeConfig);
  const internetOnly = isInternetOnlyMode(mode);
  const allowStructured = mode.technical || mode.fundamental;
  const diagnostics = { stages: [], failures: [] };

  if (allowStructured && mode.technical && RE_BREAKOUT.test(message) && !RE_SCREEN_PICK.test(message)) {
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
          providerUsed: "rule engine",
        };
      }
    } catch (e) {
      // fall through to the LLM-routed pipeline
    }
  }

  const route = await routeQuery(env, message, history, region, userProviders);
  route.rawMessage = message;
  if (internetOnly) {
    route.intent = "INTERNET_RESEARCH";
    route.needs = [];
    route.tickers = [];
  }

  const detectedIntents = detectIntents(message, route, mode);
  const hasCompoundAsk = /\b(and|also|along with|plus|as well as)\b/i.test(message);
  const forceMultiIntent = detectedIntents.length > 1 || hasCompoundAsk;
  if (forceMultiIntent) {
    try {
      const planned = await runMultiIntentPlan(env, origin, message, region, route, mode, diagnostics, userProviders);
      return {
        ...planned,
        disclaimer: DISCLAIMER,
        diagnostics,
      };
    } catch (e) {
      diagFail(diagnostics, "multi-intent-plan", e);
      // fall through to legacy single-intent pipeline
    }
  }

  if (shouldAskClarifying(route, message, allowStructured)) {
    const label = region === "india" ? "India" : "USA";
    return {
      answer:
        `I want to be precise before I analyse this. Which ${label} stock or ticker should I focus on? ` +
        `You can reply with one name/ticker (for example ${region === "india" ? "RELIANCE" : "AAPL"}).`,
      disclaimer: DISCLAIMER,
      intent: "CLARIFY",
      agents: [],
      tickers: [],
      citations: [],
      usedWeb: false,
      providerUsed: null,
      diagnostics,
    };
  }

  const selectedNeeds = [];
  if (mode.technical) selectedNeeds.push("technical");
  if (mode.fundamental) selectedNeeds.push("fundamental");
  route.needs = selectedNeeds;

  if (allowStructured) {
    const isPrice = RE_PRICE_TARGET.test(message) && !RE_SCREEN_PICK.test(message);
    if (isPrice) {
      if (!route.tickers || !route.tickers.length) {
        const nm = await resolveNameToTicker(env, origin, region, message);
        if (nm) route.tickers = [nm.ticker];
      }
      if (route.tickers && route.tickers.length) {
        route.intent = "PRICE_TARGET";
        route.needs = selectedNeeds.length ? selectedNeeds : ["technical", "fundamental"];
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
          providerUsed: null,
          diagnostics,
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
        route.needs = selectedNeeds.length ? selectedNeeds : ["technical", "fundamental"];
      }
    }
  }

  if (allowStructured && (route.intent === "SCREEN_PICK" || route.intent === "PRICE_TARGET")) {
    try {
      const regime = await detectMarketRegime(env, origin, region);

      if (route.intent === "SCREEN_PICK") {
        const res = await runScreenPick(env, origin, region, route, regime, mode, userProviders);
        if (res && res.answer) {
          const citations = rankAndFilterSources(region, res.sources || [], 12);
          const evidence = {
            region,
            mode: mode.list,
            intent: route.intent,
            universe: route.universe,
            confidence: Number(route.confidence || 0),
            regime: { regime: regime.regime, note: regime.note, breadth: regime.breadth },
            picks: (res.picks || []).map((p) => ({ ticker: p.ticker, name: p.name, composite: p.composite, tech: p.tech, fund: p.fund, sent: p.sent })),
            sources: citations,
          };
          const checked = await verifyAgainstEvidence(env, res.answer, evidence, userProviders);
          return {
            answer: verify(checked),
            disclaimer: DISCLAIMER,
            intent: route.intent,
            agents: ["screener", "technical", "fundamental"],
            tickers: (res.picks || []).map((p) => p.ticker),
            universe: route.universe,
            regime: regime.regime,
            citations,
            usedWeb: false,
            providerUsed: res.providerUsed || null,
            evidence,
            diagnostics,
          };
        }
      }

      if (route.intent === "PRICE_TARGET" && route.tickers.length) {
        const res = await runPriceTarget(env, origin, region, route.tickers[0], route, regime, userProviders);
        if (res && res.answer) {
          const citations = rankAndFilterSources(region, res.sources || [], 8);
          const evidence = {
            region,
            mode: mode.list,
            intent: route.intent,
            confidence: Number(route.confidence || 0),
            regime: { regime: regime.regime, note: regime.note, breadth: regime.breadth },
            ticker: res.ticker,
            buyZone: res.zone ? { buy: res.zone.buy, zone: res.zone.zone, anchors: res.zone.anchors } : null,
            sources: citations,
          };
          const checked = await verifyAgainstEvidence(env, res.answer, evidence, userProviders);
          return {
            answer: verify(checked),
            disclaimer: DISCLAIMER,
            intent: route.intent,
            agents: ["technical", "fundamental", "valuation"],
            tickers: [res.ticker],
            regime: regime.regime,
            buyZone: res.zone ? { buy: res.zone.buy, zone: res.zone.zone } : null,
            citations,
            usedWeb: false,
            providerUsed: res.providerUsed || null,
            evidence,
            diagnostics,
          };
        }
      }
    } catch (e) {
      diagFail(diagnostics, "specialized-branch", e);
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
  if (internalThin || mode.internet) {
    const web = await webSearch(`${message} stock`, region);
    if (web) {
      usedWeb = true;
      contextByKind.web = web.text;
      if (Array.isArray(web.sources) && web.sources.length) {
        for (const s of web.sources.slice(0, 8)) sources.push({ title: s.title, url: s.url });
      } else {
        sources.push({ title: `Web (${web.engine || "external"})`, url: web.url });
      }
    }
  }

  const rankedSources = rankAndFilterSourcesForMode(region, sources, mode, 12);

  const specialistJobs = [];
  const specialistPrompt = (kind, question, contextText) => ({
    system: SPECIALIST_SYSTEMS[kind],
    user: `Question: ${question}\n\nData:\n${contextText}`,
  });
  if (wantTech && contextByKind.technical) {
    specialistJobs.push((async () => {
      try {
        const p = specialistPrompt("technical", message, contextByKind.technical);
        const out = await callLLMWithRetry(env, p.system, p.user, { maxTokens: 350, userProviders }, diagnostics, "specialist-technical", 2);
        return { kind: "technical", text: out.text };
      } catch (e) { diagFail(diagnostics, "specialist-technical", e); return null; }
    })());
  }
  if (wantFund && contextByKind.fundamental) {
    specialistJobs.push((async () => {
      try {
        const p = specialistPrompt("fundamental", message, contextByKind.fundamental);
        const out = await callLLMWithRetry(env, p.system, p.user, { maxTokens: 350, userProviders }, diagnostics, "specialist-fundamental", 2);
        return { kind: "fundamental", text: out.text };
      } catch (e) { diagFail(diagnostics, "specialist-fundamental", e); return null; }
    })());
  }
  if (wantNews && contextByKind.news) {
    specialistJobs.push((async () => {
      try {
        const p = specialistPrompt("news", message, contextByKind.news);
        const out = await callLLMWithRetry(env, p.system, p.user, { maxTokens: 350, userProviders }, diagnostics, "specialist-news", 2);
        return { kind: "news", text: out.text };
      } catch (e) { diagFail(diagnostics, "specialist-news", e); return null; }
    })());
  }
  if (wantMacro && contextByKind.macro) {
    specialistJobs.push((async () => {
      try {
        const p = specialistPrompt("macro", message, contextByKind.macro);
        const out = await callLLMWithRetry(env, p.system, p.user, { maxTokens: 350, userProviders }, diagnostics, "specialist-macro", 2);
        return { kind: "macro", text: out.text };
      } catch (e) { diagFail(diagnostics, "specialist-macro", e); return null; }
    })());
  }

  let notes = (await Promise.all(specialistJobs)).filter((n) => n && n.text);

  if (!notes.length && contextByKind.web) {
    notes = [{ kind: "web", text: contextByKind.web }];
  }

  const evidence = buildEvidencePack(
    route,
    region,
    stockContexts,
    contextByKind,
    null,
    mode,
    rankedSources
  );

  let answer;
  let providerUsed = null;
  if (notes.length) {
    try {
      const syn = await synthesize(env, message, notes, rankedSources, evidence, userProviders);
      answer = syn.text;
      providerUsed = syn.provider || null;
      answer = await verifyAgainstEvidence(env, answer, evidence, userProviders);
    } catch (e) {
      diagFail(diagnostics, "synthesis", e);
      const bullets = notes.slice(0, 4).map((n) => `- ${n.kind}: ${clip(n.text, 260)}`);
      answer = `Synthesis model was unavailable, so here is a direct evidence summary:\n${bullets.join("\n")}`;
      providerUsed = "rule engine";
    }
  } else {
    const needsSpecificData =
      route.tickers.length ||
      ["STOCK_DEEP_DIVE", "PRICE_TARGET", "SCREEN_PICK", "COMPARE_STOCKS", "SECTOR_ANALYSIS"].includes(route.intent);
    if (mode.internet) {
      try {
        const synthesisModel = synthesisWorkersAiModel(env);
        const { text, provider } = await callLLMWithRetry(
          env,
          "You are HerAI, a Senior Stock Market Analyst. Provide a concise answer using high-level market knowledge and clearly label uncertainty when exact sourced data is unavailable in this request. Do not give direct buy/sell advice.",
          message,
          { maxTokens: 500, model: synthesisModel, userProviders },
          diagnostics,
          "internet-fallback",
          2
        );
        answer = text;
        providerUsed = provider || providerUsed;
      } catch (e) {
        diagFail(diagnostics, "internet-fallback", e);
        if (contextByKind.web) {
          const webBullets = summarizeWebSignals(contextByKind.web, 7);
          answer =
            "Live model inference is temporarily unavailable, but here are the most relevant internet signals I found:\n\n" +
            (webBullets || clip(contextByKind.web, 1200));
          providerUsed = "rule engine";
        } else {
          answer =
            "Internet mode is enabled, but live model inference is temporarily unavailable for this request. " +
            "Please retry in a moment, or provide a session API key in the chat panel to continue with external-analysis fallback.";
        }
      }
    } else if (needsSpecificData) {
      if ((wantTech || wantFund) && stockContexts.length) {
        const first = stockContexts[0];
        answer =
          `I found grounded data for ${first.ticker}${first.name ? ` (${first.name})` : ""}. ` +
          `Here is the evidence snapshot from HeRAI data while live specialist synthesis is temporarily unavailable:\n\n` +
          `${clip(first.summary, 420)}\n\n` +
          `${wantTech ? "Technical evidence available from the stock page and computed indicators.\n" : ""}` +
          `${wantFund ? "Fundamental evidence available from valuation, growth, and quality sections.\n" : ""}` +
          `Please ask a narrower follow-up (for example: \"technical trend only\" or \"valuation vs peers\") and I will return a tighter answer.`;
        providerUsed = "rule engine";
      } else {
        const askedFor = route.tickers.length ? route.tickers.join(", ") : "that";
        answer =
          `I ground every answer in HeRAI's own built data (per-stock pages, screeners, macro), and I could not locate the specific data needed for ${askedFor} in the ${region.toUpperCase()} dataset right now. ` +
          `Please give me an exact ticker we cover (e.g., AAPL, RELIANCE), ask for a screen-based shortlist (e.g., "10 S&P 500 stocks to consider"), or ask for a buy zone on a named stock, and I'll analyse it from the data.`;
      }
    } else {
      try {
        const synthesisModel = synthesisWorkersAiModel(env);
        const { text, provider } = await callLLMWithRetry(
          env,
          "You are HerAI, a Senior Stock Market Analyst acting as an educator. Explain the CONCEPT the user asked about (e.g., what RSI/P-E/support means) in 1-3 short paragraphs, using institutional terminology. " +
            "Do NOT invent specific prices, tickers, targets, or figures. Do NOT give buy/sell advice. Do not role-play a dialogue or ask follow-up questions. " +
            "If the question actually requires specific stock data, say it should be asked about a named ticker or via a screen.",
          message,
          { maxTokens: 600, model: synthesisModel, userProviders },
          diagnostics,
          "concept-answer",
          2
        );
        answer = text;
        providerUsed = provider || null;
      } catch (e) {
        diagFail(diagnostics, "concept-answer", e);
        answer =
          "Live model inference is temporarily unavailable, so I can only provide grounded stock-specific analysis right now. " +
          "Please ask with a specific ticker (for example AAPL or RELIANCE), or try again shortly.";
      }
    }
  }

  answer = verify(answer);

  return {
    answer,
    disclaimer: DISCLAIMER,
    intent: internetOnly ? "INTERNET_RESEARCH" : route.intent,
    agents: notes.map((n) => n.kind),
    tickers: route.tickers,
    citations: rankedSources,
    usedWeb,
    providerUsed,
    evidence,
    diagnostics,
  };
}

// ── Question bank (analytics) — capture every customer question ─────────────
const QLOG_PREFIX = "q:";
const ALOG_PREFIX = "algo:";
const QLOG_MAX_READ = 5000;
const ALOG_MAX_READ = 5000;

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

function summarizeWebSignals(webText, maxLines = 6) {
  const lines = String(webText || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  const picks = lines.slice(0, Math.max(1, maxLines));
  return picks.map((s) => `- ${clip(s, 220)}`).join("\n");
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

async function handleAlgoAdmin(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-admin-key") || "";
  const adminKey = env && env.HERAI_ADMIN_KEY;
  const hasConfiguredKey = Boolean(adminKey);
  if (hasConfiguredKey && key && key !== adminKey) {
    return json({ error: "unauthorized" }, 401);
  }
  const kv = env && env.HERAI_KV;
  if (!kv) return json({ error: "HERAI_KV not bound — algo telemetry is disabled.", entries: [] }, 200);

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "2000", 10) || 2000, ALOG_MAX_READ);
  const entries = [];
  let cursor;
  while (entries.length < ALOG_MAX_READ) {
    const res = await kv.list({ prefix: ALOG_PREFIX, cursor, limit: 1000 });
    const gets = await Promise.all(res.keys.map((k) => kv.get(k.name)));
    for (const g of gets) { if (g) { try { entries.push(JSON.parse(g)); } catch { /* skip */ } } }
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const trimmed = entries.slice(0, limit);

  const total = trimmed.length;
  let fallbackRuns = 0;
  let unmetRuns = 0;
  const byIntent = {};
  const byRegion = {};
  const perIntent = {};
  const missByQuestion = {};

  for (const e of trimmed) {
    const intent = e.intent || "?";
    const region = e.region || "?";
    byIntent[intent] = (byIntent[intent] || 0) + 1;
    byRegion[region] = (byRegion[region] || 0) + 1;

    if (e.fallbackUsed || e.usedWeb) fallbackRuns++;
    const coverage = Array.isArray(e.coverage) ? e.coverage : [];
    const hasUnmet = coverage.some((c) => c && c.met === false) || (Array.isArray(e.unmetIntents) && e.unmetIntents.length > 0);
    if (hasUnmet) {
      unmetRuns++;
      const qn = String(e.q || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 140);
      if (!missByQuestion[qn]) missByQuestion[qn] = { q: e.q, misses: 0 };
      missByQuestion[qn].misses++;
    }

    for (const c of coverage) {
      const k = c && c.kind ? c.kind : "UNKNOWN";
      if (!perIntent[k]) {
        perIntent[k] = { runs: 0, met: 0, unmet: 0, webFallbacks: 0, pagesScannedSum: 0, localHitsSum: 0, sampleCount: 0 };
      }
      perIntent[k].runs++;
      if (c && c.met) perIntent[k].met++; else perIntent[k].unmet++;
    }

    const stats = Array.isArray(e.searchStats) ? e.searchStats : [];
    for (const s of stats) {
      const k = s && s.kind ? s.kind : "UNKNOWN";
      if (!perIntent[k]) {
        perIntent[k] = { runs: 0, met: 0, unmet: 0, webFallbacks: 0, pagesScannedSum: 0, localHitsSum: 0, sampleCount: 0 };
      }
      if (s.usedWeb) perIntent[k].webFallbacks++;
      perIntent[k].pagesScannedSum += Number(s.pagesScanned || 0);
      perIntent[k].localHitsSum += Number(s.localHitCount || 0);
      perIntent[k].sampleCount += 1;
    }
  }

  const perIntentSummary = {};
  for (const [k, v] of Object.entries(perIntent)) {
    perIntentSummary[k] = {
      runs: v.runs,
      met: v.met,
      unmet: v.unmet,
      metRatePct: v.runs ? Math.round((v.met * 10000) / v.runs) / 100 : 0,
      webFallbacks: v.webFallbacks,
      avgPagesScanned: v.sampleCount ? Math.round((v.pagesScannedSum / v.sampleCount) * 100) / 100 : 0,
      avgLocalHitCount: v.sampleCount ? Math.round((v.localHitsSum / v.sampleCount) * 100) / 100 : 0,
    };
  }

  const topMisses = Object.values(missByQuestion)
    .sort((a, b) => b.misses - a.misses)
    .slice(0, 50);

  if (url.searchParams.get("format") === "csv") {
    const cols = ["ts", "region", "mode", "q", "intent", "usedWeb", "fallbackUsed", "unmetIntents", "answerPreview"];
    const rows = [cols.join(",")];
    for (const e of trimmed) {
      const row = {
        ts: e.ts,
        region: e.region,
        mode: e.mode,
        q: e.q,
        intent: e.intent,
        usedWeb: !!e.usedWeb,
        fallbackUsed: !!e.fallbackUsed,
        unmetIntents: Array.isArray(e.unmetIntents) ? e.unmetIntents.join("|") : "",
        answerPreview: e.answerPreview,
      };
      rows.push(cols.map((c) => csvCell(row[c])).join(","));
    }
    return new Response(rows.join("\n"), {
      status: 200,
      headers: { ...cors(), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="herai_algo_runs.csv"' },
    });
  }

  return json({
    total,
    fallbackRuns,
    fallbackRatePct: total ? Math.round((fallbackRuns * 10000) / total) / 100 : 0,
    unmetRuns,
    unmetIntentRatePct: total ? Math.round((unmetRuns * 10000) / total) / 100 : 0,
    byIntent,
    byRegion,
    perIntent: perIntentSummary,
    topMisses,
    entries: trimmed,
  });
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

  if (url.pathname === "/api/herai/algo" && request.method === "GET") {
    return handleAlgoAdmin(request, env);
  }

  if (url.pathname === "/api/herai/chat" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* empty */ }

    const message = clip(body.message, MAX_MESSAGE).trim();
    const region = ALLOWED_REGIONS.has(body.region) ? body.region : "usa";
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
    const mode = normalizeModes(body.modes);
    const userProviders = normalizeUserProviders(body.userProviders || body.providers || body.apiProviders);

    if (!message) return json({ error: "Please enter a question." }, 400);
    if (!hasWorkersAI(env) && !availableProviders(env).length) {
      return json({ error: "HerAI is not configured yet (no Workers AI binding or provider key set)." }, 503);
    }

    const cacheable = !history.length && !userProviders.length;
    const key = cacheable ? await cacheKey(region, `${mode.cacheKey}::${message}`) : null;
    const cached = cacheable ? await cacheGet(env, key) : null;
    if (cached) {
      logQuestion(env, ctx, { message, region, mode: mode.cacheKey }, cached);
      logAlgoRun(env, ctx, { message, region, mode: mode.cacheKey }, cached);
      return json({ ...cached, cached: true });
    }

    try {
      const result = await orchestrate(env, url.origin, message, region, history, mode.list, userProviders);
      logQuestion(env, ctx, { message, region, mode: mode.cacheKey }, result);
      logAlgoRun(env, ctx, { message, region, mode: mode.cacheKey }, result);
      if (cacheable) ctx.waitUntil(cachePut(env, key, result));
      return json(result);
    } catch (e) {
      const msg = String(e && e.message);
      try { console.error("HerAI chat error:", (e && e.stack) || e); } catch { /* noop */ }
      logQuestion(env, ctx, { message, region, mode: mode.cacheKey }, { error: msg, intent: "ERROR" });
      logAlgoRun(env, ctx, { message, region, mode: mode.cacheKey }, { error: msg, intent: "ERROR", usedWeb: false, intentCoverage: [] });
      if (msg.includes("NO_LLM_KEYS")) {
        return json({ error: "HerAI is not configured yet (no Workers AI binding or provider key set)." }, 503);
      }
      if (msg.includes("USER_PROVIDER_FAILED")) {
        return json({ error: "Provided API key(s) failed. Cloudflare fallback also unavailable.", detail: msg.slice(0, 500) }, 502);
      }
      if (msg.includes("WORKERS_AI_FAILED")) {
        return json({ error: "Workers AI inference failed", detail: msg.slice(0, 500) }, 502);
      }
      return json({ error: "HerAI hit an error. Please try again." }, 500);
    }
  }

  return json({ error: "unknown herai route" }, 404);
}

function diagFail(diagnostics, stage, error) {
  if (!diagnostics) return;
  const msg = String((error && error.message) || error || "unknown");
  diagnostics.failures.push({ stage, error: clip(msg, 240) });
}

async function callLLMWithRetry(env, system, user, options, diagnostics, stage, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const out = await callLLM(env, system, user, options || {});
      if (diagnostics) diagnostics.stages.push({ stage, attempt: i + 1, ok: true, provider: out.provider || null });
      return out;
    } catch (e) {
      lastErr = e;
      if (diagnostics) diagnostics.stages.push({ stage, attempt: i + 1, ok: false, provider: null });
    }
  }
  throw lastErr || new Error(`${stage}: failed`);
}

function logAlgoRun(env, ctx, meta, result) {
  try {
    const kv = env && env.HERAI_KV;
    if (!kv) return;
    const intentCoverage = (result && result.intentCoverage) || (result && result.evidence && result.evidence.intentCoverage) || [];
    const searchStats = (result && result.searchStats) || (result && result.evidence && result.evidence.searchStats) || [];
    const entry = {
      ts: new Date().toISOString(),
      region: meta.region,
      mode: meta.mode,
      q: String(meta.message || "").slice(0, 500),
      intent: (result && result.intent) || null,
      usedWeb: !!(result && result.usedWeb),
      fallbackUsed: !!(result && result.usedWeb),
      coverage: intentCoverage,
      searchStats,
      unmetIntents: intentCoverage.filter((x) => !x.met).map((x) => x.kind),
      answerPreview: String((result && result.answer) || (result && result.error) || "").slice(0, 300),
    };
    const key = ALOG_PREFIX + Date.now() + ":" + Math.random().toString(36).slice(2, 8);
    const p = kv.put(key, JSON.stringify(entry));
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
  } catch {
    /* telemetry must never break the chat */
  }
}