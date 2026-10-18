// Jans Holzstube – Werkstatt: Planen, Einkauf, Baupläne, Produkte, Material, Einstellungen.
import {
  euro, materialMap, teilAnzahl, teilMasse, stueckliste, einkaufsliste, kostenVariante,
  zeichnungSVG, zuschnittSVG, einkaufCSV, einkaufText, findeVariante, winkelText, winkelHtml,
} from "./bauplan.js";
import { GitHub } from "./github.js";

// ======================================================================
// Zustand
// ======================================================================
const lies = (id) => JSON.parse(document.getElementById(id).textContent);
const DATEIEN = {
  produkte: "src/_data/produkte.json",
  material: "src/_data/material.json",
  site: "src/_data/site.json",
  bauliste: "src/_data/bauliste.json",
};
const S = {
  produkte: lies("d-produkte"),
  material: lies("d-material"),
  site: lies("d-site"),
  bauliste: lies("d-bauliste"),
  original: {},            // Text beim Laden (für Konflikt-Prüfung)
  geaendert: new Set(),
  fotos: {},               // pfad -> { base64, dataUrl }
  tab: "planen",
  produktId: null,
  varianteIdx: 0,
  bauplan: { produkt: null, variante: null },
};
if (!Array.isArray(S.bauliste.auftraege)) S.bauliste.auftraege = [];
for (const k of Object.keys(DATEIEN)) S.original[k] = JSON.stringify(S[k]);

const ENTWURF = "holzstube-entwurf";
const GH_KEY = "holzstube-github";
const speicher = {
  lies(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  schreib(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* voll oder gesperrt */ } },
  weg(k) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};
const ghEinstellungen = () => speicher.lies(GH_KEY) || { owner: "", repo: "", branch: "main", token: "" };
const gh = () => new GitHub(ghEinstellungen());
let M = materialMap(S.material);

// ======================================================================
// Helfer
// ======================================================================
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const zahl = (v) => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const slug = (s) => String(s).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "produkt";
const kopie = (o) => JSON.parse(JSON.stringify(o));
const fotoUrl = (pfad) => (S.fotos[pfad] ? S.fotos[pfad].dataUrl : pfad);

function melde(text, fehler = false) {
  const el = $("#meldung");
  el.textContent = text;
  el.classList.toggle("fehler", fehler);
  el.classList.add("zeigen");
  clearTimeout(melde.t);
  melde.t = setTimeout(() => el.classList.remove("zeigen"), fehler ? 7000 : 3200);
}

function geaendert(datei) {
  S.geaendert.add(datei);
  if (datei === "material") M = materialMap(S.material);
  speicher.schreib(ENTWURF, {
    zeit: Date.now(), geaendert: [...S.geaendert],
    produkte: S.produkte, material: S.material, site: S.site, bauliste: S.bauliste,
  });
  statusZeigen();
}

function statusZeigen() {
  const n = S.geaendert.size + Object.keys(S.fotos).length;
  $("#status").classList.toggle("offen", n > 0);
  $("#status-text").textContent = n ? `${n} ungespeicherte Änderung${n > 1 ? "en" : ""}` : "Alles gespeichert";
}

function setzePfad(obj, pfad, wert) {
  const teile = pfad.split(".");
  let o = obj;
  for (let i = 0; i < teile.length - 1; i++) {
    const k = teile[i];
    if (o[k] === undefined) o[k] = /^\d+$/.test(teile[i + 1]) ? [] : {};
    o = o[k];
  }
  o[teile[teile.length - 1]] = wert;
}
function holePfad(obj, pfad) {
  return pfad.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Eingabefelder mit data-pfad an ein Objekt binden
function binde(container, obj, datei, nachher) {
  container.addEventListener("input", (e) => {
    const el = e.target.closest("[data-pfad]");
    if (!el || !container.contains(el)) return;
    let wert;
    if (el.type === "checkbox") wert = el.checked;
    else if (el.dataset.typ === "zahl") wert = zahl(el.value);
    else if (el.dataset.typ === "zeilen") wert = el.value.split("\n").map((z) => z.trim()).filter(Boolean);
    else if (el.dataset.typ === "json") {
      try { wert = el.value.trim() ? JSON.parse(el.value) : undefined; el.setCustomValidity(""); }
      catch { el.setCustomValidity("Kein gültiges JSON"); el.reportValidity(); return; }
    } else wert = el.value;
    setzePfad(typeof obj === "function" ? obj() : obj, el.dataset.pfad, wert);
    geaendert(datei);
    if (nachher) nachher(el);
  });
}

function herunterladen(name, inhalt, typ = "text/plain") {
  const blob = new Blob([inhalt], { type: typ });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// 3D-Ansicht nur bei Bedarf laden
let viewerModul = null;
async function neuerViewer(container) {
  try {
    viewerModul ||= await import("./modell3d.js");
    return viewerModul.erstelleViewer(container, { drehen: false });
  } catch (e) {
    console.error(e);
    container.innerHTML = `<div class="lade">3D konnte nicht geladen werden (Internet?).</div>`;
    return null;
  }
}
let aktiverViewer = null;
function viewerWeg() { if (aktiverViewer) { aktiverViewer.dispose(); aktiverViewer = null; } }

// ======================================================================
// Login
// ======================================================================
function login() {
  const ok = sessionStorage.getItem("holzstube-login") === "1";
  if (ok) return start();
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = S.site.werkstatt || { benutzer: "Jan", passwort: "1234" };
    const name = $("#l-name").value.trim().toLowerCase(), pw = $("#l-pw").value;
    if (name === String(w.benutzer).toLowerCase() && pw === String(w.passwort)) {
      try { sessionStorage.setItem("holzstube-login", "1"); } catch { /* egal */ }
      start();
    } else $("#login-fehler").classList.remove("versteckt");
  });
}

