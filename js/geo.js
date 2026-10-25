// Geo math: distance, elevation gain, step estimate, track simplification.
(function () {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;

  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function trackDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].segStart) continue; // pause boundary: not walked
      d += haversine(points[i - 1], points[i]);
    }
    return d;
  }

  // Ascent/descent with hysteresis: a change only counts once it exceeds `threshold`
  // metres, which filters out GPS/DEM jitter.
  function elevationGain(eles, threshold = 3) {
    let up = 0, down = 0, ref = null;
    for (const e of eles) {
      if (e == null || Number.isNaN(e)) continue;
      if (ref == null) { ref = e; continue; }
      const diff = e - ref;
      if (diff >= threshold) { up += diff; ref = e; }
      else if (diff <= -threshold) { down -= diff; ref = e; }
    }
    return { up, down };
  }

  function smooth(values, window = 5) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - window); j <= Math.min(values.length - 1, i + window); j++) {
        if (values[j] != null) { sum += values[j]; n++; }
      }
      out.push(n ? sum / n : null);
    }
    return out;
  }

  // Resample a track every `step` metres (for elevation lookups and the profile chart).
  function resample(points, step = 50, max = 400) {
    if (points.length < 2) return points.map((p) => ({ lat: p.lat, lon: p.lon, dist: 0 }));
    const total = trackDistance(points);
    step = Math.max(step, total / max);
    const out = [{ lat: points[0].lat, lon: points[0].lon, dist: 0, alt: points[0].alt }];
    let acc = 0, next = step;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const seg = points[i].segStart ? 0 : haversine(a, b);
      while (seg > 0 && acc + seg >= next) {
        const t = (next - acc) / seg;
        out.push({
          lat: a.lat + (b.lat - a.lat) * t,
          lon: a.lon + (b.lon - a.lon) * t,
          dist: next,
          alt: a.alt != null && b.alt != null ? a.alt + (b.alt - a.alt) * t : null,
        });
        next += step;
      }
      acc += seg;
    }
    const last = points[points.length - 1];
    out.push({ lat: last.lat, lon: last.lon, dist: acc, alt: last.alt });
    return out;
  }

  // Step estimate from distance. Stride ~ 0.415 x body height is a common rule of
  // thumb, NOT a measurement; the UI labels this as an estimate.
  function estimateSteps(distanceM, heightCm) {
    const stride = heightCm ? (heightCm * 0.415) / 100 : 0.72;
    return Math.round(distanceM / stride);
  }

  function fmtKm(m) { return (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' km'; }
  function fmtDur(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h} ó ${String(m).padStart(2, '0')} p` : `${m} p ${String(s % 60).padStart(2, '0')} mp`;
  }

  window.Geo = { haversine, trackDistance, elevationGain, smooth, resample, estimateSteps, fmtKm, fmtDur };
})();
