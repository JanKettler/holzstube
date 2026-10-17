// Jans Holzstube – öffentliche Seite
import { materialMap, zeichnungSVG, vorderansicht, whatsappLink } from "./bauplan.js";

const lies = (id) => JSON.parse(document.getElementById(id).textContent);
const produkte = lies("d-produkte");
const materialDaten = lies("d-material");
const site = lies("d-site");
const M = materialMap(materialDaten);

// ---------- Lichterkette oben ----------
function lichterkette() {
  const box = document.getElementById("lichterkette");
  if (!box) return;
  const w = Math.max(box.clientWidth, 320);
  const abstand = w < 600 ? 46 : 62;
  const n = Math.floor(w / abstand);
  const bogen = [];
  let d = "M-10 8";
  for (let i = 0; i <= n; i++) {
    const x0 = i * abstand - 10, x1 = x0 + abstand;
    d += ` Q${x0 + abstand / 2} ${30 + (i % 2) * 6} ${x1} 8`;
    bogen.push({ x: x0 + abstand / 2, y: 18 + (i % 2) * 3 });
  }
  const birnen = bogen.map((b, i) => {
    const dreh = (i % 2 ? -1 : 1) * (8 + (i % 3) * 4);
    return `<g transform="translate(${b.x.toFixed(1)} ${b.y.toFixed(1)}) rotate(${dreh})" style="--d:${(0.35 + i * 0.07).toFixed(2)}s">
      <circle class="lk-schein" cx="0" cy="17" r="20"/>
      <rect class="lk-sockel" x="-3.2" y="0" width="6.4" height="7" rx="1.5"/>
      <path class="lk-birne" d="M0 6c-4.6 0-6.4 4.3-6.4 8.3 0 4.8 3.2 9.7 6.4 9.7s6.4-4.9 6.4-9.7C6.4 10.3 4.6 6 0 6z"/>
    </g>`;
  }).join("");
  box.innerHTML = `<svg viewBox="0 0 ${w} 70" preserveAspectRatio="xMidYMin meet">
    <defs><radialGradient id="lk-glow"><stop offset="0" stop-color="#ffe2a3" stop-opacity=".75"/><stop offset=".4" stop-color="#f6c86b" stop-opacity=".25"/><stop offset="1" stop-color="#f6c86b" stop-opacity="0"/></radialGradient></defs>
    <path class="lk-kabel" d="${d}"/>${birnen}</svg>`;
  requestAnimationFrame(() => box.classList.add("an"));
}

// ---------- Glühbirnen entlang einer Zeichnung ----------
function birnenPunkte(v, abstandFaktor = 22) {
  const formen = vorderansicht(v, M).filter((f) => !f.modell && !/stütz|spieß|fuß/i.test(f.name));
  const xs = formen.flatMap((f) => f.poly.map((q) => q[0])), ys = formen.flatMap((f) => f.poly.map((q) => q[1]));
  const groesse = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const abstand = groesse / abstandFaktor;
  const punkte = [];
  for (const f of formen) {
    const p = f.poly;
    if (p.length <= 6) {
      // Latte: Mittellinie zwischen den beiden kurzen Kanten
      const kanten = p.map((a, i) => { const b = p[(i + 1) % p.length]; return { a, b, l: Math.hypot(b[0] - a[0], b[1] - a[1]) }; })
        .sort((x, y) => x.l - y.l);
      const m1 = [(kanten[0].a[0] + kanten[0].b[0]) / 2, (kanten[0].a[1] + kanten[0].b[1]) / 2];
      const m2 = [(kanten[1].a[0] + kanten[1].b[0]) / 2, (kanten[1].a[1] + kanten[1].b[1]) / 2];
      const len = Math.hypot(m2[0] - m1[0], m2[1] - m1[1]);
      const n = Math.max(1, Math.round(len / abstand));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        punkte.push([m1[0] + (m2[0] - m1[0]) * t, m1[1] + (m2[1] - m1[1]) * t]);
      }
    } else {
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.round(len / abstand);
        for (let k = 0; k < n; k++) punkte.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
      }
    }
  }
  return { punkte, r: groesse / 95 };
}

function zeichnungMitLicht(v, licht, dichte = 22) {
  let svg = zeichnungSVG(v, M, { linie: 200 });
  const hatFlamme = (v.teile || []).some((t) => t.flamme && !t.nurMitLicht);
  if (licht && !hatFlamme && !(v.teile || []).some((t) => t.nurMitLicht)) {
    const { punkte, r } = birnenPunkte(v, dichte);
    const b = punkte.map(([x, y], i) => `<circle class="birne" cx="${x.toFixed(1)}" cy="${(-y).toFixed(1)}" r="${r.toFixed(1)}" style="--d:${(i % 7) * 0.4}s"/>`).join("");
    svg = svg.replace("</svg>", `${b}</svg>`);
  }
  return svg;
}

// ---------- Startbild ----------
function startbild() {
  const box = document.getElementById("start-bild");
  const p = produkte.find((x) => x.id === "holzstern");
  if (!box || !p) return;
  const v = p.varianten.find((x) => x.id === "xxl") || p.varianten[p.varianten.length - 1];
  const tmp = { ...v, teile: v.teile.filter((t) => !/stütz/i.test(t.name)) };
  const html = zeichnungMitLicht(tmp, true, 13);
  box.insertAdjacentHTML("afterbegin", html);
}

