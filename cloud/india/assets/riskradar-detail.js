/* Risk Radar company page — charts only; all text is server-rendered for search engines. */
(function () {
  'use strict';
  const el = document.getElementById('bkd-data');
  const CAT_COL = { Liquidity: '#0ea5e9', Solvency: '#b91c1c', Profitability: '#f59e0b', 'Cash Flow': '#8b5cf6', 'Sales Trend': '#ea580c', 'Market Signal': '#e11d48', 'News & Governance': '#64748b' };
  document.querySelectorAll('.bkd-flag[data-cat]').forEach(f => {
    const col = CAT_COL[f.dataset.cat] || '#ea580c';
    f.style.borderLeftColor = col;
    const p = f.querySelector('.pts');
    if (p) p.style.background = col;
  });
  if (!el || typeof Chart === 'undefined') return;
  const D = JSON.parse(el.textContent);

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
  const chart = (id, cfg) => { const c = document.getElementById(id); if (c) new Chart(c, cfg); };
  const moneyAxis = { ticks: { callback: v => money(v) } };
  const s = D.series;
  const cats = Object.keys(D.cats);

  chart('bkdRadar', {
    type: 'radar',
    data: { labels: cats, datasets: [{ data: cats.map(x => D.cats[x]), backgroundColor: 'rgba(220,38,38,.18)', borderColor: '#dc2626', pointBackgroundColor: '#dc2626' }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, display: false } } } },
  });
  chart('bkdPrice', {
    type: 'line',
    data: { labels: s.px_d, datasets: [{ data: s.px_c, borderColor: '#1e293b', backgroundColor: 'rgba(220,38,38,.08)', fill: true, pointRadius: 0, tension: 0.2 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 6 } } } },
  });
  const bar = (label, data, col) => ({ label, data, backgroundColor: data.map(v => v != null && v < 0 ? '#dc2626' : col), borderRadius: 4 });
  chart('bkdPnl', { type: 'bar', data: { labels: s.periods, datasets: [bar('Revenue', s.revenue, '#94a3b8'), bar('Net income', s.net_income, '#16a34a')] }, options: { maintainAspectRatio: false, scales: { y: moneyAxis } } });
  chart('bkdCash', { type: 'bar', data: { labels: s.periods, datasets: [bar('Operating CF', s.ocf, '#0ea5e9'), bar('Free CF', s.fcf, '#6366f1')] }, options: { maintainAspectRatio: false, scales: { y: moneyAxis } } });
  chart('bkdBal', {
    type: 'line',
    data: { labels: s.periods, datasets: [
      { label: 'Total debt', data: s.debt, borderColor: '#dc2626', tension: 0.25, spanGaps: true },
      { label: 'Cash', data: s.cash, borderColor: '#16a34a', tension: 0.25, spanGaps: true },
      { label: 'Equity', data: s.equity, borderColor: '#6366f1', tension: 0.25, spanGaps: true }] },
    options: { maintainAspectRatio: false, scales: { y: moneyAxis } },
  });
})();
