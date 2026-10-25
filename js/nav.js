// Route navigation: chain an OSM route's ways into one line, then project the
// current position onto it (progress, remaining distance, off-route).
(function () {
  const d = (a, b) => Geo.haversine({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });

  // OSM route relations list their ways in no guaranteed order or direction. Greedy
  // chaining from the end nearest to `near` works for linear routes and loops;
  // branches further than MAX_GAP from the current end are left out.
  const MAX_GAP = 800;
  function chain(lines, near) {
    const segs = lines.filter((l) => l.length > 1).map((l) => l.slice());
    if (!segs.length) return [];
    const nearPt = near ? [near.lon, near.lat] : segs[0][0];
    let best = null;
    segs.forEach((s, i) => {
      for (const [pt, rev] of [[s[0], false], [s[s.length - 1], true]]) {
        const dd = d(pt, nearPt);
        if (!best || dd < best.d) best = { i, rev, d: dd };
      }
    });
    let path = segs.splice(best.i, 1)[0];
    if (best.rev) path.reverse();
    while (segs.length) {
      const tail = path[path.length - 1];
      let nb = null;
      segs.forEach((s, i) => {
        const d0 = d(s[0], tail), d1 = d(s[s.length - 1], tail);
        const m = Math.min(d0, d1);
        if (!nb || m < nb.d) nb = { i, d: m, rev: d1 < d0 };
      });
      if (nb.d > MAX_GAP) break;
      const s = segs.splice(nb.i, 1)[0];
      if (nb.rev) s.reverse();
      path = path.concat(nb.d < 2 ? s.slice(1) : s);
    }
    return path;
  }

  function build(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + d(coords[i - 1], coords[i]));
    return { coords, cum, total: cum[cum.length - 1] };
  }

  // Nearest point on the route. Searches around the previous index first (cheap, and
  // keeps us from jumping to a parallel section of a loop), the whole line if far off.
  function project(route, pos, hint = 0) {
    const { coords, cum } = route;
    const kx = 111320 * Math.cos((pos.lat * Math.PI) / 180), ky = 110540;
    const px = pos.lon * kx, py = pos.lat * ky;
    const scan = (from, to) => {
      let best = null;
      for (let i = Math.max(0, from); i < Math.min(coords.length - 1, to); i++) {
        const ax = coords[i][0] * kx, ay = coords[i][1] * ky, bx = coords[i + 1][0] * kx, by = coords[i + 1][1] * ky;
        const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
        const qx = ax + t * vx, qy = ay + t * vy, off = Math.hypot(px - qx, py - qy);
        if (!best || off < best.off) best = { i, t, off, along: cum[i] + t * (cum[i + 1] - cum[i]), pt: [qx / kx, qy / ky] };
      }
      return best;
    };
    let best = scan(hint - 30, hint + 300);
    if (!best || best.off > 80) {
      const all = scan(0, coords.length);
      if (all && (!best || all.off < best.off)) best = all;
    }
    return best;
  }

  // The part still ahead of the projected point.
  function ahead(route, proj) {
    if (!proj) return route.coords;
    return [proj.pt, ...route.coords.slice(proj.i + 1)];
  }

  window.Nav = { chain, build, project, ahead };
})();
