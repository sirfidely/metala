import { api, fcfa, hhmm, ddmm, esc, toast, store, freshnessBadge, simBadge, createMap, drawNetwork, VehicleLayer, subscribeVehicles, FRESHNESS } from "/shared/metala.js";

const $ = (s) => document.querySelector(s);
const S = {
  token: store.get("metala.app.token"),
  me: null,
  network: null,
  vehicles: [],
  map: null,
  layer: null,
  sheet: null,          // { kind: "stop"|"vehicle"|"departures", id, lineId }
  alerts: new Map(),    // vehicleId -> { stopId, notified }
  pendingPayment: null,
};

// ---------- Connexion ----------
$("#fill-awa").onclick = (e) => { e.preventDefault(); $("#phone").value = "07 00 00 00 01"; };
$("#btn-otp").onclick = async () => {
  try {
    const r = await api("/api/auth/otp/request", { method: "POST", body: { phone: $("#phone").value } });
    $("#step-phone").classList.add("hidden");
    $("#step-code").classList.remove("hidden");
    if (r.dev_code) {
      $("#dev-otp").innerHTML = `Prototype : aucun SMS n’est envoyé. Votre code est <b>${esc(r.dev_code)}</b>`;
      $("#dev-otp").classList.remove("hidden");
      $("#code").value = r.dev_code;
    }
    $("#code").focus();
  } catch (e) { toast(e.message, "error"); }
};
$("#btn-back").onclick = () => { $("#step-code").classList.add("hidden"); $("#step-phone").classList.remove("hidden"); };
$("#btn-verify").onclick = async () => {
  try {
    const r = await api("/api/auth/otp/verify", { method: "POST", body: { phone: $("#phone").value, code: $("#code").value.trim(), name: $("#name").value.trim() } });
    S.token = r.token;
    store.set("metala.app.token", r.token);
    await enter();
  } catch (e) { toast(e.message, "error"); }
};

async function enter() {
  S.me = await api("/api/me", { token: S.token });
  $("#login").classList.add("hidden");
  $("#main").classList.remove("hidden");
  if (!S.map) await initMap();
  renderPass();
}

async function boot() {
  S.network = await api("/api/network");
  if (S.token) {
    try { await enter(); return; } catch { store.del("metala.app.token"); S.token = null; }
  }
}

// ---------- Onglets ----------
document.querySelectorAll(".tabbar button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== "tab-" + name));
  if (name === "map") S.map && S.map.resize();
  if (name === "titles") renderProducts();
  if (name === "pass") refreshMe().then(renderPass);
  if (name === "trips") renderTrips();
}

async function refreshMe() {
  try { S.me = await api("/api/me", { token: S.token }); }
  catch (e) { if (e.status === 401) logout(); }
}
function logout() { store.del("metala.app.token"); location.reload(); }

// ---------- Carte ----------
const stopById = (id) => S.network.stops.find((s) => s.id === id);
const lineById = (id) => S.network.lines.find((l) => l.id === id);
const opById = (id) => S.network.operators.find((o) => o.id === id);
const terminus = (line, dir) => stopById(dir >= 0 ? line.stop_ids.at(-1) : line.stop_ids[0])?.name || "";

async function initMap() {
  S.map = createMap("map");
  await new Promise((r) => S.map.on("load", r));
  drawNetwork(S.map, S.network, { onStopClick: (id) => openSheet({ kind: "stop", id }) });
  S.layer = new VehicleLayer(S.map, S.network, { onClick: (id) => openSheet({ kind: "vehicle", id }) });
  subscribeVehicles((states) => {
    S.vehicles = states;
    S.layer.update(states);
    if (S.sheet && S.sheet.kind === "vehicle") renderSheet();
  });
  setInterval(() => { if (S.sheet && S.sheet.kind === "stop") renderSheet(); checkAlerts(); }, 5000);
  fillSearch();
  openSheet(null);
}

