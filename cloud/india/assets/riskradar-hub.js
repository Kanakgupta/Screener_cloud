/* Risk Radar hub — company financial-distress screener. */
(function () {
  'use strict';
  const D = JSON.parse(document.getElementById('bk-data').textContent);
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  const enc = encodeURIComponent;
  const hasChart = typeof Chart !== 'undefined';
  const charts = {};
  const pct = (x, d = 0) => x == null ? '—' : (x * 100).toFixed(d) + '%';
  const spct = (x, d = 1) => x == null ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
  const TIER_COL = { Severe: '#b91c1c', High: '#ea580c', Elevated: '#d97706' };
  const TIER_LBL = { Severe: 'Very weak', High: 'Weak', Elevated: 'Watch' };
  const scoreCol = s => s >= 70 ? TIER_COL.Severe : s >= 50 ? TIER_COL.High : TIER_COL.Elevated;

  function money(v) {
    if (v == null) return '—';
    const a = Math.abs(v);
    if (D.cur === '₹') {
      if (a >= 1e12) return '₹' + (v / 1e12).toFixed(2) + ' L Cr';
      if (a >= 1e7) return '₹' + Math.round(v / 1e7).toLocaleString('en-IN') + ' Cr';
      return '₹' + Math.round(v).toLocaleString('en-IN');
    }
    if (a >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  function mkChart(id, cfg) {
    if (!hasChart) return;
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (el) charts[id] = new Chart(el, cfg);
  }

  const st = { bucket: 'all', q: '', sort: { k: 'sc', dir: -1 }, tiers: new Set(['Severe', 'High', 'Elevated']), univ: readUniv() };
  function readUniv() {
    try {
      const v = localStorage.getItem('universe-' + D.region);
      if (v) return v.split(',').filter(Boolean);
    } catch (e) { /* storage blocked */ }
    return ['all'];
  }
  const showAllUniv = () => !st.univ.length || st.univ.includes('all') || (st.univ.length === 1 && st.univ[0] === D.default_univ);
  const inUniv = r => showAllUniv() || (r.idx || []).some(x => st.univ.includes(x));
  const inBucket = (r, b) => b === 'all' || (b === 'ai' ? r.ai || r.b === 'ai' : r.b === b);
  function analyzedCount(b) {
    const keys = showAllUniv() ? ['all'] : st.univ;
    const sum = bb => Math.max(0, ...keys.map(k => (D.analyzed[bb] || {})[k] || 0));
    if (b === 'all') return D.buckets.filter(x => x.id !== 'ai').reduce((s, x) => s + sum(x.id), 0);
    return sum(b);
  }

  function renderSectors() {
    const base = D.rows.filter(inUniv);
    const items = [{ id: 'all', label: 'All sectors', icon: '🌐' }].concat(D.buckets);
    $('#bkSectors').innerHTML = items.map(b => {
      const n = base.filter(r => inBucket(r, b.id)).length;
      const a = analyzedCount(b.id);
      const share = a ? n / a : 0;
      const cls = share > 0.35 ? 'hot' : share > 0.15 ? 'warm' : '';
      return `<li data-b="${esc(b.id)}" class="${b.id === st.bucket ? 'active' : ''}" title="${n} of ${a} analysed companies flagged">
        <span class="ic">${esc(b.icon)}</span><span>${esc(b.label)}</span><span class="cnt ${cls}">${n}</span>
        <span class="bar"><i style="width:${Math.min(100, share * 100).toFixed(1)}%"></i></span>
        <span class="sub">${a ? pct(share) + ' of ' + a.toLocaleString() + ' analysed' : (b.id === 'shell-spac' ? 'Trust vehicles — not assessed' : 'No analysable companies')}</span></li>`;
    }).join('');
  }

  function filteredRows() {
    const q = st.q.toLowerCase();
    const rows = D.rows.filter(r => inUniv(r) && inBucket(r, st.bucket) && st.tiers.has(r.tier)
      && (!q || r.t.toLowerCase().includes(q) || r.n.toLowerCase().includes(q) || (r.ind || '').toLowerCase().includes(q)));
    const { k, dir } = st.sort;
    if (k !== 'i') rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
    return rows;
  }

  function renderCompany() {
    renderSectors();
    const meta = st.bucket === 'all' ? { label: 'All sectors', icon: '🌐' } : D.buckets.find(b => b.id === st.bucket) || {};
    const all = D.rows.filter(r => inUniv(r) && inBucket(r, st.bucket));
    const a = analyzedCount(st.bucket);
    $('#bkSecTitle').textContent = `${meta.icon || ''} ${meta.label || ''}`;
    $('#bkSecSub').textContent = D.sector_blurbs[st.bucket] || D.sector_blurbs._default;
    const cnt = t => all.filter(r => r.tier === t).length;
    $('#bkSecKpis').innerHTML = [
      [a.toLocaleString(), 'Analysed'], [all.length.toLocaleString(), 'Flagged'],
      [cnt('Severe'), TIER_LBL.Severe], [cnt('High'), TIER_LBL.High], [cnt('Elevated'), TIER_LBL.Elevated],
      [a ? pct(all.length / a) : '—', 'Flag rate'],
    ].map(([v, l]) => `<div class="k"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');

    mkChart('bkTierChart', {
      type: 'doughnut',
      data: { labels: [TIER_LBL.Severe, TIER_LBL.High, TIER_LBL.Elevated], datasets: [{ data: [cnt('Severe'), cnt('High'), cnt('Elevated')], backgroundColor: [TIER_COL.Severe, TIER_COL.High, TIER_COL.Elevated], borderWidth: 0 }] },
      options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom' } } },
    });
    const cats = D.categories;
    const avg = cats.map(c => all.length ? all.reduce((s, r) => s + (r.cats[c] || 0), 0) / all.length : 0);
    mkChart('bkCatChart', {
      type: 'bar',
      data: { labels: cats, datasets: [{ data: avg, backgroundColor: avg.map(v => v > 50 ? '#dc2626' : v > 25 ? '#f59e0b' : '#94a3b8'), borderRadius: 6 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw.toFixed(0) + '% of max stress' } } }, scales: { x: { max: 100, ticks: { callback: v => v + '%' } } } },
    });
    const freq = {};
    all.forEach(r => r.why.forEach(w => { freq[w] = (freq[w] || 0) + 1; }));
    const top = Object.entries(freq).sort((x, y) => y[1] - x[1]).slice(0, 7);
    mkChart('bkFlagChart', {
      type: 'bar',
      data: { labels: top.map(x => x[0].length > 34 ? x[0].slice(0, 33) + '…' : x[0]), datasets: [{ data: top.map(x => x[1]), backgroundColor: '#6366f1', borderRadius: 6 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { font: { size: 10.5 } } } } },
    });
    renderTable();
  }

  function renderTable() {
    const rows = filteredRows();
    const tb = $('#bkTable tbody');
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="11" class="bk-empty">No companies in this sector currently meet the distress threshold${st.q ? ' for this filter' : ''}. ✅</td></tr>`;
      return;
    }
    tb.innerHTML = rows.map((r, i) => {
      const href = 'stocks/' + enc(r.t) + '.html';
      const det = 'risk-radar/' + enc(r.t) + '.html';
      return `<tr>
        <td>${i + 1}</td>
        <td><a class="tk" href="${href}">${esc(r.t.replace(/\.NS$/, ''))}</a></td>
        <td><a class="nm" href="${href}">${esc(r.n)}</a><div class="ind">${esc(r.ind)}</div></td>
        <td><div class="bk-scorebar"><span class="t"><i style="width:${r.sc}%;background:${scoreCol(r.sc)}"></i></span><b>${r.sc}</b></div></td>
        <td><span class="bk-tier ${esc(r.tier)}">${esc(TIER_LBL[r.tier] || r.tier)}</span></td>
        <td class="num">${r.po == null ? '—' : pct(r.po)}</td>
        <td class="num">${r.pm == null ? '—' : pct(r.pm, r.pm < 0.1 ? 1 : 0)}</td>
        <td class="num ${r.dd != null && r.dd < -0.5 ? 'neg' : ''}">${r.dd == null ? '—' : spct(r.dd, 0)}</td>
        <td class="num">${money(r.mc)}</td>
        <td><div class="bk-why">${r.why.map(w => `<span>${esc(w)}</span>`).join('')}</div></td>
        <td><a class="bk-btn" href="${det}">Details →</a></td></tr>`;
    }).join('');
  }

  $('#bkSectors').addEventListener('click', e => {
    const li = e.target.closest('li[data-b]');
    if (li) { st.bucket = li.dataset.b; setHash(); renderCompany(); }
  });
  $('#bkSearch').addEventListener('input', e => { st.q = e.target.value.trim(); renderTable(); });
  $$('.bk-chip').forEach(b => b.addEventListener('click', () => {
    b.classList.toggle('on');
    b.classList.contains('on') ? st.tiers.add(b.dataset.tier) : st.tiers.delete(b.dataset.tier);
    renderTable();
  }));
  $$('#bkTable th[data-k]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k;
    st.sort = { k, dir: st.sort.k === k ? -st.sort.dir : (['t', 'n', 'tier'].includes(k) ? 1 : -1) };
    renderTable();
  }));
  document.addEventListener('universe-changed', e => {
    st.univ = (e.detail && e.detail.length) ? e.detail : ['all'];
    renderCompany();
  });

  function setHash() {
    const h = '#company/' + st.bucket;
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  function route() {
    const parts = decodeURIComponent(location.hash.slice(1)).split('/');
    // Old links (#realestate/...) now live on the RealEstate page.
    if (parts[0] === 'realestate') { location.replace('realestate.html#' + parts.slice(1).join('/')); return; }
    const b = parts[0] === 'company' ? parts[1] : null;
    if (b && (b === 'all' || D.buckets.some(x => x.id === b))) st.bucket = b;
    renderCompany();
  }
  window.addEventListener('hashchange', route);
  route();
})();
