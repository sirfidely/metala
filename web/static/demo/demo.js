import { api, until, toast } from "/shared/metala.js";

const $ = (s) => document.querySelector(s);
const URLS = {
  app: "/app/?demo=awa&embed=1",
  scan: "/scan/?driver=drv_kone&vehicle=veh_101&embed=1",
  fleet: "/fleet/?demo=lagune&embed=1",
};
const frame = (k) => $("#f-" + k);
const hook = (k) => until(() => {
  const w = frame(k).contentWindow;
  return w && w.metalaDemo && w.metalaDemo.ready() ? w.metalaDemo : null;
}, 15000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Étapes de la démonstration : focus = écrans mis en avant.
const STEPS = [
  {
    title: "Awa sait quand partir de chez elle",
    text: "Dès l’ouverture, Metala calcule son trajet Maison → Travail avec les vrais horaires et la position des véhicules : « Partez à … ».",
    why: "<b>Le problème résolu :</b> savoir quel véhicule passe, et à quelle heure, près de chez soi.",
    focus: ["app"],
    run: async () => (await hook("app")).home(),
  },
  {
    title: "Elle prépare son trajet de demain matin",
    text: "Départ de sa maison, pas d’un arrêt : Metala ajoute la marche, choisit la ligne, et donne l’heure à laquelle partir pour arriver avant 8 h.",
    why: "<b>Porte-à-porte :</b> d’un lieu à un autre, à la date et à l’heure voulues.",
    focus: ["app"],
    run: async () => (await hook("app")).plan(),
  },
  {
    title: "Toutes les lignes, tous les modes",
    text: "Bus, navette, bateau-bus, gbaka, woro-woro : chaque ligne montre son tracé, ses arrêts, ses horaires et ses véhicules en service.",
    why: "<b>Un seul réseau :</b> entreprises publiques, compagnies privées et transport artisanal sur le même socle.",
    focus: ["app"],
    run: async () => (await hook("app")).line(),
  },
  {
    title: "Elle paie avec son téléphone",
    text: "Awa présente le QR code de son Metala Pass au valideur du chauffeur. Le code change toutes les minutes et ne sert qu’une fois.",
    why: "<b>Paiement fluide :</b> ni monnaie ni ticket, et le chauffeur voit sa recette monter.",
    focus: ["app", "scan"],
    run: async () => { (await hook("app")).pass("phone"); await wait(1500); await (await hook("scan")).tap("awa-phone"); },
  },
  {
    title: "Le propriétaire de la flotte le voit en direct",
    text: "Chaque paiement apparaît dans Metala Fleet : véhicule, recette, part de chacun. Le propriétaire suit ses chauffeurs et ses véhicules.",
    why: "<b>Pour le transporteur :</b> une recette tracée, sans fuite d’argent liquide.",
    focus: ["fleet"],
    run: async () => { const f = await hook("fleet"); f.view("dash"); await wait(300); await f.highlight("feed-card"); },
  },
  {
    title: "Une carte copiée ? Refusée.",
    text: "Copier le numéro d’une carte ne suffit pas : à chaque passage, la puce doit répondre à un défi cryptographique.",
    why: "<b>Anti-fraude :</b> la carte ne peut pas être clonée.",
    focus: ["scan"],
    run: async () => (await hook("scan")).tap("clone"),
  },
  {
    title: "Pas de réseau ? La carte paie quand même",
    text: "La 4G coupe. Le valideur débite le porte-monnaie stocké sur la puce du Metala Pass, rechargé à l’avance, et garde la transaction signée.",
    why: "<b>Hors ligne :</b> on ne peut dépenser que le solde prépayé ; aucune double dépense.",
    focus: ["scan"],
    run: async () => { const s = await hook("scan"); await s.setOnline(false); await wait(400); await s.tap("awa"); },
  },
  {
    title: "Le réseau revient : tout est transmis",
    text: "Le valideur envoie les paiements hors ligne ; le serveur vérifie la signature de chaque carte et crédite le transporteur.",
    why: "<b>Rien n’est perdu :</b> chaque passage est vérifié et payé.",
    focus: ["scan", "fleet"],
    run: async () => { const s = await hook("scan"); await s.setOnline(true); const f = await hook("fleet"); f.view("dash"); await wait(600); await f.highlight("feed-card"); },
  },
  {
    title: "Awa maîtrise son budget transport",
    text: "Dépenses du mois, projection de fin de mois, répartition par mode… et un conseil quand un carnet ou un forfait lui ferait économiser.",
    why: "<b>Pour le voyageur :</b> le transport devient un budget qu’on pilote.",
    focus: ["app"],
    run: async () => (await hook("app")).budget(),
  },
  {
    title: "Elle recharge en Mobile Money",
    text: "Deux touches : le porte-monnaie de son Pass est crédité, utilisable dans le bus, le gbaka, le bateau, le woro-woro ou le taxi compteur.",
    why: "<b>Un seul moyen de paiement</b> pour toute la mobilité du Grand Abidjan.",
    focus: ["app"],
    run: async () => (await hook("app")).buy("prd_wallet_2000"),
  },
  {
    title: "Chaque franc est rapproché",
    text: "Argent encaissé, titres, trajets, porte-monnaie, part du transporteur et commission : tout est contrôlé automatiquement.",
    why: "<b>Confiance :</b> c’est la condition d’une exploitation payante à grande échelle.",
    focus: ["fleet"],
    run: async () => { const f = await hook("fleet"); f.view("recon"); await wait(400); await f.highlight("v-recon"); },
  },
];

let cur = -1;
let running = 0;
let narrowPane = "app";

function loadFrames() {
  try { sessionStorage.clear(); } catch {}
  for (const k of Object.keys(URLS)) frame(k).src = URLS[k];
}

function renderDots() {
  $("#dots").innerHTML = STEPS.map((_, i) => `<button class="${i === cur ? "on" : i < cur ? "done" : ""}" data-i="${i}">${i + 1}</button>`).join("");
  $("#dots").querySelectorAll("button").forEach((b) => (b.onclick = () => goto(+b.dataset.i)));
}

function showPane(p) {
  narrowPane = p;
  document.querySelectorAll(".pane").forEach((el) => el.classList.toggle("show", el.dataset.p === p));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
}
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => showPane(b.dataset.p)));

