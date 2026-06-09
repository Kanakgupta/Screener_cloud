// Click-to-sort for tables with class .sortable
// - Reads td[data-sort] when present (numeric), else parses cell text.
// - Skips the leading "#" / row-number column.
// - Re-binds when tables/rows are dynamically inserted (MutationObserver).
// - Safe to re-run; uses a flag to avoid double-binding.

(function () {
  function parseCell(td, isNum) {
    const ds = td.getAttribute('data-sort');
    if (ds !== null && ds !== '') {
      if (isNum) {
        const n = parseFloat(ds);
        return Number.isNaN(n) ? -Infinity : n;
      }
      return ds;
    }
    const txt = (td.innerText || td.textContent || '').trim();
    if (isNum) {
      // Strip currency / commas / %, normalise minus, keep digits/dot/exp.
      const cleaned = txt.replace(/\u2212/g, '-').replace(/[^0-9.\-eE]/g, '');
      const n = parseFloat(cleaned);
      return Number.isNaN(n) ? -Infinity : n;
    }
    return txt;
  }

  function bind(table) {
    if (!table || table.dataset.sortBound === '1') return;
    table.dataset.sortBound = '1';
    const thead = table.tHead;
    if (!thead) return;
    const headerRow = thead.rows[thead.rows.length - 1];
    if (!headerRow) return;
    const headers = Array.from(headerRow.cells);
    headers.forEach((th, idx) => {
      // Skip a leading row-number column ("#") which would never be useful to sort.
      const label = (th.textContent || '').trim();
      if (idx === 0 && (label === '#' || label === '' || /^row$/i.test(label))) {
        return;
      }
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const tbody = table.tBodies[0];
        if (!tbody) return;
        const rows = Array.from(tbody.rows);
        const isNum = th.classList.contains('num') || th.classList.contains('r');
        const asc = !th.classList.contains('sort-asc');
        headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(asc ? 'sort-asc' : 'sort-desc');
        rows.sort((a, b) => {
          const av = a.cells[idx] ? parseCell(a.cells[idx], isNum) : (isNum ? -Infinity : '');
          const bv = b.cells[idx] ? parseCell(b.cells[idx], isNum) : (isNum ? -Infinity : '');
          if (isNum) return asc ? av - bv : bv - av;
          return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });
        rows.forEach(r => tbody.appendChild(r));
        // Renumber leading "#" cells if the first column shows row numbers.
        let n = 1;
        rows.forEach(tr => {
          if (tr.classList.contains('u-hidden') || tr.classList.contains('f-hidden')) return;
          const c = tr.cells[0];
          if (c && /^\s*\d+\s*$/.test(c.textContent)) c.textContent = n++;
        });
      });
    });
  }

  function bindAll(root) {
    (root || document).querySelectorAll('table.sortable').forEach(bind);
  }

  function init() {
    bindAll(document);
    // Watch for tables/rows added later (e.g. dynamically rendered results).
    try {
      const mo = new MutationObserver(muts => {
        for (const m of muts) {
          if (!m.addedNodes) continue;
          m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            if (node.matches && node.matches('table.sortable')) bind(node);
            if (node.querySelectorAll) node.querySelectorAll('table.sortable').forEach(bind);
          });
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
