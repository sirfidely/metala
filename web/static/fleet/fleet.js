import { api, fcfa, hhmm, esc, toast, store, sessionStore, params, embedded, freshnessBadge, simBadge, createMap, drawNetwork, fitLines, VehicleLayer } from "/shared/metala.js";

const $ = (s) => document.querySelector(s);
const S = {
  token: sessionStore.get("metala.fleet.token"), pr: JSON.parse(sessionStore.get("metala.fleet.pr") || "null"),
  view: "dash", network: null, map: null, layer: null, seen: new Set(), firstFeed: true,
  explain: store.get("metala.fleet.explain") === "on",
};
if (embedded) document.body.classList.add("embed");
document.body.classList.toggle("no-explain", !S.explain);

const TITLES = { dash: "Tableau de bord", vehicles: "Flotte & terminaux", validations: "Journal des montées", recon: "Recettes & rapprochement", cards: "Cartes Metala Pass" };
const INTRO = {
  dash: "Ce que le transporteur n’avait jamais : <b>sa flotte, ses montées et ses recettes en temps réel</b>, sur un seul écran. Chaque passage de carte dans un bus apparaît ici en quelques secondes.",
  vehicles: "Position et état de chaque bus et de son valideur. En cas de vol ou d’incident, l’opérateur <b>gèle le terminal à distance</b> en un clic.",
  validations: "Toutes les montées, acceptées ou refusées, avec leur motif. Les données sont <b>anonymisées</b> : l’opérateur ne voit jamais l’identité des voyageurs.",
  recon: "Chaque franc est tracé : ce que le prestataire de paiement a encaissé, les titres émis, les trajets consommés et la part de chacun <b>doivent concorder au franc près</b>. Objectif du pilote : 0 écart non expliqué.",
  cards: "Un Metala Pass perdu ou volé est <b>bloqué instantanément</b> sur tous les bus de tous les opérateurs.",
};
const DEMO_USERS = { lagune: "fleet@lagune.demo", ebene: "fleet@ebene.demo", admin: "admin@metala.demo" };

async function boot() {
  S.network = await api("/api/network");
  let inv = null;
  try {
    inv = await api("/api/dev/inventory");
    $("#demo-acc").innerHTML = `<div class="small muted">Comptes de démonstration (mot de passe <span class="mono">${esc(inv.staff_password)}</span>) :</div>` +
      inv.staff.map((u) => `<button data-u="${esc(u)}"><strong>${esc(u)}</strong><br><span class="small muted">${u.startsWith("admin") ? "Équipe Metala — tous les opérateurs" : u.includes("lagune") ? "Lagune Express (fictif) · ligne M2" : "Navettes Ébène (fictif) · ligne N1"}</span></button>`).join("");
    $("#demo-acc").querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => { $("#u").value = b.dataset.u; $("#pw").value = inv.staff_password; login(); }));
  } catch {}
  if (S.token && S.pr) {
    try { await api("/api/fleet/dashboard", { token: S.token }); return enter(); } catch { sessionStore.del("metala.fleet.token"); }
  }
  const demo = DEMO_USERS[params.get("demo")];
  if (demo && inv) { $("#u").value = demo; $("#pw").value = inv.staff_password; return login(); }
}

async function login() {
  try {
    const r = await api("/api/auth/staff", { method: "POST", body: { username: $("#u").value, password: $("#pw").value } });
    S.token = r.token; S.pr = r.principal;
    sessionStore.set("metala.fleet.token", r.token);
    sessionStore.set("metala.fleet.pr", JSON.stringify(r.principal));
    enter();
  } catch (e) { toast(e.message, "error"); }
}
$("#btn-login").onclick = login;
$("#pw").onkeydown = (e) => e.key === "Enter" && login();
$("#logout").onclick = () => { sessionStore.del("metala.fleet.token"); sessionStore.del("metala.fleet.pr"); location.href = location.pathname; };
$("#tg-explain").onclick = () => {
  S.explain = !S.explain;
  store.set("metala.fleet.explain", S.explain ? "on" : "off");
  document.body.classList.toggle("no-explain", !S.explain);
};

const opName = (id) => S.network.operators.find((o) => o.id === id)?.name || "Tous les opérateurs";
const lineById = (id) => S.network.lines.find((l) => l.id === id);
const chip = (l) => l ? `<span class="line-chip" style="background:${l.color}">${esc(l.code)}</span>` : "";
const opQuery = () => { const v = $("#op-filter").value; return v ? `?operator_id=${v}` : ""; };
const scopeOp = () => S.pr.role === "platform_admin" ? $("#op-filter").value : S.pr.operator_id;

