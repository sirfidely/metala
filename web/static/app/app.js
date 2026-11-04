import {
  api, fcfa, hhmm, ddmm, esc, toast, store, sessionStore, freshnessBadge,
  createMap, VehicleLayer, subscribeVehicles, TZ,
} from "/shared/metala.js";
import { ic } from "/shared/icons.js";

const $ = (s) => document.querySelector(s);
const AWA_PHONE = "07 00 00 00 01";

const MODES = {
  bus: { label: "Bus", icon: "bus" },
  navette: { label: "Navette", icon: "van" },
  bateau: { label: "Bateau-bus", icon: "boat" },
  gbaka: { label: "Gbaka", icon: "van" },
  woro: { label: "Woro-woro", icon: "taxi" },
  taxi: { label: "Taxi compteur", icon: "taxi" },
};

const S = {
  token: sessionStore.get("metala.app.token"),
  me: null, network: null, products: [], vehicles: [],
  stack: [], route: null, maps: [], layers: [],
  favs: JSON.parse(store.get("metala.app.favlines") || '["ln_m2"]'),
  trip: null, // { from, to, when: now|depart|arrive, date, time, results }
  journeys: {},
};

const TAB_ICONS = { lines: "bus", trip: "route", pass: "qr", budget: "chart", profile: "user" };
document.querySelectorAll(".tabbar button").forEach((b) => {
  const t = b.dataset.tab;
  if (t === "pass") b.innerHTML = ic("qr", 28);
  else b.querySelector(".ti").innerHTML = ic(TAB_ICONS[t], 22);
});
$("#nav-back").innerHTML = ic("back");

// ---------- Aides ----------
const stopById = (id) => S.network.stops.find((s) => s.id === id);
const lineById = (id) => S.network.lines.find((l) => l.id === id);
const opById = (id) => S.network.operators.find((o) => o.id === id);
const modeIc = (mode, color, size = 20) => `<span class="mode-ic" style="background:${color}">${ic(MODES[mode]?.icon || "bus", size)}</span>`;
const chip = (l) => `<span class="line-chip" style="background:${l.color}">${esc(l.code)}</span>`;
const A = (o) => esc(JSON.stringify(o));
const num = (n) => new Intl.NumberFormat("fr-FR").format(n || 0);
const firstName = () => (S.me?.traveler.name || "").split(/[\s(]/)[0] || "Voyageur";
const card = () => S.me?.cards[0];
const opKind = { public: "Entreprise publique", prive: "Compagnie privée", artisanal: "Transport artisanal", taxi: "Taxis" };
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
const minutesTo = (t) => Math.round((new Date(t) - Date.now()) / 60000);
function activeTitles() {
  const now = Date.now();
  return (S.me?.titles || []).filter((t) => new Date(t.valid_until) > now && (t.kind === "monthly" || t.trips_remaining > 0));
}
const coveredBy = (operatorId) => activeTitles().find((t) => t.operator_id === operatorId);

// ---------- Connexion ----------
async function sendOtp(phone) {
  const r = await api("/api/auth/otp/request", { method: "POST", body: { phone } });
  $("#step-phone").classList.add("hidden");
  $("#step-code").classList.remove("hidden");
  if (r.dev_code) {
    $("#dev-otp").innerHTML = `Code de démo : <b class="mono">${esc(r.dev_code)}</b>`;
    $("#dev-otp").classList.remove("hidden");
    $("#code").value = r.dev_code;
  }
}
async function verify() {
  const r = await api("/api/auth/otp/verify", { method: "POST", body: { phone: $("#phone").value, code: $("#code").value.trim() } });
  S.token = r.token;
  sessionStore.set("metala.app.token", r.token);
  await enter();
}
async function loginAsAwa() { $("#phone").value = AWA_PHONE; await sendOtp(AWA_PHONE); await verify(); }
$("#btn-otp").onclick = () => sendOtp($("#phone").value).catch((e) => toast(e.message, "error"));
$("#btn-awa").onclick = () => loginAsAwa().catch((e) => toast(e.message, "error"));
$("#btn-verify").onclick = () => verify().catch((e) => toast(e.message, "error"));
$("#btn-back").onclick = () => { $("#step-code").classList.add("hidden"); $("#step-phone").classList.remove("hidden"); };

async function refreshMe() {
  try { S.me = await api("/api/me", { token: S.token }); }
  catch (e) {
    if (e.status !== 401) return;
    sessionStore.del("metala.app.token");
    location.reload();
  }
}
async function enter() {
  S.me = await api("/api/me", { token: S.token });
  $("#login").classList.add("hidden");
  $("#main").classList.remove("hidden");
  go("lines", {}, true);
}

// ---------- Navigation ----------
const TITLES = { trip: "Trajet", journey: "Votre trajet", pass: "Payer", recharge: "Recharger", budget: "Budget transport", history: "Mes trajets", places: "Mes lieux" };
const TAB_OF = { lines: "lines", line: "lines", trip: "trip", journey: "trip", pass: "pass", recharge: "pass", budget: "budget", profile: "profile", history: "profile", places: "profile" };

function go(name, args = {}, root = false) {
  if (root) S.stack = [];
  else if (S.route) S.stack.push(S.route);
  S.route = { name, args };
  render();
}
function back() { if (S.stack.length) { S.route = S.stack.pop(); render(); } }
$("#nav-back").onclick = back;
document.querySelectorAll(".tabbar button").forEach((b) => (b.onclick = () => go(b.dataset.tab, {}, true)));

let seq = 0;
async function render(keepScroll = false) {
  const { name, args } = S.route;
  const my = ++seq;
  $("#appbar").classList.toggle("hidden-bar", name === "lines" || name === "profile");
  $("#title").textContent = args.title ?? TITLES[name] ?? "";
  $("#nav-back").style.visibility = S.stack.length ? "visible" : "hidden";
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === TAB_OF[name]));
  clearInterval(S.viewTimer);
  const html = await V[name](args);
  if (my !== seq) return;
  for (const m of S.maps) m.remove();
  S.maps = []; S.layers = [];
  const top = $("#view").scrollTop;
  $("#view").innerHTML = html;
  $("#view").scrollTop = keepScroll ? top : 0;
  bind($("#view"));
  if (V[name].after) V[name].after(args);
}

function bind(root) {
  root.querySelectorAll("[data-go]").forEach((el) => (el.onclick = (e) => {
    e.preventDefault();
    go(el.dataset.go, el.dataset.a ? JSON.parse(el.dataset.a) : {}, el.dataset.root === "1");
  }));
  root.querySelectorAll("[data-fav]").forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    const id = el.dataset.fav;
    S.favs = S.favs.includes(id) ? S.favs.filter((x) => x !== id) : [...S.favs, id];
    store.set("metala.app.favlines", JSON.stringify(S.favs));
    el.classList.toggle("on", S.favs.includes(id));
  }));
  root.querySelectorAll("[data-book]").forEach((el) => (el.onclick = () => openBooking(el.dataset.book)));
}