function fillSearch() {
  const served = new Set(S.network.lines.flatMap((l) => l.stop_ids));
  const stops = S.network.stops.filter((s) => served.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const opts = (ph) => `<option value="">${ph}</option>` + stops.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  $("#from").innerHTML = opts("Départ : choisissez un arrêt");
  $("#to").innerHTML = opts("Où allez-vous ?");
  $("#from").value = "st_yop_siporex";
  $("#to").value = "st_plateau_cite";
  const go = () => { if ($("#from").value) openSheet({ kind: "stop", id: $("#from").value }); };
  $("#from").onchange = go;
  $("#to").onchange = go;
}

function openSheet(sheet) {
  S.sheet = sheet;
  $("#sheet").classList.toggle("collapsed", !sheet);
  if (sheet && sheet.kind === "stop") {
    const s = stopById(sheet.id);
    S.map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(S.map.getZoom(), 13), offset: [0, -120] });
  }
  renderSheet();
}
$(".grab").onclick = () => openSheet(S.sheet ? null : { kind: "stop", id: $("#from").value || "st_plateau_cite" });

async function renderSheet() {
  const body = $("#sheet-body");
  const sh = S.sheet;
  if (!sh) {
    body.innerHTML = `<div class="spread"><strong>Touchez un arrêt ou un bus</strong><span class="badge sim">GPS simulé</span></div>`;
    return;
  }
  if (sh.kind === "vehicle") return renderVehicle(body, sh.id);
  if (sh.kind === "departures") return renderDepartures(body, sh.lineId);
  const stop = stopById(sh.id);
  const to = $("#to").value;
  let arrivals = [];
  try { arrivals = await api(`/api/stops/${sh.id}/arrivals`); } catch (e) { body.innerHTML = `<p>${esc(e.message)}</p>`; return; }
  if (S.sheet !== sh) return;
  const lines = S.network.lines.filter((l) => l.stop_ids.includes(sh.id));
  // Recherche du trajet : ne garder que les lignes et sens qui mènent à la destination.
  let routeNote = "";
  if (to && to !== sh.id) {
    const ok = new Map();
    for (const l of lines) {
      const a = l.stop_ids.indexOf(sh.id), b = l.stop_ids.indexOf(to);
      if (b >= 0) ok.set(l.id, b > a ? 1 : -1);
    }
    arrivals = arrivals.filter((a) => ok.get(a.line_id) === a.direction);
    routeNote = ok.size
      ? `Vers <strong>${esc(stopById(to).name)}</strong> : ${[...ok.keys()].map((id) => chip(lineById(id))).join(" ")}`
      : `Aucune ligne directe vers <strong>${esc(stopById(to).name)}</strong> depuis cet arrêt.`;
  }
  body.innerHTML = `
    <div class="spread"><h3>${esc(stop.name)}</h3><div>${lines.map(chip).join(" ")}</div></div>
    ${routeNote ? `<p class="small" style="margin:6px 0 4px">${routeNote}</p>` : ""}
    <div>${arrivals.length ? arrivals.map((a) => arrivalRow(a, sh.id)).join("") :
      `<div class="empty">Aucun véhicule avec une position fiable en approche.<br>Nous n’affichons pas d’estimation sans GPS récent.</div>`}</div>
    <div class="note">ETA calculée depuis la dernière position reçue. <b>Places affichées = estimation</b> des places réservables connues, pas l’occupation réelle. Une place réservée n’est garantie que si l’opérateur s’y engage contractuellement.</div>`;
  body.querySelectorAll("[data-alert]").forEach((b) => (b.onclick = () => toggleAlert(b.dataset.alert, sh.id)));
  body.querySelectorAll("[data-book]").forEach((b) => (b.onclick = () => openSheet({ kind: "departures", lineId: b.dataset.book, back: sh })));
  body.querySelectorAll("[data-veh]").forEach((b) => (b.onclick = () => openSheet({ kind: "vehicle", id: b.dataset.veh })));
}

const chip = (l) => `<span class="line-chip" style="background:${l.color}">${esc(l.code)}</span>`;

function arrivalRow(a, stopId) {
  const l = lineById(a.line_id);
  const alerted = S.alerts.has(a.vehicle_id);
  const eta = a.eta_minutes <= 0 ? "À l’arrêt" : `${a.degraded ? "~" : ""}${a.eta_minutes} min`;
  return `<div class="arr">
    <div>${chip(l)}</div>
    <div style="min-width:0">
      <div><strong>vers ${esc(terminus(l, a.direction))}</strong></div>
      <div class="meta">${freshnessBadge(a.freshness, a.age_seconds)} ${simBadge(a.source)} <span class="badge">≈ ${a.reservable_seats} places réservables</span></div>
      <div class="arr-actions">
        <button class="btn small ${alerted ? "" : "secondary"}" data-alert="${a.vehicle_id}">🔔 ${alerted ? "Alerte activée" : "M’alerter à 3 min"}</button>
        <button class="btn small secondary" data-book="${a.line_id}">Réserver</button>
        <button class="btn small ghost" data-veh="${a.vehicle_id}">Fiche</button>
      </div>
    </div>
    <div class="eta"><b>${eta}</b><span class="small muted">${(a.distance_m / 1000).toFixed(1)} km${a.degraded ? " · estimation dégradée" : ""}</span></div>
  </div>`;
}

