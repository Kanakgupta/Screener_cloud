/**
 * Elite Club Discussion Forum — Cloudflare Worker
 *
 * Handles /api/elite/* routes using KV for storage.
 * Handles /api/herai/* routes via the HerAI multi-agent orchestrator.
 * All other requests fall through to static assets.
 *
 * KV key scheme:
 *   {region}:{thread_id}  →  full thread JSON
 */

import { handleHeraiRequest } from "./herai.js";

const ALLOWED_REGIONS = new Set(["usa", "india", "global"]);
const ALLOWED_CATEGORIES = [
  "Suggestion", "Discussion", "Question", "Strategy", "News", "Off-Topic",
];
const RETENTION_DAYS = 30;
const MAX_TITLE = 240;
const MAX_BODY = 8000;
const MAX_AUTHOR = 60;

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function shortId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function slug(s) {
  return (s || "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 48) || "thread";
}
function clean(s, n) {
  return (s || "").trim().slice(0, n);
}
function esc(s) {
  return String(s || "");
}
function validRegion(r) {
  return ALLOWED_REGIONS.has(r) ? r : "global";
}
function validThreadId(id) {
  return /^[A-Za-z0-9_\-]{6,80}$/.test(id || "");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── KV operations ────────────────────────────────────────────────────────────

async function kvKey(region, id) {
  return `${region}:${id}`;
}

async function readThread(kv, region, id) {
  const raw = await kv.get(await kvKey(region, id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeThread(kv, region, id, obj) {
  await kv.put(await kvKey(region, id), JSON.stringify(obj));
}

async function listAllThreads(kv, region) {
  const prefix = `${region}:`;
  const threads = [];
  let cursor = null;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const key of res.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        try { threads.push(JSON.parse(raw)); } catch { /* skip corrupt */ }
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return threads;
}

async function purgeOld(kv, region) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const prefix = `${region}:`;
  let cursor = null;
  do {
    const res = await kv.list({ prefix, cursor });
    for (const key of res.keys) {
      // Key format: region:YYYY-MM-DD_slug_hex
      const datepart = key.name.slice(prefix.length, prefix.length + 10);
      if (datepart < cutoff) {
        await kv.delete(key.name);
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
}

// ── Thread summary ───────────────────────────────────────────────────────────

function summaryFor(t) {
  const posts = t.posts || [];
  const score = (t.votes || 0) + posts.length * 2 +
    posts.reduce((s, p) => s + (p.votes || 0), 0);
  return {
    id: t.id,
    title: t.title,
    category: t.category,
    tags: t.tags || [],
    author: t.author,
    created: t.created,
    updated: t.updated,
    votes: t.votes || 0,
    replies: posts.length,
    score,
    excerpt: (t.body || "").slice(0, 180),
  };
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleList(kv, url) {
  const region = validRegion(url.searchParams.get("region"));
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const meaningful = ["1", "true"].includes(url.searchParams.get("meaningful"));

  await purgeOld(kv, region);
  let threads = await listAllThreads(kv, region);
  let items = threads.map(summaryFor);

  if (q) {
    items = items.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.excerpt || "").toLowerCase().includes(q) ||
      (t.tags || []).some(tg => tg.toLowerCase().includes(q))
    );
  }

  // Sort: suggestions first, then by score, then newest
  items.sort((a, b) => {
    const sa = a.category === "Suggestion" ? 1 : 0;
    const sb = b.category === "Suggestion" ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (b.updated || "").localeCompare(a.updated || "");
  });

  if (meaningful && items.length) {
    const scores = items.map(t => t.score || 0).sort((a, b) => a - b);
    const mid = scores[Math.floor(scores.length / 2)] || 0;
    const thresh = Math.max(1, mid);
    items = items.filter(t => (t.score || 0) >= thresh || t.category === "Suggestion");
  }

  return json({ region, items, categories: ALLOWED_CATEGORIES });
}

async function handleGetThread(kv, url) {
  const region = validRegion(url.searchParams.get("region"));
  const id = url.searchParams.get("id") || "";
  if (!validThreadId(id)) return json({ error: "invalid id" }, 400);
  const t = await readThread(kv, region, id);
  if (!t) return json({ error: "not found" }, 404);
  return json({ region, thread: t });
}

async function handleSummary(kv, url) {
  const region = validRegion(url.searchParams.get("region"));
  await purgeOld(kv, region);
  const threads = await listAllThreads(kv, region);

  const days = {};
  for (const t of threads) {
    const day = (t.created || "").slice(0, 10);
    if (!days[day]) {
      days[day] = { date: day, threads: 0, replies: 0, suggestions: 0, top_titles: [] };
    }
    const d = days[day];
    d.threads++;
    d.replies += (t.posts || []).length;
    if (t.category === "Suggestion") d.suggestions++;
    d.top_titles.push({ id: t.id, title: t.title, category: t.category });
  }

  const out = Object.values(days)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(d => ({ ...d, top_titles: d.top_titles.slice(0, 3) }));

  return json({ region, days: out, retention_days: RETENTION_DAYS });
}

async function handleCreateThread(kv, body) {
  const region = validRegion(body.region);
  const title = clean(body.title, MAX_TITLE);
  const bodyText = clean(body.body, MAX_BODY);
  const author = clean(body.author, MAX_AUTHOR) || "Anonymous";
  if (!title || !bodyText) return json({ error: "Title and body are required." }, 400);

  const cat = ALLOWED_CATEGORIES.includes(body.category) ? body.category : "Discussion";
  const tags = (body.tags || []).filter(Boolean).map(x => clean(x, 24)).slice(0, 6);
  const tid = `${todayStr()}_${slug(title)}_${shortId()}`;
  const now = nowISO();

  const obj = {
    id: tid, region, title, category: cat, tags, author,
    created: now, updated: now, body: bodyText, votes: 0, posts: [],
  };

  await purgeOld(kv, region);
  await writeThread(kv, region, tid, obj);
  return json({ thread: obj });
}

async function handleAddPost(kv, body) {
  const region = validRegion(body.region);
  const threadId = body.id || "";
  const postBody = clean(body.body, MAX_BODY);
  const author = clean(body.author, MAX_AUTHOR) || "Anonymous";
  if (!postBody) return json({ error: "Body is required." }, 400);
  if (!validThreadId(threadId)) return json({ error: "invalid thread id" }, 400);

  const t = await readThread(kv, region, threadId);
  if (!t) return json({ error: "Thread not found." }, 404);

  const post = {
    id: `p_${shortId()}`,
    parent: body.parent || null,
    author,
    created: nowISO(),
    body: postBody,
    votes: 0,
  };
  t.posts = t.posts || [];
  t.posts.push(post);
  t.updated = post.created;
  await writeThread(kv, region, threadId, t);
  return json({ post });
}

async function handleVote(kv, body) {
  const region = validRegion(body.region);
  const threadId = body.id || "";
  const postId = body.postId || null;
  const delta = parseInt(body.dir, 10);
  if (delta !== 1 && delta !== -1) return json({ error: "invalid vote" }, 400);
  if (!validThreadId(threadId)) return json({ error: "invalid thread id" }, 400);

  const t = await readThread(kv, region, threadId);
  if (!t) return json({ error: "Thread not found." }, 404);

  if (!postId) {
    t.votes = (t.votes || 0) + delta;
    t.updated = nowISO();
    await writeThread(kv, region, threadId, t);
    return json({ votes: t.votes });
  }

  const p = (t.posts || []).find(x => x.id === postId);
  if (!p) return json({ error: "Post not found." }, 404);
  p.votes = (p.votes || 0) + delta;
  t.updated = nowISO();
  await writeThread(kv, region, threadId, t);
  return json({ votes: p.votes });
}

// ── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // HerAI multi-agent assistant routes
    if (url.pathname.startsWith("/api/herai/")) {
      try {
        return await handleHeraiRequest(request, env, ctx);
      } catch (e) {
        const msg = String(e && (e.stack || e.message || e));
        return json({ error: "herai route crash", detail: msg.slice(0, 1200) }, 500);
      }
    }

    // CORS preflight
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/elite/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Elite API routes
    if (url.pathname.startsWith("/api/elite/")) {
      const kv = env.ELITE_KV;
      if (!kv) return json({ error: "KV not configured" }, 500);

      const path = url.pathname;

      if (request.method === "GET") {
        if (path === "/api/elite/list") return handleList(kv, url);
        if (path === "/api/elite/thread") return handleGetThread(kv, url);
        if (path === "/api/elite/summary") return handleSummary(kv, url);
        return json({ error: "unknown route" }, 404);
      }

      if (request.method === "POST") {
        let body = {};
        try { body = await request.json(); } catch { /* empty */ }
        if (path === "/api/elite/thread") return handleCreateThread(kv, body);
        if (path === "/api/elite/post") return handleAddPost(kv, body);
        if (path === "/api/elite/vote") return handleVote(kv, body);
        return json({ error: "unknown route" }, 404);
      }

      return json({ error: "method not allowed" }, 405);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};
