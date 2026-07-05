/**
 * HerAI — Multi-Agent Stock Q&A Orchestrator (Cloudflare Worker module)
 *
 * Free-tier stack:
 *   - LLM primary: Cloudflare Workers AI binding (env.AI)
 *   - LLM fallback: Gemini -> Groq -> Cerebras -> OpenRouter (optional secrets)
 *   - Grounding: reads already-deployed static assets (stock HTMLs, /_fred_cache.json)
 *   - Web fallback: DuckDuckGo (no key) — used only when internal data is thin
 *   - Optional answer cache: env.HERAI_KV (falls back to no-cache if unbound)
 *
 * Public entry: handleHeraiRequest(request, env, ctx)
 *   Routes:
 *     POST /api/herai/chat   { message, region, history? } -> { answer, ... }
 *     GET  /api/herai/health -> { ok, providers }
 *
 * Design: docs/HERAI_MULTI_AGENT_DESIGN.md
 */

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

const DEFAULT_CF_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CF_MODEL_FALLBACKS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.1-8b-instruct",
];

// ── Small helpers ───────────────────────────────────────────────────────────
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
  return Array.from(new Set(ordered));
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
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Unified LLM call across the free chain ──────────────────────────────────
async function callLLM(env, system, user, { wantJson = false, maxTokens = 900 } = {}) {
  const providers = availableProviders(env);
  let workersAiErr = null;

  // Primary path: Workers AI binding
  if (hasWorkersAI(env)) {
    try {
      const text = await callWorkersAI(env, system, user, wantJson, maxTokens);
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

async function callWorkersAI(env, system, user, wantJson, maxTokens) {
  const models = workersAiModelCandidates(env);
  const jsonTail = wantJson
    ? "\n\nReturn ONLY a valid JSON object. Do not add markdown fences or extra text."
    : "";
  const promptUser = `${user}${jsonTail}`;
  const prompt = `System:\n${system}\n\nUser:\n${promptUser}`;

  let lastErr = null;
  for (const model of models) {
    try {
      // Workers AI text models are most consistently supported with `prompt`.
      const out = await env.AI.run(model, {
        prompt,
        max_tokens: maxTokens,
        temperature: 0.3,
      });

      const text =
        out?.response ||
        out?.result?.response ||
        out?.output_text ||
        (Array.isArray(out?.result)
          ? out.result.map((x) => x?.text || x?.response || "").join("\n")
          : "");
      if (String(text || "").trim()) return String(text || "");
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || "").toLowerCase();
      // Auto-try the next model when current one is deprecated/unavailable.
      if (
        msg.includes("deprecated") ||
        msg.includes("unknown model") ||
        msg.includes("not found") ||
        msg.includes("invalid model")
      ) {
        continue;
      }
      throw e;
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
const ROUTER_SYSTEM = `You are the routing brain of a stock-market assistant.
Classify the user's question and extract entities. Return ONLY JSON:
{
  "intent": "STOCK_DEEP_DIVE|BUY_RECOMMENDATION|SECTOR_ANALYSIS|SCREEN_QUERY|MARKET_REGIME|COMPARE_STOCKS|NEWS_QUERY|GENERAL_QUERY",
  "tickers": ["AAPL"],
  "sectors": [],
  "timeframe": "short|medium|long|unspecified",
  "needs": ["technical","fundamental","news","macro"],
  "confidence": 0.0
}
Rules: "needs" lists ONLY the specialists required to answer well (keep it minimal).
For a single-stock analysis include technical+fundamental+news. For market mood use macro.
Tickers must be plain symbols (uppercase, no exchange suffix). If none, return [].`;

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

function enrichRouteWithTicker(route, message) {
  const out = { ...route };
  const tokens = Array.from(new Set((message.match(/\b[A-Z]{1,5}\b/g) || []).slice(0, 4)));
  if (!out.tickers || !out.tickers.length) {
    out.tickers = tokens;
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
  const needs = (r.needs || []).filter((n) => validNeeds.has(n));
  return {
    intent: r.intent || "GENERAL_QUERY",
    tickers: (r.tickers || []).map((t) => String(t).toUpperCase().replace(/\.(NS|BO)$/i, "")).slice(0, 4),
    sectors: (r.sectors || []).slice(0, 3),
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
  try {
    const req = new Request(origin + path);
    const res = await env.ASSETS.fetch(req);
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

async function fetchStockContext(env, origin, region, ticker) {
  // Try both plain and .NS for India
  const candidates = region === "india"
    ? [`/${region}/stocks/${ticker}.NS.html`, `/${region}/stocks/${ticker}.html`]
    : [`/${region}/stocks/${ticker}.html`];
  for (const path of candidates) {
    const res = await assetGet(env, origin, path);
    if (res) {
      const html = await res.text();
      const meta = (html.match(/<meta name="description" content="([^"]+)"/i) || [])[1] || "";
      const body = stripHtml(html);
      return {
        ticker,
        url: `https://heraiscreener.com${path}`,
        summary: clip(meta, 400),
        text: clip(body, 4500),
      };
    }
  }
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
  // News feeds may or may not be deployed; try known locations.
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
    "You are a technical analyst. Using ONLY the provided data (price, SMAs, RSI, 52w, returns), give a concise read of trend, momentum and key levels. Never invent numbers. 3-5 sentences.",
  fundamental:
    "You are a fundamental analyst. Using ONLY the provided data (valuation, quality, growth), summarize the company's fundamental picture and fair-value context. Never invent numbers. 3-5 sentences.",
  news:
    "You are a news analyst. Using ONLY the provided items, summarize the most relevant recent catalysts and their likely tone. Cite dates when present. 3-5 sentences.",
  macro:
    "You are a macro/market-regime analyst. Using ONLY the provided macro data, describe the current market backdrop briefly. 2-4 sentences.",
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
const SYNTH_SYSTEM = `You are HerAI, the manager that assembles a final answer for the user.
You are given specialist notes and source snippets. Produce a clear, well-structured answer.
Rules:
- Use ONLY facts present in the specialist notes / sources. Do not invent numbers.
- Be balanced; never say "buy" or "sell" as advice. Frame as data-driven analysis.
- Use short paragraphs or bullets. Keep it focused on the question.
- Do NOT append a disclaimer (the app adds one).`;

async function synthesize(env, question, notes, sources) {
  const notesText = notes.map((n) => `[${n.kind}] ${n.text}`).join("\n\n");
  const srcText = sources.map((s, i) => `(${i + 1}) ${s.url}`).join("\n");
  const user = `User question: ${question}\n\nSpecialist notes:\n${notesText || "(none)"}\n\nSources:\n${srcText || "(none)"}`;
  const { text } = await callLLM(env, SYNTH_SYSTEM, user, { maxTokens: 900 });
  return text;
}

// ── Verifier / guardrails (rule-based, cheap; upgradeable to LLM) ────────────
function verify(answer) {
  let out = String(answer || "").trim();
  // Trim accidental assistant self-dialogue to first complete answer.
  out = out.split(/\n\nIs that\b/i)[0];
  out = out.split(/\n\nNow, let's\b/i)[0];
  out = out.split(/\n\nWould you like\b/i)[0];
  out = out.replace(/^HerAI:\s*/i, "");
  // Soften any accidental direct advice phrasing.
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

// ── Main orchestration ──────────────────────────────────────────────────────
async function orchestrate(env, origin, message, region, history, mode = "analysis") {
  // 1) Route
  const route = await routeQuery(env, message, history, region);

  // Mode override: news mode should route strictly to news specialist flow.
  if (mode === "news") {
    route.needs = ["news"];
  }

  // 2) Gather grounding in parallel
  const groundingTasks = [];
  const sources = [];
  const contextByKind = {};

  const wantTech = route.needs.includes("technical");
  const wantFund = route.needs.includes("fundamental");
  const wantNews = route.needs.includes("news");
  const wantMacro = route.needs.includes("macro");

  // Stock context (shared by technical + fundamental)
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

  // 3) Web fallback only if internal grounding is thin for what was requested
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

  // 4) Run needed specialists in parallel
  const specialistJobs = [];
  if (wantTech && contextByKind.technical) specialistJobs.push(runSpecialist(env, "technical", message, contextByKind.technical).then((t) => ({ kind: "technical", text: t })));
  if (wantFund && contextByKind.fundamental) specialistJobs.push(runSpecialist(env, "fundamental", message, contextByKind.fundamental).then((t) => ({ kind: "fundamental", text: t })));
  if (wantNews && contextByKind.news) specialistJobs.push(runSpecialist(env, "news", message, contextByKind.news).then((t) => ({ kind: "news", text: t })));
  if (wantMacro && contextByKind.macro) specialistJobs.push(runSpecialist(env, "macro", message, contextByKind.macro).then((t) => ({ kind: "macro", text: t })));

  let notes = (await Promise.all(specialistJobs)).filter((n) => n && n.text);

  // If nothing grounded at all, answer generally (single LLM pass) with web note.
  if (!notes.length && contextByKind.web) {
    notes = [{ kind: "web", text: contextByKind.web }];
  }

  // 5) Synthesize
  let answer;
  if (notes.length) {
    answer = await synthesize(env, message, notes, sources);
  } else {
    // No grounding available — general answer, clearly framed.
    const { text } = await callLLM(
      env,
      "You are HerAI, a careful stock-market educator. Answer once in 1-3 short paragraphs or bullets. Never role-play both sides, never ask follow-up questions, never continue into a dialogue. Never give direct buy/sell advice. Do not invent specific prices or figures.",
      message,
      { maxTokens: 700 }
    );
    answer = text;
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
    });
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
    if (cached) return json({ ...cached, cached: true });

    try {
      const result = await orchestrate(env, url.origin, message, region, history, mode);
      if (!history.length) ctx.waitUntil(cachePut(env, key, result));
      return json(result);
    } catch (e) {
      const msg = String(e && e.message);
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
