import { api, esc, sessionStore, store, toast, fcfa, hhmm } from "/shared/metala.js";
import { ic } from "/shared/icons.js";

// Metala Scan : l'application mobile des agents transporteurs.
// Encaisser (QR par la caméra, carte NFC, compteur), suivre les réservations,
// voir la recette du service, du véhicule et de la ligne.

const $ = (s) => document.querySelector(s);
const S = {
  token: sessionStore.get("metala.scan.token"), inv: null, driver: null, vehicle: null,
  phone: "", pin: "", shift: null, config: null, online: true, queue: [], recent: [],
  busy: false, amount: "", tab: "pay", resa: [], stream: null,
};
const MODE_IC = { bus: "bus", navette: "van", bateau: "boat", gbaka: "van", woro: "taxi", taxi: "taxi" };
const OP_COLOR = { op_lagune: "#0E7C66", op_ebene: "#C2410C", op_bateau: "#2563EB", op_gbaka: "#CA8A04", op_woro: "#9333EA", op_taxi: "#E11D48" };
// Cartes NFC de test (le navigateur ne lit pas les cartes DESFire).
const TEST_CARDS = [
  { uid: "04A1B2C3D4E5F6", name: "Carte d’Awa" },
  { uid: "04B7C8D9E0F1A2", name: "Carte de Koffi" },
  { uid: "04C3D4E5F6A7B8", name: "Carte de Yao" },
  { uid: "04A1B2C3D4E5F6", name: "Copie de la carte d’Awa", clone: true },
];
const isTaxi = () => S.vehicle?.mode === "taxi";
const qKey = () => "metala.scan.queue." + S.vehicle.vehicle_id;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
const digits = (s) => s.replace(/\D/g, "").slice(-10);
const pax = (n) => `${n} passager${n > 1 ? "s" : ""}`;

$("#ti-pay").innerHTML = ic("scan", 22);
$("#ti-resa").innerHTML = ic("ticket", 22);
$("#ti-takings").innerHTML = ic("wallet", 22);

// ---------- Connexion de l'agent ----------
async function boot() {
  try { S.inv = await api("/api/dev/inventory"); } catch { S.inv = { drivers: [], driver_pin: "" }; }
  if (S.token) {
    try {
      S.shift = await api("/api/scan/shift", { token: S.token });
      S.driver = S.shift.driver;
      S.vehicle = { vehicle_id: S.shift.vehicle.id, plate: S.shift.vehicle.plate, mode: S.shift.vehicle.mode, line_code: S.shift.line_code, operator_id: S.shift.vehicle.operator_id };
      return start();
    } catch { sessionStore.del("metala.scan.token"); S.token = null; }
  }
  stepPhone();
}

function stepPhone() {
  $("#login").innerHTML = `<div class="brand"><span class="m">M</span>METALA SCAN</div>
    <h2>Prendre son service</h2><p class="muted" style="margin:0">Numéro de l’agent et code PIN</p>
    <div class="input"><span>+225</span><input id="ph" inputmode="tel" placeholder="01 01 01 01 01" value="${esc(S.phone)}" autocomplete="tel"></div>
    <div class="pin-dots" id="dots"></div>
    <div class="keypad" id="kp">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}<button data-k="del" aria-label="Effacer">${ic("back", 22)}</button><button data-k="0">0</button><button class="ok" data-k="ok">Suivant</button></div>
    <div class="hintbox">Agents de test : 01 01 01 01 01 (bus M2), 01 01 01 06 01 (taxi) · PIN ${esc(S.inv.driver_pin || "1234")}</div>`;
  const draw = () => { $("#dots").innerHTML = [0, 1, 2, 3].map((i) => `<i class="${i < S.pin.length ? "on" : ""}"></i>`).join(""); };
  draw();
  $("#ph").oninput = (e) => (S.phone = e.target.value);
  $("#kp").querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.k;
    if (k === "del") S.pin = S.pin.slice(0, -1);
    else if (k === "ok") return next();
    else if (S.pin.length < 4) S.pin += k;
    draw();
    if (S.pin.length === 4) next();
  }));
  function next() {
    const d = S.inv.drivers.find((x) => digits(x.phone) === digits(S.phone));
    if (!d) { toast("Numéro d’agent inconnu", "error"); return; }
    if (S.pin.length !== 4) { toast("Code PIN à 4 chiffres", "error"); return; }
    S.driver = d;
    stepVehicle();
  }
}

