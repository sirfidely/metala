import {
  api, fcfa, hhmm, ddmm, esc, toast, store, sessionStore, params, embedded, freshnessBadge,
  createMap, drawNetwork, onStopClick, fitLines, VehicleLayer, subscribeVehicles, along, until,
} from "/shared/metala.js";
import { ic } from "/shared/icons.js";

const $ = (s) => document.querySelector(s);
const AWA_PHONE = "07 00 00 00 01";
const DEFAULT_STOP = "st_yop_siporex";
const SPEED_KMH = 18;

const S = {
  token: sessionStore.get("metala.app.token"),
  me: null, network: null, products: [], vehicles: [],
  stack: [], route: null, map: null, layer: null, sheet: null,
  alerts: new Map(),
  favs: JSON.parse(store.get("metala.app.favs") || '{"lines":["ln_m2"],"stops":["st_yop_siporex"]}'),
  settings: JSON.parse(store.get("metala.app.settings") || '{"notif":true,"bio":true}'),
};
if (embedded) { document.body.classList.add("embed"); $("#banner").classList.add("hidden"); }

// Icônes de la barre d'onglets
const TABS = { home: "home", lines: "grid", pass: "scan", map: "map", profile: "user" };
document.querySelectorAll(".tabbar button").forEach((b) => { b.innerHTML = ic(TABS[b.dataset.tab], b.dataset.tab === "pass" ? 28 : 24); });
$("#nav-back").innerHTML = ic("back");

// ---------- Aides ----------
const stopById = (id) => S.network.stops.find((s) => s.id === id);
const lineById = (id) => S.network.lines.find((l) => l.id === id);
const chip = (l) => `<span class="line-chip" style="background:${l.color}">${esc(l.code)}</span>`;
const terminus = (l, dir) => stopById(dir >= 0 ? l.stop_ids.at(-1) : l.stop_ids[0])?.name || "";
const linesAt = (stopId) => S.network.lines.filter((l) => l.stop_ids.includes(stopId));
const firstName = () => (S.me?.traveler.name || "").split(/[\s(]/)[0] || "Voyageur";
const card = () => S.me?.cards[0];
const etaHtml = (a) => a.eta_minutes <= 0 ? `<div class="eta now"><b>À l’arrêt</b></div>`
  : `<div class="eta"><b>${a.degraded ? "~" : ""}${a.eta_minutes}</b><small>min</small></div>`;
const isFav = (k, id) => S.favs[k].includes(id);
const star = (k, id) => `<button class="star ${isFav(k, id) ? "on" : ""}" data-fav="${k}:${id}" aria-label="Favori">${ic("star", 22)}</button>`;
const A = (o) => esc(JSON.stringify(o));
const kindDesc = (p) => p.kind === "monthly" ? `Illimité · ${p.validity_days} j` : `${p.trips} trajet${p.trips > 1 ? "s" : ""} · ${p.validity_days === 1 ? "24 h" : p.validity_days + " j"}`;
const num = (n) => new Intl.NumberFormat("fr-FR").format(n || 0);
function activeTitles() {
  const now = Date.now();
  return (S.me?.titles || []).filter((t) => new Date(t.valid_until) > now && (t.kind === "monthly" || t.trips_remaining > 0));
}

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
    if (params.get("demo") === "awa") { await loginAsAwa(); return; }
    location.reload();
  }
}
async function enter() {
  S.me = await api("/api/me", { token: S.token });
  $("#login").classList.add("hidden");
  $("#main").classList.remove("hidden");
  go("home", {}, true);
}

// ---------- Navigation ----------
const TITLES = { lines: "Réseau", pass: "Mon Pass", recharge: "Recharger", search: "Itinéraire", map: "Carte", account: "Mon compte", settings: "Paramètres", trips: "Mes trajets", help: "Centre d’aide" };
const TAB_OF = { home: "home", search: "home", lines: "lines", line: "lines", stop: "lines", pass: "pass", recharge: "pass", map: "map", profile: "profile", account: "profile", settings: "profile", trips: "profile", help: "profile" };

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
  $("#appbar").classList.toggle("hidden-bar", name === "home" || name === "profile");
  $("#title").textContent = args.title ?? TITLES[name] ?? "";
  $("#nav-back").style.visibility = S.stack.length ? "visible" : "hidden";
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === TAB_OF[name]));
  const isMap = name === "map";
  $("#view").classList.toggle("hidden", isMap);
  $("#mapview").classList.toggle("hidden", !isMap);
  if (isMap) return showMap(args);
  const html = await V[name](args);
  if (my !== seq) return;
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
    const [k, id] = el.dataset.fav.split(":");
    S.favs[k] = isFav(k, id) ? S.favs[k].filter((x) => x !== id) : [...S.favs[k], id];
    store.set("metala.app.favs", JSON.stringify(S.favs));
    el.classList.toggle("on", isFav(k, id));
  }));
  root.querySelectorAll("[data-book]").forEach((el) => (el.onclick = () => openBooking(el.dataset.book)));
  root.querySelectorAll("[data-follow]").forEach((el) => (el.onclick = () => { const [v, s] = el.dataset.follow.split("|"); follow(v, s); }));
}

