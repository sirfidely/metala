// Utilitaires partagés des interfaces Metala (prototype).

export async function api(path, { method = "GET", body, token, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `Erreur ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Délai dépassé : réseau indisponible");
      err.status = 0;
      err.timeout = true;
      throw err;
    }
    if (e instanceof TypeError) { const err = new Error("Réseau indisponible"); err.status = 0; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const fcfa = (n) => new Intl.NumberFormat("fr-FR").format(Math.round(n || 0)) + " FCFA";
// Heures affichées à l'heure d'Abidjan (GMT), quel que soit le fuseau du navigateur.
export const TZ = "Africa/Abidjan";
export const hhmm = (d) => new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
export const ddmm = (d) => new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: TZ });
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const params = new URLSearchParams(location.search);
export const embedded = params.get("embed") === "1";

export const FRESHNESS = {
  fresh: { label: "GPS en direct", cls: "fresh" },
  delayed: { label: "GPS retardé", cls: "delayed" },
  unknown: { label: "Position inconnue", cls: "unknown" },
};

export function freshnessBadge(fr, age) {
  const f = FRESHNESS[fr] || FRESHNESS.unknown;
  let ageTxt = "";
  if (fr !== "unknown" && age >= 0) ageTxt = ` · ${age} s`;
  else if (fr === "unknown" && age > 0) ageTxt = ` · ${Math.round(age / 60)} min`;
  return `<span class="badge ${f.cls}"><span class="dot"></span>${f.label}${ageTxt}</span>`;
}

export const simBadge = (src) => (src === "simulator" ? `<span class="badge sim" title="Position produite par le simulateur de démonstration">Simulé</span>` : "");

export function toast(msg, kind = "") {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Fenêtre de démo : les pages intégrées dans /demo/ gardent leur session dans
// sessionStorage (une session par onglet), les autres dans localStorage.
export const sessionStore = embedded ? {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
} : store;

// ---------- Géométrie des lignes ----------

const R = 6371000;
export function dist(a, b) { // a, b = [lat, lon]
  const t = Math.PI / 180;
  const dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Abscisse curviligne (m) d'un point projeté sur le tracé d'une ligne.
export function along(line, pt) {
  if (!line._cum) {
    line._cum = [0];
    for (let i = 1; i < line.shape.length; i++) line._cum.push(line._cum[i - 1] + dist(line.shape[i - 1], line.shape[i]));
  }
  const kx = Math.cos((pt[0] * Math.PI) / 180) * 111320, ky = 110540;
  let best = 0, bestD = Infinity;
  for (let i = 1; i < line.shape.length; i++) {
    const a = line.shape[i - 1], b = line.shape[i];
    const ax = a[1] * kx, ay = a[0] * ky, bx = b[1] * kx, by = b[0] * ky, px = pt[1] * kx, py = pt[0] * ky;
    const dx = bx - ax, dy = by - ay, seg = dx * dx + dy * dy;
    const t = seg > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / seg)) : 0;
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < bestD) { bestD = d; best = line._cum[i - 1] + t * (line._cum[i] - line._cum[i - 1]); }
  }
  return best;
}

// ---------- Carte (MapLibre) ----------
// Fond de carte : OpenFreeMap (vectoriel, gratuit, sans clé, données
// OpenStreetMap), puis repli automatique sur les tuiles raster OpenStreetMap,
// puis CARTO. Si aucun fournisseur ne répond, lignes, arrêts et bus restent
// affichés sur un fond neutre.

export const ABIDJAN = [-4.02, 5.345];

const PROVIDERS = {
  light: [
    { id: "openfreemap", label: "OpenFreeMap", style: "https://tiles.openfreemap.org/styles/positron" },
    { id: "osm", label: "OpenStreetMap", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attribution: "© contributeurs OpenStreetMap" },
    { id: "carto", label: "CARTO", tiles: ["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"], attribution: "© contributeurs OpenStreetMap © CARTO" },
  ],
  dark: [
    { id: "openfreemap", label: "OpenFreeMap", style: "https://tiles.openfreemap.org/styles/dark" },
    { id: "carto", label: "CARTO", tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"], attribution: "© contributeurs OpenStreetMap © CARTO" },
    { id: "osm", label: "OpenStreetMap", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attribution: "© contributeurs OpenStreetMap" },
  ],
};

function rasterStyle(p, dark) {
  return {
    version: 8,
    sources: p ? { base: { type: "raster", tiles: p.tiles, tileSize: 256, maxzoom: 19, attribution: p.attribution } } : {},
    layers: [
      { id: "bg", type: "background", paint: { "background-color": dark ? "#0d2a33" : "#eef1ee" } },
      ...(p ? [{ id: "base", type: "raster", source: "base", paint: { "raster-saturation": -0.35 } }] : []),
    ],
  };
}

async function fetchJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// createMap renvoie une carte prête ; onStyle(map, hasGlyphs) est rappelé à
// chaque (re)chargement du fond pour redessiner les couches Metala.
export async function createMap(container, { center, zoom, onStyle, dark = false } = {}) {
  const PROV = PROVIDERS[dark ? "dark" : "light"];
  let idx = 0, style = null;
  try { style = await fetchJSON(PROV[0].style, 4000); } catch { idx = 1; }
  if (!style) style = rasterStyle(PROV[idx], dark);
  const map = new maplibregl.Map({ container, center: center || ABIDJAN, zoom: zoom || 12, style, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.metalaProvider = PROV[idx].label;
  map.metalaDark = dark;
  const el = typeof container === "string" ? document.getElementById(container) : container;
  if (window.ResizeObserver) new ResizeObserver(() => map.resize()).observe(el);

  // Repli si les tuiles du fournisseur courant échouent en série.
  let failures = 0;
  map.on("error", (e) => {
    const src = e && (e.sourceId || (e.source && e.source.id));
    if (!src || src === "metala-lines" || src === "metala-stops") return;
    if (++failures < 6) return;
    failures = 0;
    idx++;
    map.metalaProvider = PROV[idx] ? PROV[idx].label : "aucun (fond neutre)";
    console.warn("Fond de carte indisponible, bascule vers", map.metalaProvider);
    map.setStyle(rasterStyle(PROV[idx], dark));
  });
  map.on("style.load", () => onStyle && onStyle(map, !!map.getStyle().glyphs));
  await new Promise((r) => (map.loaded() ? r() : map.once("load", r)));
  return map;
}

// Dessine lignes et arrêts (à appeler depuis onStyle).
export function drawNetwork(map, network, hasGlyphs, { operatorFilter, highlightLine } = {}) {
  const lines = network.lines.filter((l) => !operatorFilter || l.operator_id === operatorFilter);
  const lineFC = {
    type: "FeatureCollection",
    features: lines.map((l) => ({
      type: "Feature",
      properties: { id: l.id, color: l.color, dim: highlightLine && highlightLine !== l.id ? 1 : 0 },
      geometry: { type: "LineString", coordinates: l.shape.map(([lat, lon]) => [lon, lat]) },
    })),
  };
  const served = new Set(lines.flatMap((l) => l.stop_ids));
  const stopFC = {
    type: "FeatureCollection",
    features: network.stops.filter((s) => served.has(s.id)).map((s) => ({
      type: "Feature", properties: { id: s.id, name: s.name }, geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  };
  for (const id of ["metala-stop-labels", "metala-stops", "metala-lines", "metala-lines-casing"]) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ["metala-lines", "metala-stops"]) if (map.getSource(id)) map.removeSource(id);
  const dark = !!map.metalaDark;
  map.addSource("metala-lines", { type: "geojson", data: lineFC });
  map.addLayer({ id: "metala-lines-casing", type: "line", source: "metala-lines", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#0a2530" : "#ffffff", "line-width": 10, "line-opacity": ["case", ["==", ["get", "dim"], 1], 0.3, 1] } });
  map.addLayer({ id: "metala-lines", type: "line", source: "metala-lines", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 6, "line-opacity": ["case", ["==", ["get", "dim"], 1], 0.25, 1] } });
  map.addSource("metala-stops", { type: "geojson", data: stopFC });
  map.addLayer({ id: "metala-stops", type: "circle", source: "metala-stops", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 15, 8], "circle-color": dark ? "#0a2530" : "#fff", "circle-stroke-color": dark ? "#ffffff" : "#0b5d4b", "circle-stroke-width": 3 } });
  if (hasGlyphs) {
    map.addLayer({
      id: "metala-stop-labels", type: "symbol", source: "metala-stops", minzoom: 12.2,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.2], "text-anchor": "top", "text-max-width": 9 },
      paint: { "text-color": dark ? "#eaf4f2" : "#063a2f", "text-halo-color": dark ? "#0a2530" : "#ffffff", "text-halo-width": 1.6 },
    });
  }
}

export function onStopClick(map, cb) {
  map.on("click", "metala-stops", (e) => cb(e.features[0].properties.id));
  map.on("mouseenter", "metala-stops", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "metala-stops", () => (map.getCanvas().style.cursor = ""));
}

export function fitLines(map, lines, padding = 50) {
  const coords = lines.flatMap((l) => l.shape.map(([lat, lon]) => [lon, lat]));
  if (!coords.length) return;
  const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(b, { padding, duration: 0 });
}

// Marqueurs animés : chaque nouvelle position reçue est interpolée sur 1,5 s.
export class VehicleLayer {
  constructor(map, network, { onClick } = {}) {
    this.map = map;
    this.markers = new Map();
    this.lineColor = Object.fromEntries(network.lines.map((l) => [l.id, l.color]));
    this.onClick = onClick;
    this.filter = null;
    this.focus = null;
  }
  update(states) {
    const seen = new Set();
    for (const s of states) {
      if (!s.has_position || (this.filter && !this.filter(s))) continue;
      seen.add(s.vehicle_id);
      let m = this.markers.get(s.vehicle_id);
      if (!m) {
        const el = document.createElement("div");
        el.className = "bus-marker";
        el.addEventListener("click", (ev) => { ev.stopPropagation(); this.onClick && this.onClick(s.vehicle_id); });
        const marker = new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(this.map);
        m = { marker, el, from: [s.lon, s.lat], to: [s.lon, s.lat], t0: 0 };
        this.markers.set(s.vehicle_id, m);
      }
      m.el.style.background = this.lineColor[s.line_id] || "#0b5d4b";
      m.el.classList.remove("fresh", "delayed", "unknown"); // conserver les classes MapLibre
      m.el.classList.add(s.freshness);
      m.el.classList.toggle("focus", this.focus === s.vehicle_id);
      m.el.textContent = s.line_code;
      m.el.title = `${s.line_code} · ${FRESHNESS[s.freshness].label}`;
      const cur = m.marker.getLngLat();
      m.from = [cur.lng, cur.lat];
      m.to = [s.lon, s.lat];
      m.t0 = performance.now();
    }
    for (const [id, m] of this.markers) if (!seen.has(id)) { m.marker.remove(); this.markers.delete(id); }
    if (!this.raf) this.animate();
  }
  animate() {
    this.raf = requestAnimationFrame(() => {
      const now = performance.now();
      let moving = false;
      for (const m of this.markers.values()) {
        const k = Math.min(1, (now - m.t0) / 1500);
        if (k < 1) moving = true;
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        m.marker.setLngLat([m.from[0] + (m.to[0] - m.from[0]) * e, m.from[1] + (m.to[1] - m.from[1]) * e]);
      }
      this.raf = null;
      if (moving) this.animate();
    });
  }
}

// Flux temps réel (SSE) avec repli sur sondage.
export function subscribeVehicles(onData) {
  let es, poll;
  const startPoll = () => {
    if (poll) return;
    poll = setInterval(() => api("/api/vehicles").then(onData).catch(() => {}), 4000);
  };
  try {
    es = new EventSource("/api/stream/vehicles");
    es.addEventListener("vehicles", (e) => onData(JSON.parse(e.data)));
    es.onerror = () => { startPoll(); };
  } catch { startPoll(); }
  return () => { es && es.close(); poll && clearInterval(poll); };
}

// Attend qu'une condition soit vraie (utilisé par la démo guidée).
export const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 120)); }
  return null;
};