async function enter() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").innerHTML = `<strong>${esc(S.pr.name)}</strong><br>${S.pr.role === "platform_admin" ? "Administrateur Metala" : esc(opName(S.pr.operator_id))}`;
  if (S.pr.role === "platform_admin") {
    $("#op-filter").classList.remove("hidden");
    $("#nav-cards").classList.remove("hidden");
    $("#op-filter").innerHTML = `<option value="">Tous les opérateurs</option>` + S.network.operators.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("");
    $("#op-filter").onchange = () => { rebuildMap(); refresh(); };
  }
  document.querySelectorAll("#nav button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));
  setView(params.get("view") || "dash");
  await rebuildMap();
  setInterval(refresh, 3000);
}

async function rebuildMap() {
  if (S.map) { S.map.remove(); S.map = null; }
  const op = scopeOp();
  S.map = await createMap("fleet-map", { zoom: 12, onStyle: (m, g) => drawNetwork(m, S.network, g, { operatorFilter: op }) });
  S.layer = new VehicleLayer(S.map, S.network, { onClick: () => setView("vehicles") });
  fitLines(S.map, S.network.lines.filter((l) => !op || l.operator_id === op), 40);
  refresh();
}

function setView(v) {
  S.view = v;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  for (const k of Object.keys(TITLES)) $("#v-" + k).classList.toggle("hidden", k !== v);
  $("#v-map-wrap").classList.toggle("hidden", v !== "dash");
  $("#view-title").textContent = TITLES[v];
  $("#intro").innerHTML = INTRO[v];
  if (v === "dash") setTimeout(() => S.map && S.map.resize(), 0);
  refresh();
}

let busy = false;
async function refresh() {
  if (busy || !S.token) return;
  busy = true;
  try {
    const q = opQuery();
    const vehicles = await api("/api/fleet/vehicles" + q, { token: S.token });
    S.layer && S.layer.update(vehicles);
    if (S.view === "dash") {
      const [d, vals] = await Promise.all([api("/api/fleet/dashboard" + q, { token: S.token }), api("/api/fleet/validations" + (q ? q + "&" : "?") + "limit=8", { token: S.token })]);
      renderDash(d, vehicles, vals);
    }
    if (S.view === "vehicles") renderVehicles(vehicles);
    if (S.view === "validations") renderValidations(await api("/api/fleet/validations" + (q ? q + "&" : "?") + "limit=150", { token: S.token }));
    if (S.view === "recon") renderRecon(await api("/api/fleet/reconciliation" + q, { token: S.token }));
    if (S.view === "cards") renderCards(await api("/api/dev/inventory"));
    $("#updated").textContent = "Mis à jour " + new Date().toLocaleTimeString("fr-FR");
  } catch (e) {
    if (e.status === 401) { sessionStore.del("metala.fleet.token"); location.reload(); }
  } finally { busy = false; }
}