function stepVehicle() {
  const vs = S.driver.vehicles;
  $("#login").innerHTML = `<div class="brand"><span class="m">M</span>METALA SCAN</div>
    <h2>Bonjour ${esc(S.driver.name.split(" ")[0])}</h2><p class="muted" style="margin:0">Quel véhicule conduisez-vous ?</p>
    <div class="list">${vs.map((v, i) => `<button class="opt" data-i="${i}"><span class="av" style="background:${OP_COLOR[v.operator_id] || "#163742"}">${ic(MODE_IC[v.mode] || "bus", 22)}</span>
      <span><b>${esc(v.plate)}</b><small>${v.line_code ? "Ligne " + esc(v.line_code) : "Taxi compteur"}${v.frozen ? " · valideur bloqué" : ""}</small></span></button>`).join("")}</div>
    <button class="link" id="back">‹ Retour</button>`;
  document.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { S.vehicle = vs[+b.dataset.i]; login(); }));
  $("#back").onclick = () => { S.pin = ""; stepPhone(); };
}

async function login() {
  try {
    const r = await api("/api/auth/driver", { method: "POST", body: { phone: S.driver.phone, pin: S.pin, vehicle_id: S.vehicle.vehicle_id } });
    S.token = r.token;
    sessionStore.set("metala.scan.token", r.token);
    start();
  } catch (e) { toast(e.message, "error"); S.pin = ""; stepPhone(); }
}

// ---------- Service ----------
async function start() {
  $("#login").classList.add("hidden");
  $("#run").classList.remove("hidden");
  try { S.queue = JSON.parse(store.get(qKey()) || "[]"); } catch { S.queue = []; }
  $("#t-chip").style.background = OP_COLOR[S.vehicle.operator_id] || "#163742";
  $("#t-chip").innerHTML = `${ic(MODE_IC[S.vehicle.mode] || "bus", 18)}${esc(S.vehicle.line_code || "")}`;
  $("#t-veh").textContent = S.vehicle.plate;
  $("#t-driver").textContent = S.driver.name;
  await refreshConfig();
  setOnline(true);
  await Promise.all([refreshShift(), refreshResa()]);
  showTab("pay");
  clearInterval(S.poll);
  S.poll = setInterval(() => { refreshShift(); refreshResa(); sync(); }, 8000);
}

document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.t)));
function showTab(t) {
  S.tab = t;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  ({ pay: renderPay, resa: renderResa, takings: renderTakings })[t]();
  $("#tabview").scrollTop = 0;
}

async function refreshConfig() {
  try {
    S.config = await api("/api/scan/config", { token: S.token, timeout: 3000 });
    store.set("metala.scan.config", JSON.stringify(S.config));
  } catch { try { S.config = JSON.parse(store.get("metala.scan.config")); } catch {} }
}

async function refreshShift() {
  if (!S.online) return;
  try { S.shift = await api("/api/scan/shift", { token: S.token, timeout: 3000 }); }
  catch (e) { if (e.status === 401 || e.status === 403) logout(); return; }
  if (S.tab === "takings") renderTakings();
}
async function refreshResa() {
  if (!S.online) return;
  try { S.resa = await api("/api/scan/reservations", { token: S.token, timeout: 3000 }); } catch { return; }
  const waiting = S.resa.some((d) => d.passengers.some((p) => !p.boarded_at));
  $("#resa-dot").classList.toggle("hidden", !waiting);
  if (S.tab === "resa") renderResa();
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
// Le bouton réseau sert à essayer le fonctionnement sans 4G.
async function setOnline(on) { S.online = on; renderNet(); if (on) { await refreshConfig(); await sync(); refreshShift(); refreshResa(); } if (S.tab === "pay") renderPay(); }
$("#net").onclick = () => setOnline(!S.online);

async function sync() {
  if (!S.online || !S.queue.length) return;
  try {
    const r = await api("/api/scan/offline-sync", { method: "POST", token: S.token, body: { txs: S.queue } });
    S.queue = [];
    store.set(qKey(), "[]");
    renderNet();
    if (r.synced) toast(`${r.synced} paiement${r.synced > 1 ? "s" : ""} hors ligne transmis`, "success");
    refreshShift();
  } catch {}
}

// ---------- Onglet Encaisser ----------
function renderPay() {
  const v = $("#tabview");
  const actions = `
    <button class="scan-btn" id="go-qr">${ic("qr", 28)}Scanner le QR du voyageur</button>
    <button class="nfc-zone" id="go-nfc"><span class="ring">${ic("nfc", 30)}</span><span><b>Carte Metala Pass</b><small>${S.online ? "Le voyageur pose sa carte" : "Hors ligne : la carte paie avec son solde"}</small></span></button>`;
  if (isTaxi()) {
    const amt = Number(S.amount || 0);
    v.innerHTML = `<div class="taxi"><div class="fare">Montant du compteur</div><div class="amount">${new Intl.NumberFormat("fr-FR").format(amt)} <small>FCFA</small></div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}<button data-k="del" aria-label="Effacer">${ic("back", 20)}</button><button data-k="0">0</button><button data-k="00">00</button></div></div>
      ${amt ? actions : `<p class="muted" style="text-align:center;margin-top:16px">Saisissez le montant pour encaisser</p>`}`;
    v.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.k;
      if (k === "del") S.amount = S.amount.slice(0, -1);
      else if ((S.amount + k).length <= 5) S.amount = (S.amount + k).replace(/^0+/, "");
      renderPay();
    }));
  } else {
    v.innerHTML = `<div class="fare">Tarif du trajet<b>${S.config ? fcfa(S.config.fare) : "—"}</b>Forfaits, carnets et porte-monnaie acceptés</div>${actions}`;
  }
  const qr = $("#go-qr"), nfc = $("#go-nfc");
  if (qr) qr.onclick = openCamera;
  if (nfc) nfc.onclick = pickCard;
}

