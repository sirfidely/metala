import { api, esc, sessionStore, store, toast, params, embedded, fcfa } from "/shared/metala.js";
import { ic } from "/shared/icons.js";

const $ = (s) => document.querySelector(s);
const S = {
  token: sessionStore.get("metala.scan.token"), device: null, selected: null, lastTap: null, busy: false,
  online: true, config: null, queue: [], recent: [],
};
if (embedded) { document.body.classList.add("embed"); $("#banner").classList.add("hidden"); }
$("#change").innerHTML = ic("refresh", 18);
$("#reader").innerHTML = ic("nfc", 64);

// Personnages de démonstration et cas de fraude.
const CARDS = [
  { key: "awa", uid: "04A1B2C3D4E5F6", name: "Awa", hint: "carnet + porte-monnaie" },
  { key: "koffi", uid: "04B7C8D9E0F1A2", name: "Koffi", hint: "forfait Ébène" },
  { key: "yao", uid: "04C3D4E5F6A7B8", name: "Yao", hint: "aucun titre" },
  { key: "clone", uid: "04A1B2C3D4E5F6", name: "Clone", hint: "copie de la carte d’Awa", special: "clone" },
];

// File des transactions hors ligne : conservée sur le terminal.
const qKey = () => "metala.scan.queue." + S.device.id;
const loadQueue = () => { try { S.queue = JSON.parse(store.get(qKey()) || "[]"); } catch { S.queue = []; } };
const saveQueue = () => store.set(qKey(), JSON.stringify(S.queue));

async function inventory() {
  try { return await api("/api/dev/inventory"); }
  catch { toast("Simulateur indisponible", "error"); return { devices: [], cards: [] }; }
}

async function boot() {
  S.inv = await inventory();
  const wanted = params.get("device") || sessionStore.get("metala.scan.device");
  const d = S.inv.devices.find((x) => x.id === wanted);
  if (d) {
    if (!params.get("device") && S.token && sessionStore.get("metala.scan.device") === d.id) { S.device = d; return start(); }
    return enroll(d);
  }
  showSetup();
}

function showSetup() {
  $("#setup").classList.remove("hidden");
  $("#run").classList.add("hidden");
  $("#devices").innerHTML = S.inv.devices.map((d) => `
    <button class="dev-btn" data-id="${d.id}">
      <span class="line-chip" style="background:${d.operator_id === "op_lagune" ? "#0E7C66" : "#C2410C"}">${esc(d.line_code)}</span>
      <span><strong>${esc(d.plate)}</strong><br><small>${d.operator_id === "op_lagune" ? "Lagune Express" : "Navettes Ébène"}${d.frozen ? " · gelé" : ""}</small></span>
    </button>`).join("");
  $("#devices").querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => enroll(S.inv.devices.find((d) => d.id === b.dataset.id))));
}

async function enroll(d) {
  try {
    const r = await api("/api/auth/device", { method: "POST", body: { device_id: d.id, secret: d.secret } });
    S.token = r.token;
    S.device = d;
    sessionStore.set("metala.scan.token", r.token);
    sessionStore.set("metala.scan.device", d.id);
    start();
  } catch (e) { toast(e.message, "error"); }
}

async function start() {
  $("#setup").classList.add("hidden");
  $("#run").classList.remove("hidden");
  $("#t-chip").textContent = S.device.line_code;
  $("#t-chip").style.background = S.device.operator_id === "op_lagune" ? "#0E7C66" : "#C2410C";
  $("#t-veh").textContent = "Bus " + S.device.plate;
  $("#t-op").textContent = S.device.operator_id === "op_lagune" ? "Lagune Express" : "Navettes Ébène";
  S.selected = S.selected || CARDS[0];
  loadQueue();
  renderCards();
  await refreshConfig();
  setOnline(true);
}

// Configuration téléchargée en ligne : tarif et liste noire, pour décider hors ligne.
async function refreshConfig() {
  try {
    S.config = await api("/api/scan/config", { token: S.token, timeout: 2500 });
    store.set("metala.scan.config", JSON.stringify(S.config));
  } catch {
    try { S.config = JSON.parse(store.get("metala.scan.config")); } catch {}
  }
  $("#p-fare").innerHTML = `${ic("wallet", 14)}${S.config ? fcfa(S.config.fare) : "—"}`;
}