function kpi(lbl, val, sub = "", id = "") {
  return `<div class="card kpi" ${id ? `id="${id}"` : ""}><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
}

const STATUS_ICON = { accepted: "✓", already_validated: "↺", rejected: "✕" };
function feedItem(v, isNew) {
  const l = lineById(v.line_id);
  const tags = (v.offline ? ` <span class="badge warn">hors ligne</span>` : "") + (v.source === "wallet" ? ` <span class="badge">porte-monnaie</span>` : "");
  const what = v.status === "accepted" ? (v.debited ? `Montée · ${fcfa(v.debited)}${tags}` : `Montée · forfait`)
    : v.status === "already_validated" ? "Double passage ignoré (aucun débit)" : esc(v.message.replace(/^Refusé — /, "Refus : "));
  return `<div class="feed-item ${isNew ? "new" : ""}"><span class="feed-ico ${v.status}">${STATUS_ICON[v.status]}</span>${chip(l)}
    <span>${what}<br><span class="small muted">bus ${esc(v.vehicle_id.replace("veh_", ""))} · carte ${esc(v.card_uid.slice(0, 4))}••••</span></span><span class="when">${new Date(v.at).toLocaleTimeString("fr-FR")}</span></div>`;
}

function renderDash(d, vehicles, vals) {
  const t = d.vehicles_total || 1;
  const feed = vals.map((v) => { const n = !S.firstFeed && !S.seen.has(v.id); S.seen.add(v.id); return feedItem(v, n); }).join("");
  S.firstFeed = false;
  $("#v-dash").innerHTML = `
    <div class="kpis">
      ${kpi("Bus en service", `${d.vehicles_fresh} / ${d.vehicles_total}`, "avec un GPS à jour")}
      ${kpi("Montées aujourd’hui", d.validations_today, `${d.rejections_today} refus (fraude, sans titre…)`, "kpi-val")}
      ${kpi("Ventes du jour", fcfa(d.sales_today), "titres payés par les voyageurs")}
      ${kpi("Recette transporteur", fcfa(d.revenue_today), "trajets effectués, part opérateur", "kpi-rev")}
      ${kpi("Commission Metala", fcfa(d.commission_today), "1 à 2 % selon l’accord")}
      ${kpi("Réservations", d.reservations_open, "places réservées à venir")}
    </div>
    <div class="grid2">
      <div class="card" id="feed-card">
        <div class="spread"><h3>Activité en direct</h3><span class="badge ok">● en direct</span></div>
        <div class="feed">${feed || `<p class="muted small">Aucune montée pour l’instant.</p>`}</div>
      </div>
      <div class="card">
        <h3>État de la flotte</h3>
        <div class="fbar"><i style="width:${(100 * d.vehicles_fresh) / t}%;background:#16a34a"></i><i style="width:${(100 * d.vehicles_delayed) / t}%;background:#d97706"></i><i style="width:${(100 * d.vehicles_unknown) / t}%;background:#9ca3af"></i></div>
        <div class="row small" style="flex-wrap:wrap;gap:6px">${freshnessBadge("fresh", -1)} ${d.vehicles_fresh} ${freshnessBadge("delayed", -1)} ${d.vehicles_delayed} ${freshnessBadge("unknown", -1)} ${d.vehicles_unknown}</div>
        <table class="table" style="margin-top:10px"><thead><tr><th>Ligne</th><th>Montées</th><th>Refus</th></tr></thead><tbody>
          ${d.lines.map((l) => `<tr><td>${chip(lineById(l.line_id))}</td><td><strong>${l.validations}</strong></td><td>${l.rejections}</td></tr>`).join("")}
        </tbody></table>
        <p class="small muted">${vehicles.filter((v) => v.freshness !== "fresh").length ? "Un bus sans GPS récent est signalé ici et grisé pour les voyageurs." : "Tous les bus envoient leur position."}</p>
      </div>
    </div>`;
}

function renderVehicles(vs) {
  $("#v-vehicles").innerHTML = `<div class="card scroll-x"><table class="table">
    <thead><tr><th>Bus</th><th>Ligne</th><th>Position GPS</th><th>Dernier signal</th><th>Vitesse</th><th>Valideur</th><th></th></tr></thead><tbody>
    ${vs.map((v) => `<tr>
      <td><strong class="mono">${esc(v.plate)}</strong></td>
      <td>${chip(lineById(v.line_id))}</td>
      <td>${freshnessBadge(v.freshness, v.age_seconds)} ${simBadge(v.source)}</td>
      <td>${v.last_seen ? hhmm(v.last_seen) : "—"}</td>
      <td>${v.freshness === "unknown" ? "—" : Math.round(v.speed_kmh) + " km/h"}</td>
      <td>${v.device_frozen ? `<span class="badge ko">gelé</span>` : `<span class="badge ok">actif</span>`}</td>
      <td><button class="btn small ${v.device_frozen ? "secondary" : "danger"}" data-dev="${v.device_id}" data-frozen="${v.device_frozen}">${v.device_frozen ? "Réactiver" : "Geler le valideur"}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
  $("#v-vehicles").querySelectorAll("[data-dev]").forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/fleet/devices/${b.dataset.dev}/freeze`, { method: "POST", token: S.token, body: { frozen: b.dataset.frozen !== "true" } });
      toast(b.dataset.frozen === "true" ? "Valideur réactivé" : "Valideur gelé : il ne peut plus valider", "success");
      refresh();
    } catch (e) { toast(e.message, "error"); }
  }));
}

const STATUS = { accepted: `<span class="badge ok">Validée</span>`, already_validated: `<span class="badge warn">Double passage</span>`, rejected: `<span class="badge ko">Refusée</span>` };
function renderValidations(vals) {
  $("#v-validations").innerHTML = `<div class="card scroll-x"><table class="table">
    <thead><tr><th>Heure</th><th>Ligne</th><th>Bus</th><th>Carte</th><th>Résultat</th><th>Motif</th><th>Recette</th></tr></thead><tbody>
    ${vals.map((v) => `<tr><td>${new Date(v.at).toLocaleTimeString("fr-FR")}</td><td>${chip(lineById(v.line_id))}</td><td class="mono">${esc(v.vehicle_id.replace("veh_", ""))}</td>
      <td class="mono">${esc(v.card_uid.slice(0, 4))}••••${esc(v.card_uid.slice(-2))}</td><td>${STATUS[v.status]}</td><td class="small">${esc(v.message)}${v.offline ? ` <span class="badge warn">hors ligne</span>` : ""}</td>
      <td>${v.debited ? fcfa(v.debited) : "—"}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Aucune montée.</td></tr>`}
    </tbody></table></div>`;
}

