# Jans Holzstube

Handgebaute Holzdeko aus der Nachbarschaft – öffentliche Seite mit 3D-Modellen und eine Werkstatt mit Bauplänen, Einkaufsliste und Zuschnitt.

Gebaut mit [Eleventy](https://www.11ty.dev/) (erzeugt einfache HTML-Seiten) und [three.js](https://threejs.org/) für die 3D-Ansicht.

## Seiten

| Seite | Wofür |
| --- | --- |
| `index.html` | Öffentliche Seite für die Nachbarn: Produkte, Preise, Liefertermine, Anfrage per WhatsApp |
| `werkstatt.html` | Dein Bereich (Login): Planen, Einkauf & Zuschnitt, Baupläne, Produkte, Material, Einstellungen |
| `impressum.html` | Impressum |

## Wo steht was?

```
src/
  _data/
    produkte.json   ← alle Produkte, Varianten, Teile mit 3D-Positionen, Schritte
    material.json   ← Material mit Preisen (Latten, Platten, Schrauben, Lichterketten …)
    site.json       ← Texte der Seite, WhatsApp-Nummer, Liefertermine, Impressum, Login
    bauliste.json   ← was du gerade bauen willst (Mengen)
  assets/
    css/stil.css
    js/bauplan.js   ← Berechnungen: Stückliste, Einkaufsliste, Zuschnitt, Kosten, Zeichnung
    js/modell3d.js  ← 3D-Ansicht
    js/shop.js      ← öffentliche Seite
    js/werkstatt.js ← Werkstatt
    js/github.js    ← Speichern ins Repo
    img/produkte/   ← Fotos (landen hier automatisch, wenn du sie in der Werkstatt hochlädst)
  index.njk, werkstatt.njk, impressum.njk
.github/workflows/deploy.yml  ← baut und veröffentlicht die Seite bei jeder Änderung
```

Normalerweise musst du keine Datei von Hand anfassen – alles geht über die Werkstatt.

## Einrichtung (einmalig)

1. **GitHub Pages einschalten:** Im Repo → *Settings* → *Pages* → bei *Source* „**GitHub Actions**“ wählen.
   - Privates Repo: Pages geht nur mit GitHub Pro. Als Schüler bekommst du das kostenlos über das [GitHub Student Developer Pack](https://education.github.com/pack). Bis zur Freischaltung kannst du das Repo öffentlich lassen – es liegt nichts Geheimes darin.
2. Nach der ersten Änderung baut GitHub die Seite (Tab *Actions*, dauert ca. 1–2 Minuten). Die Adresse steht dann unter *Settings → Pages*, z. B. `https://DEINNAME.github.io/holzstube/`.
3. **Werkstatt öffnen:** `…/werkstatt.html`, Login mit `Jan` / `1234`.
4. **Token anlegen**, damit die Werkstatt speichern kann: github.com → Profilbild → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*. Nur dieses Repo auswählen, bei *Repository permissions* **Contents: Read and write**. Den Token in der Werkstatt unter *Einstellungen* eintragen.
5. In den Einstellungen deine **WhatsApp-Nummer** und das **Impressum** eintragen und speichern.

## So arbeitest du damit

- **Planen:** Anzahl pro Produkt und Variante eintragen (mit/ohne Licht).
- **Einkauf & Zuschnitt:** fertige Einkaufsliste mit Kostenschätzung, Schnittplan für jede Latte und Platte, Stückliste. Drucken/PDF, als CSV oder über *Teilen* direkt in Notizen/WhatsApp.
- **Baupläne:** Zeichnung mit Maßen, 3D-Modell, Stückliste, Kleinteile, Bauschritte, Materialkosten und Preisvorschlag.
- **Produkte:** neue Produkte anlegen, Teile mit Maßen eintragen, Foto hochladen. Wenn du bei einem Teil 3D-Positionen einträgst, entsteht daraus das 3D-Modell; ohne Positionen werden die Teile nebeneinander ausgelegt.
- **Material & Preise:** Baumarktpreise anpassen – alle Kosten rechnen sich neu.
- **Speichern** (oben rechts) schreibt alle Änderungen in einem Commit ins Repo. Bis dahin bleiben sie auf deinem Gerät gespeichert.

### 3D-Positionen

Maße in Millimetern. `x` = nach rechts, `y` = nach oben (Boden = 0), `z` = nach vorne. Jedes Teil liegt erst flach auf der x-Achse (Länge = x, Breite = y, Dicke = z). Drehung in Grad: zuerst `rx` (um die eigene Längsachse, 90 = hochkant), dann `ry`, dann `rz` (90 = senkrecht).

## Lokal testen (optional, nicht nötig auf dem iPad)

```
npm install
npm start
```