// ---------- Itinéraires ----------
function legsHtml(j) {
  return `<div class="legs">${j.legs.map((l, i) => {
    const sep = i ? `<span class="sep">›</span>` : "";
    if (l.kind === "walk") return l.minutes >= 1 ? `${sep}<span class="w">${ic("walk", 15)}${l.minutes}</span>` : "";
    return `${sep}<span class="lc" style="background:${l.color}">${ic(MODES[l.mode]?.icon || "bus", 14)}${esc(l.line_code)}</span>`;
  }).join("")}</div>`;
}
function firstRide(j) { return j.legs.find((l) => l.kind === "ride"); }
function liveTxt(j) {
  const r = firstRide(j);
  if (!r?.live) return "";
  return `<span class="badge fresh"><span class="dot"></span>${MODES[r.mode].label} localisé · ${r.live.eta_minutes <= 0 ? "à l’arrêt" : `dans ${r.live.eta_minutes} min`}</span>`;
}
function fareTxt(j) {
  const rides = j.legs.filter((l) => l.kind === "ride");
  if (!rides.length) return "Gratuit";
  const due = rides.filter((r) => !coveredBy(r.operator_id)).reduce((a, r) => a + r.fare, 0);
  return due ? fcfa(due) : "Inclus dans vos titres";
}

async function plan(from, to, when = "now", at = null) {
  const body = { from, to };
  if (at) { body.at = at; body.arrive_by = when === "arrive"; }
  const js = await api("/api/journeys", { method: "POST", body });
  for (const j of js) S.journeys[j.id] = j;
  return js;
}

// ---------- Vue : Lignes (accueil) ----------
const V = {};

V.lines = async ({ mode = "" } = {}) => {
  const t = S.me.traveler;
  let commute = "";
  if (t.home && t.work) {
    const hour = Number(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }));
    const [from, to, label] = hour < 13 ? [t.home, t.work, "Maison → Travail"] : [t.work, t.home, "Travail → Maison"];
    const js = await plan(from, to).catch(() => []);
    const j = js[0];
    if (j) {
      const leave = minutesTo(j.depart);
      commute = `<button class="commute" data-go="journey" data-a="${A({ id: j.id })}">
        <div class="lbl">${ic(hour < 13 ? "briefcase" : "home", 15)}${label}</div>
        <div class="big">${leave <= 0 ? "Partez maintenant" : `Partez à ${hhmm(j.depart)}`}</div>
        <div class="meta">${legsHtml(j)}<span class="pillw">Arrivée ${hhmm(j.arrive)}</span></div>
      </button>`;
    }
  }
  const lines = S.network.lines.filter((l) => !mode || l.mode === mode);
  const live = {};
  for (const v of S.vehicles) if (v.freshness !== "unknown" && v.line_id) live[v.line_id] = (live[v.line_id] || 0) + 1;
  const modes = [...new Set(S.network.lines.map((l) => l.mode))];
  const lineRow = (l) => `<button class="row-i" data-go="line" data-a="${A({ id: l.id, title: "Ligne " + l.code })}">
      ${modeIc(l.mode, l.color)}<div class="grow"><div class="t">${esc(l.code)} · ${esc(l.name)}</div>
      <div class="s">${MODES[l.mode].label} · toutes les ${l.headway_min} min · ${live[l.id] || 0} en service</div></div>
      <span class="chev">${ic("chev", 18)}</span></button>`;
  const favs = S.favs.map(lineById).filter(Boolean);
  return `
    <div class="hello"><div class="avatar">${esc(firstName()[0])}</div>
      <div class="who"><small>Bonjour</small><div>${esc(firstName())}</div></div></div>
    <button class="search-box" style="margin:6px 16px 0;width:calc(100% - 32px);display:flex;align-items:center;gap:10px;background:var(--a-surface);border:1px solid var(--a-border);border-radius:16px;padding:15px 16px;color:var(--a-muted);font-size:16px" data-go="trip" data-root="1">${ic("search", 20)}Où allez-vous ?</button>
    ${commute}
    ${favs.length && !mode ? `<div class="sec"><h3>Mes lignes</h3></div><div class="panel">${favs.map(lineRow).join("")}</div>` : ""}
    <div class="sec"><h3>Réseau</h3><small>${S.network.lines.length} lignes · ${S.network.operators.length} opérateurs</small></div>
    <div class="chips-row"><button class="fchip ${!mode ? "on" : ""}" data-m="">Tous</button>${modes.map((m) => `<button class="fchip ${mode === m ? "on" : ""}" data-m="${m}">${ic(MODES[m].icon, 15)}${MODES[m].label}</button>`).join("")}<button class="fchip ${mode === "taxi" ? "on" : ""}" data-m="taxi">${ic("taxi", 15)}Taxi</button></div>
    ${mode === "taxi" ? `<div class="panel"><div class="row-i">${modeIc("taxi", "#E11D48")}<div class="grow"><div class="t">Taxis compteurs</div><div class="s">Pas de ligne : payez la course avec votre Pass</div></div></div></div>`
      : `<div class="panel">${lines.map(lineRow).join("")}</div>`}`;
};
V.lines.after = () => document.querySelectorAll(".fchip").forEach((b) => (b.onclick = () => { S.route.args = { mode: b.dataset.m }; render(true); }));

// ---------- Vue : une ligne ----------
function nextDeparturesFromTerminus(l, dir, count = 1) {
  // Prochains départs du terminus (horaires théoriques), à l'heure d'Abidjan.
  const now = new Date();
  const out = [];
  const [fh, fm] = l.first_dep.split(":").map(Number), [lh, lm] = l.last_dep.split(":").map(Number);
  const dayStart = new Date(dayKey(now) + "T00:00:00Z");
  for (let d = 0; d < 2 && out.length < count; d++) {
    const base = new Date(dayStart.getTime() + d * 86400000);
    for (let m = fh * 60 + fm; m <= lh * 60 + lm && out.length < count; m += l.headway_min) {
      const t = new Date(base.getTime() + m * 60000);
      if (t > now - 60000) out.push(t);
    }
  }
  return out;
}

