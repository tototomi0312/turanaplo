// Views + hash router.
(function () {
  const { h, toast, ic } = UI;
  const view = document.getElementById('view');
  const titleEl = document.getElementById('title');
  const backBtn = document.getElementById('backBtn');
  const tabbar = document.getElementById('tabbar');
  let cleanup = [];

  const DIFFICULTY = ['Könnyű', 'Közepes', 'Nehéz', 'Nagyon nehéz'];
  const REPORT_TYPES = ['Lezárt / járhatatlan út', 'Hiányzó vagy rossz jelzés', 'Kidőlt fa, akadály',
    'Bezárt / megszűnt létesítmény', 'Új vagy változott útvonal', 'Egyéb'];
  const FILTERS = [['Mind', null], ['Túraútvonal', ['route', 'trail']], ['Csúcs', ['peak']], ['Kilátó', ['tower', 'viewpoint']], ['Turistaház', ['alpine_hut', 'wilderness_hut']],
    ['Szikla, gerinc', ['ridge', 'cliff', 'rock', 'arch', 'saddle', 'gorge']], ['Barlang', ['cave_entrance']], ['Vízesés', ['waterfall']], ['Vár', ['castle']]];
  const KIND_COLOR = { peak: '#2f6b4f', tower: '#b5541c', viewpoint: '#b5541c', alpine_hut: '#7a4fa0', wilderness_hut: '#7a4fa0',
    cave_entrance: '#5c5c5c', waterfall: '#1f78b4', castle: '#8c5a2b',
    ridge: '#6b7f3a', saddle: '#6b7f3a', cliff: '#7d6a55', rock: '#7d6a55', arch: '#7d6a55', gorge: '#7d6a55',
    route: '#1c5fd1', trail: '#1c5fd1' };

  backBtn.innerHTML = Icons.back;
  backBtn.addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/'));

  // replaceChildren would print null/false as text, so drop them first.
  const render = (...kids) => view.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  function setTitle(t, back = true) { titleEl.textContent = t; backBtn.hidden = !back; }
  const go = (hash) => { location.hash = hash; };

  // ---------- small components ----------
  function seg(options, value, onChange, cls = '') {
    const wrap = h('div', { class: 'seg ' + cls });
    const draw = () => wrap.replaceChildren(...options.map(([label, v]) =>
      h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => { value = value === v && cls.includes('toggle') ? null : v; draw(); onChange(value); } }, label)));
    draw();
    return wrap;
  }
  const field = (label, ...kids) => h('div', { class: 'field' }, h('label', null, label), ...kids);
  const section = (title, ...kids) => h('section', { class: 'section' }, title ? h('h2', null, title) : null, ...kids);

  function kindBadge(kind, symbol) {
    const b = ic(KindIcon[kind] || 'pin', 'badge');
    const mark = symbol && UI.trailMark(symbol);
    if (mark) { b.innerHTML = ''; b.append(mark); b.classList.add('has-mark'); }
    b.style.setProperty('--c', KIND_COLOR[kind] || '#2f6b4f');
    return b;
  }

  function placeCard(p, onClick) {
    const meta = [Places.KIND[p.kind] || 'Hely', p.town, p.region, p.ele ? `${Math.round(p.ele)} m` : null].filter(Boolean).join(' · ');
    return h('button', { class: 'place', type: 'button', onclick: () => onClick(p) },
      kindBadge(p.kind, p.symbol),
      h('span', { class: 'place-body' }, h('strong', null, p.name), h('small', null, meta)),
      p.distance != null ? h('span', { class: 'place-dist' }, Geo.fmtKm(p.distance)) : null);
  }

  function getPosition(maxAge = 30000) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Nincs helymeghatározás'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: maxAge });
    });
  }

  function geoErrorText(e) {
    if (e && e.code === 1) return 'A helymeghatározás tiltva van. iPhone-on: Beállítások › Adatvédelem › Helymeghatározás › Safari: „App használatakor".';
    if (e && e.code === 3) return 'Nem jött GPS-jel időben. Próbáld szabad ég alatt.';
    return 'Nem sikerült a helyet lekérni.';
  }

  function hikeLine(hk) {
    const s = hk.stats || {};
    const dist = s.distance ?? Geo.trackDistance(hk.points);
    return [Geo.fmtKm(dist), Geo.fmtDur((hk.endedAt || Date.now()) - hk.startedAt), s.up != null ? `↑ ${Math.round(s.up)} m` : null].filter(Boolean).join(' · ');
  }

  // Place lookup: our own record (reviews, own places) first, then the catalogue.
  async function findPlace(id) {
    const own = await DB.get('places', id), cat = await Catalog.byId(id);
    if (!own) return cat;
    const merged = Object.assign({}, cat || {}, own);
    for (const k of ['ele', 'region', 'town']) if (merged[k] == null && cat) merged[k] = cat[k];
    return merged;
  }

  // ---------- explore ----------
  const exploreState = { q: '', filter: 0, region: null, near: null, mode: 'list', limit: 60 };

  async function explore() {
    setTitle('Felfedezés', false);
    const st = exploreState;
    const input = h('input', { type: 'search', placeholder: 'Keress: Csóványos, Kékes, kilátó…', value: st.q, enterkeyhint: 'search' });
    const list = h('div', { class: 'places' });
    const count = h('p', { class: 'muted small' });
    const onlineBox = h('div');
    const mapEl = h('div', { class: 'map explore-map', hidden: st.mode !== 'map' });
    const regions = [...await Catalog.regions()].sort((a, b) => a.localeCompare(b, 'hu'));
    const regionSel = h('select', { class: 'select', onchange: (e) => { st.region = e.target.value || null; refresh(); } },
      h('option', { value: '' }, 'Minden tájegység'), ...regions.map((r) => h('option', { value: r, selected: r === st.region }, r)));
    const nearBtn = h('button', { type: 'button', class: 'chip' + (st.near ? ' on' : ''), onclick: async () => {
      if (st.near) { st.near = null; nearBtn.classList.remove('on'); return refresh(); }
      nearBtn.textContent = 'Helyzet…';
      try { st.near = await getPosition(); nearBtn.classList.add('on'); } catch (e) { toast(geoErrorText(e), 5000); }
      nearBtn.replaceChildren(ic('locate'), ' Közelben');
      refresh();
    } }, ic('locate'), ' Közelben');

    let map = null, results = [];
    const pick = (p) => go(`#/place/${encodeURIComponent(p.id)}`);

    async function refresh() {
      const kinds = FILTERS[st.filter][1];
      results = await Catalog.query({ q: st.q, kinds: kinds ? new Set(kinds) : null, near: st.near, region: st.region });
      // Own places and routes are not in the catalogue; match them the same way and list them first.
      const words = Catalog.norm(st.q).split(' ').filter(Boolean);
      const own = (await DB.all('places')).filter((p) => p.source === 'own' && !p.id.startsWith('own:demo') &&
        (!kinds || kinds.includes(p.kind)) && (!st.region || p.region === st.region) &&
        words.every((w) => Catalog.norm([p.name, p.town, p.region].filter(Boolean).join(' ')).includes(w)));
      if (st.near) own.forEach((p) => (p.distance = Geo.haversine(st.near, p)));
      results = [...own, ...results];
      count.textContent = `${results.length.toLocaleString('hu-HU')} hely` + (st.near ? ', távolság szerint' : '');
      list.replaceChildren(...results.slice(0, st.limit).map((p) => placeCard(p, pick)),
        ...(results.length > st.limit ? [h('button', { class: 'btn ghost wide', onclick: () => { st.limit += 60; refresh(); } }, 'Továbbiak')] : []));
      if (!results.length) list.append(h('p', { class: 'empty' }, 'Nincs ilyen hely a beépített listában.'));
      // The built-in list is a selection; the full OSM search is always one tap away (list and map mode).
      onlineBox.replaceChildren(...(st.q ? [h('button', { class: 'btn wide', onclick: () => onlineSearch(st.q) }, ic('search'), ` „${st.q}" keresése a teljes térképen`)] : []));
      if (map) updateMapData();
    }

    async function onlineSearch(q) {
      if (st.mode === 'map') modeSeg.querySelector('button').click(); // results are a list
      list.replaceChildren(h('p', { class: 'muted' }, 'Keresés…'));
      try {
        const res = await Places.search(q, st.near);
        list.replaceChildren(...res.map((p) => placeCard(p, async (x) => { await Places.remember(x); pick(x); })));
        if (!res.length) list.append(h('p', { class: 'muted' }, 'Nincs találat.'));
      } catch (e) { list.replaceChildren(h('p', { class: 'muted' }, 'A keresés nem sikerült (nincs net?).')); }
    }

    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { st.q = input.value; st.limit = 60; refresh(); }, 150); });

    function updateMapData() {
      const fc = { type: 'FeatureCollection', features: results.map((p) => ({ type: 'Feature',
        properties: { id: p.id, name: p.name, kind: p.kind, color: KIND_COLOR[p.kind] || '#2f6b4f' },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) };
      map.ready.then(() => {
        if (map.getSource('places')) return map.getSource('places').setData(fc);
        map.addSource('places', { type: 'geojson', data: fc, cluster: true, clusterRadius: 42, clusterMaxZoom: 11 });
        map.addLayer({ id: 'clusters', type: 'circle', source: 'places', filter: ['has', 'point_count'],
          paint: { 'circle-color': '#2f6b4f', 'circle-opacity': 0.85, 'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 100, 24], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'places', filter: ['has', 'point_count'],
          layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#fff' } });
        map.addLayer({ id: 'pts', type: 'circle', source: 'places', filter: ['!', ['has', 'point_count']],
          paint: { 'circle-color': ['get', 'color'], 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'pts-label', type: 'symbol', source: 'places', filter: ['!', ['has', 'point_count']], minzoom: 11,
          layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] },
          paint: { 'text-color': '#24352b', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
        map.on('click', 'clusters', async (e) => {
          const f = e.features[0];
          const z = await map.getSource('places').getClusterExpansionZoom(f.properties.cluster_id);
          map.easeTo({ center: f.geometry.coordinates, zoom: z });
        });
        map.on('click', 'pts', (e) => {
          const f = e.features[0];
          new maplibregl.Popup({ offset: 10, closeButton: false }).setLngLat(f.geometry.coordinates)
            .setHTML(`<a class="popup-link" href="#/place/${encodeURIComponent(f.properties.id)}">${f.properties.name} ›</a>`).addTo(map);
        });
        for (const l of ['clusters', 'pts']) {
          map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
          map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
        }
      });
    }

    const modeSeg = seg([['Lista', 'list'], ['Térkép', 'map']], st.mode, (v) => {
      st.mode = v || 'list';
      list.hidden = st.mode === 'map'; mapEl.hidden = st.mode !== 'map';
      if (st.mode === 'map') {
        if (!map) {
          map = MapKit.makeMap(mapEl, st.near ? { center: [st.near.lon, st.near.lat], zoom: 10 } : { bounds: [[16.1, 45.7], [22.9, 48.6]] });
          cleanup.push(() => map.remove());
          updateMapData();
        } else setTimeout(() => map.resize(), 30);
      }
    }, 'small');

    render(
      h('div', { class: 'search' }, ic('search'), input),
      h('div', { class: 'chips' }, nearBtn, ...FILTERS.map(([label], i) =>
        h('button', { type: 'button', class: 'chip' + (i === st.filter ? ' on' : ''), onclick: (e) => {
          st.filter = i; st.limit = 60;
          e.currentTarget.parentNode.querySelectorAll('.chip').forEach((c, j) => j > 0 && c.classList.toggle('on', j - 1 === i));
          refresh();
        } }, label))),
      h('div', { class: 'row-between' }, regionSel, modeSeg),
      count, mapEl, list, onlineBox);
    list.hidden = st.mode === 'map';
    if (st.mode === 'map') { st.mode = 'list'; modeSeg.querySelectorAll('button')[1].click(); }
    refresh();
  }

  // ---------- place ----------
  async function placeView(id) {
    const p = await findPlace(id);
    if (!p) return go('#/');
    setTitle('');
    const sm = await placeSummary(id);
    const reports = (await DB.byIndex('reports', 'placeId', id)).sort((a, b) => b.createdAt - a.createdAt);
    const mapEl = h('div', { class: 'map hero' });
    const parkList = h('div', { class: 'list' }, h('p', { class: 'muted small' }, 'Parkolók keresése a közelben…'));

    let rType = null;
    const rText = h('textarea', { rows: 3, placeholder: 'Mi változott? (pl. „a piros jelzés a forrásnál eltűnt")' });
    const reportForm = h('div', { class: 'panel', hidden: true },
      field('Mi a változás?', seg(REPORT_TYPES.map((t) => [t, t]), null, (v) => (rType = v), 'wrap toggle')), rText,
      h('button', { class: 'btn primary wide', onclick: async () => {
        if (!rType) return toast('Válaszd ki, mi változott.');
        let pos = null; try { pos = await getPosition(); } catch (e) { /* location is optional */ }
        await Places.remember(stripPlace(p));
        await DB.put('reports', { id: DB.uid(), placeId: id, type: rType, text: rText.value.trim(), createdAt: Date.now(),
          lat: pos?.lat ?? null, lon: pos?.lon ?? null, status: 'open' });
        toast('Jelzés mentve.'); placeView(id);
      } }, 'Jelzés mentése'));

    const tag = (on, label) => on == null ? null : h('span', { class: 'tag' + (on ? ' yes' : ' no') }, (on ? '✓ ' : '✗ ') + label);

    render(
      mapEl,
      h('div', { class: 'place-head' }, kindBadge(p.kind, p.symbol),
        h('div', null, h('h1', { class: 'big-title' }, p.name),
          h('p', { class: 'muted' }, [Places.KIND[p.kind] || 'Hely', p.town, p.region, p.ele ? `${Math.round(p.ele)} m` : null].filter(Boolean).join(' · ')))),
      p.unofficial ? h('p', { class: 'unofficial' }, ic('flag'), ` Nem hivatalos útvonal · készítette: ${p.author || 'ismeretlen'}`,
        p.distance ? ` · ${Geo.fmtKm(p.distance)}` : '') : null,
      h('div', { class: 'tags' }, sm.avg ? h('span', { class: 'tag star' }, `★ ${sm.avg.toFixed(1).replace('.', ',')}`) : null,
        tag(sm.kid, 'gyerekbarát'), tag(sm.dog, 'kutyabarát'), sm.difficulty ? h('span', { class: 'tag' }, sm.difficulty) : null),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => startHike(p) }, ic('play'), ' Indítás itt'),
        h('a', { class: 'btn', href: appleMaps(p.lat, p.lon), target: '_blank', rel: 'noopener' }, ic('car'), ' Odavezetés')),
      wishPanel(p),
      section('Parkolás a közelben', parkList,
        h('p', { class: 'muted small' }, 'Forrás: OpenStreetMap. A díjat és a nyitva tartást a helyszínen ellenőrizd.')),
      section('Túráim itt',
        sm.hikes.length ? h('div', { class: 'list' }, sm.hikes.map((x) => h('a', { class: 'card', href: `#/hike/${x.id}` },
          h('div', { class: 'card-top' }, h('strong', null, UI.fmtDate(x.startedAt)), x.review.stars ? h('span', { class: 'stars small' }, '★'.repeat(x.review.stars)) : null),
          h('div', { class: 'muted' }, hikeLine(x)), x.review.text ? h('p', { class: 'quote' }, x.review.text) : null)))
          : h('p', { class: 'muted' }, 'Még nem jártál itt az appal.')),
      section('Változások',
        reports.length ? h('div', { class: 'list' }, reports.map((r) => h('div', { class: 'card' },
          h('div', { class: 'card-top' }, h('strong', null, r.type), h('span', { class: 'muted' }, UI.fmtDate(r.createdAt))),
          r.text ? h('p', null, r.text) : null,
          h('div', { class: 'card-top' },
            r.status !== 'open' ? h('span', { class: 'tag yes' }, 'rendben') : h('span', { class: 'tag warn' }, 'nyitott'),
            h('button', { class: 'linkbtn', onclick: async () => { r.status = r.status === 'open' ? 'resolved' : 'open'; await DB.put('reports', r); placeView(id); } },
              r.status === 'open' ? 'Már rendben' : 'Újranyitás')))))
          : h('p', { class: 'muted' }, 'Nincs jelzett változás.'),
        h('button', { class: 'btn wide', onclick: () => (reportForm.hidden = !reportForm.hidden) }, ic('flag'), ' Változás jelzése'), reportForm),
      p.source === 'own' ? h('button', { class: 'linkbtn', onclick: async () => {
        const name = prompt('Új név:', p.name); if (!name) return;
        p.name = name.trim(); await DB.put('places', p);
        for (const x of sm.hikes) { x.place.name = p.name; await DB.put('hikes', x); }
        placeView(id);
      } }, 'Átnevezés') : null);

    const map = MapKit.makeMap(mapEl, { center: [p.lon, p.lat], zoom: 13.5 });
    cleanup.push(() => map.remove());
    if (p.kind === 'route' || p.kind === 'trail') {
      Places.trailGeometry(p).then((lines) => {
        if (!lines.length) return;
        const col = (p.symbol && { blue: '#1c5fd1', red: '#d22b2b', green: '#1f8a3a', yellow: '#d9a400' }[p.symbol.split(':')[0]]) || '#1c5fd1';
        MapKit.drawLines(map, 'route', lines, col);
        MapKit.fitPoints(map, lines.flat().map(([lon, lat]) => ({ lat, lon })), 30);
      }).catch(() => { /* geometry is a bonus; the marker still shows the place */ });
    } else MapKit.marker(map, p.lat, p.lon, { cls: 'pin-place', html: Icons[KindIcon[p.kind] || 'pin'] });
    reports.filter((r) => r.lat != null).forEach((r) => MapKit.marker(map, r.lat, r.lon, { cls: 'pin-report', html: Icons.flag, popup: r.type }));
    DB.kvGet('car').then((car) => { if (car) MapKit.marker(map, car.lat, car.lon, { cls: 'pin-car', html: Icons.car, popup: 'Itt parkol az autó' }); });

    let alive = true; cleanup.push(() => (alive = false));
    let parkMarkers = [], fitted = false;
    const showParks = (all) => {
      if (!alive) return;
      const parks = all.slice(0, 6);
      parkList.replaceChildren(...parks.map((k) => h('a', { class: 'place', href: appleMaps(k.lat, k.lon), target: '_blank', rel: 'noopener' },
        ic('parking', 'badge park'),
        h('span', { class: 'place-body' }, h('strong', null, k.name || 'Parkoló'),
          h('small', null, [k.fee === 'yes' ? 'fizetős' : k.fee === 'no' ? 'ingyenes' : null, k.capacity ? `${k.capacity} hely` : null, 'útvonal Apple Térképen'].filter(Boolean).join(' · '))),
        h('span', { class: 'place-dist' }, Geo.fmtKm(k.distance)))));
      parkMarkers.forEach((m) => m.remove());
      parkMarkers = parks.map((k) => MapKit.marker(map, k.lat, k.lon, { cls: 'pin-park', html: 'P', popup: k.name || 'Parkoló' }));
      if (parks.length && !fitted) { fitted = true; MapKit.fitPoints(map, [p, ...parks.slice(0, 2)], 50); }
    };
    // Sources answer at different speeds (Nominatim ~1 s, Overpass up to 25 s): show what arrives.
    Places.parking(p.lat, p.lon, 8000, showParks).then((all) => {
      if (alive && !all.length) parkList.replaceChildren(h('p', { class: 'muted' }, '8 km-en belül nincs parkoló az OpenStreetMapen.'));
    }).catch(() => {
      if (alive && !parkMarkers.length) parkList.replaceChildren(h('p', { class: 'muted' }, 'A parkolók nem töltődtek be (nincs net, vagy a térképszerver lassú).'));
    });
  }

  // Bucket-list toggle with an optional planned date.
  function wishPanel(p) {
    const box = h('div', { class: 'wish' });
    const save = async (wish) => {
      const rec = Object.assign((await DB.get('places', p.id)) || stripPlace(p), { savedAt: Date.now() });
      if (wish) rec.wish = wish; else delete rec.wish;
      await DB.put('places', rec);
      p.wish = rec.wish;
      draw();
    };
    function draw() {
      if (!p.wish) {
        box.replaceChildren(h('button', { class: 'btn ghost wide', onclick: () => save({ addedAt: Date.now(), date: null }).then(() => toast('Felkerült a bakancslistára.')) },
          ic('flag'), ' Bakancslistára'));
        return;
      }
      const date = h('input', { type: 'date', value: p.wish.date || '', min: today(), onchange: (e) => save({ ...p.wish, date: e.target.value || null }) });
      box.replaceChildren(h('div', { class: 'panel wish-on' },
        h('div', { class: 'card-top' }, h('strong', null, ic('check', 'ok-ic'), ' A bakancslistádon'),
          h('button', { class: 'linkbtn danger', onclick: () => save(null).then(() => toast('Levettem a bakancslistáról.')) }, 'Levétel')),
        field('Mikor mennétek? (nem kötelező)', date),
        p.wish.date ? h('button', { class: 'btn wide', onclick: () => exportIcs(p) }, ic('calendar'), ' Naptárba') : null));
    }
    draw();
    return box;
  }

  const appleMaps = (lat, lon) => `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`;
  const stripPlace = (p) => ({ id: p.id, source: p.source, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon, ele: p.ele ?? null,
    region: p.region ?? null, town: p.town ?? null, symbol: p.symbol ?? null });

  async function placeSummary(placeId) {
    const hikes = (await DB.all('hikes')).filter((x) => x.place?.id === placeId && x.status === 'finished');
    const rated = hikes.filter((x) => x.review.stars);
    const vote = (key) => {
      const v = hikes.map((x) => x.review[key]).filter((x) => x != null);
      return v.length ? v.filter(Boolean).length >= v.length / 2 : null;
    };
    const diffs = hikes.map((x) => x.review.difficulty).filter(Boolean);
    return {
      hikes, avg: rated.length ? rated.reduce((a, x) => a + x.review.stars, 0) / rated.length : null,
      kid: vote('kidFriendly'), dog: vote('dogFriendly'),
      difficulty: diffs.length ? diffs.sort((a, b) => diffs.filter((d) => d === b).length - diffs.filter((d) => d === a).length)[0] : null,
    };
  }

  async function startHike(p) {
    if (Tracker.hike) return go('#/track');
    const place = p ? await Places.remember(stripPlace(p)) : null;
    await Tracker.start(place ? stripPlace(place) : null);
    go('#/track');
  }

  // ---------- start: quick pick near me ----------
  async function start() {
    if (Tracker.hike) return go('#/track');
    setTitle('Hol vagy?');
    const status = h('p', { class: 'muted' }, 'Helyzet lekérése…');
    const list = h('div', { class: 'places' });
    let here = null;
    render(status, list, h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => {
        if (!here) return toast('Előbb kell egy GPS-pozíció.');
        const name = prompt('A hely neve:'); if (!name) return;
        startHike({ id: 'own:' + DB.uid(), source: 'own', name: name.trim(), kind: 'own', lat: here.lat, lon: here.lon, ele: null });
      } }, ic('plus'), ' Új hely itt'),
      h('button', { class: 'btn ghost', onclick: () => startHike(null) }, 'Hely nélkül')));
    try {
      here = await getPosition();
      const own = (await DB.all('places')).filter((p) => p.source === 'own');
      own.forEach((p) => (p.distance = Geo.haversine(here, p)));
      const near = [...own.filter((p) => p.distance < 10000), ...(await Catalog.query({ near: here })).slice(0, 40)]
        .sort((a, b) => a.distance - b.distance);
      status.textContent = near.length ? 'A legközelebbi helyek. Koppints arra, ahol most túrázol:' : 'A közelben nincs ismert hely.';
      list.replaceChildren(...near.slice(0, 40).map((p) => placeCard(p, startHike)));
    } catch (e) {
      status.textContent = e && e.code ? geoErrorText(e) : 'Nem sikerült a helyet lekérni.';
    }
  }

  // ---------- live tracking ----------
  function track() {
    const hk = Tracker.hike;
    if (!hk) return go('#/');
    setTitle(hk.place?.name || 'Túra');
    const mapEl = h('div', { class: 'map track-map' });
    const st = { dist: h('b'), time: h('b'), alt: h('b'), acc: h('b') };
    const warn = h('p', { class: 'warn', hidden: true });
    const pauseBtn = h('button', { class: 'round', 'aria-label': 'Szünet', onclick: () => Tracker.state().paused ? Tracker.resume() : Tracker.pause() });
    const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async (e) => {
      for (const f of e.target.files) await addPhoto(Tracker.hike, f, true);
      e.target.value = '';
    } });

    render(mapEl,
      h('div', { class: 'live-card' },
        h('div', { class: 'live-stats' },
          h('div', null, h('span', null, 'Táv'), st.dist), h('div', null, h('span', null, 'Idő'), st.time),
          h('div', null, h('span', null, 'Magasság'), st.alt), h('div', null, h('span', null, 'GPS'), st.acc)),
        warn,
        h('div', { class: 'live-actions' },
          pauseBtn,
          h('button', { class: 'round', 'aria-label': 'Fotó', onclick: () => photoInput.click() }, ic('camera')), photoInput,
          h('button', { class: 'round stop', 'aria-label': 'Befejezés', onclick: async () => {
            if (!confirm('Befejezed a túrát?')) return;
            const done = await Tracker.finish();
            go(`#/hike/${done.id}`);
          } }, ic('stop'))),
        h('button', { class: 'linkbtn danger small', onclick: async () => {
          if (confirm('Biztosan elveted ezt a túrát? Nem menthető vissza.')) { await Tracker.discard(); go('#/hikes'); }
        } }, 'Túra elvetése')));

    // Locate button cycles: follow -> follow + heading-up -> free.
    let follow = 1;
    const map = MapKit.makeMap(mapEl, { center: hk.place ? [hk.place.lon, hk.place.lat] : undefined, zoom: 15,
      locate: async (b) => {
        follow = (follow + 1) % 3;
        if (follow === 2) {
          const ok = await Heading.start();
          if (!ok) { toast('Az iránytű nem engedélyezett, csak haladási irányt mutatok.'); }
        }
        if (follow !== 2) map.easeTo({ bearing: 0, duration: 300 });
        b.classList.toggle('on', follow > 0); b.classList.toggle('heading', follow === 2);
        toast(['Szabad mozgatás', 'Követés', 'Követés + irány felfelé'][follow]);
        refresh(true);
      } });
    cleanup.push(() => map.remove());
    if (map.locateBtn) map.locateBtn.classList.add('on');
    // Like a car GPS: panning frees the map, one tap brings it back and follows again.
    let lastFollow = 1;
    const recenter = h('button', { class: 'recenter', hidden: true, onclick: (e) => {
      e.stopPropagation();
      follow = lastFollow; recenter.hidden = true;
      map.locateBtn?.classList.add('on'); map.locateBtn?.classList.toggle('heading', follow === 2);
      refresh(true);
    } }, ic('locate'), ' Vissza hozzám');
    mapEl.append(recenter);
    map.on('dragstart', () => {
      if (follow) { lastFollow = follow; follow = 0; map.locateBtn?.classList.remove('on', 'heading'); }
      recenter.hidden = false;
    });
    const me = MapKit.meMarker(map);
    let drawn = -1;

    // Route navigation, when the hike was started on a hiking route or trail.
    const navBox = h('div', { class: 'nav-card', hidden: true });
    mapEl.after(navBox);
    let route = hk.navRoute ? Nav.build(hk.navRoute) : null, proj = null, offCount = 0, drawnIdx = -1;
    const navColor = (hk.place?.symbol && { blue: '#1c5fd1', red: '#d22b2b', green: '#1f8a3a', yellow: '#d9a400' }[hk.place.symbol.split(':')[0]]) || '#1c5fd1';
    if (!route && (hk.place?.kind === 'route' || hk.place?.kind === 'trail')) {
      navBox.hidden = false; navBox.textContent = 'Útvonal betöltése…';
      (async () => {
        try {
          const lines = await Places.trailGeometry(hk.place);
          const cur = Tracker.hike; if (!cur) return;
          const pos = cur.lastFix?.lat != null ? cur.lastFix : cur.points[cur.points.length - 1] || hk.place;
          const coords = Nav.chain(lines, pos);
          if (coords.length < 2) { navBox.textContent = 'Ehhez a helyhez nincs útvonal-vonal.'; return; }
          cur.navRoute = coords; route = Nav.build(coords);
          refresh(true);
        } catch (e) {
          DB.logError('nav', e);
          navBox.textContent = 'Az útvonalat nem sikerült betölteni (nincs net, vagy a térképszerver lassú).';
        }
      })();
    }

    function updateNav(cur, fix) {
      if (!route || !fix) return;
      proj = Nav.project(route, fix, proj ? proj.i : 0);
      if (!proj) return;
      const remaining = Math.max(0, route.total - proj.along);
      offCount = proj.off > 50 ? offCount + 1 : 0;
      if (proj.i !== drawnIdx) { drawnIdx = proj.i; MapKit.drawLines(map, 'nav', [Nav.ahead(route, proj)], navColor); }
      const walked = Geo.trackDistance(cur.points);
      const paused = cur.pauses.reduce((a, p) => a + (p.to - p.from), 0) + (cur.pausedAt ? Date.now() - cur.pausedAt : 0);
      const moving = Date.now() - cur.startedAt - paused;
      const speed = walked > 300 && moving > 0 ? walked / moving : 4000 / 3600000; // m/ms; 4 km/h until we know better
      navBox.hidden = false;
      navBox.replaceChildren(...[
        remaining < 40 ? h('strong', { class: 'arrived' }, ic('flag'), ' Megérkeztél a célhoz!')
          : h('div', { class: 'nav-main' }, h('span', null, 'Célig'), h('b', null, Geo.fmtKm(remaining)),
            h('span', { class: 'muted' }, `kb. ${Geo.fmtDur(remaining / speed)}`)),
        offCount >= 2 ? h('p', { class: 'warn' }, `Letértél a kijelölt útról (${Math.round(proj.off)} m). Az útvonal színes vonallal látszik.`) : null,
      ].filter(Boolean));
    }

    // Parked car: one per user, kept between hikes until cleared.
    let car = null, carMarker = null;
    const carRow = h('div', { class: 'car-row' });
    async function drawCar() {
      car = await DB.kvGet('car');
      carMarker?.remove(); carMarker = null;
      if (car) carMarker = MapKit.marker(map, car.lat, car.lon, { cls: 'pin-car', html: Icons.car, popup: 'Itt parkol az autó' });
      const fix = Tracker.hike?.lastFix;
      carRow.replaceChildren(...(car ? [
        h('a', { class: 'chip', href: `https://maps.apple.com/?daddr=${car.lat},${car.lon}&dirflg=w`, target: '_blank', rel: 'noopener' },
          ic('car'), fix?.lat != null ? ` Autóhoz: ${Geo.fmtKm(Geo.haversine(fix, car))}` : ' Autóhoz'),
        h('button', { class: 'chip', onclick: async () => { if (confirm('Törlöd a parkolóhelyet?')) { await DB.kvDel('car'); drawCar(); } } }, 'Parkoló törlése'),
      ] : [
        h('button', { class: 'chip', onclick: async () => {
          const f = Tracker.hike?.lastFix;
          let pos = f?.lat != null ? f : null;
          if (!pos) { try { pos = await getPosition(5000); } catch (e) { return toast(geoErrorText(e), 5000); } }
          await DB.kvSet('car', { lat: pos.lat, lon: pos.lon, t: Date.now(), hikeId: Tracker.hike?.id || null });
          toast('Megjegyeztem, hol parkoltok.'); drawCar();
        } }, ic('car'), ' Itt parkoltam'),
      ]));
    }
    navBox.after(carRow);
    drawCar();
    const carTimer = setInterval(() => { if (car) drawCar(); }, 15000);
    cleanup.push(() => clearInterval(carTimer));

    // Start the compass on the first tap anywhere (iOS needs a gesture for the permission prompt).
    const firstTap = () => { Heading.start(); };
    document.addEventListener('click', firstTap, { once: true });
    cleanup.push(() => document.removeEventListener('click', firstTap));

    cleanup.push(Heading.on((deg) => {
      me.setHeading(deg);
      if (follow === 2 && deg != null) map.rotateTo(deg, { duration: 200 });
    }));

    function refresh(force) {
      const cur = Tracker.hike; if (!cur) return;
      const s = Tracker.state();
      const pts = cur.points, last = pts[pts.length - 1];
      st.dist.textContent = Geo.fmtKm(Geo.trackDistance(pts));
      const paused = cur.pauses.reduce((a, p) => a + (p.to - p.from), 0) + (cur.pausedAt ? Date.now() - cur.pausedAt : 0);
      st.time.textContent = Geo.fmtClock(Date.now() - cur.startedAt - paused);
      st.alt.textContent = last?.alt != null ? `${Math.round(last.alt)} m` : '–';
      st.acc.textContent = cur.lastFix ? `±${Math.round(cur.lastFix.acc)} m` : 'keres…';
      pauseBtn.innerHTML = s.paused ? Icons.play : Icons.pause;
      pauseBtn.classList.toggle('paused', s.paused);
      const msgs = [];
      if (s.paused) msgs.push('Szünetel: a követés áll.');
      if (cur.lastError?.code === 1) msgs.push(geoErrorText(cur.lastError));
      if (!s.paused && !s.wakeLock && 'wakeLock' in navigator) msgs.push('A képernyő lezárhat: koppints a térképre, ha elsötétül.');
      if (!('wakeLock' in navigator)) msgs.push('Állítsd az automatikus zárolást „Soha"-ra a túra idejére, különben a GPS leállhat.');
      warn.hidden = !msgs.length; warn.textContent = msgs.join(' ');
      const fix = cur.lastFix?.lat != null ? cur.lastFix : last;
      if (fix) me.setLngLat([fix.lon, fix.lat]);
      updateNav(cur, fix);
      if (pts.length !== drawn || force) {
        drawn = pts.length;
        MapKit.drawTrack(map, pts);
        if (fix && follow) map.easeTo({ center: [fix.lon, fix.lat], duration: 400 });
      }
    }
    cleanup.push(Tracker.on(() => refresh()));
    const timer = setInterval(() => refresh(), 1000);
    cleanup.push(() => clearInterval(timer));
    refresh(true);
  }

  // ---------- photos ----------
  async function addPhoto(hk, file, live) {
    try {
      const exif = await Exif.read(file);
      const { blob, width, height } = await UI.resizePhoto(file);
      const data = await blob.arrayBuffer();
      let takenAt = live ? Date.now() : (exif.takenAt || file.lastModified);
      let pos = exif.lat != null ? { lat: exif.lat, lon: exif.lon } : null;
      const pts = hk.points;
      if (!pos && live && pts.length) pos = pts[pts.length - 1];
      else if (!pos && pts.length && takenAt >= hk.startedAt - 600000 && takenAt <= (hk.endedAt || Date.now()) + 600000) {
        // Place the photo at the track point closest in time to when it was taken.
        pos = pts.reduce((best, p) => Math.abs(p.t - takenAt) < Math.abs(best.t - takenAt) ? p : best, pts[0]);
      }
      const id = DB.uid();
      await DB.put('photos', { id, hikeId: hk.id, data, type: 'image/jpeg', width, height, takenAt,
        lat: pos?.lat ?? null, lon: pos?.lon ?? null, visibility: hk.visibility || 'private' });
      // Read it back and decode once: if the device cannot, say so now, not at home.
      const back = await DB.get('photos', id);
      await createImageBitmap(DB.photoBlob(back));
      toast(pos ? 'Fotó mentve, a térképre tettem.' : 'Fotó mentve.');
      return true;
    } catch (e) {
      await DB.logError('addPhoto', e);
      toast('A fotót nem sikerült elmenteni: ' + (e.message || e), 6000);
      return false;
    }
  }

  // ---------- post-processing ----------
  async function computeStats(hk) {
    const samples = Geo.resample(hk.points, 40);
    let eles = null, source = 'dem';
    try { eles = await Places.elevations(samples); }
    catch (e) { source = 'gps'; eles = samples.map((s) => s.alt ?? null); }
    if (source === 'gps' && eles.every((e) => e == null)) source = 'none';
    const smoothed = source === 'gps' ? Geo.smooth(eles, 3) : eles;
    const gain = Geo.elevationGain(smoothed, source === 'gps' ? 5 : 2);
    const valid = smoothed.filter((e) => e != null);
    const distance = Geo.trackDistance(hk.points);
    const pausedMs = (hk.pauses || []).reduce((a, p) => a + (p.to - p.from), 0);
    const settings = await DB.settings();
    hk.stats = {
      distance, durationMs: hk.endedAt - hk.startedAt, movingMs: hk.endedAt - hk.startedAt - pausedMs,
      up: source === 'none' ? null : gain.up, down: source === 'none' ? null : gain.down,
      minEle: valid.length ? Math.min(...valid) : null, maxEle: valid.length ? Math.max(...valid) : null,
      stepsEstimate: Geo.estimateSteps(distance, settings.heightCm),
      gaps: hk.points.filter((p) => p.gapBefore).length,
      elevationSource: source,
      profile: samples.map((s, i) => ({ dist: Math.round(s.dist), ele: smoothed[i] == null ? null : Math.round(smoothed[i] * 10) / 10 })),
    };
    await DB.put('hikes', hk);
    return hk;
  }

  // ---------- hike detail ----------
  async function hikeView(id) {
    let hk = await DB.get('hikes', id);
    if (!hk) return go('#/hikes');
    if (hk.status === 'active') return go('#/track');
    setTitle(hk.place?.name || 'Túra');
    if (!hk.stats || hk.stats.elevationSource === 'gps' && navigator.onLine) {
      render(h('p', { class: 'muted' }, 'Útvonal feldolgozása, magasságadatok lekérése…'));
      hk = await computeStats(hk);
    }
    const s = hk.stats;
    const save = async () => { await DB.put('hikes', hk); toast('Mentve.'); };
    let saveTimer;
    const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); };

    const mapEl = h('div', { class: 'map hero' });
    const photosEl = h('div', { class: 'photos' });
    const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async (e) => {
      const files = [...e.target.files];
      toast(`${files.length} fotó feldolgozása…`, 10000);
      let ok = 0;
      for (const f of files) if (await addPhoto(hk, f, false)) ok++;
      e.target.value = ''; toast(`${ok} fotó hozzáadva.`); renderPhotos();
    } });

    const stepsInput = h('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: 'pl. az Egészség appból',
      value: hk.realSteps ?? '', onchange: (e) => { hk.realSteps = e.target.value ? +e.target.value : null; save(); } });

    const ele = (v) => v == null ? '–' : `${Math.round(v)} m`;
    const eleNote = { dem: 'Magasság: domborzati modellből (Open-Meteo), az útvonal mentén.',
      gps: 'Magasság: a telefon GPS-éből (pontatlanabb; net nélkül készült, legközelebb újraszámolom).',
      none: 'Magasság-adat nem érhető el.' }[s.elevationSource];
    const tile = (icon, label, value) => h('div', { class: 'tile' }, ic(icon), h('span', null, label), h('b', null, value));

    const textArea = h('textarea', { rows: 4, placeholder: 'Milyen volt? Útviszonyok, látnivalók, tippek…',
      oninput: (e) => { hk.review.text = e.target.value; saveSoon(); } });
    textArea.value = hk.review.text || '';

    render(
      mapEl,
      h('div', { class: 'row-between' }, h('p', { class: 'muted small date' }, UI.fmtDate(hk.startedAt)),
        h('button', { class: 'fav' + (hk.favorite ? ' on' : ''), 'aria-label': 'Kedvenc', onclick: async (e) => {
          hk.favorite = !hk.favorite; e.currentTarget.classList.toggle('on', hk.favorite);
          await DB.put('hikes', hk); toast(hk.favorite ? 'Kedvencek közé tettem.' : 'Kivettem a kedvencek közül.');
        } }, ic('heart'), ' Kedvenc')),
      h('div', { class: 'tiles' },
        tile('distance', 'Táv', Geo.fmtKm(s.distance)),
        tile('clock', 'Mozgásban', Geo.fmtDur(s.movingMs)),
        tile('steps', 'Lépés (becsült)', (hk.realSteps || s.stepsEstimate).toLocaleString('hu-HU')),
        tile('up', 'Emelkedés', s.up == null ? '–' : `${Math.round(s.up)} m`),
        tile('down', 'Ereszkedés', s.down == null ? '–' : `${Math.round(s.down)} m`),
        tile('peak', 'Legmagasabb', ele(s.maxEle))),
      h('div', { class: 'chart-card' }, UI.elevationChart(s.profile),
        h('p', { class: 'muted small' }, eleNote, s.gaps ? ` ${s.gaps} GPS-kiesés, egyenes vonallal becsülve.` : '',
          ` Teljes idő: ${Geo.fmtDur(s.durationMs)}, legalacsonyabb pont: ${ele(s.minEle)}.`)),
      field('Valós lépésszám (ha tudod)', stepsInput,
        h('small', { class: 'muted' }, 'A becslés a távból és a testmagasságból számol. Az iPhone Egészség appjában látod a pontos számot.')),

      section('Fotók', photosEl,
        h('button', { class: 'btn wide', onclick: () => fileInput.click() }, ic('plus'), ' Fotók a fotóalbumból'), fileInput,
        h('p', { class: 'muted small' }, 'Egyszerre többet is kiválaszthatsz: a készítés ideje (és ha van, a helye) alapján a túra megfelelő pontjára kerülnek.')),

      section('Értékelés',
        UI.stars(hk.review.stars, (v) => { hk.review.stars = v; save(); }),
        field('Vélemény', textArea),
        field('Gyerekbarát?', seg([['Igen', true], ['Nem', false], ['Nem tudom', null]], hk.review.kidFriendly, (v) => { hk.review.kidFriendly = v; save(); })),
        field('Kutyabarát?', seg([['Igen', true], ['Nem', false], ['Nem tudom', null]], hk.review.dogFriendly, (v) => { hk.review.dogFriendly = v; save(); })),
        field('Nehézség', seg(DIFFICULTY.map((d) => [d, d]), hk.review.difficulty, (v) => { hk.review.difficulty = v; save(); }, 'wrap toggle')),
        field('Láthatóság', seg([['Privát', 'private'], ['Megosztott', 'public']], hk.visibility, (v) => { hk.visibility = v || 'private'; save(); })),
        h('p', { class: 'muted small' }, 'A megosztás a szerveres verzióval indul. Addig minden csak ezen a telefonon van.')),

      hk.place ? h('a', { class: 'btn ghost wide', href: `#/place/${encodeURIComponent(hk.place.id)}` }, ic('pin'), ` ${hk.place.name} adatlapja`) : null,
      h('button', { class: 'btn ghost wide', onclick: () => saveAsRoute(hk) }, ic('route'), ' Mentés saját útvonalként'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => exportGpx(hk) }, ic('download'), ' GPX'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Törlöd a túrát a fotóival együtt?')) return;
          for (const p of await DB.byIndex('photos', 'hikeId', hk.id)) await DB.del('photos', p.id);
          await DB.del('hikes', hk.id); go('#/hikes');
        } }, ic('trash'), ' Törlés')));

    const map = MapKit.makeMap(mapEl, { center: hk.place ? [hk.place.lon, hk.place.lat] : undefined, zoom: 13 });
    cleanup.push(() => map.remove());
    MapKit.drawTrack(map, hk.points);
    if (hk.points.length) {
      const f = hk.points[0], l = hk.points[hk.points.length - 1];
      MapKit.marker(map, f.lat, f.lon, { cls: 'pin-start', popup: 'Indulás' });
      MapKit.marker(map, l.lat, l.lon, { cls: 'pin-end', popup: 'Érkezés' });
      MapKit.fitPoints(map, hk.points, 36);
    }
    let photoMarkers = [];
    const urls = [];
    cleanup.push(() => urls.forEach((u) => URL.revokeObjectURL(u)));

    async function renderPhotos() {
      const photos = (await DB.byIndex('photos', 'hikeId', hk.id)).sort((a, b) => a.takenAt - b.takenAt);
      photoMarkers.forEach((m) => m.remove()); photoMarkers = [];
      const gallery = photos.map((p) => { const u = URL.createObjectURL(DB.photoBlob(p)); urls.push(u); return u; });
      photosEl.replaceChildren(...photos.map((p, i) => {
        const url = gallery[i];
        if (p.lat != null) photoMarkers.push(MapKit.marker(map, p.lat, p.lon, { cls: 'pin-photo', html: `<img src="${url}" alt="">`, onClick: () => openPhoto(gallery, i) }));
        const img = h('img', { src: url, loading: 'lazy', alt: '', onclick: () => openPhoto(gallery, i) });
        img.addEventListener('error', () => DB.logError('photo-display', `${p.id} ${p.data ? 'arraybuffer' : 'blob'} ${p.width}x${p.height}`));
        return h('figure', null, img,
          h('button', { class: 'x', 'aria-label': 'Fotó törlése', onclick: async () => {
            if (confirm('Törlöd a fotót?')) { await DB.del('photos', p.id); renderPhotos(); }
          } }, '×'));
      }));
      if (!photos.length) photosEl.append(h('p', { class: 'muted' }, 'Még nincs fotó.'));
    }
    renderPhotos();
  }

  // Full-screen viewer: swipe or arrows to page, close button, swipe down or Esc to close.
  // A walked track becomes a route others could follow later. Marked unofficial with
  // the author's name, and stored like OSM routes (place + 'geom:' lines), so
  // navigation and (later) server sharing work the same way.
  async function saveAsRoute(hk) {
    if (hk.points.length < 2) return toast('Ehhez a túrához nincs útvonal.');
    const st = await DB.settings();
    const name = prompt('Az útvonal neve:', `${hk.place?.name || 'Túra'} – saját útvonal`);
    if (!name) return;
    const lines = [];
    let cur = [];
    hk.points.forEach((p, i) => { if (i && p.segStart) { lines.push(cur); cur = []; } cur.push([p.lon, p.lat]); });
    lines.push(cur);
    const first = hk.points[0];
    const place = { id: 'own:route-' + DB.uid(), source: 'own', kind: 'route', name: name.trim(), lat: first.lat, lon: first.lon, ele: null,
      region: hk.place?.region || null, town: hk.place?.town || null, unofficial: true, author: st.name || 'Én',
      createdAt: Date.now(), fromHike: hk.id, distance: hk.stats?.distance ?? Geo.trackDistance(hk.points), visibility: 'private' };
    await DB.put('places', place);
    await DB.kvSet('geom:' + place.id, lines);
    toast('Elmentettem útvonalként. A Felfedezésben is megtalálod.');
    go(`#/place/${encodeURIComponent(place.id)}`);
  }

  function openPhoto(urls, start = 0) {
    let i = start, x0 = null, y0 = 0;
    const img = h('img', { alt: '' });
    const counter = h('span', { class: 'ov-count' });
    const step = (d) => { i = (i + d + urls.length) % urls.length; show(); };
    const prev = h('button', { class: 'ov-nav prev', 'aria-label': 'Előző kép', onclick: (e) => { e.stopPropagation(); step(-1); } }, ic('back'));
    const next = h('button', { class: 'ov-nav next', 'aria-label': 'Következő kép', onclick: (e) => { e.stopPropagation(); step(1); } }, ic('next'));
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); };
    function show() {
      img.src = urls[i];
      counter.textContent = urls.length > 1 ? `${i + 1} / ${urls.length}` : '';
      prev.hidden = next.hidden = urls.length < 2;
    }
    const ov = h('div', { class: 'overlay', onclick: close }, img, prev, next, counter,
      h('button', { class: 'ov-close', 'aria-label': 'Bezárás', onclick: (e) => { e.stopPropagation(); close(); } }, ic('close')));
    img.addEventListener('click', (e) => e.stopPropagation());
    ov.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
    ov.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
      else if (dy > 100) close();
    });
    document.addEventListener('keydown', onKey);
    show();
    document.body.append(ov);
  }

  function exportGpx(hk) {
    const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    let segs = '', cur = '';
    hk.points.forEach((p, i) => {
      if (i && p.segStart) { segs += `<trkseg>${cur}</trkseg>`; cur = ''; }
      cur += `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`;
    });
    segs += `<trkseg>${cur}</trkseg>`;
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Turanaplo" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(hk.place?.name || 'Túra')}</name>${segs}</trk></gpx>`;
    download(new Blob([gpx], { type: 'application/gpx+xml' }), `tura-${new Date(hk.startedAt).toISOString().slice(0, 10)}.gpx`);
  }

  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- my hikes ----------
  let hikesFilter = 'all';
  const hikeCard = (x) => h('a', { class: 'card hike', href: `#/hike/${x.id}` },
    h('div', { class: 'card-top' }, h('strong', null, x.favorite ? ic('heart', 'heart-ic') : null, x.place?.name || 'Túra'),
      h('span', { class: 'muted small' }, UI.fmtDate(x.startedAt))),
    h('div', { class: 'muted' }, hikeLine(x)),
    x.review?.stars ? h('div', { class: 'stars small' }, '★'.repeat(x.review.stars)) : null);

  async function hikes() {
    setTitle('Túráim', false);
    const active = Tracker.hike;
    const all = (await DB.all('hikes')).filter((x) => x.status === 'finished').sort((a, b) => b.startedAt - a.startedAt);
    const list = hikesFilter === 'fav' ? all.filter((x) => x.favorite) : all;
    const total = all.reduce((a, x) => a + (x.stats?.distance ?? Geo.trackDistance(x.points)), 0);
    const up = all.reduce((a, x) => a + (x.stats?.up || 0), 0);
    render(
      active ? h('a', { class: 'banner', href: '#/track' }, h('span', { class: 'pulse' }), 'Folyamatban: ', active.place?.name || 'Túra', ' ›') : null,
      all.length ? h('div', { class: 'summary' },
        h('div', null, h('b', null, all.length), h('span', null, 'túra')),
        h('div', null, h('b', null, Geo.fmtKm(total)), h('span', null, 'összesen')),
        h('div', null, h('b', null, `${Math.round(up)} m`), h('span', null, 'emelkedés'))) : null,
      all.length ? h('div', { class: 'row-between' }, seg([['Mind', 'all'], ['Kedvencek', 'fav']], hikesFilter, (v) => { hikesFilter = v || 'all'; hikes(); }, 'small')) : null,
      list.length ? h('div', { class: 'list' }, list.map(hikeCard))
        : all.length ? h('p', { class: 'muted' }, 'Még nincs kedvenc túrád. A túra oldalán a szívvel jelölheted meg.')
          : h('div', { class: 'empty' }, ic('book', 'big-ic'), h('p', null, 'Még nincs túrád.'),
            h('p', { class: 'muted small' }, 'Válassz helyet a Felfedezésben, vagy indíts egyet a középső gombbal. A Beállításokban demó túrát is nézhetsz.')));
  }

  // ---------- bucket list ----------
  const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString('hu-HU', { month: 'long', day: 'numeric', weekday: 'short' });
  const today = () => new Date().toISOString().slice(0, 10);

  async function bucketList() {
    setTitle('Bakancslista', false);
    // Saved records may predate the catalogue fields (town, region, ele): merge them in.
    const places = await Promise.all((await DB.all('places')).map((p) => findPlace(p.id)));
    const hikesAll = (await DB.all('hikes')).filter((x) => x.status === 'finished');
    const visitedIds = new Set(hikesAll.map((x) => x.place?.id).filter(Boolean));
    const open = (p) => go(`#/place/${encodeURIComponent(p.id)}`);
    const planned = places.filter((p) => p.wish?.date).sort((a, b) => a.wish.date.localeCompare(b.wish.date));
    const wishes = places.filter((p) => p.wish && !p.wish.date).sort((a, b) => b.wish.addedAt - a.wish.addedAt);
    const favs = hikesAll.filter((x) => x.favorite).sort((a, b) => b.startedAt - a.startedAt);
    const visited = places.filter((p) => visitedIds.has(p.id) || (p.source === 'own' && !p.wish));

    const plannedCard = (p) => {
      const card = placeCard(p, open);
      const past = p.wish.date < today();
      card.querySelector('.place-dist')?.remove();
      card.append(h('span', { class: 'date-chip' + (past ? ' past' : '') }, fmtDay(p.wish.date)));
      return card;
    };

    const empty = !planned.length && !wishes.length && !favs.length && !visited.length;
    render(
      empty ? h('div', { class: 'empty' }, ic('flag', 'big-ic'), h('p', null, 'Még üres a bakancslistád.'),
        h('p', { class: 'muted small' }, 'Egy hely oldalán a „Bakancslistára" gombbal teheted fel, akár dátummal is. A megtett túrákat a szívvel jelölheted kedvencnek.'),
        h('a', { class: 'btn primary', href: '#/' }, ic('explore'), ' Helyek böngészése')) : null,
      planned.length ? section('Tervezett', h('div', { class: 'places' }, planned.map(plannedCard))) : null,
      wishes.length ? section('Egyszer eljutok ide', h('div', { class: 'places' }, wishes.map((p) => placeCard(p, open)))) : null,
      favs.length ? section('Kedvenc túráim', h('div', { class: 'list' }, favs.map(hikeCard))) : null,
      visited.length ? section('Ahol már jártam', h('div', { class: 'places' }, visited.map((p) => {
        const n = hikesAll.filter((x) => x.place?.id === p.id).length;
        const card = placeCard(p, open);
        card.querySelector('small').textContent += n ? ` · ${n} túra` : ' · saját hely';
        return card;
      }))) : null);
  }

  // All-day calendar event; iPhone Safari offers "Add to Calendar" for .ics files.
  function exportIcs(p) {
    const d = p.wish.date.replace(/-/g, '');
    const next = new Date(p.wish.date + 'T12:00:00'); next.setDate(next.getDate() + 1);
    const d2 = next.toISOString().slice(0, 10).replace(/-/g, '');
    const esc = (t) => String(t).replace(/[\\,;]/g, (c) => '\\' + c);
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Turanaplo//HU', 'BEGIN:VEVENT',
      `UID:${p.id.replace(/[^a-z0-9]/gi, '')}-${d}@turanaplo`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${d2}`, `SUMMARY:${esc('Túra: ' + p.name)}`,
      `LOCATION:${esc([p.name, p.town, p.region].filter(Boolean).join(', '))}`, `GEO:${p.lat};${p.lon}`,
      `DESCRIPTION:${esc(appleMaps(p.lat, p.lon))}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    download(new Blob([ics], { type: 'text/calendar' }), `tura-${d}.ics`);
  }

  // ---------- settings ----------
  const DEMO_ROUTE = [[47.5049, 18.9634], [47.5075, 18.9600], [47.5102, 18.9575], [47.5130, 18.9560],
    [47.5160, 18.9568], [47.5186, 18.9586], [47.5170, 18.9625], [47.5140, 18.9650], [47.5100, 18.9660], [47.5060, 18.9645]];

  async function makeDemo() {
    const pts = [];
    let t = Date.now() - 3 * 3600000;
    for (let i = 1; i < DEMO_ROUTE.length; i++) {
      const [a, b] = [DEMO_ROUTE[i - 1], DEMO_ROUTE[i]];
      const n = Math.max(1, Math.round(Geo.haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) / 15));
      for (let k = 0; k < n; k++) {
        pts.push({ t, lat: a[0] + ((b[0] - a[0]) * k) / n + (Math.random() - 0.5) * 0.00003,
          lon: a[1] + ((b[1] - a[1]) * k) / n + (Math.random() - 0.5) * 0.00003, alt: null, acc: 8 });
        t += 13000;
      }
    }
    const place = await Places.remember({ id: 'own:demo-janoshegy', source: 'own', name: 'János-hegy (demó)', kind: 'own', lat: 47.5186, lon: 18.9586, ele: null });
    const hk = { id: DB.uid(), status: 'finished', startedAt: pts[0].t, endedAt: t, points: pts, pauses: [], visibility: 'private',
      place: stripPlace(place),
      review: { stars: 4, text: 'Demó túra: Normafától a János-hegyi kilátóig és vissza.', kidFriendly: true, dogFriendly: true, difficulty: 'Könnyű' } };
    await DB.put('hikes', hk);
    go(`#/hike/${hk.id}`);
  }

  async function backup(withPhotos) {
    const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    const data = { app: 'turanaplo', version: 2, exportedAt: new Date().toISOString(),
      hikes: await DB.all('hikes'), places: await DB.all('places'), reports: await DB.all('reports'), photos: [] };
    if (withPhotos) for (const p of await DB.all('photos')) {
      const buf = p.data || await p.blob.arrayBuffer();
      const { blob, data: _d, ...rest } = p;
      data.photos.push({ ...rest, type: p.type || 'image/jpeg', b64: toB64(buf) });
    }
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `turanaplo-mentes-${new Date().toISOString().slice(0, 10)}.json`);
  }

  async function restore(file) {
    const data = JSON.parse(await file.text());
    if (data.app !== 'turanaplo') throw new Error('Nem Túranapló mentés');
    for (const x of data.hikes || []) await DB.put('hikes', x);
    for (const x of data.places || []) await DB.put('places', x);
    for (const x of data.reports || []) await DB.put('reports', x);
    for (const x of data.photos || []) {
      const { b64, blob, ...rest } = x;
      const buf = b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer : await (await (await fetch(blob)).blob()).arrayBuffer();
      await DB.put('photos', { ...rest, data: buf });
    }
  }

  async function settings() {
    setTitle('Beállítások', false);
    const st = await DB.settings();
    const height = h('input', { type: 'number', inputmode: 'numeric', min: 100, max: 230, value: st.heightCm ?? '', placeholder: 'cm',
      onchange: async (e) => { st.heightCm = e.target.value ? +e.target.value : null; await DB.saveSettings(st); toast('Mentve.'); } });
    const restoreInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
      try { await restore(e.target.files[0]); toast('Visszatöltve.'); go('#/hikes'); } catch (err) { toast('Hibás mentésfájl.'); }
    } });
    let persisted = null;
    try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* not supported */ }
    const errors = (await DB.kvGet('errors')) || [];

    render(
      section(null, field('Testmagasság (a lépésszám becsléséhez)', height),
        field('A neved (a saját útvonalaidon ez látszik szerzőként)', h('input', { type: 'text', value: st.name || '', placeholder: 'pl. Tomi',
          onchange: async (e) => { st.name = e.target.value.trim() || null; await DB.saveSettings(st); toast('Mentve.'); } }))),
      section('Adatok',
        h('p', { class: 'muted small' }, 'Minden adat (túrák, fotók, vélemények) most csak ezen a telefonon van. Időnként mentsd le, és tedd a Fájlok appba vagy Dropboxba.',
          persisted === false ? ' A Safari hosszabb használaton kívüli idő után törölheti a weboldalak adatait, ezért a mentés most különösen fontos.' : ''),
        h('div', { class: 'actions wrap' },
          h('button', { class: 'btn', onclick: () => backup(true) }, 'Mentés fotókkal'),
          h('button', { class: 'btn', onclick: () => backup(false) }, 'Mentés fotók nélkül'),
          h('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Visszatöltés'), restoreInput)),
      section('Kipróbálás',
        h('div', { class: 'actions wrap' },
          h('button', { class: 'btn', onclick: makeDemo }, 'Demó túra'),
          h('button', { class: 'btn', onclick: async () => {
            if (Tracker.hike) return toast('Már fut egy túra.');
            await Tracker.start({ id: 'own:demo-janoshegy', name: 'Szimulált séta', kind: 'own', lat: DEMO_ROUTE[0][0], lon: DEMO_ROUTE[0][1] });
            Tracker.simulate(DEMO_ROUTE, 250); go('#/track');
          } }, 'Követés szimulálása')),
        h('p', { class: 'muted small' }, 'A demó túra a Normafa–János-hegy körön mutatja meg a túra adatlapját. A szimuláció kitalált GPS-pontokkal játssza le a követést.')),
      section('Hibanapló',
        errors.length ? h('div', null,
          h('pre', { class: 'log' }, errors.slice(-10).reverse().map((e) => `${new Date(e.t).toLocaleString('hu-HU')} ${e.where}: ${e.msg}${e.n ? ` (×${e.n})` : ''}`).join('\n')),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', onclick: async () => {
              const text = errors.map((e) => `${new Date(e.t).toISOString()} ${e.where}: ${e.msg} | ${e.ua}`).join('\n');
              try { await navigator.clipboard.writeText(text); toast('Kimásolva, küldd el Telegramon.'); } catch (err) { toast('Nem sikerült másolni.'); }
            } }, 'Másolás'),
            h('button', { class: 'btn ghost', onclick: async () => { await DB.kvDel('errors'); settings(); } }, 'Törlés')))
          : h('p', { class: 'muted small' }, 'Nincs hiba.')),
      section('Veszélyzóna',
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Minden túra, fotó, hely és jelzés törlődik erről a telefonról. Biztos?')) return;
          if (Tracker.hike) await Tracker.discard();
          for (const s of ['hikes', 'photos', 'places', 'reports']) await DB.clear(s);
          toast('Minden adat törölve.'); go('#/');
        } }, 'Minden adat törlése')),
      h('p', { class: 'muted small' }, 'Térkép: OpenFreeMap, © OpenStreetMap közreműködők, OpenTopoMap, Waymarked Trails. Magasság: Open-Meteo.'));
  }

  // ---------- router ----------
  const TABS = { explore: ['', 'explore', 'place'], hikes: ['hikes', 'hike', 'track'], places: ['bucket', 'myplaces'], settings: ['settings'] };

  async function route() {
    cleanup.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    cleanup = [];
    document.body.classList.remove('map-full');
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    tabbar.querySelectorAll('a[data-tab]').forEach((a) => a.classList.toggle('on', TABS[a.dataset.tab].includes(parts[0])));
    document.body.classList.toggle('tracking', parts[0] === 'track');
    window.scrollTo(0, 0);
    try {
      switch (parts[0]) {
        case 'start': return await start();
        case 'track': return track();
        case 'hike': return await hikeView(parts[1]);
        case 'hikes': return await hikes();
        case 'bucket': case 'myplaces': return await bucketList();
        case 'place': return await placeView(decodeURIComponent(parts.slice(1).join('/')));
        case 'settings': return await settings();
        default: return await explore();
      }
    } catch (err) {
      console.error(err);
      DB.logError('route:' + parts[0], err);
      render(h('p', { class: 'warn' }, 'Hiba történt: ', err.message || String(err)), h('a', { class: 'btn', href: '#/' }, 'Kezdőlap'));
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('error', (e) => DB.logError('window', e.message));
  window.addEventListener('unhandledrejection', (e) => DB.logError('promise', e.reason));

  // Tab bar icons + the round start button (also shows when a hike is running).
  tabbar.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', Icons[el.dataset.icon]));
  const fab = document.getElementById('fab');
  const updateFab = () => {
    const running = !!Tracker.hike;
    fab.classList.toggle('running', running);
    fab.innerHTML = running ? Icons.route : Icons.play;
    fab.setAttribute('aria-label', running ? 'Futó túra' : 'Túra indítása');
  };
  fab.addEventListener('click', () => go(Tracker.hike ? '#/track' : '#/start'));
  Tracker.on(updateFab);

  (async () => {
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (e) { /* best effort */ }
    await Tracker.restore();
    updateFab();
    if (Tracker.hike && !location.hash.startsWith('#/track')) location.hash = '#/track';
    route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
  })();

  window.App = { computeStats };
})();
