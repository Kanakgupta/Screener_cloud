// Generic numeric range filter for data tables.
// Auto-attaches a filter bar above any `table.sortable` whose header contains
// any of the supported columns: "Mkt Cap", "P/E", "ROCE %".
// Cooperates with the universe filter (NIFTY50/All) by using the `f-hidden`
// class. The universe filter uses `u-hidden`. Either class hides the row.
(function () {
  // Parse a displayed cell value into a raw number.
  // Handles INR formats: "₹1.23 L Cr", "₹450.20 Cr", "₹3.45 L", "₹12,345",
  //   plus legacy USD formats: "$1.23T", "$450.20B", "$3.45M", "$12,345",
  //   "12.34", "5.67%", "Δ 1.23", "+12.34%", "-", "—", "N/A", "".
  function parseCell(text) {
    if (text == null) return null;
    let s = String(text).trim();
    if (!s || s === '-' || s === '—' || s === 'N/A') return null;
    // INR multi-letter suffixes first
    const upper = s.toUpperCase();
    let inrMult = null;
    if (upper.endsWith('L CR')) { inrMult = 1e12; s = s.slice(0, -4); }
    else if (upper.endsWith('CR'))  { inrMult = 1e7;  s = s.slice(0, -2); }
    else if (upper.endsWith(' L'))  { inrMult = 1e5;  s = s.slice(0, -2); }
    s = s.replace(/[₹Δ$,\s]/g, '');
    if (s.endsWith('%')) s = s.slice(0, -1);
    let mult = inrMult || 1;
    if (!inrMult) {
      const last = s.slice(-1).toUpperCase();
      if (last === 'T') { mult = 1e12; s = s.slice(0, -1); }
      else if (last === 'B') { mult = 1e9; s = s.slice(0, -1); }
      else if (last === 'M') { mult = 1e6; s = s.slice(0, -1); }
      else if (last === 'K') { mult = 1e3; s = s.slice(0, -1); }
    }
    const n = parseFloat(s);
    return isFinite(n) ? n * mult : null;
  }

  // Parse user input. Accepts INR (10 Cr, 1.5 L Cr, 250 L) or legacy (10B, 1.5T, 250M).
  function parseInput(v) {
    if (v == null) return null;
    let s = String(v).trim();
    if (!s) return null;
    const upper = s.toUpperCase();
    let inrMult = null;
    if (upper.endsWith('L CR')) { inrMult = 1e12; s = s.slice(0, -4); }
    else if (upper.endsWith('CR'))  { inrMult = 1e7;  s = s.slice(0, -2); }
    else if (upper.endsWith(' L'))  { inrMult = 1e5;  s = s.slice(0, -2); }
    s = s.replace(/[₹$,\s]/g, '');
    if (s.endsWith('%')) s = s.slice(0, -1);
    let mult = inrMult || 1;
    if (!inrMult) {
      const last = s.slice(-1).toUpperCase();
      if (last === 'T') { mult = 1e12; s = s.slice(0, -1); }
      else if (last === 'B') { mult = 1e9; s = s.slice(0, -1); }
      else if (last === 'M') { mult = 1e6; s = s.slice(0, -1); }
      else if (last === 'K') { mult = 1e3; s = s.slice(0, -1); }
    }
    const n = parseFloat(s);
    return isFinite(n) ? n * mult : null;
  }

  // Header-text -> filter spec. The match function receives the header
  // text with sort arrows stripped and trimmed.
  const TARGETS = [
    { match: t => t === 'Mkt Cap',                 id: 'mcap', label: 'Mkt Cap',  hint: 'e.g. 5000 Cr' },
    { match: t => t === 'P/E',                     id: 'pe',   label: 'P/E',      hint: '' },
    { match: t => t === 'Fwd P/E',                 id: 'fpe',  label: 'Fwd P/E',  hint: '' },
    { match: t => t === 'ROCE %' || t === 'ROCE',  id: 'roce', label: 'ROCE %',   hint: '' }
  ];

  function buildFilterFor(table) {
    if (table.dataset.filterInit) return;
    if (table.dataset.noFilter) return;
    if (!table.tHead || !table.tHead.rows[0]) return;

    const headers = Array.from(table.tHead.rows[0].cells);
    const cols = [];
    headers.forEach((th, idx) => {
      const t = th.textContent.replace(/[▲▼]/g, '').trim();
      for (const spec of TARGETS) {
        if (spec.match(t)) { cols.push(Object.assign({}, spec, { idx })); break; }
      }
    });
    if (!cols.length) return;

    const tbody = table.tBodies[0];
    if (!tbody) return;
    table.dataset.filterInit = '1';

    // Cache parsed values on each row so re-filtering is cheap.
    function refreshCache() {
      Array.from(tbody.rows).forEach(r => {
        cols.forEach(c => {
          const cell = r.cells[c.idx];
          const v = parseCell(cell ? cell.textContent : '');
          r.dataset['flt_' + c.id] = (v == null) ? '' : String(v);
        });
      });
    }
    refreshCache();

    // Build UI. Place the bar before the .table-wrap if present; otherwise
    // before the table itself.
    const wrap = table.closest('.table-wrap') || table;
    const bar = document.createElement('div');
    bar.className = 'tbl-filter-bar';
    bar.innerHTML =
      '<div class="tbl-filter-title">Filter</div>' +
      cols.map(c =>
        '<div class="tbl-filter-field">' +
          '<label>' + c.label + '</label>' +
          '<div class="tbl-filter-inputs">' +
            '<input type="text" data-fid="' + c.id + '" data-bound="min" placeholder="min' + (c.hint ? ' (' + c.hint + ')' : '') + '" />' +
            '<input type="text" data-fid="' + c.id + '" data-bound="max" placeholder="max" />' +
          '</div>' +
        '</div>'
      ).join('') +
      '<button type="button" class="tbl-filter-clear">Clear</button>' +
      '<span class="tbl-filter-count muted small"></span>';
    wrap.parentNode.insertBefore(bar, wrap);

    function apply() {
      const bounds = {};
      cols.forEach(c => { bounds[c.id] = { min: null, max: null }; });
      let active = false;
      bar.querySelectorAll('input').forEach(inp => {
        const v = parseInput(inp.value);
        if (v != null) { bounds[inp.dataset.fid][inp.dataset.bound] = v; active = true; }
      });

      let visible = 0;
      Array.from(tbody.rows).forEach(r => {
        let pass = true;
        for (const c of cols) {
          const b = bounds[c.id];
          if (b.min == null && b.max == null) continue;
          const raw = r.dataset['flt_' + c.id];
          const v = (raw === '' || raw == null) ? null : parseFloat(raw);
          if (v == null) { pass = false; break; }
          if (b.min != null && v < b.min) { pass = false; break; }
          if (b.max != null && v > b.max) { pass = false; break; }
        }
        r.classList.toggle('f-hidden', !pass);
        if (pass && !r.classList.contains('u-hidden')) visible++;
      });
      bar.querySelector('.tbl-filter-count').textContent =
        active ? (visible + ' visible') : '';

      // Renumber the leading "#" column among visible rows.
      let n = 1;
      Array.from(tbody.rows).forEach(tr => {
        if (tr.classList.contains('f-hidden') || tr.classList.contains('u-hidden')) return;
        const c0 = tr.cells[0];
        if (c0 && /^\s*\d+\s*$/.test(c0.textContent)) c0.textContent = n++;
      });
    }

    bar.addEventListener('input', apply);
    bar.querySelector('.tbl-filter-clear').addEventListener('click', () => {
      bar.querySelectorAll('input').forEach(i => i.value = '');
      apply();
    });

    // Re-apply when the universe toggle changes (so the count stays accurate).
    document.addEventListener('universe-changed', apply);

    apply();
  }

  function init() {
    document.querySelectorAll('table.sortable').forEach(buildFilterFor);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