V.line = async ({ id, dir = 1 }) => {
  const l = lineById(id);
  const op = opById(l.operator_id);
  const n = l.stop_ids.length;
  const order = dir > 0 ? l.stop_ids : [...l.stop_ids].reverse();
  const offs = order.map((sid) => { const i = l.stop_ids.indexOf(sid); return dir > 0 ? l.stop_minutes[i] : l.stop_minutes[n - 1] - l.stop_minutes[i]; });
  const [dep] = nextDeparturesFromTerminus(l, dir, 1);
  const fare = S.products.find((p) => p.operator_id === l.operator_id && p.kind === "single");
  const buses = S.vehicles.filter((v) => v.line_id === id && v.has_position && v.freshness !== "unknown" && (v.direction >= 0 ? 1 : -1) === dir);
  // position approximative du bus : arrêt le plus proche
  const near = (v) => {
    let best = 0, bd = Infinity;
    order.forEach((sid, i) => { const s = stopById(sid); const d = (s.lat - v.lat) ** 2 + (s.lon - v.lon) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const busAt = {};
  for (const b of buses) { const i = near(b); (busAt[i] ||= []).push(b); }
  const rows = order.map((sid, i) => {
    const s = stopById(sid);
    const t = dep ? new Date(dep.getTime() + offs[i] * 60000) : null;
    const bus = busAt[i] ? `<div class="tl-bus ${busAt[i][0].freshness}"><span class="tl-rail"><span class="bus-dot" style="background:${l.color}">${ic(MODES[l.mode].icon, 14)}</span></span><span>${busAt[i].length > 1 ? `${busAt[i].length} véhicules` : "Véhicule"} ici · ${freshnessBadge(busAt[i][0].freshness, busAt[i][0].age_seconds)}</span></div>` : "";
    return `${bus}<div class="tl-stop ${i === n - 1 ? "last" : ""}"><span class="tl-rail"><span class="tl-dot"></span></span><span class="tl-name">${esc(s.name)}</span><span class="tl-time">${t ? hhmm(t) : ""}</span></div>`;
  }).join("");
  const term = (d) => stopById(d > 0 ? l.stop_ids[n - 1] : l.stop_ids[0]).name;
  return `
    <div class="line-head">${modeIc(l.mode, l.color, 22)}<div class="grow">${esc(l.code)} · ${esc(l.name)}<div class="muted" style="font-size:13px;font-weight:500">${esc(op.name)} · ${opKind[op.kind] || ""}</div></div>
      <button class="star ${S.favs.includes(id) ? "on" : ""}" data-fav="${id}" aria-label="Ligne favorite">${ic("star", 22)}</button></div>
    <div class="minimap" id="line-map"></div>
    <div class="facts">
      <div class="fact"><small>Fréquence</small><b>${l.headway_min} min</b></div>
      <div class="fact"><small>Service</small><b>${l.first_dep}–${l.last_dep}</b></div>
      <div class="fact"><small>Tarif</small><b>${fare ? fcfa(fare.price) : "—"}</b></div>
    </div>
    <div class="seg" style="margin-top:14px"><button data-d="1" class="${dir > 0 ? "on" : ""}">→ ${esc(term(1))}</button><button data-d="-1" class="${dir < 0 ? "on" : ""}">→ ${esc(term(-1))}</button></div>
    <div class="sec" style="padding-top:2px"><h3>Prochain départ</h3><small>${dep ? `${hhmm(dep)} · horaires prévus` : "service terminé"}</small></div>
    <div class="timeline" style="--lc:${l.color}">${rows}</div>
    ${l.reservable ? `<div class="bottom-btn"><button class="pill-btn ghost" data-book="${l.id}" style="width:100%">Réserver une place</button></div>` : ""}`;
};
V.line.after = async ({ id, dir = 1 }) => {
  document.querySelectorAll(".seg [data-d]").forEach((b) => (b.onclick = () => { S.route.args = { ...S.route.args, dir: Number(b.dataset.d) }; render(true); }));
  const l = lineById(id);
  const map = await createMap("line-map", { dark: true, onStyle: (m, g) => drawRoute(m, [{ coords: l.shape, color: l.color }], l.stop_ids.map(stopById), g) });
  if (!map) return;
  S.maps.push(map);
  map.scrollZoom.disable();
  fitShape(map, l.shape, 24);
  const layer = new VehicleLayer(map, S.network);
  layer.filter = (v) => v.line_id === id;
  layer.update(S.vehicles);
  S.layers.push(layer);
};

// ---------- Cartes : tracés ----------
function drawRoute(map, segs, stops, glyphs) {
  const dark = !!map.metalaDark;
  for (const id of ["r-labels", "r-stops", "r-line", "r-walk", "r-casing"]) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ["r-segs", "r-stops"]) if (map.getSource(id)) map.removeSource(id);
  map.addSource("r-segs", { type: "geojson", data: { type: "FeatureCollection", features: segs.map((s) => ({ type: "Feature", properties: { color: s.color || "#fff", walk: s.walk ? 1 : 0 }, geometry: { type: "LineString", coordinates: s.coords.map(([a, b]) => [b, a]) } })) } });
  map.addLayer({ id: "r-casing", type: "line", source: "r-segs", filter: ["==", ["get", "walk"], 0], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dark ? "#0a2530" : "#fff", "line-width": 9 } });
  map.addLayer({ id: "r-line", type: "line", source: "r-segs", filter: ["==", ["get", "walk"], 0], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 5 } });
  map.addLayer({ id: "r-walk", type: "line", source: "r-segs", filter: ["==", ["get", "walk"], 1], layout: { "line-cap": "round" }, paint: { "line-color": dark ? "#eaf4f2" : "#374151", "line-width": 3, "line-dasharray": [0.5, 2] } });
  map.addSource("r-stops", { type: "geojson", data: { type: "FeatureCollection", features: stops.map((s) => ({ type: "Feature", properties: { name: s.name }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) } });
  map.addLayer({ id: "r-stops", type: "circle", source: "r-stops", paint: { "circle-radius": 5, "circle-color": dark ? "#0a2530" : "#fff", "circle-stroke-color": dark ? "#fff" : "#0b5d4b", "circle-stroke-width": 2.5 } });
  if (glyphs) map.addLayer({ id: "r-labels", type: "symbol", source: "r-stops", minzoom: 12.5, layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 8 }, paint: { "text-color": "#eaf4f2", "text-halo-color": "#0a2530", "text-halo-width": 1.5 } });
}
function fitShape(map, coords, padding = 30) {
  const pts = coords.map(([a, b]) => [b, a]);
  const bounds = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(bounds, { padding, duration: 0 });
}

// ---------- Vue : Trajet (porte-à-porte) ----------
function defaultTrip() {
  const t = S.me.traveler;
  return { from: t.home || null, to: t.work || null, when: "now", date: dayKey(new Date()), time: "07:30", results: null };
}
const placeLabel = (p) => p ? esc(p.name) : `<span class="muted">Choisir…</span>`;

V.trip = async () => {
  S.trip ||= defaultTrip();
  const tr = S.trip;
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  let res = "";
  if (tr.results) {
    res = tr.results.length ? tr.results.map((j) => `
      <button class="jcard" data-go="journey" data-a="${A({ id: j.id })}">
        <div class="times"><b>${hhmm(j.depart)} → ${hhmm(j.arrive)}</b><span>${j.minutes} min</span></div>
        <div style="margin-top:10px">${legsHtml(j)}</div>
        <div class="foot"><span>${j.transfers ? `${j.transfers} correspondance` : j.legs.some((l) => l.kind === "ride") ? "Direct" : "À pied"} · ${j.walk_minutes} min à pied · ${fareTxt(j)}</span>${liveTxt(j)}</div>
      </button>`).join("") : `<div class="empty">Aucun trajet trouvé à cette heure</div>`;
  }
  return `
    <div class="od">
      <div class="od-row"><span class="pin from"></span><button class="field-btn" id="pick-from"><span><small>Départ</small>${placeLabel(tr.from)}</span></button></div>
      <div class="od-row"><span class="pin to"></span><button class="field-btn" id="pick-to"><span><small>Arrivée</small>${placeLabel(tr.to)}</span></button></div>
      <button class="swap" id="od-swap" aria-label="Inverser">${ic("swap", 18)}</button>
    </div>
    <div class="when">
      <div class="seg"><button data-w="now" class="${tr.when === "now" ? "on" : ""}">Maintenant</button><button data-w="depart" class="${tr.when === "depart" ? "on" : ""}">Partir à</button><button data-w="arrive" class="${tr.when === "arrive" ? "on" : ""}">Arriver avant</button></div>
      ${tr.when !== "now" ? `<div class="when-row"><input type="date" id="w-date" value="${tr.date}" aria-label="Date"><input type="time" id="w-time" value="${tr.time}" aria-label="Heure"></div>
        <div class="chips-row" style="padding:10px 0 0"><button class="fchip ${tr.date === dayKey(new Date()) ? "on" : ""}" data-day="${dayKey(new Date())}">Aujourd’hui</button><button class="fchip ${tr.date === tomorrow ? "on" : ""}" data-day="${tomorrow}">Demain</button></div>` : ""}
    </div>
    <div class="bottom-btn" style="margin-top:14px"><button class="pill-btn primary" id="go-plan" style="width:100%" ${tr.from && tr.to ? "" : "disabled"}>${ic("search", 18)}Rechercher</button></div>
    ${res}`;
};
V.trip.after = () => {
  const tr = S.trip;
  $("#pick-from").onclick = () => pickPlace("Départ", (p) => { tr.from = p; tr.results = null; render(); });
  $("#pick-to").onclick = () => pickPlace("Arrivée", (p) => { tr.to = p; tr.results = null; render(); });
  $("#od-swap").onclick = () => { [tr.from, tr.to] = [tr.to, tr.from]; tr.results = null; render(); };
  document.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => { tr.when = b.dataset.w; tr.results = null; render(true); }));
  document.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { tr.date = b.dataset.day; render(true); }));
  if ($("#w-date")) { $("#w-date").onchange = (e) => (tr.date = e.target.value); $("#w-time").onchange = (e) => (tr.time = e.target.value); }
  $("#go-plan").onclick = searchTrip;
};
async function searchTrip() {
  const tr = S.trip;
  const at = tr.when === "now" ? null : new Date(`${tr.date}T${tr.time}:00Z`).toISOString(); // Abidjan = GMT
  try { tr.results = await plan(tr.from, tr.to, tr.when, at); } catch (e) { toast(e.message, "error"); return; }
  render(true);
}

