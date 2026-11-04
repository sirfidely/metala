import { api, fcfa, hhmm, ddmm, esc, toast, sessionStore, freshnessBadge, createMap, drawNetwork, fitLines, VehicleLayer } from "/shared/metala.js";

// Metala Gestion : back-office des compagnies de transport (administrateur)
// et de Metala (super administrateur).

const $ = (s) => document.querySelector(s);
const S = {
  token: sessionStore.get("metala.fleet.token"), pr: JSON.parse(sessionStore.get("metala.fleet.pr") || "null"),
  view: "dash", network: null, map: null, layer: null, seen: new Set(), firstFeed: true,
  newLine: null, driver: null,
};
const KIND = { public: "Entreprise publique", prive: "Compagnie privée", artisanal: "Transport artisanal", taxi: "Taxis compteurs" };
const MODE = { bus: "Bus", navette: "Navette", bateau: "Bateau-bus", gbaka: "Gbaka", woro: "Woro-woro", taxi: "Taxi compteur" };
const PKIND = { single: "Ticket", carnet: "Carnet", monthly: "Forfait" };

// ---------- Connexion et inscription ----------
document.querySelectorAll(".seg2 button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".seg2 button").forEach((x) => x.classList.toggle("on", x === b));
  $("#l-in").classList.toggle("hidden", b.dataset.l !== "in");
  $("#l-up").classList.toggle("hidden", b.dataset.l !== "up");
}));

async function boot() {
  S.network = await api("/api/network");
  try {
    const inv = await api("/api/dev/inventory");
    $("#demo-acc").innerHTML = `<div class="small muted">Comptes de test (mot de passe <span class="mono">${esc(inv.staff_password)}</span>)</div>` +
      inv.staff.map((u) => `<button data-u="${esc(u)}"><b>${esc(u)}</b> · ${u.startsWith("admin") ? "super administrateur Metala" : "administrateur de compagnie"}</button>`).join("");
    $("#demo-acc").querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => { $("#u").value = b.dataset.u; $("#pw").value = inv.staff_password; login(); }));
  } catch {}
  if (S.token && S.pr) {
    try { await api("/api/fleet/dashboard", { token: S.token }); return enter(); } catch { sessionStore.del("metala.fleet.token"); }
  }
}

function signedIn(r) {
  S.token = r.token; S.pr = r.principal;
  sessionStore.set("metala.fleet.token", r.token);
  sessionStore.set("metala.fleet.pr", JSON.stringify(r.principal));
  enter();
}
async function login() {
  try { signedIn(await api("/api/auth/staff", { method: "POST", body: { username: $("#u").value, password: $("#pw").value } })); }
  catch (e) { toast(e.message, "error"); }
}
$("#btn-login").onclick = login;
$("#pw").onkeydown = (e) => e.key === "Enter" && login();
$("#btn-register").onclick = async () => {
  try {
    const r = await api("/api/auth/register", { method: "POST", body: { name: $("#r-name").value, kind: $("#r-kind").value, admin_email: $("#r-mail").value, password: $("#r-pw").value } });
    S.network = await api("/api/network");
    toast("Compagnie inscrite : commencez par créer une ligne", "success");
    signedIn(r);
    setView("lines");
  } catch (e) { toast(e.message, "error"); }
};
$("#logout").onclick = () => { sessionStore.del("metala.fleet.token"); sessionStore.del("metala.fleet.pr"); location.reload(); };

