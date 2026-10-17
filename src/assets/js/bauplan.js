// Jans Holzstube – Berechnungen: Stückliste, Einkaufsliste, Zuschnitt, Kosten, 2D-Zeichnung.
// Reine Funktionen ohne Seitenbezug, werden von Shop und Werkstatt genutzt.

export const euro = (v) =>
  (Math.round((v || 0) * 100) / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

export const mm = (v) => `${Math.round(v)} mm`;

export function materialMap(materialDaten) {
  const map = {};
  for (const m of materialDaten.materialien || []) map[m.id] = m;
  return map;
}

export function teilAnzahl(t) {
  if (Array.isArray(t.instanzen) && t.instanzen.length) return t.instanzen.length;
  return Number(t.anzahl) || 0;
}

export function findeVariante(produkte, pid, vid) {
  const p = produkte.find((x) => x.id === pid);
  if (!p) return {};
  const v = p.varianten.find((x) => x.id === vid) || p.varianten[0];
  return { p, v };
}

// ---------- Maße eines Teils ----------
function polygonFlaeche(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}
function polygonUmfang(pts) {
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    u += Math.hypot(x2 - x1, y2 - y1);
  }
  return u;
}
function profilBox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Abmessungen in lokalen Achsen: X = Länge, Y = Breite, Z = Dicke
export function teilMasse(t, M) {
  const m = M[t.material] || {};
  if (t.profil && t.profil.length > 2) {
    const b = profilBox(t.profil);
    return { L: b.w, B: b.h, D: m.dicke || 18 };
  }
  if (m.typ === "platte") return { L: +t.laenge || 0, B: +t.breite || 0, D: m.dicke || 18 };
  return { L: +t.laenge || 0, B: m.breite || 40, D: m.dicke || 20 };
}

export function teilOberflaeche(t, M) {
  const { L, B, D } = teilMasse(t, M);
  if (t.profil && t.profil.length > 2) return 2 * polygonFlaeche(t.profil) + polygonUmfang(t.profil) * D;
  return 2 * (L * B + L * D + B * D);
}

// ---------- Auftrag -> Einzelteile ----------
// auftraege: [{produkt, variante, licht, anzahl}]
export function sammleTeile(auftraege, produkte, M) {
  const zeilen = [];
  for (const a of auftraege) {
    const n = Number(a.anzahl) || 0;
    if (n <= 0) continue;
    const { p, v } = findeVariante(produkte, a.produkt, a.variante);
    if (!v) continue;
    zeilen.push({ p, v, n, licht: !!a.licht });
  }
  return zeilen;
}

export function stueckliste(auftraege, produkte, M) {
  const rows = new Map();
  for (const { p, v, n } of sammleTeile(auftraege, produkte, M)) {
    for (const t of v.teile || []) {
      if (t.nurModell || !M[t.material]) continue;
      const k = teilAnzahl(t) * n;
      const mat = M[t.material];
      const dims = mat.typ === "platte" ? `${t.laenge} × ${t.breite}` : `${t.laenge}`;
      const key = `${t.material}|${dims}|${t.zuschnitt || ""}|${p.id}|${t.name}`;
      const r = rows.get(key) || { produkt: p.name, variante: v.name, teil: t.name, material: mat.name, materialId: t.material,
        masse: dims, zuschnitt: t.zuschnitt || "", anzahl: 0, profil: !!t.profil };
      r.anzahl += k;
      rows.set(key, r);
    }
  }
  return [...rows.values()];
}

// ---------- Zuschnitt ----------
function zuschnittLinear(stuecke, laenge, saege) {
  const sorted = [...stuecke].sort((a, b) => b.l - a.l);
  const stangen = [];
  const zuLang = [];
  for (const s of sorted) {
    if (s.l > laenge) { zuLang.push(s); continue; }
    let st = stangen.find((x) => x.rest >= s.l + (x.schnitte.length ? saege : 0));
    if (!st) { st = { schnitte: [], rest: laenge }; stangen.push(st); }
    st.rest -= s.l + (st.schnitte.length ? saege : 0);
    st.schnitte.push(s);
  }
  return { stangen, zuLang };
}

