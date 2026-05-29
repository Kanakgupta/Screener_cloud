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
    sort: 'recent',
    currentThread: null,
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
  function initials(name) {
    if (!name || name === 'Anonymous') return '?';
    return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0,2);
  }

  // ---------- API helpers ----------
  function apiGet(path){
    return fetch(`${API}/${path}`).then(r => {
      if (!r.ok) throw new Error(`Server error (${r.status})`);
      return r.json();
    }).catch(e => { console.error('apiGet', path, e); return {}; });
  }
  function apiPost(path, body){
    // Get Firebase ID token for server-side verification
    const tokenPromise = (window.HeraiAuth && window.HeraiAuth.getIdToken)
      ? window.HeraiAuth.getIdToken()
      : Promise.resolve(null);

    return tokenPromise.then(token => {
      const headers = {'Content-Type': 'application/json'};
      if (token) headers['Authorization'] = 'Bearer ' + token;
      return fetch(`${API}/${path}`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({region: REGION, ...body}),
      });
    }).then(r => {
      if (r.status === 401) {
        // Token expired or invalid — force re-auth
        if (window.HeraiAuth) window.HeraiAuth.logout();
        throw new Error('Session expired. Please sign in again.');
      }
      if (!r.ok) throw new Error(`Server error (${r.status})`);
      return r.json();
    }).catch(e => { console.error('apiPost', path, e); return {error: e.message}; });
  }

  // ---------- Summary ----------
  function loadSummary(){
    apiGet(`summary?region=${REGION}`).then(s => {
      const days = (s && s.days) || [];
      const html = days.slice(0,5).map(d => {
        const titles = (d.top_titles||[]).map(t =>
          `<a href="#${esc(t.id)}" data-thread="${esc(t.id)}">${esc(t.title)}</a>`
        ).join(' · ');
        return `<div class="ec-summary-day">
          <span class="ec-day-label">${esc(d.date)}</span>
          <span class="ec-day-meta">${d.threads} thread${d.threads===1?'':'s'} · ${d.replies} repl${d.replies===1?'y':'ies'}${d.suggestions?` · <strong>${d.suggestions} suggestion${d.suggestions===1?'':'s'}</strong>`:''}</span>
          ${titles ? `<div style="margin-top:4px;">${titles}</div>` : ''}
        </div>`;
      }).join('');
      $('ecSummary').innerHTML = `<h2>Activity Summary <span class="muted small" style="font-weight:400;color:#9ca3af;">(last ${s.retention_days||30} days)</span></h2>${html || '<p style="margin:6px 0 0;color:#9ca3af;font-size:13px;">No discussions yet — be the first to start one!</p>'}`;
      $('ecSummary').querySelectorAll('a[data-thread]').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); openThread(a.dataset.thread); });
      });
    });
  }

  // ---------- Categories ----------
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

  // ---------- Thread list ----------
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
      items.sort((a,b) => {
        const sa = a.category === 'Suggestion' ? 1 : 0;
        const sb = b.category === 'Suggestion' ? 1 : 0;
        if (sa !== sb) return sb - sa;
        return (b.updated||'').localeCompare(a.updated||'');
      });
    }
    if (!items.length) {
      $('ecList').innerHTML = `<div class="ec-empty">
        <div class="ec-empty-icon">💬</div>
        <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">No discussions yet</p>
        <a href="#" id="ecStartLink" style="font-size:14px;">Start the first discussion →</a>
      </div>`;
      const sl = $('ecStartLink');
      if (sl) sl.addEventListener('click', e => { e.preventDefault(); showNewForm(); });
      return;
    }
    $('ecList').innerHTML = items.map(t => `
      <div class="ec-thread-card ${t.category==='Suggestion'?'suggestion':''}" data-id="${esc(t.id)}">
        <div class="ec-thread-votes">
          <span class="ec-thread-vote-count">${t.votes||0}</span>
          <span class="ec-thread-vote-label">votes</span>
        </div>
        <div class="ec-thread-body">
          <div class="ec-thread-head">
            <h4 class="ec-thread-title">${esc(t.title)}</h4>
            <span class="ec-thread-cat ${catClass(t.category)}">${esc(t.category||'Discussion')}</span>
          </div>
          <p class="ec-thread-excerpt">${esc(t.excerpt)}</p>
          <div class="ec-thread-meta">
            ${t.category==='Suggestion'?'<span class="ec-pin">★ Suggestion</span><span class="ec-meta-dot">·</span>':''}
            <span>${esc(t.author||'Anonymous')}</span>
            <span class="ec-meta-dot">·</span>
            <span>${rel(t.created)}</span>
            <span class="ec-meta-dot">·</span>
            <span class="ec-meta-replies">💬 ${t.replies||0} repl${(t.replies||0)===1?'y':'ies'}</span>
          </div>
        </div>
      </div>
    `).join('');
    $('ecList').querySelectorAll('.ec-thread-card').forEach(c => {
      c.addEventListener('click', () => openThread(c.dataset.id));
    });
  }

  // ---------- Thread detail ----------
  function openThread(id){
    window.HeraiAuth.requireAuth().then(() => {
      apiGet(`thread?region=${REGION}&id=${encodeURIComponent(id)}`).then(d => {
        if (!d || !d.thread) return;
        STATE.currentThread = d.thread;
        renderDetail();
        window.scrollTo({top: 0, behavior: 'smooth'});
      });
    });
  }

  function renderDetail(){
    const t = STATE.currentThread;
    if (!t) return;
    const posts = (t.posts || []).slice().sort((a,b) => (a.created||'').localeCompare(b.created||''));
    const tagsHtml = (t.tags||[]).map(x => `<span class="ec-tag">${esc(x)}</span>`).join('');
    $('ecMid').innerHTML = `
      <button class="ec-detail-back" id="ecBack">← Back to discussions</button>
      <div class="ec-detail-header">
        <span class="ec-thread-cat ${catClass(t.category)}">${esc(t.category||'Discussion')}</span>
        <h2 class="ec-detail-title">${esc(t.title)}</h2>
        <div class="ec-detail-meta">
          <div class="ec-avatar">${initials(t.author)}</div>
          <strong>${esc(t.author||'Anonymous')}</strong>
          <span class="ec-meta-dot">·</span>
          <span>${fmtDate(t.created)}</span>
          <span class="ec-meta-dot">·</span>
          <span>${rel(t.created)}</span>
          ${tagsHtml ? '<span class="ec-meta-dot">·</span>' + tagsHtml : ''}
        </div>
        <div class="ec-detail-body">${esc(t.body)}</div>
        <div class="ec-detail-actions">
          <button class="ec-vote-btn upvote" data-dir="1">▲ Upvote <span id="ecThreadVotes">${t.votes||0}</span></button>
          <button class="ec-vote-btn downvote" data-dir="-1">▼ Downvote</button>
        </div>
      </div>

      <div class="ec-replies-section">
        <div class="ec-replies-head">${posts.length} ${posts.length===1?'Reply':'Replies'}</div>
        <div id="ecReplies">${posts.map(renderReply).join('')}</div>
      </div>

      <div class="ec-reply-form">
        <h3 class="ec-form-title">✍ Add your reply</h3>
        <textarea id="ecReplyBody" placeholder="Share your thoughts, evidence, or counter-arguments…"></textarea>
        <div class="ec-form-actions">
          <button class="ec-submit" id="ecReplySubmit">Post Reply</button>
        </div>
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
      <div class="ec-reply-meta">
        <div class="ec-avatar" style="width:26px;height:26px;font-size:11px;">${initials(p.author)}</div>
        <strong>${esc(p.author||'Anonymous')}</strong>
        <span class="ec-meta-dot">·</span>
        <span>${rel(p.created)}</span>
      </div>
      <div class="ec-reply-body">${esc(p.body)}</div>
      <div class="ec-reply-actions">
        <button class="ec-vote-btn upvote" data-id="${esc(p.id)}" data-dir="1">▲ <span class="ec-pv-${esc(p.id)}">${p.votes||0}</span></button>
        <button class="ec-vote-btn downvote" data-id="${esc(p.id)}" data-dir="-1">▼</button>
      </div>
    </div>`;
  }

  // ---------- Voting ----------
  function voteThread(dir){
    window.HeraiAuth.requireAuth().then(user => {
      const t = STATE.currentThread; if (!t) return;
      apiPost('vote', {id: t.id, dir: parseInt(dir,10), uid: user.uid}).then(r => {
        if (r && typeof r.votes === 'number') {
          t.votes = r.votes;
          const el = $('ecThreadVotes'); if (el) el.textContent = r.votes;
        }
      });
    });
  }
  function votePost(pid, dir){
    window.HeraiAuth.requireAuth().then(user => {
      const t = STATE.currentThread; if (!t) return;
      apiPost('vote', {id: t.id, postId: pid, dir: parseInt(dir,10), uid: user.uid}).then(r => {
        if (r && typeof r.votes === 'number') {
          document.querySelectorAll('.ec-pv-'+CSS.escape(pid)).forEach(el => el.textContent = r.votes);
        }
      });
    });
  }

  // ---------- Submit reply ----------
  function submitReply(){
    window.HeraiAuth.requireAuth().then(user => {
      _doSubmitReply(user);
    });
  }
  function _doSubmitReply(user){
    const t = STATE.currentThread; if (!t) return;
    const body = $('ecReplyBody').value.trim();
    const author = user.name || 'Anonymous';
    const err = $('ecReplyError');
    if (!body) { err.textContent = 'Please write a reply.'; err.hidden = false; return; }
    err.hidden = true;
    STATE.author = author;
    apiPost('post', {id: t.id, body, author, parent: null, uid: user.uid}).then(r => {
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
      <div class="ec-new-form">
        <h3 class="ec-form-title">✎ Start a new discussion</h3>
        <div class="ec-form-row">
          <select id="ecNewCat">
            ${STATE.categories.map(c => `<option value="${esc(c)}"${c==='Suggestion'?' selected':''}>${esc(c)}${c==='Suggestion'?' ★ (top priority)':''}</option>`).join('')}
          </select>
        </div>
        <input id="ecNewTitle" placeholder="Title — what's this about?">
        <input id="ecNewTags" placeholder="Tags (comma separated, optional)">
        <textarea id="ecNewBody" placeholder="Describe your idea, question, or discussion topic in detail. For suggestions, explain the problem and your proposed solution."></textarea>
        <div class="ec-form-actions">
          <button class="ec-submit" id="ecNewSubmit">Post Discussion</button>
          <button class="ec-cancel" id="ecNewCancel">Cancel</button>
        </div>
        <div class="ec-error" id="ecNewError" hidden></div>
        <p class="ec-form-hint">Discussions auto-purge after 30 days. Suggestions to improve the site are pinned to the top.</p>
      </div>
    `;
    $('ecBack').addEventListener('click', renderHome);
    $('ecNewCancel').addEventListener('click', renderHome);
    $('ecNewSubmit').addEventListener('click', submitNew);
  }

  function submitNew(){
    window.HeraiAuth.requireAuth().then(user => {
      _doSubmitNew(user);
    });
  }
  function _doSubmitNew(user){
    const title = $('ecNewTitle').value.trim();
    const body  = $('ecNewBody').value.trim();
    const author = user.name || 'Anonymous';
    const category = $('ecNewCat').value;
    const tags = $('ecNewTags').value.split(',').map(s => s.trim()).filter(Boolean);
    const err = $('ecNewError');
    if (!title || !body) { err.textContent = 'Title and body are required.'; err.hidden = false; return; }
    err.hidden = true;
    STATE.author = author;
    apiPost('thread', {title, body, author, category, tags, uid: user.uid}).then(r => {
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

  // ---------- Home view ----------
  function renderHome(){
    $('ecMid').innerHTML = `
      <div id="ecSummary" class="ec-summary"><span class="ec-loading">Loading summary…</span></div>
      <div class="ec-toolbar">
        <div class="ec-toolbar-left">
          <h2 class="ec-toolbar-title">Discussions</h2>
        </div>
        <div class="ec-toolbar-right">
          <div class="ec-select-wrap">
            <select id="ecSort">
              <option value="recent">Newest first</option>
              <option value="top">Top score</option>
            </select>
          </div>
          <label class="ec-check-label"><input type="checkbox" id="ecMeaningful" ${STATE.meaningful?'checked':''}> Meaningful only</label>
        </div>
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
    $('ecNewBtn').addEventListener('click', () => {
      window.HeraiAuth.requireAuth().then(() => showNewForm());
    });
    $('ecSearch').addEventListener('input', e => {
      STATE.query = e.target.value;
      clearTimeout(window._ecSearchT);
      window._ecSearchT = setTimeout(loadList, 250);
    });
    renderHome();
    loadList();
  });
})();
