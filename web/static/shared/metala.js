// Utilitaires partagés des interfaces Metala (prototype).
export const Metala = {};

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
export const hhmm = (d) => new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
export const ddmm = (d) => new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const FRESHNESS = {
  fresh: { label: "GPS frais", cls: "fresh" },
  delayed: { label: "GPS retardé", cls: "delayed" },
  unknown: { label: "Position inconnue", cls: "unknown" },
};

export function freshnessBadge(fr, age) {
  const f = FRESHNESS[fr] || FRESHNESS.unknown;
  const ageTxt = age >= 0 && fr !== "unknown" ? ` · ${age} s` : age > 0 ? ` · ${Math.round(age / 60)} min` : "";
  return `<span class="badge ${f.cls}"><span class="dot"></span>${f.label}${ageTxt}</span>`;
}

export const simBadge = (src) => (src === "simulator" ? `<span class="badge sim">Simulé</span>` : "");

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

// --- Carte (MapLibre + OpenStreetMap) ---

export const ABIDJAN = [-4.02, 5.345];

export function createMap(container, opts = {}) {
  const map = new maplibregl.Map({
    container,
    center: opts.center || ABIDJAN,
    zoom: opts.zoom || 12.2,
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "© contributeurs OpenStreetMap",
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#eef2f0" } },
        { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.75, "raster-contrast": -0.05, "raster-brightness-min": 0.08 } },
      ],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const el = typeof container === "string" ? document.getElementById(container) : container;
  if (window.ResizeObserver) new ResizeObserver(() => map.resize()).observe(el);
  return map;
}

export function drawNetwork(map, network, { onStopClick, operatorFilter } = {}) {
  const lines = network.lines.filter((l) => !operatorFilter || l.operator_id === operatorFilter);
  const lineFeatures = lines.map((l) => ({
    type: "Feature",
    properties: { id: l.id, color: l.color, code: l.code },
    geometry: { type: "LineString", coordinates: l.shape.map(([lat, lon]) => [lon, lat]) },
  }));
  const servedStops = new Set(lines.flatMap((l) => l.stop_ids));
  const stopFeatures = network.stops.filter((s) => servedStops.has(s.id)).map((s) => ({
    type: "Feature",
    properties: { id: s.id, name: s.name },
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
  }));
  map.addSource("lines", { type: "geojson", data: { type: "FeatureCollection", features: lineFeatures } });
  map.addLayer({ id: "lines-casing", type: "line", source: "lines", paint: { "line-color": "#fff", "line-width": 9 }, layout: { "line-cap": "round", "line-join": "round" } });
  map.addLayer({ id: "lines", type: "line", source: "lines", paint: { "line-color": ["get", "color"], "line-width": 5 }, layout: { "line-cap": "round", "line-join": "round" } });
  map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: stopFeatures } });
  map.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": "#0b5d4b", "circle-stroke-width": 3 } });
  if (onStopClick) {
    map.on("click", "stops", (e) => onStopClick(e.features[0].properties.id));
    map.on("mouseenter", "stops", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "stops", () => (map.getCanvas().style.cursor = ""));
  }
  const coords = lineFeatures.flatMap((f) => f.geometry.coordinates);
  if (coords.length) {
    const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding: 50, duration: 0 });
  }
}

// Marqueurs animés : chaque nouvelle position reçue est interpolée sur 1,5 s.
export class VehicleLayer {
  constructor(map, network, { onClick } = {}) {
    this.map = map;
    this.markers = new Map();
    this.lineColor = Object.fromEntries(network.lines.map((l) => [l.id, l.color]));
    this.onClick = onClick;
  }
  update(states) {
    const seen = new Set();
    for (const s of states) {
      if (!s.has_position) continue;
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
      m.el.textContent = s.line_code;
      m.el.title = `${s.line_code} · ${s.vehicle_id} · ${FRESHNESS[s.freshness].label}`;
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