function renderPills() {
  $("#p-net").className = "pill " + (S.online ? "on" : "off");
  $("#p-net").innerHTML = S.online ? `${ic("wifi", 14)}En ligne` : `${ic("wifioff", 14)}Hors ligne`;
  $("#p-queue").classList.toggle("hidden", !S.queue.length);
  $("#p-queue").innerHTML = `${ic("refresh", 14)}${S.queue.length} à synchroniser`;
  $("#net-ic").innerHTML = ic(S.online ? "wifi" : "wifioff");
  $("#net-label").textContent = S.online ? "Réseau 4G" : "Réseau coupé";
  $("#net-tg").classList.toggle("off", !S.online);
  $("#term").classList.toggle("offline", !S.online);
}

async function setOnline(on) {
  S.online = on;
  renderPills();
  if (on) { await refreshConfig(); await sync(); }
}
$("#net").onclick = () => setOnline(!S.online);

async function sync() {
  if (!S.online || !S.queue.length) return null;
  try {
    const r = await api("/api/scan/offline-sync", { method: "POST", token: S.token, body: { txs: S.queue } });
    S.queue = [];
    saveQueue();
    renderPills();
    if (r.synced) toast(`${r.synced} passage${r.synced > 1 ? "s" : ""} hors ligne synchronisé${r.synced > 1 ? "s" : ""}`, "success");
    return r;
  } catch { return null; }
}
setInterval(sync, 10000);

function renderCards() {
  $("#cards").innerHTML = CARDS.map((c) => `
    <button class="vcard ${c === S.selected ? "sel" : ""} ${c.special ? "bad" : ""}" data-k="${c.key}">
      <span class="av">${c.special ? ic("x", 16) : esc(c.name[0])}</span><span>${esc(c.name)}<small>${esc(c.hint)}</small></span></button>`).join("");
  $("#cards").querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => select(b.dataset.k)));
}
function select(key) { S.selected = CARDS.find((c) => c.key === key) || CARDS[0]; renderCards(); }
$("#change").onclick = async () => { S.inv = await inventory(); showSetup(); };

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());

async function tap() {
  if (S.busy) return null;
  S.busy = true;
  const card = S.selected;
  const t0 = performance.now();
  pending();
  try {
    return S.online ? await tapOnline(card, t0) : await tapOffline(card, t0);
  } finally { S.busy = false; }
}

// En ligne : challenge serveur → réponse de la puce → décision serveur.
async function tapOnline(card, t0) {
  try {
    let req;
    if ($("#retry").checked && S.lastTap) req = S.lastTap;
    else {
      const { challenge } = await api("/api/scan/challenge", { method: "POST", token: S.token, timeout: 2500 });
      let proof = "";
      if (card.special !== "clone") {
        try { proof = (await api(`/api/dev/cards/${card.uid}/respond`, { method: "POST", body: { challenge } })).proof; } catch { proof = "00"; }
      }
      req = { tap_id: uuid(), card_uid: card.uid, challenge, proof };
    }
    S.lastTap = req;
    const v = await api("/api/scan/validate", { method: "POST", token: S.token, body: req, timeout: 2500 });
    const kind = v.status === "already_validated" ? "already" : v.status;
    return show({ kind, message: v.message, reason: v.reason || (kind === "already" ? "passback" : "ok"), source: v.source, debited: v.debited, id: v.id, mode: "online" }, t0, card);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return show({ kind: "rejected", message: "Terminal bloqué", reason: "frozen", mode: "online" }, t0, card);
    // Le serveur ne répond pas : on bascule en mode hors ligne.
    setOnline(false);
    return tapOffline(card, t0);
  }
}

