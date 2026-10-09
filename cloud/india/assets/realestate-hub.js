/* RealEstate hub — housing heat map, drill-down and buy-timing analysis (USA + India). */
(function () {
  'use strict';
  const CFG = JSON.parse(document.getElementById('re-data').textContent);
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  const enc = encodeURIComponent;
  const charts = {};
  const spct = (x, d = 1) => x == null ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtYM = s => { if (!s) return '—'; const [y, m] = s.split('-'); return MONTHS[+m - 1] + ' ' + y; };

  function money(v, cur) {
    if (v == null) return '—';
    const a = Math.abs(v);
    if (cur === '₹') return '₹' + Math.round(v).toLocaleString('en-IN');
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + Math.round(v / 1e3).toLocaleString('en-US') + 'K';
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  function mkChart(id, cfg) {
    if (typeof Chart === 'undefined') return;
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (el) charts[id] = new Chart(el, cfg);
  }

  const RE = { country: null, idx: {}, series: {}, map: null, tiles: null, geoLayer: null, outline: null, capLayer: null,
               ptLayer: null, metric: 'bs', sel: null, usTopo: null, inStates: null, inOutline: null, tiers: new Set([1, 2, 3]) };
  const METRICS = {
    bs: { lbl: 'Buy-timing score', dom: [20, 80], stops: ['#b91c1c', '#f59e0b', '#facc15', '#22c55e', '#15803d'], fmt: v => v == null ? '—' : Math.round(v) + '/100', ends: ['Wait / stretched', 'Attractive now'] },
    yoy: { lbl: '1-year price change', dom: [-0.08, 0.12], stops: ['#1d4ed8', '#93c5fd', '#f8fafc', '#fca5a5', '#b91c1c'], fmt: v => spct(v), ends: ['Falling', 'Rising fast'] },
    c5: { lbl: '5-year growth (CAGR)', dom: [0, 0.12], stops: ['#fef9c3', '#fdba74', '#f97316', '#c2410c', '#7c2d12'], fmt: v => spct(v), ends: ['Flat', 'Strong'] },
    dev: { lbl: 'Valuation vs long-run trend', dom: [-0.2, 0.2], stops: ['#15803d', '#86efac', '#f8fafc', '#fca5a5', '#b91c1c'], fmt: v => spct(v), ends: ['Below trend (cheap)', 'Above trend (stretched)'] },
    e12: { lbl: '12-month outlook', dom: [-0.05, 0.08], stops: ['#1d4ed8', '#93c5fd', '#f8fafc', '#fca5a5', '#b91c1c'], fmt: v => spct(v), ends: ['Expected to fall', 'Expected to rise'] },
    v: { lbl: 'Price level', dom: null, stops: ['#ede9fe', '#c4b5fd', '#8b5cf6', '#6d28d9', '#3b0764'], log: true, fmt: v => v == null ? '—' : money(v, RE.idx[RE.country] && RE.idx[RE.country].currency), ends: ['Lower', 'Higher'] },
  };
  const SIG_COL = { BUY: '#16a34a', ACCUMULATE: '#0284c7', WAIT: '#d97706', HOT: '#e11d48', CAUTION: '#b91c1c' };
  const TIER_LBL = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };

  function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
    const a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
    return 'rgb(' + a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',') + ')';
  }
  function colorFor(n) {
    const m = METRICS[RE.metric];
    let v = n[RE.metric];
    if (v == null) return '#cbd5e1';
    let [lo, hi] = m.dom || RE.vdom;
    if (m.log) { v = Math.log(Math.max(1, v)); lo = Math.log(lo); hi = Math.log(hi); }
    return ramp(m.stops, (v - lo) / (hi - lo));
  }
  function renderLegend() {
    const m = METRICS[RE.metric];
    const dom = m.dom || RE.vdom || [0, 1];
    const india = RE.country === 'india';
    $('#reLegend').innerHTML = `<div><strong>${esc(m.lbl)}</strong></div>
      <div class="ramp" style="background:linear-gradient(90deg,${m.stops.join(',')})"></div>
      <div class="ends"><span>${esc(m.fmt(dom[0]))}<br><small>${esc(m.ends[0])}</small></span><span style="text-align:right">${esc(m.fmt(dom[1]))}<br><small>${esc(m.ends[1])}</small></span></div>
      <div style="margin-top:8px">Signals: ${Object.keys(SIG_COL).map(s => `<span class="bk-pill" style="background:${SIG_COL[s]}">${s}</span>`).join(' ')}</div>
      ${india ? `<div class="re-key"><span><i class="cap">★</i> State / UT capital</span><span><i class="dot t1"></i> Tier 1</span><span><i class="dot t2"></i> Tier 2</span><span><i class="dot t3"></i> Tier 3</span><span><i class="dot ring"></i> State trend (no city index)</span><span><i class="dot na"></i> No official index</span></div>` : ''}`;
  }

  async function loadIndex(c) {
    if (RE.idx[c]) return RE.idx[c];
    const r = await fetch('/' + c + '/realestate/index.json');
    if (!r.ok) throw new Error('Real-estate data not built yet for ' + c);
    const d = await r.json();
    d.by = {};
    d.nodes.forEach(n => { d.by[n.id] = n; });
    d.byStateName = {};
    d.nodes.forEach(n => { if (n.lv === 'state') d.byStateName[n.nm] = n; });
    RE.idx[c] = d;
    return d;
  }
  async function loadSeries(c, key) {
    const k = c + ':' + key;
    if (!RE.series[k]) {
      const r = await fetch('/' + c + '/realestate/series/' + enc(key) + '.json');
      if (!r.ok) throw new Error('Series unavailable');
      RE.series[k] = (await r.json()).s;
    }
    return RE.series[k];
  }
  const nodesAt = (d, lv, parent) => d.nodes.filter(n => n.lv === lv && (parent == null || n.p === parent));
  const byName = (a, b) => a.nm.localeCompare(b.nm);
  function stateOf(n) {
    const by = RE.idx[RE.country].by;
    if (!n) return null;
    if (n.lv === 'state') return n;
    if (n.lv === 'city') return by[n.p] || null;
    if (n.lv === 'locality') return stateOf(by[n.p]);
    return null;
  }
  const cityOf = n => !n ? null : n.lv === 'city' ? n : n.lv === 'locality' ? RE.idx[RE.country].by[n.p] : null;
  const placeLabel = n => {
    if (n.lv === 'state') return n.nm;
    if (n.lv === 'city') return n.nm + ', ' + (RE.country === 'usa' ? n.p : stateOf(n).nm);
    return n.nm + ' — ' + cityOf(n).nm + ', ' + stateOf(n).nm;
  };

  function initMap() {
    if (RE.map || typeof L === 'undefined') return;
    RE.map = L.map('reMap', { preferCanvas: true, zoomControl: true, worldCopyJump: false, minZoom: 3, zoomSnap: 0.25 });
    RE.ptLayer = L.layerGroup().addTo(RE.map);
    RE.capLayer = L.layerGroup().addTo(RE.map);
    RE.map.on('zoomend', drawPoints);
  }

  // USA uses OpenStreetMap tiles; India uses only the official Survey of India
  // boundary layers (no international basemap, whose borders differ).
  function setBasemap(country) {
    if (RE.tiles) { RE.tiles.remove(); RE.tiles = null; }
    $('#reMap').classList.toggle('re-official', country === 'india');
    if (country === 'usa') {
      RE.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18, className: 'bk-tiles',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors',
      }).addTo(RE.map);
      RE.tiles.bringToBack();
    }
  }

  async function setCountry(c, selectId) {
    $$('.bk-countries button').forEach(b => b.classList.toggle('active', b.dataset.country === c));
    RE.country = c;
    RE.sel = null;
    let d;
    try { d = await loadIndex(c); } catch (e) {
      $('#reAnalysis').innerHTML = `<div class="bk-empty">${esc(e.message)}. Run <code>python cli.py realestate --region ${esc(c)}</code>.</div>`;
      return;
    }
    const vals = d.nodes.filter(n => n.lv !== 'state' && n.v).map(n => n.v).sort((a, b) => a - b);
    RE.vdom = vals.length ? [vals[Math.floor(vals.length * 0.05)], vals[Math.floor(vals.length * 0.95)]] : [1, 2];
    $('#reLocWrap').hidden = !d.levels.includes('locality');
    $('#reTierWrap').hidden = c !== 'india';
    $('#reSource').innerHTML = `Source: <a href="${esc(d.source.url)}" target="_blank" rel="noopener nofollow">${esc(d.source.name)}</a> · data to ${esc(fmtYM(d.as_of))} (${esc(d.freq)}) · ${esc(d.unit)}`
      + (c === 'india' ? ' · Map: official boundary of India as per Survey of India (via DataMeet); cities: GeoNames.' : '');
    fillStates();
    fillSearch();
    renderLegend();
    if (RE.map) {
      RE.map.invalidateSize();
      setBasemap(c);
      RE.map.setView(d.map.center, d.map.zoom);
      await drawGeo();
      homeView();
      drawCapitals();
      drawPoints();
    }
    if (selectId && d.by[selectId]) selectNode(selectId, !!RE.map);
    else renderOverview();
  }

  function fillStates() {
    const d = RE.idx[RE.country];
    $('#reState').innerHTML = '<option value="">— All states —</option>' + nodesAt(d, 'state').sort(byName)
      .map(n => `<option value="${esc(n.id)}">${esc(n.nm)}${n.nodata ? ' (no official index)' : ''}</option>`).join('');
    fillCities('');
  }
  function fillCities(stateId) {
    const d = RE.idx[RE.country];
    const list = stateId ? nodesAt(d, 'city', stateId).sort((a, b) => (a.tier || 9) - (b.tier || 9) || byName(a, b)) : [];
    $('#reCity').innerHTML = `<option value="">${stateId ? '— Choose city —' : '— Pick a state first —'}</option>` +
      list.map(n => `<option value="${esc(n.id)}">${esc(n.nm)}${n.tier ? ' · ' + TIER_LBL[n.tier] : ''}${n.proxy === 'state' ? ' (state trend)' : n.proxy === 'none' ? ' (no index)' : ''}</option>`).join('');
    fillLocs('');
  }
  function fillLocs(cityId) {
    const d = RE.idx[RE.country];
    const list = cityId ? nodesAt(d, 'locality', cityId).sort(byName) : [];
    $('#reLoc').innerHTML = `<option value="">${cityId ? (list.length ? '— Choose locality —' : '— No localities mapped —') : '— Pick a city first —'}</option>` +
      list.map(n => `<option value="${esc(n.id)}">${esc(n.nm)}</option>`).join('');
  }
  function fillSearch() {
    const d = RE.idx[RE.country];
    RE.searchMap = {};
    $('#reSearchList').innerHTML = d.nodes.map(n => {
      const lab = placeLabel(n);
      RE.searchMap[lab.toLowerCase()] = n.id;
      return `<option value="${esc(lab)}"></option>`;
    }).join('');
  }

  function stateNodeForFeature(f) {
    const d = RE.idx[RE.country];
    return RE.country === 'usa' ? d.by[d.fips[f.id]] : d.byStateName[f.properties.name];
  }
  async function drawGeo() {
    if (RE.geoLayer) { RE.geoLayer.remove(); RE.geoLayer = null; }
    if (RE.outline) { RE.outline.remove(); RE.outline = null; }
    let geo;
    try {
      if (RE.country === 'usa') {
        if (typeof topojson === 'undefined') return;
        if (!RE.usTopo) RE.usTopo = await (await fetch('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json')).json();
        geo = topojson.feature(RE.usTopo, RE.usTopo.objects.states);
      } else {
        if (!RE.inStates) RE.inStates = await (await fetch(CFG.assets + 'india-states.geojson')).json();
        if (!RE.inOutline) RE.inOutline = await (await fetch(CFG.assets + 'india-outline.geojson')).json();
        geo = RE.inStates;
      }
    } catch (e) { return; }
    RE.geoLayer = L.geoJSON(geo, {
      style: f => {
        const n = stateNodeForFeature(f);
        const has = n && !n.nodata;
        return { color: RE.country === 'india' ? '#64748b' : '#ffffff', weight: 1, fillOpacity: has ? 0.72 : (RE.country === 'india' ? 0.5 : 0.15), fillColor: has ? colorFor(n) : (RE.country === 'india' ? '#e2e8f0' : '#cbd5e1') };
      },
      onEachFeature: (f, layer) => {
        const n = stateNodeForFeature(f);
        if (!n) return;
        layer.bindTooltip(tipHtml(n), { sticky: true });
        layer.on('click', () => selectNode(n.id));
        layer.on('mouseover', () => layer.setStyle({ weight: 2.5, color: '#111827' }));
        layer.on('mouseout', () => layer.setStyle({ weight: 1, color: RE.country === 'india' ? '#64748b' : '#ffffff' }));
      },
    }).addTo(RE.map);
    if (RE.country === 'india' && RE.inOutline) {
      RE.outline = L.geoJSON(RE.inOutline, { interactive: false, style: { color: '#0f172a', weight: 1.8, fill: false } }).addTo(RE.map);
    }
    RE.geoLayer.bringToBack();
  }
  function restyleGeo() {
    if (!RE.geoLayer) return;
    RE.geoLayer.eachLayer(l => {
      const n = stateNodeForFeature(l.feature);
      if (n && !n.nodata) { l.setStyle({ fillColor: colorFor(n) }); l.setTooltipContent(tipHtml(n)); }
    });
  }
  function tipHtml(n) {
    const m = METRICS[RE.metric];
    if (n.nodata) return `<strong>${esc(n.nm)}</strong><br>No official housing price index published (NHB RESIDEX)`;
    const note = n.proxy === true ? ' <em>(city index)</em>' : n.proxy === 'state' ? ' <em>(state trend)</em>' : n.proxy === 'none' ? ' <em>(no official index)</em>' : '';
    const tier = n.tier ? ` · ${TIER_LBL[n.tier]}` : '';
    if (n.proxy === 'none') return `<strong>${esc(n.nm)}</strong>${tier}${note}`;
    return `<strong>${esc(n.nm)}</strong>${tier}${note}<br>${esc(m.lbl)}: <b>${esc(m.fmt(n[RE.metric]))}</b><br>` +
      `Signal: <b style="color:${SIG_COL[n.sig] || '#334155'}">${esc(n.sig || '—')}</b>` + (n.v ? ` · ${esc(money(n.v, RE.idx[RE.country].currency))}` : '');
  }

  function drawCapitals() {
    RE.capLayer.clearLayers();
    const d = RE.idx[RE.country];
    if (RE.country !== 'india' || !d.capitals) return;
    d.capitals.forEach(c => {
      const icon = L.divIcon({ className: 're-cap' + (c.national ? ' national' : ''), html: '★', iconSize: [16, 16], iconAnchor: [8, 8] });
      L.marker([c.lat, c.lon], { icon, keyboard: false, zIndexOffset: 1000 })
        .bindTooltip(`<strong>${esc(c.name)}</strong><br>${c.national ? 'National capital' : 'Capital of ' + esc(c.state)}`, { direction: 'top' })
        .addTo(RE.capLayer);
    });
    syncCapitalLabels();
  }
  function syncCapitalLabels() {
    if (RE.map) $('#reMap').classList.toggle('re-caps-big', RE.map.getZoom() >= 6);
  }

  function drawPoints() {
    if (!RE.map || !RE.idx[RE.country]) return;
    const d = RE.idx[RE.country];
    const z = RE.map.getZoom();
    const sel = RE.sel ? d.by[RE.sel] : null;
    const selState = stateOf(sel), selCity = cityOf(sel);
    RE.ptLayer.clearLayers();
    syncCapitalLabels();
    if (RE.geoLayer) {
      const op = RE.country === 'india' ? (z >= 8 ? 0.35 : 0.72) : (z >= 8 ? 0.08 : z >= 6 ? 0.3 : 0.72);
      RE.geoLayer.eachLayer(l => { const n = stateNodeForFeature(l.feature); l.setStyle({ fillOpacity: n && !n.nodata ? op : (RE.country === 'india' ? 0.5 : 0.1) }); });
    }
    let pts = [];
    if (RE.country === 'usa') {
      if (z >= 6) pts = nodesAt(d, 'city');
      else if (selState) pts = nodesAt(d, 'city', selState.id);
      $('#reHint').textContent = z >= 6 || selState ? 'Click a city for its price trend and best-buy timing' : 'Zoom in or click a state to reveal cities';
    } else {
      const cities = nodesAt(d, 'city').filter(c => RE.tiers.has(c.tier || 3));
      pts = cities.filter(c => (c.tier || 3) === 1 || z >= 6 || (c.tier === 2 && z >= 5) || (selState && c.p === selState.id));
      if (selCity) pts = pts.concat(nodesAt(d, 'locality', selCity.id));
      else if (z >= 10) pts = pts.concat(nodesAt(d, 'locality'));
      $('#reHint').textContent = z < 6 ? 'Zoom in for Tier 2 / Tier 3 cities · ★ = state capital' : 'Click a city, then a locality (e.g. Whitefield in Bengaluru)';
    }
    pts.forEach(n => {
      const india = RE.country === 'india';
      const r = n.lv === 'locality' ? 7 : india ? ({ 1: 9, 2: 6.5, 3: 4.5 }[n.tier || 3]) : (z >= 9 ? 8 : 5);
      const isSel = sel && sel.id === n.id;
      const proxyRing = n.proxy === 'state';
      const mk = L.circleMarker([n.lat, n.lon], {
        radius: isSel ? r + 4 : r, weight: isSel ? 3 : (n.lv === 'locality' || proxyRing ? 2 : 1),
        color: isSel ? '#111827' : n.lv === 'locality' ? '#312e81' : proxyRing ? '#475569' : '#ffffff',
        dashArray: proxyRing ? '2 2' : null,
        fillColor: n.proxy === 'none' ? '#ffffff' : colorFor(n), fillOpacity: n.proxy === 'none' ? 0.7 : 0.92,
      });
      mk.bindTooltip(tipHtml(n), { direction: 'top' });
      mk.on('click', () => selectNode(n.id));
      mk.addTo(RE.ptLayer);
    });
  }

  function syncSelects(n) {
    const s = stateOf(n), c = cityOf(n);
    $('#reState').value = s ? s.id : '';
    fillCities(s ? s.id : '');
    $('#reCity').value = c ? c.id : '';
    fillLocs(c ? c.id : '');
    $('#reLoc').value = n && n.lv === 'locality' ? n.id : '';
  }

  function zoomTo(n) {
    if (!RE.map) return;
    const d = RE.idx[RE.country];
    if (n.lv === 'state') {
      if (RE.geoLayer) {
        let b = null;
        RE.geoLayer.eachLayer(l => { const sn = stateNodeForFeature(l.feature); if (sn && sn.id === n.id) b = l.getBounds(); });
        if (b) { RE.map.fitBounds(b, { padding: [20, 20] }); return; }
      }
      const kids = nodesAt(d, 'city', n.id);
      if (kids.length) RE.map.fitBounds(L.latLngBounds(kids.map(k => [k.lat, k.lon])).pad(0.3), { maxZoom: 8 });
    } else {
      RE.map.setView([n.lat, n.lon], n.lv === 'locality' ? 12 : (RE.country === 'india' ? 10 : 10));
    }
  }

  function selectNode(id, zoom = true) {
    const d = RE.idx[RE.country];
    const n = d.by[id];
    if (!n) return;
    RE.sel = id;
    syncSelects(n);
    if (zoom) zoomTo(n);
    drawPoints();
    setHash();
    renderNode(n);
  }

  // ------------------------------------------------------------ analysis
  function sigSentence(n) {
    const soft = n.soft ? ` Seasonally, prices tend to be softest around <b>${esc(fmtYM(n.soft))}</b>.` : '';
    switch (n.sig) {
      case 'BUY': return `Prices are projected to rise about <b>${esc(spct(n.e12))}</b> over the next 12 months and are not stretched versus their long-run trend — waiting is likely to cost more.${soft}`;
      case 'WAIT': return `The model projects prices about <b>${esc(spct(n.best && n.best.p))}</b> lower around <b>${esc(fmtYM(n.best && n.best.d))}</b>. Patience is likely to be rewarded; use the time to negotiate and line up financing.`;
      case 'HOT': return `Prices are running <b>${esc(spct(n.dev))}</b> above their long-run pace and still accelerating. Buy only with a long horizon and negotiate hard — momentum markets can reverse quickly.`;
      case 'CAUTION': return `Prices are stretched (<b>${esc(spct(n.dev))}</b> vs trend) and momentum has turned negative — elevated correction risk. Wait for confirmation of a bottom.`;
      default: return `Near fair value with a modest expected change (<b>${esc(spct(n.e12))}</b> over 12 months). Accumulate opportunistically and negotiate on price.${soft}`;
    }
  }
  function bestWindow(n) {
    if (n.best) return { v: fmtYM(n.best.d), s: spct(n.best.p) + ' vs today' };
    if (n.sig === 'BUY' || n.sig === 'HOT') return { v: 'Now', s: 'prices projected to rise' };
    return n.soft ? { v: fmtYM(n.soft), s: 'seasonal soft spot' } : { v: 'Now', s: 'no deeper dip projected' };
  }
  function crumbs(n) {
    const d = RE.idx[RE.country];
    const parts = [`<a data-go="">${esc(d.flag)} ${esc(d.label)}</a>`];
    const s = stateOf(n), c = cityOf(n);
    if (s) parts.push(`<a data-go="${esc(s.id)}">${esc(s.nm)}</a>`);
    if (c) parts.push(`<a data-go="${esc(c.id)}">${esc(c.nm)}</a>`);
    if (n.lv === 'locality') parts.push(`<b>${esc(n.nm)}</b>`);
    return `<div class="bk-crumb">${parts.join(' › ')}</div>`;
  }
  function kpis(n, cur) {
    const india = RE.country === 'india';
    const items = [
      [n.v ? money(n.v, cur) : (n.proxy ? 'Not published' : '—'), india ? 'Price (₹ / sq ft carpet)' : 'Typical home value'],
      [spct(n.yoy), '1-year change'],
      [spct(n.c5), india ? '5-yr CAGR (UC index)' : '5-year CAGR'],
      [spct(n.dd), 'From peak'],
      [spct(n.dev), india ? 'YoY vs long-run pace' : 'vs long-run trend'],
      [spct(n.e12), '12-month outlook'],
    ];
    if (n.pop) items.push([n.pop.toLocaleString('en-IN'), 'Population']);
    return `<div class="bk-kpis">${items.map(([v, l]) => `<div class="k"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`;
  }
  function topLists(cands) {
    const live = cands.filter(c => c.sig);
    const best = live.slice().sort((a, b) => (b.bs || 0) - (a.bs || 0)).slice(0, 8);
    const hot = live.slice().sort((a, b) => (b.yoy || -9) - (a.yoy || -9)).slice(0, 8);
    const li = (n, v) => `<li data-go="${esc(n.id)}"><span>${esc(placeLabel(n))}${n.proxy === 'state' ? ' <small>(state trend)</small>' : ''}</span><span><span class="bk-pill" style="background:${SIG_COL[n.sig]}">${esc(n.sig)}</span> ${esc(v)}</span></li>`;
    return `<div class="bk-grid2" style="margin-top:14px">
      <div><h3>🟢 Best buy-timing</h3><ul class="bk-list">${best.map(n => li(n, (n.bs ?? '—') + '/100')).join('')}</ul></div>
      <div><h3>🔥 Fastest-rising prices</h3><ul class="bk-list">${hot.map(n => li(n, spct(n.yoy))).join('')}</ul></div></div>`;
  }

  function renderOverview() {
    const d = RE.idx[RE.country];
    const all = nodesAt(d, 'city');
    const official = all.filter(c => !c.proxy);
    const sigs = {};
    official.forEach(c => { if (c.sig) sigs[c.sig] = (sigs[c.sig] || 0) + 1; });
    const india = RE.country === 'india';
    const tc = t => all.filter(c => c.tier === t).length;
    $('#reAnalysis').innerHTML = `${crumbs({ lv: 'country' })}<h2>${esc(d.flag)} ${esc(d.label)} housing — ${all.length.toLocaleString()} cities</h2>
      <p class="bk-sub">${india ? `${official.length} cities with an official NHB RESIDEX index · ${tc(1)} Tier 1, ${tc(2)} Tier 2, ${tc(3)} Tier 3 cities on the map · ★ marks every state / UT capital. ` : ''}Colour shows <b>${esc(METRICS[RE.metric].lbl)}</b>. Click a ${india ? 'state or city, then a locality (e.g. Whitefield, Bengaluru)' : 'state, then a city (e.g. Fremont, CA)'} for its price trend, forecast and best-buy window.</p>
      <div class="bk-grid2"><div class="bk-chartbox"><canvas id="reSigChart"></canvas></div><div class="bk-chartbox"><canvas id="reYoyChart"></canvas></div></div>
      ${topLists(official)}`;
    const labels = Object.keys(SIG_COL).filter(s => sigs[s]);
    mkChart('reSigChart', { type: 'doughnut', data: { labels, datasets: [{ data: labels.map(s => sigs[s]), backgroundColor: labels.map(s => SIG_COL[s]), borderWidth: 0 }] }, options: { maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'right' }, title: { display: true, text: 'Buy-timing signal mix (official-index cities)' } } } });
    const bins = [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.2];
    const counts = new Array(bins.length + 1).fill(0);
    official.forEach(c => { if (c.yoy == null) return; const i = bins.findIndex(b => c.yoy < b); counts[i < 0 ? bins.length : i]++; });
    const bl = ['<-10%', '-10…-5%', '-5…-2%', '-2…0%', '0…2%', '2…5%', '5…10%', '10…20%', '>20%'];
    mkChart('reYoyChart', { type: 'bar', data: { labels: bl, datasets: [{ data: counts, backgroundColor: bl.map((_, i) => ramp(METRICS.yoy.stops, i / (bl.length - 1))), borderRadius: 5 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: 'Markets by 1-year price change' } } } });
  }

  async function renderNode(n) {
    const d = RE.idx[RE.country];
    const box = $('#reAnalysis');
    const india = RE.country === 'india';
    const st = stateOf(n);
    if (n.nodata || n.proxy === 'none') {
      const kids = n.lv === 'state' ? nodesAt(d, 'city', n.id) : [];
      box.innerHTML = `${crumbs(n)}<h2>${esc(placeLabel(n))}</h2>
        <div class="bk-note">NHB RESIDEX, India's official housing price index, does not yet cover ${n.lv === 'state' ? 'any city in ' + esc(n.nm) : esc(n.nm) + ' or any other city in ' + esc(st.nm)}. We show no price or signal rather than an estimate.</div>
        ${n.pop ? kpis(n, d.currency) : ''}${kids.length ? `<h3>${kids.length} cities mapped</h3><ul class="bk-list">${kids.sort((a, b) => (b.pop || 0) - (a.pop || 0)).map(c => `<li data-go="${esc(c.id)}"><span>${esc(c.nm)}</span><span>${TIER_LBL[c.tier] || ''}</span></li>`).join('')}</ul>` : ''}`;
      return;
    }
    const bw = bestWindow(n);
    const sig = `<div class="bk-signal sig-${esc(n.sig)}"><div class="w">${esc(n.sig)}</div><div class="d">${sigSentence(n)}</div>
      <div class="s"><small>Best price window</small><b>${esc(bw.v)}</b><small>${esc(bw.s)}</small></div></div>`;
    let proxy = '';
    if (n.proxy === true) proxy = `<div class="bk-note">📍 ${esc(n.nm)} uses the official <b>${esc(cityOf(n).nm)}</b> city index — NHB RESIDEX does not publish locality-level prices. Locality premiums or discounts vs the city average are not reflected.</div>`;
    if (n.proxy === 'state') proxy = `<div class="bk-note">📍 ${esc(n.nm)} (${TIER_LBL[n.tier] || ''}) has no city-level official index yet. The trend and signal shown are the median of NHB RESIDEX cities in <b>${esc(st.nm)}</b>; no price level is shown because ${esc(n.nm)} prices can differ materially from those cities.</div>`;
    const indiaState = india && n.lv === 'state';
    const noChart = n.proxy === 'state';
    box.innerHTML = `${crumbs(n)}<h2>${esc(placeLabel(n))}${n.tier ? ` <span class="bk-pill tier-pill">${TIER_LBL[n.tier]}</span>` : ''}</h2>
      <p class="bk-sub">${n.lv === 'state' ? `${n.n || 0} official-index cities${n.n_all ? ' · ' + n.n_all + ' more Tier 2/3 cities mapped' : ''} · state summary` : esc(n.metro || n.county || '')}</p>${sig}${proxy}${kpis(n, d.currency)}
      ${indiaState ? '<div class="bk-chartbox" style="height:300px"><canvas id="reTrend"></canvas></div>' : noChart ? '' :
        `<div class="bk-grid2" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)"><div><h3>Price trend &amp; 80% forecast band</h3><div class="bk-chartbox" style="height:300px"><canvas id="reTrend"></canvas></div></div>
         <div><h3>Seasonality — when prices dip</h3><div class="bk-chartbox" style="height:300px"><canvas id="reSeason"></canvas></div></div></div>`}
      <div id="reExtra"></div>`;
    if (n.lv === 'state') $('#reExtra').innerHTML = topLists(nodesAt(d, 'city', n.id));
    if (indiaState) return renderIndiaState(n);
    if (noChart) return;
    try {
      const key = RE.country === 'usa' ? (n.lv === 'state' ? n.id : n.p) : 'IN';
      const ser = await loadSeries(RE.country, key);
      const sid = RE.country === 'usa' ? n.id : cityOf(n).id;
      const s = ser[sid];
      if (!s) throw new Error('no series');
      if (RE.sel !== n.id) return;
      RE.country === 'usa' ? drawUS(s, n) : drawIndia(s, n);
    } catch (e) {
      const t = $('#reTrend');
      if (t) t.parentElement.innerHTML = '<div class="bk-empty">Price history unavailable for this market.</div>';
    }
  }

  function seasonChart(sf, per) {
    if (!sf) {
      const el = $('#reSeason');
      if (el) el.parentElement.innerHTML = '<div class="bk-empty">No reliable seasonal pattern in this market.</div>';
      return;
    }
    const vals = sf.map(x => (Math.exp(x) - 1) * 100);
    const mi = vals.indexOf(Math.min(...vals));
    const labels = per === 12 ? MONTHS : ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];
    const weak = Math.max(...vals) - Math.min(...vals) < 0.5;
    mkChart('reSeason', {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: vals.map((v, i) => i === mi ? '#16a34a' : v > 0 ? '#f87171' : '#93c5fd'), borderRadius: 4 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw.toFixed(2) + '% vs annual average' } }, title: { display: true, text: 'Cheapest: ' + labels[mi] + (weak ? ' (weak pattern)' : '') } }, scales: { y: { ticks: { callback: v => v.toFixed(weak ? 2 : 1) + '%' } } } },
    });
  }

  function trendChart(labels, hist, fc, best, cur) {
    const H = hist.length, F = fc.d.length;
    const pad = a => new Array(H - 1).fill(null).concat(a);
    const mid = pad([hist[H - 1]].concat(fc.m));
    const lo = pad([hist[H - 1]].concat(fc.lo));
    const hi = pad([hist[H - 1]].concat(fc.hi));
    const bestPt = new Array(H + F).fill(null);
    if (best) { const i = fc.d.indexOf(best.d); if (i >= 0) bestPt[H + i] = fc.m[i]; }
    mkChart('reTrend', {
      type: 'line',
      data: {
        labels: labels.concat(fc.d).map(fmtYM),
        datasets: [
          { label: 'Actual', data: hist.concat(new Array(F).fill(null)), borderColor: '#1e293b', backgroundColor: 'rgba(30,41,59,.06)', fill: true, pointRadius: 0, borderWidth: 2.2, tension: 0.25 },
          { label: 'Forecast', data: mid, borderColor: '#6366f1', borderDash: [6, 4], pointRadius: 0, borderWidth: 2, tension: 0.25 },
          { label: '80% band', data: hi, borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(99,102,241,.15)', fill: '+1' },
          { label: '80% band (low)', data: lo, borderWidth: 0, pointRadius: 0, fill: false },
          { label: 'Best entry', data: bestPt, borderColor: '#16a34a', backgroundColor: '#16a34a', pointRadius: 9, pointStyle: 'star', showLine: false },
        ],
      },
      options: {
        maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { filter: i => !i.text.includes('(low)') } }, tooltip: { callbacks: { label: c => c.raw == null ? null : `${c.dataset.label}: ${money(c.raw, cur)}` } } },
        scales: { x: { ticks: { maxTicksLimit: 10 } }, y: { ticks: { callback: v => money(v, cur) } } },
      },
    });
  }
  function drawUS(s, n) {
    const [y0, m0] = s.d0.split('-').map(Number);
    const dates = s.v.map((_, i) => { const t = y0 * 12 + m0 - 1 + i; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); });
    const k = Math.max(0, dates.length - 120);
    trendChart(dates.slice(k), s.v.slice(k), s.fc, n.best, '$');
    seasonChart(s.sf, 12);
  }
  function drawIndia(s, n) {
    trendChart(s.d, s.v, s.fc, n.best, '₹');
    seasonChart(s.sf, 4);
    const city = cityOf(n);
    const pxb = city.pxb || [];
    $('#reExtra').innerHTML = `<div class="bk-grid2" style="margin-top:14px">
      <div><h3>Price by home size (latest quarter)</h3><table class="bk-table"><tbody>
        <tr><td>Up to 646 sq ft (≤60 m²)</td><td class="num"><b>${esc(money(pxb[0], '₹'))}</b> /sq ft</td></tr>
        <tr><td>646 – 1,184 sq ft</td><td class="num"><b>${esc(money(pxb[1], '₹'))}</b> /sq ft</td></tr>
        <tr><td>Above 1,184 sq ft (>110 m²)</td><td class="num"><b>${esc(money(pxb[2], '₹'))}</b> /sq ft</td></tr>
        <tr><td>Official HPI (FY2024-25 = 100)</td><td class="num"><b>${esc(city.hpi)}</b></td></tr></tbody></table></div>
      <div><h3>Long-run cycle — under-construction index</h3><div class="bk-chartbox"><canvas id="reUC"></canvas></div></div></div>`;
    if (s.uc && s.uc.d.length) {
      mkChart('reUC', { type: 'line', data: { labels: s.uc.d.map(fmtYM), datasets: [{ data: s.uc.v, borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,.08)', fill: true, pointRadius: 0, tension: 0.3 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 8 } } } } });
    }
  }
  function renderIndiaState(n) {
    const kids = nodesAt(RE.idx.india, 'city', n.id).filter(c => c.v).sort((a, b) => b.v - a.v);
    mkChart('reTrend', {
      type: 'bar',
      data: { labels: kids.map(c => c.nm), datasets: [{ label: '₹ / sq ft', data: kids.map(c => c.v), backgroundColor: kids.map(c => SIG_COL[c.sig]), borderRadius: 6 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: 'Official-index city prices (₹/sq ft) — bar colour = buy-timing signal' }, tooltip: { callbacks: { afterLabel: c => `1Y ${spct(kids[c.dataIndex].yoy)} · ${kids[c.dataIndex].sig}` } } } },
    });
  }

  // ------------------------------------------------------------ wiring
  // India: frame the whole official outline (incl. all of J&K and Ladakh).
  function homeView() {
    if (!RE.map) return;
    if (RE.country === 'india' && RE.outline) RE.map.fitBounds(RE.outline.getBounds(), { padding: [8, 8] });
    else RE.map.setView(RE.idx[RE.country].map.center, RE.idx[RE.country].map.zoom);
  }
  function resetRE() {
    RE.sel = null;
    syncSelects(null);
    homeView();
    drawPoints();
    setHash();
    renderOverview();
  }
  $('#reAnalysis').addEventListener('click', e => {
    const a = e.target.closest('[data-go]');
    if (!a) return;
    a.dataset.go ? selectNode(a.dataset.go) : resetRE();
  });
  $$('.bk-countries button').forEach(b => b.addEventListener('click', () => { setCountry(b.dataset.country).then(setHash); }));
  $('#reMetric').addEventListener('change', e => {
    RE.metric = e.target.value; renderLegend(); restyleGeo(); drawPoints();
    if (!RE.sel) renderOverview();
  });
  $$('#reTierWrap input').forEach(cb => cb.addEventListener('change', () => {
    RE.tiers = new Set($$('#reTierWrap input:checked').map(x => +x.value));
    drawPoints();
  }));
  $('#reState').addEventListener('change', e => { e.target.value ? selectNode(e.target.value) : resetRE(); });
  $('#reCity').addEventListener('change', e => { e.target.value ? selectNode(e.target.value) : $('#reState').value && selectNode($('#reState').value); });
  $('#reLoc').addEventListener('change', e => { e.target.value ? selectNode(e.target.value) : $('#reCity').value && selectNode($('#reCity').value); });
  $('#reSearch').addEventListener('change', e => {
    const id = RE.searchMap && RE.searchMap[e.target.value.trim().toLowerCase()];
    if (id) { selectNode(id); e.target.value = ''; }
  });

  function setHash() {
    const h = '#' + (RE.country || CFG.region) + (RE.sel ? '/' + RE.sel : '');
    if (location.hash !== h) history.replaceState(null, '', h);
  }
  async function route() {
    const [a, b] = decodeURIComponent(location.hash.slice(1)).split('/');
    const country = a === 'usa' || a === 'india' ? a : CFG.region;
    initMap();
    if (country !== RE.country) await setCountry(country, b);
    else if (b) selectNode(b);
    else resetRE();
  }
  window.addEventListener('hashchange', route);
  // Leaflet sizes its canvas when created; re-measure once the grid layout has settled.
  window.addEventListener('load', () => { if (RE.map) { RE.map.invalidateSize(); drawPoints(); } });
  route();
})();
