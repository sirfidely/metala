// Mesure d'usage (PostHog). La clé de projet est publique par conception :
// elle permet seulement d'envoyer des événements, pas de lire les données.
// Aucune donnée personnelle n'est envoyée : ni numéro de téléphone, ni nom,
// ni e-mail ; les textes de l'interface sont masqués dans les clics capturés.
const KEY = "phc_nzrf34gYyHZyhaXXbRthReqrgias4pFTSpevjm2sXQFM";
const HOST = "https://us.i.posthog.com"; // projet hébergé en Europe : https://eu.i.posthog.com

const ph = () => window.posthog;
let ready = false;

export function initAnalytics(app) {
  if (ready || !ph()) return;
  try {
    ph().init(KEY, {
      api_host: HOST,
      person_profiles: "identified_only",
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
      disable_surveys: true,
    });
    ph().register({ app });
    ready = true;
  } catch { /* la mesure ne doit jamais bloquer l'application */ }
}

export function track(event, props = {}) {
  if (!ready) return;
  try { ph().capture(event, props); } catch { /* ignoré */ }
}

// Écran affiché dans une application à une seule page.
export const screen = (name) => track("ecran_vu", { ecran: name });

// Rattache les événements à un identifiant interne (jamais le téléphone ni l'e-mail).
export function identify(id, props = {}) {
  if (!ready || !id) return;
  try { ph().identify(id, props); } catch { /* ignoré */ }
}

export function resetAnalytics() {
  if (!ready) return;
  try { ph().reset(); } catch { /* ignoré */ }
}
