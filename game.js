(() => {
  "use strict";

  // ---------- config ----------
  const QUICK_ROUNDS = 7;
  const PERFECT_KM = 50;      // anything this close scores 100
  const FALLOFF_KM = 1500;    // score decays by e every this many km beyond PERFECT_KM
  const COLORS = { guess: "#ffc83d", truth: "#ffffff" };
  const TEXTURE_CDN = "https://cdn.jsdelivr.net/npm/three-globe@2.45.0/example/img/";
  const TILE_URL = (x, y, l) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`;
  const TILE_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics";
  const BASE_CREDIT = "Imagery: NASA Blue Marble";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // WebGL refuses textures from file:// pages, so fall back to the CDN copy there.
  const tex = (name) => (location.protocol === "file:" ? TEXTURE_CDN : "assets/") + name;

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distanceKm(a, b) {
    const R = 6371;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function scoreFor(km) {
    if (km <= PERFECT_KM) return 100;
    return Math.max(0, Math.round(100 * Math.exp(-(km - PERFECT_KM) / FALLOFF_KM)));
  }

  function midpoint(a, b) {
    const toVec = (p) => [Math.cos(rad(p.lat)) * Math.cos(rad(p.lng)), Math.cos(rad(p.lat)) * Math.sin(rad(p.lng)), Math.sin(rad(p.lat))];
    const [x1, y1, z1] = toVec(a);
    const [x2, y2, z2] = toVec(b);
    const x = x1 + x2, y = y1 + y2, z = z1 + z2;
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) return { lat: a.lat, lng: a.lng }; // antipodes
    return { lat: deg(Math.asin(z / len)), lng: deg(Math.atan2(y, x)) };
  }

  function shuffle(arr, random = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- daily game ----------
  // The player's calendar date, so a new set starts at their local midnight (like Wordle).
  function todayKey() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Deterministic PRNG from a string: cyrb53-style hash feeding mulberry32.
  // Same seed => same sequence in every browser.
  function seededRandom(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Today's 7 for a kind. Depends on the order of CAPITALS, so keep that list's order stable.
  const dailyPicks = (kind, day) => shuffle(CAPITALS, seededRandom(`captap:${day}:${kind}`)).slice(0, QUICK_ROUNDS);

  // ---------- country shapes ----------
  // COUNTRY_SHAPES[name] = [polygon, ...], polygon = [outerRing, ...holes], ring = flat [lng, lat, ...]

  // Even-odd ray cast across every ring, so holes (e.g. Lesotho inside South Africa) count as outside.
  // Natural Earth splits shapes at the antimeridian, so a flat lng/lat test is safe.
  function insideShape(polys, lat, lng) {
    let inside = false;
    for (const poly of polys) for (const ring of poly) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  // A country's main landmasses: every polygon holding at least 1% of its area. Misses are measured
  // to these, so a pin in the Atlantic isn't scored against Brazil's tiny mid-ocean rocks.
  const majorCache = new Map();
  function majorPolys(name) {
    if (!majorCache.has(name)) {
      const polys = COUNTRY_SHAPES[name];
      const areas = polys.map(([ring]) => {
        let a = 0;
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          a += (ring[j] - ring[i]) * (ring[j + 1] + ring[i + 1]) * Math.cos(rad(ring[i + 1]));
        }
        return Math.abs(a);
      });
      const total = areas.reduce((s, a) => s + a, 0);
      majorCache.set(name, polys.filter((_, i) => areas[i] >= total * 0.01));
    }
    return majorCache.get(name);
  }

  // Closest point on the outline (outlines are dense enough that vertices suffice).
  function nearestOnShape(polys, p) {
    let best = { km: Infinity, lat: 0, lng: 0 };
    for (const poly of polys) {
      const ring = poly[0];
      for (let i = 0; i < ring.length; i += 2) {
        const q = { lat: ring[i + 1], lng: ring[i] };
        const km = distanceKm(p, q);
        if (km < best.km) best = { km, ...q };
      }
    }
    return best;
  }

  const extentCache = new Map();
  // Rough size of a country in km, used to pick a camera height that shows all of it.
  function shapeExtentKm(name) {
    if (!extentCache.has(name)) {
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      for (const poly of majorPolys(name)) {
        const ring = poly[0];
        for (let i = 0; i < ring.length; i += 2) {
          minLng = Math.min(minLng, ring[i]); maxLng = Math.max(maxLng, ring[i]);
          minLat = Math.min(minLat, ring[i + 1]); maxLat = Math.max(maxLat, ring[i + 1]);
        }
      }
      extentCache.set(name, distanceKm({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng }));
    }
    return extentCache.get(name);
  }

  const shapeFeature = (name) => ({
    type: "Feature",
    geometry: {
      type: "MultiPolygon",
      coordinates: COUNTRY_SHAPES[name].map((poly) =>
        poly.map((ring) => {
          const pts = [];
          for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
          return pts;
        })),
    },
  });

  const fmtKm = (km) => (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString()) + " km";
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem("captap:" + key) ?? localStorage.getItem("touchdown:" + key)); } catch { return null; } },
    set(key, v) { try { localStorage.setItem("captap:" + key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // ---------- split-flap board ----------
  const FLAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let flapTimers = [];

  function wrapWords(text, maxChars) {
    const lines = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line && (line + " " + word).length > maxChars) { lines.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    if (line) lines.push(line);
    return lines;
  }

  function setFlap(el, text, { maxWidth, maxTile = 52, maxChars = 14 } = {}) {
    flapTimers.forEach(clearInterval);
    flapTimers = [];
    const lines = wrapWords(text, maxChars);
    const longest = Math.max(...lines.map((l) => l.length));
    const tileW = Math.max(14, Math.min(maxTile, (maxWidth / longest) / 1.08));
    el.style.setProperty("--tile-w", tileW.toFixed(1) + "px");
    el.innerHTML = "";
    el.setAttribute("aria-label", text);

    let index = 0;
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "flap-line";
      row.setAttribute("aria-hidden", "true");
      for (const ch of line) {
        const tile = document.createElement("div");
        const span = document.createElement("span");
        tile.className = "tile";
        tile.appendChild(span);
        row.appendChild(tile);
        if (ch === " ") { tile.classList.add("is-blank"); continue; }
        if (reduceMotion) { span.textContent = ch; continue; }
        // Spin through letters, then settle — staggered left to right.
        let flips = 4 + index * 1.4 + Math.random() * 3;
        const timer = setInterval(() => {
          tile.classList.remove("is-flipping");
          void tile.offsetWidth;
          tile.classList.add("is-flipping");
          if (--flips <= 0) {
            span.textContent = ch;
            clearInterval(timer);
          } else {
            span.textContent = FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)];
          }
        }, 55);
        flapTimers.push(timer);
        index++;
      }
      el.appendChild(row);
    }
  }

  // ---------- globe ----------
  const globe = new Globe($("globe"), { animateIn: true })
    .globeImageUrl(tex("earth-blue-marble.jpg"))
    .bumpImageUrl(tex("earth-topology.png"))
    .backgroundImageUrl(tex("night-sky.png"))
    .showAtmosphere(true)
    .atmosphereColor("#8fc6ff")
    .atmosphereAltitude(0.17)
    .width(window.innerWidth)
    .height(window.innerHeight)
    // pins
    .htmlElementsData([])
    .htmlLat("lat")
    .htmlLng("lng")
    .htmlAltitude(0)
    .htmlElement((d) => d.el)
    .htmlTransitionDuration(0)
    // line between guess and answer
    .arcsData([])
    .arcColor(() => [COLORS.guess, COLORS.truth])
    .arcStroke(0.45)
    .arcAltitudeAutoScale(0.25)
    .arcDashLength(0.35)
    .arcDashGap(0.12)
    .arcDashAnimateTime(reduceMotion ? 0 : 1800)
    .arcsTransitionDuration(0)
    // pulse on the answer
    .ringsData([])
    .ringColor(() => (t) => `rgba(255,255,255,${(1 - t) * 0.9})`)
    .ringMaxRadius(2.2)
    .ringPropagationSpeed(1.6)
    .ringRepeatPeriod(reduceMotion ? 0 : 1100)
    // the answer country, shown only after a guess in country mode
    .polygonsData([])
    .polygonGeoJsonGeometry("geometry")
    .polygonCapColor(() => "rgba(255,255,255,0.22)")
    .polygonSideColor(() => "rgba(255,255,255,0.05)")
    .polygonStrokeColor(() => "#ffffff")
    .polygonAltitude(0.004)
    .polygonsTransitionDuration(0);

  // Our own tap detection: globe.gl's built-in click uses a throttled raycast,
  // which can report a stale position for very quick taps.
  const globeEl = $("globe");
  const pointers = new Map();
  let tap = null;
  globeEl.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, true);
    tap = pointers.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (!tap || e.type !== "pointerup") { if (!pointers.size) tap = null; return; }
    const still = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 7 && performance.now() - tap.t < 700;
    tap = null;
    if (!still) return;
    const r = globeEl.getBoundingClientRect();
    const c = globe.toGlobeCoords(e.clientX - r.left, e.clientY - r.top);
    if (c) onGlobeClick(c.lat, c.lng);
  };
  globeEl.addEventListener("pointerup", release);
  globeEl.addEventListener("pointercancel", release);

  const controls = globe.controls();
  controls.autoRotateSpeed = 0.45;
  controls.enableDamping = true;
  controls.zoomSpeed = 0.9;
  // Altitude that fits the whole globe on screen, taller on portrait phones.
  const overviewAltitude = () => 2.1 * Math.max(1, (0.8 * window.innerHeight) / window.innerWidth);
  globe.pointOfView({ lat: 22, lng: 10, altitude: overviewAltitude() + 0.3 });

  window.addEventListener("resize", () => {
    globe.width(window.innerWidth).height(window.innerHeight);
  });

  // Slow the drag-rotation down as the camera gets close, so zoomed-in panning stays precise.
  controls.addEventListener("change", () => {
    const alt = globe.pointOfView().altitude;
    controls.rotateSpeed = Math.max(0.08, Math.min(1, alt * 0.45));
  });

  function makePin(color, label) {
    const el = document.createElement("div");
    el.className = "pin" + (reduceMotion ? "" : " is-dropping");
    el.innerHTML = `
      <svg viewBox="0 0 26 36" aria-hidden="true">
        <path d="M13 35C13 35 2 21.5 2 13a11 11 0 0 1 22 0c0 8.5-11 22-11 22Z" fill="${color}" stroke="rgba(0,0,0,.55)" stroke-width="1.5"/>
        <circle cx="13" cy="13" r="4.2" fill="rgba(0,0,0,.6)"/>
      </svg>`;
    if (label) {
      const tag = document.createElement("span");
      tag.className = "pin-label";
      tag.textContent = label;
      el.appendChild(tag);
    }
    return el;
  }

  // ---------- imagery toggle ----------
  function setHd(on) {
    globe.globeTileEngineUrl(on ? TILE_URL : null);
    $("credit").textContent = on ? TILE_CREDIT : BASE_CREDIT;
    store.set("hd", on);
  }
  $("hdToggle").checked = !!store.get("hd");
  setHd($("hdToggle").checked);
  $("hdToggle").addEventListener("change", (e) => setHd(e.target.checked));

  // ---------- game state ----------
  const KINDS = {
    capitals: {
      one: "capital", many: "capitals", column: "Capital",
      title: (t) => t.capital,
      prompt: (t) => `${t.capital}, ${t.country}`,
      bestKey: (mode) => "best-" + mode,
    },
    countries: {
      one: "country", many: "countries", column: "Country",
      title: (t) => t.country,
      prompt: (t) => `Drop a pin anywhere in ${t.country}`,
      bestKey: (mode) => `best-${mode}-countries`,
    },
  };

  const state = {
    kind: store.get("kind") === "countries" ? "countries" : "capitals",
    mode: null,       // "quick" | "all"
    queue: [],
    i: 0,
    total: 0,
    results: [],
    guess: null,      // { lat, lng }
    phase: "menu",    // "menu" | "guess" | "reveal" | "end"
  };

  const ui = {
    hud: $("hud"), board: $("board"), dock: $("dock"),
    start: $("start"), end: $("end"),
    action: $("actionBtn"), finish: $("finishBtn"),
    result: $("result"),
  };

  function show(el, on) { el.hidden = !on; }

  function goMenu() {
    state.phase = "menu";
    document.body.classList.add("is-menu");
    clearMarks();
    [ui.hud, ui.board, ui.dock, ui.end].forEach((el) => show(el, false));
    show(ui.start, true);
    controls.autoRotate = !reduceMotion;
    renderBests();
    setFlap($("titleFlap"), "CapTap", { maxWidth: Math.min(window.innerWidth - 80, 540), maxTile: 52, maxChars: 20 });
  }

  function renderBests() {
    const k = KINDS[state.kind];
    const today = store.get(`today-${state.kind}`);
    const a = store.get(k.bestKey("all"));
    $("quickName").textContent = "Daily seven";
    $("quickDesc").textContent = `Today's 7 ${k.many}, the same for everyone. Out of 700 points.`;
    $("allName").textContent = `Every ${k.one}`;
    $("bestQuick").textContent = today && today.day === todayKey() ? `Your score today: ${today.total} / ${QUICK_ROUNDS * 100}` : "";
    $("bestAll").textContent = a ? `Your best: ${a.total.toLocaleString()} from ${a.played} ${a.played === 1 ? k.one : k.many}` : "";
    $("capCount").textContent = CAPITALS.length;
    document.querySelector(`.kind input[value="${state.kind}"]`).checked = true;
  }

  function startGame(mode) {
    const k = KINDS[state.kind];
    $("roundWord").textContent = k.one;
    $("colName").textContent = k.column;
    state.mode = mode;
    state.day = todayKey();
    state.queue = mode === "quick" ? dailyPicks(state.kind, state.day) : shuffle(CAPITALS);
    state.i = 0;
    state.total = 0;
    state.results = [];
    document.body.classList.remove("is-menu");
    controls.autoRotate = false;
    show(ui.start, false);
    show(ui.end, false);
    show(ui.hud, true);
    show(ui.board, true);
    show(ui.dock, true);
    show(ui.finish, mode === "all");
    nextRound();
  }

  function clearMarks() {
    globe.htmlElementsData([]).arcsData([]).ringsData([]).polygonsData([]);
  }

  function nextRound() {
    state.phase = "guess";
    state.guess = null;
    clearMarks();
    const target = state.queue[state.i];
    const k = KINDS[state.kind];
    setFlap($("cityFlap"), k.title(target), {
      maxWidth: Math.min(window.innerWidth - 32, 860),
      maxTile: window.innerWidth < 560 ? 34 : 48,
      maxChars: window.innerWidth < 560 ? 11 : 16,
    });
    $("countryLabel").textContent = k.prompt(target);
    $("roundLabel").textContent = `${state.i + 1} / ${state.queue.length}`;
    $("scoreLabel").textContent = state.total.toLocaleString();
    show(ui.result, false);
    ui.action.disabled = true;
    ui.action.textContent = "Click the globe to drop a pin";

    // Pull back to a hemisphere view without moving to a new spot (no free hints).
    const pov = globe.pointOfView();
    const overview = overviewAltitude();
    if (pov.altitude < overview * 0.85) globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: overview }, reduceMotion ? 0 : 900);
  }

  function onGlobeClick(lat, lng) {
    if (state.phase !== "guess") return;
    state.guess = { lat, lng };
    globe.htmlElementsData([{ lat, lng, el: makePin(COLORS.guess) }]);
    ui.action.disabled = false;
    ui.action.textContent = "Lock in guess";
  }

  function reveal() {
    const target = state.queue[state.i];
    const g = state.guess;
    const guessPin = { lat: g.lat, lng: g.lng, el: makePin(COLORS.guess) };
    // Where the answer is shown: the capital, or the nearest edge of the country.
    let km, spot, viewKm, detail;

    if (state.kind === "capitals") {
      km = distanceKm(g, target);
      spot = target;
      viewKm = km;
      detail = `${fmtKm(km)} from ${target.capital}`;
      globe.htmlElementsData([guessPin, { ...target, el: makePin(COLORS.truth, target.capital) }]);
    } else {
      const shape = COUNTRY_SHAPES[target.country];
      const inside = insideShape(shape, g.lat, g.lng);
      const edge = inside ? null : nearestOnShape(majorPolys(target.country), g);
      km = inside ? 0 : edge.km;
      spot = inside ? g : edge;
      viewKm = Math.max(km, shapeExtentKm(target.country) * 0.6);
      detail = inside ? `Inside ${target.country}` : `${fmtKm(km)} outside ${target.country}`;
      globe
        .polygonsData([shapeFeature(target.country)])
        .htmlElementsData(inside ? [guessPin] : [guessPin, { lat: edge.lat, lng: edge.lng, el: makePin(COLORS.truth, target.country) }]);
    }

    const points = scoreFor(km);
    state.total += points;
    state.results.push({ ...target, km, points });
    state.phase = "reveal";

    globe
      .arcsData(km > 30 ? [{ startLat: g.lat, startLng: g.lng, endLat: spot.lat, endLng: spot.lng }] : [])
      .ringsData(km > 0 ? [{ lat: spot.lat, lng: spot.lng }] : []);

    const mid = midpoint(g, spot);
    const portrait = Math.max(1, (0.8 * window.innerHeight) / window.innerWidth);
    const altitude = Math.max(0.35, Math.min(overviewAltitude() * 1.2, (0.3 + (viewKm / 6000) * 1.9) * portrait));
    globe.pointOfView({ ...mid, altitude }, reduceMotion ? 0 : 1300);

    $("resultPoints").textContent = points;
    $("resultPointsWord").textContent = points === 1 ? "point" : "points";
    $("resultDistance").textContent = detail;
    show(ui.result, true);
    $("scoreLabel").textContent = state.total.toLocaleString();

    const last = state.i === state.queue.length - 1;
    ui.action.textContent = last ? "See results" : `Next ${KINDS[state.kind].one}`;
    ui.action.focus({ preventScroll: true });
  }

  function advance() {
    if (state.i >= state.queue.length - 1) return finish();
    state.i++;
    nextRound();
  }

  function finish() {
    if (state.phase === "guess" && state.results.length === 0) return goMenu();
    state.phase = "end";
    flapTimers.forEach(clearInterval);
    [ui.hud, ui.board, ui.dock].forEach((el) => show(el, false));
    clearMarks();

    const played = state.results.length;
    const max = played * 100;
    $("endScore").textContent = state.total.toLocaleString();
    $("endMax").textContent = `/ ${max.toLocaleString()}`;

    const k = KINDS[state.kind];
    const avgKm = state.results.reduce((s, r) => s + r.km, 0) / played;
    const perfect = state.results.filter((r) => r.points === 100).length;
    let summary;
    if (state.kind === "capitals") {
      const best = state.results.reduce((a, b) => (b.km < a.km ? b : a));
      summary = `Average miss ${fmtKm(avgKm)}. Closest was ${best.capital}, ${fmtKm(best.km)} off.`;
      if (perfect) summary += ` ${plural(perfect, "perfect pin")}.`;
    } else {
      const inside = state.results.filter((r) => r.km === 0).length;
      summary = `${inside} of ${played} pins landed inside the country. Average miss ${fmtKm(avgKm)}.`;
    }
    if (state.mode === "all" && played < state.queue.length) summary = `${played} of ${state.queue.length} ${k.many}. ` + summary;
    $("endSummary").textContent = summary;

    if (state.mode === "quick") {
      // The first finished run of the day is "today's score"; replays don't overwrite it.
      const prev = store.get(`today-${state.kind}`);
      const first = !prev || prev.day !== state.day;
      if (first) store.set(`today-${state.kind}`, { day: state.day, total: state.total });
      const date = new Date(state.day + "T12:00").toLocaleDateString(undefined, { month: "long", day: "numeric" });
      $("endKicker").textContent = first ? `Your score for ${date}` : `Replay of ${date}. Your first score was ${prev.total}.`;
    } else {
      const key = k.bestKey(state.mode);
      const prev = store.get(key);
      const isBest = !!prev && state.total > prev.total;
      if (!prev || state.total > prev.total) store.set(key, { total: state.total, played });
      $("endKicker").textContent = isBest ? "New best score" : "Final score";
    }

    const body = $("arrivals");
    body.innerHTML = "";
    for (const r of state.results) {
      const row = document.createElement("div");
      row.className = "arr-row";
      row.setAttribute("role", "row");
      row.innerHTML = `
        <span role="cell" class="arr-city"></span>
        <span role="cell" class="arr-dist num"></span>
        <span role="cell" class="arr-pts num${r.points === 0 ? " is-zero" : ""}"></span>`;
      const city = row.children[0];
      city.textContent = k.title(r);
      if (state.kind === "capitals") {
        const country = document.createElement("span");
        country.className = "arr-country";
        country.textContent = r.country;
        city.appendChild(country);
      }
      row.children[1].textContent = r.km === 0 ? "Inside" : fmtKm(r.km);
      row.children[2].textContent = r.points;
      body.appendChild(row);
    }

    controls.autoRotate = !reduceMotion;
    show(ui.end, true);
    $("againBtn").focus({ preventScroll: true });
  }

  // ---------- wiring ----------
  document.querySelectorAll(".kind input").forEach((input) =>
    input.addEventListener("change", () => {
      state.kind = input.value;
      store.set("kind", state.kind);
      renderBests();
    }));

  document.querySelectorAll(".mode").forEach((btn) =>
    btn.addEventListener("click", () => startGame(btn.dataset.mode)));

  ui.action.addEventListener("click", () => {
    if (state.phase === "guess" && state.guess) reveal();
    else if (state.phase === "reveal") advance();
  });
  ui.finish.addEventListener("click", finish);
  $("menuBtn").addEventListener("click", goMenu);
  $("againBtn").addEventListener("click", () => startGame(state.mode));
  $("modesBtn").addEventListener("click", goMenu);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
    if (state.phase === "guess" && state.guess) { e.preventDefault(); reveal(); }
    else if (state.phase === "reveal") { e.preventDefault(); advance(); }
  });

  goMenu();
})();
