// Direction: compass (where the phone points) and GPS course (where we are moving).
// iOS needs DeviceOrientationEvent.requestPermission() from a tap, so start() must
// be called from a click handler.
(function () {
  let compass = null, course = null, listening = false, listeners = [];
  const emit = () => listeners.forEach((fn) => fn(Heading.value()));

  function onOrientation(e) {
    let deg = null;
    if (typeof e.webkitCompassHeading === 'number') deg = e.webkitCompassHeading; // iOS: degrees from north
    else if (e.absolute && e.alpha != null) deg = 360 - e.alpha;                 // Android absolute
    if (deg == null) return;
    // Correct for screen rotation (landscape).
    const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    compass = (deg + angle + 360) % 360;
    emit();
  }

  const Heading = {
    on(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; },
    // Compass wins (also works when standing still); GPS course is the fallback.
    value() { return compass ?? course; },
    source() { return compass != null ? 'compass' : course != null ? 'course' : null; },

    async start() {
      if (listening) return true;
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') return false;
        }
      } catch (e) { return false; }
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
      listening = true;
      return true;
    },

    // Fed from GPS fixes: coords.heading is only meaningful while moving.
    setCourse(heading, speed) {
      if (heading != null && !Number.isNaN(heading) && speed != null && speed > 0.6) { course = heading; emit(); }
    },
  };

  window.Heading = Heading;
})();
