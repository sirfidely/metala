import { api, fcfa, hhmm, esc, toast, store, freshnessBadge, simBadge, createMap, drawNetwork, VehicleLayer } from "/shared/metala.js";

const $ = (s) => document.querySelector(s);
const S = { token: store.get("metala.fleet.token"), pr: JSON.parse(store.get("metala.fleet.pr") || "null"), view: "dash", network: null, map: null, layer: null, timer: null };
const TITLES = { dash: "Tableau de bord", vehicles: "Flotte & terminaux", validations: "Journal des validations", recon: "Recettes & rapprochement", cards: "Cartes Metala Pass" };

async function boot() {
  S.network = await api("/api/network");
  try {
    const inv = await api("/api/dev/inventory");
    $("#demo-acc").innerHTML = `<div class="small muted">Comptes de démonstration (mot de passe <span class="mono">${esc(inv.staff_password)}</span>) :</div>` +
      inv.staff.map((u) => `<button data-u="${esc(u)}"><strong>${esc(u)}</strong><br><span class="small muted">${u.startsWith("admin") ? "Équipe Metala — tous opérateurs" : u.includes("lagune") ? "Lagune Express (fictif) · ligne M2" : "Navettes Ébène (fictif) · ligne N1"}</span></button>`).join("");
    $("#demo-acc").querySelectorAll("[data-u]").forEach((b) => (b.onclick = () => { $("#u").value = b.dataset.u; $("#pw").value = inv.staff_password; login(); }));
  } catch {}
  if (S.token && S.pr) {
    try { await api("/api/fleet/dashboard", { token: S.token }); return enter(); } catch { store.del("metala.fleet.token"); }
  }
}

async function login() {
  try {
    const r = await api("/api/auth/staff", { method: "POST", body: { username: $("#u").value, password: $("#pw").value } });
    S.token = r.token; S.pr = r.principal;
    store.set("metala.fleet.token", r.token);
    store.set("metala.fleet.pr", JSON.stringify(r.principal));
    enter();
  } catch (e) { toast(e.message, "error"); }
}
$("#btn-login").onclick = login;
$("#pw").onkeydown = (e) => e.key === "Enter" && login();
$("#logout").onclick = () => { store.del("metala.fleet.token"); store.del("metala.fleet.pr"); location.reload(); };

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
  await rebuildMap();
  refresh();
  S.timer = setInterval(refresh, 4000);
}

async function rebuildMap() {
  if (S.map) { S.map.remove(); S.map = null; }
  S.map = createMap("fleet-map", { zoom: 12 });
  await new Promise((r) => S.map.on("load", r));
  drawNetwork(S.map, S.network, { operatorFilter: scopeOp() });
  S.layer = new VehicleLayer(S.map, S.network, { onClick: () => setView("vehicles") });
}

function setView(v) {
  S.view = v;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  for (const k of Object.keys(TITLES)) $("#v-" + k).classList.toggle("hidden", k !== v);
  $("#v-map-wrap").classList.toggle("hidden", v !== "dash");
  $("#view-title").textContent = TITLES[v];
  if (v === "dash") setTimeout(() => S.map && S.map.resize(), 0);
  refresh();
}

async function refresh() {
  try {
    const q = opQuery();
    const vehicles = await api("/api/fleet/vehicles" + q, { token: S.token });
    S.layer && S.layer.update(vehicles);
    if (S.view === "dash") renderDash(await api("/api/fleet/dashboard" + q, { token: S.token }), vehicles);
    if (S.view === "vehicles") renderVehicles(vehicles);
    if (S.view === "validations") renderValidations(await api("/api/fleet/validations" + (q ? q + "&" : "?") + "limit=150", { token: S.token }));
    if (S.view === "recon") renderRecon(await api("/api/fleet/reconciliation" + q, { token: S.token }));
    if (S.view === "cards") renderCards(await api("/api/dev/inventory"));
    $("#updated").textContent = "Mis à jour " + new Date().toLocaleTimeString("fr-FR");
  } catch (e) {
    if (e.status === 401) { store.del("metala.fleet.token"); location.reload(); }
    else toast(e.message, "error");
  }
}

