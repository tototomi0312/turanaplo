// Small UI helpers: element builder, toast, maps, elevation chart, photo resize.
(function () {
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  const LAYERS = {
    topo: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17,
      attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://opentopomap.org">OpenTopoMap</a>' },
    osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19,
      attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  };
  const TRAILS = { url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    attr: 'Turistautak: <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>' };

  function makeMap(el, layerKey = 'topo') {
    const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([47.5, 19.0], 12);
    const base = {
      'Turista': L.tileLayer(LAYERS.topo.url, { maxZoom: LAYERS.topo.max, attribution: LAYERS.topo.attr }),
      'Alap': L.tileLayer(LAYERS.osm.url, { maxZoom: LAYERS.osm.max, attribution: LAYERS.osm.attr }),
    };
    const trails = L.tileLayer(TRAILS.url, { maxZoom: 18, opacity: 0.8, attribution: TRAILS.attr });
    (layerKey === 'osm' ? base['Alap'] : base['Turista']).addTo(map);
    trails.addTo(map);
    L.control.layers(base, { 'Jelzett utak': trails }, { position: 'topright' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    return map;
  }

  // Split a track into solid (walked) and dashed (GPS gap estimate) polylines.
  function drawTrack(map, points, group) {
    group = group || L.layerGroup().addTo(map);
    group.clearLayers();
    let seg = [];
    const flush = () => { if (seg.length > 1) L.polyline(seg, { color: '#d9480f', weight: 5, opacity: 0.9 }).addTo(group); };
    points.forEach((p, i) => {
      if (i && (p.segStart || p.gapBefore)) {
        flush();
        if (p.gapBefore) {
          const a = points[i - 1];
          L.polyline([[a.lat, a.lon], [p.lat, p.lon]], { color: '#d9480f', weight: 3, dashArray: '6 8', opacity: 0.7 }).addTo(group);
        }
        seg = [];
      }
      seg.push([p.lat, p.lon]);
    });
    flush();
    return group;
  }

  const dot = (color) => L.divIcon({ className: 'dot', html: `<span style="background:${color}"></span>`, iconSize: [16, 16] });

  // Elevation profile as inline SVG. samples: [{dist, ele}]
  function elevationChart(samples) {
    const W = 600, H = 160, P = { l: 38, r: 8, t: 10, b: 22 };
    const vals = samples.filter((s) => s.ele != null);
    if (vals.length < 2) return h('p', { class: 'muted' }, 'Nincs magasság-adat.');
    const maxD = vals[vals.length - 1].dist || 1;
    let lo = Math.min(...vals.map((s) => s.ele)), hi = Math.max(...vals.map((s) => s.ele));
    if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
    const x = (d) => P.l + (d / maxD) * (W - P.l - P.r);
    const y = (e) => P.t + (1 - (e - lo) / (hi - lo)) * (H - P.t - P.b);
    const line = vals.map((s, i) => `${i ? 'L' : 'M'}${x(s.dist).toFixed(1)},${y(s.ele).toFixed(1)}`).join('');
    const area = `${line}L${x(maxD)},${H - P.b}L${x(0)},${H - P.b}Z`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Magassági profil">
      <path d="${area}" class="area"/><path d="${line}" class="line"/>
      <text x="4" y="${y(hi) + 4}">${Math.round(hi)} m</text><text x="4" y="${y(lo)}">${Math.round(lo)} m</text>
      <text x="${P.l}" y="${H - 4}">0</text><text x="${W - P.r}" y="${H - 4}" text-anchor="end">${Geo.fmtKm(maxD)}</text></svg>`;
    return h('div', { html: svg });
  }

  // Downscale a photo before storing it (iPhone originals are 3-6 MB).
  async function resizePhoto(file, max = 1600, quality = 0.82) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    return { blob, width: c.width, height: c.height };
  }

  function stars(value, onChange) {
    const wrap = h('div', { class: 'stars', role: 'radiogroup', 'aria-label': 'Értékelés' });
    const render = () => {
      wrap.replaceChildren(...[1, 2, 3, 4, 5].map((n) =>
        h('button', { type: 'button', class: n <= value ? 'on' : '', 'aria-label': `${n} csillag`,
          onclick: onChange ? () => { value = value === n ? 0 : n; render(); onChange(value); } : null }, '★')));
    };
    render();
    return wrap;
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  window.UI = { h, toast, makeMap, drawTrack, dot, elevationChart, resizePhoto, stars, fmtDate };
})();
