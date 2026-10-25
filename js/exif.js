// Minimal JPEG EXIF reader: capture time (DateTimeOriginal) and GPS position.
// Returns {}, never throws: a photo without EXIF is still a valid photo.
(function () {
  async function read(file) {
    try {
      const buf = await file.slice(0, 256 * 1024).arrayBuffer();
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return {};
      let off = 2;
      while (off + 4 < v.byteLength) {
        const marker = v.getUint16(off), len = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
        if ((marker & 0xff00) !== 0xff00) break;
        off += 2 + len;
      }
    } catch (e) { /* unreadable: treat as no EXIF */ }
    return {};
  }

  function parseTiff(v, start) {
    const le = v.getUint16(start) === 0x4949;
    const u16 = (o) => v.getUint16(start + o, le), u32 = (o) => v.getUint32(start + o, le);
    const ifd = (o) => {
      const n = u16(o), out = {};
      for (let i = 0; i < n; i++) {
        const e = o + 2 + i * 12;
        out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 };
      }
      return out;
    };
    const ascii = (t) => {
      const o = t.count > 4 ? u32(t.valOff) : t.valOff;
      let s = '';
      for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(start + o + i));
      return s;
    };
    const rationals = (t) => {
      const o = u32(t.valOff), out = [];
      for (let i = 0; i < t.count; i++) out.push(u32(o + i * 8) / (u32(o + i * 8 + 4) || 1));
      return out;
    };
    const res = {};
    const ifd0 = ifd(u32(4));
    if (ifd0[0x8769]) {
      const exif = ifd(u32(ifd0[0x8769].valOff));
      const dt = exif[0x9003] || exif[0x9004];
      if (dt) {
        const m = ascii(dt).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (m) res.takenAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); // camera local time
      }
    }
    if (ifd0[0x8825]) {
      const g = ifd(u32(ifd0[0x8825].valOff));
      if (g[2] && g[4]) {
        const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
        let lat = dms(rationals(g[2])), lon = dms(rationals(g[4]));
        if (g[1] && ascii(g[1]) === 'S') lat = -lat;
        if (g[3] && ascii(g[3]) === 'W') lon = -lon;
        if (lat || lon) { res.lat = lat; res.lon = lon; }
      }
    }
    return res;
  }

  window.Exif = { read };
})();