function kpi(lbl, val, sub = "") {
  return `<div class="card kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
}

function renderDash(d, vehicles) {
  const t = d.vehicles_total || 1;
  $("#v-dash").innerHTML = `
    <div class="kpis">
      ${kpi("Véhicules actifs", `${d.vehicles_fresh} / ${d.vehicles_total}`, "GPS frais (< 30 s)")}
      ${kpi("Validations du jour", d.validations_today, `${d.rejections_today} refus`)}
      ${kpi("Ventes du jour", fcfa(d.sales_today), "encaissées via PSP")}
      ${kpi("Recette transporteur", fcfa(d.revenue_today), "reconnue au grand livre")}
      ${kpi("Commission Metala", fcfa(d.commission_today), "selon accord")}
      ${kpi("Réservations ouvertes", d.reservations_open, "services éligibles")}
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Fraîcheur GPS de la flotte</h3>
        <div class="fbar"><i style="width:${(100 * d.vehicles_fresh) / t}%;background:#16a34a"></i><i style="width:${(100 * d.vehicles_delayed) / t}%;background:#d97706"></i><i style="width:${(100 * d.vehicles_unknown) / t}%;background:#9ca3af"></i></div>
        <div class="row small" style="flex-wrap:wrap">${freshnessBadge("fresh", -1)} ${d.vehicles_fresh} ${freshnessBadge("delayed", -1)} ${d.vehicles_delayed} ${freshnessBadge("unknown", -1)} ${d.vehicles_unknown}</div>
        <p class="small muted">Seuils : frais &lt; 30 s · retardé 30–120 s · inconnu &gt; 120 s (grisé, sans ETA voyageur).</p>
        <table class="table" style="margin-top:6px"><thead><tr><th>Véhicule</th><th>Ligne</th><th>GPS</th></tr></thead><tbody>
          ${vehicles.map((v) => `<tr><td class="mono">${esc(v.plate)}</td><td>${chip(lineById(v.line_id))}</td><td>${freshnessBadge(v.freshness, v.age_seconds)}</td></tr>`).join("")}
        </tbody></table>
      </div>
      <div class="card">
        <h3>Fréquentation du jour par ligne</h3>
        <table class="table"><thead><tr><th>Ligne</th><th>Montées validées</th><th>Refus</th></tr></thead><tbody>
          ${d.lines.map((l) => `<tr><td>${chip(lineById(l.line_id))}</td><td><strong>${l.validations}</strong></td><td>${l.rejections}</td></tr>`).join("")}
        </tbody></table>
        <p class="small muted" style="margin-top:12px">Les refus incluent cartes sans titre, titres expirés, cartes non authentifiées et rejeux.</p>
      </div>
    </div>`;
}

function renderVehicles(vs) {
  $("#v-vehicles").innerHTML = `<div class="card scroll-x"><table class="table">
    <thead><tr><th>Véhicule</th><th>Ligne</th><th>Position GPS</th><th>Dernier point</th><th>Vitesse</th><th>Places réservables</th><th>Terminal Scan</th><th></th></tr></thead><tbody>
    ${vs.map((v) => `<tr>
      <td><strong class="mono">${esc(v.plate)}</strong><div class="small muted">${esc(v.vehicle_id)}</div></td>
      <td>${chip(lineById(v.line_id))}</td>
      <td>${freshnessBadge(v.freshness, v.age_seconds)} ${simBadge(v.source)}</td>
      <td>${v.last_seen ? hhmm(v.last_seen) : "—"}</td>
      <td>${v.freshness === "unknown" ? "—" : Math.round(v.speed_kmh) + " km/h"}</td>
      <td>${v.reservable_seats}</td>
      <td class="mono">${esc(v.device_id)} ${v.device_frozen ? `<span class="badge ko">gelé</span>` : `<span class="badge ok">actif</span>`}</td>
      <td><button class="btn small ${v.device_frozen ? "secondary" : "danger"}" data-dev="${v.device_id}" data-frozen="${v.device_frozen}">${v.device_frozen ? "Dégeler" : "Geler le terminal"}</button></td>
    </tr>`).join("")}</tbody></table>
    <p class="small muted">Geler un terminal (vol, perte, incident) bloque immédiatement ses validations et sa télémétrie.</p></div>`;
  $("#v-vehicles").querySelectorAll("[data-dev]").forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/fleet/devices/${b.dataset.dev}/freeze`, { method: "POST", token: S.token, body: { frozen: b.dataset.frozen !== "true" } });
      toast(b.dataset.frozen === "true" ? "Terminal dégelé" : "Terminal gelé", "success");
      refresh();
    } catch (e) { toast(e.message, "error"); }
  }));
}

const STATUS = { accepted: `<span class="badge ok">Validé</span>`, already_validated: `<span class="badge warn">Déjà validé</span>`, rejected: `<span class="badge ko">Refusé</span>` };

function renderValidations(vals) {
  $("#v-validations").innerHTML = `<div class="card scroll-x"><table class="table">
    <thead><tr><th>Heure</th><th>Ligne</th><th>Véhicule</th><th>Carte</th><th>Résultat</th><th>Message</th><th>Valeur reconnue</th></tr></thead><tbody>
    ${vals.map((v) => `<tr><td>${new Date(v.at).toLocaleTimeString("fr-FR")}</td><td>${chip(lineById(v.line_id))}</td><td class="mono">${esc(v.vehicle_id)}</td>
      <td class="mono">${esc(v.card_uid.slice(0, 4))}••••${esc(v.card_uid.slice(-2))}</td><td>${STATUS[v.status]}</td><td class="small">${esc(v.message)}${v.reason ? ` <span class="muted">(${esc(v.reason)})</span>` : ""}</td>
      <td>${v.debited ? fcfa(v.debited) : "—"}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Aucune validation.</td></tr>`}
    </tbody></table><p class="small muted">Minimisation : l’opérateur voit un UID masqué, jamais l’identité du voyageur.</p></div>`;
}