// Carte NFC : la lecture DESFire n'est pas possible dans un navigateur ;
// on choisit une carte de test.
function pickCard() {
  sheet(`<h3>Carte présentée</h3><p class="muted" style="margin:0 0 12px">Cartes de test</p>
    <div class="list">${TEST_CARDS.map((c, i) => `<button class="opt" data-c="${i}"><span class="av" style="background:${c.clone ? "rgba(248,113,113,.2)" : "var(--sf2)"};color:${c.clone ? "var(--rd)" : "#fff"}">${ic(c.clone ? "x" : "card", 20)}</span><span><b>${esc(c.name)}</b><small class="mono">${esc(c.uid)}</small></span></button>`).join("")}</div>
    <button class="btn-main ghost" id="sh-x">Annuler</button>`);
  document.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { closeSheet(); charge({ card: TEST_CARDS[+b.dataset.c] }); }));
  $("#sh-x").onclick = closeSheet;
}

// QR : la caméra du téléphone lit le code affiché dans Metala App.
async function openCamera() {
  if (!S.online) return showResult({ kind: "rejected", message: "QR indisponible hors ligne", detail: "Demandez la carte Metala Pass" });
  if (!navigator.mediaDevices?.getUserMedia) return cameraFallback("Caméra indisponible sur cet appareil");
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch { return cameraFallback("Accès à la caméra refusé"); }
  const video = $("#video");
  video.srcObject = S.stream;
  await video.play().catch(() => {});
  $("#camera").classList.remove("hidden");
  const canvas = $("#canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
  const loop = () => {
    if (!S.stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = 480, h = Math.round((video.videoHeight / video.videoWidth) * w);
      canvas.width = w; canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
      if (code?.data) {
        closeCamera();
        if (!code.data.startsWith("MTL1.")) return showResult({ kind: "rejected", message: "Ce QR n’est pas un Metala Pass" });
        if (navigator.vibrate) navigator.vibrate(40);
        return charge({ token: code.data });
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function closeCamera() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  $("#camera").classList.add("hidden");
}
$("#cam-close").onclick = closeCamera;
function cameraFallback(reason) {
  sheet(`<h3>${esc(reason)}</h3><p class="muted" style="margin:0 0 12px">Sur un ordinateur, utilisez le QR de test d’un voyageur.</p>
    <button class="btn-main orange" id="fb-awa">${ic("qr", 20)}QR de test · Awa</button><button class="btn-main ghost" id="sh-x">Annuler</button>`);
  $("#fb-awa").onclick = async () => {
    closeSheet();
    try { charge({ token: (await api("/api/dev/travelers/0700000001/pay-token", { method: "POST" })).token }); } catch (e) { toast(e.message, "error"); }
  };
  $("#sh-x").onclick = closeSheet;
}

async function charge({ card, token }) {
  if (S.busy) return;
  if (isTaxi() && !Number(S.amount)) return toast("Saisissez le montant du compteur", "error");
  S.busy = true;
  showResult({ kind: "pending" });
  try {
    if (S.online) await chargeOnline(card, token);
    else await chargeOffline(card);
  } finally {
    S.busy = false;
    if (isTaxi()) S.amount = "";
    if (S.tab === "pay") renderPay();
  }
}

async function chargeOnline(card, token) {
  const req = { tap_id: uuid(), amount: isTaxi() ? Number(S.amount) : undefined };
  try {
    if (token) req.pay_token = token;
    else {
      const { challenge } = await api("/api/scan/challenge", { method: "POST", token: S.token, timeout: 3000 });
      let proof = "";
      if (!card.clone) { try { proof = (await api(`/api/dev/cards/${card.uid}/respond`, { method: "POST", body: { challenge } })).proof; } catch { proof = "00"; } }
      Object.assign(req, { card_uid: card.uid, challenge, proof });
    }
    const v = await api("/api/scan/validate", { method: "POST", token: S.token, body: req, timeout: 3000 });
    const kind = v.status === "already_validated" ? "already" : v.status;
    showResult({ kind, message: v.message, amount: v.debited, tags: [v.channel === "phone" ? "QR" : "carte", v.source === "wallet" ? "porte-monnaie" : v.source === "title" ? "titre" : ""] });
    refreshShift(); refreshResa();
  } catch (e) {
    if (e.status === 401 || e.status === 403) return showResult({ kind: "rejected", message: "Valideur bloqué par la compagnie" });
    if (e.status === 400) return showResult({ kind: "rejected", message: e.message });
    // Pas de réponse du serveur : on passe hors ligne.
    await setOnline(false);
    if (card) return chargeOffline(card);
    showResult({ kind: "rejected", message: "Réseau perdu", detail: "Demandez la carte Metala Pass" });
  }
}

// Hors ligne : décision locale, débit du porte-monnaie de la carte.
async function chargeOffline(card) {
  if (!card) return showResult({ kind: "rejected", message: "QR indisponible hors ligne" });
  if (card.clone) return showResult({ kind: "rejected", message: "Carte non authentique" });
  if (S.config?.blacklist?.includes(card.uid)) return showResult({ kind: "rejected", message: "Carte bloquée" });
  if (!isTaxi() && S.recent.find((r) => r.uid === card.uid && Date.now() - r.at < 60000)) return showResult({ kind: "already", message: "Déjà payé — aucun débit" });
  const amount = isTaxi() ? Number(S.amount) : S.config?.fare;
  try {
    const tx = await api(`/api/dev/cards/${card.uid}/offline-debit`, { method: "POST", body: { device_id: "dev_" + S.vehicle.vehicle_id.slice(4), amount } });
    S.queue.push(tx);
    store.set(qKey(), JSON.stringify(S.queue));
    S.recent.push({ uid: card.uid, at: Date.now() });
    renderNet();
    showResult({ kind: "accepted", message: "Payé", amount: tx.amount, tags: ["hors ligne", `solde ${fcfa(tx.balance)}`] });
  } catch (e) {
    showResult({ kind: "rejected", message: e.status === 409 ? "Solde insuffisant" : "Refusé" });
  }
}

function showResult(r) {
  const el = $("#result");
  clearTimeout(S.hide);
  el.className = "result " + r.kind;
  if (r.kind === "pending") {
    el.innerHTML = `<div class="big" style="background:none">${ic("nfc", 56)}</div><div class="msg" style="font-size:18px;color:var(--mu)">Paiement en cours…</div>`;
    return;
  }
  el.innerHTML = `<div class="big">${ic({ accepted: "check", already: "refresh", rejected: "x" }[r.kind], 54)}</div>
    <div class="msg">${esc(r.message)}</div>
    <div class="det">${r.amount ? `<b>${fcfa(r.amount)}</b>` : ""}${(r.tags || []).filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${r.detail ? `<span>${esc(r.detail)}</span>` : ""}</div>
    <div class="close">Touchez pour continuer</div>`;
  if (navigator.vibrate) navigator.vibrate(r.kind === "accepted" ? 80 : [60, 60, 60]);
  S.hide = setTimeout(() => el.classList.add("hidden"), 3500);
  el.onclick = () => el.classList.add("hidden");
}

// ---------- Onglet Réservations ----------
function renderResa() {
  const v = $("#tabview");
  if (!S.resa.length) { v.innerHTML = `<div class="empty">${isTaxi() ? "Pas de réservation pour un taxi compteur." : "Aucun départ réservable dans les prochaines heures."}</div>`; return; }
  const total = S.resa.reduce((a, d) => a + d.passengers.length, 0);
  v.innerHTML = `<div class="h4"><span>Prochains départs de ce véhicule</span><span>${total} réservation${total > 1 ? "s" : ""}</span></div>` +
    S.resa.map((d) => {
      const boarded = d.passengers.filter((p) => p.boarded_at).length;
      return `<div class="card2"><div class="dep-head"><span class="t">${hhmm(d.depart_at)}</span>
        <div class="grow"><b>Ligne ${esc(d.line_code)}</b><small>Départ ${esc(d.from)}</small></div>
        <span class="seats">${d.reserved}/${d.reservable_seats} places</span></div>
        ${d.passengers.map((p) => `<div class="pax">${ic("user", 18)}<span class="grow">${esc(p.name)}</span>
          ${p.boarded_at ? `<span class="badge2 in">À bord · ${hhmm(p.boarded_at)}</span>` : `<span class="badge2 wait">Attendu</span>`}</div>`).join("")}
        ${d.passengers.length ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${boarded}/${d.passengers.length} à bord · marqué automatiquement au paiement</div>` : `<div class="muted" style="font-size:13px;margin-top:8px">Aucune réservation</div>`}
      </div>`;
    }).join("");
}

// ---------- Onglet Recette ----------
function renderTakings() {
  const v = $("#tabview"), sh = S.shift;
  if (!sh) { v.innerHTML = `<div class="empty">Chargement…</div>`; return; }
  const pending = S.queue.reduce((a, t) => a + t.amount, 0);
  v.innerHTML = `
    <div class="stats" style="margin-top:6px">
      <div class="stat big"><small>Mon service · depuis ${hhmm(sh.shift.start)}</small><b>${fcfa(sh.revenue + pending)}</b><span>${pax(sh.passengers + S.queue.length)} · ${sh.refused} refus</span></div>
      <div class="stat"><small>Véhicule aujourd’hui</small><b>${fcfa(sh.vehicle_today.revenue)}</b><span>${pax(sh.vehicle_today.passengers)}</span></div>
      <div class="stat"><small>${sh.line_code ? `Ligne ${esc(sh.line_code)} aujourd’hui` : "Réservations"}</small><b>${sh.line_code ? fcfa(sh.line_today.revenue) : sh.reservations}</b><span>${sh.line_code ? `${pax(sh.line_today.passengers)} · tous véhicules` : "à venir"}</span></div>
    </div>
    ${pending ? `<div class="queue" style="margin:10px 0 0">${ic("refresh", 15)}${fcfa(pending)} encaissés hors ligne, transmis au retour du réseau</div>` : ""}
    <div class="h4"><span>Dernières transactions</span></div>
    <div class="card2" style="padding:4px 14px">${sh.recent.length ? sh.recent.map((t) => `
      <div class="tx"><span class="s ${t.status}">${ic(t.status === "accepted" ? "check" : t.status === "rejected" ? "x" : "refresh", 14)}</span>
        <div class="grow">${t.status === "accepted" ? `<b>${fcfa(t.debited)}</b> · ${t.source === "wallet" ? "porte-monnaie" : t.debited ? "titre" : "forfait"}` : esc(t.message.replace("Refusé — ", ""))}${t.channel === "phone" ? " · QR" : ""}${t.offline ? " · hors ligne" : ""}</div>
        <span class="when">${hhmm(t.at)}</span></div>`).join("") : `<div class="empty" style="padding:16px">Aucune transaction</div>`}</div>
    <button class="btn-main danger" id="end">Fin de service</button>`;
  $("#end").onclick = endShift;
}

async function endShift() {
  if (S.queue.length && !S.online) return toast("Reconnectez-vous pour transmettre les paiements hors ligne", "error");
  await sync();
  try {
    const sv = await api("/api/scan/shift/end", { method: "POST", token: S.token });
    const mins = Math.round((new Date(sv.shift.end) - new Date(sv.shift.start)) / 60000);
    sheet(`<h3>Service terminé</h3><p class="muted" style="margin:0 0 14px">${esc(sv.vehicle.plate)} · ${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")}</p>
      <div class="stats"><div class="stat big"><small>Recette</small><b>${fcfa(sv.revenue)}</b><span>${pax(sv.passengers)} · ${sv.refused} refus</span></div></div>
      <button class="btn-main" id="bye">Fermer</button>`);
    $("#bye").onclick = logout;
  } catch (e) { toast(e.message, "error"); }
}

function logout() {
  clearInterval(S.poll);
  closeSheet();
  sessionStore.del("metala.scan.token");
  S.token = null; S.pin = ""; S.shift = null;
  $("#run").classList.add("hidden");
  $("#login").classList.remove("hidden");
  stepPhone();
}

function sheet(html) { $("#sheet-card").innerHTML = html; $("#sheet").classList.remove("hidden"); }
function closeSheet() { $("#sheet").classList.add("hidden"); }
$("#sheet").onclick = (e) => { if (e.target.id === "sheet") closeSheet(); };

boot();