// ---------- Aides ----------
const isAdmin = () => S.pr.role === "platform_admin";
const opName = (id) => S.network.operators.find((o) => o.id === id)?.name || "Toutes les compagnies";
const lineById = (id) => S.network.lines.find((l) => l.id === id);
const stopById = (id) => S.network.stops.find((s) => s.id === id);
const chip = (l) => l ? `<span class="line-chip" style="background:${l.color}">${esc(l.code)}</span>` : `<span class="kind">Taxi</span>`;
const scopeOp = () => isAdmin() ? $("#op-filter").value : S.pr.operator_id;
const q = () => { const v = $("#op-filter").value; return v ? `?operator_id=${v}` : ""; };
const kpi = (lbl, val, sub = "") => `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
const needOp = (what) => `<div class="card muted small">Choisissez une compagnie en haut à droite pour ${what}.</div>`;
async function reloadNetwork() { S.network = await api("/api/network"); }

async function enter() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").innerHTML = `<b>${isAdmin() ? "Super administrateur" : "Administrateur"}</b><br>${isAdmin() ? "Metala · toutes les compagnies" : esc(opName(S.pr.operator_id))}`;
  if (isAdmin()) {
    document.querySelectorAll(".admin-only").forEach((x) => x.classList.remove("hidden"));
    $("#op-filter").classList.remove("hidden");
    fillOpFilter();
    $("#op-filter").onchange = () => setView(S.view);
  }
  document.querySelectorAll("#nav button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));
  setView(S.view);
  setInterval(() => refresh(), 4000);
}
function fillOpFilter() {
  const cur = $("#op-filter").value;
  $("#op-filter").innerHTML = `<option value="">Toutes les compagnies</option>` + S.network.operators.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("");
  $("#op-filter").value = cur;
}

const TITLES = { dash: "Tableau de bord", lines: "Lignes", fares: "Tarifs", vehicles: "Véhicules", drivers: "Conducteurs", payments: "Paiements", recon: "Recettes", operators: "Compagnies", cards: "Cartes Metala Pass" };
function setView(v) {
  S.view = v;
  if (S.map) { S.map.remove(); S.map = null; S.layer = null; }
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  $("#view-title").textContent = TITLES[v];
  $("#view").innerHTML = "";
  VIEWS[v].build?.();
  refresh();
}

let busy = false;
async function refresh() {
  if (busy || !S.token) return;
  busy = true;
  try {
    await VIEWS[S.view].refresh?.();
    $("#updated").textContent = "à jour " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    if (e.status === 401) { sessionStore.del("metala.fleet.token"); location.reload(); }
  } finally { busy = false; }
}

const VIEWS = {};

// ---------- Tableau de bord ----------
VIEWS.dash = {
  build() {
    $("#view").innerHTML = `<div class="kpis" id="kpis"></div>
      <div class="grid2"><div class="card"><div class="toolbar"><h3 style="margin:0">Activité des conducteurs</h3><span class="badge ok">● en direct</span></div><div id="feed"></div></div>
      <div class="card" style="padding:8px"><div id="fleet-map"></div></div></div>`;
    S.firstFeed = true;
    const op = scopeOp();
    createMap("fleet-map", { zoom: 11.5, onStyle: (m, g) => drawNetwork(m, S.network, g, { operatorFilter: op }) }).then((m) => {
      if (!m) return;
      if (S.view !== "dash") { m.remove(); return; }
      S.map = m;
      S.layer = new VehicleLayer(m, S.network);
      const lines = S.network.lines.filter((l) => !op || l.operator_id === op);
      if (lines.length) fitLines(m, lines, 30);
    });
  },
  async refresh() {
    const [d, vals, vehicles, drivers] = await Promise.all([
      api("/api/fleet/dashboard" + q(), { token: S.token }),
      api("/api/fleet/validations" + (q() ? q() + "&" : "?") + "limit=10", { token: S.token }),
      api("/api/fleet/vehicles" + q(), { token: S.token }),
      api("/api/fleet/drivers" + q(), { token: S.token }),
    ]);
    S.layer?.update(vehicles);
    const onDuty = drivers.filter((x) => x.on_duty).length;
    $("#kpis").innerHTML = kpi("Recette du jour", fcfa(d.revenue_today), `${fcfa(d.commission_today)} de commission Metala`) +
      kpi("Paiements", d.validations_today, `${d.rejections_today} refusés`) +
      kpi("Conducteurs en service", `${onDuty} / ${drivers.length}`) +
      kpi("Véhicules localisés", `${d.vehicles_fresh} / ${d.vehicles_total}`) +
      kpi("Réservations à venir", d.reservations_open);
    $("#feed").innerHTML = vals.map((v) => {
      const isNew = !S.firstFeed && !S.seen.has(v.id);
      S.seen.add(v.id);
      const drv = drivers.find((x) => x.id === v.driver_id);
      const what = v.status === "accepted" ? `${fcfa(v.debited)} · ${v.source === "wallet" ? "porte-monnaie" : v.debited ? "titre" : "forfait"}` : esc(v.message.replace("Refusé — ", "Refus : "));
      return `<div class="feed-item" style="${isNew ? "animation:newrow 2s" : ""}"><span class="feed-ico ${v.status}">${v.status === "accepted" ? "✓" : v.status === "rejected" ? "✕" : "↺"}</span>${chip(lineById(v.line_id))}
        <span>${what}${v.channel === "phone" ? " · QR" : ""}${v.offline ? ` <span class="badge warn">hors ligne</span>` : ""}<br><span class="small muted">${drv ? esc(drv.name) + " · " : ""}${esc(drv?.plate || v.vehicle_id.replace("veh_", "véhicule "))}</span></span>
        <span class="when">${hhmm(v.at)}</span></div>`;
    }).join("") || `<p class="muted small">Aucun paiement aujourd’hui.</p>`;
    S.firstFeed = false;
  },
};

// ---------- Lignes ----------
VIEWS.lines = {
  build() {
    if (S.newLine) return buildLineForm();
    $("#view").innerHTML = `<div class="toolbar"><span class="muted small" id="lines-count"></span><button class="btn" id="add-line">+ Nouvelle ligne</button></div><div id="lines-list"></div>`;
    $("#add-line").onclick = () => {
      if (!scopeOp()) return toast("Choisissez d’abord une compagnie", "error");
      S.newLine = { stops: [], mode: "bus" };
      setView("lines");
    };
  },
  async refresh() {
    if (S.newLine) return;
    const op = scopeOp();
    const [vehicles, prods] = await Promise.all([api("/api/fleet/vehicles" + q(), { token: S.token }), api("/api/fleet/products" + q(), { token: S.token })]);
    const lines = S.network.lines.filter((l) => !op || l.operator_id === op);
    $("#lines-count").textContent = `${lines.length} ligne${lines.length > 1 ? "s" : ""}`;
    $("#lines-list").innerHTML = lines.map((l) => {
      const fare = prods.find((p) => p.operator_id === l.operator_id && p.kind === "single");
      const live = vehicles.filter((v) => v.line_id === l.id);
      return `<div class="card line-card" style="margin-bottom:10px">${chip(l)}<div class="grow"><b>${esc(l.name)}</b> <span class="kind">${MODE[l.mode]}</span>${isAdmin() ? ` <span class="small muted">${esc(opName(l.operator_id))}</span>` : ""}
        <div class="stops">${l.stop_ids.map((id) => esc(stopById(id)?.name || id)).join(" → ")}</div>
        <div class="facts"><span class="badge">toutes les ${l.headway_min} min</span><span class="badge">${l.first_dep}–${l.last_dep}</span><span class="badge">${Math.round(l.stop_minutes.at(-1))} min de bout en bout</span>
          ${fare ? `<span class="badge">${fcfa(fare.price)}</span>` : ""}<span class="badge">${live.length} véhicule${live.length > 1 ? "s" : ""}</span>${l.reservable ? `<span class="badge ok">réservable</span>` : ""}</div></div></div>`;
    }).join("") || `<div class="card muted">Aucune ligne. Créez la première ligne de votre compagnie.</div>`;
  },
};

function buildLineForm() {
  const nl = S.newLine;
  $("#view").innerHTML = `<div class="grid2">
    <div class="card">
      <h3>Nouvelle ligne · ${esc(opName(scopeOp()))}</h3>
      <div class="form-row"><div class="field" style="max-width:110px"><label for="nl-code">Code</label><input id="nl-code" maxlength="4" placeholder="E1"></div>
        <div class="field"><label for="nl-name">Nom</label><input id="nl-name" placeholder="Marcory ↔ Plateau"></div></div>
      <div class="form-row" style="margin-top:12px"><div class="field"><label for="nl-mode">Mode</label><select id="nl-mode">${Object.entries(MODE).filter(([k]) => k !== "taxi").map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
        <div class="field"><label for="nl-fare">Tarif du trajet (FCFA)</label><input id="nl-fare" type="number" min="50" step="50" value="300"></div></div>
      <div class="form-row" style="margin-top:12px"><div class="field"><label for="nl-head">Fréquence (min)</label><input id="nl-head" type="number" min="2" max="180" value="15"></div>
        <div class="field"><label for="nl-first">Premier départ</label><input id="nl-first" type="time" value="05:30"></div>
        <div class="field"><label for="nl-last">Dernier départ</label><input id="nl-last" type="time" value="21:00"></div></div>
      <label class="check"><input type="checkbox" id="nl-resa"> Places réservables par les voyageurs</label>
      <h3 style="margin-top:8px">Arrêts, dans l’ordre</h3>
      <ol class="picked" id="nl-stops"></ol>
      <div class="toolbar" style="margin-top:14px"><button class="btn secondary" id="nl-cancel">Annuler</button><button class="btn" id="nl-save">Publier la ligne</button></div>
    </div>
    <div class="card" style="padding:8px"><div id="line-map"></div>
      <p class="map-hint">Cliquez sur un arrêt existant pour l’ajouter. Cliquez ailleurs pour créer un nouvel arrêt.</p>
      <div id="new-stop" class="form-row hidden" style="margin-top:8px"><div class="field"><label for="ns-name">Nom du nouvel arrêt</label><input id="ns-name" placeholder="Marcory Zone 4"></div><button class="btn" id="ns-go">Créer l’arrêt</button></div>
    </div></div>`;
  $("#nl-mode").value = nl.mode;
  const drawPicked = () => {
    $("#nl-stops").innerHTML = nl.stops.map((id, i) => `<li><span>${esc(stopById(id)?.name || id)}</span><button data-up="${i}" aria-label="Monter">↑</button><button data-rm="${i}" aria-label="Retirer">✕</button></li>`).join("") || `<p class="muted small">Aucun arrêt choisi.</p>`;
    $("#nl-stops").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { nl.stops.splice(+b.dataset.rm, 1); drawPicked(); drawRoute(); }));
    $("#nl-stops").querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => { const i = +b.dataset.up; if (i) [nl.stops[i - 1], nl.stops[i]] = [nl.stops[i], nl.stops[i - 1]]; drawPicked(); drawRoute(); }));
  };
  const drawRoute = () => {
    const m = S.map;
    if (!m || !m.getSource("nl-route")) return;
    m.getSource("nl-route").setData({ type: "Feature", geometry: { type: "LineString", coordinates: nl.stops.map((id) => { const s = stopById(id); return [s.lon, s.lat]; }) } });
  };
  drawPicked();
  $("#nl-cancel").onclick = () => { S.newLine = null; setView("lines"); };
  $("#nl-save").onclick = async () => {
    try {
      const l = await api("/api/fleet/lines", { method: "POST", token: S.token, body: {
        operator_id: scopeOp(), code: $("#nl-code").value, name: $("#nl-name").value, mode: $("#nl-mode").value,
        fare: Number($("#nl-fare").value), headway_min: Number($("#nl-head").value), first_dep: $("#nl-first").value,
        last_dep: $("#nl-last").value, reservable: $("#nl-resa").checked, stop_ids: nl.stops } });
      await reloadNetwork();
      toast(`Ligne ${l.code} publiée : visible des voyageurs`, "success");
      S.newLine = null;
      setView("lines");
    } catch (e) { toast(e.message, "error"); }
  };
  let clicked = null;
  createMap("line-map", { zoom: 11.8, onStyle: (m, g) => {
    const fc = { type: "FeatureCollection", features: S.network.stops.map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) };
    for (const id of ["nl-route", "all-stops", "all-labels"]) if (m.getLayer(id)) m.removeLayer(id);
    for (const id of ["nl-route", "all-stops"]) if (m.getSource(id)) m.removeSource(id);
    m.addSource("nl-route", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } } });
    m.addLayer({ id: "nl-route", type: "line", source: "nl-route", paint: { "line-color": "#0e7c66", "line-width": 5 } });
    m.addSource("all-stops", { type: "geojson", data: fc });
    m.addLayer({ id: "all-stops", type: "circle", source: "all-stops", paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": "#0b5d4b", "circle-stroke-width": 3 } });
    if (g) m.addLayer({ id: "all-labels", type: "symbol", source: "all-stops", minzoom: 12, layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top" }, paint: { "text-color": "#063a2f", "text-halo-color": "#fff", "text-halo-width": 1.5 } });
    drawRoute();
  } }).then((m) => {
    if (!m) return;
    if (S.view !== "lines" || !S.newLine) { m.remove(); return; }
    S.map = m;
    m.on("click", (e) => {
      const f = m.queryRenderedFeatures(e.point, { layers: ["all-stops"] })[0];
      if (f) {
        const id = f.properties.id;
        if (!nl.stops.includes(id)) nl.stops.push(id);
        drawPicked(); drawRoute();
        return;
      }
      clicked = e.lngLat;
      $("#new-stop").classList.remove("hidden");
      $("#ns-name").focus();
    });
    m.on("mouseenter", "all-stops", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "all-stops", () => (m.getCanvas().style.cursor = ""));
  });
  $("#nl-mode").onchange = (e) => (nl.mode = e.target.value);
  $("#ns-go").onclick = async () => {
    if (!clicked) return;
    try {
      const st = await api("/api/fleet/stops", { method: "POST", token: S.token, body: { name: $("#ns-name").value, lat: clicked.lat, lon: clicked.lng } });
      await reloadNetwork();
      nl.stops.push(st.id);
      $("#ns-name").value = "";
      $("#new-stop").classList.add("hidden");
      S.map?.getSource("all-stops")?.setData({ type: "FeatureCollection", features: S.network.stops.map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })) });
      drawPicked(); drawRoute();
      toast(`Arrêt « ${st.name} » créé`, "success");
    } catch (e) { toast(e.message, "error"); }
  };
}

// ---------- Tarifs ----------
VIEWS.fares = {
  build() {
    if (!scopeOp()) { $("#view").innerHTML = needOp("gérer ses tarifs"); return; }
    $("#view").innerHTML = `<div class="card" style="margin-bottom:16px"><h3>Ajouter un tarif</h3><div class="form-row">
      <div class="field"><label for="np-name">Nom</label><input id="np-name" placeholder="Carnet 10 trajets"></div>
      <div class="field" style="max-width:150px"><label for="np-kind">Type</label><select id="np-kind"><option value="carnet">Carnet</option><option value="monthly">Forfait</option><option value="single">Ticket</option></select></div>
      <div class="field" style="max-width:110px"><label for="np-trips">Trajets</label><input id="np-trips" type="number" min="2" value="10"></div>
      <div class="field" style="max-width:120px"><label for="np-days">Validité (jours)</label><input id="np-days" type="number" min="1" value="30"></div>
      <div class="field" style="max-width:140px"><label for="np-price">Prix (FCFA)</label><input id="np-price" type="number" min="50" step="50"></div>
      <button class="btn" id="np-go">Ajouter</button></div></div><div id="fares-table"></div>`;
    $("#np-kind").onchange = (e) => { $("#np-trips").disabled = e.target.value !== "carnet"; };
    $("#np-go").onclick = async () => {
      try {
        await api("/api/fleet/products", { method: "POST", token: S.token, body: { operator_id: scopeOp(), name: $("#np-name").value, kind: $("#np-kind").value, trips: Number($("#np-trips").value), validity_days: Number($("#np-days").value), price: Number($("#np-price").value) } });
        toast("Tarif ajouté : proposé aux voyageurs dans Metala App", "success");
        $("#np-name").value = ""; $("#np-price").value = "";
        VIEWS.fares.refresh(true);
      } catch (e) { toast(e.message, "error"); }
    };
  },
  async refresh(force) {
    if (!scopeOp() || (!force && document.activeElement?.classList.contains("price-in"))) return;
    const prods = await api("/api/fleet/products" + q(), { token: S.token });
    if (!force && $("#fares-table").dataset.n === String(prods.map((p) => p.id + p.price).join())) return;
    $("#fares-table").dataset.n = prods.map((p) => p.id + p.price).join();
    $("#fares-table").innerHTML = `<div class="card scroll-x"><table class="table"><thead><tr><th>Tarif</th><th>Type</th><th>Trajets</th><th>Validité</th><th>Prix</th><th></th></tr></thead><tbody>
      ${prods.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td><span class="kind">${PKIND[p.kind]}</span></td><td>${p.kind === "monthly" ? "illimité" : p.trips}</td><td>${p.validity_days} j</td>
        <td><input class="price-in" type="number" step="50" value="${p.price}" data-p="${p.id}" aria-label="Prix de ${esc(p.name)}"></td><td><button class="btn small secondary" data-save="${p.id}">Enregistrer</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun tarif. Le tarif de base est créé avec la première ligne.</td></tr>`}
      </tbody></table><p class="small muted">Un changement de prix s’applique aux prochains achats ; les titres déjà vendus gardent leur prix.</p></div>`;
    $("#fares-table").querySelectorAll("[data-save]").forEach((b) => (b.onclick = async () => {
      try {
        await api(`/api/fleet/products/${b.dataset.save}`, { method: "PUT", token: S.token, body: { price: Number($(`[data-p="${b.dataset.save}"]`).value) } });
        toast("Prix mis à jour", "success");
        VIEWS.fares.refresh(true);
      } catch (e) { toast(e.message, "error"); }
    }));
  },
};

