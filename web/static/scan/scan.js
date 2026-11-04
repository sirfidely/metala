import { api, esc, sessionStore, store, toast, params, embedded, fcfa, hhmm } from "/shared/metala.js";
import { ic } from "/shared/icons.js";

// Metala Scan : l'application du conducteur. Prise de service, encaissement
// (carte NFC ou QR du téléphone), recette du service, mode hors ligne.

const $ = (s) => document.querySelector(s);
const S = {
  token: sessionStore.get("metala.scan.token"), inv: null, driver: null, vehicle: null, pin: "",
  shift: null, config: null, online: true, queue: [], recent: [], busy: false, amount: "",
  medium: null,
};
if (embedded) { document.body.classList.add("embed"); $("#banner").classList.add("hidden"); }
const MODE_IC = { bus: "bus", navette: "van", bateau: "boat", gbaka: "van", woro: "taxi", taxi: "taxi" };
const OP_COLOR = { op_lagune: "#0E7C66", op_ebene: "#C2410C", op_bateau: "#2563EB", op_gbaka: "#CA8A04", op_woro: "#9333EA", op_taxi: "#E11D48" };

// Ce que les voyageurs présentent (simulation : cartes et téléphones virtuels).
const MEDIA = [
  { key: "awa", kind: "card", uid: "04A1B2C3D4E5F6", name: "Carte d’Awa" },
  { key: "awa-phone", kind: "phone", phone: "0700000001", name: "Téléphone d’Awa" },
  { key: "koffi", kind: "card", uid: "04B7C8D9E0F1A2", name: "Carte de Koffi" },
  { key: "yao", kind: "card", uid: "04C3D4E5F6A7B8", name: "Carte de Yao" },
  { key: "clone", kind: "card", uid: "04A1B2C3D4E5F6", name: "Carte copiée", special: "clone" },
];
const isTaxi = () => S.vehicle?.mode === "taxi";
const qKey = () => "metala.scan.queue." + S.vehicle.vehicle_id;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());

// ---------- Connexion du conducteur ----------
async function boot() {
  try { S.inv = await api("/api/dev/inventory"); } catch { S.inv = { drivers: [], driver_pin: "" }; }
  const drv = params.get("driver"), veh = params.get("vehicle");
  if (drv && veh) {
    const d = S.inv.drivers.find((x) => x.id === drv);
    const v = d?.vehicles.find((x) => x.vehicle_id === veh);
    if (d && v) { S.driver = d; S.vehicle = v; S.pin = S.inv.driver_pin; return login(); }
  }
  if (S.token) {
    try {
      S.shift = await api("/api/scan/shift", { token: S.token });
      S.driver = S.shift.driver;
      S.vehicle = { vehicle_id: S.shift.vehicle.id, plate: S.shift.vehicle.plate, mode: S.shift.vehicle.mode, line_code: S.shift.line_code, operator_id: S.shift.vehicle.operator_id };
      return start();
    } catch { sessionStore.del("metala.scan.token"); }
  }
  stepDriver();
}

function stepDriver() {
  $("#login-step").innerHTML = `<h2>Bonjour, qui conduit ?</h2><p class="muted" style="margin:0 0 12px">Conducteurs de démonstration</p>
    <div class="list">${S.inv.drivers.map((d, i) => `<button class="opt" data-i="${i}"><span class="av" style="background:${OP_COLOR[d.operator_id] || "#163742"}">${esc(d.name.split(" ").map((x) => x[0]).join(""))}</span>
      <span><b>${esc(d.name)}</b><small>${esc(opName(d.operator_id))}</small></span></button>`).join("")}</div>`;
  document.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { S.driver = S.inv.drivers[+b.dataset.i]; stepVehicle(); }));
}
const opName = (id) => ({ op_lagune: "Lagune Express", op_ebene: "Navettes Ébène", op_bateau: "Bateaux de la Lagune", op_gbaka: "Union des gbaka", op_woro: "Woro-woro Riviera", op_taxi: "Taxis Kouassi & Fils" }[id] || "");

function stepVehicle() {
  const vs = S.driver.vehicles;
  $("#login-step").innerHTML = `<h2>Votre véhicule</h2><p class="muted" style="margin:0 0 12px">${esc(S.driver.name)} · ${esc(opName(S.driver.operator_id))}</p>
    <div class="list">${vs.map((v, i) => `<button class="opt" data-i="${i}"><span class="av" style="background:${OP_COLOR[v.operator_id]}">${ic(MODE_IC[v.mode] || "bus", 20)}</span>
      <span><b>${esc(v.plate)}</b><small>${v.line_code ? "Ligne " + esc(v.line_code) : "Taxi compteur"}${v.frozen ? " · valideur gelé" : ""}</small></span></button>`).join("")}</div>
    <button class="link" id="back">‹ Changer de conducteur</button>`;
  document.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { S.vehicle = vs[+b.dataset.i]; stepPin(); }));
  $("#back").onclick = stepDriver;
}

