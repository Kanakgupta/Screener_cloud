/* HerAI — two-panel chat: FAQ side panel + chat, with precompiled answers,
   follow-ups, search, and privacy-friendly per-user learning (localStorage). */
(function () {
  "use strict";

  var region = (document.body && document.body.getAttribute("data-region")) || "usa";
  var LEARN_KEY = "herai_learn_" + region;

  var FAQ = { questions: [], byId: {}, top: [] };
  var history = [];          // chat turns {role, content}
  var pending = null;        // staged FAQ idea awaiting user edit/send
  var lastSourceKeys = [];   // screener context from the last answer, for follow-ups
  var currentMode = "analysis"; // sticky: "analysis" (default) or "news"
  var messagesEl, inputEl, sendBtn;
  var topEl, restEl, forYouWrap, forYouEl, showMoreBtn, searchEl;
  var modeNewsBtn, modeAnalysisBtn;

  // ---------- helpers ----------
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function renderText(s) {
    var safe = escapeHtml(s);
    var lines = safe.split(/\n/);
    var out = [], inList = false;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      // whole-line bold => heading
      var head = ln.match(/^\s*\*\*(.+)\*\*\s*:?\s*$/);
      if (head) {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push("<h4>" + head[1] + "</h4>");
        continue;
      }
      ln = ln.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      // markdown links [text](url) -> real clickable links (also hides long
      // redirect URLs like Google News' from the visible text).
      ln = ln.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');
      if (/^\s*[-*]\s+/.test(ln)) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + ln.replace(/^\s*[-*]\s+/, "") + "</li>");
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        out.push(ln);
      }
    }
    if (inList) out.push("</ul>");
    return out.join("\n").replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  }
  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  // ---------- learning store ----------
  function loadLearn() {
    try { return JSON.parse(localStorage.getItem(LEARN_KEY)) || { counts: {}, recent: [] }; }
    catch (e) { return { counts: {}, recent: [] }; }
  }
  function saveLearn(s) { try { localStorage.setItem(LEARN_KEY, JSON.stringify(s)); } catch (e) {} }
  function recordAsk(id, text) {
    var s = loadLearn();
    if (id) s.counts[id] = (s.counts[id] || 0) + 1;
    s.recent = ([{ id: id || null, q: text, t: Date.now() }]).concat(s.recent || []).slice(0, 25);
    saveLearn(s);
    renderForYou();
  }

  // ---------- chat rendering ----------
  function addUser(text) {
    messagesEl.appendChild(el("div", "herai-msg user", escapeHtml(text)));
    scrollDown();
  }
  function addTyping() {
    var t = el("div", "herai-typing");
    t.innerHTML = '<span class="herai-dots"><span></span><span></span><span></span></span>' +
      "<span>HerAI is consulting its analysts\u2026</span>";
    messagesEl.appendChild(t); scrollDown(); return t;
  }
  function addError(text) {
    messagesEl.appendChild(el("div", "herai-msg error", escapeHtml(text))); scrollDown();
  }
  function addBot(data, opts) {
    opts = opts || {};
    var m = el("div", "herai-msg bot");
    m.innerHTML = renderText(data.answer || "");
    var meta = el("div", "herai-meta");

    var badges = el("div", "herai-badges");
    if (opts.instant) {
      badges.appendChild(el("span", "herai-agent-chip instant", "\u26a1 ready answer"));
    }
    (data.agents || []).forEach(function (a) {
      badges.appendChild(el("span", "herai-agent-chip", escapeHtml(a)));
    });
    if (data.usedWeb) badges.appendChild(el("span", "herai-agent-chip", "web"));
    if (badges.childNodes.length) meta.appendChild(badges);

    var cites = (data.citations || data.sources || []);
    if (cites.length) {
      var c = el("div", "herai-cites");
      c.appendChild(el("span", null, "Sources: "));
      cites.forEach(function (s) {
        var a = el("a"); a.href = s.url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = s.title || s.url; c.appendChild(a);
      });
      meta.appendChild(c);
    }
    if (data.disclaimer) meta.appendChild(el("div", "herai-disclaimer", escapeHtml(data.disclaimer)));
    m.appendChild(meta);

    // follow-ups
    if (opts.followups && opts.followups.length) {
      var fu = el("div", "herai-followups");
      opts.followups.forEach(function (f) {
        var b = el("button", "herai-followup", escapeHtml(f.q));
        b.addEventListener("click", function () { askFaq(f.id); });
        fu.appendChild(b);
      });
      m.appendChild(fu);
    }
    messagesEl.appendChild(m); scrollDown();
  }

  function followupsFor(entry) {
    if (!entry || !entry.followups) return [];
    return entry.followups.map(function (id) { return FAQ.byId[id]; })
      .filter(Boolean).map(function (e) { return { id: e.id, q: e.q }; });
  }

  function setBusy(b) { sendBtn.disabled = b; inputEl.disabled = b; }

  // ---------- mode toggle (News / Analysis) ----------
  function setMode(mode) {
    currentMode = (mode === "news") ? "news" : "analysis";
    if (modeNewsBtn) modeNewsBtn.classList.toggle("active", currentMode === "news");
    if (modeAnalysisBtn) modeAnalysisBtn.classList.toggle("active", currentMode === "analysis");
    if (inputEl) {
      inputEl.placeholder = currentMode === "news"
        ? "What's the latest on\u2026 (e.g. Google, Amazon, a sector)"
        : "Ask a stock-market question\u2026";
    }
  }

  // ---------- ask flows ----------
  function askFaq(id) {
    var entry = FAQ.byId[id];
    if (!entry) return;
    if (entry.mode) setMode(entry.mode);
    addUser(entry.q);
    recordAsk(id, entry.q);
    if (entry.answer && entry.answer.trim()) {
      // instant precompiled answer (analysis-mode, screener-backed only)
      if (entry.source && entry.source.length) lastSourceKeys = entry.source;
      addBot(
        { answer: entry.answer, sources: entry.sources || [],
          disclaimer: DISCLAIMER, agents: [] },
        { instant: true, followups: followupsFor(entry) }
      );
      history.push({ role: "user", content: entry.q });
      history.push({ role: "assistant", content: entry.answer });
    } else {
      liveAsk(entry.q, entry);
    }
  }

  function askText(text) {
    text = (text || inputEl.value || "").trim();
    if (!text) return;
    // If the text matches a staged idea (unmodified), reuse its screener sources.
    var entry = (pending && text === pending.q) ? FAQ.byId[pending.id] : null;
    pending = null;
    inputEl.value = "";
    inputEl.style.height = "auto";
    addUser(text);
    recordAsk(entry ? entry.id : null, text);
    liveAsk(text, entry);
  }

  // Clicking a left-panel idea fills the input so the user can tweak it first.
  function prefillFaq(id) {
    var entry = FAQ.byId[id];
    if (!entry) return;
    if (entry.mode) setMode(entry.mode);
    pending = { q: entry.q, id: entry.id };
    inputEl.value = entry.q;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + "px";
    inputEl.focus();
  }

  var DISCLAIMER = "This is informational analysis, not investment advice. Data may be delayed or incomplete. Always do your own research.";

  async function liveAsk(text, entry) {
    setBusy(true);
    history.push({ role: "user", content: text });
    var typing = addTyping();
    var payload = { message: text, region: region, history: history.slice(0, -1), mode: currentMode };
    if (entry && entry.source && entry.source.length) payload.sources = entry.source;
    else if (lastSourceKeys.length) payload.context_sources = lastSourceKeys;
    try {
      var res = await fetch("/api/herai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      typing.remove();
      if (!res.ok || data.error) {
        addError(data.error || "Something went wrong. Please try again.");
      } else {
        if (data.sourceKeys && data.sourceKeys.length) lastSourceKeys = data.sourceKeys;
        addBot(data, { followups: followupsFor(entry) });
        history.push({ role: "assistant", content: data.answer || "" });
        if (history.length > 12) history = history.slice(-12);
      }
    } catch (e) {
      typing.remove();
      addError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
      inputEl.focus();
    }
  }

  // ---------- side panel ----------
  function faqButton(entry) {
    var b = el("button", "herai-faq-item cat-" + entry.cat);
    b.appendChild(el("span", "dot"));
    b.appendChild(el("span", null, escapeHtml(entry.q)));
    b.addEventListener("click", function () { prefillFaq(entry.id); });
    b.setAttribute("data-q", entry.q.toLowerCase());
    b.setAttribute("data-id", entry.id);
    return b;
  }

  function renderForYou() {
    if (!forYouWrap) return;
    var s = loadLearn();
    var ranked = Object.keys(s.counts || {})
      .sort(function (a, b) { return s.counts[b] - s.counts[a]; })
      .map(function (id) { return FAQ.byId[id]; })
      .filter(Boolean)
      .slice(0, 5);
    forYouEl.innerHTML = "";
    if (!ranked.length) { forYouWrap.classList.add("herai-hidden"); return; }
    forYouWrap.classList.remove("herai-hidden");
    ranked.forEach(function (e) { forYouEl.appendChild(faqButton(e)); });
  }

  function renderSide() {
    var qs = FAQ.questions;
    var topIds = FAQ.top && FAQ.top.length ? FAQ.top : qs.slice(0, 10).map(function (e) { return e.id; });
    var topSet = {};
    topIds.forEach(function (id) { topSet[id] = 1; });

    topEl.innerHTML = "";
    restEl.innerHTML = "";
    qs.forEach(function (e) {
      (topSet[e.id] ? topEl : restEl).appendChild(faqButton(e));
    });

    var hiddenCount = restEl.childNodes.length;
    if (hiddenCount > 0) {
      showMoreBtn.classList.remove("herai-hidden");
      showMoreBtn.textContent = "Show " + hiddenCount + " more questions";
    } else {
      showMoreBtn.classList.add("herai-hidden");
    }
    renderForYou();
  }

  function toggleMore() {
    var hidden = restEl.classList.toggle("herai-hidden");
    showMoreBtn.textContent = hidden
      ? "Show " + restEl.childNodes.length + " more questions"
      : "Show fewer";
  }

  function onSearch() {
    var q = (searchEl.value || "").trim().toLowerCase();
    if (q) restEl.classList.remove("herai-hidden");
    [topEl, restEl].forEach(function (list) {
      Array.prototype.forEach.call(list.querySelectorAll(".herai-faq-item"), function (btn) {
        var match = !q || (btn.getAttribute("data-q") || "").indexOf(q) !== -1;
        btn.style.display = match ? "" : "none";
      });
    });
  }

  // ---------- init ----------
  async function loadFaq() {
    try {
      var res = await fetch("herai_faq.json", { cache: "no-cache" });
      if (!res.ok) return;
      var data = await res.json();
      FAQ.questions = data.questions || [];
      FAQ.top = data.top || [];
      FAQ.byId = {};
      FAQ.questions.forEach(function (e) { FAQ.byId[e.id] = e; });
    } catch (e) { /* FAQ optional */ }
  }

  async function init() {
    messagesEl = document.getElementById("herai-messages");
    inputEl = document.getElementById("herai-input");
    sendBtn = document.getElementById("herai-send");
    topEl = document.getElementById("herai-faq-top");
    restEl = document.getElementById("herai-faq-rest");
    forYouWrap = document.getElementById("herai-foryou-wrap");
    forYouEl = document.getElementById("herai-foryou");
    showMoreBtn = document.getElementById("herai-showmore");
    searchEl = document.getElementById("herai-search");
    modeNewsBtn = document.getElementById("herai-mode-news");
    modeAnalysisBtn = document.getElementById("herai-mode-analysis");
    if (!messagesEl || !inputEl || !sendBtn) return;

    sendBtn.addEventListener("click", function () { askText(); });
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askText(); }
    });
    inputEl.addEventListener("input", function () {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + "px";
    });
    if (showMoreBtn) showMoreBtn.addEventListener("click", toggleMore);
    if (searchEl) searchEl.addEventListener("input", onSearch);
    if (modeNewsBtn) modeNewsBtn.addEventListener("click", function () { setMode("news"); inputEl.focus(); });
    if (modeAnalysisBtn) modeAnalysisBtn.addEventListener("click", function () { setMode("analysis"); inputEl.focus(); });
    setMode(currentMode);

    await loadFaq();
    if (topEl) renderSide();
    inputEl.focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