function renderRecon(r) {
  const chk = (ok, label) => `<div class="check-row"><span class="badge ${ok ? "ok" : "ko"}">${ok ? "✓" : "✕"}</span>${label}</div>`;
  $("#v-recon").innerHTML = `
    <div class="kpis">
      ${kpi("Encaissé", fcfa(r.psp_succeeded_total), `${r.psp_succeeded_count} paiements Mobile Money`)}
      ${kpi("Recette transporteur", fcfa(r.operator_revenue), "trajets effectués + forfaits")}
      ${kpi("Commission Metala", fcfa(r.metala_commission), "selon l’accord commercial")}
      ${kpi("Trajets prépayés", fcfa(r.liability_balance), "pas encore consommés")}
      ${r.operator_id === "" ? kpi("Porte-monnaie", fcfa(r.wallet_ledger), `${r.wallet_loads} recharges`) : ""}
      ${kpi("Hors ligne", `${r.offline_synced}`, r.offline_pending_count ? `${r.offline_pending_count} en attente · ${fcfa(r.offline_pending)}` : "passages synchronisés")}
    </div>
    <div class="recon">
      <div class="card"><h3>Contrôles automatiques</h3>
        ${chk(r.psp_succeeded_count === r.ledger_sales_count && r.psp_succeeded_total === r.ledger_sales_total, "Argent encaissé = ventes enregistrées")}
        ${chk(r.psp_succeeded_count === r.titles_issued + r.wallet_loads, "Chaque paiement : un titre ou une recharge")}
        ${chk(r.debiting_validations === r.ledger_usage_count, "Chaque trajet débité une seule fois")}
        ${chk(r.liability_balance === r.titles_value_remaining, "Trajets prépayés = soldes des cartes")}
        ${r.operator_id === "" ? chk(r.wallet_ledger === r.wallet_cards + r.offline_pending, "Porte-monnaie = soldes des cartes + hors ligne en attente") : ""}
        ${chk(r.ledger_sales_total === r.liability_balance + r.wallet_ledger + r.operator_revenue + r.metala_commission, "Comptabilité équilibrée")}
        <div style="margin-top:14px">${r.balanced ? `<span class="badge ok" style="font-size:15px;padding:7px 14px">Écart : 0 FCFA</span>` : `<span class="badge ko" style="font-size:14px;padding:6px 12px">${r.discrepancies.length} écart(s) : ${esc(r.discrepancies.join(" ; "))}</span>`}</div>
      </div>
      <div class="card"><h3>Détail</h3><table class="table"><tbody>
        <tr><td>Paiements confirmés par le prestataire</td><td>${r.psp_succeeded_count} · ${fcfa(r.psp_succeeded_total)}</td></tr>
        <tr><td>Ventes au grand livre</td><td>${r.ledger_sales_count} · ${fcfa(r.ledger_sales_total)}</td></tr>
        <tr><td>Titres émis</td><td>${r.titles_issued}</td></tr>
        <tr><td>Trajets débités</td><td>${r.debiting_validations} · ${fcfa(r.ledger_usage_total)}</td></tr>
        <tr><td>Solde des cartes (registre)</td><td>${fcfa(r.titles_value_remaining)}</td></tr>
      </tbody></table>
      <p class="small muted">Prototype : les forfaits mensuels sont reconnus en recette à la vente, les carnets à chaque trajet.</p></div>
    </div>`;
}

function renderCards(inv) {
  $("#v-cards").innerHTML = `<div class="card scroll-x"><table class="table">
    <thead><tr><th>Carte</th><th>Porteur</th><th>Émise le</th><th>Statut</th><th></th></tr></thead><tbody>
    ${inv.cards.filter((c) => !c.holder.startsWith("Voyageur simulé")).map((c) => `<tr><td class="mono">${esc(c.uid)}</td><td>${esc(c.holder || c.phone)}</td><td>${new Date(c.issued_at).toLocaleDateString("fr-FR")}</td>
      <td>${c.status === "active" ? `<span class="badge ok">active</span>` : `<span class="badge ko">bloquée</span>`}</td>
      <td>${c.status === "active" ? `<button class="btn small danger" data-uid="${c.uid}">Bloquer (perte, vol)</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
  $("#v-cards").querySelectorAll("[data-uid]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Bloquer la carte ${b.dataset.uid} sur tout le réseau ?`)) return;
    try { await api(`/api/admin/cards/${b.dataset.uid}/revoke`, { method: "POST", token: S.token }); toast("Carte bloquée", "success"); refresh(); }
    catch (e) { toast(e.message, "error"); }
  }));
}

// Pilotage depuis la démo guidée.
window.metalaDemo = {
  ready: () => !!S.token && !$("#app").classList.contains("hidden"),
  view: (v) => setView(v),
  highlight: async (id = "feed-card") => {
    await refresh();
    const el = document.getElementById(id);
    if (el) { el.classList.remove("hl"); void el.offsetWidth; el.classList.add("hl"); el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  },
  refresh,
};

boot().catch((e) => toast(e.message, "error"));