// ---------- Produktkarten ----------
function nachricht(p, v, licht) {
  const preis = licht ? v.preis.mit : v.preis.ohne;
  const groesse = p.varianten.length > 1 ? ` ${v.name}` : "";
  const lt = p.lichtText || "mit Beleuchtung";
  const mit = v.licht && v.licht.length ? (licht ? ` ${lt}` : ` ${lt.replace(/^mit /, "ohne ")}`) : "";
  return `Moin Jan! Ich interessiere mich für: ${p.name}${groesse}${mit} (${preis} €). Wann könntest du das bauen?`;
}

function karten() {
  document.querySelectorAll(".karte").forEach((karte) => {
    const p = produkte.find((x) => x.id === karte.dataset.id);
    if (!p) return;
    let v = p.varianten[0];
    let licht = false;
    const bild = karte.querySelector(".karte-bild");
    const preisEl = karte.querySelector("[data-preis]");
    const masseEl = karte.querySelector("[data-masse]");
    const schalter = karte.querySelector(".schalter");
    const lichtInput = karte.querySelector("[data-licht]");
    const anfrage = karte.querySelector("[data-anfrage]");

    function aktualisieren() {
      if (!p.foto) {
        bild.querySelector(".zeichnung")?.remove();
        bild.insertAdjacentHTML("afterbegin", zeichnungMitLicht(v, licht));
      }
      const hatLicht = v.licht && v.licht.length && v.preis.mit !== v.preis.ohne;
      schalter.classList.toggle("versteckt", !hatLicht);
      if (!hatLicht) { licht = false; lichtInput.checked = false; }
      preisEl.textContent = `${licht ? v.preis.mit : v.preis.ohne} €`;
      masseEl.textContent = v.masse || "";
      anfrage.href = whatsappLink(site.whatsapp, nachricht(p, v, licht));
    }
    karte.querySelectorAll("[data-variante]").forEach((b) => b.addEventListener("click", () => {
      v = p.varianten.find((x) => x.id === b.dataset.variante) || v;
      karte.querySelectorAll("[data-variante]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      aktualisieren();
    }));
    lichtInput.addEventListener("change", () => { licht = lichtInput.checked; aktualisieren(); });
    karte.querySelector("[data-3d]").addEventListener("click", () => oeffne3D(p, v, licht));
    aktualisieren();
  });
}

// ---------- Filter ----------
function filter() {
  const knoepfe = document.querySelectorAll("[data-filter]");
  knoepfe.forEach((b) => b.addEventListener("click", () => {
    knoepfe.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    document.querySelectorAll(".karte").forEach((k) => {
      k.classList.toggle("versteckt", b.dataset.filter !== "alle" && k.dataset.kategorie !== b.dataset.filter);
    });
  }));
}

// ---------- 3D-Fenster ----------
let viewer = null;
async function oeffne3D(p, v, licht) {
  const dlg = document.getElementById("fenster-3d");
  const buehne = document.getElementById("buehne-3d");
  document.getElementById("fenster-titel").textContent = p.varianten.length > 1 ? `${p.name} ${v.name}` : p.name;
  document.getElementById("fenster-unter").textContent = v.masse || "";
  const lichtKnopf = dlg.querySelector("[data-licht-3d]");
  const hatLicht = (v.licht && v.licht.length) || (v.teile || []).some((t) => t.flamme);
  lichtKnopf.classList.toggle("versteckt", !hatLicht);
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  document.body.style.overflow = "hidden";
  try {
    const { erstelleViewer } = await import("./modell3d.js");
    if (!viewer) viewer = erstelleViewer(buehne);
    viewer.zeige(v, M, { licht });
    lichtKnopf.textContent = licht ? "Licht aus" : "Licht an";
  } catch (e) {
    console.error(e);
    buehne.innerHTML = `<div class="lade">Die 3D-Ansicht konnte nicht geladen werden. Bitte später noch einmal versuchen.</div>`;
  }
}
function fenster3D() {
  const dlg = document.getElementById("fenster-3d");
  const zu = () => {
    if (dlg.open) dlg.close ? dlg.close() : dlg.removeAttribute("open");
  };
  dlg.querySelector("[data-schliessen]").addEventListener("click", zu);
  dlg.addEventListener("close", () => {
    document.body.style.overflow = "";
    if (viewer) { viewer.dispose(); viewer = null; }
  });
  dlg.querySelector("[data-licht-3d]").addEventListener("click", (e) => {
    if (!viewer) return;
    viewer.licht(!viewer.lichtAn);
    e.currentTarget.textContent = viewer.lichtAn ? "Licht aus" : "Licht an";
  });
  dlg.querySelector("[data-ansicht]").addEventListener("click", () => viewer && viewer.ansicht("vorne"));
}

// ---------- Start ----------
lichterkette();
startbild();
karten();
filter();
fenster3D();
const kontakt = document.getElementById("kontakt-knopf");
if (kontakt) kontakt.href = whatsappLink(site.whatsapp, "Moin Jan! Ich habe eine Frage zu deiner Holzdeko:");
let breite = window.innerWidth;
window.addEventListener("resize", () => {
  if (Math.abs(window.innerWidth - breite) > 60) { breite = window.innerWidth; document.getElementById("lichterkette").classList.remove("an"); lichterkette(); }
});