async function goto(i) {
  if (i < 0) return;
  if (i >= STEPS.length) { $("#outro").classList.remove("hidden"); return; }
  cur = i;
  const s = STEPS[i];
  $("#n-num").textContent = i + 1;
  $("#n-title").textContent = s.title;
  $("#n-text").textContent = s.text;
  $("#n-why").innerHTML = s.why;
  $("#prev").disabled = i === 0;
  $("#next").textContent = i === STEPS.length - 1 ? "Conclusion →" : "Suivant →";
  document.querySelectorAll(".pane").forEach((el) => {
    el.classList.toggle("focus", s.focus.includes(el.dataset.p));
    el.classList.toggle("dim", !s.focus.includes(el.dataset.p));
  });
  showPane(s.focus[0]);
  renderDots();
  run();
}

async function run() {
  const id = ++running;
  const s = STEPS[cur];
  $("#replay").disabled = true;
  try { await s.run(); }
  catch (e) { if (id === running) toast("Action impossible : " + e.message, "error"); }
  finally { if (id === running) $("#replay").disabled = false; }
}

async function restart() {
  $("#outro").classList.add("hidden");
  $("#intro").classList.add("hidden");
  try { await api("/api/dev/reset", { method: "POST" }); }
  catch { toast("Réinitialisation impossible (mode démo désactivé ?)", "error"); }
  loadFrames();
  await Promise.all([hook("app"), hook("scan"), hook("fleet")]);
  goto(0);
}

$("#go").onclick = restart;
$("#restart").onclick = restart;
$("#again").onclick = restart;
$("#close-outro").onclick = () => $("#outro").classList.add("hidden");
$("#next").onclick = () => goto(cur + 1);
$("#prev").onclick = () => goto(cur - 1);
$("#replay").onclick = run;
document.addEventListener("keydown", (e) => {
  if (!$("#intro").classList.contains("hidden")) { if (e.key === "Enter") restart(); return; }
  if (e.key === "ArrowRight" || e.key === "PageDown") goto(cur + 1);
  if (e.key === "ArrowLeft" || e.key === "PageUp") goto(cur - 1);
  if (e.key.toLowerCase() === "r") run();
});

loadFrames();
showPane(narrowPane);