function zuschnittPlatte(stuecke, W, H, saege) {
  // Regal-Verfahren (Streifen): Teile werden so gedreht, dass sie flach liegen
  const teile = stuecke.map((s) => {
    let w = Math.max(s.w, s.h), h = Math.min(s.w, s.h);
    if (w > W) [w, h] = [h, w];
    return { ...s, w, h };
  }).sort((a, b) => b.h - a.h || b.w - a.w);
  const platten = [];
  const zuGross = [];
  for (const t of teile) {
    if ((t.w > W || t.h > H) && (t.h > W || t.w > H)) { zuGross.push(t); continue; }
    let gesetzt = false;
    for (const pl of platten) {
      pl.streifen.forEach((st, si) => {
        const letzter = si === pl.streifen.length - 1;
        for (const [w, h, gedreht] of [[t.w, t.h, false], [t.h, t.w, true]]) {
          if (gesetzt || st.x + w > W) continue;
          // passt in den Streifen – oder der letzte Streifen darf nach unten wachsen
          if (h <= st.h || (letzter && st.y + h <= H)) {
            if (h > st.h) { st.h = h; pl.yFrei = st.y + h + saege; }
            pl.teile.push({ ...t, x: st.x, y: st.y, w, h, gedreht });
            st.x += w + saege;
            gesetzt = true;
          }
        }
      });
      if (!gesetzt) {
        const y = pl.streifen.length ? pl.yFrei : 0;
        if (y + t.h <= H && t.w <= W) {
          pl.streifen.push({ y, h: t.h, x: t.w + saege });
          pl.yFrei = y + t.h + saege;
          pl.teile.push({ ...t, x: 0, y, w: t.w, h: t.h });
          gesetzt = true;
        }
      }
      if (gesetzt) break;
    }
    if (!gesetzt) {
      const pl = { streifen: [], teile: [], yFrei: 0 };
      if (t.w <= W && t.h <= H) {
        pl.streifen.push({ y: 0, h: t.h, x: t.w + saege });
        pl.yFrei = t.h + saege;
        pl.teile.push({ ...t, x: 0, y: 0, w: t.w, h: t.h });
      } else {
        pl.streifen.push({ y: 0, h: t.w, x: t.h + saege });
        pl.yFrei = t.w + saege;
        pl.teile.push({ ...t, x: 0, y: 0, w: t.h, h: t.w, gedreht: true });
      }
      platten.push(pl);
    }
  }
  return { platten, zuGross };
}