V.journey = async ({ id }) => {
  const j = S.journeys[id];
  if (!j) return `<div class="empty">Trajet expiré</div>`;
  const steps = [];
  steps.push(`<div class="step"><span class="t">${hhmm(j.depart)}</span><span class="ico">${ic("home", 16)}</span><div class="d"><b>Partez de ${esc(j.legs[0].from.name)}</b></div></div>`);
  for (const l of j.legs) {
    if (l.kind === "walk") {
      if (l.minutes >= 1) steps.push(`<div class="step"><span class="t"></span><span class="ico">${ic("walk", 16)}</span><div class="d">Marchez ${l.minutes} min<small>${num(l.meters)} m jusqu’à ${esc(l.to.name)}</small></div></div>`);
      continue;
    }
    const covered = coveredBy(l.operator_id);
    steps.push(`<div class="step"><span class="t">${hhmm(l.depart)}</span><span class="ico" style="background:${l.color};color:#fff">${ic(MODES[l.mode].icon, 16)}</span>
      <div class="d"><b>${MODES[l.mode].label} ${esc(l.line_code)}</b> direction ${esc(l.headsign)}
        <small>À ${esc(l.from.name)} · ${l.stops} arrêt${l.stops > 1 ? "s" : ""} · ${l.minutes} min</small>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${l.live ? freshnessBadge(l.live.freshness, l.live.age_seconds) : `<span class="badge">horaire prévu</span>`}
        <span class="badge">${covered ? esc(covered.name) : fcfa(l.fare)}</span></div></div></div>`);
    steps.push(`<div class="step"><span class="t">${hhmm(l.arrive)}</span><span class="ico">${ic("pin", 16)}</span><div class="d">Descendez à ${esc(l.to.name)}</div></div>`);
  }
  steps.push(`<div class="step"><span class="t">${hhmm(j.arrive)}</span><span class="ico" style="background:var(--a-green-2);color:#04281e">${ic("check", 16)}</span><div class="d"><b>Arrivée · ${esc(j.legs[j.legs.length - 1].to.name)}</b></div></div>`);
  const reservable = j.legs.find((l) => l.kind === "ride" && l.reservable);
  return `
    <div class="minimap" id="j-map" style="height:240px"></div>
    <div class="facts"><div class="fact"><small>Durée</small><b>${j.minutes} min</b></div><div class="fact"><small>À pied</small><b>${j.walk_minutes} min</b></div><div class="fact"><small>Prix</small><b>${fareTxt(j)}</b></div></div>
    <div class="steps">${steps.join("")}</div>
    <div class="bottom-btn">${uncovered(j).length ? `<button class="pill-btn primary" id="j-pay" style="width:100%">${ic("wallet", 18)}Payer ce trajet · ${fcfa(uncovered(j).reduce((a, l) => a + l.fare, 0))}</button>` : `<div class="badge ok" style="display:flex;justify-content:center;padding:10px;font-size:14px;margin-bottom:10px">${ic("check", 16)} Trajet couvert par vos titres</div>`}
      <button class="pill-btn ghost" id="j-alert" style="width:100%">${ic("bell", 18)}Me prévenir quand partir</button>
      ${reservable ? `<button class="pill-btn ghost" data-book="${reservable.line_id}" style="width:100%">Réserver une place · ${esc(reservable.line_code)}</button>` : ""}</div>`;
};
V.journey.after = async ({ id }) => {
  const j = S.journeys[id];
  if (!j) return;
  if ($("#j-pay")) $("#j-pay").onclick = () => payTrip(j);
  $("#j-alert").onclick = () => {
    const ms = new Date(j.depart) - Date.now() - 5 * 60000;
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    toast(ms > 0 ? `Rappel à ${hhmm(new Date(Date.now() + ms))}, 5 min avant le départ` : "Il est temps de partir !", "success");
    if (ms > 0) setTimeout(() => {
      toast(`Partez maintenant pour votre ${firstRide(j)?.line_code || "trajet"}`, "success");
      if ("Notification" in window && Notification.permission === "granted") new Notification("Metala", { body: "Il est temps de partir." });
    }, Math.min(ms, 2 ** 31 - 1));
  };
  const segs = j.legs.map((l) => ({ coords: l.shape, color: l.color, walk: l.kind === "walk" }));
  const stops = j.legs.filter((l) => l.kind === "ride").flatMap((l) => [l.from, l.to]);
  const map = await createMap("j-map", { dark: true, onStyle: (m, g) => drawRoute(m, segs, stops, g) });
  if (!map) return;
  S.maps.push(map);
  fitShape(map, j.legs.flatMap((l) => l.shape), 30);
  for (const [p, color] of [[j.legs[0].from, "#34d399"], [j.legs[j.legs.length - 1].to, "#f5a24b"]]) {
    const el = document.createElement("div");
    el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${color};border:3px solid #0a2530`;
    new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  }
  const r = firstRide(j);
  if (r?.live) {
    const layer = new VehicleLayer(map, S.network);
    layer.filter = (v) => v.vehicle_id === r.live.vehicle_id;
    layer.focus = r.live.vehicle_id;
    layer.update(S.vehicles);
    S.layers.push(layer);
  }
};