function renderVehicle(body, id) {
  const v = S.vehicles.find((x) => x.vehicle_id === id);
  if (!v) { body.innerHTML = `<p>Véhicule introuvable.</p>`; return; }
  const l = lineById(v.line_id);
  const op = opById(v.operator_id);
  const unknown = v.freshness === "unknown";
  body.innerHTML = `
    <div class="spread"><div class="row">${chip(l)}<h3>${esc(l.name)}</h3></div><button class="btn ghost small" id="close-veh">Fermer</button></div>
    <p class="small muted" style="margin:4px 0 10px">${esc(op.name)} · véhicule ${esc(v.vehicle_id)}</p>
    <div class="row" style="flex-wrap:wrap">${freshnessBadge(v.freshness, v.age_seconds)} ${simBadge(v.source)}</div>
    <table class="table" style="margin-top:10px">
      <tr><td class="muted">Sens</td><td>vers ${esc(terminus(l, v.direction))}</td></tr>
      <tr><td class="muted">Dernière position</td><td>${v.last_seen ? hhmm(v.last_seen) : "—"}</td></tr>
      <tr><td class="muted">Vitesse</td><td>${unknown ? "—" : Math.round(v.speed_kmh) + " km/h"}</td></tr>
      <tr><td class="muted">Places réservables (estimation)</td><td>${v.reservable_seats}</td></tr>
    </table>
    ${unknown ? `<div class="note">Position inconnue depuis plus de 120 s : le véhicule est grisé et aucune heure d’arrivée n’est calculée.</div>` :
      v.freshness === "delayed" ? `<div class="note">GPS retardé (30–120 s) : la position affichée peut être en retard sur la réalité.</div>` : ""}
    <div class="arr-actions" style="margin-top:12px"><button class="btn small secondary" id="veh-book">Réserver sur cette ligne</button></div>`;
  $("#close-veh").onclick = () => openSheet(null);
  $("#veh-book").onclick = () => openSheet({ kind: "departures", lineId: v.line_id });
}

async function renderDepartures(body, lineId) {
  const l = lineById(lineId);
  const deps = (await api(`/api/departures?line_id=${lineId}`)).slice(0, 6);
  body.innerHTML = `
    <div class="spread"><div class="row">${chip(l)}<h3>Réserver une place</h3></div><button class="btn ghost small" id="dep-back">Retour</button></div>
    <p class="small muted" style="margin:4px 0 8px">${esc(l.name)} · services éligibles à la réservation (P1)</p>
    ${deps.map((d) => {
      const left = d.reservable_seats - d.reserved;
      return `<div class="arr"><div><strong style="font-size:18px">${hhmm(d.depart_at)}</strong><div class="small muted">départ ${esc(stopById(l.stop_ids[0]).name)}</div></div>
        <div class="eta"><span class="badge ${left ? (left === 1 ? "warn" : "ok") : "ko"}">${left ? `${left} place${left > 1 ? "s" : ""} réservable${left > 1 ? "s" : ""}` : "Complet"}</span>
        <div style="margin-top:6px"><button class="btn small" data-dep="${d.id}" ${left ? "" : "disabled"}>Réserver</button></div></div></div>`;
    }).join("")}
    <div class="note">Place réservée = garantie uniquement si l’opérateur s’y engage contractuellement.</div>`;
  $("#dep-back").onclick = () => openSheet(S.sheet.back || { kind: "stop", id: $("#from").value || l.stop_ids[0] });
  body.querySelectorAll("[data-dep]").forEach((b) => (b.onclick = async () => {
    try {
      await api("/api/reservations", { method: "POST", token: S.token, body: { departure_id: b.dataset.dep } });
      toast("Place réservée ✔", "success");
      renderSheet();
    } catch (e) { toast(e.message, "error"); }
  }));
}