// ---------- Einkaufsliste ----------
export function einkaufsliste(auftraege, produkte, materialDaten) {
  const M = materialMap(materialDaten);
  const saege = Number(materialDaten.saegeschnitt) || 4;
  const linear = {}, platte = {}, stueck = {};
  let lasurFlaeche = 0;
  let stunden = 0, umsatz = 0;

  for (const { p, v, n, licht } of sammleTeile(auftraege, produkte, M)) {
    stunden += (Number(v.stunden) || 0) * n;
    umsatz += (licht ? v.preis?.mit : v.preis?.ohne || 0) * n || 0;
    for (const t of v.teile || []) {
      const m = M[t.material];
      if (t.nurModell || !m) continue;
      const k = teilAnzahl(t) * n;
      for (let i = 0; i < k; i++) {
        const label = `${t.name} (${p.name} ${v.name})`;
        if (m.typ === "linear") (linear[m.id] ||= []).push({ l: +t.laenge, name: t.name, label });
        else if (m.typ === "platte") {
          const d = teilMasse(t, M);
          (platte[m.id] ||= []).push({ w: d.L, h: d.B, name: t.name, label, profil: t.profil });
        }
      }
      if (v.oberflaeche === "lasur") lasurFlaeche += teilOberflaeche(t, M) * k;
    }
    for (const kt of v.kleinteile || []) if (M[kt.material]) stueck[kt.material] = (stueck[kt.material] || 0) + (+kt.anzahl || 0) * n;
    if (licht) for (const l of v.licht || []) if (M[l.material]) stueck[l.material] = (stueck[l.material] || 0) + (+l.anzahl || 0) * n;
  }

  const posten = [];
  const zuschnitt = { linear: [], platten: [] };
  for (const [id, stuecke] of Object.entries(linear)) {
    const m = M[id];
    const z = zuschnittLinear(stuecke, m.laenge, saege);
    const meter = stuecke.reduce((s, x) => s + x.l, 0) / 1000;
    posten.push({ id, name: m.name, benoetigt: `${meter.toFixed(1).replace(".", ",")} m in ${stuecke.length} Stücken`,
      kaufen: z.stangen.length + z.zuLang.length, einheit: `Stück à ${(m.laenge / 1000).toString().replace(".", ",")} m`,
      preis: (z.stangen.length + z.zuLang.length) * m.preis, warnung: z.zuLang.length ? `${z.zuLang.length} Teil(e) länger als ${m.laenge} mm` : "" });
    zuschnitt.linear.push({ id, name: m.name, laenge: m.laenge, ...z });
  }
  for (const [id, stuecke] of Object.entries(platte)) {
    const m = M[id];
    const z = zuschnittPlatte(stuecke, m.laenge, m.breite, saege);
    const flaeche = stuecke.reduce((s, x) => s + x.w * x.h, 0) / 1e6;
    posten.push({ id, name: m.name, benoetigt: `${flaeche.toFixed(2).replace(".", ",")} m² in ${stuecke.length} Teilen`,
      kaufen: z.platten.length + z.zuGross.length, einheit: `Platte ${m.laenge} × ${m.breite} mm`,
      preis: (z.platten.length + z.zuGross.length) * m.preis, warnung: z.zuGross.length ? `${z.zuGross.length} Teil(e) größer als die Platte` : "" });
    zuschnitt.platten.push({ id, name: m.name, W: m.laenge, H: m.breite, ...z });
  }
  for (const [id, anzahl] of Object.entries(stueck)) {
    const m = M[id];
    const pk = Math.max(1, +m.packung || 1);
    const packungen = Math.ceil(anzahl / pk);
    posten.push({ id, name: m.name, benoetigt: `${anzahl} ${m.einheit || "Stück"}`, kaufen: packungen,
      einheit: pk > 1 ? `Packung à ${pk}` : "Stück", preis: packungen * m.preis });
  }
  if (lasurFlaeche > 0) {
    const m = Object.values(M).find((x) => x.typ === "lasur");
    if (m) {
      const qm = lasurFlaeche / 1e6;
      const liter = (qm * (m.anstriche || 2)) / (m.ergiebigkeit || 12);
      const geb = Math.ceil(liter / (m.liter || 0.75));
      posten.push({ id: m.id, name: m.name, benoetigt: `${qm.toFixed(1).replace(".", ",")} m², ${m.anstriche || 2} Anstriche ≈ ${liter.toFixed(2).replace(".", ",")} l`,
        kaufen: geb, einheit: `Dose ${String(m.liter).replace(".", ",")} l`, preis: geb * m.preis });
    }
  }
  const reihenfolge = { linear: 0, platte: 1, lasur: 2, stueck: 3 };
  posten.sort((a, b) => (reihenfolge[M[a.id]?.typ] ?? 9) - (reihenfolge[M[b.id]?.typ] ?? 9));
  const summe = posten.reduce((s, x) => s + x.preis, 0);
  return { posten, zuschnitt, summe, stunden, umsatz };
}

// ---------- Kosten pro Stück (anteilig) ----------
export function kostenVariante(v, materialDaten, licht) {
  const M = materialMap(materialDaten);
  let holz = 0, klein = 0, lichtK = 0, lasur = 0;
  for (const t of v.teile || []) {
    const m = M[t.material];
    if (t.nurModell || !m) continue;
    const k = teilAnzahl(t);
    if (m.typ === "linear") holz += (k * t.laenge / m.laenge) * m.preis * 1.1;
    else if (m.typ === "platte") {
      const d = teilMasse(t, M);
      holz += (k * d.L * d.B / (m.laenge * m.breite)) * m.preis * 1.25;
    }
    if (v.oberflaeche === "lasur") {
      const l = Object.values(M).find((x) => x.typ === "lasur");
      if (l) lasur += (teilOberflaeche(t, M) * k / 1e6) * (l.anstriche || 2) / (l.ergiebigkeit || 12) / (l.liter || 0.75) * l.preis;
    }
  }
  for (const kt of v.kleinteile || []) {
    const m = M[kt.material];
    if (m) klein += (+kt.anzahl / (m.packung || 1)) * m.preis;
  }
  if (licht) for (const l of v.licht || []) {
    const m = M[l.material];
    if (m) lichtK += (+l.anzahl / (m.packung || 1)) * m.preis;
  }
  const material = holz + klein + lichtK + lasur;
  const satz = Number(materialDaten.stundensatz) || 10;
  const arbeit = (Number(v.stunden) || 0) * satz;
  const vorschlag = Math.ceil((material + arbeit) / 5) * 5 - 1;
  return { holz, klein, licht: lichtK, lasur, material, arbeit, vorschlag: Math.max(vorschlag, 1) };
}