async function start() {
  $("#login").classList.add("versteckt");
  $("#app").classList.remove("versteckt");
  $$(".ws-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => zeigeTab(b.dataset.tab)));
  $("#speichern").addEventListener("click", speichern);
  window.addEventListener("beforeunload", (e) => {
    if (S.geaendert.size || Object.keys(S.fotos).length) { e.preventDefault(); e.returnValue = ""; }
  });

  // Entwurf wiederherstellen
  const entwurf = speicher.lies(ENTWURF);
  if (entwurf && entwurf.geaendert && entwurf.geaendert.length) {
    for (const k of entwurf.geaendert) if (entwurf[k]) S[k] = entwurf[k];
    entwurf.geaendert.forEach((k) => S.geaendert.add(k));
    M = materialMap(S.material);
    melde(`Ungespeicherte Änderungen von ${new Date(entwurf.zeit).toLocaleString("de-DE")} wiederhergestellt.`);
  } else if (gh().bereit) {
    await vonGitHubLaden(true);
  }
  statusZeigen();
  zeigeTab(location.hash.slice(1) || "planen");
}

async function vonGitHubLaden(leise) {
  try {
    const g = gh();
    for (const [k, pfad] of Object.entries(DATEIEN)) {
      try {
        const { text } = await g.ladeText(pfad);
        S[k] = JSON.parse(text);
        S.original[k] = JSON.stringify(S[k]);
      } catch (e) { if (e.status !== 404) throw e; }
    }
    if (!Array.isArray(S.bauliste.auftraege)) S.bauliste.auftraege = [];
    M = materialMap(S.material);
    if (!leise) melde("Aktueller Stand von GitHub geladen.");
  } catch (e) {
    melde(`Laden von GitHub fehlgeschlagen: ${e.message}`, true);
  }
}

// ======================================================================
// Speichern
// ======================================================================
async function speichern() {
  const n = S.geaendert.size + Object.keys(S.fotos).length;
  if (!n) return melde("Es gibt nichts zu speichern.");
  const g = gh();
  if (!g.bereit) {
    zeigeTab("einstellungen");
    return melde("Bitte zuerst GitHub in den Einstellungen verbinden. Alternativ: Dateien unten herunterladen.", true);
  }
  const knopf = $("#speichern");
  knopf.disabled = true;
  knopf.textContent = "Speichere …";
  try {
    // Prüfen, ob jemand die Dateien inzwischen direkt auf GitHub geändert hat
    const konflikte = [];
    for (const k of S.geaendert) {
      try {
        const { text } = await g.ladeText(DATEIEN[k]);
        if (JSON.stringify(JSON.parse(text)) !== S.original[k]) konflikte.push(DATEIEN[k]);
      } catch (e) { if (e.status !== 404) throw e; }
    }
    if (konflikte.length && !confirm(`Diese Dateien wurden zwischendurch auf GitHub geändert:\n${konflikte.join("\n")}\n\nTrotzdem mit deinem Stand überschreiben?`)) {
      throw new Error("Abgebrochen – lade in den Einstellungen den aktuellen Stand von GitHub.");
    }
    const dateien = [];
    for (const k of S.geaendert) dateien.push({ pfad: DATEIEN[k], text: JSON.stringify(S[k], null, 1) + "\n" });
    for (const [pfad, f] of Object.entries(S.fotos)) dateien.push({ pfad: `src/${pfad}`, base64: f.base64 });
    const was = [...S.geaendert].concat(Object.keys(S.fotos).length ? ["Fotos"] : []).join(", ");
    await g.commit(dateien, `Werkstatt: ${was} aktualisiert`);
    for (const k of S.geaendert) S.original[k] = JSON.stringify(S[k]);
    S.geaendert.clear();
    S.fotos = {};
    speicher.weg(ENTWURF);
    statusZeigen();
    melde("Gespeichert! Die Seite ist in ca. 1–2 Minuten aktualisiert.");
  } catch (e) {
    melde(`Speichern fehlgeschlagen: ${e.message}`, true);
  } finally {
    knopf.disabled = false;
    knopf.textContent = "Speichern";
  }
}

// ======================================================================
// Tabs
// ======================================================================
const TABS = { planen: tabPlanen, einkauf: tabEinkauf, bauplan: tabBauplan, produkte: tabProdukte, material: tabMaterial, einstellungen: tabEinstellungen };
function zeigeTab(name) {
  if (!TABS[name]) name = "planen";
  viewerWeg();
  S.tab = name;
  history.replaceState(null, "", `#${name}`);
  $$(".ws-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  // frisches Element, damit keine alten Event-Listener hängen bleiben
  const alt = $("#inhalt");
  const el = alt.cloneNode(false);
  alt.replaceWith(el);
  TABS[name](el);
  window.scrollTo(0, 0);
}

// ======================================================================
// Planen
// ======================================================================
function anzahl(pid, vid, licht) {
  const a = S.bauliste.auftraege.find((x) => x.produkt === pid && x.variante === vid && !!x.licht === licht);
  return a ? a.anzahl : 0;
}
function setzeAnzahl(pid, vid, licht, n) {
  n = Math.max(0, Math.round(n) || 0);
  const liste = S.bauliste.auftraege;
  const i = liste.findIndex((x) => x.produkt === pid && x.variante === vid && !!x.licht === licht);
  if (i >= 0) { if (n) liste[i].anzahl = n; else liste.splice(i, 1); }
  else if (n) liste.push({ produkt: pid, variante: vid, licht, anzahl: n });
  geaendert("bauliste");
}

function zaehler(pid, vid, licht) {
  return `<span class="zaehler" data-z="${esc(pid)}|${esc(vid)}|${licht ? 1 : 0}">
    <button type="button" data-schritt="-1" aria-label="weniger">−</button>
    <input type="number" inputmode="numeric" min="0" value="${anzahl(pid, vid, licht)}" aria-label="Anzahl">
    <button type="button" data-schritt="1" aria-label="mehr">+</button></span>`;
}

function tabPlanen(el) {
  const zeilen = S.produkte.map((p) => {
    const rows = p.varianten.map((v) => {
      const k0 = kostenVariante(v, S.material, false), k1 = kostenVariante(v, S.material, true);
      const hatLicht = v.licht && v.licht.length;
      return `<tr>
        <td>${esc(v.name)}<div class="leise" style="font-size:13px">${esc(v.masse || "")}</div></td>
        <td>${zaehler(p.id, v.id, false)}<div class="leise" style="font-size:12.5px;margin-top:3px">${v.preis.ohne} € · Mat. ${euro(k0.material)}</div></td>
        <td>${hatLicht ? `${zaehler(p.id, v.id, true)}<div class="leise" style="font-size:12.5px;margin-top:3px">${v.preis.mit} € · Mat. ${euro(k1.material)}</div>` : `<span class="leise">–</span>`}</td>
      </tr>`;
    }).join("");
    return `<tr class="produkt-zeile"><td colspan="3">${esc(p.name)}${p.sichtbar ? "" : ` <span class="leise" style="font-size:13px;font-family:var(--schrift-text)">(nicht auf der Seite)</span>`}</td></tr>${rows}`;
  }).join("");
  el.innerHTML = `
    <div class="ws-leiste"><h2 style="margin:0">Was baue ich?</h2><span class="abstand"></span>
      <button class="knopf knopf-klein" id="leeren" type="button">Alles auf 0</button>
      <button class="knopf knopf-klein knopf-gold" type="button" id="zum-einkauf">Zur Einkaufsliste →</button></div>
    <p class="leise" style="margin-top:-8px">Trag ein, wie oft du was baust – mit und ohne Beleuchtung. Einkaufsliste, Zuschnitt und Kosten rechnen sich automatisch.</p>
    <div class="kacheln" id="kacheln"></div>
    <div class="panel tab-scroll"><table class="tab"><thead><tr><th>Variante</th><th>Ohne Licht</th><th>Mit Licht</th></tr></thead><tbody>${zeilen}</tbody></table></div>`;
  const kacheln = () => {
    const ek = einkaufsliste(S.bauliste.auftraege, S.produkte, S.material);
    const stueck = S.bauliste.auftraege.reduce((s, a) => s + a.anzahl, 0);
    const gewinn = ek.umsatz - ek.summe;
    $("#kacheln").innerHTML = `
      <div class="kachel"><div class="zahl">${stueck}</div><div class="was">Stück geplant</div></div>
      <div class="kachel"><div class="zahl">${euro(ek.summe)}</div><div class="was">Einkauf (geschätzt)</div></div>
      <div class="kachel"><div class="zahl">${ek.stunden.toLocaleString("de-DE")} h</div><div class="was">Bauzeit (geschätzt)</div></div>
      <div class="kachel"><div class="zahl">${euro(ek.umsatz)}</div><div class="was">Einnahmen</div></div>
      <div class="kachel ${gewinn >= 0 ? "gut" : "schlecht"}"><div class="zahl">${euro(gewinn)}</div><div class="was">Übrig nach Einkauf${ek.stunden ? ` · ${euro(gewinn / ek.stunden)}/h` : ""}</div></div>`;
  };
  kacheln();
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-schritt]");
    if (!b) return;
    const z = b.closest("[data-z]"), inp = $("input", z);
    inp.value = Math.max(0, (parseInt(inp.value, 10) || 0) + Number(b.dataset.schritt));
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  el.addEventListener("input", (e) => {
    const z = e.target.closest("[data-z]");
    if (!z) return;
    const [pid, vid, l] = z.dataset.z.split("|");
    setzeAnzahl(pid, vid, l === "1", parseInt(e.target.value, 10));
    kacheln();
  });
  $("#leeren").addEventListener("click", () => {
    if (!confirm("Alle Anzahlen auf 0 setzen?")) return;
    S.bauliste.auftraege = [];
    geaendert("bauliste");
    zeigeTab("planen");
  });
  $("#zum-einkauf").addEventListener("click", () => zeigeTab("einkauf"));
}

// Stückliste im Stil der Fertigmaße: Pos · Anzahl · Teil · Material · L · B · D · Winkel · Hinweis
function stuecklisteTabelle(zeilen, mitProdukt) {
  return `<table class="tab stueckliste"><thead><tr><th class="zahl">Pos.</th><th class="zahl">Anz.</th><th>Teil</th>
    <th class="zahl">Länge</th><th class="zahl">Breite</th><th class="zahl">Dicke</th><th>Winkel</th><th>Hinweis</th></tr></thead>
    <tbody>${zeilen.map((r, i) => `<tr>
      <td class="zahl leise">${i + 1}</td><td class="zahl"><b>${r.anzahl}</b></td>
      <td><b>${esc(r.teil)}</b>${mitProdukt ? `<div class="leise" style="font-size:12.5px">${esc(r.produkt)}${r.variante ? " " + esc(r.variante) : ""}</div>` : ""}<div class="leise" style="font-size:12.5px">${esc(r.material)}</div></td>
      <td class="zahl"><b>${r.laenge}</b></td><td class="zahl">${r.breite}</td><td class="zahl">${r.dicke}</td>
      <td>${winkelHtml(esc(r.winkel))}</td><td class="leise" style="font-size:14px">${esc(r.zuschnitt)}${r.profil ? " · Form aussägen" : ""}</td></tr>`).join("")}</tbody></table>
    <p class="leise" style="font-size:13px;margin:10px 0 0">Alle Maße in mm. Winkel: erstes Ende / zweites Ende.</p>`;
}

// ======================================================================
// Einkauf & Zuschnitt
// ======================================================================
function tabEinkauf(el) {
  const auf = S.bauliste.auftraege;
  if (!auf.length) {
    el.innerHTML = `<h2>Einkauf &amp; Zuschnitt</h2><div class="panel"><p>Noch nichts geplant. Trag unter <a href="#planen" data-tab-link="planen">Planen</a> ein, was du bauen willst.</p></div>`;
    $("[data-tab-link]", el).addEventListener("click", (e) => { e.preventDefault(); zeigeTab("planen"); });
    return;
  }
  const ek = einkaufsliste(auf, S.produkte, S.material);
  const sl = stueckliste(auf, S.produkte, M);
  const uebersicht = auf.map((a) => {
    const { p, v } = findeVariante(S.produkte, a.produkt, a.variante);
    return p ? `${a.anzahl} × ${p.name}${p.varianten.length > 1 ? " " + v.name : ""}${a.licht ? " mit Licht" : ""}` : "";
  }).filter(Boolean).join(" · ");
  el.innerHTML = `
    <div class="ws-leiste"><h2 style="margin:0">Einkaufsliste</h2><span class="abstand"></span>
      <button class="knopf knopf-klein" id="teilen" type="button">Teilen / Kopieren</button>
      <button class="knopf knopf-klein" id="csv" type="button">Als CSV</button>
      <button class="knopf knopf-klein knopf-gold" id="drucken" type="button">Drucken / PDF</button></div>
    <p class="leise" style="margin-top:-8px">Für: ${esc(uebersicht)}</p>
    <div class="panel tab-scroll">
      <table class="tab"><thead><tr><th style="width:36px"></th><th>Material</th><th>Benötigt</th><th class="zahl">Kaufen</th><th class="zahl">ca. Preis</th></tr></thead>
      <tbody>${ek.posten.map((p) => `<tr><td><input type="checkbox" aria-label="erledigt" style="width:20px;height:20px"></td>
        <td><b>${esc(p.name)}</b>${p.warnung ? `<div class="warnung">${esc(p.warnung)}</div>` : ""}</td>
        <td class="leise">${esc(p.benoetigt)}</td><td class="zahl"><b>${p.kaufen}</b> <span class="leise">× ${esc(p.einheit)}</span></td><td class="zahl">${euro(p.preis)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td></td><td colspan="3">Summe (Schätzung)</td><td class="zahl">${euro(ek.summe)}</td></tr></tfoot></table>
      <p class="leise" style="font-size:13px;margin:12px 0 0">${esc(S.material.hinweis || "")}</p>
    </div>
    <h2>Zuschnitt</h2>
    <div class="panel">${zuschnittSVG(ek.zuschnitt)}</div>
    <h2>Stückliste (Fertigmaße)</h2>
    <div class="panel tab-scroll">${stuecklisteTabelle(sl, true)}</div>`;
  $("#drucken").addEventListener("click", () => window.print());
  $("#csv").addEventListener("click", () => herunterladen("einkaufsliste.csv", einkaufCSV(ek), "text/csv;charset=utf-8"));
  $("#teilen").addEventListener("click", async () => {
    const text = einkaufText(ek);
    try {
      if (navigator.share) await navigator.share({ title: "Einkaufsliste", text });
      else { await navigator.clipboard.writeText(text); melde("Einkaufsliste kopiert."); }
    } catch (e) { if (e.name !== "AbortError") { await navigator.clipboard?.writeText(text); melde("Einkaufsliste kopiert."); } }
  });
}

// ======================================================================
// Baupläne
// ======================================================================
function tabBauplan(el) {
  if (!S.produkte.length) { el.innerHTML = `<h2>Baupläne</h2><p>Noch keine Produkte.</p>`; return; }
  let pid = S.bauplan.produkt || S.produkte[0].id;
  if (!S.produkte.some((p) => p.id === pid)) pid = S.produkte[0].id;
  const p = S.produkte.find((x) => x.id === pid);
  const v = p.varianten.find((x) => x.id === S.bauplan.variante) || p.varianten[0];
  S.bauplan = { produkt: p.id, variante: v.id };
  const k0 = kostenVariante(v, S.material, false), k1 = kostenVariante(v, S.material, true);
  const hatLicht = v.licht && v.licht.length;
  const teile = (v.teile || []).filter((t) => !t.nurModell);
  const kl = (v.kleinteile || []).filter((k) => M[k.material]);
  const li = (v.licht || []).filter((k) => M[k.material]);
  const ek1 = einkaufsliste([{ produkt: p.id, variante: v.id, licht: true, anzahl: 1 }], S.produkte, S.material);

  el.innerHTML = `
    <div class="ws-leiste nicht-drucken">
      <select id="bp-produkt" style="max-width:260px">${S.produkte.map((x) => `<option value="${esc(x.id)}" ${x.id === p.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      ${p.varianten.length > 1 ? `<div class="var-tabs" style="margin:0">${p.varianten.map((x) => `<button type="button" data-var="${esc(x.id)}" aria-pressed="${x.id === v.id}">${esc(x.name)}</button>`).join("")}</div>` : ""}
      <span class="abstand"></span>
      <button class="knopf knopf-klein" type="button" id="bp-bearbeiten">Bearbeiten</button>
      <button class="knopf knopf-klein knopf-gold" type="button" id="bp-drucken">Drucken / PDF</button>
    </div>
    <h2>${esc(p.name)}${p.varianten.length > 1 ? ` <span class="leise" style="font-size:.7em">${esc(v.name)}</span>` : ""}</h2>
    <p class="leise" style="margin-top:-6px">${esc(v.masse || "")} · ${esc(p.untertitel || "")}</p>
    <div class="bauplan-kopf">
      <div class="bp-zeichnung">${zeichnungSVG(v, M, { masse: true, linie: 400 })}</div>
      <div class="bp-3d" id="bp-3d"><div class="lade">3D wird geladen …</div>${hatLicht || (v.teile || []).some((t) => t.flamme) ? `<button class="knopf knopf-klein" type="button" id="bp-licht">Licht an</button>` : ""}</div>
    </div>
    <div class="kacheln">
      <div class="kachel"><div class="zahl">${euro(k0.material)}</div><div class="was">Material ohne Licht</div></div>
      ${hatLicht ? `<div class="kachel"><div class="zahl">${euro(k1.material)}</div><div class="was">Material mit Licht</div></div>` : ""}
      <div class="kachel"><div class="zahl">${String(v.stunden || 0).replace(".", ",")} h</div><div class="was">Bauzeit (geschätzt)</div></div>
      <div class="kachel"><div class="zahl">${k0.vorschlag} €${hatLicht ? ` / ${k1.vorschlag} €` : ""}</div><div class="was">Preisvorschlag (${S.material.stundensatz || 10} €/h)</div></div>
      <div class="kachel"><div class="zahl">${v.preis.ohne} €${hatLicht ? ` / ${v.preis.mit} €` : ""}</div><div class="was">Dein Preis</div></div>
    </div>
    <div class="panel tab-scroll">
      <h3>Stückliste (Fertigmaße, 1 Stück)</h3>
      ${stuecklisteTabelle(stueckliste([{ produkt: p.id, variante: v.id, anzahl: 1 }], S.produkte, M), false)}
    </div>
    <div class="raster-2" style="gap:0 20px">
      <div class="panel"><h3>Kleinteile</h3>${kl.length ? `<ul style="margin:0;padding-left:1.2em">${kl.map((k) => `<li>${k.anzahl} × ${esc(M[k.material].name)}</li>`).join("")}</ul>` : `<p class="leise">Keine.</p>`}
        ${li.length ? `<h3 style="margin-top:16px">Beleuchtung</h3><ul style="margin:0;padding-left:1.2em">${li.map((k) => `<li>${k.anzahl} × ${esc(M[k.material].name)}</li>`).join("")}</ul>` : ""}
        <h3 style="margin-top:16px">Oberfläche</h3><p style="margin:0">${({ lasur: "Lasur außen, 2 Anstriche", geflammt: "Geflämmt und ausgebürstet, danach Holzöl", keine: "Unbehandelt" })[v.oberflaeche] || esc(v.oberflaeche || "–")}</p>
      </div>
      <div class="panel"><h3>Einkauf für 1 Stück (mit Licht)</h3>
        <ul style="margin:0;padding-left:1.2em">${ek1.posten.map((x) => `<li>${x.kaufen} × ${esc(x.name)} <span class="leise">(${esc(x.einheit)})</span></li>`).join("")}</ul>
        <p class="leise" style="font-size:13px;margin:10px 0 0">Bei mehreren Stück lohnt sich die Einkaufsliste unter „Planen“, dort wird der Verschnitt geteilt.</p>
      </div>
    </div>
    <div class="panel"><h3>So wird's gebaut</h3>${(v.schritte || []).length ? `<ol class="schrittliste">${v.schritte.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<p class="leise">Noch keine Schritte eingetragen.</p>`}</div>
    ${teile.some((t) => M[t.material]?.notiz) ? `<div class="hinweis">${[...new Set(teile.map((t) => M[t.material]?.notiz).filter(Boolean))].map(esc).join("<br>")}</div>` : ""}
    <div class="panel nicht-drucken" style="margin-top:20px"><h3>Zuschnitt für 1 Stück</h3>${zuschnittSVG(ek1.zuschnitt)}</div>`;

  $("#bp-produkt").addEventListener("change", (e) => { S.bauplan = { produkt: e.target.value, variante: null }; zeigeTab("bauplan"); });
  $$("[data-var]", el).forEach((b) => b.addEventListener("click", () => { S.bauplan.variante = b.dataset.var; zeigeTab("bauplan"); }));
  $("#bp-drucken").addEventListener("click", () => window.print());
  $("#bp-bearbeiten").addEventListener("click", () => { S.produktId = p.id; S.varianteIdx = p.varianten.indexOf(v); zeigeTab("produkte"); });
  const bp3d = $("#bp-3d");
  neuerViewer(bp3d).then((vw) => {
    if (!vw || S.tab !== "bauplan" || !document.body.contains(bp3d)) { vw?.dispose(); return; }
    aktiverViewer = vw;
    vw.zeige(v, M);
    const lk = $("#bp-licht");
    if (lk) lk.addEventListener("click", () => { vw.licht(!vw.lichtAn); lk.textContent = vw.lichtAn ? "Licht aus" : "Licht an"; });
  });
}

// ======================================================================
// Produkte (Editor)
// ======================================================================
function neuesProdukt() {
  let id = "neues-produkt", n = 2;
  while (S.produkte.some((p) => p.id === id)) id = `neues-produkt-${n++}`;
  return {
    id, name: "Neues Produkt", untertitel: "", beschreibung: "", kategorie: "draussen", sichtbar: false, foto: "", lieferung: "advent",
    varianten: [{
      id: "standard", name: "Standard", masse: "", preis: { ohne: 0, mit: 0 }, stunden: 1, licht: [], oberflaeche: "lasur",
      teile: [{ name: "Latte", material: S.material.materialien[0]?.id || "", laenge: 500, zuschnitt: "gerade", anzahl: 4, instanzen: [] }],
      kleinteile: [], schritte: [],
    }],
  };
}

function materialOptionen(gewaehlt, filter) {
  return S.material.materialien.filter((m) => !filter || filter(m))
    .map((m) => `<option value="${esc(m.id)}" ${m.id === gewaehlt ? "selected" : ""}>${esc(m.name)}</option>`).join("");
}

function teilKarte(t, ti, vi) {
  const pf = `varianten.${vi}.teile.${ti}`;
  if (t.form === "zylinder") {
    return `<div class="teil-karte" data-teil="${ti}">
      <div class="teil-oben" style="grid-template-columns:2fr 1fr 1fr 1fr auto">
        <div class="feld"><label>Deko im Modell (Zylinder)</label><input type="text" data-pfad="${pf}.name" value="${esc(t.name)}"></div>
        <div class="feld"><label>Ø mm</label><input type="number" data-typ="zahl" data-pfad="${pf}.durchmesser" value="${t.durchmesser || 20}"></div>
        <div class="feld"><label>Höhe mm</label><input type="number" data-typ="zahl" data-pfad="${pf}.hoehe" value="${t.hoehe || 50}"></div>
        <div class="feld"><label>Farbe</label><input type="text" data-pfad="${pf}.farbe" value="${esc(t.farbe || "#eeeeee")}"></div>
        <button class="knopf-x" type="button" data-aktion="teil-weg" title="Teil löschen">×</button>
      </div>
      <p class="leise" style="font-size:13px;margin:6px 0 0">Nur fürs 3D-Modell (z. B. Kerze), zählt nicht zur Stückliste.${t.flamme ? " Mit Flamme." : ""}${t.nurMitLicht ? " Nur sichtbar mit Licht." : ""}</p>
      ${instanzenHtml(t, pf)}
    </div>`;
  }
  const m = M[t.material] || {};
  const platte = m.typ === "platte";
  const mitPos = t.instanzen && t.instanzen.length;
  return `<div class="teil-karte" data-teil="${ti}">
    <div class="teil-oben">
      <div class="feld"><label>Teil</label><input type="text" data-pfad="${pf}.name" value="${esc(t.name)}"></div>
      <div class="feld"><label>Material</label><select data-pfad="${pf}.material" data-neu-zeichnen>${materialOptionen(t.material, (x) => x.typ === "linear" || x.typ === "platte" || x.typ === "modell")}</select></div>
      <div class="feld"><label>Länge mm</label><input type="number" inputmode="decimal" data-typ="zahl" data-pfad="${pf}.laenge" value="${t.laenge ?? ""}"></div>
      <div class="feld"><label>${platte ? "Breite mm" : "Querschnitt"}</label>${platte
        ? `<input type="number" inputmode="decimal" data-typ="zahl" data-pfad="${pf}.breite" value="${t.breite ?? ""}">`
        : `<input type="text" value="${m.breite || "?"} × ${m.dicke || "?"}" disabled>`}</div>
      <div class="feld"><label>Anzahl</label><input type="number" inputmode="numeric" data-typ="zahl" data-pfad="${pf}.anzahl" value="${teilAnzahl(t)}" ${mitPos ? `disabled title="Ergibt sich aus den 3D-Positionen"` : ""}></div>
      <div style="display:flex">
        <button class="knopf-x" type="button" data-aktion="teil-kopie" title="Teil kopieren" style="color:inherit">⧉</button>
        <button class="knopf-x" type="button" data-aktion="teil-weg" title="Teil löschen">×</button>
      </div>
    </div>
    <div class="raster-2" style="margin-top:10px;gap:0 10px">
      <div class="feld" style="margin:0"><label>Winkel</label><input type="text" data-pfad="${pf}.winkel" value="${esc(t.winkel || "")}" placeholder="z. B. 22,5° / 22,5° oder gerade"></div>
      <div class="feld" style="margin:0"><label>Hinweis zum Zuschnitt</label><input type="text" data-pfad="${pf}.zuschnitt" value="${esc(t.zuschnitt || "")}" placeholder="z. B. Enden stehen waagerecht"></div>
    </div>
    ${instanzenHtml(t, pf)}
    <details data-key="${pf}-form" ${t.profil ? "open" : ""}><summary>Form (nur Platten, für ausgesägte Formen)</summary>
      <p class="leise" style="font-size:13px">Eckpunkte als Liste in mm, Mitte = 0/0, z. B. <code>[[-300,-500],[300,-500],[0,500]]</code> für ein Dreieck. Leer lassen für ein Rechteck.</p>
      <textarea data-typ="json" data-pfad="${pf}.profil" rows="3">${t.profil ? esc(JSON.stringify(t.profil)) : ""}</textarea>
    </details>
  </div>`;
}

function instanzenHtml(t, pf) {
  const inst = t.instanzen || [];
  return `<details data-key="${pf}-pos"><summary>3D-Positionen (${inst.length || "keine – Teile werden nebeneinander ausgelegt"})</summary>
    <p class="leise" style="font-size:13px">Mitte des Teils in mm: x = rechts, y = hoch (Boden = 0), z = nach vorne. Drehung in Grad: erst um die eigene Längsachse (rx), dann ry, dann rz (rz = 90 stellt eine Latte senkrecht).</p>
    <div class="inst-zeile inst-kopf"><span>x</span><span>y</span><span>z</span><span>rx</span><span>ry</span><span>rz</span><span></span></div>
    ${inst.map((i, ii) => `<div class="inst-zeile">
      ${[0, 1, 2].map((k) => `<input type="number" inputmode="decimal" data-typ="zahl" data-pfad="${pf}.instanzen.${ii}.p.${k}" value="${i.p?.[k] ?? 0}">`).join("")}
      ${[0, 1, 2].map((k) => `<input type="number" inputmode="decimal" data-typ="zahl" data-pfad="${pf}.instanzen.${ii}.r.${k}" value="${i.r?.[k] ?? 0}">`).join("")}
      <button class="knopf-x" type="button" data-aktion="inst-weg" data-inst="${ii}" title="Position löschen">×</button></div>`).join("")}
    <button class="knopf knopf-klein" type="button" data-aktion="inst-neu" style="margin-top:8px">+ Position</button>
  </details>`;
}

function listeHtml(liste, pf, filter) {
  return `${(liste || []).map((k, i) => `<div class="inst-zeile" style="grid-template-columns:3fr 1fr auto">
      <select data-pfad="${pf}.${i}.material">${materialOptionen(k.material, filter)}</select>
      <input type="number" inputmode="numeric" data-typ="zahl" data-pfad="${pf}.${i}.anzahl" value="${k.anzahl}">
      <button class="knopf-x" type="button" data-aktion="liste-weg" data-liste="${pf}" data-i="${i}">×</button></div>`).join("")}
    <button class="knopf knopf-klein" type="button" data-aktion="liste-neu" data-liste="${pf}" style="margin-top:8px">+ hinzufügen</button>`;
}

function tabProdukte(el) {
  if (!S.produktId || !S.produkte.some((p) => p.id === S.produktId)) S.produktId = S.produkte[0]?.id;
  const p = S.produkte.find((x) => x.id === S.produktId);
  const liste = S.produkte.map((x) => `<button type="button" data-produkt="${esc(x.id)}" aria-current="${x.id === S.produktId}">
      <span>${esc(x.name)}<br><span class="klein">${x.varianten.length} Variante${x.varianten.length > 1 ? "n" : ""}${x.sichtbar ? "" : " · versteckt"}</span></span><span class="klein">›</span></button>`).join("");
  if (!p) {
    el.innerHTML = `<h2>Produkte</h2><button class="knopf knopf-gold" type="button" data-aktion="produkt-neu">+ Neues Produkt</button>`;
    el.addEventListener("click", (e) => { if (e.target.closest('[data-aktion="produkt-neu"]')) { const n = neuesProdukt(); S.produkte.push(n); S.produktId = n.id; geaendert("produkte"); zeigeTab("produkte"); } });
    return;
  }
  if (S.varianteIdx >= p.varianten.length) S.varianteIdx = 0;
  const vi = S.varianteIdx, v = p.varianten[vi];
  const kateg = [["draussen", "Für draußen"], ["geschenk", "Zum Verschenken"]];
  const lief = [["advent", "Nur Advent-Termine"], ["beide", "Auch als Geschenk im Dezember"]];
  el.innerHTML = `
    <div class="ws-leiste"><h2 style="margin:0">Produkte</h2><span class="abstand"></span>
      <button class="knopf knopf-klein knopf-gold" type="button" data-aktion="produkt-neu">+ Neues Produkt</button></div>
    <div class="editor">
      <div class="produktliste">${liste}</div>
      <div id="editor">
        <div class="panel">
          <div class="raster-2">
            <div class="feld"><label>Name</label><input type="text" data-pfad="name" value="${esc(p.name)}"></div>
            <div class="feld"><label>Kurzbeschreibung</label><input type="text" data-pfad="untertitel" value="${esc(p.untertitel || "")}"></div>
          </div>
          <div class="feld"><label>Beschreibung</label><textarea data-pfad="beschreibung" rows="3">${esc(p.beschreibung || "")}</textarea></div>
          <div class="raster-3">
            <div class="feld"><label>Kategorie</label><select data-pfad="kategorie">${kateg.map(([k, n]) => `<option value="${k}" ${p.kategorie === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
            <div class="feld"><label>Lieferung</label><select data-pfad="lieferung">${lief.map(([k, n]) => `<option value="${k}" ${p.lieferung === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
            <div class="feld"><label>Text beim Licht-Schalter</label><input type="text" data-pfad="lichtText" value="${esc(p.lichtText || "")}" placeholder="mit Beleuchtung"></div>
            <div class="feld"><span class="label">Sichtbarkeit</span><label class="check" style="min-height:42px;margin:0"><input type="checkbox" data-pfad="sichtbar" ${p.sichtbar ? "checked" : ""}> Auf der Seite zeigen</label></div>
          </div>
          <div class="raster-2">
            <div>
              <span class="label" style="font-size:13px;font-weight:600;color:var(--tinte-leise)">Foto</span>
              <div class="foto-vorschau" style="margin-top:5px">${p.foto ? `<img src="${esc(fotoUrl(p.foto))}" alt="">` : "Noch kein Foto – auf der Seite erscheint die Zeichnung."}</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;justify-content:flex-end">
              <label class="knopf knopf-klein" style="cursor:pointer">Foto wählen<input type="file" accept="image/*" id="foto" class="sr"></label>
              ${p.foto ? `<button class="knopf knopf-klein" type="button" data-aktion="foto-weg">Foto entfernen</button>` : ""}
              <button class="knopf knopf-klein" type="button" data-aktion="produkt-hoch">↑ Nach oben</button>
              <button class="knopf knopf-klein" type="button" data-aktion="produkt-kopie">Produkt kopieren</button>
              <button class="knopf knopf-klein knopf-rot" type="button" data-aktion="produkt-weg">Produkt löschen</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="ws-leiste" style="margin-bottom:10px"><h3 style="margin:0">Varianten</h3><span class="abstand"></span>
            <button class="knopf knopf-klein" type="button" data-aktion="var-neu">+ Variante (Kopie)</button>
            ${p.varianten.length > 1 ? `<button class="knopf knopf-klein knopf-rot" type="button" data-aktion="var-weg">Variante löschen</button>` : ""}</div>
          <div class="var-tabs">${p.varianten.map((x, i) => `<button type="button" data-var-idx="${i}" aria-pressed="${i === vi}">${esc(x.name)}</button>`).join("")}</div>
          <div class="raster-3">
            <div class="feld"><label>Name der Variante</label><input type="text" data-pfad="varianten.${vi}.name" value="${esc(v.name)}"></div>
            <div class="feld"><label>Maße (Text)</label><input type="text" data-pfad="varianten.${vi}.masse" value="${esc(v.masse || "")}" placeholder="ca. 60 × 120 cm"></div>
            <div class="feld"><label>Bauzeit (Stunden)</label><input type="number" inputmode="decimal" step="0.25" data-typ="zahl" data-pfad="varianten.${vi}.stunden" value="${v.stunden || 0}"></div>
            <div class="feld"><label>Preis ohne Licht (€)</label><input type="number" inputmode="decimal" data-typ="zahl" data-pfad="varianten.${vi}.preis.ohne" value="${v.preis?.ohne ?? 0}"></div>
            <div class="feld"><label>Preis mit Licht (€)</label><input type="number" inputmode="decimal" data-typ="zahl" data-pfad="varianten.${vi}.preis.mit" value="${v.preis?.mit ?? 0}"></div>
            <div class="feld"><label>Oberfläche</label><select data-pfad="varianten.${vi}.oberflaeche">${[["lasur", "Lasur"], ["geflammt", "Geflämmt"], ["keine", "Unbehandelt"]].map(([k, n]) => `<option value="${k}" ${v.oberflaeche === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
          </div>
          <div class="kacheln" id="ed-kosten" style="margin:4px 0 0"></div>
        </div>

        <div class="bauplan-kopf">
          <div class="bp-zeichnung" id="ed-zeichnung"></div>
          <div class="bp-3d" id="ed-3d"><div class="lade">3D wird geladen …</div><button class="knopf knopf-klein" type="button" id="ed-licht">Licht an</button></div>
        </div>

        <div class="panel">
          <div class="ws-leiste" style="margin-bottom:10px"><h3 style="margin:0">Teile</h3><span class="abstand"></span>
            <button class="knopf knopf-klein" type="button" data-aktion="teil-neu">+ Holzteil</button>
            <button class="knopf knopf-klein" type="button" data-aktion="deko-neu">+ Deko im Modell</button></div>
          <div id="ed-teile">${(v.teile || []).map((t, ti) => teilKarte(t, ti, vi)).join("")}</div>
        </div>

        <div class="raster-2" style="gap:0 20px">
          <div class="panel"><h3>Kleinteile (pro Stück)</h3>${listeHtml(v.kleinteile, `varianten.${vi}.kleinteile`, (m) => m.typ === "stueck")}</div>
          <div class="panel"><h3>Beleuchtung (nur „mit Licht“)</h3>${listeHtml(v.licht, `varianten.${vi}.licht`, (m) => m.typ === "stueck")}</div>
        </div>
        <div class="panel"><h3>Bauschritte</h3><p class="leise" style="font-size:13px;margin-top:-4px">Ein Schritt pro Zeile.</p>
          <textarea data-typ="zeilen" data-pfad="varianten.${vi}.schritte" rows="8">${esc((v.schritte || []).join("\n"))}</textarea></div>
      </div>
    </div>`;

  for (const k of S.offeneDetails || []) { const d = $(`details[data-key="${CSS.escape(k || "")}"]`, el); if (d) d.open = true; }
  S.offeneDetails = [];
  const editor = $("#editor");
  const vorschau = () => {
    const vv = p.varianten[S.varianteIdx];
    $("#ed-zeichnung").innerHTML = zeichnungSVG(vv, M, { masse: true, linie: 400 });
    const k0 = kostenVariante(vv, S.material, false), k1 = kostenVariante(vv, S.material, true);
    $("#ed-kosten").innerHTML = `
      <div class="kachel"><div class="zahl">${euro(k0.material)}</div><div class="was">Material ohne Licht</div></div>
      <div class="kachel"><div class="zahl">${euro(k1.material)}</div><div class="was">Material mit Licht</div></div>
      <div class="kachel"><div class="zahl">${k0.vorschlag} € / ${k1.vorschlag} €</div><div class="was">Preisvorschlag</div></div>`;
    if (aktiverViewer) aktiverViewer.zeige(vv, M, { kameraBehalten: true });
  };
  let timer;
  binde(editor, () => p, "produkte", (feld) => {
    if (feld.dataset.pfad === "name") {
      $(`[data-produkt="${CSS.escape(p.id)}"] span`, el).firstChild.textContent = p.name;
    }
    if (feld.matches("[data-neu-zeichnen]")) { zeigeTab("produkte"); return; }
    if (/varianten\.\d+\.name$/.test(feld.dataset.pfad)) $(`[data-var-idx="${S.varianteIdx}"]`, el).textContent = feld.value;
    clearTimeout(timer);
    timer = setTimeout(vorschau, 250);
  });
  vorschau();
  const ed3d = $("#ed-3d");
  neuerViewer(ed3d).then((vw) => {
    if (!vw || S.tab !== "produkte" || !document.body.contains(ed3d)) { vw?.dispose(); return; }
    viewerWeg();
    aktiverViewer = vw;
    vw.zeige(p.varianten[S.varianteIdx], M);
    $("#ed-licht").addEventListener("click", (e) => { vw.licht(!vw.lichtAn); e.currentTarget.textContent = vw.lichtAn ? "Licht aus" : "Licht an"; });
  });

  $("#foto").addEventListener("change", async (e) => {
    const datei = e.target.files[0];
    if (!datei) return;
    try {
      const { base64, dataUrl } = await bildVerkleinern(datei, 1600);
      const pfad = `assets/img/produkte/${p.id}-${Date.now().toString(36)}.jpg`;
      if (p.foto && S.fotos[p.foto]) delete S.fotos[p.foto];
      S.fotos[pfad] = { base64, dataUrl };
      p.foto = pfad;
      geaendert("produkte");
      zeigeTab("produkte");
    } catch (err) { melde(`Foto konnte nicht gelesen werden: ${err.message}`, true); }
  });

  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.produkt) { S.produktId = b.dataset.produkt; S.varianteIdx = 0; return zeigeTab("produkte"); }
    if (b.dataset.varIdx !== undefined) { S.varianteIdx = Number(b.dataset.varIdx); return zeigeTab("produkte"); }
    const a = b.dataset.aktion;
    if (!a) return;
    const vv = p.varianten[S.varianteIdx];
    const teilIdx = () => Number(b.closest("[data-teil]").dataset.teil);
    switch (a) {
      case "produkt-neu": { const n = neuesProdukt(); S.produkte.push(n); S.produktId = n.id; S.varianteIdx = 0; break; }
      case "produkt-kopie": {
        const n = kopie(p); let id = `${p.id}-kopie`, k = 2;
        while (S.produkte.some((x) => x.id === id)) id = `${p.id}-kopie-${k++}`;
        n.id = id; n.name = `${p.name} (Kopie)`; n.sichtbar = false;
        S.produkte.splice(S.produkte.indexOf(p) + 1, 0, n); S.produktId = id; break;
      }
      case "produkt-weg":
        if (!confirm(`„${p.name}“ wirklich löschen?`)) return;
        S.produkte.splice(S.produkte.indexOf(p), 1);
        S.bauliste.auftraege = S.bauliste.auftraege.filter((x) => x.produkt !== p.id);
        geaendert("bauliste");
        S.produktId = null; break;
      case "produkt-hoch": { const i = S.produkte.indexOf(p); if (i > 0) [S.produkte[i - 1], S.produkte[i]] = [S.produkte[i], S.produkte[i - 1]]; break; }
      case "foto-weg": p.foto = ""; break;
      case "var-neu": {
        const n = kopie(vv); let id = `${vv.id}-2`, k = 3;
        while (p.varianten.some((x) => x.id === id)) id = `${vv.id}-${k++}`;
        n.id = id; n.name = `${vv.name} (Kopie)`; p.varianten.push(n); S.varianteIdx = p.varianten.length - 1; break;
      }
      case "var-weg":
        if (!confirm(`Variante „${vv.name}“ löschen?`)) return;
        p.varianten.splice(S.varianteIdx, 1); S.varianteIdx = 0; break;
      case "teil-neu": vv.teile.push({ name: "Neues Teil", material: S.material.materialien.find((m) => m.typ === "linear")?.id || "", laenge: 500, winkel: "gerade", zuschnitt: "", anzahl: 1, instanzen: [] }); break;
      case "deko-neu": vv.teile.push({ name: "Kerze", form: "zylinder", nurModell: true, durchmesser: 22, hoehe: 150, farbe: "#f3ead8", flamme: true, instanzen: [{ p: [0, 75, 0], r: [0, 0, 0] }] }); break;
      case "teil-weg": if (!confirm("Teil löschen?")) return; vv.teile.splice(teilIdx(), 1); break;
      case "teil-kopie": { const i = teilIdx(); vv.teile.splice(i + 1, 0, kopie(vv.teile[i])); break; }
      case "inst-neu": {
        const t = vv.teile[teilIdx()];
        t.instanzen ||= [];
        const letzte = t.instanzen[t.instanzen.length - 1];
        if (!t.instanzen.length && teilAnzahl(t) > 0 && t.form !== "zylinder") {
          // vorhandene Anzahl in Positionen umwandeln
          const { B } = teilMasse(t, M);
          for (let i = 0; i < teilAnzahl(t); i++) t.instanzen.push({ p: [0, (B || 40) / 2 + i * ((B || 40) + 20), 0], r: [0, 0, 0] });
        } else t.instanzen.push(letzte ? kopie(letzte) : { p: [0, 0, 0], r: [0, 0, 0] });
        if (letzte) t.instanzen[t.instanzen.length - 1].p[0] += 100;
        break;
      }
      case "inst-weg": {
        const t = vv.teile[teilIdx()];
        t.instanzen.splice(Number(b.dataset.inst), 1);
        if (!t.instanzen.length) t.anzahl = 1;
        break;
      }
      case "liste-neu": {
        const arr = holePfad(p, b.dataset.liste) || [];
        arr.push({ material: S.material.materialien.find((m) => m.typ === "stueck")?.id || "", anzahl: 1 });
        setzePfad(p, b.dataset.liste, arr); break;
      }
      case "liste-weg": holePfad(p, b.dataset.liste).splice(Number(b.dataset.i), 1); break;
      default: return;
    }
    geaendert("produkte");
    S.offeneDetails = $$("details[open][data-key]", el).map((d) => d.dataset.key);
    if (a === "inst-neu") S.offeneDetails.push(b.closest("details")?.dataset.key);
    zeigeTab("produkte");
  });
}

function bildVerkleinern(datei, max) {
  return new Promise((ok, fehler) => {
    const url = URL.createObjectURL(datei);
    const img = new Image();
    img.onload = () => {
      const f = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * f); c.height = Math.round(img.height * f);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(url);
      ok({ dataUrl, base64: dataUrl.split(",")[1] });
    };
    img.onerror = () => fehler(new Error("Bildformat nicht unterstützt"));
    img.src = url;
  });
}

// ======================================================================
// Material & Preise
// ======================================================================
const TYPEN = { linear: "Latte / Kantholz / Leiste", platte: "Platte", stueck: "Stückware / Packung", lasur: "Lasur / Farbe", modell: "Nur fürs 3D-Modell (Kaufteil)" };
function materialFelder(m, i) {
  const pf = `materialien.${i}`;
  const f = (k, label, step = "1") => `<div class="feld"><label>${label}</label><input type="number" inputmode="decimal" step="${step}" data-typ="zahl" data-pfad="${pf}.${k}" value="${m[k] ?? ""}"></div>`;
  const spez = {
    linear: f("breite", "Breite mm") + f("dicke", "Dicke mm") 
      + f("laenge", "Rohlänge 1 (mm)") + f("preis", "Preis Länge 1 (€)", "0.01") + `<span></span>`
      + f("laenge2", "Rohlänge 2 (mm, optional)") + f("preis2", "Preis Länge 2 (€)", "0.01"),
    platte: f("laenge", "Länge mm") + f("breite", "Breite mm") + f("dicke", "Dicke mm"),
    stueck: f("packung", "Stück pro Packung"),
    modell: f("breite", "Breite mm") + f("dicke", "Dicke mm"),
    lasur: f("liter", "Liter pro Dose", "0.05") + f("ergiebigkeit", "m² pro Liter") + f("anstriche", "Anstriche"),
  }[m.typ] || "";
  return `<div class="teil-karte" data-mat="${i}">
    <div class="teil-oben" style="grid-template-columns:2.4fr 1.4fr 1fr auto">
      <div class="feld"><label>Bezeichnung</label><input type="text" data-pfad="${pf}.name" value="${esc(m.name)}"></div>
      <div class="feld"><label>Art</label><select data-pfad="${pf}.typ" data-neu>${Object.entries(TYPEN).map(([k, n]) => `<option value="${k}" ${m.typ === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      ${m.typ === "linear" ? "<span></span>" : `<div class="feld"><label>Preis €</label><input type="number" inputmode="decimal" step="0.01" data-typ="zahl" data-pfad="${pf}.preis" value="${m.preis ?? 0}"></div>`}
      <button class="knopf-x" type="button" data-aktion="mat-weg" title="Löschen">×</button>
    </div>
    <div class="raster-3" style="margin-top:10px">${spez}</div>
    <p class="leise" style="font-size:12.5px;margin:0">Kürzel: <code>${esc(m.id)}</code>${m.notiz ? ` · ${esc(m.notiz)}` : ""}</p>
  </div>`;
}

function tabMaterial(el) {
  el.innerHTML = `
    <div class="ws-leiste"><h2 style="margin:0">Material &amp; Preise</h2><span class="abstand"></span>
      <button class="knopf knopf-klein knopf-gold" type="button" data-aktion="mat-neu">+ Material</button></div>
    <div class="hinweis" style="margin-bottom:20px">${esc(S.material.hinweis || "Preise im Baumarkt prüfen und hier eintragen.")}</div>
    <div class="panel"><div class="raster-3">
      <div class="feld"><label>Sägeschnitt (mm)</label><input type="number" data-typ="zahl" data-pfad="saegeschnitt" value="${S.material.saegeschnitt ?? 4}"></div>
      <div class="feld"><label>Dein Stundenlohn für Preisvorschläge (€)</label><input type="number" data-typ="zahl" data-pfad="stundensatz" value="${S.material.stundensatz ?? 10}"></div>
    </div></div>
    <div id="mat-liste">${S.material.materialien.map(materialFelder).join("")}</div>`;
  binde(el, S.material, "material", (feld) => { if (feld.matches("[data-neu]")) zeigeTab("material"); });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-aktion]");
    if (!b) return;
    if (b.dataset.aktion === "mat-neu") {
      const name = prompt("Name des Materials, z. B. „Rahmenholz 44 × 69 mm“");
      if (!name) return;
      let id = slug(name), k = 2;
      while (M[id]) id = `${slug(name)}-${k++}`;
      S.material.materialien.push({ id, name, typ: "linear", breite: 48, dicke: 24, laenge: 2500, preis: 0, laenge2: 2000, preis2: 0 });
    } else if (b.dataset.aktion === "mat-weg") {
      const i = Number(b.closest("[data-mat]").dataset.mat);
      const m = S.material.materialien[i];
      const benutzt = S.produkte.filter((p) => p.varianten.some((v) => [...(v.teile || []), ...(v.kleinteile || []), ...(v.licht || [])].some((t) => t.material === m.id)));
      if (benutzt.length && !confirm(`„${m.name}“ wird benutzt in: ${benutzt.map((p) => p.name).join(", ")}.\nTrotzdem löschen?`)) return;
      if (!benutzt.length && !confirm(`„${m.name}“ löschen?`)) return;
      S.material.materialien.splice(i, 1);
    } else return;
    geaendert("material");
    zeigeTab("material");
  });
}

// ======================================================================
// Einstellungen
// ======================================================================
function tabEinstellungen(el) {
  const g = ghEinstellungen();
  const s = S.site;
  el.innerHTML = `
    <h2>Einstellungen</h2>
    <div class="panel">
      <h3>GitHub verbinden</h3>
      <p class="leise" style="margin-top:-4px">Damit „Speichern“ deine Änderungen direkt ins Repo schreibt. Die Angaben bleiben nur auf diesem Gerät.</p>
      <div class="raster-3">
        <div class="feld"><label>GitHub-Benutzername</label><input type="text" id="gh-owner" value="${esc(g.owner)}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
        <div class="feld"><label>Repo-Name</label><input type="text" id="gh-repo" value="${esc(g.repo)}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="holzstube"></div>
        <div class="feld"><label>Branch</label><input type="text" id="gh-branch" value="${esc(g.branch || "main")}" autocapitalize="off"></div>
      </div>
      <div class="feld"><label>Zugangsschlüssel (Fine-grained Token)</label><input type="password" id="gh-token" value="${esc(g.token)}" autocomplete="off" placeholder="github_pat_…"></div>
      <div class="ws-leiste">
        <button class="knopf knopf-gold knopf-klein" type="button" id="gh-speichern">Verbinden &amp; testen</button>
        <button class="knopf knopf-klein" type="button" id="gh-laden">Stand von GitHub laden</button>
        <button class="knopf knopf-klein knopf-rot" type="button" id="gh-trennen">Vom Gerät entfernen</button>
      </div>
      <details><summary>So bekommst du den Zugangsschlüssel</summary>
        <ol class="schrittliste" style="margin-top:10px">
          <li>Auf github.com: Profilbild → <b>Settings</b> → ganz unten <b>Developer settings</b> → <b>Personal access tokens</b> → <b>Fine-grained tokens</b> → <b>Generate new token</b>.</li>
          <li>Name z. B. „Holzstube Werkstatt“, Ablauf z. B. 1 Jahr.</li>
          <li>Bei <b>Repository access</b>: „Only select repositories“ → dein Holzstube-Repo.</li>
          <li>Bei <b>Permissions → Repository permissions</b>: <b>Contents</b> auf „Read and write“.</li>
          <li>Token erstellen, kopieren und oben einfügen. Er wird nur auf diesem Gerät gespeichert, nicht im Repo.</li>
        </ol>
      </details>
      <div id="gh-ergebnis"></div>
    </div>

    <div class="panel" id="seite">
      <h3>Inhalte der Seite</h3>
      <div class="raster-2">
        <div class="feld"><label>WhatsApp-Nummer</label><input type="text" inputmode="tel" data-pfad="whatsapp" value="${esc(s.whatsapp || "")}"></div>
        <div class="feld"><label>Telefon (Anzeige)</label><input type="text" inputmode="tel" data-pfad="telefon" value="${esc(s.telefon || "")}"></div>
      </div>
      <div class="feld"><label>Zeile über der Überschrift</label><input type="text" data-pfad="untertitel" value="${esc(s.untertitel || "")}"></div>
      <div class="feld"><label>Einleitung</label><textarea data-pfad="einleitung" rows="3">${esc(s.einleitung || "")}</textarea></div>
      <div class="feld"><label>Über mich</label><textarea data-pfad="ueber" rows="4">${esc(s.ueber || "")}</textarea></div>
      <div class="ws-leiste" style="align-items:flex-end">
        <div class="foto-vorschau" style="width:150px;aspect-ratio:4/5">${s.ueberFoto ? `<img src="${esc(fotoUrl(s.ueberFoto))}" alt="">` : "Kein Foto"}</div>
        <label class="knopf knopf-klein" style="cursor:pointer">Foto für „Über mich“ wählen<input type="file" accept="image/*" id="ueber-foto" class="sr"></label>
      </div>
      <h3 style="margin-top:20px">Liefertermine</h3>
      ${(s.liefertermine || []).map((t, i) => `<div class="teil-karte"><div class="raster-3">
        <div class="feld"><label>Titel</label><input type="text" data-pfad="liefertermine.${i}.titel" value="${esc(t.titel)}"></div>
        <div class="feld"><label>Bestellen bis</label><input type="text" data-pfad="liefertermine.${i}.bestellen_bis" value="${esc(t.bestellen_bis)}"></div>
        <div class="feld"><label>Fertig bis</label><input type="text" data-pfad="liefertermine.${i}.lieferung_bis" value="${esc(t.lieferung_bis)}"></div></div>
        <div class="feld" style="margin:0"><label>Text</label><input type="text" data-pfad="liefertermine.${i}.text" value="${esc(t.text || "")}"></div></div>`).join("")}
      <h3 style="margin-top:20px">Impressum</h3>
      <div class="raster-2">
        <div class="feld"><label>Name</label><input type="text" data-pfad="impressum.name" value="${esc(s.impressum?.name || "")}"></div>
        <div class="feld"><label>Straße</label><input type="text" data-pfad="impressum.strasse" value="${esc(s.impressum?.strasse || "")}"></div>
        <div class="feld"><label>PLZ und Ort</label><input type="text" data-pfad="impressum.ort" value="${esc(s.impressum?.ort || "")}"></div>
        <div class="feld"><label>Kontakt</label><input type="text" data-pfad="impressum.kontakt" value="${esc(s.impressum?.kontakt || "")}"></div>
      </div>
      <h3 style="margin-top:20px">Werkstatt-Zugang</h3>
      <div class="raster-2">
        <div class="feld"><label>Name</label><input type="text" data-pfad="werkstatt.benutzer" value="${esc(s.werkstatt?.benutzer || "")}"></div>
        <div class="feld"><label>Passwort</label><input type="text" data-pfad="werkstatt.passwort" value="${esc(s.werkstatt?.passwort || "")}"></div>
      </div>
      <p class="leise" style="font-size:13px;margin:0">Das ist nur eine einfache Tür: Wer sich auskennt, kann das Passwort im Quelltext finden. Hinter dem Login liegt deshalb nichts Geheimes – dein GitHub-Token bleibt sowieso nur auf deinem Gerät.</p>
    </div>

    <div class="panel">
      <h3>Ohne GitHub-Verbindung</h3>
      <p class="leise" style="margin-top:-4px">Du kannst die geänderten Dateien auch herunterladen und von Hand im Repo unter <code>src/_data/</code> ersetzen.</p>
      <div class="ws-leiste" style="margin:0">${Object.keys(DATEIEN).map((k) => `<button class="knopf knopf-klein" type="button" data-laden="${k}">${k}.json</button>`).join("")}</div>
      <hr style="border:none;border-top:1px solid var(--strich);margin:18px 0">
      <button class="knopf knopf-klein knopf-rot" type="button" id="entwurf-weg">Ungespeicherte Änderungen verwerfen</button>
    </div>`;

  binde($("#seite"), S.site, "site");
  $("#ueber-foto").addEventListener("change", async (e) => {
    const datei = e.target.files[0];
    if (!datei) return;
    try {
      const f = await bildVerkleinern(datei, 1400);
      const pfad = `assets/img/ueber-${Date.now().toString(36)}.jpg`;
      if (S.site.ueberFoto && S.fotos[S.site.ueberFoto]) delete S.fotos[S.site.ueberFoto];
      S.fotos[pfad] = f;
      S.site.ueberFoto = pfad;
      geaendert("site");
      zeigeTab("einstellungen");
    } catch (err) { melde(`Foto konnte nicht gelesen werden: ${err.message}`, true); }
  });
  const ergebnis = (html, fehler) => { $("#gh-ergebnis").innerHTML = `<div class="hinweis${fehler ? " fehler" : ""}" style="margin-top:14px">${html}</div>`; };
  $("#gh-speichern").addEventListener("click", async () => {
    const neu = { owner: $("#gh-owner").value.trim(), repo: $("#gh-repo").value.trim(), branch: $("#gh-branch").value.trim() || "main", token: $("#gh-token").value.trim() };
    speicher.schreib(GH_KEY, neu);
    ergebnis("Teste die Verbindung …");
    try {
      const info = await new GitHub(neu).pruefe();
      ergebnis(`Verbunden mit <b>${esc(info.name)}</b> (${info.privat ? "privat" : "öffentlich"}).${info.schreiben ? "" : " <b>Achtung:</b> keine Schreibrechte."}`, !info.schreiben);
    } catch (e) { ergebnis(esc(e.message), true); }
  });
  $("#gh-laden").addEventListener("click", async () => {
    if (!gh().bereit) return ergebnis("Bitte zuerst verbinden.", true);
    if ((S.geaendert.size || Object.keys(S.fotos).length) && !confirm("Deine ungespeicherten Änderungen gehen dabei verloren. Weiter?")) return;
    S.geaendert.clear(); S.fotos = {}; speicher.weg(ENTWURF);
    await vonGitHubLaden(false);
    statusZeigen();
    zeigeTab("einstellungen");
  });
  $("#gh-trennen").addEventListener("click", () => { speicher.weg(GH_KEY); melde("GitHub-Verbindung von diesem Gerät entfernt."); zeigeTab("einstellungen"); });
  $$("[data-laden]", el).forEach((b) => b.addEventListener("click", () => herunterladen(`${b.dataset.laden}.json`, JSON.stringify(S[b.dataset.laden], null, 1) + "\n", "application/json")));
  $("#entwurf-weg").addEventListener("click", () => {
    if (!confirm("Alle ungespeicherten Änderungen verwerfen?")) return;
    speicher.weg(ENTWURF);
    S.geaendert.clear(); S.fotos = {};
    location.reload();
  });
}

login();
