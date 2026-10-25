// Places: OpenStreetMap lookups (Overpass for nearby, Nominatim for name search),
// own places, and DEM elevation (Open-Meteo) for the finished track.
(function () {
  const OVERPASS = 'https://overpass-api.de/api/interpreter';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const ELEVATION = 'https://api.open-meteo.com/v1/elevation';

  const KIND = {
    peak: 'Csúcs', viewpoint: 'Kilátópont', tower: 'Kilátó', alpine_hut: 'Turistaház',
    wilderness_hut: 'Menedékház', shelter: 'Esőbeálló', cave_entrance: 'Barlang',
    spring: 'Forrás', waterfall: 'Vízesés', ruins: 'Rom', route: 'Turistaút', own: 'Saját hely',
    picnic_site: 'Pihenőhely', castle: 'Vár', ridge: 'Gerinc', cliff: 'Sziklafal', rock: 'Szikla',
    arch: 'Sziklakapu', saddle: 'Nyereg', gorge: 'Szurdok', other: 'Hely',
  };

  function kindOf(tags) {
    if (tags.route === 'hiking') return 'route';
    if (tags.natural === 'peak') return 'peak';
    if (tags.man_made === 'tower') return 'tower';
    if (tags.tourism) return KIND[tags.tourism] ? tags.tourism : 'other';
    if (tags.amenity === 'shelter') return 'shelter';
    if (tags.natural) return KIND[tags.natural] ? tags.natural : 'other';
    if (tags.waterway === 'waterfall') return 'waterfall';
    if (tags.historic === 'castle') return 'castle';
    if (tags.historic === 'ruins') return 'ruins';
    return 'other';
  }

  function fromOsm(e) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    return {
      id: `osm:${e.type}/${e.id}`, source: 'osm', name: t.name, kind: kindOf(t),
      lat, lon, ele: t.ele ? parseFloat(t.ele) : null,
      symbol: t['osmc:symbol'] || null,
    };
  }

  // Overpass gives the richest result, but its public servers are often overloaded
  // (measured 2026-10-25: 502s and 30 s timeouts on four mirrors while Nominatim
  // answered in ~130 ms). Both run in parallel; onUpdate gets the merged list each
  // time a source answers, so the user sees places as soon as either one is back.
  async function nearby(lat, lon, radius = 8000, onUpdate) {
    const merged = new Map();
    const add = (list) => {
      for (const p of list) {
        if (!p.name) p.name = KIND[p.kind];
        p.distance = Geo.haversine({ lat, lon }, p);
        merged.set(p.id, Object.assign(merged.get(p.id) || {}, p));
      }
      const sorted = [...merged.values()].sort((x, y) => x.distance - y.distance);
      if (onUpdate) onUpdate(sorted);
      return sorted;
    };
    const results = await Promise.allSettled([
      nearbyOverpass(lat, lon, radius).then(add),
      nearbyNominatim(lat, lon, radius, add).then(add),
    ]);
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    return [...merged.values()].sort((x, y) => x.distance - y.distance);
  }

  async function nearbyOverpass(lat, lon, radius) {
    const a = `(around:${radius},${lat},${lon})`;
    const q = `[out:json][timeout:12];(
      node${a}[natural=peak][name];
      node${a}[tourism=viewpoint][name];
      nwr${a}[man_made=tower]["tower:type"=observation];
      nwr${a}[tourism~"^(alpine_hut|wilderness_hut|picnic_site)$"][name];
      node${a}[amenity=shelter][name];
      node${a}[natural~"^(cave_entrance|spring)$"][name];
      node${a}[waterway=waterfall][name];
      nwr${a}[historic=ruins][name];
      relation${a}[route=hiking][name];
    );out center tags 300;`;
    const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('Overpass ' + res.status);
    const json = await res.json();
    if (json.remark && !json.elements.length) throw new Error('Overpass: ' + json.remark);
    return json.elements.map(fromOsm).filter((p) => p.lat != null);
  }

  async function nearbyNominatim(lat, lon, radius, onCategory) {
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
    const viewbox = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((v) => v.toFixed(4)).join(',');
    const out = [];
    for (const q of ['peak', 'viewpoint', 'alpine hut', 'wilderness hut', 'cave entrance', 'spring']) {
      try {
        const params = new URLSearchParams({ q, format: 'jsonv2', limit: '40', viewbox, bounded: '1', 'accept-language': 'hu' });
        const res = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const found = (await res.json()).filter((r) => r.name).map(fromNominatim);
          out.push(...found);
          if (onCategory && found.length) onCategory(found);
        }
      } catch (e) { /* skip this category */ }
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim usage policy: max 1 request/s
    }
    if (!out.length) throw new Error('Nincs elérhető helyadatbázis');
    return out;
  }

  function fromNominatim(r) {
    return {
      id: `osm:${r.osm_type}/${r.osm_id}`, source: 'osm', name: r.name || r.display_name.split(',')[0],
      kind: kindOf({ [r.category]: r.type }), lat: +r.lat, lon: +r.lon, ele: null,
      detail: r.display_name.split(',').slice(1, 3).join(',').trim(),
    };
  }

  async function search(text, near) {
    const params = new URLSearchParams({ q: text, format: 'jsonv2', limit: '15', countrycodes: 'hu', 'accept-language': 'hu' });
    const res = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('Nominatim ' + res.status);
    const json = await res.json();
    return json.map((r) => {
      const p = fromNominatim(r);
      if (near) p.distance = Geo.haversine(near, p);
      return p;
    });
  }

  // Car parks around a destination. Same parallel Overpass + Nominatim pattern as nearby().
  async function parking(lat, lon, radius = 8000, onUpdate) {
    const found = new Map();
    const sorted = () => [...found.values()].sort((a, b) => a.distance - b.distance);
    const add = (list) => {
      list.forEach((p) => {
        p.distance = Geo.haversine({ lat, lon }, p);
        if (!found.has(p.id)) found.set(p.id, p);
      });
      if (onUpdate && list.length) onUpdate(sorted());
    };
    const overpass = (async () => {
      const q = `[out:json][timeout:15];nwr(around:${radius},${lat},${lon})[amenity=parking][access!~"^(private|no|customers)$"];out center tags 60;`;
      const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error('Overpass ' + res.status);
      add((await res.json()).elements.map((e) => {
        const t = e.tags || {};
        return { id: `osm:${e.type}/${e.id}`, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
          name: t.name || null, fee: t.fee || null, capacity: t.capacity || null, surface: t.surface || null };
      }).filter((p) => p.lat != null));
    })();
    const nominatim = (async () => {
      const dLat = radius / 111320, dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
      const viewbox = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((v) => v.toFixed(4)).join(',');
      const params = new URLSearchParams({ q: 'parking', format: 'jsonv2', limit: '30', viewbox, bounded: '1', 'accept-language': 'hu' });
      const res = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('Nominatim ' + res.status);
      add((await res.json()).filter((r) => r.type === 'parking').map((r) => ({ id: `osm:${r.osm_type}/${r.osm_id}`,
        lat: +r.lat, lon: +r.lon, name: r.name || null, fee: null, capacity: null })));
    })();
    const results = await Promise.allSettled([overpass, nominatim]);
    if (results.every((r) => r.status === 'rejected') && !found.size) throw results[0].reason;
    return sorted();
  }

  // DEM elevation for resampled points; Open-Meteo takes up to 100 coordinates per call.
  async function elevations(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i += 100) {
      const chunk = pts.slice(i, i + 100);
      const params = new URLSearchParams({
        latitude: chunk.map((p) => p.lat.toFixed(5)).join(','),
        longitude: chunk.map((p) => p.lon.toFixed(5)).join(','),
      });
      const res = await fetch(`${ELEVATION}?${params}`);
      if (!res.ok) throw new Error('Elevation ' + res.status);
      out.push(...(await res.json()).elevation);
    }
    return out;
  }

  // Merge OSM data with what we know locally (own reviews, reports).
  async function remember(place) {
    const prev = await DB.get('places', place.id);
    const merged = Object.assign({}, prev || {}, place, { savedAt: Date.now() });
    delete merged.distance;
    await DB.put('places', merged);
    return merged;
  }

  window.Places = { KIND, nearby, search, elevations, remember, parking };
})();