// ---------- Alertes de proximité ----------
function toggleAlert(vehicleId, stopId) {
  if (S.alerts.has(vehicleId)) S.alerts.delete(vehicleId);
  else {
    S.alerts.set(vehicleId, { stopId, notified: false });
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    toast("Nous vous préviendrons 3 min avant l’arrivée.");
  }
  renderSheet();
}

async function checkAlerts() {
  for (const [vid, al] of S.alerts) {
    try {
      const arr = await api(`/api/stops/${al.stopId}/arrivals`);
      const a = arr.find((x) => x.vehicle_id === vid);
      if (a && a.eta_minutes <= 3 && !al.notified) {
        al.notified = true;
        const msg = `${a.line_code} arrive à ${stopById(al.stopId).name} dans ${Math.max(a.eta_minutes, 0)} min`;
        toast("🔔 " + msg, "success");
        if ("Notification" in window && Notification.permission === "granted") new Notification("Metala", { body: msg });
        S.alerts.delete(vid);
      }
    } catch {}
  }
}

// ---------- Titres ----------
const kindDesc = (p) => p.kind === "monthly" ? `Illimité · ${p.validity_days} jours` :
  `${p.trips} trajet${p.trips > 1 ? "s" : ""} · valable ${p.validity_days === 1 ? "24 h" : p.validity_days + " jours"}`;

async function renderProducts() {
  const prods = await api("/api/products");
  $("#products").innerHTML = S.network.operators.map((op) => {
    const lines = S.network.lines.filter((l) => l.operator_id === op.id);
    return `<div class="op-group"><h4><span class="op-dot" style="background:${op.color}"></span>${esc(op.name)} ${lines.map(chip).join(" ")}</h4>
      ${prods.filter((p) => p.operator_id === op.id).map((p) => `
        <div class="card product"><div><strong>${esc(p.name)}</strong><div class="desc">${kindDesc(p)}</div></div>
        <div class="price">${fcfa(p.price)}</div><button class="btn small" data-buy="${p.id}">Acheter</button></div>`).join("")}
    </div>`;
  }).join("");
  $("#products").querySelectorAll("[data-buy]").forEach((b) => (b.onclick = () => buy(prods.find((p) => p.id === b.dataset.buy))));
}

async function buy(prod) {
  try {
    const pay = await api("/api/purchases", { method: "POST", token: S.token, body: { product_id: prod.id } });
    S.pendingPayment = pay;
    $("#pay-body").innerHTML = `<div class="muted small">${esc(opById(prod.operator_id).name)}</div>
      <div><strong>${esc(prod.name)}</strong> · ${kindDesc(prod)}</div>
      <div class="pay-amount">${fcfa(pay.amount)}</div>
      <div class="small muted">Référence PSP <span class="mono">${esc(pay.psp_ref)}</span> · statut <span class="badge warn">en attente</span></div>
      <div class="note">Le titre n’est émis qu’après confirmation signée du PSP (webhook). Le prototype ne débite aucun compte réel.</div>`;
    $("#pay-dup").checked = false;
    $("#pay-modal").classList.remove("hidden");
  } catch (e) { toast(e.message, "error"); }
}
async function settle(status) {
  const pay = S.pendingPayment;
  if (!pay) return;
  try {
    const dup = $("#pay-dup").checked ? "&duplicate=1" : "";
    const r = await api(`/api/dev/psp/${pay.id}/confirm?status=${status}${dup}`, { method: "POST" });
    $("#pay-modal").classList.add("hidden");
    if (r.status === "succeeded") {
      await refreshMe();
      const n = S.me.titles.filter((t) => t.payment_id === pay.id).length;
      toast(`Paiement confirmé · ${n} titre émis${dup ? " (webhook reçu 2 fois)" : ""}`, "success");
    } else toast("Paiement refusé par le PSP — aucun titre émis", "error");
  } catch (e) { toast(e.message, "error"); }
  S.pendingPayment = null;
}
$("#pay-ok").onclick = () => settle("succeeded");
$("#pay-fail").onclick = () => settle("failed");
$("#pay-cancel").onclick = () => { $("#pay-modal").classList.add("hidden"); S.pendingPayment = null; };