// ---------- Vues ----------
const V = {};

function passCards() {
  const c = card();
  const t = activeTitles()[0];
  const titleChip = !t ? "" : t.kind === "monthly" ? `Forfait · ${ddmm(t.valid_until)}` : `${t.trips_remaining} trajets`;
  const off = c?.status === "revoked" ? "revoked" : "";
  return `
    <div class="carousel" id="carousel">
      <div class="pcard front ${off}" id="pass-card">
        <div class="brand">METALA PASS</div><div class="nfc">${ic("nfc", 26)}</div>
        <div class="bal-l">Porte-monnaie</div>
        <div class="bal">${num(c?.balance)} <small>FCFA</small></div>
        <div class="foot"><span>${off ? "Carte bloquée" : esc(firstName())}</span>${titleChip ? `<span class="chip-t">${titleChip}</span>` : ""}</div>
      </div>
      <div class="pcard back ${off}">
        <div class="stripe"></div>
        <div class="back-body">
          <div class="uid">${c ? esc(c.uid.match(/.{1,2}/g).join(" ")) : "—"}</div>
          <div class="kv"><span>Titulaire<b>${esc(S.me.traveler.name || "—")}</b></span><span style="text-align:right">Émise le<b>${c ? ddmm(c.issued_at) : "—"}</b></span></div>
          <div class="kv"><span>Sans réseau<b>Oui</b></span><span style="text-align:right">Statut<b>${c?.status === "active" ? "Active" : "Bloquée"}</b></span></div>
        </div>
      </div>
    </div>
    <div class="dots" id="dots"><i class="on"></i><i></i></div>`;
}
function bindCarousel() {
  const c = $("#carousel");
  if (!c) return;
  c.onscroll = () => {
    const i = Math.round(c.scrollLeft / c.clientWidth);
    document.querySelectorAll("#dots i").forEach((d, k) => d.classList.toggle("on", k === i));
  };
}

V.home = async () => {
  const home = S.favs.stops[0] || DEFAULT_STOP;
  const arr = (await api(`/api/stops/${home}/arrivals`).catch(() => [])).slice(0, 3);
  return `
    <div class="hello"><div class="avatar">${esc(firstName()[0])}</div>
      <div class="who"><small>Bonjour</small><div>${esc(firstName())}</div></div>
      <button class="icon-btn soft" data-go="search" aria-label="Rechercher">${ic("search")}</button></div>
    ${passCards()}
    <div class="quick">
      <button data-go="recharge"><span class="q">${ic("plus", 26)}</span>Recharger</button>
      <button data-go="search"><span class="q">${ic("route", 24)}</span>Itinéraire</button>
      <button data-go="lines" data-root="1"><span class="q">${ic("bus", 24)}</span>Lignes</button>
      <button data-go="trips"><span class="q">${ic("clock", 24)}</span>Trajets</button>
    </div>
    <div class="sec"><h3>Prochains passages</h3><a href="#" data-go="stop" data-a="${A({ id: home, title: stopById(home).name })}">${esc(stopById(home).name)}</a></div>
    <div class="panel" id="home-arr">${arrivalRows(arr, home, false)}</div>`;
};
V.home.after = bindCarousel;

function arrivalRows(arr, stopId, actions = true) {
  if (!arr.length) return `<div class="empty">Aucun bus localisé en approche</div>`;
  return arr.map((a) => {
    const l = lineById(a.line_id);
    const on = S.alerts.has(a.vehicle_id);
    return `<div class="row-i">${chip(l)}
      <div class="grow"><div class="t">${esc(terminus(l, a.direction))}</div><div class="s">${freshnessBadge(a.freshness, a.age_seconds)}</div>
        ${actions ? `<div class="actions" style="margin-top:10px"><button class="btn-s ${on ? "on" : ""}" data-follow="${a.vehicle_id}|${stopId}">${ic("bell", 16)}${on ? "Activée" : "M’alerter"}</button><button class="btn-s" data-book="${a.line_id}">Réserver</button></div>` : ""}
      </div>${etaHtml(a)}</div>`;
  }).join("");
}

