// Jans Holzstube – 3D-Ansicht (three.js)
// Baut aus den Teilen eines Produkts (Länge, Breite, Dicke, Position, Drehung) ein Modell.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { teilMasse, teilAnzahl } from "./bauplan.js";

const GRAD = Math.PI / 180;

// ---------- Texturen ----------
let holzTextur = null;
function erzeugeHolzTextur() {
  if (holzTextur) return holzTextur;
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 512, 128);
  // Maserung: viele leicht gewellte Linien in Längsrichtung
  for (let i = 0; i < 70; i++) {
    const y0 = Math.random() * 128;
    const hell = 0.78 + Math.random() * 0.18;
    g.strokeStyle = `rgba(${Math.round(120 * hell)},${Math.round(80 * hell)},${Math.round(40 * hell)},${0.06 + Math.random() * 0.12})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    g.beginPath();
    for (let x = 0; x <= 512; x += 16) {
      const y = y0 + Math.sin(x / (40 + i) + i) * 2.2 + Math.sin(x / 9 + i * 3) * 0.4;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  // ein paar Äste
  for (let i = 0; i < 2; i++) {
    const x = 80 + Math.random() * 350, y = 20 + Math.random() * 88;
    const grad = g.createRadialGradient(x, y, 0, x, y, 9);
    grad.addColorStop(0, "rgba(90,55,25,.55)");
    grad.addColorStop(1, "rgba(90,55,25,0)");
    g.fillStyle = grad;
    g.beginPath(); g.ellipse(x, y, 12, 6, 0, 0, Math.PI * 2); g.fill();
  }
  holzTextur = new THREE.CanvasTexture(c);
  holzTextur.colorSpace = THREE.SRGBColorSpace;
  holzTextur.wrapS = holzTextur.wrapT = THREE.RepeatWrapping;
  holzTextur.anisotropy = 4;
  return holzTextur;
}

let glanzTextur = null;
function erzeugeGlanz() {
  if (glanzTextur) return glanzTextur;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,240,200,1)");
  grad.addColorStop(0.18, "rgba(255,215,130,.85)");
  grad.addColorStop(0.45, "rgba(246,180,80,.25)");
  grad.addColorStop(1, "rgba(246,180,80,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glanzTextur = new THREE.CanvasTexture(c);
  glanzTextur.colorSpace = THREE.SRGBColorSpace;
  return glanzTextur;
}

// ---------- Viewer ----------
export function erstelleViewer(container, optionen = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.querySelectorAll(".lade").forEach((e) => e.remove());
  container.appendChild(renderer.domElement);

  const szene = new THREE.Scene();
  const kamera = new THREE.PerspectiveCamera(35, 1, 1, 100000);
  const steuerung = new OrbitControls(kamera, renderer.domElement);
  steuerung.enableDamping = true;
  steuerung.dampingFactor = 0.08;
  steuerung.maxPolarAngle = Math.PI * 0.53;
  steuerung.autoRotate = optionen.drehen !== false;
  steuerung.autoRotateSpeed = 0.7;
  steuerung.addEventListener("start", () => { steuerung.autoRotate = false; });

  const himmel = new THREE.HemisphereLight(0xfff3e0, 0x1a2d22, 1.1);
  szene.add(himmel);
  const sonne = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sonne.castShadow = true;
  sonne.shadow.mapSize.set(2048, 2048);
  sonne.shadow.bias = -0.0004;
  szene.add(sonne, sonne.target);
  const fuell = new THREE.DirectionalLight(0xbfd8ff, 0.5);
  szene.add(fuell);

  const boden = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.ShadowMaterial({ opacity: 0.38 }));
  boden.rotation.x = -Math.PI / 2;
  boden.receiveShadow = true;
  szene.add(boden);

  let modell = new THREE.Group();
  let lichter = new THREE.Group();
  let flammen = new THREE.Group();
  szene.add(modell, lichter, flammen);
  let punktLichter = [];
  let lichtAn = false;
  let groesse = 1000, mitte = new THREE.Vector3();
  let laeuft = true;
  let zeit = 0;

  function leeren(gruppe) {
    gruppe.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== geteilt.birne && o.material !== geteilt.glanz) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    gruppe.clear();
  }

  const geteilt = {
    birne: new THREE.MeshBasicMaterial({ color: 0xffe9b5 }),
    glanz: new THREE.SpriteMaterial({ map: erzeugeGlanz(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  };

  function holzMaterial(farbe, geflammt, profil) {
    const tex = erzeugeHolzTextur().clone();
    tex.needsUpdate = true;
    if (profil) tex.repeat.set(1 / 500, 1 / 160);
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(geflammt ? "#5b4330" : farbe || "#c99a5b"),
      map: tex, roughness: geflammt ? 0.95 : 0.78, metalness: 0,
    });
    return m;
  }

  // Punkte für die Lichterkette eines Teils (lokal) – immer auf der Seite, die nach vorne zeigt
  function lichtPunkte(t, M, abstand, mesh) {
    const { L, B, D } = teilMasse(t, M);
    const yW = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
    const zW = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
    const spalt = abstand * 0.06;
    let off;
    const istPlatte = t.profil && t.profil.length > 2 && (M[t.material] || {}).typ !== "linear";
    if (istPlatte) off = [0, 0, Math.sign(zW.z || 1) * (D / 2 + spalt)];
    else if (Math.abs(yW.z) > Math.abs(zW.z)) off = [0, Math.sign(yW.z) * (B / 2 + spalt), 0];
    else off = [0, 0, Math.sign(zW.z || 1) * (D / 2 + spalt)];
    const pts = [];
    if (istPlatte) {
      const p = t.profil;
      for (let i = 0; i < p.length; i++) {
        const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
        const len = Math.hypot(x2 - x1, y2 - y1);
        const n = Math.max(1, Math.floor(len / abstand));
        for (let k = 0; k < n; k++) pts.push([x1 + (x2 - x1) * (k / n), y1 + (y2 - y1) * (k / n), off[2]]);
      }
    } else {
      const n = Math.max(1, Math.floor((L - abstand * 0.5) / abstand));
      for (let k = 0; k <= n; k++) pts.push([-L / 2 + abstand * 0.25 + (k * (L - abstand * 0.5)) / n, off[1], off[2]]);
    }
    return pts;
  }

  function zeige(v, M, opt = {}) {
    leeren(modell); leeren(lichter); leeren(flammen);
    punktLichter.forEach((l) => szene.remove(l));
    punktLichter = [];
    if (!v) return;
    const geflammt = v.oberflaeche === "geflammt";
    const matCache = {};
    const hatFlammen = (v.teile || []).some((t) => t.flamme);
    let auslege = 0;
    const lichtOrte = [];

    for (const t of v.teile || []) {
      const m = M[t.material] || {};
      let geo, mat;
      if (t.form === "zylinder") {
        const r = (t.durchmesser || 20) / 2;
        geo = new THREE.CylinderGeometry(r, r, t.hoehe || 50, 28);
        mat = new THREE.MeshStandardMaterial({
          color: t.farbe || "#eeeeee", roughness: t.glas ? 0.1 : 0.55,
          transparent: !!t.glas, opacity: t.glas ? 0.35 : 1,
        });
      } else if (t.profil && t.profil.length > 2 && m.typ === "linear") {
        // Latte mit schrägen Enden: Profil in Länge × Dicke, extrudiert über die Breite
        const form = new THREE.Shape(t.profil.map(([x, y]) => new THREE.Vector2(x, y)));
        const B = m.breite || 48;
        geo = new THREE.ExtrudeGeometry(form, { depth: B, bevelEnabled: false });
        geo.translate(0, 0, -B / 2);
        geo.rotateX(Math.PI / 2);
        geo.computeVertexNormals();
        const key = (t.material || "x") + (t.farbe || "") + "-latte";
        mat = matCache[key] ||= holzMaterial(t.farbe || m.farbe, geflammt, true);
      } else if (t.profil && t.profil.length > 2) {
        const form = new THREE.Shape(t.profil.map(([x, y]) => new THREE.Vector2(x, y)));
        const D = m.dicke || 18;
        geo = new THREE.ExtrudeGeometry(form, { depth: D, bevelEnabled: false });
        geo.translate(0, 0, -D / 2);
        mat = holzMaterial(t.farbe || m.farbe, geflammt, true);
      } else {
        const { L, B, D } = teilMasse(t, M);
        if (!L || !B || !D) continue;
        geo = new THREE.BoxGeometry(L, B, D);
        const key = (t.material || "x") + (t.farbe || "");
        mat = matCache[key] ||= holzMaterial(t.farbe || m.farbe, geflammt, false);
        // Maserung passend zur Länge strecken
        if (mat.map) mat.map.repeat.set(1, 1);
      }
      const liste = (t.instanzen && t.instanzen.length) ? t.instanzen : Array.from({ length: teilAnzahl(t) }, (_, i) => {
        const { L, B, D } = teilMasse(t, M);
        const p = { p: [auslege + L / 2, D / 2, i * ((B || 40) + 20)], r: [90, 0, 0] };
        if (i === teilAnzahl(t) - 1) auslege += L + 60;
        return p;
      });
      for (const i of liste) {
        const mesh = new THREE.Mesh(geo, mat);
        if (t.nurMitLicht) mesh.userData.nurMitLicht = true;
        const [x, y, z] = i.p || [0, 0, 0];
        const [rx, ry, rz] = i.r || [0, 0, 0];
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx * GRAD, ry * GRAD, rz * GRAD, "ZYX");
        mesh.castShadow = !t.glas;
        mesh.receiveShadow = true;
        mesh.userData.teil = t;
        modell.add(mesh);
        if (t.flamme) {
          const top = new THREE.Vector3(0, (t.hoehe || 20) / 2 + 9, 0).applyEuler(mesh.rotation).add(mesh.position);
          lichtOrte.push({ pos: top, flamme: true });
        } else if (!hatFlammen && !t.nurModell && m.typ !== undefined) {
          lichtOrte.push({ teil: t, mesh });
        }
      }
    }

    // Größe bestimmen, Kamera und Licht ausrichten
    const box = new THREE.Box3().setFromObject(modell);
    if (box.isEmpty()) return;
    box.getCenter(mitte);
    const s = new THREE.Vector3();
    box.getSize(s);
    groesse = Math.max(s.x, s.y, s.z, 200);
    boden.scale.setScalar(groesse * 2.2);
    boden.position.set(mitte.x, Math.min(box.min.y, 0) - 0.5, mitte.z);
    sonne.position.set(mitte.x - groesse * 0.8, mitte.y + groesse * 1.6, mitte.z + groesse * 1.2);
    sonne.target.position.copy(mitte);
    const sc = sonne.shadow.camera;
    sc.left = sc.bottom = -groesse * 1.2; sc.right = sc.top = groesse * 1.2;
    sc.near = 1; sc.far = groesse * 5;
    sc.updateProjectionMatrix();
    fuell.position.set(mitte.x + groesse, mitte.y + groesse * 0.4, mitte.z - groesse);
    kamera.near = groesse / 100; kamera.far = groesse * 40;
    steuerung.target.copy(mitte);
    steuerung.minDistance = groesse * 0.6;
    steuerung.maxDistance = groesse * 6;
    if (!opt.kameraBehalten) setzeAnsicht("schraeg");

    // Lichterkette vorbereiten
    const abstand = Math.max(40, Math.min(110, groesse / 18));
    const birnenGeo = new THREE.SphereGeometry(groesse / 260 + 2, 10, 8);
    for (const o of lichtOrte) {
      if (o.flamme) {
        const fl = new THREE.Mesh(new THREE.ConeGeometry(5, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
        fl.position.copy(o.pos);
        const gl = new THREE.Sprite(geteilt.glanz);
        gl.scale.setScalar(60);
        gl.position.copy(o.pos);
        flammen.add(fl, gl);
        continue;
      }
      o.mesh.updateMatrixWorld();
      for (const p of lichtPunkte(o.teil, M, abstand, o.mesh)) {
        const w = new THREE.Vector3(...p).applyMatrix4(o.mesh.matrixWorld);
        const b = new THREE.Mesh(birnenGeo, geteilt.birne);
        b.position.copy(w);
        const g = new THREE.Sprite(geteilt.glanz);
        g.scale.setScalar(abstand * 0.85);
        g.position.copy(w);
        g.userData.phase = Math.random() * Math.PI * 2;
        lichter.add(b, g);
      }
    }
    const anz = flammen.children.length ? Math.min(4, flammen.children.length / 2) : 3;
    for (let k = 0; k < anz; k++) {
      const pl = new THREE.PointLight(0xffb85c, 0, groesse * 3, 1.6);
      if (flammen.children.length) {
        pl.position.copy(flammen.children[k * 2].position).add(new THREE.Vector3(0, 60, 80));
        pl.userData.basis = 5000;
      } else {
        pl.position.set(mitte.x + (k - 1) * s.x * 0.35, mitte.y + (k === 1 ? s.y * 0.2 : -s.y * 0.1), mitte.z + Math.max(s.z, 60) * 1.2);
        pl.userData.basis = (Math.pow(groesse, 1.6) * 1.5) / anz;
      }
      szene.add(pl);
      punktLichter.push(pl);
    }
    setzeLicht(lichtAn || !!opt.licht);
  }

  function setzeAnsicht(art) {
    const fov = kamera.fov * GRAD;
    const dist = (groesse / (2 * Math.tan(fov / 2))) * 1.55;
    if (art === "vorne") kamera.position.set(mitte.x, mitte.y + groesse * 0.04, mitte.z + dist);
    else kamera.position.set(mitte.x + dist * 0.55, mitte.y + dist * 0.32, mitte.z + dist * 0.8);
    kamera.lookAt(mitte);
    steuerung.update();
  }

  function setzeLicht(an) {
    lichtAn = an;
    lichter.visible = an;
    flammen.visible = an;
    himmel.intensity = an ? 0.18 : 1.1;
    sonne.intensity = an ? 0.25 : 2.4;
    fuell.intensity = an ? 0.08 : 0.5;
    renderer.toneMappingExposure = an ? 1.25 : 1.05;
    punktLichter.forEach((pl) => (pl.intensity = an ? pl.userData.basis : 0));
    modell.children.forEach((o) => { if (o.userData.nurMitLicht) o.visible = an; });
    container.classList.toggle("nacht", an);
  }

  function groesseAnpassen() {
    const w = container.clientWidth || 300, h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    kamera.aspect = w / h;
    kamera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(groesseAnpassen);
  ro.observe(container);
  groesseAnpassen();

  function schleife(t) {
    if (!laeuft) return;
    requestAnimationFrame(schleife);
    zeit = t / 1000;
    if (lichtAn) {
      flammen.children.forEach((f, i) => { if (!f.isSprite) f.scale.y = 1 + Math.sin(zeit * 9 + i) * 0.12; });
      punktLichter.forEach((pl, i) => (pl.intensity = pl.userData.basis * (0.92 + 0.08 * Math.sin(zeit * 3 + i * 2))));
    }
    steuerung.update();
    renderer.render(szene, kamera);
  }
  requestAnimationFrame(schleife);

  return {
    zeige,
    licht: (an) => setzeLicht(an),
    get lichtAn() { return lichtAn; },
    ansicht: setzeAnsicht,
    dispose() {
      laeuft = false;
      ro.disconnect();
      steuerung.dispose();
      leeren(modell); leeren(lichter); leeren(flammen);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