// Tickets à acheter pour un trajet : les tronçons non couverts par un titre.
function uncovered(j) {
  return j.legs.filter((l) => l.kind === "ride" && !coveredBy(l.operator_id));
}

// Payer un trajet : un ticket par compagnie empruntée, en un seul paiement.
function payTrip(j) {
  const legs = uncovered(j);
  const total = legs.reduce((a, l) => a + l.fare, 0);
  let method = METHODS[0].id;
  modal(`<div class="m-head"><strong>Payer ce trajet</strong><button class="icon-btn" id="pt-x">${ic("x")}</button></div>
    <div class="amount">${fcfa(total)}</div>
    <div class="panel" style="margin:12px 0 0">${legs.map((l) => `<div class="row-i"><span class="mode-ic" style="background:${l.color}">${ic(MODES[l.mode].icon, 18)}</span><div class="grow"><div class="t">Ticket ${esc(l.line_code)}</div><div class="s">${esc(opById(l.operator_id)?.name || "")}</div></div><b>${fcfa(l.fare)}</b></div>`).join("")}</div>
    <div class="methods">${METHODS.map((m, i) => `<button class="method ${i === 0 ? "on" : ""}" data-m="${m.id}"><span class="mi" style="background:${m.color}">${m.short}</span>${m.label}</button>`).join("")}</div>
    <button class="pill-btn primary" id="pt-go" style="width:100%">Payer ${fcfa(total)}</button>`, () => {
    document.querySelectorAll(".method").forEach((b) => (b.onclick = () => { method = b.dataset.m; document.querySelectorAll(".method").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#pt-x").onclick = closeModal;
    $("#pt-go").onclick = async () => {
      const m = METHODS.find((x) => x.id === method);
      modal(`<div class="success"><div class="spinner"></div><strong>Validez sur votre téléphone</strong><p>${m.label} · ${fcfa(total)}</p></div>`);
      try {
        if (!S.products.length) S.products = await api("/api/products");
        for (const l of legs) {
          const prod = S.products.find((p) => p.operator_id === l.operator_id && p.kind === "single");
          const pay = await api("/api/purchases", { method: "POST", token: S.token, body: { product_id: prod.id } });
          await api(`/api/dev/psp/${pay.id}/confirm?status=succeeded`, { method: "POST" });
        }
        await refreshMe();
        modal(`<div class="success"><div class="check">${ic("check", 42)}</div><strong>Trajet payé</strong><p>Vos tickets sont sur votre Metala Pass. Présentez la carte ou le QR à la montée.</p></div>
          <button class="pill-btn primary" id="ok" style="width:100%">OK</button>`, () => ($("#ok").onclick = () => { closeModal(); render(true); }));
      } catch (e) { closeModal(); toast(e.message, "error"); }
    };
  });
}

// ---------- Choix d'un lieu (n'importe où, pas seulement un arrêt) ----------
function pickPlace(title, cb) {
  const t = S.me.traveler;
  const saved = [t.home && { ...t.home, icon: "home", label: "Maison" }, t.work && { ...t.work, icon: "briefcase", label: "Travail" }].filter(Boolean);
  const done = (p) => { closeModal(); cb({ name: p.name, lat: p.lat, lon: p.lon, id: p.id }); };
  modal(`<div class="m-head"><strong>${esc(title)}</strong><button class="icon-btn" id="pp-x">${ic("x")}</button></div>
    <div class="phone-input" style="margin:12px 0"><span>${ic("search", 18)}</span><input id="pp-q" placeholder="Quartier, lieu, arrêt…" autocomplete="off"></div>
    <div class="panel pick-list" style="margin:0" id="pp-list"></div>`, async () => {
    $("#pp-x").onclick = closeModal;
    const head = `
      <button class="row-i" id="pp-geo"><span class="tile-ic">${ic("locate")}</span><div class="grow"><div class="t">Ma position</div></div></button>
      <button class="row-i" id="pp-map"><span class="tile-ic">${ic("map")}</span><div class="grow"><div class="t">Choisir sur la carte</div></div></button>
      ${saved.map((p, i) => `<button class="row-i" data-saved="${i}"><span class="tile-ic">${ic(p.icon)}</span><div class="grow"><div class="t">${p.label}</div><div class="s">${esc(p.name)}</div></div></button>`).join("")}`;
    const fill = async (q) => {
      const list = await api(`/api/places?q=${encodeURIComponent(q)}`).catch(() => []);
      $("#pp-list").innerHTML = (q ? "" : head) + list.slice(0, 25).map((p, i) => `<button class="row-i" data-i="${i}"><span class="tile-ic">${ic(p.kind === "stop" ? "pin" : "star", 18)}</span><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${p.kind === "stop" ? "Arrêt" : "Lieu"}</div></div></button>`).join("");
      $("#pp-list").querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => done(list[+b.dataset.i])));
      $("#pp-list").querySelectorAll("[data-saved]").forEach((b) => (b.onclick = () => done(saved[+b.dataset.saved])));
      const geo = $("#pp-geo");
      if (geo) geo.onclick = () => {
        if (!navigator.geolocation) return toast("Géolocalisation indisponible", "error");
        navigator.geolocation.getCurrentPosition((pos) => {
          const { latitude: lat, longitude: lon } = pos.coords;
          if (lat < 4.9 || lat > 5.8 || lon < -4.6 || lon > -3.5) return toast("Vous êtes hors du Grand Abidjan", "error");
          done({ name: "Ma position", lat, lon });
        }, () => toast("Position refusée", "error"), { timeout: 8000 });
      };
      const pm = $("#pp-map");
      if (pm) pm.onclick = () => pickOnMap(title, done);
    };
    let deb;
    $("#pp-q").oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => fill(e.target.value.trim()), 200); };
    fill("");
  });
}

async function pickOnMap(title, done) {
  modal(`<div class="m-head"><strong>${esc(title)} · sur la carte</strong><button class="icon-btn" id="pm-x">${ic("x")}</button></div>
    <div class="picker-map"><div id="pm-map" style="position:absolute;inset:0"></div><span class="center-pin">${ic("pin", 40)}</span></div>
    <button class="pill-btn primary" id="pm-ok" style="width:100%;margin-top:12px">Choisir ce point</button>`, async () => {
    $("#pm-x").onclick = closeModal;
    const map = await createMap("pm-map", { dark: true, zoom: 13 });
    if (!map) return;
    const c = S.me.traveler.home;
    if (c) map.jumpTo({ center: [c.lon, c.lat], zoom: 14 });
    $("#pm-ok").onclick = () => {
      const { lng, lat } = map.getCenter();
      map.remove();
      done({ name: `Point choisi (${lat.toFixed(4)}, ${lng.toFixed(4)})`, lat, lon: lng });
    };
  });
}