// ---------- Pass ----------
function renderPass() {
  const me = S.me;
  if (!me) return;
  const card = me.cards[0];
  const now = Date.now();
  const titles = me.titles.map((t) => {
    const expired = new Date(t.valid_until).getTime() < now;
    const used = t.kind !== "monthly" && t.trips_remaining === 0;
    const op = opById(t.operator_id);
    const state = expired ? `<span class="badge ko">Expiré</span>` : used ? `<span class="badge unknown">Épuisé</span>` : `<span class="badge ok">Actif</span>`;
    const detail = t.kind === "monthly" ? `Illimité jusqu’au ${ddmm(t.valid_until)}` : `<strong>${t.trips_remaining}</strong> / ${t.trips_total} trajets · jusqu’au ${ddmm(t.valid_until)}`;
    const pct = t.kind === "monthly" ? 100 : (100 * t.trips_remaining) / t.trips_total;
    return `<div class="card title-item" style="${expired || used ? "opacity:.6" : ""}">
      <div class="spread"><strong>${esc(t.name)}</strong>${state}</div>
      <div class="small muted" style="margin-top:2px"><span class="op-dot" style="display:inline-block;background:${op.color}"></span> ${esc(op.name)}</div>
      <div class="small" style="margin-top:6px">${detail}</div>
      <div class="progress"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  $("#pass").innerHTML = `
    <div class="pass-card"><div class="brand">METALA PASS</div><div class="nfc">))))</div>
      <div class="uid">${card ? esc(card.uid.match(/.{1,2}/g).join(" ")) : "—"}</div>
      <div class="holder">${esc(me.traveler.name || me.traveler.phone)} ${card && card.status !== "active" ? " · <b>RÉVOQUÉE</b>" : ""}</div></div>
    <p class="small muted" style="margin:0 16px 14px">Carte NFC passive : utilisable sans smartphone, sans Internet et sans batterie. Présentez-la au valideur Metala Scan à la montée.
      <a href="/scan/">Ouvrir le simulateur de valideur →</a></p>
    <div class="section-label">Mes titres</div>
    ${titles || `<div class="empty">Aucun titre. Achetez-en un dans l’onglet Titres.</div>`}
    <div style="margin:18px 16px"><button class="btn ghost" id="logout">Se déconnecter</button></div>`;
  $("#logout").onclick = logout;
}

// ---------- Trajets ----------
async function renderTrips() {
  const [res, hist] = await Promise.all([api("/api/me/reservations", { token: S.token }), api("/api/me/history", { token: S.token })]);
  const upcoming = res.filter((r) => r.status === "confirmed" && new Date(r.departure.depart_at) > Date.now());
  $("#reservations").innerHTML = `<div class="section-label">Réservations à venir</div>` + (upcoming.length ? upcoming.map((r) => {
    const l = lineById(r.departure.line_id);
    return `<div class="card hist" style="margin-bottom:8px"><div class="hist-item"><div>${chip(l)}</div>
      <div><strong>${hhmm(r.departure.depart_at)}</strong> · départ ${esc(stopById(l.stop_ids[0]).name)}<div class="small muted">${esc(l.name)}</div></div>
      <button class="btn small danger" style="margin-left:auto" data-cancel="${r.id}">Annuler</button></div></div>`;
  }).join("") : `<div class="empty">Aucune réservation.</div>`);
  $("#reservations").querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
    await api(`/api/reservations/${b.dataset.cancel}`, { method: "DELETE", token: S.token });
    toast("Réservation annulée");
    renderTrips();
  }));
  const icon = (h) => h.kind === "purchase" ? "🎟️" : h.status === "accepted" ? "✅" : h.status === "already_validated" ? "↺" : "⛔";
  $("#history").innerHTML = `<div class="section-label">Historique</div>` + (hist.length ? `<div class="card hist">${hist.map((h) => `
    <div class="hist-item"><div class="hist-ico">${icon(h)}</div>
      <div><strong>${esc(h.label)}</strong><div class="small muted">${esc(h.detail)}${h.amount ? " · " + fcfa(h.amount) : ""}${h.kind === "purchase" && h.status !== "succeeded" ? ` · ${h.status === "pending" ? "en attente" : "échoué"}` : ""}</div></div>
      <div class="when">${ddmm(h.at)} ${hhmm(h.at)}</div></div>`).join("")}</div>` : `<div class="empty">Aucun trajet pour l’instant.</div>`);
}

boot().catch((e) => toast(e.message, "error"));
