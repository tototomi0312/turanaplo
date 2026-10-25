// Built-in catalogue of Hungarian hiking destinations (data/places-hu.json, built
// from OpenStreetMap by tools/build-catalog). Works offline, filters instantly.
(function () {
  let data = null, items = null;

  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').trim();

  async function load() {
    if (items) return items;
    const res = await fetch('data/places-hu.json');
    data = await res.json();
    items = data.items.map(([id, name, k, lat, lon, ele, r, score]) => ({
      id: 'osm:' + ({ n: 'node', w: 'way', r: 'relation' }[id[0]]) + '/' + id.slice(1),
      source: 'osm', name, kind: data.kinds[k], lat, lon, ele, region: r >= 0 ? data.regions[r] : null,
      score, key: norm(name + ' ' + (r >= 0 ? data.regions[r] : '')),
    }));
    return items;
  }

  // q: free text (accent-insensitive, every word must match); kinds: Set or null;
  // near: {lat, lon} sorts by distance, otherwise by importance.
  async function query({ q = '', kinds = null, near = null, region = null } = {}) {
    const all = await load();
    const words = norm(q).split(' ').filter(Boolean);
    let res = all.filter((p) => (!kinds || kinds.has(p.kind)) && (!region || p.region === region) &&
      words.every((w) => p.key.includes(w)));
    if (near) {
      res.forEach((p) => (p.distance = Geo.haversine(near, p)));
      res.sort((a, b) => a.distance - b.distance);
    } else {
      res.forEach((p) => delete p.distance);
      res.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'hu'));
    }
    return res;
  }

  async function regions() { await load(); return data.regions; }
  async function byId(id) { return (await load()).find((p) => p.id === id) || null; }

  window.Catalog = { load, query, regions, byId, norm };
})();
