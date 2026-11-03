import { api, esc, store, toast } from "/shared/metala.js";

const $ = (s) => document.querySelector(s);
const S = { token: store.get("metala.scan.token"), device: null, cards: [], selected: null, lastTap: null, busy: false };

// Cartes spéciales de démonstration (fraude / support inconnu).
const CLONE = { uid: "04A1B2C3D4E5F6", holder: "Carte clonée (UID seul)", special: "clone" };
const UNKNOWN = { uid: "04FFFFFFFFFF01", holder: "Carte inconnue", special: "unknown" };

async function loadInventory() {
  try { return await api("/api/dev/inventory"); }
  catch { toast("Simulateur indisponible (mode production ?)", "error"); return { devices: [], cards: [] }; }
}

async function boot() {
  const inv = await loadInventory();
  S.inv = inv;
  const saved = store.get("metala.scan.device");
  if (S.token && saved) {
    const d = inv.devices.find((x) => x.id === saved);
    if (d) { S.device = d; return start(); }
  }
  showSetup();
}

function showSetup() {
  $("#setup").classList.remove("hidden");
  $("#run").classList.add("hidden");
  $("#devices").innerHTML = S.inv.devices.map((d) => `
    <button class="dev-btn" data-id="${d.id}">
      <span class="line-chip" style="background:${d.operator_id === "op_lagune" ? "#0E7C66" : "#C2410C"}">${esc(d.line_code)}</span>
      <span><strong>${esc(d.plate)}</strong><br><small class="sub">${esc(d.vehicle_id)} · terminal ${esc(d.id)}${d.frozen ? " · <b style='color:#fca5a5'>GELÉ</b>" : ""}</small></span>
    </button>`).join("");
  $("#devices").querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => enroll(S.inv.devices.find((d) => d.id === b.dataset.id))));
}

async function enroll(d) {
  try {
    const r = await api("/api/auth/device", { method: "POST", body: { device_id: d.id, secret: d.secret } });
    S.token = r.token;
    S.device = d;
    store.set("metala.scan.token", r.token);
    store.set("metala.scan.device", d.id);
    start();
  } catch (e) { toast(e.message, "error"); }
}

function start() {
  $("#setup").classList.add("hidden");
  $("#run").classList.remove("hidden");
  $("#t-line").textContent = `LIGNE ${S.device.line_code}`;
  $("#t-veh").textContent = `${S.device.plate} · ${S.device.vehicle_id}`;
  $("#p-dev").textContent = S.device.id;
  const named = S.inv.cards.filter((c) => !c.holder.startsWith("Voyageur simulé"));
  S.cards = [...named, CLONE, UNKNOWN];
  S.selected = S.cards[0];
  renderCards();
}

function renderCards() {
  $("#cards").innerHTML = S.cards.map((c, i) => `
    <button class="vcard ${c === S.selected ? "sel" : ""} ${c.special ? "bad" : ""}" data-i="${i}">
      ${esc(c.holder.replace(/\s*\(.*\)/, ""))}${c.status === "revoked" ? " ⛔" : ""}
      <small>${c.special === "clone" ? "UID copié, sans clé" : esc(c.uid)}</small>
    </button>`).join("");
  $("#cards").querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { S.selected = S.cards[+b.dataset.i]; renderCards(); }));
}

$("#change").onclick = async () => { S.inv = await loadInventory(); showSetup(); };
$("#offline").onchange = () => {
  const off = $("#offline").checked;
  $("#p-net").textContent = off ? "Hors réseau" : "4G · en ligne";
  $("#p-net").className = "pill " + (off ? "off" : "on");
};

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());

// Une présentation de carte : challenge serveur → réponse de la puce → décision serveur.
async function tapCard() {
  if (S.busy) return;
  S.busy = true;
  const card = S.selected;
  const t0 = performance.now();
  try {
    if ($("#offline").checked) {
      // Le terminal ne joint pas le serveur : refus explicite, jamais de faux succès.
      await new Promise((r) => setTimeout(r, 400));
      return show({ status: "rejected", message: "Refusé — réseau indisponible", detail: "Aucune validation hors ligne dans le MVP. Réessayez ou payez autrement." }, t0, card);
    }
    let req;
    if ($("#retry").checked && S.lastTap) {
      req = S.lastTap; // même tap_id, même challenge
    } else {
      const { challenge } = await api("/api/scan/challenge", { method: "POST", token: S.token, timeout: 2500 });
      let proof = "";
      if (card.special !== "clone") {
        // La puce calcule la preuve dynamique (simulée côté serveur de démo).
        try { proof = (await api(`/api/dev/cards/${card.uid}/respond`, { method: "POST", body: { challenge } })).proof; }
        catch { proof = "00"; }
      }
      req = { tap_id: uuid(), card_uid: card.uid, challenge, proof };
    }
    S.lastTap = req;
    const v = await api("/api/scan/validate", { method: "POST", token: S.token, body: req, timeout: 2500 });
    const details = [];
    if (v.title_name) details.push(v.title_name);
    if (v.reason) details.push(`motif : ${v.reason}`);
    show({ status: v.status === "already_validated" ? "already" : v.status, message: v.message, detail: details.join(" · "), id: v.id }, t0, card);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      show({ status: "rejected", message: "Terminal non autorisé", detail: e.message }, t0, card);
    } else {
      show({ status: "rejected", message: "Refusé — réseau indisponible", detail: e.message }, t0, card);
    }
  } finally {
    S.busy = false;
  }
}

function show(r, t0, card) {
  const ms = Math.round(performance.now() - t0);
  const icon = { accepted: "✓", already: "↺", rejected: "✕" }[r.status] || "✕";
  const el = $("#result");
  el.className = "result " + r.status;
  el.innerHTML = `<div class="big">${icon}</div><div class="msg">${esc(r.message)}</div>
    <div class="det">${esc(r.detail || "")}</div><div class="lat">décision en ${ms} ms · cible ≤ 1 000 ms (NF-02)${r.id ? " · " + esc(r.id) : ""}</div>`;
  const line = document.createElement("div");
  line.innerHTML = `<span>${new Date().toLocaleTimeString("fr-FR")}</span><span class="s-${r.status === "already" ? "already_validated" : r.status}">${esc(r.message)}</span><span style="color:#6b7280">${esc(card.holder.replace(/\s*\(.*\)/, ""))} · ${ms} ms</span>`;
  $("#log").prepend(line);
  clearTimeout(S.hide);
  S.hide = setTimeout(() => el.classList.add("hidden"), 3200);
  el.onclick = () => el.classList.add("hidden");
  if (navigator.vibrate) navigator.vibrate(r.status === "accepted" ? 80 : [60, 60, 60]);
}

$("#reader").onclick = tapCard;
document.addEventListener("keydown", (e) => { if (e.code === "Space" && !$("#run").classList.contains("hidden")) { e.preventDefault(); tapCard(); } });

boot();