V.pass = async () => {
  await refreshMe();
  const c = card();
  const titles = activeTitles();
  return `
    ${passCards()}
    <div class="tap-anim">${ic("nfc", 54)}</div>
    <p class="muted" style="text-align:center;margin:0 0 6px">Posez la carte sur le valideur</p>
    ${titles.length ? `<div class="sec"><h3>Titres</h3></div><div class="panel">${titles.map((t) => `
      <div class="row-i"><span class="tile-ic">${ic("ticket")}</span><div class="grow"><div class="t">${esc(t.name)}</div>
      <div class="s">${t.kind === "monthly" ? "Illimité" : `${t.trips_remaining} / ${t.trips_total}`} · ${ddmm(t.valid_until)}</div></div></div>`).join("")}</div>` : ""}
    <div class="bottom-btn"><button class="pill-btn primary" data-go="recharge" style="width:100%">${ic("plus", 20)}Recharger</button>
    ${c?.status === "active" ? `<button class="pill-btn danger" id="block" style="width:100%">${ic("ban", 20)}Carte perdue</button>` : ""}</div>`;
};
V.pass.after = () => {
  bindCarousel();
  const b = $("#block");
  if (b) b.onclick = () => modal(`<div class="success"><div class="check ko">${ic("ban", 40)}</div><strong>Bloquer la carte ?</strong><p>Refusée dans tous les bus. Solde conservé.</p></div>
      <button class="pill-btn danger" id="blk-ok" style="width:100%">Bloquer</button><button class="pill-btn ghost" id="blk-no" style="width:100%">Annuler</button>`, () => {
    $("#blk-no").onclick = closeModal;
    $("#blk-ok").onclick = async () => { await api(`/api/me/cards/${card().uid}/block`, { method: "POST", token: S.token }); closeModal(); toast("Carte bloquée"); render(); };
  });
};

V.recharge = async ({ tab = "wallet" } = {}) => {
  S.products = await api("/api/products");
  const wallet = S.products.filter((p) => p.kind === "wallet");
  const body = tab === "wallet" ? `
    <div class="pass-screen"><div class="lbl2">Solde actuel</div><div class="big" style="font-size:34px">${fcfa(card()?.balance)}</div></div>
    <div class="chips">${wallet.map((p, i) => `<button class="chip-amt ${i === 1 ? "on" : ""}" data-p="${p.id}">${num(p.price)}</button>`).join("")}</div>
    <p class="muted" style="text-align:center;font-size:13px;margin:12px 0 0">Tous les bus · même sans réseau</p>
    <div class="bottom-btn"><button class="pill-btn primary" id="w-go" style="width:100%">Continuer</button></div>`
    : S.network.operators.map((op) => `
      <div class="sec"><h3>${esc(op.name.replace(" (fictif)", ""))}</h3><small>${S.network.lines.filter((l) => l.operator_id === op.id).map(chip).join(" ")}</small></div>
      <div class="panel">${S.products.filter((p) => p.operator_id === op.id).map((p) => `
        <button class="row-i prod" data-buy="${p.id}"><span class="tile-ic">${ic("ticket")}</span><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${kindDesc(p)}</div></div><span class="price">${fcfa(p.price)}</span></button>`).join("")}</div>`).join("");
  return `<div class="seg"><button data-t="wallet" class="${tab === "wallet" ? "on" : ""}">Porte-monnaie</button><button data-t="titles" class="${tab === "titles" ? "on" : ""}">Titres</button></div>${body}`;
};
V.recharge.after = () => {
  document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { S.route.args = { tab: b.dataset.t }; render(); }));
  let sel = document.querySelector(".chip-amt.on")?.dataset.p;
  document.querySelectorAll(".chip-amt").forEach((b) => (b.onclick = () => { sel = b.dataset.p; document.querySelectorAll(".chip-amt").forEach((x) => x.classList.toggle("on", x === b)); }));
  if ($("#w-go")) $("#w-go").onclick = () => openCheckout(sel);
  document.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = () => openCheckout(b.dataset.buy)));
};