// ---------- Vue : Payer (Pass) ----------
V.pass = async ({ tab = "card" } = {}) => {
  await refreshMe();
  const c = card();
  const titles = activeTitles();
  const off = c?.status !== "active";
  const cardView = `
    <div class="carousel" style="padding-top:6px"><div class="pcard front ${off ? "revoked" : ""}" id="pass-card" style="flex-basis:100%">
      <div class="brand">METALA PASS</div><div class="nfc">${ic("nfc", 26)}</div>
      <div class="bal-l">Porte-monnaie</div><div class="bal">${num(c?.balance)} <small>FCFA</small></div>
      <div class="foot"><span class="mono">${c ? esc(c.uid.slice(0, 4) + " •••• " + c.uid.slice(-4)) : ""}</span><span>${off ? "Bloquée" : esc(firstName())}</span></div>
    </div></div>
    <div class="tap-anim">${ic("nfc", 50)}</div>
    <p class="muted" style="text-align:center;margin:0">Posez la carte sur le valideur</p>`;
  const phoneView = `
    <div class="qr-box" id="qr-box"></div>
    <div class="qr-timer" id="qr-timer"></div>
    <p class="muted" style="text-align:center;margin:8px 16px 0">Présentez ce code au valideur · solde ${fcfa(c?.balance)}</p>`;
  return `
    <div class="seg"><button data-t="card" class="${tab === "card" ? "on" : ""}">${"Carte"}</button><button data-t="phone" class="${tab === "phone" ? "on" : ""}">Téléphone</button></div>
    ${tab === "card" ? cardView : phoneView}
    ${titles.length ? `<div class="sec"><h3>Titres</h3></div><div class="panel">${titles.map((t) => `
      <div class="row-i"><span class="tile-ic">${ic("ticket")}</span><div class="grow"><div class="t">${esc(t.name)}</div>
      <div class="s">${t.kind === "monthly" ? "Illimité" : `${t.trips_remaining} trajets`} · jusqu’au ${ddmm(t.valid_until)}</div></div></div>`).join("")}</div>` : ""}
    <div class="bottom-btn"><button class="pill-btn primary" data-go="recharge" style="width:100%">${ic("plus", 20)}Recharger</button>
      ${!off ? `<button class="pill-btn danger" id="block" style="width:100%">${ic("ban", 20)}Carte perdue</button>` : ""}</div>`;
};
V.pass.after = ({ tab = "card" } = {}) => {
  document.querySelectorAll(".seg [data-t]").forEach((b) => (b.onclick = () => { S.route.args = { tab: b.dataset.t }; render(); }));
  if (tab === "phone") {
    const refresh = async () => {
      try {
        const r = await api("/api/me/pay-token", { token: S.token });
        const qr = qrcode(0, "M");
        qr.addData(r.token);
        qr.make();
        if ($("#qr-box")) $("#qr-box").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
        S.qrExp = new Date(r.expires_at);
      } catch (e) { if ($("#qr-box")) $("#qr-box").innerHTML = `<p style="color:#0a2530;text-align:center">${esc(e.message)}</p>`; }
    };
    refresh();
    S.viewTimer = setInterval(() => {
      const s = Math.max(0, Math.round((S.qrExp - Date.now()) / 1000));
      if ($("#qr-timer")) $("#qr-timer").textContent = `Code renouvelé dans ${s} s`;
      if (s <= 5) refresh();
    }, 1000);
  }
  const b = $("#block");
  if (b) b.onclick = () => modal(`<div class="success"><div class="check ko">${ic("ban", 40)}</div><strong>Bloquer la carte ?</strong><p>Refusée partout. Solde conservé.</p></div>
      <button class="pill-btn danger" id="blk-ok" style="width:100%">Bloquer</button><button class="pill-btn ghost" id="blk-no" style="width:100%">Annuler</button>`, () => {
    $("#blk-no").onclick = closeModal;
    $("#blk-ok").onclick = async () => { await api(`/api/me/cards/${card().uid}/block`, { method: "POST", token: S.token }); closeModal(); render(); };
  });
};

V.recharge = async ({ tab = "wallet" } = {}) => {
  S.products = await api("/api/products");
  const wallet = S.products.filter((p) => p.kind === "wallet");
  const ops = S.network.operators.filter((o) => S.products.some((p) => p.operator_id === o.id && p.kind !== "single"));
  const body = tab === "wallet" ? `
    <div class="pass-screen"><div class="lbl2">Solde actuel</div><div class="big" style="font-size:34px">${fcfa(card()?.balance)}</div></div>
    <div class="chips">${wallet.map((p, i) => `<button class="chip-amt ${i === 1 ? "on" : ""}" data-p="${p.id}">${num(p.price)}</button>`).join("")}</div>
    <p class="muted" style="text-align:center;font-size:13px;margin:12px 0 0">Bus, gbaka, bateau, woro-woro, taxi · même sans réseau</p>
    <div class="bottom-btn"><button class="pill-btn primary" id="w-go" style="width:100%">Continuer</button></div>`
    : ops.map((op) => `
      <div class="sec"><h3>${esc(op.name.replace(" (fictif)", ""))}</h3></div>
      <div class="panel">${S.products.filter((p) => p.operator_id === op.id && p.kind !== "single").map((p) => `
        <button class="row-i" data-buy="${p.id}"><span class="tile-ic">${ic("ticket")}</span><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${p.kind === "monthly" ? `Illimité · ${p.validity_days} j` : `${p.trips} trajets · ${p.validity_days} j`}</div></div><b>${fcfa(p.price)}</b></button>`).join("")}</div>`).join("");
  return `<div class="seg"><button data-t="wallet" class="${tab === "wallet" ? "on" : ""}">Porte-monnaie</button><button data-t="titles" class="${tab === "titles" ? "on" : ""}">Forfaits et carnets</button></div>${body}`;
};
V.recharge.after = () => {
  document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { S.route.args = { tab: b.dataset.t }; render(); }));
  let sel = document.querySelector(".chip-amt.on")?.dataset.p;
  document.querySelectorAll(".chip-amt").forEach((b) => (b.onclick = () => { sel = b.dataset.p; document.querySelectorAll(".chip-amt").forEach((x) => x.classList.toggle("on", x === b)); }));
  if ($("#w-go")) $("#w-go").onclick = () => openCheckout(sel);
  document.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = () => openCheckout(b.dataset.buy)));
};