// Hors ligne : le valideur décide seul, avec le porte-monnaie de la puce.
async function tapOffline(card, t0) {
  await new Promise((r) => setTimeout(r, 350));
  const res = (kind, message, reason, extra = {}) => show({ kind, message, reason, mode: "offline", ...extra }, t0, card);
  if (card.special === "clone") return res("rejected", "Refusé — carte non authentique", "offline_auth");
  if (S.config?.blacklist?.includes(card.uid)) return res("rejected", "Refusé — carte bloquée", "offline_blacklist");
  const recent = S.recent.find((r) => r.uid === card.uid && Date.now() - r.at < 60000);
  if (recent) return res("already", "Déjà validé — aucun débit", "offline_passback");
  if (!S.config) return res("rejected", "Refusé — valideur non configuré", "offline_auth");
  try {
    const tx = await api(`/api/dev/cards/${card.uid}/offline-debit`, { method: "POST", body: { device_id: S.device.id, amount: S.config.fare } });
    S.queue.push(tx);
    saveQueue();
    S.recent.push({ uid: card.uid, at: Date.now() });
    renderPills();
    return res("accepted", `Validé hors ligne — solde ${fcfa(tx.balance)}`, "offline_ok", { debited: tx.amount, source: "wallet" });
  } catch (e) {
    return res("rejected", e.status === 409 ? "Refusé — solde insuffisant" : "Refusé", "offline_balance");
  }
}

function pending() {
  const el = $("#result");
  clearTimeout(S.hide);
  el.className = "result pending";
  el.innerHTML = `<div class="big" style="background:none">${ic("nfc", 54)}</div><div class="msg" style="font-size:17px;color:var(--mu)">Lecture…</div>`;
}

const ONLINE_STEPS = [["net", "Serveur Metala"], ["auth", "Carte authentique"], ["active", "Carte active"], ["once", "Pas de double passage"], ["title", "Titre ou solde"], ["debit", "Débit enregistré"]];
const OFFLINE_STEPS = [["auth", "Carte authentique (SAM)"], ["active", "Hors liste noire"], ["once", "Pas de double passage"], ["title", "Solde sur la carte"], ["debit", "Débit signé · en attente"]];
const FAIL_AT = {
  frozen: "net", uid_only: "auth", bad_challenge: "auth", replay: "auth", challenge_expired: "auth", unknown_card: "auth", bad_proof: "auth",
  card_revoked: "active", passback: "once", no_title: "title", title_expired: "title", insufficient_balance: "title",
  offline_auth: "auth", offline_blacklist: "active", offline_passback: "once", offline_balance: "title",
};

function show(r, t0, card) {
  const ms = Math.round(performance.now() - t0);
  const el = $("#result");
  el.className = "result " + r.kind;
  const icon = { accepted: "check", already: "refresh", rejected: "x" }[r.kind];
  const tags = [];
  if (r.mode === "offline") tags.push("hors ligne");
  if (r.source === "wallet") tags.push("porte-monnaie");
  el.innerHTML = `<div class="big">${ic(icon, 48)}</div><div class="msg">${esc(r.message)}</div>
    <div class="det">${esc(card.name)}${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>
    <div class="lat">${ms} ms</div>`;
  clearTimeout(S.hide);
  S.hide = setTimeout(() => el.classList.add("hidden"), embedded ? 6000 : 3500);
  el.onclick = () => el.classList.add("hidden");

  const steps = r.mode === "offline" ? OFFLINE_STEPS : ONLINE_STEPS;
  const failAt = r.kind === "accepted" ? null : FAIL_AT[r.reason] || "auth";
  let reached = true;
  $("#checks").innerHTML = steps.map(([k, label]) => {
    let st = "skip";
    if (reached) st = k === failAt ? (r.kind === "already" ? "warn" : "ko") : "ok";
    if (k === failAt) reached = false;
    const sym = st === "ok" ? "check" : st === "ko" ? "x" : st === "warn" ? "refresh" : "";
    return `<div class="chk ${st}"><span class="s">${sym ? ic(sym, 13) : ""}</span><span>${esc(label)}</span></div>`;
  }).join("");
  $("#explain-wrap").classList.remove("hidden");

  const line = document.createElement("div");
  line.innerHTML = `<span>${new Date().toLocaleTimeString("fr-FR")}</span><span class="s-${r.kind}">${esc(r.message)}</span>`;
  $("#log").prepend(line);
  if (navigator.vibrate) navigator.vibrate(r.kind === "accepted" ? 80 : [60, 60, 60]);
  return r;
}

$("#reader").onclick = tap;
document.addEventListener("keydown", (e) => { if (e.code === "Space" && !$("#run").classList.contains("hidden")) { e.preventDefault(); tap(); } });

// Pilotage depuis la démo guidée.
window.metalaDemo = {
  ready: () => !!S.device && !$("#run").classList.contains("hidden") && !!S.config,
  select,
  setOnline,
  queued: () => S.queue.length,
  tap: async (key) => { if (key) select(key); return tap(); },
};

boot();