// ---------- Véhicules ----------
VIEWS.vehicles = {
  build() {
    const op = scopeOp();
    const lines = S.network.lines.filter((l) => l.operator_id === op);
    $("#view").innerHTML = (op ? `<div class="card" style="margin-bottom:16px"><h3>Enregistrer un véhicule</h3><div class="form-row">
      <div class="field"><label for="nv-plate">Immatriculation</label><input id="nv-plate" placeholder="4521 LG 01"></div>
      <div class="field"><label for="nv-line">Affectation</label><select id="nv-line">${lines.map((l) => `<option value="${l.id}">Ligne ${esc(l.code)} · ${esc(l.name)}</option>`).join("")}<option value="">Taxi compteur (sans ligne)</option></select></div>
      <div class="field" style="max-width:150px"><label for="nv-seats">Places réservables</label><input id="nv-seats" type="number" min="0" max="80" value="0"></div>
      <button class="btn" id="nv-go">Enregistrer</button></div><p class="small muted" style="margin:10px 0 0">Un valideur Metala Scan est créé pour le véhicule.</p></div>` : needOp("enregistrer un véhicule")) + `<div id="veh-table"></div>`;
    if (op) $("#nv-go").onclick = async () => {
      const line = $("#nv-line").value;
      try {
        const v = await api("/api/fleet/vehicles", { method: "POST", token: S.token, body: { operator_id: op, plate: $("#nv-plate").value, line_id: line, mode: line ? "" : "taxi", reservable_seats: Number($("#nv-seats").value) || 0 } });
        toast(`${v.plate} enregistré`, "success");
        $("#nv-plate").value = "";
        refresh();
      } catch (e) { toast(e.message, "error"); }
    };
  },
  async refresh() {
    const [vs, drivers] = await Promise.all([api("/api/fleet/vehicles" + q(), { token: S.token }), api("/api/fleet/drivers" + q(), { token: S.token })]);
    $("#veh-table").innerHTML = `<div class="card scroll-x"><table class="table"><thead><tr><th>Véhicule</th><th>Affectation</th><th>Conducteur</th><th>Position</th><th>Valideur</th><th></th></tr></thead><tbody>
      ${vs.map((v) => { const d = drivers.find((x) => x.on_duty && x.vehicle_id === v.vehicle_id); return `<tr>
        <td><b class="mono">${esc(v.plate)}</b>${isAdmin() ? `<div class="small muted">${esc(opName(v.operator_id))}</div>` : ""}</td>
        <td>${chip(lineById(v.line_id))}</td><td>${d ? esc(d.name) : `<span class="muted">—</span>`}</td>
        <td>${freshnessBadge(v.freshness, v.age_seconds)}</td>
        <td>${v.device_frozen ? `<span class="badge ko">bloqué</span>` : `<span class="badge ok">actif</span>`}</td>
        <td><button class="btn small ${v.device_frozen ? "secondary" : "danger"}" data-dev="${v.device_id}" data-frozen="${v.device_frozen}">${v.device_frozen ? "Débloquer" : "Bloquer"}</button></td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">Aucun véhicule.</td></tr>`}
      </tbody></table></div>`;
    $("#veh-table").querySelectorAll("[data-dev]").forEach((b) => (b.onclick = async () => {
      try { await api(`/api/fleet/devices/${b.dataset.dev}/freeze`, { method: "POST", token: S.token, body: { frozen: b.dataset.frozen !== "true" } }); refresh(); }
      catch (e) { toast(e.message, "error"); }
    }));
  },
};

// ---------- Conducteurs ----------
VIEWS.drivers = {
  build() {
    const op = scopeOp();
    $("#view").innerHTML = (op ? `<div class="card" style="margin-bottom:16px"><h3>Ajouter un conducteur</h3><div class="form-row">
      <div class="field"><label for="nd-name">Nom</label><input id="nd-name" placeholder="Prénom Nom"></div>
      <div class="field"><label for="nd-phone">Téléphone</label><input id="nd-phone" placeholder="07 00 00 00 00" inputmode="tel"></div>
      <div class="field" style="max-width:130px"><label for="nd-pin">Code PIN</label><input id="nd-pin" inputmode="numeric" maxlength="4" placeholder="4 chiffres"></div>
      <button class="btn" id="nd-go">Ajouter</button></div><p class="small muted" style="margin:10px 0 0">Le conducteur se connecte à Metala Scan avec son numéro et son code PIN.</p></div>` : "") +
      `<div id="drv-table"></div><div id="drv-detail" class="panel-detail"></div>`;
    if (op) $("#nd-go").onclick = async () => {
      try {
        const d = await api("/api/fleet/drivers", { method: "POST", token: S.token, body: { operator_id: op, name: $("#nd-name").value, phone: $("#nd-phone").value, pin: $("#nd-pin").value } });
        toast(`${d.name} ajouté`, "success");
        ["#nd-name", "#nd-phone", "#nd-pin"].forEach((s) => ($(s).value = ""));
        refresh();
      } catch (e) { toast(e.message, "error"); }
    };
  },
  async refresh() {
    const ds = await api("/api/fleet/drivers" + q(), { token: S.token });
    $("#drv-table").innerHTML = `<div class="card scroll-x"><table class="table"><thead><tr><th>Conducteur</th><th>Téléphone</th><th>Statut</th><th>Passagers</th><th>Recette du service</th></tr></thead><tbody>
      ${ds.map((d) => `<tr class="drv-row" data-d="${d.id}"><td><b>${esc(d.name)}</b>${isAdmin() ? `<div class="small muted">${esc(opName(d.operator_id))}</div>` : ""}</td><td class="mono">${esc(d.phone)}</td>
        <td>${d.on_duty ? `<span class="badge ok">en service</span> <span class="small">${esc(d.plate)} · ${hhmm(d.since)}</span>` : `<span class="badge">hors service</span>`}</td>
        <td>${d.on_duty ? d.passengers : "—"}</td><td>${d.on_duty ? fcfa(d.revenue) : "—"}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Aucun conducteur.</td></tr>`}
      </tbody></table><p class="small muted">Cliquez sur un conducteur pour voir son activité.</p></div>`;
    $("#drv-table").querySelectorAll("[data-d]").forEach((r) => (r.onclick = () => { S.driver = r.dataset.d; showDriver(); }));
    if (S.driver) showDriver();
  },
};

async function showDriver() {
  let a;
  try { a = await api(`/api/fleet/drivers/${S.driver}/activity`, { token: S.token }); } catch { return; }
  $("#drv-detail").innerHTML = `<div class="card"><div class="toolbar"><h3 style="margin:0">${esc(a.driver.name)}</h3><button class="btn ghost small" id="drv-x">Fermer</button></div>
    <div class="kpis">${kpi("Aujourd’hui", fcfa(a.today.revenue), `${a.today.passengers} passagers`)}${kpi("Ce mois-ci", fcfa(a.month.revenue), `${a.month.passengers} passagers`)}</div>
    <div class="scroll-x"><table class="table"><thead><tr><th>Service</th><th>Véhicule</th><th>Durée</th><th>Passagers</th><th>Refus</th><th>Recette</th></tr></thead><tbody>
    ${a.shifts.map((s) => { const end = s.shift.end ? new Date(s.shift.end) : new Date(); const m = Math.round((end - new Date(s.shift.start)) / 60000); return `<tr>
      <td>${ddmm(s.shift.start)} ${hhmm(s.shift.start)}${s.shift.end ? "" : ` <span class="badge ok">en cours</span>`}</td><td class="mono">${esc(s.vehicle.plate)} ${s.line_code ? chip(lineById(s.vehicle.line_id)) : ""}</td>
      <td>${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}</td><td>${s.passengers}</td><td>${s.refused}</td><td><b>${fcfa(s.revenue)}</b></td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">Aucun service.</td></tr>`}
    </tbody></table></div></div>`;
  $("#drv-x").onclick = () => { S.driver = null; $("#drv-detail").innerHTML = ""; };
}

// ---------- Paiements ----------
VIEWS.payments = {
  build() { $("#view").innerHTML = `<div id="pay-table"></div>`; },
  async refresh() {
    const [vals, drivers] = await Promise.all([api("/api/fleet/validations" + (q() ? q() + "&" : "?") + "limit=150", { token: S.token }), api("/api/fleet/drivers" + q(), { token: S.token })]);
    const st = { accepted: `<span class="badge ok">payé</span>`, already_validated: `<span class="badge warn">déjà payé</span>`, rejected: `<span class="badge ko">refusé</span>` };
    $("#pay-table").innerHTML = `<div class="card scroll-x"><table class="table"><thead><tr><th>Heure</th><th>Ligne</th><th>Conducteur</th><th>Moyen</th><th>Résultat</th><th>Montant</th></tr></thead><tbody>
      ${vals.map((v) => `<tr><td>${ddmm(v.at)} ${hhmm(v.at)}</td><td>${chip(lineById(v.line_id))}</td><td>${esc(drivers.find((d) => d.id === v.driver_id)?.name || "—")}</td>
        <td>${v.channel === "phone" ? "QR" : "Carte"} ${v.source === "wallet" ? "· porte-monnaie" : ""}${v.offline ? ` <span class="badge warn">hors ligne</span>` : ""}</td>
        <td>${st[v.status]}${v.status === "rejected" ? ` <span class="small muted">${esc(v.message.replace("Refusé — ", ""))}</span>` : ""}</td><td>${v.debited ? fcfa(v.debited) : "—"}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun paiement.</td></tr>`}
      </tbody></table><p class="small muted">Les voyageurs restent anonymes : seuls le moyen de paiement et le montant sont visibles.</p></div>`;
  },
};

// ---------- Recettes ----------
VIEWS.recon = {
  build() { $("#view").innerHTML = `<div id="recon"></div>`; },
  async refresh() {
    const r = await api("/api/fleet/reconciliation" + q(), { token: S.token });
    const chk = (ok, label) => `<div class="check-row"><span class="badge ${ok ? "ok" : "ko"}">${ok ? "✓" : "✕"}</span>${label}</div>`;
    $("#recon").innerHTML = `<div class="kpis">${kpi("Recette transporteur", fcfa(r.operator_revenue), "trajets effectués et forfaits")}${kpi("Commission Metala", fcfa(r.metala_commission))}${kpi("Encaissé par Mobile Money", fcfa(r.psp_succeeded_total), `${r.psp_succeeded_count} paiements`)}${kpi("Trajets prépayés", fcfa(r.liability_balance), "non encore consommés")}</div>
      <div class="card"><h3>Contrôles automatiques</h3>
        ${chk(r.psp_succeeded_count === r.ledger_sales_count && r.psp_succeeded_total === r.ledger_sales_total, "Argent encaissé = ventes enregistrées")}
        ${chk(r.psp_succeeded_count === r.titles_issued + r.wallet_loads, "Chaque paiement : un titre ou une recharge")}
        ${chk(r.debiting_validations === r.ledger_usage_count, "Chaque trajet débité une seule fois")}
        ${chk(r.liability_balance === r.titles_value_remaining, "Trajets prépayés = soldes des titres")}
        ${chk(r.ledger_sales_total === r.liability_balance + r.wallet_ledger + r.operator_revenue + r.metala_commission, "Comptabilité équilibrée")}
        <div style="margin-top:12px">${r.balanced ? `<span class="badge ok" style="font-size:14px;padding:6px 12px">Écart : 0 FCFA</span>` : `<span class="badge ko">${esc(r.discrepancies.join(" ; "))}</span>`}</div></div>`;
  },
};

// ---------- Super administrateur ----------
VIEWS.operators = {
  build() {
    $("#view").innerHTML = `<div class="card" style="margin-bottom:16px"><h3>Inscrire une compagnie</h3><div class="form-row">
      <div class="field"><label for="no-name">Nom</label><input id="no-name"></div>
      <div class="field" style="max-width:210px"><label for="no-kind">Catégorie</label><select id="no-kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
      <div class="field"><label for="no-mail">E-mail de l’administrateur</label><input id="no-mail"></div>
      <div class="field" style="max-width:170px"><label for="no-pw">Mot de passe</label><input id="no-pw" type="password"></div>
      <button class="btn" id="no-go">Inscrire</button></div></div><div id="ops-table"></div>`;
    $("#no-go").onclick = async () => {
      try {
        const o = await api("/api/admin/operators", { method: "POST", token: S.token, body: { name: $("#no-name").value, kind: $("#no-kind").value, admin_email: $("#no-mail").value, password: $("#no-pw").value } });
        toast(`${o.name} inscrite`, "success");
        await reloadNetwork(); fillOpFilter();
        ["#no-name", "#no-mail", "#no-pw"].forEach((s) => ($(s).value = ""));
        refresh();
      } catch (e) { toast(e.message, "error"); }
    };
  },
  async refresh() {
    const ops = await api("/api/admin/operators", { token: S.token });
    $("#ops-table").innerHTML = `<div class="card scroll-x"><table class="table"><thead><tr><th>Compagnie</th><th>Catégorie</th><th>Lignes</th><th>Véhicules</th><th>Conducteurs</th><th>Administrateur</th></tr></thead><tbody>
      ${ops.map((o) => `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${o.color};margin-right:6px"></span><b>${esc(o.name)}</b></td><td><span class="kind">${KIND[o.kind] || o.kind}</span></td><td>${o.lines}</td><td>${o.vehicles}</td><td>${o.drivers}</td><td class="mono small">${esc(o.admin || "—")}</td></tr>`).join("")}
      </tbody></table></div>`;
  },
};

VIEWS.cards = {
  build() { $("#view").innerHTML = `<div id="cards-table"></div>`; },
  async refresh() {
    const inv = await api("/api/dev/inventory");
    $("#cards-table").innerHTML = `<div class="card scroll-x"><table class="table"><thead><tr><th>Carte</th><th>Porteur</th><th>Solde</th><th>Statut</th><th></th></tr></thead><tbody>
      ${inv.cards.filter((c) => !c.holder.startsWith("Voyageur simulé")).map((c) => `<tr><td class="mono">${esc(c.uid)}</td><td>${esc(c.holder || c.phone)}</td><td>${fcfa(c.balance)}</td>
        <td>${c.status === "active" ? `<span class="badge ok">active</span>` : `<span class="badge ko">bloquée</span>`}</td>
        <td>${c.status === "active" ? `<button class="btn small danger" data-uid="${c.uid}">Bloquer</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`;
    $("#cards-table").querySelectorAll("[data-uid]").forEach((b) => (b.onclick = async () => {
      if (!confirm(`Bloquer la carte ${b.dataset.uid} sur tout le réseau ?`)) return;
      try { await api(`/api/admin/cards/${b.dataset.uid}/revoke`, { method: "POST", token: S.token }); refresh(); } catch (e) { toast(e.message, "error"); }
    }));
  },
};

boot().catch((e) => toast(e.message, "error"));