// ---------- Vue : Budget ----------
V.budget = async () => {
  const b = await api("/api/me/budget", { token: S.token });
  S.budget = b;
  const month = new Date(b.month + "-15T12:00:00Z").toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: TZ });
  const pct = b.budget ? Math.min(100, (100 * b.spent) / b.budget) : 0;
  const projPct = b.budget ? Math.min(100, (100 * b.projected) / b.budget) : 0;
  const over = b.budget && b.projected > b.budget;
  const maxMode = Math.max(1, ...b.by_mode.map((m) => m.amount));
  return `
    <div class="budget-hero">
      <div class="of" style="text-transform:capitalize">${esc(month)}</div>
      <div class="spent">${fcfa(b.spent)}</div>
      <div class="of">${b.budget ? `sur un budget de ${fcfa(b.budget)}` : "Aucun budget défini"} · ${b.trips} trajets</div>
      ${b.budget ? `<div class="bar"><i class="${over ? "warn" : ""}" style="width:${pct}%"></i><span class="proj" style="left:${projPct}%" title="Projection fin de mois"></span></div>` : ""}
      <div class="row2"><span>Fin de mois estimée <b>${fcfa(b.projected)}</b></span><span>Mois dernier <b>${fcfa(b.last_month)}</b></span></div>
      ${over ? `<div class="badge warn" style="margin-top:12px">Dépassement prévu de ${fcfa(b.projected - b.budget)}</div>` : ""}
    </div>
    <div class="sec"><h3>30 derniers jours</h3><small>par jour</small></div>
    <div class="chart" id="chart"></div>
    ${b.by_mode.length ? `<div class="sec"><h3>Par mode de transport</h3><small>ce mois-ci</small></div>
    <div class="panel">${b.by_mode.map((m) => `<div class="row-i">${modeIc(m.mode, "var(--a-surface-2)", 18)}<div class="grow"><div class="spread" style="display:flex;justify-content:space-between"><span class="t">${MODES[m.mode]?.label || m.mode}</span><b>${fcfa(m.amount)}</b></div>
      <div class="hbar"><i style="width:${(100 * m.amount) / maxMode}%"></i></div><div class="s">${m.trips} trajets</div></div></div>`).join("")}</div>` : ""}
    ${b.advice.map((a) => `<div class="advice"><b>${esc(a.title)}</b><p>${esc(a.detail)}</p><span class="save">Économie ≈ ${fcfa(a.saving)} / mois</span></div>`).join("")}
    <div class="bottom-btn"><button class="pill-btn ghost" id="set-budget" style="width:100%">${ic("edit", 18)}${b.budget ? "Modifier mon budget" : "Définir mon budget"}</button></div>`;
};
V.budget.after = () => {
  const b = S.budget;
  drawDaily($("#chart"), b.daily, b.budget ? b.budget / b.days_in_month : 0);
  $("#set-budget").onclick = () => modal(`<div class="m-head"><strong>Budget mensuel</strong><button class="icon-btn" id="bg-x">${ic("x")}</button></div>
    <div class="phone-input" style="margin:14px 0"><input id="bg-v" inputmode="numeric" value="${b.budget || ""}" placeholder="15000"><span>FCFA</span></div>
    <button class="pill-btn primary" id="bg-ok" style="width:100%">Enregistrer</button>`, () => {
    $("#bg-x").onclick = closeModal;
    $("#bg-ok").onclick = async () => {
      try { await api("/api/me/budget", { method: "PUT", token: S.token, body: { amount: Number($("#bg-v").value.replace(/\D/g, "")) || 0 } }); closeModal(); render(); }
      catch (e) { toast(e.message, "error"); }
    };
  });
};

