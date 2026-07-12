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
  var currentModes = { technical: true, fundamental: true, internet: false };
  var SESSION_KEYS = "herai_user_providers_v1";
  var messagesEl, inputEl, sendBtn;
  var topEl, restEl, forYouWrap, forYouEl, showMoreBtn, searchEl;
  var modeTechnicalBtn, modeFundamentalBtn, modeInternetBtn;
  var keyStatusEl, keyOpenBtn, keyModalEl, keySaveBtn, keyCloseBtns;

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
    renderSide();
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
    if (data.providerUsed) {
      badges.appendChild(el("span", "herai-agent-chip", "provider: " + escapeHtml(data.providerUsed)));
    }
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

  // ---------- mode toggle + API key session state ----------
  function activeModesList() {
    var out = [];
    if (currentModes.technical) out.push("technical");
    if (currentModes.fundamental) out.push("fundamental");
    if (currentModes.internet) out.push("internet");
    return out;
  }

  function refreshModeUI() {
    if (modeTechnicalBtn) modeTechnicalBtn.classList.toggle("active", !!currentModes.technical);
    if (modeFundamentalBtn) modeFundamentalBtn.classList.toggle("active", !!currentModes.fundamental);
    if (modeInternetBtn) modeInternetBtn.classList.toggle("active", !!currentModes.internet);
    if (!inputEl) return;
    var modes = activeModesList();
    if (modes.length === 1 && modes[0] === "internet") {
      inputEl.placeholder = "Ask with internet research enabled...";
    } else if (modes.indexOf("technical") !== -1 && modes.indexOf("fundamental") !== -1) {
      inputEl.placeholder = "Ask technical + fundamental stock questions...";
    } else if (modes.indexOf("technical") !== -1) {
      inputEl.placeholder = "Ask a technical analysis question...";
    } else {
      inputEl.placeholder = "Ask a fundamental analysis question...";
    }
  }

  function toggleMode(key) {
    currentModes[key] = !currentModes[key];
    if (!currentModes.technical && !currentModes.fundamental && !currentModes.internet) {
      currentModes.technical = true;
    }
    refreshModeUI();
  }

  function getSavedProviders() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEYS);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function setSavedProviders(list) {
    try { sessionStorage.setItem(SESSION_KEYS, JSON.stringify(list || [])); } catch (e) {}
    renderProviderStatus();
  }

  function renderProviderStatus() {
    if (!keyStatusEl) return;
    var list = getSavedProviders();
    if (!list.length) {
      keyStatusEl.textContent = "";
      return;
    }
    var names = list.map(function (p) { return p.id; }).join(" -> ");
    keyStatusEl.textContent = "Using session provider key chain: " + names + " (not stored after tab closes).";
  }

  function collectProviderForm() {
    var defs = [
      { id: "gemini" },
      { id: "claude" },
      { id: "openai" },
      { id: "openrouter" },
      { id: "ollama" },
      { id: "groq" },
      { id: "cerebras" },
    ];
    var list = [];
    defs.forEach(function (d) {
      var keyEl = document.getElementById("herai-key-" + d.id);
      if (!keyEl) return;
      var key = (keyEl.value || "").trim();
      if (!key) return;
      var modelEl = document.getElementById("herai-model-" + d.id);
      var endpointEl = document.getElementById("herai-endpoint-" + d.id);
      var item = { id: d.id, key: key };
      if (modelEl && modelEl.value.trim()) item.model = modelEl.value.trim();
      if (endpointEl && endpointEl.value.trim()) item.endpoint = endpointEl.value.trim();
      list.push(item);
    });
    return list;
  }

  function openKeyModal() {
    if (!keyModalEl) return;
    var current = getSavedProviders();
    ["gemini", "claude", "openai", "openrouter", "ollama", "groq", "cerebras"].forEach(function (id) {
      var row = null;
      for (var i = 0; i < current.length; i++) {
        if (current[i].id === id) { row = current[i]; break; }
      }
      var keyEl = document.getElementById("herai-key-" + id);
      var modelEl = document.getElementById("herai-model-" + id);
      var endpointEl = document.getElementById("herai-endpoint-" + id);
      if (keyEl) keyEl.value = row && row.key ? row.key : "";
      if (modelEl) modelEl.value = row && row.model ? row.model : "";
      if (endpointEl) endpointEl.value = row && row.endpoint ? row.endpoint : "";
    });
    keyModalEl.classList.remove("herai-hidden");
  }

  function closeKeyModal() {
    if (keyModalEl) keyModalEl.classList.add("herai-hidden");
  }

  // ---------- ask flows ----------
  function askFaq(id) {
    var entry = FAQ.byId[id];
    if (!entry) return;
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
  function prefillQuestion(q, id) {
    if (!q) return;
    pending = { q: q, id: id || null };
    inputEl.value = q;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + "px";
    inputEl.focus();
  }

  var DISCLAIMER = "This is informational analysis, not investment advice. Data may be delayed or incomplete. Always do your own research.";

  async function liveAsk(text, entry) {
    setBusy(true);
    history.push({ role: "user", content: text });
    var typing = addTyping();
    var payload = {
      message: text,
      region: region,
      history: history.slice(0, -1),
      modes: activeModesList(),
      userProviders: getSavedProviders(),
    };
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
    b.addEventListener("click", function () { prefillQuestion(entry.q, entry.id); });
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
    var recents = loadLearn().recent || [];
    var uniq = [];
    var seen = {};
    recents.forEach(function (r) {
      var q = String((r && r.q) || "").trim();
      if (!q) return;
      var key = q.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      var item = { id: r.id || key, q: q, cat: "recent" };
      FAQ.byId[item.id] = item;
      uniq.push(item);
    });
    topEl.innerHTML = "";
    restEl.innerHTML = "";
    uniq.slice(0, 25).forEach(function (e) { topEl.appendChild(faqButton(e)); });

    if (!uniq.length) {
      topEl.appendChild(el("div", "herai-meta", "Your asked questions will appear here."));
    }
    if (showMoreBtn) {
      if (restEl.childNodes.length > 0) {
        showMoreBtn.classList.remove("herai-hidden");
        showMoreBtn.textContent = "Show " + restEl.childNodes.length + " more questions";
      } else {
        showMoreBtn.classList.add("herai-hidden");
      }
    }
    if (forYouWrap) {
      if (uniq.length > 0) {
        forYouWrap.classList.remove("herai-hidden");
        forYouEl.innerHTML = "";
        uniq.slice(0, 5).forEach(function (e) { forYouEl.appendChild(faqButton(e)); });
      } else {
        forYouWrap.classList.add("herai-hidden");
      }
    }
  }

  function toggleMore() {
    if (!restEl || !showMoreBtn) return;
    var hidden = restEl.classList.toggle("herai-hidden");
    showMoreBtn.textContent = hidden
      ? "Show " + restEl.childNodes.length + " more questions"
      : "Show fewer";
  }

  function onSearch() {
    var q = (searchEl.value || "").trim().toLowerCase();
    [topEl, restEl].forEach(function (list) {
      Array.prototype.forEach.call(list.querySelectorAll(".herai-faq-item"), function (btn) {
        var match = !q || (btn.getAttribute("data-q") || "").indexOf(q) !== -1;
        btn.style.display = match ? "" : "none";
      });
    });
  }

  // ---------- init ----------
  async function loadFaq() {
    // Intentionally disabled: left panel now learns from user's own questions.
    FAQ.questions = [];
    FAQ.top = [];
    FAQ.byId = {};
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
    modeTechnicalBtn = document.getElementById("herai-mode-technical");
    modeFundamentalBtn = document.getElementById("herai-mode-fundamental");
    modeInternetBtn = document.getElementById("herai-mode-internet");
    keyStatusEl = document.getElementById("herai-key-status");
    keyOpenBtn = document.getElementById("herai-open-keys");
    keyModalEl = document.getElementById("herai-key-modal");
    keySaveBtn = document.getElementById("herai-save-keys");
    keyCloseBtns = document.querySelectorAll(".herai-key-close");
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
    if (modeTechnicalBtn) modeTechnicalBtn.addEventListener("click", function () { toggleMode("technical"); inputEl.focus(); });
    if (modeFundamentalBtn) modeFundamentalBtn.addEventListener("click", function () { toggleMode("fundamental"); inputEl.focus(); });
    if (modeInternetBtn) modeInternetBtn.addEventListener("click", function () { toggleMode("internet"); inputEl.focus(); });
    if (keyOpenBtn) keyOpenBtn.addEventListener("click", openKeyModal);
    if (keySaveBtn) keySaveBtn.addEventListener("click", function () { setSavedProviders(collectProviderForm()); closeKeyModal(); });
    if (keyCloseBtns && keyCloseBtns.length) {
      Array.prototype.forEach.call(keyCloseBtns, function (btn) { btn.addEventListener("click", closeKeyModal); });
    }
    if (keyModalEl) {
      keyModalEl.addEventListener("click", function (e) { if (e.target === keyModalEl) closeKeyModal(); });
    }

    refreshModeUI();
    renderProviderStatus();

    await loadFaq();
    if (topEl) renderSide();
    inputEl.focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