// ---------- 2D-Ansicht (von vorne) ----------
function rotMat([rx, ry, rz]) {
  const a = (rx * Math.PI) / 180, b = (ry * Math.PI) / 180, c = (rz * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // R = Rz * Ry * Rx
  return [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
}
function anwenden(R, p, [x, y, z]) {
  return [
    R[0][0] * x + R[0][1] * y + R[0][2] * z + p[0],
    R[1][0] * x + R[1][1] * y + R[1][2] * z + p[1],
    R[2][0] * x + R[2][1] * y + R[2][2] * z + p[2],
  ];
}
function huelle(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const kreuz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && kreuz(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && kreuz(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// Liefert Polygone der Vorderansicht (x, y in mm), sortiert von hinten nach vorne.
export function vorderansicht(v, M) {
  const formen = [];
  const teile = v.teile || [];
  let auslege = 0;
  for (const t of teile) {
    if (t.nurMitLicht) continue;
    const inst = (t.instanzen && t.instanzen.length) ? t.instanzen : null;
    const m = M[t.material] || {};
    let lokal;
    if (t.form === "zylinder") {
      const r = (t.durchmesser || 20) / 2, h = (t.hoehe || 50) / 2;
      lokal = [[-r, -h, -r], [r, -h, -r], [r, h, -r], [-r, h, -r], [-r, -h, r], [r, -h, r], [r, h, r], [-r, h, r]];
      lokal.konkav = null;
    } else if (t.profil && t.profil.length > 2) {
      const d = (m.dicke || 18) / 2;
      lokal = t.profil.flatMap(([x, y]) => [[x, y, -d], [x, y, d]]);
      lokal.konkav = t.profil;
    } else {
      const { L, B, D } = teilMasse(t, M);
      lokal = [];
      for (const x of [-L / 2, L / 2]) for (const y of [-B / 2, B / 2]) for (const z of [-D / 2, D / 2]) lokal.push([x, y, z]);
    }
    const liste = inst || Array.from({ length: teilAnzahl(t) }, (_, i) => {
      const { L, B } = teilMasse(t, M);
      const p = { p: [auslege + L / 2, (B || 40) / 2 + i * ((B || 40) + 20), 0], r: [0, 0, 0] };
      if (i === teilAnzahl(t) - 1) auslege += L + 60;
      return p;
    });
    for (const i of liste) {
      const R = rotMat(i.r || [0, 0, 0]);
      const p = i.p || [0, 0, 0];
      let poly;
      const flachVorne = lokal.konkav && Math.abs(R[2][2]) > 0.99;
      if (flachVorne) poly = lokal.konkav.map(([x, y]) => anwenden(R, p, [x, y, 0]).slice(0, 2));
      else poly = huelle(lokal.map((q) => anwenden(R, p, q).slice(0, 2)));
      const z = anwenden(R, p, [0, 0, 0])[2];
      formen.push({ poly, z, name: t.name, farbe: t.farbe || m.farbe, modell: !!t.nurModell });
    }
  }
  formen.sort((a, b) => a.z - b.z);
  return formen;
}

export function zeichnungSVG(v, M, opt = {}) {
  const formen = vorderansicht(v, M);
  if (!formen.length) return "";
  const xs = formen.flatMap((f) => f.poly.map((q) => q[0])), ys = formen.flatMap((f) => f.poly.map((q) => q[1]));
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  const rand = Math.max(w, h) * (opt.masse ? 0.16 : 0.06);
  const vb = [minX - rand, -(maxY + rand), w + 2 * rand, h + 2 * rand];
  const sw = Math.max(w, h) / (opt.linie || 260);
  const pfade = formen.map((f) => {
    const d = f.poly.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)} ${(-q[1]).toFixed(1)}`).join("") + "Z";
    return `<path d="${d}" class="${f.modell ? "zg-modell" : "zg-teil"}"${opt.farbig ? ` style="fill:${f.farbe || "#c99a5b"}"` : ""}/>`;
  }).join("");
  let masse = "";
  if (opt.masse) {
    const fs = Math.max(w, h) / 22, o = rand * 0.45;
    const yb = -(minY) + o;
    const xr = maxX + o;
    masse = `<g class="zg-mass" style="font-size:${fs.toFixed(0)}px">
      <path d="M${minX} ${yb}H${maxX}M${minX} ${yb - fs / 3}V${yb + fs / 3}M${maxX} ${yb - fs / 3}V${yb + fs / 3}"/>
      <text x="${(minX + maxX) / 2}" y="${yb + fs * 1.15}" text-anchor="middle">${Math.round(w / 10)} cm</text>
      <path d="M${xr} ${-maxY}V${-minY}M${xr - fs / 3} ${-maxY}H${xr + fs / 3}M${xr - fs / 3} ${-minY}H${xr + fs / 3}"/>
      <text x="${xr + fs * 0.5}" y="${-(minY + maxY) / 2}" dominant-baseline="middle" transform="rotate(90 ${xr + fs * 0.5} ${-(minY + maxY) / 2})" text-anchor="middle">${Math.round(h / 10)} cm</text>
    </g>`;
  }
  return `<svg class="zeichnung" viewBox="${vb.map((x) => x.toFixed(1)).join(" ")}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Zeichnung von vorne" style="--zg-sw:${sw.toFixed(2)}px">${pfade}${masse}</svg>`;
}

// ---------- Zuschnittplan als SVG ----------
export function zuschnittSVG(z) {
  const teile = [];
  for (const L of z.linear) {
    const zeilen = L.stangen.map((st, i) => {
      let x = 0;
      const rects = st.schnitte.map((s) => {
        const r = `<g><rect x="${x}" y="0" width="${s.l}" height="60" class="zs-teil"/><text x="${x + s.l / 2}" y="38" text-anchor="middle">${s.l}</text><title>${s.label}</title></g>`;
        x += s.l + 4;
        return r;
      }).join("");
      return `<div class="zs-zeile"><span class="zs-nr">${i + 1}</span><svg viewBox="-2 -2 ${L.laenge + 4} 64" preserveAspectRatio="none" class="zs-stange"><rect x="0" y="0" width="${L.laenge}" height="60" class="zs-rest"/>${rects}</svg><span class="zs-restlabel">Rest ${Math.round(st.rest)} mm</span></div>`;
    }).join("");
    teile.push(`<section class="zs-block"><h4>${L.name}</h4><p class="leise">${L.stangen.length} × ${L.laenge} mm · Schnittbreite eingerechnet</p>${zeilen}${L.zuLang.length ? `<p class="warnung">Zu lang für eine Stange: ${L.zuLang.map((s) => s.label + " " + s.l + " mm").join(", ")}</p>` : ""}</section>`);
  }
  for (const P of z.platten) {
    const svgs = P.platten.map((pl, i) => {
      const rects = pl.teile.map((t) => `<g><rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" class="zs-teil"/><text x="${t.x + t.w / 2}" y="${t.y + t.h / 2}" text-anchor="middle" dominant-baseline="middle">${t.name}${t.profil ? " ✂" : ""} · ${Math.round(Math.max(t.w, t.h))}×${Math.round(Math.min(t.w, t.h))}</text><title>${t.label}</title></g>`).join("");
      return `<figure class="zs-platte"><svg viewBox="-4 -4 ${P.W + 8} ${P.H + 8}"><rect x="0" y="0" width="${P.W}" height="${P.H}" class="zs-rest"/>${rects}</svg><figcaption>Platte ${i + 1}</figcaption></figure>`;
    }).join("");
    teile.push(`<section class="zs-block"><h4>${P.name}</h4><p class="leise">${P.platten.length} Platte(n) ${P.W} × ${P.H} mm · ✂ = Form aussägen (umschließendes Rechteck gezeigt)</p><div class="zs-platten">${svgs}</div>${P.zuGross.length ? `<p class="warnung">Passt auf keine Platte: ${P.zuGross.map((s) => s.label).join(", ")}</p>` : ""}</section>`);
  }
  return teile.join("") || `<p class="leise">Noch nichts geplant.</p>`;
}

// ---------- Export ----------
export function einkaufCSV(ek) {
  const z = [["Material", "Benötigt", "Kaufen", "Einheit", "Preis (geschätzt)"]];
  for (const p of ek.posten) z.push([p.name, p.benoetigt, p.kaufen, p.einheit, p.preis.toFixed(2).replace(".", ",")]);
  z.push(["Summe", "", "", "", ek.summe.toFixed(2).replace(".", ",")]);
  return "﻿" + z.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

export function einkaufText(ek) {
  return ["Einkaufsliste – Jans Holzstube", ""]
    .concat(ek.posten.map((p) => `☐ ${p.kaufen} × ${p.name} (${p.einheit}) – ${p.benoetigt}`))
    .concat(["", `Geschätzt: ${euro(ek.summe)}`]).join("\n");
}

export function whatsappLink(nummer, text) {
  const n = String(nummer || "").replace(/[^0-9]/g, "").replace(/^0/, "49");
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
