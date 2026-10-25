// Views + hash router.
(function () {
  const { h, toast } = UI;
  const view = document.getElementById('view');
  const titleEl = document.getElementById('title');
  const backBtn = document.getElementById('backBtn');
  let cleanup = [];

  const DIFFICULTY = ['Könnyű', 'Közepes', 'Nehéz', 'Nagyon nehéz'];
  const REPORT_TYPES = ['Lezárt / járhatatlan út', 'Hiányzó vagy rossz jelzés', 'Kidőlt fa, akadály',
    'Bezárt / megszűnt létesítmény', 'Új vagy változott útvonal', 'Egyéb'];

  backBtn.addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#/'));

  // replaceChildren would print null/false as text, so drop them first.
  const render = (...kids) => view.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

  function setTitle(t, back = true) { titleEl.textContent = t; backBtn.hidden = !back; }
  const go = (hash) => { location.hash = hash; };

  // ---------- helpers ----------
  function triState(label, value, onChange) {
    const opts = [[true, 'Igen'], [false, 'Nem'], [null, 'Nem tudom']];
    const wrap = h('div', { class: 'seg' });
    const render = () => wrap.replaceChildren(...opts.map(([v, t]) =>
      h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => { value = v; render(); onChange(v); } }, t)));
    render();
    return h('div', { class: 'field' }, h('label', null, label), wrap);
  }

  function choice(label, options, value, onChange) {
    const wrap = h('div', { class: 'seg wrap' });
    const render = () => wrap.replaceChildren(...options.map((t) =>
      h('button', { type: 'button', class: t === value ? 'on' : '', onclick: () => { value = value === t ? null : t; render(); onChange(value); } }, t)));
    render();
    return h('div', { class: 'field' }, h('label', null, label), wrap);
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Nincs helymeghatározás'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    });
  }

  function geoErrorText(e) {
    if (e && e.code === 1) return 'A helymeghatározás tiltva van. iPhone-on: Beállítások › Adatvédelem › Helymeghatározás › Safari: „App használatakor".';
    if (e && e.code === 3) return 'Nem jött GPS-jel időben. Próbáld szabad ég alatt.';
    return 'Nem sikerült a helyet lekérni.';
  }

  function placeRow(p, onPick) {
    return h('button', { class: 'row', onclick: () => onPick(p) },
      h('span', { class: 'kind' }, Places.KIND[p.kind] || 'Hely'),
      h('span', { class: 'name' }, p.name, p.detail ? h('small', null, ' · ', p.detail) : null),
      h('span', { class: 'dist' }, p.distance != null ? Geo.fmtKm(p.distance) : (p.ele ? `${Math.round(p.ele)} m` : '')));
  }

  function hikeStatsLine(hk) {
    const s = hk.stats || {};
    const dist = s.distance ?? Geo.trackDistance(hk.points);
    return [Geo.fmtKm(dist), Geo.fmtDur((hk.endedAt || Date.now()) - hk.startedAt),
      s.up != null ? `↑ ${Math.round(s.up)} m` : null].filter(Boolean).join(' · ');
  }

  // ---------- home ----------
  async function home() {
    setTitle('Túranapló', false);
    const active = Tracker.hike;
    const hikes = (await DB.all('hikes')).filter((x) => x.status === 'finished').sort((a, b) => b.startedAt - a.startedAt);
    render(
      active ? h('a', { class: 'banner', href: '#/track' }, '● Folyamatban: ', active.place?.name || 'Túra', ' › folytatás') : null,
      !active ? h('a', { class: 'btn big primary', href: '#/start' }, 'Új túra indítása') : null,
      h('div', { class: 'links' }, h('a', { href: '#/places' }, 'Helyek'), h('a', { href: '#/settings' }, 'Beállítások')),
      h('h2', null, 'Túráim'),
      hikes.length ? h('div', { class: 'list' }, hikes.map((hk) =>
        h('a', { class: 'card', href: `#/hike/${hk.id}` },
          h('div', { class: 'card-top' }, h('strong', null, hk.place?.name || 'Túra'), h('span', { class: 'muted' }, UI.fmtDate(hk.startedAt))),
          h('div', { class: 'muted' }, hikeStatsLine(hk)),
          hk.review?.stars ? h('div', { class: 'stars small' }, '★'.repeat(hk.review.stars)) : null)))
        : h('p', { class: 'muted' }, 'Még nincs túra. Indíts egyet, vagy a Beállításokban nézz meg egy demó túrát.'));
  }

  // ---------- start: pick a place ----------
  async function start() {
    if (Tracker.hike) return go('#/track');
    setTitle('Hol vagy?');
    const status = h('p', { class: 'muted' }, 'Helyzet lekérése…');
    const list = h('div', { class: 'list' });
    const mapEl = h('div', { class: 'map small' });
    const input = h('input', { type: 'search', placeholder: 'Keresés névre (pl. Csóványos, Kéktúra)…', enterkeyhint: 'search' });
    let here = null, map = null, markers = null;

    const pick = async (p) => {
      const place = p ? await Places.remember(p) : null;
      await Tracker.start(place ? { id: place.id, name: place.name, kind: place.kind, lat: place.lat, lon: place.lon } : null);
      go('#/track');
    };

    const show = (places, heading) => {
      list.replaceChildren(h('h3', null, heading), ...places.slice(0, 40).map((p) => placeRow(p, pick)));
      if (map) {
        markers.clearLayers();
        places.slice(0, 40).forEach((p) => L.marker([p.lat, p.lon], { icon: UI.dot('#2f5d3a') }).bindPopup(p.name).on('popupopen', () => {}).addTo(markers));
      }
    };

    const form = h('form', { class: 'searchbar', onsubmit: async (e) => {
      e.preventDefault();
      const q = input.value.trim(); if (!q) return;
      status.textContent = 'Keresés…';
      try {
        const res = await Places.search(q, here);
        status.textContent = res.length ? '' : 'Nincs találat.';
        show(res, 'Találatok');
      } catch (err) { status.textContent = 'A keresés nem sikerült (nincs net?).'; }
    } }, input, h('button', { class: 'btn' }, 'Keres'));

    const own = h('button', { class: 'btn', onclick: async () => {
      if (!here) return toast('Előbb kell egy GPS-pozíció.');
      const name = prompt('A hely neve:');
      if (!name) return;
      pick({ id: 'own:' + DB.uid(), source: 'own', name: name.trim(), kind: 'own', lat: here.lat, lon: here.lon, ele: null });
    } }, '+ Új hely itt');

    render(form, mapEl, status, list,
      h('div', { class: 'actions' }, own, h('button', { class: 'btn ghost', onclick: () => pick(null) }, 'Indítás hely nélkül')));

    map = UI.makeMap(mapEl, (await DB.settings()).mapLayer);
    markers = L.layerGroup().addTo(map);
    cleanup.push(() => map.remove());

    // Remembered places first: works offline and shows our own spots.
    const known = await DB.all('places');
    try {
      here = await getPosition();
      map.setView([here.lat, here.lon], 13);
      L.marker([here.lat, here.lon], { icon: UI.dot('#1c7ed6') }).addTo(map);
      known.forEach((p) => (p.distance = Geo.haversine(here, p)));
      const nearKnown = known.filter((p) => p.distance < 15000).sort((a, b) => a.distance - b.distance);
      if (nearKnown.length) show(nearKnown, 'Korábbi helyeid a közelben');
      status.textContent = 'Közeli helyek keresése a térképadatbázisban…';
      const ids = new Set(nearKnown.map((p) => p.id));
      const merge = (near) => show([...nearKnown, ...near.filter((p) => !ids.has(p.id))], 'A közelben');
      const near = await Places.nearby(here.lat, here.lon, 8000, (partial) => { if (partial.length) merge(partial); });
      status.textContent = near.length ? '' : 'A közelben nincs ismert kirándulóhely. Keress névre, vagy vegyél fel újat.';
      merge(near);
    } catch (err) {
      status.textContent = err && err.code ? geoErrorText(err) : 'A közeli helyek nem töltődtek be (nincs net?). Keress névre, vagy indíts hely nélkül.';
      if (known.length) show(known, 'Korábbi helyeid');
    }
  }

  // ---------- live tracking ----------
  function track() {
    const hk = Tracker.hike;
    if (!hk) return go('#/');
    setTitle(hk.place?.name || 'Túra');
    const mapEl = h('div', { class: 'map tall' });
    const st = { dist: h('b'), time: h('b'), alt: h('b'), acc: h('b') };
    const warn = h('p', { class: 'warn', hidden: true });
    const pauseBtn = h('button', { class: 'btn', onclick: () => Tracker.state().paused ? Tracker.resume() : Tracker.pause() }, 'Szünet');
    const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async (e) => {
      for (const f of e.target.files) await addPhoto(Tracker.hike, f, true);
      e.target.value = ''; toast('Fotó mentve.'); refresh();
    } });

    render(mapEl,
      h('div', { class: 'stats live' },
        h('div', null, h('span', null, 'Táv'), st.dist), h('div', null, h('span', null, 'Idő'), st.time),
        h('div', null, h('span', null, 'Magasság'), st.alt), h('div', null, h('span', null, 'GPS'), st.acc)),
      warn,
      h('div', { class: 'actions' },
        pauseBtn,
        h('button', { class: 'btn', onclick: () => photoInput.click() }, 'Fotó'), photoInput,
        h('button', { class: 'btn primary', onclick: async () => {
          if (!confirm('Befejezed a túrát?')) return;
          const done = await Tracker.finish();
          go(`#/hike/${done.id}`);
        } }, 'Befejezés')),
      h('button', { class: 'linkbtn danger', onclick: async () => {
        if (confirm('Biztosan elveted ezt a túrát? Nem menthető vissza.')) { await Tracker.discard(); go('#/'); }
      } }, 'Túra elvetése'),
      h('p', { class: 'muted small' }, 'Tartsd nyitva az appot: zárolt képernyőnél az iPhone leállíthatja a GPS-t. A kiesett szakaszt szaggatott vonal jelzi, és egyenes vonalként számolódik.'));

    const map = UI.makeMap(mapEl);
    const group = L.layerGroup().addTo(map);
    const me = L.marker([47.5, 19], { icon: UI.dot('#1c7ed6') }).addTo(map);
    let follow = true, drawn = -1;
    map.on('dragstart', () => (follow = false));
    cleanup.push(() => map.remove());
    if (hk.place?.lat) map.setView([hk.place.lat, hk.place.lon], 15);

    function refresh() {
      const cur = Tracker.hike; if (!cur) return;
      const s = Tracker.state();
      const pts = cur.points, last = pts[pts.length - 1];
      st.dist.textContent = Geo.fmtKm(Geo.trackDistance(pts));
      const paused = cur.pauses.reduce((a, p) => a + (p.to - p.from), 0) + (cur.pausedAt ? Date.now() - cur.pausedAt : 0);
      st.time.textContent = Geo.fmtDur(Date.now() - cur.startedAt - paused);
      st.alt.textContent = last?.alt != null ? `${Math.round(last.alt)} m` : '–';
      st.acc.textContent = cur.lastFix ? `±${Math.round(cur.lastFix.acc)} m` : 'keres…';
      pauseBtn.textContent = s.paused ? 'Folytatás' : 'Szünet';
      const msgs = [];
      if (s.paused) msgs.push('Szünetel: a követés áll.');
      if (cur.lastError?.code === 1) msgs.push(geoErrorText(cur.lastError));
      if (!s.paused && !s.wakeLock && 'wakeLock' in navigator) msgs.push('A képernyő magától lezárhat: koppints a térképre, ha elsötétül.');
      if (!('wakeLock' in navigator)) msgs.push('Ez a böngésző nem tudja ébren tartani a képernyőt. Állítsd az automatikus zárolást „Soha"-ra a túra idejére.');
      warn.hidden = !msgs.length; warn.textContent = msgs.join(' ');
      if (pts.length !== drawn) {
        drawn = pts.length;
        UI.drawTrack(map, pts, group);
        if (last) { me.setLatLng([last.lat, last.lon]); if (follow) map.setView([last.lat, last.lon], Math.max(map.getZoom(), 15)); }
      }
    }
    cleanup.push(Tracker.on(refresh));
    const timer = setInterval(refresh, 1000);
    cleanup.push(() => clearInterval(timer));
    refresh();
  }

  // ---------- photos ----------
  async function addPhoto(hk, file, live) {
    const { blob, width, height } = await UI.resizePhoto(file);
    let pos = null, takenAt = live ? Date.now() : file.lastModified;
    const pts = hk.points;
    if (live && pts.length) pos = pts[pts.length - 1];
    else if (pts.length && takenAt >= hk.startedAt - 600000 && takenAt <= (hk.endedAt || Date.now()) + 600000) {
      // Place the photo at the track point closest in time to the file's timestamp.
      pos = pts.reduce((best, p) => Math.abs(p.t - takenAt) < Math.abs(best.t - takenAt) ? p : best, pts[0]);
    }
    await DB.put('photos', { id: DB.uid(), hikeId: hk.id, blob, width, height, takenAt,
      lat: pos?.lat ?? null, lon: pos?.lon ?? null, visibility: hk.visibility || 'private' });
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
    if (!hk) return go('#/');
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

    const mapEl = h('div', { class: 'map' });
    const photosEl = h('div', { class: 'photos' });
    const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async (e) => {
      toast('Fotók feldolgozása…', 8000);
      for (const f of e.target.files) await addPhoto(hk, f, false);
      e.target.value = ''; toast('Fotók hozzáadva.'); renderPhotos();
    } });

    const stepsInput = h('input', { type: 'number', inputmode: 'numeric', min: 0, placeholder: 'pl. az Egészség appból',
      value: hk.realSteps ?? '', onchange: (e) => { hk.realSteps = e.target.value ? +e.target.value : null; save(); } });

    const ele = (v) => v == null ? '–' : `${Math.round(v)} m`;
    const eleNote = { dem: 'Magasság: domborzati modellből (Open-Meteo), a GPS-útvonal mentén.',
      gps: 'Magasság: a telefon GPS-éből (pontatlanabb; net nélkül készült, legközelebb újraszámolom).',
      none: 'Magasság-adat nem érhető el.' }[s.elevationSource];

    const textArea = h('textarea', { rows: 4, placeholder: 'Milyen volt? Útviszonyok, látnivalók, tippek…',
      oninput: (e) => { hk.review.text = e.target.value; saveSoon(); } });
    textArea.value = hk.review.text || '';

    render(
      mapEl,
      h('div', { class: 'stats' },
        h('div', null, h('span', null, 'Táv'), h('b', null, Geo.fmtKm(s.distance))),
        h('div', null, h('span', null, 'Időtartam'), h('b', null, Geo.fmtDur(s.durationMs))),
        h('div', null, h('span', null, 'Mozgásban'), h('b', null, Geo.fmtDur(s.movingMs))),
        h('div', null, h('span', null, 'Lépés (becsült)'), h('b', null, s.stepsEstimate.toLocaleString('hu-HU'))),
        h('div', null, h('span', null, 'Emelkedés'), h('b', null, s.up == null ? '–' : `↑ ${Math.round(s.up)} m`)),
        h('div', null, h('span', null, 'Ereszkedés'), h('b', null, s.down == null ? '–' : `↓ ${Math.round(s.down)} m`)),
        h('div', null, h('span', null, 'Legalacsonyabb'), h('b', null, ele(s.minEle))),
        h('div', null, h('span', null, 'Legmagasabb'), h('b', null, ele(s.maxEle)))),
      UI.elevationChart(s.profile),
      h('p', { class: 'muted small' }, UI.fmtDate(hk.startedAt), ' · ', eleNote,
        s.gaps ? ` ${s.gaps} GPS-kiesés, egyenes vonallal becsülve.` : ''),
      h('div', { class: 'field' }, h('label', null, 'Valós lépésszám (ha tudod)'), stepsInput,
        h('small', { class: 'muted' }, 'A becslés a megtett távból és a testmagasságból számol. Az iPhone Egészség appjában látod a pontos számot.')),

      h('h2', null, 'Fotók'), photosEl,
      h('button', { class: 'btn', onclick: () => fileInput.click() }, '+ Fotók hozzáadása'), fileInput,

      h('h2', null, 'Értékelés'),
      UI.stars(hk.review.stars, (v) => { hk.review.stars = v; save(); }),
      h('div', { class: 'field' }, h('label', null, 'Vélemény'), textArea),
      triState('Gyerekbarát?', hk.review.kidFriendly, (v) => { hk.review.kidFriendly = v; save(); }),
      triState('Kutyabarát?', hk.review.dogFriendly, (v) => { hk.review.dogFriendly = v; save(); }),
      choice('Nehézség', DIFFICULTY, hk.review.difficulty, (v) => { hk.review.difficulty = v; save(); }),
      choice('Láthatóság', ['Privát', 'Megosztott'], hk.visibility === 'public' ? 'Megosztott' : 'Privát',
        (v) => { hk.visibility = v === 'Megosztott' ? 'public' : 'private'; save(); }),
      h('p', { class: 'muted small' }, 'A megosztás a szerveres verzióval indul. Addig minden csak ezen a telefonon van.'),

      hk.place ? h('a', { class: 'btn ghost', href: `#/place/${encodeURIComponent(hk.place.id)}` }, `A hely adatlapja: ${hk.place.name}`) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => exportGpx(hk) }, 'GPX letöltése'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Törlöd a túrát a fotóival együtt?')) return;
          for (const p of await DB.byIndex('photos', 'hikeId', hk.id)) await DB.del('photos', p.id);
          await DB.del('hikes', hk.id); go('#/');
        } }, 'Törlés')));

    const map = UI.makeMap(mapEl, (await DB.settings()).mapLayer);
    cleanup.push(() => map.remove());
    const group = UI.drawTrack(map, hk.points);
    if (hk.points.length) {
      const f = hk.points[0], l = hk.points[hk.points.length - 1];
      L.marker([f.lat, f.lon], { icon: UI.dot('#2b8a3e') }).bindPopup('Indulás').addTo(group);
      L.marker([l.lat, l.lon], { icon: UI.dot('#c92a2a') }).bindPopup('Érkezés').addTo(group);
      map.fitBounds(L.latLngBounds(hk.points.map((p) => [p.lat, p.lon])), { padding: [24, 24] });
    } else if (hk.place?.lat) map.setView([hk.place.lat, hk.place.lon], 14);
    const photoLayer = L.layerGroup().addTo(map);
    const urls = [];
    cleanup.push(() => urls.forEach((u) => URL.revokeObjectURL(u)));

    async function renderPhotos() {
      const photos = (await DB.byIndex('photos', 'hikeId', hk.id)).sort((a, b) => a.takenAt - b.takenAt);
      photoLayer.clearLayers();
      photosEl.replaceChildren(...photos.map((p) => {
        const url = URL.createObjectURL(p.blob); urls.push(url);
        if (p.lat != null) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'photo-pin', html: `<img src="${url}">`, iconSize: [36, 36] }) })
          .bindPopup(`<img src="${url}" class="popup-img">`).addTo(photoLayer);
        return h('figure', null, h('img', { src: url, loading: 'lazy', onclick: () => openPhoto(url) }),
          h('button', { class: 'x', 'aria-label': 'Fotó törlése', onclick: async () => {
            if (confirm('Törlöd a fotót?')) { await DB.del('photos', p.id); renderPhotos(); }
          } }, '×'));
      }));
      if (!photos.length) photosEl.append(h('p', { class: 'muted' }, 'Még nincs fotó.'));
    }
    renderPhotos();
  }

  function openPhoto(url) {
    const ov = h('div', { class: 'overlay', onclick: () => ov.remove() }, h('img', { src: url }));
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

  // ---------- places ----------
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

  const tag = (on, label) => on == null ? null : h('span', { class: 'tag' + (on ? ' yes' : ' no') }, (on ? '✓ ' : '✗ ') + label);

  async function placesList() {
    setTitle('Helyek');
    const places = (await DB.all('places')).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const rows = await Promise.all(places.map(async (p) => {
      const sm = await placeSummary(p.id);
      return h('a', { class: 'card', href: `#/place/${encodeURIComponent(p.id)}` },
        h('div', { class: 'card-top' }, h('strong', null, p.name), h('span', { class: 'muted' }, Places.KIND[p.kind] || '')),
        h('div', { class: 'muted' }, `${sm.hikes.length} túra`, sm.avg ? ` · ${'★'.repeat(Math.round(sm.avg))}` : ''),
        h('div', { class: 'tags' }, tag(sm.kid, 'gyerekbarát'), tag(sm.dog, 'kutyabarát'), sm.difficulty ? h('span', { class: 'tag' }, sm.difficulty) : null));
    }));
    render(rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'Még nincs elmentett hely. A túra indításakor választott helyek ide kerülnek.'));
  }

  async function placeView(id) {
    const p = await DB.get('places', id);
    if (!p) return go('#/places');
    setTitle(p.name);
    const sm = await placeSummary(id);
    const reports = (await DB.byIndex('reports', 'placeId', id)).sort((a, b) => b.createdAt - a.createdAt);
    const mapEl = h('div', { class: 'map small' });

    let rType = null;
    const rText = h('textarea', { rows: 3, placeholder: 'Mi változott? (pl. „a piros jelzés a forrásnál eltűnt")' });
    const reportForm = h('div', { class: 'panel', hidden: true },
      choice('Mi a változás?', REPORT_TYPES, null, (v) => (rType = v)), rText,
      h('button', { class: 'btn primary', onclick: async () => {
        if (!rType) return toast('Válaszd ki, mi változott.');
        let pos = null; try { pos = await getPosition(); } catch (e) { /* location is optional */ }
        await DB.put('reports', { id: DB.uid(), placeId: id, type: rType, text: rText.value.trim(), createdAt: Date.now(),
          lat: pos?.lat ?? null, lon: pos?.lon ?? null, status: 'open' });
        toast('Jelzés mentve.'); placeView(id);
      } }, 'Jelzés mentése'));

    render(mapEl,
      h('p', { class: 'muted' }, Places.KIND[p.kind] || 'Hely', p.ele ? ` · ${Math.round(p.ele)} m` : '',
        p.source === 'osm' ? ' · forrás: OpenStreetMap' : ' · saját hely'),
      h('div', { class: 'tags' }, sm.avg ? h('span', { class: 'tag' }, `${sm.avg.toFixed(1).replace('.', ',')} ★`) : null,
        tag(sm.kid, 'gyerekbarát'), tag(sm.dog, 'kutyabarát'), sm.difficulty ? h('span', { class: 'tag' }, sm.difficulty) : null),
      p.source === 'own' ? h('button', { class: 'linkbtn', onclick: async () => {
        const name = prompt('Új név:', p.name); if (!name) return;
        p.name = name.trim(); await DB.put('places', p);
        for (const x of sm.hikes) { x.place.name = p.name; await DB.put('hikes', x); }
        placeView(id);
      } }, 'Átnevezés') : null,
      h('h2', null, 'Túráim itt'),
      sm.hikes.length ? h('div', { class: 'list' }, sm.hikes.map((x) => h('a', { class: 'card', href: `#/hike/${x.id}` },
        h('div', { class: 'card-top' }, h('strong', null, UI.fmtDate(x.startedAt)), x.review.stars ? h('span', { class: 'stars small' }, '★'.repeat(x.review.stars)) : null),
        h('div', { class: 'muted' }, hikeStatsLine(x)), x.review.text ? h('p', { class: 'quote' }, x.review.text) : null)))
        : h('p', { class: 'muted' }, 'Még nincs túra ezen a helyen.'),
      h('h2', null, 'Változások'),
      reports.length ? h('div', { class: 'list' }, reports.map((r) => h('div', { class: 'card' },
        h('div', { class: 'card-top' }, h('strong', null, r.type), h('span', { class: 'muted' }, UI.fmtDate(r.createdAt))),
        r.text ? h('p', null, r.text) : null,
        h('button', { class: 'linkbtn', onclick: async () => { r.status = r.status === 'open' ? 'resolved' : 'open'; await DB.put('reports', r); placeView(id); } },
          r.status === 'open' ? 'Megjelölés: már rendben' : 'Újranyitás'),
        r.status !== 'open' ? h('span', { class: 'tag yes' }, 'rendben') : null)))
        : h('p', { class: 'muted' }, 'Nincs jelzett változás.'),
      h('button', { class: 'btn', onclick: () => (reportForm.hidden = !reportForm.hidden) }, 'Változás jelzése'), reportForm);

    const map = UI.makeMap(mapEl, (await DB.settings()).mapLayer);
    cleanup.push(() => map.remove());
    map.setView([p.lat, p.lon], 14);
    L.marker([p.lat, p.lon], { icon: UI.dot('#2f5d3a') }).addTo(map);
    reports.filter((r) => r.lat != null).forEach((r) => L.marker([r.lat, r.lon], { icon: UI.dot('#f08c00') }).bindPopup(r.type).addTo(map));
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
      place: { id: place.id, name: place.name, kind: place.kind, lat: place.lat, lon: place.lon },
      review: { stars: 4, text: 'Demó túra: Normafától a János-hegyi kilátóig és vissza.', kidFriendly: true, dogFriendly: true, difficulty: 'Könnyű' } };
    await DB.put('hikes', hk);
    go(`#/hike/${hk.id}`);
  }

  async function blobToDataUrl(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  }

  async function backup(withPhotos) {
    const data = { app: 'turanaplo', version: 1, exportedAt: new Date().toISOString(),
      hikes: await DB.all('hikes'), places: await DB.all('places'), reports: await DB.all('reports'), photos: [] };
    if (withPhotos) for (const p of await DB.all('photos')) data.photos.push({ ...p, blob: await blobToDataUrl(p.blob) });
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `turanaplo-mentes-${new Date().toISOString().slice(0, 10)}.json`);
  }

  async function restore(file) {
    const data = JSON.parse(await file.text());
    if (data.app !== 'turanaplo') throw new Error('Nem Túranapló mentés');
    for (const x of data.hikes || []) await DB.put('hikes', x);
    for (const x of data.places || []) await DB.put('places', x);
    for (const x of data.reports || []) await DB.put('reports', x);
    for (const x of data.photos || []) await DB.put('photos', { ...x, blob: await (await fetch(x.blob)).blob() });
  }

  async function settings() {
    setTitle('Beállítások');
    const st = await DB.settings();
    const height = h('input', { type: 'number', inputmode: 'numeric', min: 100, max: 230, value: st.heightCm ?? '', placeholder: 'cm',
      onchange: async (e) => { st.heightCm = e.target.value ? +e.target.value : null; await DB.saveSettings(st); toast('Mentve.'); } });
    const restoreInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
      try { await restore(e.target.files[0]); toast('Visszatöltve.'); go('#/'); } catch (err) { toast('Hibás mentésfájl.'); }
    } });
    let persisted = null;
    try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* not supported */ }

    render(
      h('div', { class: 'field' }, h('label', null, 'Testmagasság (a lépésszám becsléséhez)'), height),
      choice('Alap térkép', ['Turista', 'Alap'], st.mapLayer === 'osm' ? 'Alap' : 'Turista',
        async (v) => { st.mapLayer = v === 'Alap' ? 'osm' : 'topo'; await DB.saveSettings(st); }),
      h('h2', null, 'Adatok'),
      h('p', { class: 'muted small' }, 'Minden adat (túrák, fotók, vélemények) most csak ezen a telefonon van. Időnként mentsd le, és tedd a Fájlok appba vagy Dropboxba.',
        persisted === false ? ' A Safari hosszabb használaton kívüli idő után törölheti a weboldalak adatait, ezért a mentés most különösen fontos.' : ''),
      h('div', { class: 'actions wrap' },
        h('button', { class: 'btn', onclick: () => backup(true) }, 'Mentés fotókkal'),
        h('button', { class: 'btn', onclick: () => backup(false) }, 'Mentés fotók nélkül'),
        h('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Visszatöltés'), restoreInput),
      h('h2', null, 'Kipróbálás'),
      h('div', { class: 'actions wrap' },
        h('button', { class: 'btn', onclick: makeDemo }, 'Demó túra létrehozása'),
        h('button', { class: 'btn', onclick: async () => {
          if (Tracker.hike) return toast('Már fut egy túra.');
          await Tracker.start({ id: 'own:demo-janoshegy', name: 'Szimulált séta', kind: 'own', lat: DEMO_ROUTE[0][0], lon: DEMO_ROUTE[0][1] });
          Tracker.simulate(DEMO_ROUTE, 250); go('#/track');
        } }, 'Élő követés szimulálása')),
      h('p', { class: 'muted small' }, 'A demó túra a Normafa–János-hegy körön mutatja meg a túra adatlapját. A szimuláció kitalált GPS-pontokkal játssza le a követést.'),
      h('h2', null, 'Veszélyzóna'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Minden túra, fotó, hely és jelzés törlődik erről a telefonról. Biztos?')) return;
        if (Tracker.hike) await Tracker.discard();
        for (const s of ['hikes', 'photos', 'places', 'reports']) await DB.clear(s);
        toast('Minden adat törölve.'); go('#/');
      } }, 'Minden adat törlése'),
      h('p', { class: 'muted small' }, 'Térkép: © OpenStreetMap közreműködők, OpenTopoMap, Waymarked Trails. Magasság: Open-Meteo.'));
  }

  // ---------- router ----------
  async function route() {
    cleanup.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    cleanup = [];
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
    window.scrollTo(0, 0);
    try {
      switch (parts[0]) {
        case 'start': return await start();
        case 'track': return track();
        case 'hike': return await hikeView(parts[1]);
        case 'places': return await placesList();
        case 'place': return await placeView(decodeURIComponent(parts.slice(1).join('/')));
        case 'settings': return await settings();
        default: return await home();
      }
    } catch (err) {
      console.error(err);
      render(h('p', { class: 'warn' }, 'Hiba történt: ', err.message || String(err)), h('a', { class: 'btn', href: '#/' }, 'Kezdőlap'));
    }
  }

  window.addEventListener('hashchange', route);

  (async () => {
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (e) { /* best effort */ }
    await Tracker.restore();
    if (Tracker.hike && !location.hash.startsWith('#/track')) location.hash = '#/track';
    route();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
  })();

  window.App = { computeStats };
})();
