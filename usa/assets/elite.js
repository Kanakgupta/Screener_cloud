/* Elite Club discussion forum client */
(function(){
  const REGION = (window.SCREENER_REGION && window.SCREENER_REGION.id) || 'global';
  const API = '/api/elite';
  const $ = (id) => document.getElementById(id);

  let STATE = {
    items: [],
    categories: ['All'],
    activeCategory: 'All',
    query: '',
    meaningful: false,
    sort: 'recent',           // 'recent' | 'top'
    currentThread: null,      // full thread when in detail view
    author: localStorage.getItem('ec_author') || '',
  };

  function esc(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtDate(d){ if(!d) return ''; return String(d).replace('T',' ').replace('Z','').slice(0,16); }
  function rel(d){
    if(!d) return '';
    const t = Date.parse(d); if(isNaN(t)) return d;
    const diff = (Date.now() - t)/1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return Math.floor(diff/86400) + 'd ago';
  }
  function catClass(c){ return (c||'').toLowerCase().replace(/[^a-z]/g,''); }

  // ---------- API helpers ----------
  function apiGet(path){
    return fetch(`${API}/${path}`).then(r => r.json());
  }
  function apiPost(path, body){
    return fetch(`${API}/${path}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({region: REGION, ...body}),
    }).then(r => r.json());
  }

  // ---------- Render: summary + categories ----------
  function loadSummary(){
    apiGet(`summary?region=${REGION}`).then(s => {
      const days = (s && s.days) || [];
      const html = days.slice(0,5).map(d => {
        const titles = (d.top_titles||[]).map(t =>
          `<a href="#${esc(t.id)}" data-thread="${esc(t.id)}">${esc(t.title)}</a>`
        ).join(' &middot; ');
        return `<div class="ec-summary-day">
          <span class="ec-day-label">${esc(d.date)}</span>
          <span class="ec-day-meta">${d.threads} thread${d.threads===1?'':'s'} &middot; ${d.replies} repl${d.replies===1?'y':'ies'}${d.suggestions?` &middot; <strong>${d.suggestions} suggestion${d.suggestions===1?'':'s'}</strong>`:''}</span>
          ${titles ? `<div style="margin-top:3px;">${titles}</div>` : ''}
        </div>`;
      }).join('');
      $('ecSummary').innerHTML = `<h2>Executive Summary <span class="muted small" style="font-weight:400;">(last ${s.retention_days||30} days)</span></h2>${html || '<p class="muted small" style="margin:6px 0 0;">No discussions yet — be the first to start one.</p>'}`;
      // delegate clicks for inline thread links
      $('ecSummary').querySelectorAll('a[data-thread]').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); openThread(a.dataset.thread); });
      });
    });
  }

  function buildCategoryList(){
    const counts = {};
    STATE.items.forEach(t => { counts[t.category] = (counts[t.category]||0) + 1; });
    const list = ['All'].concat(STATE.categories);
    $('ecCats').innerHTML = list.map(c => {
      const n = c === 'All' ? STATE.items.length : (counts[c]||0);
      const active = c === STATE.activeCategory ? 'active' : '';
      return `<li class="${active}" data-cat="${esc(c)}">${esc(c)}<span class="ec-cat-count">${n}</span></li>`;
    }).join('');
    $('ecCats').querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        STATE.activeCategory = li.dataset.cat;
        renderList();
        buildCategoryList();
      });
    });
  }

  // ---------- Render: thread list ----------
  function loadList(){
    const params = new URLSearchParams({region: REGION, q: STATE.query});
    if (STATE.meaningful) params.set('meaningful', '1');
    apiGet(`list?${params.toString()}`).then(d => {
      STATE.items = d.items || [];
      STATE.categories = d.categories || [];
      buildCategoryList();
      renderList();
    });
  }

  function renderList(){
    let items = STATE.items.slice();
    if (STATE.activeCategory && STATE.activeCategory !== 'All') {
      items = items.filter(t => t.category === STATE.activeCategory);
    }
    if (STATE.sort === 'top') {
      items.sort((a,b) => (b.score||0) - (a.score||0));
    } else {
      // server already sorted suggestion-first, score, then updated; here re-sort recent
      items.sort((a,b) => {
        const sa = a.category === 'Suggestion' ? 1 : 0;
        const sb = b.category === 'Suggestion' ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return (b.updated||'').localeCompare(a.updated||'');
      });
    }
    if (!items.length) {
      $('ecList').innerHTML = '<div class="ec-empty">No discussions match. <a href="#" id="ecStartLink">Start one →</a></div>';
      const sl = $('ecStartLink');
      if (sl) sl.addEventListener('click', e => { e.preventDefault(); showNewForm(); });
      return;
    }
    $('ecList').innerHTML = items.map(t => `
      <div class="ec-thread-card ${t.category==='Suggestion'?'suggestion':''}" data-id="${esc(t.id)}">
        <div class="ec-thread-head">
          <h4 class="ec-thread-title">${esc(t.title)}</h4>
          <span class="ec-thread-cat ${catClass(t.category)}">${esc(t.category||'Discussion')}</span>
        </div>
        <p class="ec-thread-excerpt">${esc(t.excerpt)}</p>
        <div class="ec-thread-meta">
          ${t.category==='Suggestion'?'<span class="ec-pin">★ Site improvement</span>':''}
          <span>by ${esc(t.author||'Anonymous')}</span>
          <span>${rel(t.created)}</span>
          <span>▲ ${t.votes||0}</span>
          <span>💬 ${t.replies||0}</span>
        </div>
      </div>
    `).join('');
    $('ecList').querySelectorAll('.ec-thread-card').forEach(c => {
      c.addEventListener('click', () => openThread(c.dataset.id));
    });
  }

  // ---------- Render: thread detail ----------
  function openThread(id){
    apiGet(`thread?region=${REGION}&id=${encodeURIComponent(id)}`).then(d => {
      if (!d || !d.thread) return;
      STATE.currentThread = d.thread;
      renderDetail();
      window.scrollTo({top: 0, behavior: 'smooth'});
    });
  }

  function renderDetail(){
    const t = STATE.currentThread;
    if (!t) return;
    const posts = (t.posts || []).slice().sort((a,b) => (a.created||'').localeCompare(b.created||''));
    const tagsHtml = (t.tags||[]).map(x => `<span class="ec-tag">${esc(x)}</span>`).join('');
    $('ecMid').innerHTML = `
      <button class="ec-detail-back" id="ecBack">← Back to discussions</button>
      <span class="ec-thread-cat ${catClass(t.category)}">${esc(t.category||'Discussion')}</span>
      <h2 class="ec-detail-title">${esc(t.title)}</h2>
      <div class="ec-detail-meta">
        by <strong>${esc(t.author||'Anonymous')}</strong> &middot; ${fmtDate(t.created)} &middot; ${rel(t.created)}
        ${tagsHtml ? '&middot; ' + tagsHtml : ''}
      </div>
      <div class="ec-detail-body">${esc(t.body)}</div>
      <div class="ec-detail-actions">
        <button class="ec-vote-btn" data-dir="1">▲ Upvote (<span id="ecThreadVotes">${t.votes||0}</span>)</button>
        <button class="ec-vote-btn" data-dir="-1">▼</button>
      </div>
      <div class="ec-replies-head">${posts.length} ${posts.length===1?'reply':'replies'}</div>
      <div id="ecReplies">${posts.map(renderReply).join('')}</div>
      <div class="ec-reply-form">
        <strong style="display:block; margin-bottom:6px; font-size:13px;">Add a reply</strong>
        <input id="ecReplyAuthor" placeholder="Your name (or leave blank for Anonymous)" value="${esc(STATE.author)}">
        <textarea id="ecReplyBody" placeholder="Share your thoughts, evidence, counter-arguments..."></textarea>
        <div><button class="ec-submit" id="ecReplySubmit">Post reply</button></div>
        <div class="ec-error" id="ecReplyError" hidden></div>
      </div>
    `;
    $('ecBack').addEventListener('click', () => { STATE.currentThread = null; renderHome(); });
    $('ecMid').querySelectorAll('.ec-detail-actions .ec-vote-btn').forEach(b => {
      b.addEventListener('click', () => voteThread(b.dataset.dir));
    });
    $('ecReplySubmit').addEventListener('click', submitReply);
    $('ecMid').querySelectorAll('.ec-reply .ec-vote-btn').forEach(b => {
      b.addEventListener('click', () => votePost(b.dataset.id, b.dataset.dir));
    });
  }

  function renderReply(p){
    return `<div class="ec-reply" data-id="${esc(p.id)}">
      <div class="ec-reply-meta"><strong>${esc(p.author||'Anonymous')}</strong> &middot; ${fmtDate(p.created)} &middot; ${rel(p.created)}</div>
      <div class="ec-reply-body">${esc(p.body)}</div>
      <div class="ec-reply-actions">
        <button class="ec-vote-btn" data-id="${esc(p.id)}" data-dir="1">▲ <span class="ec-pv-${esc(p.id)}">${p.votes||0}</span></button>
        <button class="ec-vote-btn" data-id="${esc(p.id)}" data-dir="-1">▼</button>
      </div>
    </div>`;
  }

  function voteThread(dir){
    const t = STATE.currentThread; if (!t) return;
    apiPost('vote', {id: t.id, dir: parseInt(dir,10)}).then(r => {
      if (r && typeof r.votes === 'number') {
        t.votes = r.votes;
        const el = $('ecThreadVotes'); if (el) el.textContent = r.votes;
      }
    });
  }
  function votePost(pid, dir){
    const t = STATE.currentThread; if (!t) return;
    apiPost('vote', {id: t.id, postId: pid, dir: parseInt(dir,10)}).then(r => {
      if (r && typeof r.votes === 'number') {
        document.querySelectorAll('.ec-pv-'+CSS.escape(pid)).forEach(el => el.textContent = r.votes);
      }
    });
  }
  function submitReply(){
    const t = STATE.currentThread; if (!t) return;
    const body = $('ecReplyBody').value.trim();
    const author = $('ecReplyAuthor').value.trim();
    const err = $('ecReplyError');
    if (!body) { err.textContent = 'Please write a reply.'; err.hidden = false; return; }
    err.hidden = true;
    if (author) { STATE.author = author; localStorage.setItem('ec_author', author); }
    apiPost('post', {id: t.id, body, author, parent: null}).then(r => {
      if (r && r.post) {
        t.posts = t.posts || [];
        t.posts.push(r.post);
        renderDetail();
        loadSummary();
      } else {
        err.textContent = (r && r.error) || 'Could not post reply.';
        err.hidden = false;
      }
    });
  }

  // ---------- New thread form ----------
  function showNewForm(){
    STATE.currentThread = null;
    $('ecMid').innerHTML = `
      <button class="ec-detail-back" id="ecBack">← Back to discussions</button>
      <h2 class="ec-detail-title">Start a new discussion</h2>
      <div class="ec-new-form">
        <div class="ec-form-row">
          <input id="ecNewAuthor" placeholder="Your name (optional)" value="${esc(STATE.author)}">
          <select id="ecNewCat">
            ${STATE.categories.map(c => `<option value="${esc(c)}"${c==='Suggestion'?' selected':''}>${esc(c)}${c==='Suggestion'?' ★ (top priority)':''}</option>`).join('')}
          </select>
        </div>
        <input id="ecNewTitle" placeholder="Title (e.g. 'Add a portfolio tracker page')">
        <input id="ecNewTags" placeholder="Tags (comma separated, optional)">
        <textarea id="ecNewBody" placeholder="Describe your idea, question, or discussion. For suggestions, explain the problem and proposed solution."></textarea>
        <div>
          <button class="ec-submit" id="ecNewSubmit">Post discussion</button>
          <button class="ec-cancel" id="ecNewCancel">Cancel</button>
        </div>
        <div class="ec-error" id="ecNewError" hidden></div>
        <p class="muted small" style="margin-top:10px;">Discussions are stored locally and auto-purge after 30 days. Suggestions to improve the site are pinned to the top.</p>
      </div>
    `;
    $('ecBack').addEventListener('click', renderHome);
    $('ecNewCancel').addEventListener('click', renderHome);
    $('ecNewSubmit').addEventListener('click', submitNew);
  }
  function submitNew(){
    const title = $('ecNewTitle').value.trim();
    const body  = $('ecNewBody').value.trim();
    const author = $('ecNewAuthor').value.trim();
    const category = $('ecNewCat').value;
    const tags = $('ecNewTags').value.split(',').map(s => s.trim()).filter(Boolean);
    const err = $('ecNewError');
    if (!title || !body) { err.textContent = 'Title and body are required.'; err.hidden = false; return; }
    err.hidden = true;
    if (author) { STATE.author = author; localStorage.setItem('ec_author', author); }
    apiPost('thread', {title, body, author, category, tags}).then(r => {
      if (r && r.thread) {
        loadList();
        loadSummary();
        openThread(r.thread.id);
      } else {
        err.textContent = (r && r.error) || 'Could not create discussion.';
        err.hidden = false;
      }
    });
  }

  // ---------- Home view (list with toolbar) ----------
  function renderHome(){
    $('ecMid').innerHTML = `
      <div id="ecSummary" class="ec-summary"><span class="muted small">Loading summary…</span></div>
      <div class="ec-toolbar">
        <strong>Discussions</strong>
        <select id="ecSort">
          <option value="recent">Most recent</option>
          <option value="top">Top score</option>
        </select>
        <label><input type="checkbox" id="ecMeaningful" ${STATE.meaningful?'checked':''}> Meaningful only</label>
      </div>
      <div id="ecList"></div>
    `;
    $('ecSort').value = STATE.sort;
    $('ecSort').addEventListener('change', e => { STATE.sort = e.target.value; renderList(); });
    $('ecMeaningful').addEventListener('change', e => { STATE.meaningful = e.target.checked; loadList(); });
    loadSummary();
    renderList();
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    $('ecNewBtn').addEventListener('click', showNewForm);
    $('ecSearch').addEventListener('input', e => {
      STATE.query = e.target.value;
      clearTimeout(window._ecSearchT);
      window._ecSearchT = setTimeout(loadList, 250);
    });
    renderHome();
    loadList();
  });
})();
