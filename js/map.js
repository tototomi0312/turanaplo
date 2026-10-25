// Vector map (MapLibre + OpenFreeMap tiles) restyled into a calm hiking palette,
// with the Waymarked Trails raster on top for the marked hiking routes.
(function () {
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const TRAILS_URL = 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png';
  const TOPO_URL = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png';

  const PALETTE = {
    background: '#f2f0e8', water: '#b9d4e3', waterLine: '#9cc0d6', wood: '#cfe2c3', grass: '#dde9cf',
    park: '#d3e5c6', building: '#e4e0d6', road: '#ffffff', roadCase: '#ddd7c9', path: '#a07a52',
    label: '#3d4a40', labelHalo: '#f7f6f1',
  };

  // Restyle positron by source-layer, so it keeps working if layer ids change upstream.
  function restyle(map) {
    for (const layer of map.getStyle().layers) {
      const sl = layer['source-layer'], id = layer.id, t = layer.type;
      const set = (prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (e) { /* prop not on this layer */ } };
      if (t === 'background') set('background-color', PALETTE.background);
      else if (sl === 'water' && t === 'fill') set('fill-color', PALETTE.water);
      else if (sl === 'waterway' && t === 'line') set('line-color', PALETTE.waterLine);
      else if (sl === 'landcover' && t === 'fill') { set('fill-color', PALETTE.wood); set('fill-opacity', 0.9); }
      else if (sl === 'park' && t === 'fill') { set('fill-color', PALETTE.park); set('fill-opacity', 0.8); }
      else if (sl === 'landuse' && t === 'fill') set('fill-opacity', 0.35);
      else if (sl === 'building' && t === 'fill') set('fill-color', PALETTE.building);
      else if (sl === 'transportation' && t === 'line') {
        if (/path|track|pedestrian/.test(id)) { set('line-color', PALETTE.path); set('line-dasharray', [2, 1.5]); }
        else if (/casing/.test(id)) set('line-color', PALETTE.roadCase);
        else set('line-color', PALETTE.road);
      } else if (t === 'symbol') { set('text-color', PALETTE.label); set('text-halo-color', PALETTE.labelHalo); }
    }
  }

  function firstSymbolLayer(map) {
    const l = map.getStyle().layers.find((x) => x.type === 'symbol');
    return l && l.id;
  }

  function makeMap(el, opts = {}) {
    const map = new maplibregl.Map({
      container: el, style: STYLE_URL, center: opts.center || [19.2, 47.3], zoom: opts.zoom || 6.5,
      attributionControl: false, pitchWithRotate: false, dragRotate: true, touchPitch: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true,
      customAttribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Turistautak: <a href="https://hiking.waymarkedtrails.org">Waymarked Trails</a>' }));
    if (opts.bounds) map.fitBounds(opts.bounds, { padding: 16, duration: 0 });
    map.ready = new Promise((resolve) => map.on('load', () => {
      // Keep the attribution collapsed to the (i) button on small screens.
      el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      restyle(map);
      const before = firstSymbolLayer(map);
      map.addSource('topo', { type: 'raster', tiles: [TOPO_URL], tileSize: 256, maxzoom: 17 });
      map.addLayer({ id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9 } }, before);
      map.addSource('trails', { type: 'raster', tiles: [TRAILS_URL], tileSize: 256, maxzoom: 18 });
      map.addLayer({ id: 'trails', type: 'raster', source: 'trails', minzoom: 9, paint: { 'raster-opacity': 0.85 } }, before);
      resolve(map);
    }));
    addButtons(map, el, opts);
    return map;
  }

  function setLayer(map, name, visible) {
    if (map.getLayer(name)) map.setLayoutProperty(name, 'visibility', visible ? 'visible' : 'none');
  }

  // Floating round buttons: fullscreen, layers, and (optionally) locate/heading.
  function addButtons(map, el, opts) {
    const box = document.createElement('div');
    box.className = 'map-buttons';
    const btn = (icon, label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'map-btn'; b.innerHTML = icon; b.setAttribute('aria-label', label);
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
      box.append(b); return b;
    };
    btn(Icons.expand, 'Teljes képernyő', (b) => {
      const full = el.classList.toggle('fullscreen');
      document.body.classList.toggle('map-full', full);
      b.innerHTML = full ? Icons.shrink : Icons.expand;
      setTimeout(() => map.resize(), 50);
    });
    let mode = 0; // 0 vector, 1 topo raster
    btn(Icons.layers, 'Térképréteg', () => {
      mode = (mode + 1) % 2;
      setLayer(map, 'topo', mode === 1);
      UI.toast(mode === 1 ? 'Domborzati térkép' : 'Letisztult térkép');
    });
    let trails = true;
    btn(Icons.route, 'Jelzett utak', (b) => {
      trails = !trails; setLayer(map, 'trails', trails);
      b.classList.toggle('off', !trails);
      UI.toast(trails ? 'Jelzett utak be' : 'Jelzett utak ki');
    });
    if (opts.locate) map.locateBtn = btn(Icons.locate, 'Követés / irány', (b) => opts.locate(b));
    el.append(box);
  }

  // Track as GeoJSON: solid walked segments + dashed straight lines over GPS gaps.
  function trackGeoJSON(points) {
    const solid = [], dashed = [];
    let seg = [];
    points.forEach((p, i) => {
      const c = [p.lon, p.lat];
      if (i && (p.segStart || p.gapBefore)) {
        if (seg.length > 1) solid.push(seg);
        if (p.gapBefore) { const a = points[i - 1]; dashed.push([[a.lon, a.lat], c]); }
        seg = [];
      }
      seg.push(c);
    });
    if (seg.length > 1) solid.push(seg);
    return { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { kind: 'solid' }, geometry: { type: 'MultiLineString', coordinates: solid } },
      { type: 'Feature', properties: { kind: 'gap' }, geometry: { type: 'MultiLineString', coordinates: dashed } },
    ] };
  }

  async function drawTrack(map, points) {
    await map.ready;
    const data = trackGeoJSON(points);
    if (map.getSource('track')) { map.getSource('track').setData(data); return; }
    map.addSource('track', { type: 'geojson', data });
    map.addLayer({ id: 'track-casing', type: 'line', source: 'track', filter: ['==', ['get', 'kind'], 'solid'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
    map.addLayer({ id: 'track', type: 'line', source: 'track', filter: ['==', ['get', 'kind'], 'solid'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e8590c', 'line-width': 5 } });
    map.addLayer({ id: 'track-gap', type: 'line', source: 'track', filter: ['==', ['get', 'kind'], 'gap'],
      paint: { 'line-color': '#e8590c', 'line-width': 3, 'line-dasharray': [1.5, 2] } });
  }

  // Extra line layer (e.g. a hiking route's geometry). lines: [[[lon, lat], ...], ...]
  async function drawLines(map, id, lines, color = '#1f5c43') {
    await map.ready;
    const data = { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
    if (map.getSource(id)) return map.getSource(id).setData(data);
    map.addSource(id, { type: 'geojson', data });
    map.addLayer({ id: id + '-casing', type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 7 } });
    map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': 4 } });
  }

  function marker(map, lat, lon, opts = {}) {
    const el = document.createElement('div');
    el.className = 'mk ' + (opts.cls || '');
    if (opts.html) el.innerHTML = opts.html;
    const m = new maplibregl.Marker({ element: el, anchor: opts.anchor || 'center', rotationAlignment: opts.rotate ? 'map' : 'viewport' })
      .setLngLat([lon, lat]).addTo(map);
    if (opts.popup) m.setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(opts.popup));
    if (opts.onClick) el.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(); });
    return m;
  }

  // "You are here" marker with a heading cone. heading: degrees from north or null.
  function meMarker(map) {
    const el = document.createElement('div');
    el.className = 'me';
    el.innerHTML = '<div class="me-cone"></div><div class="me-dot"></div>';
    const m = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([19, 47.5]).addTo(map);
    m.setHeading = (deg) => {
      el.classList.toggle('has-heading', deg != null);
      if (deg != null) el.querySelector('.me-cone').style.transform = `rotate(${deg}deg)`;
    };
    return m;
  }

  function fitPoints(map, pts, padding = 40) {
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat]);
    pts.forEach((p) => b.extend([p.lon, p.lat]));
    map.fitBounds(b, { padding, maxZoom: 15, duration: 0 });
  }

  window.MapKit = { makeMap, drawTrack, drawLines, marker, meMarker, fitPoints, setLayer };
})();
