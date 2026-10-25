// Live GPS tracking. Points are persisted to IndexedDB as they arrive, so a reload
// or a killed Safari tab does not lose the hike.
//
// Point: { t, lat, lon, alt, acc, segStart?, gapBefore? }
//   segStart  - first point after a pause: the segment before it is not counted
//   gapBefore - GPS went silent (locked screen, tunnel): the straight line is an
//               estimate, counted in the distance and drawn dashed
(function () {
  const MAX_ACC = 35;          // metres; worse fixes are dropped...
  const MAX_ACC_STALE = 80;    // ...unless nothing better came for STALE_MS
  const STALE_MS = 60000;
  const MIN_MOVE = 4;          // metres between stored points
  const GAP_MS = 90000;        // silence longer than this is marked as a gap
  const SAVE_EVERY_MS = 3000;

  let hike = null, watchId = null, wakeLock = null, lastSave = 0, lastAccepted = 0;
  let paused = false, pendingSegStart = false, listeners = [], simTimer = null;

  const emit = () => listeners.forEach((fn) => fn(hike, state()));
  const state = () => ({ running: !!hike && !paused, paused, wakeLock: !!wakeLock });

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; emit(); });
      }
    } catch (e) { wakeLock = null; }
    emit();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hike && !paused) requestWakeLock();
    if (document.visibilityState === 'hidden' && hike) save(true);
  });
  window.addEventListener('pagehide', () => { if (hike) save(true); });

  async function save(force) {
    if (!hike) return;
    const now = Date.now();
    if (!force && now - lastSave < SAVE_EVERY_MS) return;
    lastSave = now;
    await DB.put('hikes', hike);
  }

  function onPosition(pos) {
    if (!hike || paused) return;
    const c = pos.coords, now = pos.timestamp || Date.now();
    const stale = now - lastAccepted > STALE_MS;
    if (c.accuracy > (stale ? MAX_ACC_STALE : MAX_ACC)) { hike.lastFix = { acc: c.accuracy, t: now }; emit(); return; }
    const p = { t: now, lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: Math.round(c.accuracy) };
    const prev = hike.points[hike.points.length - 1];
    if (prev && !pendingSegStart && Geo.haversine(prev, p) < MIN_MOVE) { hike.lastFix = { acc: c.accuracy, t: now }; emit(); return; }
    if (pendingSegStart && prev) p.segStart = true;
    else if (prev && now - prev.t > GAP_MS) p.gapBefore = true;
    pendingSegStart = false;
    hike.points.push(p);
    hike.lastFix = { acc: c.accuracy, t: now };
    lastAccepted = now;
    save(false);
    emit();
  }

  function onError(err) {
    hike && (hike.lastError = { code: err.code, msg: err.message, t: Date.now() });
    emit();
  }

  function startWatch() {
    if (watchId != null || simTimer) return;
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
    });
  }
  function stopWatch() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
  }

  const Tracker = {
    on(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; },
    get hike() { return hike; },
    state,

    async start(place) {
      hike = {
        id: DB.uid(), status: 'active', startedAt: Date.now(), endedAt: null,
        place, points: [], pauses: [], visibility: 'private',
        review: { stars: 0, text: '', kidFriendly: null, dogFriendly: null, difficulty: null },
      };
      paused = false; pendingSegStart = false; lastAccepted = Date.now();
      await DB.kvSet('activeHikeId', hike.id);
      await save(true);
      startWatch();
      requestWakeLock();
      emit();
      return hike;
    },

    // Resume an active hike after a reload.
    async restore() {
      const id = await DB.kvGet('activeHikeId');
      if (!id) return null;
      const h = await DB.get('hikes', id);
      if (!h || h.status !== 'active') { await DB.kvDel('activeHikeId'); return null; }
      hike = h;
      paused = !!h.pausedAt;
      // The walk continued while the app was closed: the next fix gets gapBefore
      // (straight-line estimate) through the normal GAP_MS rule.
      pendingSegStart = false;
      lastAccepted = Date.now();
      if (!paused) { startWatch(); requestWakeLock(); }
      emit();
      return hike;
    },

    pause() {
      if (!hike || paused) return;
      paused = true; hike.pausedAt = Date.now();
      stopWatch();
      if (wakeLock) wakeLock.release();
      save(true); emit();
    },

    resume() {
      if (!hike || !paused) return;
      hike.pauses.push({ from: hike.pausedAt, to: Date.now() });
      delete hike.pausedAt;
      paused = false; pendingSegStart = true; lastAccepted = Date.now();
      startWatch(); requestWakeLock();
      save(true); emit();
    },

    async finish() {
      if (!hike) return null;
      if (paused) Tracker.resume();
      stopWatch();
      if (wakeLock) wakeLock.release();
      hike.status = 'finished';
      hike.endedAt = Date.now();
      const done = hike;
      await DB.put('hikes', done);
      await DB.kvDel('activeHikeId');
      hike = null; paused = false;
      emit();
      return done;
    },

    async discard() {
      if (!hike) return;
      stopWatch();
      if (wakeLock) wakeLock.release();
      await DB.del('hikes', hike.id);
      await DB.kvDel('activeHikeId');
      hike = null; paused = false;
      emit();
    },

    // Replays a route as fake GPS fixes (demo + testing). route: [[lat, lon], ...]
    simulate(route, intervalMs = 300, stepM = 25) {
      stopWatch();
      const pts = [];
      for (let i = 1; i < route.length; i++) {
        const a = { lat: route[i - 1][0], lon: route[i - 1][1] }, b = { lat: route[i][0], lon: route[i][1] };
        const n = Math.max(1, Math.round(Geo.haversine(a, b) / stepM));
        for (let k = 0; k < n; k++) pts.push([a.lat + ((b.lat - a.lat) * k) / n, a.lon + ((b.lon - a.lon) * k) / n]);
      }
      pts.push(route[route.length - 1]);
      let i = 0, t = Date.now();
      simTimer = setInterval(() => {
        if (i >= pts.length) { clearInterval(simTimer); simTimer = null; return; }
        if (paused) return;
        t += 12000; // ~2 m/s walking pace in fake time
        const jitter = () => (Math.random() - 0.5) * 0.00004;
        onPosition({ timestamp: t, coords: { latitude: pts[i][0] + jitter(), longitude: pts[i][1] + jitter(), altitude: null, accuracy: 6 } });
        i++;
      }, intervalMs);
    },
  };

  window.Tracker = Tracker;
})();