function renderRecon(r) {
  const chk = (ok, label) => `<div class="check-row"><span class="badge ${ok ? "ok" : "ko"}">${ok ? "✓" : "✕"}</span>${label}</div>`;
  $("#v-recon").innerHTML = `
    <div class="kpis">
      ${kpi("Encaissé (PSP)", fcfa(r.psp_succeeded_total), `${r.psp_succeeded_count} paiements réussis`)}
      ${kpi("Recette transporteur", fcfa(r.operator_revenue), "titres consommés + forfaits")}
      ${kpi("Commission Metala", fcfa(r.metala_commission), "")}
      ${kpi("Titres non consommés", fcfa(r.liability_balance), "dû aux voyageurs")}
    </div>
    <div class="recon">
      <div class="card"><h3>Rapport PSP ↔ grand livre ↔ registres</h3><table class="table"><tbody>
        <tr><td>Paiements réussis (rapport PSP)</td><td>${r.psp_succeeded_count} · ${fcfa(r.psp_succeeded_total)}</td></tr>
        <tr><td>Écritures de vente (grand livre)</td><td>${r.ledger_sales_count} · ${fcfa(r.ledger_sales_total)}</td></tr>
        <tr><td>Titres émis (registre)</td><td>${r.titles_issued}</td></tr>
        <tr><td>Validations débitrices</td><td>${r.debiting_validations}</td></tr>
        <tr><td>Écritures de consommation</td><td>${r.ledger_usage_count} · ${fcfa(r.ledger_usage_total)}</td></tr>
        <tr><td>Solde titres (grand livre)</td><td>${fcfa(r.liability_balance)}</td></tr>
        <tr><td>Valeur restante (registre des titres)</td><td>${fcfa(r.titles_value_remaining)}</td></tr>
      </tbody></table></div>
      <div class="card"><h3>Contrôles</h3>
        ${chk(r.psp_succeeded_count === r.ledger_sales_count && r.psp_succeeded_total === r.ledger_sales_total, "Ventes PSP = ventes au grand livre")}
        ${chk(r.psp_succeeded_count === r.titles_issued, "1 paiement réussi = 1 titre émis (webhooks doublés neutralisés)")}
        ${chk(r.debiting_validations === r.ledger_usage_count, "1 validation débitrice = 1 écriture (zéro double débit)")}
        ${chk(r.liability_balance === r.titles_value_remaining, "Solde du grand livre = registre des titres")}
        ${chk(r.ledger_sales_total === r.liability_balance + r.operator_revenue + r.metala_commission, "Grand livre équilibré (partie double)")}
        <div style="margin-top:14px">${r.balanced ? `<span class="badge ok" style="font-size:14px;padding:6px 12px">Écart de rapprochement : 0 non expliqué</span>` : `<span class="badge ko" style="font-size:14px;padding:6px 12px">${r.discrepancies.length} écart(s) : ${esc(r.discrepancies.join(" ; "))}</span>`}</div>
        <p class="small muted" style="margin-top:12px">Simplification prototype : les forfaits mensuels sont reconnus en recette à la vente ; les carnets à chaque trajet.</p>
      </div>
    </div>`;
}

function renderCards(inv) {
  $("#v-cards").innerHTML = `<div class="card scroll-x"><table class="table">
    <thead><tr><th>UID</th><th>Porteur</th><th>Émise le</th><th>Statut</th><th></th></tr></thead><tbody>
    ${inv.cards.map((c) => `<tr><td class="mono">${esc(c.uid)}</td><td>${esc(c.holder || c.phone)}</td><td>${new Date(c.issued_at).toLocaleString("fr-FR")}</td>
      <td>${c.status === "active" ? `<span class="badge ok">active</span>` : `<span class="badge ko">révoquée</span>`}</td>
      <td>${c.status === "active" ? `<button class="btn small danger" data-uid="${c.uid}">Révoquer</button>` : ""}</td></tr>`).join("")}
    </tbody></table><p class="small muted">Révocation immédiate d’un Pass perdu, volé ou compromis : toute présentation ultérieure est refusée par le serveur.</p></div>`;
  $("#v-cards").querySelectorAll("[data-uid]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Révoquer la carte ${b.dataset.uid} ?`)) return;
    try { await api(`/api/admin/cards/${b.dataset.uid}/revoke`, { method: "POST", token: S.token }); toast("Carte révoquée", "success"); refresh(); }
    catch (e) { toast(e.message, "error"); }
  }));
}

boot().catch((e) => toast(e.message, "error"));