function stepPin() {
  S.pin = "";
  const draw = () => {
    $("#login-step").innerHTML = `<h2>Code PIN</h2><p class="muted" style="margin:0">${esc(S.driver.name)} · ${esc(S.vehicle.plate)}</p>
      <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<i class="${i < S.pin.length ? "on" : ""}"></i>`).join("")}</div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}<button data-k="del">${ic("back", 22)}</button><button data-k="0">0</button><button class="ok" data-k="ok">Valider</button></div>
      <p class="muted" style="text-align:center;font-size:12.5px">Démo : ${esc(S.inv.driver_pin)}</p><button class="link" id="back">‹ Changer de véhicule</button>`;
    document.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.k;
      if (k === "del") S.pin = S.pin.slice(0, -1);
      else if (k === "ok") return login();
      else if (S.pin.length < 4) S.pin += k;
      draw();
      if (S.pin.length === 4) login();
    }));
    $("#back").onclick = stepVehicle;
  };
  draw();
}

async function login() {
  try {
    const r = await api("/api/auth/driver", { method: "POST", body: { phone: S.driver.phone, pin: S.pin, vehicle_id: S.vehicle.vehicle_id } });
    S.token = r.token;
    sessionStore.set("metala.scan.token", r.token);
    start();
  } catch (e) { toast(e.message, "error"); S.pin = ""; if (!params.get("driver")) stepPin(); }
}

// ---------- Service ----------
async function start() {
  $("#login").classList.add("hidden");
  $("#run").classList.remove("hidden");
  try { S.queue = JSON.parse(store.get(qKey()) || "[]"); } catch { S.queue = []; }
  const color = OP_COLOR[S.vehicle.operator_id] || "#163742";
  $("#t-chip").style.background = color;
  $("#t-chip").innerHTML = `${ic(MODE_IC[S.vehicle.mode] || "bus", 18)}${esc(S.vehicle.line_code || "")}`;
  $("#t-veh").textContent = S.vehicle.plate;
  $("#t-driver").textContent = S.driver.name;
  S.medium = MEDIA[0];
  renderMedia();
  await refreshConfig();
  setOnline(true);
  refreshShift();
  clearInterval(S.poll);
  S.poll = setInterval(() => { refreshShift(); sync(); }, 5000);
}

async function refreshConfig() {
  try {
    S.config = await api("/api/scan/config", { token: S.token, timeout: 2500 });
    store.set("metala.scan.config", JSON.stringify(S.config));
  } catch { try { S.config = JSON.parse(store.get("metala.scan.config")); } catch {} }
  renderZone();
}

async function refreshShift() {
  if (!S.online) return;
  try { S.shift = await api("/api/scan/shift", { token: S.token, timeout: 2500 }); } catch (e) { if (e.status === 401 || e.status === 403) return logout(); return; }
  const pending = S.queue.reduce((a, t) => a + t.amount, 0);
  $("#s-rev").textContent = fcfa(S.shift.revenue + pending);
  $("#s-pax").textContent = S.shift.passengers + S.queue.length;
  $("#recent").innerHTML = S.shift.recent.length ? S.shift.recent.slice(0, 5).map((v) => `
    <div class="tx"><span class="s ${v.status}">${ic(v.status === "accepted" ? "check" : v.status === "rejected" ? "x" : "refresh", 14)}</span>
      <div class="grow">${v.status === "accepted" ? fcfa(v.debited) + (v.source === "wallet" ? " · porte-monnaie" : v.debited ? " · titre" : " · forfait") : esc(v.message.replace("Refusé — ", ""))}${v.channel === "phone" ? " · QR" : ""}${v.offline ? " · hors ligne" : ""}</div>
      <span class="when">${hhmm(v.at)}</span></div>`).join("") : `<p class="muted" style="margin:4px 0;font-size:13px">Aucune transaction</p>`;
}

function renderMedia() {
  $("#media").innerHTML = MEDIA.map((m) => `<button class="med ${m === S.medium ? "sel" : ""} ${m.special ? "bad" : ""}" data-k="${m.key}">${ic(m.kind === "phone" ? "qr" : m.special ? "x" : "card", 16)}${esc(m.name)}</button>`).join("");
  $("#media").querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { S.medium = MEDIA.find((m) => m.key === b.dataset.k); renderMedia(); }));
}

function renderZone() {
  const z = $("#zone");
  const keepResult = $("#result") && !$("#result").classList.contains("hidden") ? $("#result").outerHTML : `<div id="result" class="result hidden"></div>`;
  if (isTaxi()) {
    const amt = Number(S.amount || 0);
    z.innerHTML = `<div class="fare">Montant du compteur</div><div class="amount">${new Intl.NumberFormat("fr-FR").format(amt)} <small>FCFA</small></div>
      <div class="taxi-pad"><div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}<button data-k="del">${ic("back", 20)}</button><button data-k="0">0</button><button class="ok" data-k="ok" ${amt ? "" : "disabled"}>Encaisser</button></div></div>${keepResult}`;
    z.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.k;
      if (k === "del") S.amount = S.amount.slice(0, -1);
      else if (k === "ok") return tap();
      else if (S.amount.length < 5) S.amount += k;
      renderZone();
    }));
  } else {
    z.innerHTML = `<div class="fare">Tarif <b>${S.config ? fcfa(S.config.fare) : "—"}</b> · titres acceptés</div>
      <div class="reader" id="reader" role="button" aria-label="Encaisser">${ic("nfc", 60)}</div>
      <div class="hint">Carte ou QR du voyageur</div>${keepResult}`;
    $("#reader").onclick = () => tap();
  }
}

function renderNet() {
  const n = $("#net");
  n.className = "net" + (S.online ? "" : " off");
  n.innerHTML = S.online ? `${ic("wifi", 15)}En ligne` : `${ic("wifioff", 15)}Hors ligne`;
  $("#term").classList.toggle("offline", !S.online);
  const q = $("#queue");
  q.classList.toggle("hidden", !S.queue.length);
  q.innerHTML = `${ic("refresh", 15)}${S.queue.length} paiement${S.queue.length > 1 ? "s" : ""} hors ligne à transmettre`;
}
async function setOnline(on) { S.online = on; renderNet(); if (on) { await refreshConfig(); await sync(); refreshShift(); } }
$("#net").onclick = () => setOnline(!S.online);

async function sync() {
  if (!S.online || !S.queue.length) return null;
  try {
    const r = await api("/api/scan/offline-sync", { method: "POST", token: S.token, body: { txs: S.queue } });
    S.queue = [];
    store.set(qKey(), "[]");
    renderNet();
    refreshShift();
    if (r.synced) toast(`${r.synced} paiement${r.synced > 1 ? "s" : ""} hors ligne transmis`, "success");
    return r;
  } catch { return null; }
}

// ---------- Encaissement ----------
async function tap(key) {
  if (key) { S.medium = MEDIA.find((m) => m.key === key) || S.medium; renderMedia(); }
  if (S.busy) return null;
  if (isTaxi() && !Number(S.amount)) { toast("Saisissez le montant du compteur", "error"); return null; }
  S.busy = true;
  const m = S.medium;
  pending();
  try { return S.online ? await tapOnline(m) : await tapOffline(m); }
  finally { S.busy = false; if (isTaxi()) { S.amount = ""; } }
}

async function tapOnline(m) {
  const amount = isTaxi() ? Number(S.amount) : undefined;
  try {
    const req = { tap_id: uuid(), amount };
    if (m.kind === "phone") {
      req.pay_token = (await api(`/api/dev/travelers/${m.phone}/pay-token`, { method: "POST" })).token; // lecture du QR par la caméra
    } else {
      const { challenge } = await api("/api/scan/challenge", { method: "POST", token: S.token, timeout: 2500 });
      let proof = "";
      if (!m.special) { try { proof = (await api(`/api/dev/cards/${m.uid}/respond`, { method: "POST", body: { challenge } })).proof; } catch { proof = "00"; } }
      Object.assign(req, { card_uid: m.uid, challenge, proof });
    }
    const v = await api("/api/scan/validate", { method: "POST", token: S.token, body: req, timeout: 2500 });
    const kind = v.status === "already_validated" ? "already" : v.status;
    return show({ kind, message: v.message, source: v.source, channel: v.channel, debited: v.debited }, m);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return show({ kind: "rejected", message: "Valideur bloqué" }, m);
    if (e.status === 400) return show({ kind: "rejected", message: e.message }, m);
    setOnline(false);
    return tapOffline(m);
  }
}

// Hors ligne : décision locale, débit du porte-monnaie de la carte.
async function tapOffline(m) {
  await new Promise((r) => setTimeout(r, 300));
  if (m.kind === "phone") return show({ kind: "rejected", message: "QR indisponible hors ligne · utilisez la carte", offline: true }, m);
  if (m.special) return show({ kind: "rejected", message: "Refusé — carte non authentique", offline: true }, m);
  if (S.config?.blacklist?.includes(m.uid)) return show({ kind: "rejected", message: "Refusé — carte bloquée", offline: true }, m);
  if (!isTaxi() && S.recent.find((r) => r.uid === m.uid && Date.now() - r.at < 60000)) return show({ kind: "already", message: "Déjà validé — aucun débit", offline: true }, m);
  const amount = isTaxi() ? Number(S.amount) : S.config?.fare;
  try {
    const tx = await api(`/api/dev/cards/${m.uid}/offline-debit`, { method: "POST", body: { device_id: "dev_" + S.vehicle.vehicle_id.slice(4), amount } });
    S.queue.push(tx);
    store.set(qKey(), JSON.stringify(S.queue));
    S.recent.push({ uid: m.uid, at: Date.now() });
    renderNet();
    $("#s-pax").textContent = (S.shift?.passengers || 0) + S.queue.length;
    $("#s-rev").textContent = fcfa((S.shift?.revenue || 0) + S.queue.reduce((a, t) => a + t.amount, 0));
    return show({ kind: "accepted", message: `Payé hors ligne — solde ${fcfa(tx.balance)}`, source: "wallet", offline: true, debited: tx.amount }, m);
  } catch (e) {
    return show({ kind: "rejected", message: e.status === 409 ? "Refusé — solde insuffisant" : "Refusé", offline: true }, m);
  }
}

function pending() {
  const el = $("#result");
  clearTimeout(S.hide);
  el.className = "result pending";
  el.innerHTML = `<div class="big" style="background:none">${ic("nfc", 54)}</div><div class="msg" style="font-size:17px;color:var(--mu)">Lecture…</div>`;
}

function show(r, m) {
  const el = $("#result");
  el.className = "result " + r.kind;
  const tags = [];
  if (r.offline) tags.push("hors ligne");
  if (r.channel === "phone" || m.kind === "phone") tags.push("QR téléphone");
  if (r.source === "wallet") tags.push("porte-monnaie");
  el.innerHTML = `<div class="big">${ic({ accepted: "check", already: "refresh", rejected: "x" }[r.kind], 48)}</div>
    <div class="msg">${esc(r.message)}</div><div class="det">${r.debited ? `<b>${fcfa(r.debited)}</b>` : ""}${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>`;
  clearTimeout(S.hide);
  S.hide = setTimeout(() => { el.classList.add("hidden"); if (isTaxi()) renderZone(); }, embedded ? 6000 : 3000);
  el.onclick = () => { el.classList.add("hidden"); if (isTaxi()) renderZone(); };
  if (navigator.vibrate) navigator.vibrate(r.kind === "accepted" ? 80 : [60, 60, 60]);
  refreshShift();
  return r;
}

// ---------- Fin de service ----------
$("#end").onclick = async () => {
  if (S.queue.length && !S.online) return toast("Transmettez d’abord les paiements hors ligne (réseau requis)", "error");
  await sync();
  try {
    const sv = await api("/api/scan/shift/end", { method: "POST", token: S.token });
    const mins = Math.round((new Date(sv.shift.end) - new Date(sv.shift.start)) / 60000);
    $("#sheet-card").innerHTML = `<h2 style="margin:0">Service terminé</h2><p class="muted" style="margin:4px 0 0">${esc(sv.driver.name)} · ${esc(sv.vehicle.plate)} · ${mins} min</p>
      <div class="sum"><div class="stat"><small>Recette</small><b>${fcfa(sv.revenue)}</b></div><div class="stat"><small>Passagers</small><b>${sv.passengers}</b></div>
      <div class="stat"><small>Refus</small><b>${sv.refused}</b></div><div class="stat"><small>Début</small><b>${hhmm(sv.shift.start)}</b></div></div>
      <button class="btn-main" id="bye">Terminer</button>`;
    $("#sheet").classList.remove("hidden");
    $("#bye").onclick = logout;
  } catch (e) { toast(e.message, "error"); }
};
function logout() {
  clearInterval(S.poll);
  sessionStore.del("metala.scan.token");
  $("#sheet").classList.add("hidden");
  $("#run").classList.add("hidden");
  $("#login").classList.remove("hidden");
  S.token = null;
  stepDriver();
}

// Pilotage depuis la démo guidée.
window.metalaDemo = {
  ready: () => !!S.token && !$("#run").classList.contains("hidden") && !!S.config,
  select: (k) => { S.medium = MEDIA.find((m) => m.key === k) || S.medium; renderMedia(); },
  setOnline,
  queued: () => S.queue.length,
  tap: (k) => tap(k),
};

boot();