// Barres quotidiennes (une série, une teinte), budget journalier en pointillé, infobulle au survol.
function drawDaily(el, days, perDay) {
  const W = 340, H = 150, pad = { l: 4, r: 4, t: 10, b: 4 };
  const max = Math.max(perDay * 1.15, ...days.map((d) => d.amount), 1);
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const bars = days.map((d, i) => {
    const x = pad.l + i * bw + 1, w = Math.max(2, bw - 2), top = y(d.amount), h = H - pad.b - top;
    const r = Math.min(4, w / 2, h);
    const path = d.amount ? `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pad.b} Z` : "";
    return `<g data-i="${i}"><rect x="${pad.l + i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>${path ? `<path d="${path}" fill="#0fa673"/>` : ""}</g>`;
  }).join("");
  const ref = perDay ? `<line x1="0" x2="${W}" y1="${y(perDay)}" y2="${y(perDay)}" stroke="#8fadab" stroke-width="1" stroke-dasharray="3 4"/><text x="${W - 2}" y="${y(perDay) - 4}" text-anchor="end" fill="#8fadab" font-size="10">budget/jour</text>` : "";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Dépenses quotidiennes des 30 derniers jours"><line x1="0" x2="${W}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="rgba(255,255,255,.12)"/>${ref}${bars}</svg>
    <div class="axis"><span>${ddmm(days[0].date + "T12:00:00Z")}</span><span>aujourd’hui</span></div><div class="tip" id="tip"></div>`;
  const tip = el.querySelector("#tip"), svg = el.querySelector("svg");
  svg.querySelectorAll("g[data-i]").forEach((g) => {
    const show = () => {
      const d = days[+g.dataset.i];
      const rect = svg.getBoundingClientRect(), host = el.getBoundingClientRect();
      tip.innerHTML = `${new Date(d.date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: TZ })} · ${fcfa(d.amount)}${d.trips ? ` · ${d.trips} trajets` : ""}`;
      tip.style.left = `${rect.left - host.left + ((+g.dataset.i + 0.5) * bw / W) * rect.width}px`;
      tip.style.top = `${rect.top - host.top + 6}px`;
      tip.style.opacity = 1;
    };
    g.onmouseenter = show; g.ontouchstart = show;
    g.onmouseleave = () => (tip.style.opacity = 0);
  });
}

// ---------- Vue : Profil ----------
V.profile = async () => {
  await refreshMe();
  const me = S.me, t = me.traveler;
  const item = (icon, label, sub, to) => `<button class="row-i" data-go="${to}"><span class="tile-ic">${ic(icon)}</span><div class="grow"><div class="t">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div><span class="chev">${ic("chev", 20)}</span></button>`;
  return `
    <div class="profile-card"><div class="avatar">${esc(firstName()[0])}</div>
      <div><div class="name">${esc(t.name || "Voyageur")}</div><div class="phone-pill">${ic("phone", 15)}${esc(t.phone)}</div></div></div>
    <div class="panel" style="margin-top:12px">
      ${item("home", "Mes lieux", [t.home && "Maison", t.work && "Travail"].filter(Boolean).join(" · ") || "Maison, travail", "places")}
      ${item("clock", "Mes trajets", "Historique et réservations", "history")}
      ${item("card", "Mon Pass", card() ? `${fcfa(card().balance)} · ${card().status === "active" ? "active" : "bloquée"}` : "", "pass")}
    </div>
    <div class="bottom-btn"><button class="pill-btn primary" id="logout" style="width:100%">Déconnexion</button></div>`;
};
V.profile.after = () => ($("#logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST", token: S.token }).catch(() => {});
  sessionStore.del("metala.app.token");
  location.href = location.pathname;
});

V.places = async () => {
  const t = S.me.traveler;
  const row = (k, icon, label, p) => `<button class="row-i" data-k="${k}"><span class="tile-ic">${ic(icon)}</span><div class="grow"><div class="t">${label}</div><div class="s">${p ? esc(p.name) : "Non défini"}</div></div><span class="chev">${ic("edit", 18)}</span></button>`;
  return `<div class="panel">${row("home", "home", "Maison", t.home)}${row("work", "briefcase", "Travail", t.work)}</div>`;
};
V.places.after = () => document.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => pickPlace(b.dataset.k === "home" ? "Maison" : "Travail", async (p) => {
  const k = b.dataset.k;
  await api("/api/me/places", { method: "PUT", token: S.token, body: { [k]: { name: p.name, lat: p.lat, lon: p.lon } } });
  await refreshMe();
  S.trip = null;
  render();
})));

V.history = async () => {
  const [res, hist] = await Promise.all([api("/api/me/reservations", { token: S.token }), api("/api/me/history", { token: S.token })]);
  const upcoming = res.filter((r) => r.status === "confirmed" && new Date(r.departure.depart_at) > Date.now());
  const icon = (h) => h.kind === "purchase" ? "wallet" : h.status === "accepted" ? "check" : h.status === "already_validated" ? "refresh" : "x";
  return `${upcoming.length ? `<div class="sec"><h3>Réservations</h3></div><div class="panel">${upcoming.map((r) => {
      const l = lineById(r.departure.line_id);
      return `<div class="row-i">${chip(l)}<div class="grow"><div class="t">${ddmm(r.departure.depart_at)} · ${hhmm(r.departure.depart_at)}</div><div class="s">${esc(stopById(l.stop_ids[0]).name)}</div></div><button class="btn-s" style="flex:none" data-cancel="${r.id}">Annuler</button></div>`;
    }).join("")}</div>` : ""}
    <div class="sec"><h3>Historique</h3></div>
    ${hist.length ? `<div class="panel">${hist.slice(0, 60).map((h) => `<div class="row-i"><span class="tile-ic">${ic(icon(h), 18)}</span>
      <div class="grow"><div class="t">${esc(h.label)}</div><div class="s">${esc(h.kind === "purchase" ? (h.status === "succeeded" ? fcfa(h.amount) : h.status === "pending" ? "en attente" : "échoué") : h.detail)}</div></div>
      <small class="muted">${ddmm(h.at)} ${hhmm(h.at)}</small></div>`).join("")}</div>` : `<div class="empty">Aucun trajet</div>`}`;
};
V.history.after = () => document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
  await api(`/api/reservations/${b.dataset.cancel}`, { method: "DELETE", token: S.token });
  render(true);
}));

// ---------- Paiement Mobile Money et réservation ----------
const METHODS = [
  { id: "orange", label: "Orange Money", color: "#f97316", short: "OM" },
  { id: "mtn", label: "MTN MoMo", color: "#eab308", short: "MTN" },
  { id: "wave", label: "Wave", color: "#38bdf8", short: "W" },
  { id: "moov", label: "Moov Money", color: "#2563eb", short: "MV" },
];
function modal(html, after) { $("#modal-card").innerHTML = html; $("#modal").classList.remove("hidden"); bind($("#modal-card")); if (after) after(); }
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };

async function openCheckout(productId) {
  if (!S.products.length) S.products = await api("/api/products");
  const p = S.products.find((x) => x.id === productId);
  let method = METHODS[0].id;
  modal(`<div class="m-head"><strong>Paiement</strong><button class="icon-btn" id="pay-x">${ic("x")}</button></div>
    <div class="amount">${fcfa(p.price)}</div><div class="amount-l">${esc(p.kind === "wallet" ? "Porte-monnaie Metala" : p.name)}</div>
    <div class="methods">${METHODS.map((m, i) => `<button class="method ${i === 0 ? "on" : ""}" data-m="${m.id}"><span class="mi" style="background:${m.color}">${m.short}</span>${m.label}</button>`).join("")}</div>
    <button class="pill-btn primary" id="pay-go" style="width:100%">Payer</button>`, () => {
    document.querySelectorAll(".method").forEach((b) => (b.onclick = () => { method = b.dataset.m; document.querySelectorAll(".method").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#pay-x").onclick = closeModal;
    $("#pay-go").onclick = () => pay(p, method);
  });
}

async function pay(p, method) {
  const m = METHODS.find((x) => x.id === method) || METHODS[0];
  modal(`<div class="success"><div class="spinner"></div><strong>Validez sur votre téléphone</strong><p>${m.label} · ${fcfa(p.price)}</p></div>`);
  try {
    const payment = await api("/api/purchases", { method: "POST", token: S.token, body: { product_id: p.id } });
    await new Promise((r) => setTimeout(r, 900));
    const r = await api(`/api/dev/psp/${payment.id}/confirm?status=succeeded`, { method: "POST" });
    await refreshMe();
    const ok = r.status === "succeeded";
    modal(`<div class="success"><div class="check ${ok ? "" : "ko"}">${ic(ok ? "check" : "x", 42)}</div>
      <strong>${ok ? (p.kind === "wallet" ? `+ ${fcfa(p.price)}` : "Titre ajouté") : "Paiement refusé"}</strong>
      <p>${ok ? (p.kind === "wallet" ? `Solde : ${fcfa(card()?.balance)}` : esc(p.name)) : "Aucun débit"}</p></div>
      <button class="pill-btn primary" id="ok" style="width:100%">Terminé</button>`, () => ($("#ok").onclick = () => { closeModal(); go("pass", {}, true); }));
  } catch (e) { closeModal(); toast(e.message, "error"); }
}

async function openBooking(lineId) {
  const l = lineById(lineId);
  const deps = (await api(`/api/departures?line_id=${lineId}`)).slice(0, 5);
  modal(`<div class="m-head"><strong>${chip(l)} Réserver</strong><button class="icon-btn" id="bk-x">${ic("x")}</button></div>
    <p class="muted" style="margin:6px 0 0">Départ ${esc(stopById(l.stop_ids[0]).name)}</p>
    <div class="panel" style="margin:12px 0 0">${deps.map((d) => {
      const left = d.reservable_seats - d.reserved;
      return `<div class="row-i"><div class="grow"><div class="t" style="font-size:18px">${hhmm(d.depart_at)}</div><div class="s"><span class="badge ${left ? (left === 1 ? "warn" : "ok") : "ko"}">${left ? `${left} place${left > 1 ? "s" : ""}` : "Complet"}</span></div></div>
        <button class="btn-s ${left ? "primary" : ""}" style="flex:none" data-dep="${d.id}" ${left ? "" : "disabled"}>Réserver</button></div>`;
    }).join("")}</div>`, () => {
    $("#bk-x").onclick = closeModal;
    document.querySelectorAll("[data-dep]").forEach((b) => (b.onclick = async () => {
      try {
        await api("/api/reservations", { method: "POST", token: S.token, body: { departure_id: b.dataset.dep } });
        modal(`<div class="success"><div class="check">${ic("check", 42)}</div><strong>Place réservée</strong><p>Profil › Mes trajets</p></div><button class="pill-btn primary" id="ok" style="width:100%">OK</button>`, () => ($("#ok").onclick = closeModal));
      } catch (e) { toast(e.message, "error"); }
    }));
  });
}

async function boot() {
  S.network = await api("/api/network");
  S.products = await api("/api/products").catch(() => []);
  subscribeVehicles((st) => { S.vehicles = st; for (const l of S.layers) l.update(st); });
  if (S.token) { try { await enter(); return; } catch { sessionStore.del("metala.app.token"); S.token = null; } }
}
boot().catch((e) => toast(e.message, "error"));
