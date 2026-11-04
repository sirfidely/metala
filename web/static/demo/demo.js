import { api, until, toast } from "/shared/metala.js";

const $ = (s) => document.querySelector(s);
const URLS = {
  app: "/app/?demo=awa&embed=1",
  scan: "/scan/?device=dev_101&embed=1",
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
    title: "Awa ouvre Metala",
    text: "Avant de sortir, Awa voit son solde de trajets et les prochains bus à son arrêt de Yopougon, avec l’heure d’arrivée estimée.",
    why: "<b>Pour le voyageur :</b> fini l’attente à l’aveugle au bord de la route.",
    focus: ["app"],
    run: async () => (await hook("app")).home(),
  },
  {
    title: "Elle cherche son trajet vers le Plateau",
    text: "Départ, destination : Metala propose la ligne, l’heure de départ, la durée du trajet et le prix, quel que soit l’opérateur.",
    why: "<b>Une seule application</b> pour toutes les lignes équipées : c’est la fédération des opérateurs.",
    focus: ["app"],
    run: async () => (await hook("app")).search(),
  },
  {
    title: "Elle voit son bus arriver, en direct",
    text: "Chaque bus est placé sur la carte à partir de sa position GPS, mise à jour toutes les 5 secondes. Si le GPS est trop ancien, le bus est grisé.",
    why: "<b>Information fiable :</b> jamais d’heure inventée, la fraîcheur du GPS est toujours affichée.",
    focus: ["app"],
    run: async () => (await hook("app")).map(),
  },
  {
    title: "Elle monte et présente sa carte",
    text: "Awa pose son Metala Pass sur le valideur. Le serveur vérifie que la carte est authentique, trouve son carnet et débite un trajet.",
    why: "<b>Sans monnaie ni smartphone :</b> la carte suffit, réponse en moins d’une seconde.",
    focus: ["scan", "app"],
    run: async () => {
      const scan = await hook("scan");
      await scan.tap("awa");
      await wait(600);
      await (await hook("app")).flashPass();
    },
  },
  {
    title: "Le transporteur le voit instantanément",
    text: "La montée d’Awa apparaît dans le tableau de bord de l’opérateur, avec la recette correspondante, au milieu de l’activité de toute la flotte.",
    why: "<b>Pour le transporteur :</b> pour la première fois, ses montées et ses recettes en temps réel.",
    focus: ["fleet"],
    run: async () => { const f = await hook("fleet"); f.view("dash"); await wait(300); await f.highlight("feed-card"); },
  },
  {
    title: "Une carte copiée ? Refusée.",
    text: "Un fraudeur a copié le numéro de la carte d’Awa. Mais à chaque passage, la carte doit répondre à un défi cryptographique que seule la vraie puce sait résoudre.",
    why: "<b>Anti-fraude :</b> copier une carte ne sert à rien, et le transporteur voit la tentative.",
    focus: ["scan"],
    run: async () => (await hook("scan")).tap("clone"),
  },
  {
    title: "Plus de réseau ? Le porte-monnaie prend le relais",
    text: "La 4G coupe dans le bus. Le valideur continue seul : il vérifie la carte, puis débite le porte-monnaie stocké sur la puce, rechargé à l’avance par Awa. La carte signe la transaction.",
    why: "<b>Paiement hors ligne :</b> on ne peut dépenser que le solde prépayé, donc aucune fraude par double dépense.",
    focus: ["scan"],
    run: async () => { const s = await hook("scan"); await s.setOnline(false); await wait(400); await s.tap("awa"); },
  },
  {
    title: "Le réseau revient : tout est synchronisé",
    text: "Dès que la 4G revient, le valideur envoie les passages hors ligne. Le serveur vérifie chaque signature de carte et enregistre la recette du transporteur.",
    why: "<b>Rien n’est perdu :</b> chaque passage hors ligne est vérifié et payé au transporteur.",
    focus: ["scan", "fleet", "app"],
    run: async () => {
      const s = await hook("scan"); await s.setOnline(true);
      const f = await hook("fleet"); f.view("dash"); await wait(600); await f.highlight("feed-card");
      await (await hook("app")).flashPass();
    },
  },
  {
    title: "Awa recharge son porte-monnaie",
    text: "Depuis son téléphone, Awa recharge 2 000 FCFA en Mobile Money. Le solde est disponible sur sa carte, utilisable dans tous les bus, même sans réseau.",
    why: "<b>Paiements :</b> GeniusPay vers des prestataires habilités ; Metala ne garde pas l’argent des voyageurs.",
    focus: ["app"],
    run: async () => (await hook("app")).buy("prd_wallet_2000"),
  },
  {
    title: "Chaque franc est rapproché",
    text: "Argent encaissé, titres émis, trajets débités, part du transporteur et commission : tout est contrôlé automatiquement et doit concorder au franc près.",
    why: "<b>Confiance :</b> c’est la condition pour passer à une exploitation payante.",
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