V.search = async ({ from = DEFAULT_STOP, to = "st_plateau_cite" } = {}) => {
  const served = new Set(S.network.lines.flatMap((l) => l.stop_ids));
  const stops = S.network.stops.filter((s) => served.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const opt = (sel) => stops.map((s) => `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  return `
    <div class="od">
      <div class="od-row"><span class="pin from"></span><select id="od-from" aria-label="Départ">${opt(from)}</select></div>
      <div class="od-row"><span class="pin to"></span><select id="od-to" aria-label="Destination">${opt(to)}</select></div>
      <button class="swap" id="od-swap" aria-label="Inverser">${ic("swap", 18)}</button>
    </div>
    ${await routeResults(from, to)}`;
};
V.search.after = () => {
  const upd = (f, t) => { S.route.args = { from: f, to: t }; render(); };
  $("#od-from").onchange = () => upd($("#od-from").value, $("#od-to").value);
  $("#od-to").onchange = () => upd($("#od-from").value, $("#od-to").value);
  $("#od-swap").onclick = () => upd($("#od-to").value, $("#od-from").value);
};

async function routeResults(from, to) {
  if (from === to) return `<div class="empty">Choisissez une autre destination</div>`;
  const arrivals = await api(`/api/stops/${from}/arrivals`).catch(() => []);
  const out = [];
  for (const l of S.network.lines) {
    const a = l.stop_ids.indexOf(from), b = l.stop_ids.indexOf(to);
    if (a < 0 || b < 0) continue;
    const dir = b > a ? 1 : -1;
    const sF = stopById(from), sT = stopById(to);
    const travel = Math.max(2, Math.round(Math.abs(along(l, [sT.lat, sT.lon]) - along(l, [sF.lat, sF.lon])) / (SPEED_KMH / 3.6) / 60));
    const next = arrivals.find((x) => x.line_id === l.id && x.direction === dir);
    const fare = S.products.filter((p) => p.operator_id === l.operator_id && p.kind === "single").sort((x, y) => x.price - y.price)[0];
    const arrive = next ? new Date(Date.now() + (next.eta_minutes + travel) * 60000) : null;
    out.push(`<div class="route">
      <div class="route-head">${chip(l)}<div class="grow">${esc(terminus(l, dir))}</div>${next ? etaHtml(next) : `<div class="eta"><small>aucun bus<br>localisé</small></div>`}</div>
      <div class="route-steps"><div>${esc(sF.name)}</div><div class="muted">${Math.abs(b - a)} arrêts · ${travel} min</div><div>${esc(sT.name)}${arrive ? ` · <b>${hhmm(arrive)}</b>` : ""}</div></div>
      <div class="route-meta">${next ? freshnessBadge(next.freshness, next.age_seconds) : ""}${fare ? `<span class="badge">${fcfa(fare.price)}</span>` : ""}</div>
      <div class="actions">${next ? `<button class="btn-s primary" data-follow="${next.vehicle_id}|${from}">${ic("pin", 16)}Suivre</button>` : ""}<button class="btn-s" data-book="${l.id}">Réserver</button></div>
    </div>`);
  }
  return out.join("") || `<div class="empty">Pas de ligne directe</div>`;
}

V.lines = async ({ tab = "lines" } = {}) => {
  const counts = {};
  for (const v of S.vehicles) if (v.freshness !== "unknown") counts[v.line_id] = (counts[v.line_id] || 0) + 1;
  const served = new Set(S.network.lines.flatMap((l) => l.stop_ids));
  const stops = S.network.stops.filter((s) => served.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const lineRow = (l) => `<button class="row-i" data-go="line" data-a="${A({ id: l.id, title: "Ligne " + l.code })}">${chip(l)}<div class="grow"><div class="t">${esc(l.name)}</div><div class="s">${counts[l.id] || 0} bus en service</div></div>${star("lines", l.id)}</button>`;
  const stopRow = (s) => `<button class="row-i" data-go="stop" data-a="${A({ id: s.id, title: s.name })}"><span class="tile-ic">${ic("pin")}</span><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${linesAt(s.id).map(chip).join("")}</div></div>${star("stops", s.id)}</button>`;
  let body;
  if (tab === "lines") body = `<div class="panel">${S.network.lines.map(lineRow).join("")}</div>`;
  else if (tab === "stops") body = `<div class="panel">${stops.map(stopRow).join("")}</div>`;
  else {
    const fl = S.favs.lines.map(lineById).filter(Boolean), fs = S.favs.stops.map(stopById).filter(Boolean);
    body = fl.length || fs.length ? `${fl.length ? `<div class="panel">${fl.map(lineRow).join("")}</div>` : ""}${fs.length ? `<div class="panel" style="margin-top:12px">${fs.map(stopRow).join("")}</div>` : ""}` : `<div class="empty">Aucun favori</div>`;
  }
  return `<div class="seg"><button data-t="lines" class="${tab === "lines" ? "on" : ""}">Lignes</button><button data-t="stops" class="${tab === "stops" ? "on" : ""}">Arrêts</button><button data-t="favs" class="${tab === "favs" ? "on" : ""}">Favoris</button></div>${body}`;
};
V.lines.after = () => document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { S.route.args = { tab: b.dataset.t }; render(); }));

V.line = async ({ id }) => {
  const l = lineById(id);
  const stops = l.stop_ids.map(stopById);
  const pos = stops.map((s) => along(l, [s.lat, s.lon]));
  const buses = S.vehicles.filter((v) => v.line_id === id && v.has_position && v.freshness !== "unknown").map((v) => ({ v, d: along(l, [v.lat, v.lon]) }));
  let rows = "";
  stops.forEach((s, i) => {
    rows += `<button class="tl-stop ${i === stops.length - 1 ? "last" : ""}" data-go="stop" data-a="${A({ id: s.id, title: s.name })}"><span class="tl-rail"><span class="tl-dot"></span></span><span class="tl-name">${esc(s.name)}</span></button>`;
    if (i < stops.length - 1) for (const b of buses.filter((x) => x.d >= pos[i] && x.d < pos[i + 1])) {
      rows += `<div class="tl-bus ${b.v.freshness}"><span class="tl-rail"><span class="bus-dot" style="background:${l.color}">${ic("bus", 14)}</span></span><span>${b.v.direction >= 0 ? "↓" : "↑"} ${esc(terminus(l, b.v.direction))}</span></div>`;
    }
  });
  return `<div class="line-head">${chip(l)}<div class="grow">${esc(l.name)}</div>${star("lines", l.id)}</div>
    <div class="timeline" style="--lc:${l.color}">${rows}</div>
    <div class="bottom-btn"><button class="pill-btn ghost" id="line-map" style="width:100%">${ic("map", 20)}Voir sur la carte</button></div>`;
};
V.line.after = ({ id }) => ($("#line-map").onclick = () => go("map", { lineId: id }));

V.stop = async ({ id }) => {
  const arr = await api(`/api/stops/${id}/arrivals`).catch(() => []);
  return `<div class="line-head"><span class="tile-ic">${ic("pin")}</span><div class="grow">${linesAt(id).map(chip).join(" ")}</div>${star("stops", id)}</div>
    <div class="panel">${arrivalRows(arr, id)}</div>
    <div class="bottom-btn"><button class="pill-btn ghost" id="stop-map" style="width:100%">${ic("map", 20)}Voir sur la carte</button></div>`;
};
V.stop.after = ({ id }) => ($("#stop-map").onclick = () => go("map", { stopId: id }));

V.profile = async () => {
  await refreshMe();
  const me = S.me;
  const item = (icon, label, to) => `<button class="row-i" data-go="${to}"><span class="tile-ic">${ic(icon)}</span><div class="grow"><div class="t">${label}</div></div><span class="chev">${ic("chev", 20)}</span></button>`;
  return `
    <div class="profile-card"><div class="avatar">${esc(firstName()[0])}</div>
      <div><div class="name">${esc(me.traveler.name || "Voyageur")}</div><div class="phone-pill">${ic("phone", 15)}${esc(me.traveler.phone)}</div></div></div>
    ${passCards()}
    <div class="panel" style="margin-top:8px">
      ${item("user", "Mon compte", "account")}
      ${item("clock", "Mes trajets", "trips")}
      ${item("card", "Mon Pass", "pass")}
      ${item("settings", "Paramètres", "settings")}
      ${item("help", "Centre d’aide", "help")}
    </div>`;
};
V.profile.after = bindCarousel;

V.account = async () => {
  const me = S.me, c = card();
  const kv = (icon, k, v) => `<div class="row-i"><span class="tile-ic">${ic(icon)}</span><div class="grow"><div class="s" style="margin:0 0 3px">${k}</div><div class="t">${v}</div></div></div>`;
  return `<div style="text-align:center;padding:10px 0 18px"><div class="avatar" style="width:86px;height:86px;font-size:34px;margin:0 auto 12px">${esc(firstName()[0])}</div>
      <div style="font-weight:800;font-size:21px">${esc(me.traveler.name || "Voyageur")}</div><div class="muted" style="font-size:13px">ID ${esc(me.traveler.id.slice(4, 14))}</div></div>
    <div class="panel">${kv("phone", "Téléphone", esc(me.traveler.phone))}${kv("card", "Metala Pass", c ? esc(c.uid) : "—")}</div>
    <div class="panel" style="margin-top:12px">${kv("calendar", "Inscription", new Date(me.traveler.created_at).toLocaleDateString("fr-FR"))}${kv("shield", "Statut", c?.status === "active" ? "Actif" : "Carte bloquée")}</div>
    <div class="bottom-btn"><button class="pill-btn primary logout" style="width:100%">Déconnexion</button></div>`;
};
V.account.after = bindLogout;

V.settings = async () => {
  const tg = (k, icon, t, s) => `<button class="row-i" data-tg="${k}"><span class="tile-ic">${ic(icon)}</span><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div><span class="toggle ${S.settings[k] ? "on" : ""}"></span></button>`;
  return `<div class="grp">Notifications</div><div class="panel">${tg("notif", "bell", "Alertes de passage", "3 min avant l’arrivée")}</div>
    <div class="grp">Sécurité</div><div class="panel">
      <button class="row-i"><span class="tile-ic">${ic("lock")}</span><div class="grow"><div class="t">Code PIN</div><div class="s">Pour les recharges</div></div><span class="chev">${ic("chev", 20)}</span></button>
      ${tg("bio", "shield", "Biométrie", "Face ID ou empreinte")}</div>
    <div class="bottom-btn"><button class="pill-btn primary logout" style="width:100%">Déconnexion</button></div>`;
};
V.settings.after = () => {
  bindLogout();
  document.querySelectorAll("[data-tg]").forEach((b) => (b.onclick = () => {
    S.settings[b.dataset.tg] = !S.settings[b.dataset.tg];
    store.set("metala.app.settings", JSON.stringify(S.settings));
    b.querySelector(".toggle").classList.toggle("on", S.settings[b.dataset.tg]);
  }));
};
function bindLogout() {
  document.querySelectorAll(".logout").forEach((b) => (b.onclick = async () => {
    await api("/api/auth/logout", { method: "POST", token: S.token }).catch(() => {});
    sessionStore.del("metala.app.token");
    location.href = location.pathname;
  }));
}

V.help = async () => `<div class="panel">
  ${[["card", "Le Pass", "Posez la carte sur le valideur."], ["wifioff", "Sans réseau", "Le porte-monnaie paie, jusqu’au solde."], ["ban", "Carte perdue", "Bloquez-la depuis Mon Pass. Solde conservé."], ["phone", "Contact", "07 00 00 00 00 (démo)"]]
    .map(([i, t, s]) => `<div class="row-i"><span class="tile-ic">${ic(i)}</span><div class="grow"><div class="t">${t}</div><div class="s">${s}</div></div></div>`).join("")}</div>`;

V.trips = async () => {
  const [res, hist] = await Promise.all([api("/api/me/reservations", { token: S.token }), api("/api/me/history", { token: S.token })]);
  const upcoming = res.filter((r) => r.status === "confirmed" && new Date(r.departure.depart_at) > Date.now());
  const icon = (h) => h.kind === "purchase" ? "wallet" : h.status === "accepted" ? "check" : h.status === "already_validated" ? "refresh" : "x";
  return `${upcoming.length ? `<div class="sec"><h3>Réservations</h3></div><div class="panel">${upcoming.map((r) => {
      const l = lineById(r.departure.line_id);
      return `<div class="row-i">${chip(l)}<div class="grow"><div class="t">${hhmm(r.departure.depart_at)}</div><div class="s">${esc(stopById(l.stop_ids[0]).name)}</div></div><button class="btn-s" style="flex:none" data-cancel="${r.id}">Annuler</button></div>`;
    }).join("")}</div>` : ""}
    <div class="sec"><h3>Historique</h3></div>
    ${hist.length ? `<div class="panel">${hist.map((h) => `<div class="row-i"><span class="tile-ic">${ic(icon(h), 20)}</span>
      <div class="grow"><div class="t">${esc(h.label)}</div><div class="s">${esc(h.kind === "purchase" ? (h.status === "succeeded" ? fcfa(h.amount) : h.status === "pending" ? "en attente" : "échoué") : h.detail)}</div></div>
      <small class="muted">${ddmm(h.at)} ${hhmm(h.at)}</small></div>`).join("")}</div>` : `<div class="empty">Aucun trajet</div>`}`;
};
V.trips.after = () => document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
  await api(`/api/reservations/${b.dataset.cancel}`, { method: "DELETE", token: S.token });
  render(true);
}));

// ---------- Carte ----------
async function showMap(args = {}) {
  if (!S.map) {
    S.map = await createMap("map", { zoom: 12.2, dark: true, onStyle: (m, g) => drawNetwork(m, S.network, g, { highlightLine: S.route?.args?.lineId }) });
    onStopClick(S.map, (id) => showSheet({ stopId: id }));
    S.layer = new VehicleLayer(S.map, S.network, { onClick: (vid) => showSheet({ vehicleId: vid }) });
  }
  const map = S.map;
  map.resize();
  drawNetwork(map, S.network, !!map.getStyle().glyphs, { highlightLine: args.lineId });
  S.layer.focus = args.vehicleId || null;
  S.layer.update(S.vehicles);
  const sheetOpen = !!(args.stopId || args.vehicleId);
  const pad = { top: 60, bottom: sheetOpen ? 220 : 40, left: 30, right: 30 };
  if (args.lineId) fitLines(map, [lineById(args.lineId)], pad);
  else if (args.stopId) { const s = stopById(args.stopId); map.easeTo({ center: [s.lon, s.lat], zoom: 13.5, offset: [0, -110], duration: 500 }); }
  else if (args.vehicleId) { const v = S.vehicles.find((x) => x.vehicle_id === args.vehicleId); if (v) map.easeTo({ center: [v.lon, v.lat], zoom: 14, offset: [0, -110], duration: 500 }); }
  else fitLines(map, S.network.lines, pad);
  showSheet(args.stopId || args.vehicleId ? args : null);
}

async function showSheet(sel) {
  const sh = $("#sheet");
  S.sheet = sel;
  if (!sel) { sh.classList.add("hidden"); return; }
  sh.classList.remove("hidden");
  if (sel.stopId) {
    const s = stopById(sel.stopId);
    const arr = await api(`/api/stops/${s.id}/arrivals`).catch(() => []);
    if (S.sheet !== sel) return;
    sh.innerHTML = `<div class="grab"></div><div class="sheet-head"><h3>${esc(s.name)}</h3>${star("stops", s.id)}</div><div class="panel">${arrivalRows(arr, s.id)}</div>`;
  } else {
    const v = S.vehicles.find((x) => x.vehicle_id === sel.vehicleId);
    if (!v) { sh.classList.add("hidden"); return; }
    const l = lineById(v.line_id);
    const target = sel.stopId2 || S.alerts.get(v.vehicle_id)?.stopId;
    let eta = "";
    if (target) {
      const a = (await api(`/api/stops/${target}/arrivals`).catch(() => [])).find((x) => x.vehicle_id === v.vehicle_id);
      if (S.sheet !== sel) return;
      if (a) eta = `<div class="row-i"><span class="tile-ic">${ic("pin")}</span><div class="grow"><div class="t">${esc(stopById(target).name)}</div>${S.alerts.has(v.vehicle_id) ? `<div class="s">${ic("bell", 14)} alerte à 3 min</div>` : ""}</div>${etaHtml(a)}</div>`;
    }
    sh.innerHTML = `<div class="grab"></div><div class="sheet-head">${chip(l)}<h3>${esc(terminus(l, v.direction))}</h3></div>
      <div class="panel">${eta}<div class="row-i"><span class="tile-ic">${ic("bus")}</span><div class="grow"><div class="s" style="margin:0">${freshnessBadge(v.freshness, v.age_seconds)} <span class="badge">${v.reservable_seats} places</span></div></div></div></div>
      <div class="actions" style="padding:0 12px"><button class="btn-s" data-book="${l.id}">Réserver</button></div>`;
  }
  bind(sh);
}

function follow(vid, stopId) {
  if (S.alerts.has(vid)) { S.alerts.delete(vid); render(true); return; }
  S.alerts.set(vid, { stopId, notified: false });
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  go("map", { vehicleId: vid, stopId2: stopId });
}

async function checkAlerts() {
  for (const [vid, al] of S.alerts) {
    try {
      const a = (await api(`/api/stops/${al.stopId}/arrivals`)).find((x) => x.vehicle_id === vid);
      if (a && a.eta_minutes <= 3 && !al.notified) {
        al.notified = true;
        const msg = `${a.line_code} arrive à ${stopById(al.stopId).name} dans ${Math.max(a.eta_minutes, 0)} min`;
        toast(msg, "success");
        if (S.settings.notif && "Notification" in window && Notification.permission === "granted") new Notification("Metala", { body: msg });
      }
    } catch {}
  }
}

// ---------- Paiement ----------
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
  const what = p.kind === "wallet" ? "Porte-monnaie Metala" : `${p.name} · ${kindDesc(p)}`;
  modal(`<div class="m-head"><strong>Paiement</strong><button class="icon-btn" id="pay-x">${ic("x")}</button></div>
    <div class="amount">${fcfa(p.price)}</div><div class="amount-l">${esc(what)}</div>
    <div class="methods">${METHODS.map((m, i) => `<button class="method ${i === 0 ? "on" : ""}" data-m="${m.id}"><span class="mi" style="background:${m.color}">${m.short}</span>${m.label}</button>`).join("")}</div>
    <button class="pill-btn primary" id="pay-go" style="width:100%">Payer</button>
    <details class="tech"><summary>Tests</summary>
      <label><input type="checkbox" id="pay-dup"> Confirmation envoyée deux fois</label>
      <label><input type="checkbox" id="pay-fail"> Paiement refusé</label></details>`, () => {
    document.querySelectorAll(".method").forEach((b) => (b.onclick = () => { method = b.dataset.m; document.querySelectorAll(".method").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#pay-x").onclick = closeModal;
    $("#pay-go").onclick = () => pay(p, method, $("#pay-dup").checked, $("#pay-fail").checked);
  });
}

async function pay(p, method, dup = false, fail = false) {
  const m = METHODS.find((x) => x.id === method) || METHODS[0];
  modal(`<div class="success"><div class="spinner"></div><strong>Validez sur votre téléphone</strong><p>${m.label} · ${fcfa(p.price)}</p></div>`);
  try {
    const pay = await api("/api/purchases", { method: "POST", token: S.token, body: { product_id: p.id } });
    await new Promise((r) => setTimeout(r, 900));
    const r = await api(`/api/dev/psp/${pay.id}/confirm?status=${fail ? "failed" : "succeeded"}${dup ? "&duplicate=1" : ""}`, { method: "POST" });
    await refreshMe();
    const ok = r.status === "succeeded";
    modal(`<div class="success"><div class="check ${ok ? "" : "ko"}">${ic(ok ? "check" : "x", 42)}</div>
      <strong>${ok ? (p.kind === "wallet" ? `+ ${fcfa(p.price)}` : "Titre ajouté") : "Paiement refusé"}</strong>
      <p>${ok ? (p.kind === "wallet" ? `Solde : ${fcfa(card()?.balance)}` : esc(p.name)) : "Aucun débit"}</p></div>
      <button class="pill-btn primary" id="ok" style="width:100%">Terminé</button>`, () => ($("#ok").onclick = () => { closeModal(); go("home", {}, true); }));
  } catch (e) { closeModal(); toast(e.message, "error"); }
}

async function openBooking(lineId) {
  const l = lineById(lineId);
  const deps = (await api(`/api/departures?line_id=${lineId}`)).slice(0, 5);
  modal(`<div class="m-head"><strong>${chip(l)} Réserver</strong><button class="icon-btn" id="bk-x">${ic("x")}</button></div>
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

// ---------- Rafraîchissement ----------
async function tick() {
  if (!S.route || $("#main").classList.contains("hidden")) return;
  checkAlerts();
  if (!$("#modal").classList.contains("hidden")) return;
  const n = S.route.name;
  if (n === "home") {
    const home = S.favs.stops[0] || DEFAULT_STOP;
    const arr = (await api(`/api/stops/${home}/arrivals`).catch(() => [])).slice(0, 3);
    if (S.route.name === "home" && $("#home-arr")) $("#home-arr").innerHTML = arrivalRows(arr, home, false);
  } else if (n === "map" && S.sheet) showSheet(S.sheet);
  else if (n === "line" || n === "stop") render(true);
}

// ---------- Démo guidée ----------
window.metalaDemo = {
  ready: () => !!S.route,
  home: async () => { await refreshMe(); go("home", {}, true); },
  search: () => go("search", { from: DEFAULT_STOP, to: "st_plateau_cite" }, true),
  map: () => go("map", { stopId: DEFAULT_STOP }, true),
  pass: () => go("pass", {}, true),
  buy: async (productId = "prd_wallet_2000") => {
    go("recharge", {}, true);
    await until(() => $("#w-go"));
    await openCheckout(productId);
    await new Promise((r) => setTimeout(r, 1300));
    $("#pay-go").click();
  },
  flashPass: async () => {
    await refreshMe();
    go("home", {}, true);
    const el = await until(() => document.getElementById("pass-card"));
    if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  },
};

async function boot() {
  S.network = await api("/api/network");
  S.products = await api("/api/products").catch(() => []);
  subscribeVehicles((st) => { S.vehicles = st; if (S.layer) S.layer.update(st); });
  setInterval(tick, 5000);
  if (S.token) { try { await enter(); return; } catch { sessionStore.del("metala.app.token"); S.token = null; } }
  if (params.get("demo") === "awa") await loginAsAwa().catch((e) => toast(e.message, "error"));
}
boot().catch((e) => toast(e.message, "error"));
