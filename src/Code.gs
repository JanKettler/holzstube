/**
 * SG Barnstorf Weihnachtsmarkt - Backend (Google Apps Script Web-App), Version 11
 *
 * Blatt "AppState": Zelle A1 = Inventar (JSON, wie bisher, jetzt mit IDs).
 * Blatt "Kasse":    ein gemeinsamer Zaehler je Tag/Produkt + Einstellungen (Preise, Standgebuehr, Spendenente).
 * Blatt "Protokoll": wer hat wann was geaendert.  Blatt "Sicherung": taegliche Sicherungen des Datenstands.
 * Blatt "Buchungen": jede Kassen-Buchung mit Uhrzeit (fuer die Verkaeufe pro Stunde).
 * Blatt "Zugang":   Rollen, Benutzer und Anmelde-Sitzungen (Passwoerter nur als Pruefwert).
 * Blatt "Listen":   Ausgaben, Boxen, Strom-Plan, Aufbau, Aushang-Listen.
 * Blatt "Bilder":   Aushang-Bilder (Samstag/Sonntag), in Stuecke geteilt.
 *
 * Fehlende Blaetter legt das Script beim ersten Zugriff selbst an.
 * Test im Browser: <Web-App-URL>?action=ping  ->  {"status":"ok","version":11}
 */

var SHEET_STATE = 'AppState';
var SHEET_KASSE = 'Kasse';
var SHEET_LISTEN = 'Listen';
var SHEET_BILDER = 'Bilder';
var SHEET_ZUGANG = 'Zugang';
var SHEET_LOG = 'Protokoll';
var SHEET_SICHERUNG = 'Sicherung';
var SHEET_BUCHUNGEN = 'Buchungen';
var CHUNK_SIZE = 45000;          // Zellenlimit in Google Sheets: 50.000 Zeichen
var MAX_IMAGE_CHARS = 2500000;
var MAX_STATE_CHARS = 49500;
var MAX_LIST_ITEMS = 300;
var IMAGE_NAMES = ['samstag', 'sonntag'];
var DAYS = ['samstag', 'sonntag'];
var PRODUCTS = ['waffel', 'kinderpunsch'];
var TYPES = ['paid', 'free'];
var INV_FIELDS = ['name', 'sub', 'bedarf', 'lager', 'status', 'wer', 'verantwortlich', 'empfaenger', 'pack', 'box', 'einheit', 'packung', 'laden', 'preis', 'einkauf', 'watt', 'wattMax', 'dosen', 'kaufPackungen', 'packEinheit', 'lagerAus'];
var NUM_FIELDS = ['bedarf', 'lager', 'preis', 'packung', 'watt', 'wattMax', 'dosen', 'kaufPackungen'];

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------- GET ---------------------------- */

function doGet(e) {
  autoSetup_();
  MEMO_ = {};
  try { return doGetInner_(e); } finally { MEMO_ = null; }
}
function doGetInner_(e) {
  var p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'ping':
        return json_({ status: 'ok', version: 11 });
      case 'start':
        return json_(start_(p));
      case 'kasse':
        var Ak = makeActor_(p.token);
        return json_(Ak.check(KASSE_READ_, 'Kasse lesen') ? readKasse_() : deniedKasse_(Ak));
      case 'roles':
        return json_({ roles: publicRoles_(loadRoles_(false)) });
      case 'users':
        return json_(listUsers_(p.token));
      case 'me':
        return json_(me_(p.token));
      case 'catalog':
        return json_({ status: 'success', groups: PERM_CATALOG, sections: PERM_SECTIONS_, core: ADMIN_CORE_PERMS_ });
      case 'verwaltung':
        return json_(verwaltung_(p.token));
      case 'hub':
        return json_(hub_(p.token));
      case 'data':
        return json_(dataGet_(p));
      case 'systems':
        return json_({ status: 'success', systems: systemsFor_(makeActor_(p.token).perms) });
      case 'verify':
        return json_(verify_(p));
      case 'log':
        return json_(readLog_(p));
      case 'hourly':
        return json_(hourly_(p.token));
      case 'status':
        return json_(status_(p.token));
      case 'backups':
        return json_(listBackupsApi_(p.token));
      case 'inventar':
        var Ai = makeActor_(p.token);
        var invOk = Ai.check(INV_READ_, 'Inventar lesen');
        return json_({ state: invOk ? readInventar_() : invHidden_(), denied: !invOk });
      case 'list':
        var Al = makeActor_(p.token);
        return json_(Al.check(LIST_READ_[String(p.name)] || ['system.restore'], 'Liste lesen: ' + str_(p.name, 30)) ? { items: readList_(p.name, false) } : { items: [], denied: true });
      case 'imagemeta':
        var Am = makeActor_(p.token);
        return json_(belegGuard_(p.names, p.token, 'view.statistik') || (imagesReadable_(Am, p.names) ? readImageMeta_(p.names) : {}));
      case 'image':
        var Ag = makeActor_(p.token);
        return json_(belegGuard_(p.name, p.token, 'view.statistik') || (imagesReadable_(Ag, p.name) ? readImage_(p.name) : { status: 'empty' }));
      default:
        // Altes Verhalten: rohes Inventar aus A1
        var data = stateSheet_().getRange('A1').getValue();
        return ContentService.createTextOutput(data || '{}')
          .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}

// Alles, was die App beim Start braucht, in EINER Antwort (spart viele einzelne Abfragen)
function start_(p) {
  MEMO_ = {};
  try {
    var A = makeActor_(p.token);
    var invOk = A.check(INV_READ_, 'Inventar lesen');
    var out = { status: 'success', version: 11, roles: publicRoles_(loadRoles_(false)), kasse: A.check(KASSE_READ_, 'Kasse lesen') ? readKasse_() : deniedKasse_(A), inventar: invOk ? readInventar_() : invHidden_(), lists: {}, denied: { lists: [], inventar: !invOk } };
    if (p.token) out.me = A.s ? { status: 'success', user: A.s.userName, role: { id: A.s.roles[0].id, name: A.s.roles[0].name }, roles: A.s.roles, perms: A.s.perms, systems: systemsFor_(A.s.perms) } : { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
    LIST_NAMES.forEach(function (n) {
      var ok = A.check(LIST_READ_[n] || ['system.restore'], 'Liste lesen: ' + n);
      out.lists[n] = ok ? readList_(n, false) : [];
      if (!ok) out.denied.lists.push(n);
    });
    return out;
  } finally {
    MEMO_ = null;
  }
}

// Katalog aller Rechte mit Beschriftung (fuer die Verwaltung im Hub). Quelle: perms_spec, dieselben Schluessel wie PERM_DEFS.
var PERM_CATALOG = [
 {
  "id": "hub",
  "title": "Systeme (Hub)",
  "system": "hub",
  "perms": [
   {
    "key": "hub.weihnachtsmarkt",
    "label": "Weihnachtsmarkt im Hub anzeigen",
    "def": "ghoa"
   },
   {
    "key": "hub.jugend",
    "label": "Jugend im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.aufgaben",
    "label": "Aufgaben im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.wettkaempfe",
    "label": "Wettkämpfe im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.training",
    "label": "Training im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.veranstaltungen",
    "label": "Veranstaltungen im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.vorstand",
    "label": "Vorstand im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.material",
    "label": "Material im Hub anzeigen",
    "def": "a"
   },
   {
    "key": "hub.abrechnung",
    "label": "Trainerabrechnung im Hub anzeigen",
    "def": "hoa"
   },
   {
    "key": "hub.fahrten",
    "label": "Fahrtenformular im Hub anzeigen",
    "def": "hoa"
   },
   {
    "key": "hub.mitglieder",
    "label": "Mitglieder im Hub anzeigen",
    "def": "oa"
   },
   {
    "key": "hub.trainer",
    "label": "Trainer im Hub anzeigen",
    "def": "hoa"
   },
   {
    "key": "hub.anwesenheit",
    "label": "Anwesenheit im Hub anzeigen",
    "def": "hoa"
   },
   {
    "key": "hub.auswertung",
    "label": "Auswertung im Hub anzeigen",
    "def": "oa"
   },
   {
    "key": "hub.dokumente",
    "label": "Dokumente im Hub anzeigen",
    "def": "hoa"
   }
  ]
 },
 {
  "id": "view",
  "title": "Seiten ansehen",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "view.aushang",
    "label": "Aushang",
    "def": "ghoa"
   },
   {
    "key": "view.inventar",
    "label": "Inventar",
    "def": "hoa"
   },
   {
    "key": "view.verkauf",
    "label": "Kasse",
    "def": "hoa"
   },
   {
    "key": "view.statistik",
    "label": "Statistik",
    "def": "a"
   },
   {
    "key": "view.einkaufsliste",
    "label": "Einkaufsliste",
    "def": "hoa"
   },
   {
    "key": "view.verkabelung",
    "label": "Strom / Verkabelung",
    "def": "hoa"
   },
   {
    "key": "view.leihgaben",
    "label": "Leihgaben",
    "def": "hoa"
   },
   {
    "key": "view.hilfe",
    "label": "Hilfe",
    "def": "ghoa"
   },
   {
    "key": "view.lagerbestand",
    "label": "Lagerbestand",
    "def": "hoa"
   },
   {
    "key": "view.boxen",
    "label": "Boxen",
    "def": "hoa"
   },
   {
    "key": "view.rezepte",
    "label": "Rezepte",
    "def": "hoa"
   },
   {
    "key": "view.aufbau",
    "label": "Aufbau",
    "def": "hoa"
   },
   {
    "key": "view.admin",
    "label": "Admin-Panel",
    "def": "a"
   },
   {
    "key": "view.status",
    "label": "Systemstatus",
    "def": "oa"
   },
   {
    "key": "view.protokoll",
    "label": "Änderungsprotokoll",
    "def": "a"
   }
  ]
 },
 {
  "id": "aushang",
  "title": "Aushang",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "aushang.signup",
    "label": "Sich in Listen eintragen",
    "def": "ghoa"
   },
   {
    "key": "aushang.unsignOthers",
    "label": "Fremde Einträge austragen",
    "def": "oa"
   },
   {
    "key": "aushang.editRows",
    "label": "Zeilen anlegen, bearbeiten, löschen, sortieren",
    "def": "oa"
   },
   {
    "key": "aushang.editTitle",
    "label": "Titel und Datum ändern",
    "def": "oa"
   },
   {
    "key": "aushang.editTeig",
    "label": "Teig-Plätze hinzufügen / entfernen",
    "def": "oa"
   },
   {
    "key": "aushang.print",
    "label": "Aushang drucken (Druckknöpfe sehen)",
    "def": "oa"
   },
   {
    "key": "aushang.editInfo",
    "label": "Infotext oben ändern",
    "def": "oa"
   },
   {
    "key": "aushang.fullNames",
    "label": "Volle Namen in den Listen sehen (sonst nur Vornamen)",
    "def": "hoa"
   },
   {
    "key": "aushang.countdown",
    "label": "Countdown einstellen",
    "def": "a"
   },
   {
    "key": "aushang.upload",
    "label": "Zusatz-Aushang (Scan) hochladen",
    "def": "a"
   }
  ]
 },
 {
  "id": "inventar",
  "title": "Inventar",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "inventar.editBedarf",
    "label": "Bedarf ändern",
    "def": "hoa"
   },
   {
    "key": "inventar.editLager",
    "label": "Lager ändern",
    "def": "hoa"
   },
   {
    "key": "inventar.editStatus",
    "label": "Status ändern",
    "def": "hoa"
   },
   {
    "key": "inventar.editName",
    "label": "Name und Beschreibung ändern",
    "def": "oa"
   },
   {
    "key": "inventar.editMeta",
    "label": "Verantwortlich, Eingepackt und Box ändern",
    "def": "hoa"
   },
   {
    "key": "inventar.cart",
    "label": "Artikel auf die Einkaufsliste setzen / entfernen",
    "def": "hoa"
   },
   {
    "key": "inventar.addItem",
    "label": "Einträge anlegen",
    "def": "oa"
   },
   {
    "key": "inventar.deleteItem",
    "label": "Einträge löschen",
    "def": "oa"
   },
   {
    "key": "inventar.moveItem",
    "label": "Einträge verschieben",
    "def": "oa"
   },
   {
    "key": "inventar.catAdd",
    "label": "Kategorien anlegen",
    "def": "oa"
   },
   {
    "key": "inventar.catEdit",
    "label": "Kategorien bearbeiten und sortieren",
    "def": "oa"
   },
   {
    "key": "inventar.catDelete",
    "label": "Kategorien löschen",
    "def": "oa"
   }
  ]
 },
 {
  "id": "einkauf",
  "title": "Einkaufsliste",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "einkauf.check",
    "label": "Abhaken",
    "def": "hoa"
   },
   {
    "key": "einkauf.editPack",
    "label": "Packungsgröße ändern",
    "def": "hoa"
   },
   {
    "key": "einkauf.editPreis",
    "label": "Preis ändern",
    "def": "hoa"
   },
   {
    "key": "einkauf.editLaden",
    "label": "Laden ändern",
    "def": "hoa"
   },
   {
    "key": "einkauf.addItem",
    "label": "Artikel hinzufügen",
    "def": "hoa"
   },
   {
    "key": "einkauf.removeItem",
    "label": "Artikel von der Liste nehmen",
    "def": "hoa"
   }
  ]
 },
 {
  "id": "rezepte",
  "title": "Rezepte",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "rezepte.calc",
    "label": "Rechner benutzen",
    "def": "hoa"
   },
   {
    "key": "rezepte.toShopping",
    "label": "Rechner-Mengen in die Einkaufsliste übernehmen",
    "def": "hoa"
   },
   {
    "key": "rezepte.add",
    "label": "Rezepte anlegen",
    "def": "oa"
   },
   {
    "key": "rezepte.edit",
    "label": "Rezepte und Zutaten bearbeiten",
    "def": "oa"
   },
   {
    "key": "rezepte.delete",
    "label": "Rezepte löschen",
    "def": "oa"
   }
  ]
 },
 {
  "id": "boxen",
  "title": "Boxen",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "boxen.add",
    "label": "Boxen anlegen",
    "def": "oa"
   },
   {
    "key": "boxen.edit",
    "label": "Boxen bearbeiten",
    "def": "oa"
   },
   {
    "key": "boxen.delete",
    "label": "Boxen löschen",
    "def": "oa"
   }
  ]
 },
 {
  "id": "strom",
  "title": "Strom",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "strom.steckerAdd",
    "label": "Stecker anlegen",
    "def": "oa"
   },
   {
    "key": "strom.steckerEdit",
    "label": "Stecker umbenennen und Dose wählen",
    "def": "oa"
   },
   {
    "key": "strom.steckerDelete",
    "label": "Stecker löschen",
    "def": "oa"
   },
   {
    "key": "strom.plan",
    "label": "Karten verplanen (ziehen)",
    "def": "oa"
   },
   {
    "key": "strom.watt",
    "label": "Watt, Belastbarkeit und Steckplätze je Karte",
    "def": "oa"
   },
   {
    "key": "strom.verteiler",
    "label": "Verteiler einstellen",
    "def": "oa"
   },
   {
    "key": "strom.print",
    "label": "Stromplan drucken",
    "def": "hoa"
   }
  ]
 },
 {
  "id": "aufbau",
  "title": "Aufbau",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "aufbau.check",
    "label": "Schritte abhaken",
    "def": "hoa"
   },
   {
    "key": "aufbau.stepAdd",
    "label": "Schritte anlegen",
    "def": "oa"
   },
   {
    "key": "aufbau.stepEdit",
    "label": "Schritte bearbeiten",
    "def": "oa"
   },
   {
    "key": "aufbau.stepDelete",
    "label": "Schritte löschen",
    "def": "oa"
   },
   {
    "key": "aufbau.noteAdd",
    "label": "Hinweise anlegen",
    "def": "oa"
   },
   {
    "key": "aufbau.noteEdit",
    "label": "Hinweise bearbeiten",
    "def": "oa"
   },
   {
    "key": "aufbau.noteDelete",
    "label": "Hinweise löschen",
    "def": "oa"
   },
   {
    "key": "aufbau.imageAdd",
    "label": "Bilder anlegen",
    "def": "oa"
   },
   {
    "key": "aufbau.imageEdit",
    "label": "Bilder bearbeiten",
    "def": "oa"
   },
   {
    "key": "aufbau.imageDelete",
    "label": "Bilder löschen",
    "def": "oa"
   },
   {
    "key": "aufbau.sort",
    "label": "Einträge sortieren",
    "def": "oa"
   },
   {
    "key": "aufbau.print",
    "label": "Aufbauplan drucken",
    "def": "hoa"
   },
   {
    "key": "skizze.edit",
    "label": "Standskizze verschieben und bearbeiten",
    "def": "oa"
   }
  ]
 },
 {
  "id": "leihgaben",
  "title": "Leihgaben",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "leihgaben.add",
    "label": "Leihgaben anlegen",
    "def": "oa"
   },
   {
    "key": "leihgaben.edit",
    "label": "Leihgaben bearbeiten",
    "def": "oa"
   },
   {
    "key": "leihgaben.delete",
    "label": "Leihgaben löschen",
    "def": "oa"
   },
   {
    "key": "leihgaben.status",
    "label": "Status ändern (besorgt, vor Ort, zurückgegeben)",
    "def": "hoa"
   }
  ]
 },
 {
  "id": "abnahme",
  "title": "Abnahme-Checkliste",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "abnahme.check",
    "label": "Punkte abhaken",
    "def": "oa"
   },
   {
    "key": "abnahme.edit",
    "label": "Punkte anlegen, ändern, löschen",
    "def": "oa"
   },
   {
    "key": "abnahme.sign",
    "label": "Abnahme bestätigen und zurücknehmen",
    "def": "oa"
   }
  ]
 },
 {
  "id": "kasse",
  "title": "Kasse",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "kasse.book",
    "label": "Buchen (inklusive Rückgängig)",
    "def": "hoa"
   },
   {
    "key": "kasse.correct",
    "label": "Verkaufszahlen korrigieren",
    "def": "a"
   },
   {
    "key": "kasse.reset",
    "label": "Tag zurücksetzen",
    "def": "a"
   },
   {
    "key": "kasse.sturz",
    "label": "Kassensturz erfassen",
    "def": "oa"
   },
   {
    "key": "kasse.close",
    "label": "Tag abschließen",
    "def": "oa"
   },
   {
    "key": "kasse.reopen",
    "label": "Abgeschlossenen Tag wieder öffnen",
    "def": "a"
   },
   {
    "key": "kasse.practice",
    "label": "Übungsmodus benutzen",
    "def": "hoa"
   },
   {
    "key": "kasse.report",
    "label": "Tagesbericht drucken",
    "def": "oa"
   }
  ]
 },
 {
  "id": "finance",
  "title": "Finanzen",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "finance.expenseAdd",
    "label": "Ausgaben anlegen",
    "def": "a"
   },
   {
    "key": "finance.expenseDelete",
    "label": "Ausgaben löschen",
    "def": "a"
   },
   {
    "key": "finance.spende",
    "label": "Spendenente eintragen",
    "def": "a"
   },
   {
    "key": "finance.standgebuehr",
    "label": "Standgebühr eintragen",
    "def": "a"
   },
   {
    "key": "finance.prices",
    "label": "Verkaufspreise ändern",
    "def": "a"
   },
   {
    "key": "finance.productAdd",
    "label": "Produkte anlegen",
    "def": "a"
   },
   {
    "key": "finance.productEdit",
    "label": "Produkte bearbeiten",
    "def": "a"
   },
   {
    "key": "finance.productDelete",
    "label": "Produkte löschen",
    "def": "a"
   },
   {
    "key": "finance.teig",
    "label": "Waffeln pro Teig ändern",
    "def": "a"
   },
   {
    "key": "finance.receipt",
    "label": "Belege zu Ausgaben anhängen und entfernen",
    "def": "a"
   },
   {
    "key": "finance.export",
    "label": "Abrechnung als CSV oder PDF ausgeben",
    "def": "a"
   }
  ]
 },
 {
  "id": "system",
  "title": "System",
  "system": "weihnachtsmarkt",
  "perms": [
   {
    "key": "system.roles",
    "label": "Rollen anlegen, umbenennen, löschen",
    "def": "a"
   },
   {
    "key": "system.rechte",
    "label": "Rechte von Rollen ändern",
    "def": "a"
   },
   {
    "key": "system.users",
    "label": "Benutzer anlegen, bearbeiten, löschen",
    "def": "a"
   },
   {
    "key": "system.passwords",
    "label": "Passwörter ändern",
    "def": "a"
   },
   {
    "key": "system.backup",
    "label": "Backup herunterladen und Sicherung erstellen",
    "def": "a"
   },
   {
    "key": "system.restore",
    "label": "Sicherung wiederherstellen",
    "def": "a"
   },
   {
    "key": "system.kiosk",
    "label": "Kiosk-Modus ein- und ausschalten",
    "def": "oa"
   },
   {
    "key": "archiv.view",
    "label": "Saison-Archiv ansehen",
    "def": "a"
   },
   {
    "key": "archiv.create",
    "label": "Saison archivieren",
    "def": "a"
   },
   {
    "key": "archiv.delete",
    "label": "Archiv-Eintrag löschen",
    "def": "a"
   },
   {
    "key": "account.password",
    "label": "Eigenes Passwort ändern (persönliches Konto)",
    "def": "ghoa"
   },
   {
    "key": "system.reset",
    "label": "Saison-Reset",
    "def": "a"
   }
  ]
 },
 {
  "id": "aufgaben",
  "title": "Aufgaben",
  "system": "aufgaben",
  "perms": [
   {
    "key": "aufgaben.view",
    "label": "Alle Aufgaben sehen",
    "def": "a"
   },
   {
    "key": "aufgaben.own",
    "label": "Eigene Aufgaben sehen und abhaken",
    "def": "a"
   },
   {
    "key": "aufgaben.edit",
    "label": "Aufgaben bearbeiten und zuweisen (Sammelrecht, schließt anlegen und löschen ein)",
    "def": "a"
   },
   {
    "key": "aufgaben.anlegen",
    "label": "Aufgaben anlegen",
    "def": "a"
   },
   {
    "key": "aufgaben.loeschen",
    "label": "Aufgaben löschen",
    "def": "a"
   }
  ]
 },
 {
  "id": "wettkaempfe",
  "title": "Wettkämpfe",
  "system": "wettkaempfe",
  "perms": [
   {
    "key": "wettkaempfe.view",
    "label": "Wettkämpfe ansehen",
    "def": "a"
   },
   {
    "key": "wettkaempfe.import",
    "label": "Alles an Wettkämpfen verwalten (Sammelrecht: anlegen, aktualisieren, löschen, Kampfgericht, Artikel)",
    "def": "a"
   },
   {
    "key": "wettkaempfe.anlegen",
    "label": "Meldeergebnis importieren, Wettkampf anlegen und aktualisieren",
    "def": "a"
   },
   {
    "key": "wettkaempfe.loeschen",
    "label": "Wettkämpfe löschen",
    "def": "a"
   },
   {
    "key": "wettkaempfe.zeiten",
    "label": "Alle Zeiten, Zwischenzeiten und Notizen eintragen (Sammelrecht, schließt Vor Ort ein)",
    "def": "a"
   },
   {
    "key": "wettkaempfe.print",
    "label": "Drucken",
    "def": "a"
   },
   {
    "key": "wettkaempfe.check",
    "label": "Checkliste abhaken (Sammelrecht, schließt Meldegeld, Teilnahme und Kampfrichter-Zahlen ein)",
    "def": "oa"
   },
   {
    "key": "wettkaempfe.teilnahme",
    "label": "Teilnahme der Schwimmer festlegen",
    "def": "oa"
   },
   {
    "key": "wettkaempfe.krzahl",
    "label": "Kampfrichter-Zahlen eintragen",
    "def": "oa"
   },
   {
    "key": "wettkaempfe.meldegeld",
    "label": "Meldegeld-Status setzen (offen, Mail versendet, bezahlt)",
    "def": "oa"
   },
   {
    "key": "wettkaempfe.vorort",
    "label": "Vor-Ort-Seite: Zeiten, Zwischenzeiten und Stoppuhr",
    "def": "a"
   },
   {
    "key": "wettkaempfe.kampfgericht",
    "label": "Kampfgericht: Namen eintragen",
    "def": "a"
   },
   {
    "key": "wettkaempfe.artikel",
    "label": "Artikel-Entwurf ansehen",
    "def": "a"
   }
  ]
 },
 {
  "id": "training",
  "title": "Training",
  "system": "training",
  "perms": [
   {
    "key": "training.view",
    "label": "Trainingseinheiten ansehen",
    "def": "a"
   },
   {
    "key": "training.edit",
    "label": "Einheiten bearbeiten (Sammelrecht, schließt anlegen und löschen ein)",
    "def": "a"
   },
   {
    "key": "training.anlegen",
    "label": "Einheiten anlegen",
    "def": "a"
   },
   {
    "key": "training.loeschen",
    "label": "Einheiten löschen",
    "def": "a"
   },
   {
    "key": "training.beobachtung",
    "label": "Beobachtungen ansehen und schreiben (nur Trainer)",
    "def": "a"
   },
   {
    "key": "training.print",
    "label": "Drucken",
    "def": "a"
   },
   {
    "key": "training.mitglieder.view",
    "label": "Mitglieder der Wettkampfgruppe ansehen",
    "def": "a"
   },
   {
    "key": "training.mitglieder.edit",
    "label": "Mitglieder bearbeiten (Sammelrecht, schließt anlegen und löschen ein)",
    "def": "a"
   },
   {
    "key": "training.mitglieder.anlegen",
    "label": "Mitglieder anlegen",
    "def": "a"
   },
   {
    "key": "training.mitglieder.loeschen",
    "label": "Mitglieder löschen",
    "def": "a"
   },
   {
    "key": "training.tage.view",
    "label": "Trainingstage und Anwesenheit ansehen",
    "def": "a"
   },
   {
    "key": "training.tage.edit",
    "label": "Anwesenheit eintragen und Tage bearbeiten (Sammelrecht, schließt anlegen und löschen ein)",
    "def": "a"
   },
   {
    "key": "training.tage.anlegen",
    "label": "Trainingstage anlegen",
    "def": "a"
   },
   {
    "key": "training.tage.loeschen",
    "label": "Trainingstage löschen",
    "def": "a"
   },
   {
    "key": "training.rueckblick",
    "label": "Jahresrückblick ansehen",
    "def": "a"
   }
  ]
 },
 {
  "id": "veranstaltungen",
  "title": "Veranstaltungen",
  "system": "veranstaltungen",
  "perms": [
   {
    "key": "veranstaltungen.view",
    "label": "Veranstaltungen ansehen",
    "def": "a"
   },
   {
    "key": "veranstaltungen.edit",
    "label": "Veranstaltungen, Checklisten und Helfer bearbeiten (Sammelrecht, schließt anlegen und löschen ein)",
    "def": "a"
   },
   {
    "key": "veranstaltungen.anlegen",
    "label": "Veranstaltungen anlegen",
    "def": "a"
   },
   {
    "key": "veranstaltungen.loeschen",
    "label": "Veranstaltungen löschen",
    "def": "a"
   },
   {
    "key": "veranstaltungen.check",
    "label": "Checkliste abhaken und sich als Helfer eintragen",
    "def": "a"
   },
   {
    "key": "veranstaltungen.print",
    "label": "Drucken",
    "def": "a"
   },
   {
    "key": "veranstaltungen.vorlagen",
    "label": "Checklisten-Vorlagen ansehen, anlegen, aus PDF erstellen",
    "def": "a"
   }
  ]
 },
 {
  "id": "vorstand",
  "title": "Vorstand",
  "system": "vorstand",
  "perms": [
   {
    "key": "vorstand.view",
    "label": "Alles im Vorstand ansehen (Sammelrecht)",
    "def": "a"
   },
   {
    "key": "vorstand.edit",
    "label": "Alles im Vorstand bearbeiten (Sammelrecht)",
    "def": "a"
   },
   {
    "key": "vorstand.print",
    "label": "Drucken",
    "def": "a"
   },
   {
    "key": "vorstand.antrag",
    "label": "Eigene Anträge an den Vorstand stellen und ansehen",
    "def": "a"
   },
   {
    "key": "vorstand.antraege.view",
    "label": "Anträge aller ansehen",
    "def": "a"
   },
   {
    "key": "vorstand.antraege.edit",
    "label": "Anträge bearbeiten, Stand ändern, aus PDF anlegen",
    "def": "a"
   },
   {
    "key": "vorstand.sitzungen.view",
    "label": "Sitzungen ansehen",
    "def": "a"
   },
   {
    "key": "vorstand.sitzungen.edit",
    "label": "Sitzungen anlegen und bearbeiten",
    "def": "a"
   },
   {
    "key": "vorstand.protokolle.view",
    "label": "Protokolle ansehen",
    "def": "a"
   },
   {
    "key": "vorstand.protokolle.edit",
    "label": "Protokolle anlegen und bearbeiten",
    "def": "a"
   },
   {
    "key": "vorstand.beschluesse.view",
    "label": "Beschlüsse und Fristen ansehen",
    "def": "a"
   },
   {
    "key": "vorstand.beschluesse.edit",
    "label": "Beschlüsse anlegen, bearbeiten, abhaken",
    "def": "a"
   }
  ]
 },
 {
  "id": "material",
  "title": "Material",
  "system": "material",
  "perms": [
   {
    "key": "material.view",
    "label": "Material ansehen",
    "def": "a"
   },
   {
    "key": "material.edit",
    "label": "Gegenstände bearbeiten (Sammelrecht, schließt anlegen, löschen und Bestand ein)",
    "def": "a"
   },
   {
    "key": "material.anlegen",
    "label": "Gegenstände anlegen",
    "def": "a"
   },
   {
    "key": "material.loeschen",
    "label": "Gegenstände löschen",
    "def": "a"
   },
   {
    "key": "material.ausleihe",
    "label": "Ausleihe und Rückgabe buchen",
    "def": "a"
   },
   {
    "key": "material.bestand",
    "label": "Bestand ändern (Entnahme, Zugang)",
    "def": "a"
   },
   {
    "key": "material.print",
    "label": "Drucken",
    "def": "a"
   }
  ]
 },
 {
  "id": "jugendabz",
  "title": "Abzeichen und Prüfungen",
  "system": "jugend",
  "perms": [
   {
    "key": "jugend.abzeichen.view",
    "label": "Abzeichen ansehen",
    "def": "a"
   },
   {
    "key": "jugend.abzeichen.edit",
    "label": "Abzeichen bearbeiten (Sammelrecht, schließt anlegen und löschen ein)",
    "def": "a"
   },
   {
    "key": "jugend.abzeichen.anlegen",
    "label": "Abzeichen und Prüfungen anlegen",
    "def": "a"
   },
   {
    "key": "jugend.abzeichen.loeschen",
    "label": "Abzeichen und Prüfungen löschen",
    "def": "a"
   }
  ]
 },
 {
  "id": "jugendkasse",
  "title": "Jugendkasse",
  "system": "jugend",
  "perms": [
   {
    "key": "jugend.kasse.view",
    "label": "Jugendkasse ansehen",
    "def": "a"
   },
   {
    "key": "jugend.kasse.buchen",
    "label": "Buchungen und Auslagen eintragen, Kassenstandort ändern, Kassensturz",
    "def": "a"
   },
   {
    "key": "jugend.kasse.bestaetigen",
    "label": "Buchungen und Auslagen bestätigen (nur Sonderrolle „JV | Kasse“)",
    "def": "a"
   },
   {
    "key": "jugend.kasse.verwalten",
    "label": "Kategorien, Budgets, Anfangsbestand und Monatsabschluss",
    "def": "a"
   },
   {
    "key": "jugend.kasse.print",
    "label": "Kassenbuch drucken",
    "def": "a"
   }
  ]
 },
 {
  "id": "abrechnung",
  "title": "Trainerabrechnung",
  "system": "abrechnung",
  "perms": [
   {
    "key": "abrechnung.eigene",
    "label": "Eigene Abrechnungen erstellen und drucken",
    "def": "hoa"
   },
   {
    "key": "abrechnung.alle",
    "label": "Alle Abrechnungen ansehen und bezahlen (Sammelrecht)",
    "def": "a"
   },
   {
    "key": "abrechnung.ansehen",
    "label": "Alle Abrechnungen ansehen (nur lesen)",
    "def": "a"
   },
   {
    "key": "abrechnung.bezahlen",
    "label": "Abrechnungen bearbeiten und als bezahlt markieren",
    "def": "a"
   },
   {
    "key": "abrechnung.saetze",
    "label": "Abrechnungssätze (Stunden, km, Pauschalen) einstellen",
    "def": "a"
   }
  ]
 },
 {
  "id": "fahrten",
  "title": "Fahrtenformular",
  "system": "fahrten",
  "perms": [
   {
    "key": "fahrten.eigene",
    "label": "Eigene Fahrten eintragen und drucken",
    "def": "hoa"
   },
   {
    "key": "fahrten.alle",
    "label": "Alle Fahrten ansehen und abrechnen (Sammelrecht)",
    "def": "a"
   },
   {
    "key": "fahrten.ansehen",
    "label": "Alle Fahrten ansehen (nur lesen)",
    "def": "a"
   },
   {
    "key": "fahrten.abrechnen",
    "label": "Fahrten für andere eintragen und als abgerechnet markieren",
    "def": "a"
   }
  ]
 },
 {
  "id": "mitglieder",
  "title": "Mitglieder",
  "system": "mitglieder",
  "perms": [
   {
    "key": "mitglieder.view",
    "label": "Mitglieder ansehen",
    "def": "oa"
   },
   {
    "key": "mitglieder.edit",
    "label": "Mitglieder bearbeiten",
    "def": "oa"
   },
   {
    "key": "mitglieder.anlegen",
    "label": "Mitglieder anlegen",
    "def": "oa"
   },
   {
    "key": "mitglieder.loeschen",
    "label": "Mitglieder löschen",
    "def": "a"
   },
   {
    "key": "mitglieder.import",
    "label": "WebClub-Import (Gruppenlisten)",
    "def": "oa"
   }
  ]
 },
 {
  "id": "trainer",
  "title": "Trainer",
  "system": "trainer",
  "perms": [
   {
    "key": "trainer.eigene",
    "label": "Eigene Trainerdaten pflegen",
    "def": "hoa"
   },
   {
    "key": "trainer.view",
    "label": "Alle Trainer ansehen",
    "def": "oa"
   },
   {
    "key": "trainer.edit",
    "label": "Alle Trainer bearbeiten",
    "def": "oa"
   }
  ]
 },
 {
  "id": "anwesenheit",
  "title": "Anwesenheit",
  "system": "anwesenheit",
  "perms": [
   {
    "key": "anwesenheit.view",
    "label": "Anwesenheit ansehen",
    "def": "hoa"
   },
   {
    "key": "anwesenheit.upload",
    "label": "Listen hochladen",
    "def": "hoa"
   },
   {
    "key": "anwesenheit.edit",
    "label": "Listen bearbeiten",
    "def": "oa"
   },
   {
    "key": "anwesenheit.loeschen",
    "label": "Listen löschen",
    "def": "a"
   }
  ]
 },
 {
  "id": "auswertung",
  "title": "Auswertung",
  "system": "auswertung",
  "perms": [
   {
    "key": "auswertung.view",
    "label": "Auswertung ansehen",
    "def": "oa"
   },
   {
    "key": "auswertung.upload",
    "label": "Punkteliste hochladen",
    "def": "oa"
   },
   {
    "key": "auswertung.print",
    "label": "Auswertung drucken",
    "def": "oa"
   }
  ]
 },
 {
  "id": "dokumente",
  "title": "Dokumente",
  "system": "dokumente",
  "perms": [
   {
    "key": "dokumente.view",
    "label": "Dokumente ansehen",
    "def": "hoa"
   },
   {
    "key": "dokumente.edit",
    "label": "Dokumente verwalten",
    "def": "oa"
   }
  ]
 }
];


// Bereiche der Rechte-Verwaltung (Reihenfolge = Anzeige)
var PERM_SECTIONS_ = [
  { id: 'hub', title: '🌐 Intranet', icon: '🌐', hint: 'Welche Seiten im Hub erscheinen und wer Benutzer, Rollen und Rechte verwalten darf.' },
  { id: 'aufgaben', title: '✅ Aufgaben', icon: '✅' },
  { id: 'wettkaempfe', title: '🏁 Wettkämpfe', icon: '🏁' },
  { id: 'abrechnung', title: '🧾 Trainerabrechnung', icon: '🧾', hint: 'Jeder sieht nur seine eigenen Abrechnungen, außer er hat „Alle Abrechnungen“.' },
  { id: 'fahrten', title: '🚗 Fahrtenformular', icon: '🚗' },
  { id: 'training', title: '🦈 Wettkampfgruppe', icon: '🦈' },
  { id: 'jugend', title: '🏊 Jugend', icon: '🏊', hint: 'Abzeichen und Jugendkasse. Bestätigen darf nur, wer das Recht dazu hat (Rolle „JV | Kasse“).' },
  { id: 'vorstand', title: '🏛️ Vorstand', icon: '🏛️' },
  { id: 'material', title: '📦 Material', icon: '📦' },
  { id: 'veranstaltungen', title: '🎪 Veranstaltungen', icon: '🎪' },
  { id: 'weihnachtsmarkt', title: '🎄 Weihnachtsmarkt', icon: '🎄' },
  { id: 'mitglieder', title: '👥 Mitglieder', icon: '👥' },
  { id: 'trainer', title: '🎓 Trainer', icon: '🎓' },
  { id: 'anwesenheit', title: '📋 Anwesenheit', icon: '📋' },
  { id: 'auswertung', title: '📈 Auswertung', icon: '📈' },
  { id: 'dokumente', title: '📁 Dokumente', icon: '📁' }
];
var ADMIN_CORE_PERMS_ = ['view.admin', 'system.roles', 'system.rechte', 'system.users', 'system.passwords'];

/* ------------------- Systeme (Hub) ------------------- */
// Jedes System hat ein Recht "hub.<id>", das bestimmt, ob es im Hub erscheint. Neue Systeme hier eintragen
// und die Rechte-Gruppe des Systems in PERM_DEFS (aus perms_spec) ergaenzen.
var SYSTEMS_ = [
  { id: 'aufgaben', name: 'Aufgaben', icon: '✅', desc: 'Wer macht was bis wann. Eigene und gemeinsame Aufgaben.', url: '/intranet/aufgaben/', perm: 'hub.aufgaben', color: '#22c55e', group: 'Mein Bereich' },
  { id: 'wettkaempfe', name: 'Wettkämpfe', icon: '🏁', desc: 'Planung, Meldung und Ergebnisse.', url: '/intranet/wettkaempfe/', perm: 'hub.wettkaempfe', color: '#f59e0b', group: 'Mein Bereich' },
  { id: 'abrechnung', name: 'Abrechnung', icon: '🧾', desc: 'Trainerstunden und Fahrten.', url: '/intranet/abrechnung/', perm: 'hub.abrechnung', color: '#14b8a6', group: 'Mein Bereich' },
  { id: 'training', name: 'Gruppen', icon: '🦈', desc: 'Wettkampfgruppe: Training, Protokoll und Fahrten.', url: '/intranet/training/', perm: 'hub.training', color: '#06b6d4', group: 'Verein' },
  { id: 'mitglieder', name: 'Mitglieder', icon: '👥', desc: 'Alle Mitglieder mit Gruppen, Import aus WebClub.', url: '/intranet/mitglieder/', perm: 'hub.mitglieder', color: '#0ea5e9', group: 'Verein' },
  { id: 'trainer', name: 'Trainer', icon: '🎓', desc: 'Lizenzen, Erste Hilfe, Rettung und Gruppenzuordnung der Trainer.', url: '/intranet/trainer/', perm: 'hub.trainer', color: '#8b5cf6', group: 'Verein' },
  { id: 'anwesenheit', name: 'Anwesenheit', icon: '📋', desc: 'Anwesenheitslisten aus WebClub hochladen, Übersicht je Gruppe.', url: '/intranet/anwesenheit/', perm: 'hub.anwesenheit', color: '#10b981', group: 'Verein' },
  { id: 'auswertung', name: 'Auswertung', icon: '📈', desc: 'Jahresauswertung: Punkte-Rangliste, Einzelblätter, Ehrungen.', url: '/intranet/auswertung/', perm: 'hub.auswertung', color: '#f43f5e', group: 'Verein' },
  { id: 'dokumente', name: 'Dokumente', icon: '📁', desc: 'Satzung, Formulare und Downloads des Vereins.', url: '/intranet/dokumente/', perm: 'hub.dokumente', color: '#a855f7', group: 'Verein' },
  { id: 'jugend', name: 'Jugend', icon: '🏊', desc: 'Schwimmabzeichen und Jugendkasse.', url: '/intranet/jugend/', perm: 'hub.jugend', color: '#3b82f6', group: 'Verein' },
  { id: 'vorstand', name: 'Vorstand', icon: '🏛️', desc: 'Anträge, Protokolle und Beschlüsse.', url: '/intranet/vorstand/', perm: 'hub.vorstand', color: '#64748b', group: 'Verein' },
  { id: 'material', name: 'Material', icon: '📦', desc: 'Gegenstände, Bestand, Mindestmengen und Ausleihe.', url: '/intranet/material/', perm: 'hub.material', color: '#ec4899', group: 'Verein' },
  { id: 'veranstaltungen', name: 'Veranstaltungen', icon: '🎪', desc: 'Eigene Events mit Checkliste, Helfern und Material.', url: '/intranet/veranstaltungen/', perm: 'hub.veranstaltungen', color: '#a855f7', group: 'Aktionen' },
  { id: 'weihnachtsmarkt', name: 'Weihnachtsmarkt', icon: '🎄', desc: 'Aushang, Kasse, Inventar, Aufbau und mehr für den Markt.', url: '/intranet/weihnachtsmarkt/', perm: 'hub.weihnachtsmarkt', color: '#ef4444', group: 'Aktionen' },
  { id: 'fahrten', name: 'Fahrtenformular', icon: '🚗', desc: 'Fahrten zum Wettkampftraining.', url: '/intranet/abrechnung/', perm: 'hub.fahrten', color: '#f97316', group: 'Mein Bereich', hidden: true }
];
function systemsFor_(perms) {
  perms = perms || [];
  // Fahrten sind ein Reiter in der Abrechnung: wer nur "Fahrtenformular" hat, sieht die Kachel "Abrechnung"
  return SYSTEMS_.filter(function (x) {
    if (x.hidden) return false;
    if (x.id === 'abrechnung') return perms.indexOf('hub.abrechnung') >= 0 || perms.indexOf('hub.fahrten') >= 0;
    return perms.indexOf(x.perm) >= 0;
  }).map(function (x) {
    return { id: x.id, name: x.name, icon: x.icon, desc: x.desc, url: x.url, color: x.color, group: x.group || '' };
  });
}
// Fuer andere Scripts (z. B. Jugendkasse): Token pruefen. Verlangt die Script-Eigenschaft HUB_SECRET und gibt nur dann Auskunft.
function verify_(p) {
  var secret = '';
  try { secret = PropertiesService.getScriptProperties().getProperty('HUB_SECRET') || ''; } catch (e) { secret = ''; }
  if (!secret || secret.length < 16) return { status: 'error', code: 'config', message: 'HUB_SECRET ist nicht eingerichtet.' };
  if (String(p.secret || '') !== secret) return { status: 'error', code: 'secret', message: 'Falsches Geheimnis.' };
  var s = p.token ? session_(p.token) : null;
  if (!s) return { status: 'error', code: 'auth', message: 'Token ungültig.' };
  var sys = String(p.system || '');
  var def = SYSTEMS_.filter(function (x) { return x.id === sys; })[0];
  return { status: 'success', user: s.userName, userId: s.userId || '', roles: s.roles.map(function (r) { return { id: r.id, name: r.name }; }), perms: s.perms, systemAllowed: !!(def && s.perms.indexOf(def.perm) >= 0) };
}

/* ------------------- Zugriffsschutz (Token und Recht) ------------------- */
// Jede Aktion prueft im Script, wer fragt. Ohne gueltige Anmeldung gelten die Rechte der Rolle "Gast".
// Script-Eigenschaft AUTH_MODE = 'observe' schaltet auf "nur protokollieren" (Notbremse), sonst gilt 'enforce'.
var LIST_READ_ = {
  aushang: ['view.aushang'], expenses: ['view.statistik'], boxes: ['view.boxen'], strom: ['view.verkabelung'], aufbau: ['view.aufbau'],
  produkte: ['view.verkauf', 'view.statistik', 'view.admin'], rezepte: ['view.rezepte'], kassensturz: ['kasse.sturz', 'kasse.report', 'view.statistik'],
  leihgaben: ['view.leihgaben'], abnahme: ['view.aufbau'], skizze: ['view.aufbau'], archiv: ['archiv.view']
};
var LIST_WRITE_ = {
  expenses: ['finance.expenseAdd', 'finance.expenseDelete', 'finance.receipt'], boxes: ['boxen.add', 'boxen.edit', 'boxen.delete'],
  strom: ['strom.steckerAdd', 'strom.steckerEdit', 'strom.steckerDelete', 'strom.plan', 'strom.watt', 'strom.verteiler'],
  aufbau: ['aufbau.check', 'aufbau.stepAdd', 'aufbau.stepEdit', 'aufbau.stepDelete', 'aufbau.noteAdd', 'aufbau.noteEdit', 'aufbau.noteDelete', 'aufbau.imageAdd', 'aufbau.imageEdit', 'aufbau.imageDelete', 'aufbau.sort'],
  produkte: ['finance.productAdd', 'finance.productEdit', 'finance.productDelete'], rezepte: ['rezepte.add', 'rezepte.edit', 'rezepte.delete'],
  kassensturz: ['kasse.sturz'], leihgaben: ['leihgaben.add', 'leihgaben.edit', 'leihgaben.delete', 'leihgaben.status'],
  abnahme: ['abnahme.check', 'abnahme.edit', 'abnahme.sign'], skizze: ['skizze.edit'], archiv: ['archiv.create', 'archiv.delete']
};
var KASSE_READ_ = ['view.verkauf', 'view.statistik', 'kasse.report'];
var INV_READ_ = ['view.inventar', 'view.einkaufsliste', 'view.lagerbestand', 'view.boxen', 'view.verkabelung', 'view.rezepte', 'view.aufbau'];
var INV_FIELD_PERMS_ = {
  bedarf: ['inventar.editBedarf'], lager: ['inventar.editLager'], status: ['inventar.editStatus'], name: ['inventar.editName'], sub: ['inventar.editName'],
  wer: ['inventar.editMeta'], verantwortlich: ['inventar.editMeta'], empfaenger: ['inventar.editMeta'], pack: ['inventar.editMeta'], box: ['inventar.editMeta'],
  einheit: ['inventar.editBedarf', 'einkauf.editPack'], packEinheit: ['einkauf.editPack'], lagerAus: ['inventar.editLager'],
  packung: ['einkauf.editPack'], preis: ['einkauf.editPreis'], laden: ['einkauf.editLaden'], kaufPackungen: ['einkauf.check', 'rezepte.toShopping'],
  einkauf: ['inventar.cart', 'einkauf.removeItem', 'einkauf.addItem', 'rezepte.toShopping'], watt: ['strom.watt'], wattMax: ['strom.watt'], dosen: ['strom.watt']
};
var INV_OP_PERMS_ = {
  addItem: ['inventar.addItem', 'einkauf.addItem'], delItem: ['inventar.deleteItem', 'einkauf.removeItem'], moveItem: ['inventar.moveItem'],
  addCat: ['inventar.catAdd'], renameCat: ['inventar.catEdit'], editCat: ['inventar.catEdit'], setStatuses: ['inventar.catEdit'], moveCat: ['inventar.catEdit'],
  delCat: ['inventar.catDelete'], replaceAll: ['system.reset']
};
function authMode_() {
  try { return PropertiesService.getScriptProperties().getProperty('AUTH_MODE') === 'observe' ? 'observe' : 'enforce'; } catch (e) { return 'enforce'; }
}
// Im Beobachtungsmodus wird dieselbe Verweigerung hoechstens alle 10 Minuten protokolliert (kein Fluten des Protokolls)
function denyLogDue_(label) {
  try {
    var pr = PropertiesService.getScriptProperties();
    var k = 'DL_' + str_(label, 40);
    var last = Number(pr.getProperty(k)) || 0;
    if (now_() - last < 600000) return false;
    pr.setProperty(k, String(now_()));
    return true;
  } catch (e) { return false; }
}
// Wer fragt? Das Ergebnis wird 60 Sekunden zwischengespeichert (CacheService), damit nicht jede Anfrage mehrere
// Blaetter lesen muss. Jede Aenderung an Rollen, Benutzern, Rechten oder Abmeldungen erhoeht die Versionsnummer
// (bumpActors_) und macht alle gemerkten Ergebnisse sofort ungueltig.
function actorCache_() { try { return CacheService.getScriptCache(); } catch (e) { return null; } }
function bumpActors_() {
  var c = actorCache_();
  if (!c) return;
  try { c.put('act_ver', String((Number(c.get('act_ver')) || 0) + 1), 21600); } catch (e) { /* ohne Zwischenspeicher wird eben jedes Mal gelesen */ }
}
function actorBase_(token) {
  var s = token ? session_(token) : null;
  var perms = s ? s.perms : null;
  if (!perms) {
    var g = roleById_(loadRoles_(false), 'gast');
    perms = g ? (g.perms || []) : [];
  }
  return { s: s ? { userName: s.userName, roles: s.roles, extras: s.extras || [], perms: s.perms, mustChange: !!s.mustChange } : null, perms: perms };
}
function makeActor_(token) {
  var cache = actorCache_();
  var key = null;
  var base = null;
  if (cache) {
    try {
      key = 'act_' + (cache.get('act_ver') || '0') + '_' + (token ? String(token).slice(0, 64) : 'gast');
      var raw = cache.get(key);
      if (raw) base = JSON.parse(raw);
    } catch (e) { base = null; }
  }
  if (!base) {
    base = actorBase_(token);
    if (cache && key) { try { cache.put(key, JSON.stringify(base), 60); } catch (e) { /* egal */ } }
  }
  var s = base.s;
  var perms = base.perms;
  var mode = authMode_();
  return {
    s: s, perms: perms, mode: mode, denied: 0,
    any: function (list) { return !list || !list.length || list.some(function (k) { return perms.indexOf(k) >= 0; }); },
    // Fuer Aktionen: erlaubt? Im Beobachtungsmodus wird nur protokolliert.
    check: function (list, label) {
      if (this.any(list)) return true;
      if (mode !== 'observe') this.denied++;   // im Beobachtungsmodus wird nichts verweigert
      if (this.s || (mode === 'observe' && denyLogDue_(label))) logChange_('Zugriff', (mode === 'observe' ? 'Beobachtung, hätte verweigert: ' : 'Verweigert: ') + label, { n: this.s ? this.s.userName : 'Gast', r: this.s ? this.s.roles[0].name : 'Gast', d: '' });
      return mode === 'observe';
    }
  };
}
function listWriteNeed_(name, op, items) {
  if (name === 'aushang') {
    if (op.op === 'addName' || op.op === 'delName' || op.op === 'claim' || op.op === 'clear') return ['aushang.signup'];
    var kind = op.item && op.item.kind ? op.item.kind : '';
    if (!kind) { var i = indexById_(items, op.id); if (i >= 0) kind = items[i].kind; }
    if (kind === 'info') return ['aushang.editInfo'];
    if (kind === 'countdown') return ['aushang.countdown'];
    if (kind === 'meta') return ['aushang.editTitle'];
    if (kind === 'teig') return ['aushang.editTeig'];
    return ['aushang.editRows'];
  }
  return LIST_WRITE_[name] || ['system.restore'];
}
function imageNeed_(name, writing, deleting) {
  var n = String(name || '');
  if (n === 'samstag' || n === 'sonntag') return writing ? ['aushang.upload'] : ['view.aushang'];
  if (n.indexOf('aufbau_') === 0) return writing ? (deleting ? ['aufbau.imageDelete', 'aufbau.imageEdit'] : ['aufbau.imageAdd', 'aufbau.imageEdit']) : ['view.aufbau'];
  return ['system.restore'];
}
function imagesReadable_(A, names) {
  return String(names || '').split(',').every(function (n) {
    n = n.replace(/^\s+|\s+$/g, '');
    if (!n || n.indexOf('beleg_') === 0) return true;   // Belege haben einen eigenen Schutz
    return A.check(imageNeed_(n, false, false), 'Bild lesen: ' + n);
  });
}
// Ohne Leserecht: leeres Inventar. Gibt es noch gar keins, bleibt es null, damit es spaeter angelegt werden kann.
function invHidden_() {
  return readInventar_() ? [] : null;
}
function deniedKasse_(A) {
  var r = readKasse_();
  Object.keys(r.counts || {}).forEach(function (d) { Object.keys(r.counts[d]).forEach(function (p) { r.counts[d][p] = { paid: 0, free: 0 }; }); });
  r.status = 'success';
  r.denied = true;
  return r;
}


/* ------------------- Daten der neuen Systeme -------------------
   Aufgaben, Wettkaempfe, Training, Veranstaltungen, Vorstand, Material, Abzeichen.
   Jeder Datensatz liegt als eigene Zeile im Blatt "Daten" (Schluessel "sammlung/id"), so bleibt jeder unter dem Zellenlimit
   und eine Aenderung schreibt nur ihre eigenen Zeilen. */
var SHEET_DATEN = 'Daten';
// read: wer lesen darf; write: wer anlegen/aendern/loeschen darf; part: Felder, die auch mit dem genannten Einzelrecht geaendert werden duerfen
// own: "eigene Datensaetze": jeder sieht und bearbeitet nur das, was er selbst angelegt hat (Feld owner). all = sieht/bearbeitet alles.
//      perm = wer eigene anlegen darf (null = jedes persoenliche Konto), lock = Stati, die der Besitzer nicht mehr aendern darf,
//      allow = Stati, die der Besitzer selbst setzen darf, ownId = Datensatz-Kennung ist fest an den Benutzer gebunden (Profil)
var COLLS_ = {
  aufgaben:          { read: ['aufgaben.view'], write: ['aufgaben.edit'], add: ['aufgaben.anlegen'], del: ['aufgaben.edit', 'aufgaben.loeschen'], part: { status: ['aufgaben.own'], note: ['aufgaben.own'], doneAt: ['aufgaben.own'], doneBy: ['aufgaben.own'], com: ['aufgaben.own'], sub: ['aufgaben.own'] } },
  wettkaempfe:       { read: ['wettkaempfe.view', 'auswertung.view'], write: ['wettkaempfe.import', 'wettkaempfe.anlegen'], del: ['wettkaempfe.import', 'wettkaempfe.loeschen'], part: { res: ['wettkaempfe.zeiten', 'wettkaempfe.vorort'], gericht: ['wettkaempfe.kampfgericht'], meldegeldStatus: ['wettkaempfe.check', 'wettkaempfe.meldegeld'], note: ['wettkaempfe.zeiten', 'wettkaempfe.vorort'], art: ['wettkaempfe.artikel', 'wettkaempfe.import', 'wettkaempfe.zeiten'], chk: ['wettkaempfe.check'], teilnahme: ['wettkaempfe.check', 'wettkaempfe.teilnahme'], kr1: ['wettkaempfe.check', 'wettkaempfe.krzahl'], kr2: ['wettkaempfe.check', 'wettkaempfe.krzahl'], intMs: ['wettkaempfe.check'] } },
  trainingEinheiten: { read: ['training.view'], write: ['training.edit'], add: ['training.anlegen'], del: ['training.edit', 'training.loeschen'], part: {} },
  trainingBeob:      { read: ['training.beobachtung'], write: ['training.beobachtung'], part: {} },
  trainingTage:      { read: ['training.tage.view'], write: ['training.tage.edit'], add: ['training.tage.anlegen'], del: ['training.tage.edit', 'training.tage.loeschen'], part: {} },
  wgMitglieder:      { read: ['training.mitglieder.view', 'training.tage.view', 'mitglieder.view', 'anwesenheit.view', 'trainer.view', 'auswertung.view'], write: ['training.mitglieder.edit', 'mitglieder.edit', 'mitglieder.import'], add: ['training.mitglieder.anlegen', 'mitglieder.anlegen', 'mitglieder.import'], del: ['training.mitglieder.edit', 'training.mitglieder.loeschen', 'mitglieder.edit', 'mitglieder.loeschen'], part: {} },
  trainer:           { own: { perm: ['trainer.eigene'], all: ['trainer.view', 'trainer.edit', 'mitglieder.view'], adm: ['trainer.edit'] } },
  anwesenheit:       { read: ['anwesenheit.view', 'training.tage.view'], write: ['anwesenheit.upload', 'anwesenheit.edit'], add: ['anwesenheit.upload'], del: ['anwesenheit.edit', 'anwesenheit.loeschen'], part: {} },
  saison:            { read: ['auswertung.view'], write: ['auswertung.upload'], del: ['auswertung.upload'], part: {} },
  dokumente:         { read: ['dokumente.view'], write: ['dokumente.edit'], part: {} },
  veranstaltungen:   { read: ['veranstaltungen.view'], write: ['veranstaltungen.edit'], add: ['veranstaltungen.anlegen'], del: ['veranstaltungen.edit', 'veranstaltungen.loeschen'], part: { check: ['veranstaltungen.check'], helfer: ['veranstaltungen.check'] } },
  vorstandAntraege:  { own: { perm: ['vorstand.antrag'], all: ['vorstand.view', 'vorstand.antraege.view'], adm: ['vorstand.edit', 'vorstand.antraege.edit'], lock: ['Beschlossen', 'Abgelehnt', 'Zurückgestellt'], allow: ['Entwurf', 'Eingereicht'] } },
  vorstandProtokolle: { read: ['vorstand.view', 'vorstand.protokolle.view'], write: ['vorstand.edit', 'vorstand.protokolle.edit'], part: {} },
  vorstandBeschluesse: { read: ['vorstand.view', 'vorstand.beschluesse.view'], write: ['vorstand.edit', 'vorstand.beschluesse.edit'], part: { status: ['vorstand.edit', 'vorstand.beschluesse.edit'] } },
  vorstandSitzungen: { read: ['vorstand.view', 'vorstand.sitzungen.view'], write: ['vorstand.edit', 'vorstand.sitzungen.edit'], part: {} },
  vorstandUmlauf:    { read: ['vorstand.view'], write: ['vorstand.edit'], part: { stimmen: ['vorstand.abstimmen'] } },
  material:          { read: ['material.view'], write: ['material.edit'], add: ['material.anlegen'], del: ['material.edit', 'material.loeschen'], part: { loans: ['material.ausleihe'], bestand: ['material.ausleihe', 'material.bestand'], hist: ['material.ausleihe', 'material.bestand'] } },
  abzeichen:         { read: ['jugend.abzeichen.view'], write: ['jugend.abzeichen.edit'], add: ['jugend.abzeichen.anlegen'], del: ['jugend.abzeichen.edit', 'jugend.abzeichen.loeschen'], part: {} },
  abzListe:          { read: ['jugend.abzeichen.view', 'material.view'], write: ['jugend.abzeichen.edit'], part: {} },
  vorlagen:          { read: ['veranstaltungen.view', 'veranstaltungen.vorlagen', 'aufgaben.view', 'wettkaempfe.view'], write: ['veranstaltungen.edit', 'veranstaltungen.vorlagen', 'aufgaben.edit'], part: {} },
  // Jugendkasse: strikt getrennt. Ansehen, Buchen, Bestaetigen und Verwalten sind eigene Rechte.
  kasseBuchungen:    { read: ['jugend.kasse.view'], write: ['jugend.kasse.buchen'], part: { status: ['jugend.kasse.bestaetigen'], okBy: ['jugend.kasse.bestaetigen'], okAt: ['jugend.kasse.bestaetigen'] }, hook: 'kasse' },
  kasseAuslagen:     { read: ['jugend.kasse.view'], write: ['jugend.kasse.buchen'], part: { status: ['jugend.kasse.bestaetigen'], okBy: ['jugend.kasse.bestaetigen'], okAt: ['jugend.kasse.bestaetigen'] }, hook: 'auslage' },
  kasseCfg:          { read: ['jugend.kasse.view'], write: ['jugend.kasse.verwalten'], part: { ort: ['jugend.kasse.buchen'], holder: ['jugend.kasse.buchen'], seit: ['jugend.kasse.buchen'], ortLog: ['jugend.kasse.buchen'] } },
  kasseSturz:        { read: ['jugend.kasse.view'], write: ['jugend.kasse.buchen'], part: {} },
  kasseBudgets:      { read: ['jugend.kasse.view'], write: ['jugend.kasse.verwalten'], part: {} },
  kasseAbschluss:    { read: ['jugend.kasse.view'], write: ['jugend.kasse.verwalten'], part: {} },
  // Eigene Datensaetze
  abrechnungen:      { own: { perm: ['abrechnung.eigene'], all: ['abrechnung.alle', 'abrechnung.ansehen', 'abrechnung.bezahlen'], adm: ['abrechnung.alle', 'abrechnung.bezahlen'], lock: ['bezahlt'], allow: ['entwurf', 'eingereicht'] } },
  fahrten:           { own: { perm: ['fahrten.eigene'], all: ['fahrten.alle', 'fahrten.ansehen', 'fahrten.abrechnen'], adm: ['fahrten.alle', 'fahrten.abrechnen'], lock: ['abgerechnet'], allow: ['offen'] } },
  profile:           { own: { perm: null, all: null, adm: null, ownId: true } },
  saetze:            { read: ['abrechnung.eigene', 'fahrten.eigene', 'abrechnung.alle', 'fahrten.alle', 'abrechnung.ansehen', 'abrechnung.bezahlen', 'fahrten.ansehen', 'fahrten.abrechnen', 'abrechnung.saetze'], write: ['abrechnung.saetze'], part: {} }
};
// Sammlungen, bei denen die Namensliste der Benutzer mitgeliefert wird (zum Auswaehlen von Personen)
var PEOPLE_COLLS_ = ['aufgaben', 'trainingTage', 'wgMitglieder', 'material', 'veranstaltungen', 'vorstandBeschluesse', 'vorstandSitzungen', 'abrechnungen', 'fahrten'];
var DATA_MAX_ITEM_ = 40000;
var DATA_MAX_OPS_ = 300;

function has_(A, list) { return !!(list && list.length && A.any(list)); }
function ownName_(A) { return A.s && A.s.userName ? String(A.s.userName) : ''; }
// Darf dieses Konto die "eigenen" Datensaetze der Sammlung nutzen? (nur persoenliche Konten, nie reine Rollen-Anmeldungen)
function ownAllowed_(A, def) {
  if (!def.own || !ownName_(A)) return false;
  return !def.own.perm || A.any(def.own.perm);
}
function profileId_(name) { return 'p-' + String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36); }
function sameName_(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }
function monthOf_(d) { return /^\d{4}-\d{2}/.test(String(d || '')) ? String(d).slice(0, 7) : ''; }

function dataItemsOf_(all, coll) {
  var pre = coll + '/';
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(pre) !== 0) return;
    try { var it = JSON.parse(all[k]); if (it && typeof it === 'object') { it.id = k.slice(pre.length); out.push(it); } } catch (ignore) {}
  });
  out.sort(function (a, b) { return ((typeof a.ord === 'number' ? a.ord : 1e12) - (typeof b.ord === 'number' ? b.ord : 1e12)) || ((a.ts || 0) - (b.ts || 0)); });
  return out;
}
function assignedTo_(it, name) {
  if (!name) return false;
  var n = String(name).toLowerCase();
  var w = Array.isArray(it.who) ? it.who : (it.who ? [it.who] : []);
  return w.some(function (x) { return String(x).toLowerCase() === n; }) || String(it.by || '').toLowerCase() === n;
}
// Mehrere Sammlungen in EINEM Aufruf lesen (GET data&colls=a,b,c)
function dataGet_(p) {
  var A = makeActor_(p.token);
  var names = String(p.colls || p.coll || '').split(',').map(function (x) { return x.replace(/^\s+|\s+$/g, ''); }).filter(Boolean);
  if (!names.length) return { status: 'error', message: 'Keine Sammlung angegeben.' };
  var all = kvReadAll_(SHEET_DATEN);
  var who = ownName_(A);
  var out = { status: 'success', data: {}, denied: [], me: A.s ? A.s.userName : '' };
  names.forEach(function (c) {
    var def = COLLS_[c];
    if (!def) return;
    var items;
    if (def.own) {
      if (has_(A, def.own.all)) items = dataItemsOf_(all, c);
      else if (ownAllowed_(A, def)) items = dataItemsOf_(all, c).filter(function (it) { return def.own.ownId ? it.id === profileId_(who) : sameName_(it.owner, who); });
      else { out.denied.push(c); return; }
    } else if (A.any(def.read)) items = dataItemsOf_(all, c);
    else if (c === 'aufgaben' && A.any(['aufgaben.own'])) items = dataItemsOf_(all, c).filter(function (it) { return assignedTo_(it, who); });
    else { out.denied.push(c); return; }
    out.data[c] = items;
  });
  // Personen zum Auswaehlen (nur Namen), wenn eine passende Sammlung gelesen werden darf
  if (who && PEOPLE_COLLS_.some(function (c) { return out.data[c]; })) {
    try { out.people = loadUsers_().map(function (u) { return u.name; }).filter(Boolean); } catch (e) { out.people = []; }
  }
  return out;
}
function dataClean_(it) {
  var o = {};
  Object.keys(it || {}).forEach(function (k) {
    if (k === 'id' || k.charAt(0) === '_' || k.length > 40) return;
    o[k] = it[k];
  });
  return o;
}
// Zusatzregeln je Sammlung. ctx: { A, who, op ('set'|'patch'|'del'), existing, item (set) oder fields (patch), closed(datum) }
// Rueckgabe false = verweigert. Darf item/fields anpassen (z. B. Status zuruecksetzen).
function dataHook_(name, ctx) {
  var A = ctx.A, ex = ctx.existing;
  var canOk = A.any(['jugend.kasse.bestaetigen']);
  if (name === 'kasse') {
    var d = ctx.op === 'set' ? ctx.item.datum : (ctx.op === 'patch' ? ((ctx.fields && ctx.fields.datum) || (ex && ex.datum)) : '');
    if (ex && ctx.closed(ex.datum)) return false;
    if (ctx.op !== 'del' && ctx.closed(d)) return false;
    if (ctx.op === 'set') {
      if (!canOk) { if (ex && ex.status === 'bestaetigt') return false; ctx.item.status = 'offen'; delete ctx.item.okBy; delete ctx.item.okAt; }
      else if (ctx.item.status === 'bestaetigt') { ctx.item.okBy = ctx.who; ctx.item.okAt = now_(); }
      else { delete ctx.item.okBy; delete ctx.item.okAt; }
      if (!ctx.item.von) ctx.item.von = ex && ex.von ? ex.von : ctx.who;
      return true;
    }
    if (ctx.op === 'patch') {
      var f = ctx.fields || {};
      var touch = ['status', 'okBy', 'okAt'].some(function (k) { return f[k] !== undefined; });
      if (touch && !canOk) return false;
      if (!canOk && ex && ex.status === 'bestaetigt') return false;
      if (touch) { if (f.status === 'bestaetigt') { f.okBy = ctx.who; f.okAt = now_(); } else { f.okBy = ''; f.okAt = 0; } }
      return true;
    }
    if (ctx.op === 'del') return !(ex && ex.status === 'bestaetigt' && !canOk);
    return true;
  }
  if (name === 'auslage') {
    if (ctx.op === 'set') {
      if (!canOk) { if (ex && ex.status && ex.status !== 'beantragt') return false; ctx.item.status = 'beantragt'; delete ctx.item.okBy; delete ctx.item.okAt; }
      else if (ctx.item.status && ctx.item.status !== 'beantragt') { ctx.item.okBy = ctx.who; ctx.item.okAt = now_(); }
      if (!ctx.item.von) ctx.item.von = ex && ex.von ? ex.von : ctx.who;
      return true;
    }
    if (ctx.op === 'patch') {
      var g = ctx.fields || {};
      var t2 = ['status', 'okBy', 'okAt'].some(function (k) { return g[k] !== undefined; });
      if (t2 && !canOk) return false;
      if (t2) { if (g.status && g.status !== 'beantragt') { g.okBy = ctx.who; g.okAt = now_(); } else { g.okBy = ''; g.okAt = 0; } }
      return true;
    }
    if (ctx.op === 'del') return !(ex && ex.status && ex.status !== 'beantragt' && !canOk);
  }
  return true;
}
function dataOps_(b) {
  var A = makeActor_(b.token);
  var ops = Array.isArray(b.ops) ? b.ops : [];
  if (ops.length > DATA_MAX_OPS_) return { status: 'error', message: 'Zu viele Änderungen auf einmal.' };
  var all = kvReadAll_(SHEET_DATEN);
  var writes = {};
  var denied = [];
  var done = 0;
  var who = A.s ? A.s.userName : '';
  var actor = actorOf_(b);
  if (!actor.n) actor.n = who || '';
  if (!actor.r && A.s && A.s.roles && A.s.roles[0]) actor.r = String(A.s.roles[0].name || '').substring(0, 40);
  function cur(c, id) {
    var k = c + '/' + id;
    if (writes[k] !== undefined) return writes[k] === null ? null : JSON.parse(writes[k]);
    if (all[k] === undefined) return null;
    try { return JSON.parse(all[k]); } catch (e) { return null; }
  }
  function put(c, id, obj) {
    var txt = JSON.stringify(obj);
    if (txt.length > DATA_MAX_ITEM_) throw new Error('Eintrag zu groß.');
    writes[c + '/' + id] = txt;
  }
  function closed(datum) {
    var m = monthOf_(datum); if (!m) return false;
    var k = 'kasseAbschluss/' + m;
    if (writes[k] !== undefined) return writes[k] !== null;
    return all[k] !== undefined && all[k] !== '';
  }
  ops.forEach(function (op, i) {
    try {
      var c = String(op.coll || '');
      var def = COLLS_[c];
      if (!def) { denied.push(i); return; }
      var id = String(op.id || (op.item && op.item.id) || '');
      var label = c + ': ' + str_(op.op, 10) + ' ' + str_((op.item && (op.item.title || op.item.name || op.item.text)) || id, 40);
      var own = def.own || null;
      var isAdm = own ? has_(A, own.adm) : false;
      var ownOk = own ? ownAllowed_(A, def) : false;
      var canWrite = own ? isAdm : A.any(def.write);
      var canDel = own ? isAdm : (def.del ? A.any(def.del) : canWrite);
      if (op.op === 'order') {
        if (own || !canWrite) { if (!own) A.check(def.write, label); denied.push(i); return; }
        var ids = Array.isArray(op.ids) ? op.ids : [];
        ids.forEach(function (x, n) { var o = cur(c, String(x)); if (o) { o.ord = n; put(c, String(x), o); } });
        done++; return;
      }
      if (!idOk_(id)) { denied.push(i); return; }
      var existing = cur(c, id);
      // eigene Datensaetze: nur der Besitzer, solange nicht gesperrt
      if (own && !isAdm) {
        if (!ownOk) { denied.push(i); return; }
        if (own.ownId && id !== profileId_(who)) { denied.push(i); return; }
        if (existing && !own.ownId && !sameName_(existing.owner, who)) { denied.push(i); return; }
        if (existing && own.lock && own.lock.indexOf(existing.status) >= 0) { denied.push(i); return; }
        if (op.op === 'set') {
          var oi = dataClean_(op.item); oi.owner = who;
          if (own.allow && own.allow.indexOf(oi.status) < 0) oi.status = own.allow[0];
          if (existing) { if (existing.ts && !oi.ts) oi.ts = existing.ts; } else oi.ts = oi.ts || now_();
          oi.upd = now_(); oi.updBy = who; put(c, id, oi);
          logChange_('Daten', (existing ? 'Geändert: ' : 'Neu: ') + c + ' ' + str_(oi.title || oi.name || id, 40), actor); done++; return;
        }
        if (op.op === 'patch') {
          if (!existing) { denied.push(i); return; }
          var of = op.fields && typeof op.fields === 'object' ? op.fields : {};
          Object.keys(of).forEach(function (k) {
            if (k === 'id' || k === 'owner' || k.charAt(0) === '_' || k.length > 40) return;
            if (k === 'status' && own.allow && own.allow.indexOf(of[k]) < 0) return;
            existing[k] = of[k];
          });
          existing.upd = now_(); existing.updBy = who; put(c, id, existing);
          logChange_('Daten', 'Geändert: ' + c + ' ' + str_(existing.title || existing.name || id, 40), actor); done++; return;
        }
        if (op.op === 'del') {
          if (!existing || own.ownId) { denied.push(i); return; }
          writes[c + '/' + id] = null; logChange_('Daten', 'Gelöscht: ' + c + ' ' + str_(existing.title || existing.name || id, 40), actor); done++; return;
        }
        denied.push(i); return;
      }
      if (op.op === 'del') {
        if (!canDel) { A.check(def.del || def.write || own.adm, label); denied.push(i); return; }
        if (def.hook && !dataHook_(def.hook, { A: A, who: who, op: 'del', existing: existing, closed: closed })) { denied.push(i); return; }
        writes[c + '/' + id] = null; logChange_('Daten', 'Gelöscht: ' + label, actor); done++; return;
      }
      if (op.op === 'set') {
        var canAdd = canWrite || (!existing && !!def.add && A.any(def.add));
        if (!canAdd) { A.check(def.write, label); denied.push(i); return; }
        var item = dataClean_(op.item);
        if (existing) { if (typeof existing.ord === 'number' && typeof item.ord !== 'number') item.ord = existing.ord; if (existing.ts && !item.ts) item.ts = existing.ts; if (own && existing.owner && !item.owner) item.owner = existing.owner; }
        else { item.ts = item.ts || now_(); if (c === 'aufgaben' && !item.by) item.by = who; if (own && !item.owner) item.owner = who; }
        if (def.hook && !dataHook_(def.hook, { A: A, who: who, op: 'set', existing: existing, item: item, closed: closed })) { denied.push(i); return; }
        item.upd = now_(); item.updBy = who;
        put(c, id, item);
        logChange_('Daten', (existing ? 'Geändert: ' : 'Neu: ') + label, actor); done++; return;
      }
      if (op.op === 'patch') {
        var ex = existing;
        if (!ex) { denied.push(i); return; }
        var f = op.fields && typeof op.fields === 'object' ? op.fields : {};
        var keys = Object.keys(f);
        var ok = canWrite || (keys.length > 0 && keys.every(function (k) { return def.part && def.part[k] && A.any(def.part[k]); }));
        if (ok && !canWrite && c === 'aufgaben' && !A.any(['aufgaben.edit'])) ok = assignedTo_(ex, who);
        if (!ok) { A.check(def.write, label); denied.push(i); return; }
        if (def.hook && !dataHook_(def.hook, { A: A, who: who, op: 'patch', existing: ex, fields: f, closed: closed })) { denied.push(i); return; }
        keys = Object.keys(f);
        keys.forEach(function (k) {
          if (k === 'id' || k.charAt(0) === '_' || k.length > 40) return;
          // merge: Unterschluessel einzeln zusammenfuehren (z. B. Zeiten mehrerer Geraete), null loescht den Unterschluessel
          if (op.merge === true && f[k] && typeof f[k] === 'object' && !Array.isArray(f[k])) {
            var base = ex[k] && typeof ex[k] === 'object' && !Array.isArray(ex[k]) ? ex[k] : {};
            Object.keys(f[k]).forEach(function (sk) { if (f[k][sk] === null) delete base[sk]; else base[sk] = f[k][sk]; });
            ex[k] = base;
          } else ex[k] = f[k];
        });
        ex.upd = now_(); ex.updBy = who;
        put(c, id, ex);
        if (keys.some(function (k) { return k !== 'check' && k !== 'chk' && k !== 'res' && k !== 'teil'; })) logChange_('Daten', 'Geändert: ' + c + ': patch ' + str_(ex.title || ex.name || ex.text || id, 40), actor);
        done++; return;
      }
      denied.push(i);
    } catch (e) { denied.push(i); }
  });
  if (A.denied && A.mode !== 'observe') { /* Verweigerungen sind bereits protokolliert */ }
  if (Object.keys(writes).length) kvWriteMany_(SHEET_DATEN, writes);
  return { status: denied.length && !done ? 'error' : 'success', done: done, deniedIdx: denied, message: denied.length ? 'Für ' + denied.length + ' Änderung(en) fehlt die Berechtigung.' : '' };
}
// Mehrere Zeilen in einem Rutsch schreiben (Wert null = Zeile leeren). Ein Lesen, ein Schreiben.
function kvWriteMany_(name, map) {
  if (MEMO_) delete MEMO_[name];
  var sh = kvSheet_(name);
  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
  var pos = {};
  rows.forEach(function (r, i) { if (r[0] !== '') pos[String(r[0])] = i; });
  var add = [];
  Object.keys(map).forEach(function (k) {
    if (pos[k] !== undefined) rows[pos[k]] = map[k] === null ? ['', ''] : [k, map[k]];
    else if (map[k] !== null) add.push([k, map[k]]);
  });
  // freie (geleerte) Zeilen zuerst wiederverwenden
  var j = 0;
  for (var i = 0; i < rows.length && j < add.length; i++) {
    if (rows[i][0] === '') { rows[i] = add[j++]; }
  }
  var rest = add.slice(j);
  if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
  if (rest.length) sh.getRange(2 + rows.length, 1, rest.length, 2).setValues(rest);
}

/* ---------------------------- POST --------------------------- */

function doPost(e) {
  autoSetup_();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var contents = (e && e.postData && e.postData.contents) || '';
    var body = JSON.parse(contents);
    maybeBackup_();   // hoechstens einmal je 24 Stunden, vor der ersten Aenderung des Tages

    // Altes Format (reines Array): nur als Erstbefuellung, nie zum Ueberschreiben
    if (Array.isArray(body)) return json_(seedInventar_(body));

    switch (body.action) {
      case 'kasse':
        return json_({ status: 'success', ignored: true });   // alte App-Version: Zaehler je Geraet werden nicht mehr verwendet
      case 'kasseOps':
        return json_(kasseOps_(body));
      case 'kasseReset':
        return json_(kasseReset_(body));
      case 'login':
        MEMO_ = {};
        return json_(login_(body));
      case 'logout':
        MEMO_ = {};
        return json_(logout_(body));
      case 'kasseClose':
        return json_(kasseClose_(body));
      case 'kasseReopen':
        return json_(kasseReopen_(body));
      case 'changePassword':
        MEMO_ = {};
        return json_(changePassword_(body));
      case 'backupNow':
        return json_(backupNow_(body));
      case 'fileSave':
        return json_(fileSave_(body));
      case 'setMailcfg':
        return json_(setMailCfg_(body));
      case 'installTriggers':
        return json_(installTriggers_(body));
      case 'restoreBackup':
        return json_(restoreBackup_(body));
      case 'accessOps':
        MEMO_ = {};
        return json_(accessOps_(body));
      case 'dataOps':
        MEMO_ = {};
        return json_(dataOps_(body));
      case 'kasseConfig':
        return json_(saveKasseConfig_(body));
      case 'listOps':
        return json_(listOps_(body));
      case 'inventarOps':
        return json_(inventarOps_(body));
      case 'inventarSeed':
        if (!makeActor_(body.token).check(['view.inventar'], 'Inventar anlegen')) return json_({ status: 'error', code: 'perm', message: 'Keine Berechtigung.' });
        return json_(seedInventar_(body.data));
      case 'image':
        var g1 = belegGuard_(body.name, body.token, 'finance.receipt');
        if (g1) return json_(g1);
        if (String(body.name).indexOf('beleg_') !== 0 && !makeActor_(body.token).check(imageNeed_(body.name, true, false), 'Bild speichern: ' + str_(body.name, 30))) return json_({ status: 'error', code: 'perm', message: 'Keine Berechtigung.' });
        logChange_('Bilder', (String(body.name).indexOf('beleg_') === 0 ? 'Beleg gespeichert: ' : 'Bild gespeichert: ') + str_(body.name, 50), actorOf_(body));
        return json_(saveImage_(body));
      case 'imageDelete':
        var g2 = belegGuard_(body.name, body.token, 'finance.receipt');
        if (g2) return json_(g2);
        if (String(body.name).indexOf('beleg_') !== 0 && !makeActor_(body.token).check(imageNeed_(body.name, true, true), 'Bild löschen: ' + str_(body.name, 30))) return json_({ status: 'error', code: 'perm', message: 'Keine Berechtigung.' });
        logChange_('Bilder', (String(body.name).indexOf('beleg_') === 0 ? 'Beleg gelöscht: ' : 'Bild gelöscht: ') + str_(body.name, 50), actorOf_(body));
        return json_(deleteImage_(body));
    }
    return json_({ status: 'error', message: 'Unbekannte Aktion' });
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  } finally {
    MEMO_ = null;
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* -------------------------- Hilfsfunktionen ------------------- */

function num_(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}
function str_(v, max) {
  return String(v === undefined || v === null ? '' : v).substring(0, max || 200);
}
function now_() {
  return new Date().getTime();
}

function kvSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange('A:B').setNumberFormat('@');
    sh.getRange('A1:B1').setValues([['key', 'value']]);
  }
  return sh;
}
var MEMO_ = null;
function kvReadAll_(name) {
  if (MEMO_ && MEMO_[name]) {
    var copy = {};
    Object.keys(MEMO_[name]).forEach(function (k) { copy[k] = MEMO_[name][k]; });
    return copy;
  }
  var map = kvReadAllRaw_(name);
  if (MEMO_) {
    MEMO_[name] = {};
    Object.keys(map).forEach(function (k) { MEMO_[name][k] = map[k]; });
  }
  return map;
}
function kvReadAllRaw_(name) {
  var sh = kvSheet_(name);
  var last = sh.getLastRow();
  var map = {};
  if (last < 2) return map;
  var rows = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] !== '') map[String(rows[i][0])] = String(rows[i][1]);
  }
  return map;
}
function kvWrite_(name, key, value) {
  if (MEMO_) delete MEMO_[name];
  var sh = kvSheet_(name);
  var last = sh.getLastRow();
  var blank = -1;
  if (last >= 2) {
    var keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === key) {
        sh.getRange(i + 2, 2).setValue(value);
        return;
      }
      if (blank < 0 && String(keys[i][0]) === '') blank = i + 2;
    }
  }
  if (blank > 0) sh.getRange(blank, 1, 1, 2).setValues([[key, value]]);
  else sh.getRange(last + 1, 1, 1, 2).setValues([[key, value]]);
}
function kvDelete_(name, key) {
  if (MEMO_) delete MEMO_[name];
  var sh = kvSheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return;
  var keys = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === key) {
      sh.getRange(i + 2, 1, 1, 2).setValues([['', '']]);
      return;
    }
  }
}
// Schreibt einmalig Standardwerte (nur wenn noch nichts gespeichert ist), auch aus GET-Anfragen
function seedOnce_(sheet, flagKey, writes, locked) {
  var lock = null;
  try {
    if (!locked) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(8000)) return false;
    }
    if (kvReadAll_(sheet)[flagKey]) return false;
    Object.keys(writes).forEach(function (k) { kvWrite_(sheet, k, writes[k]); });
    kvWrite_(sheet, flagKey, '1');
    return true;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

/* ----------------------------- Kasse -------------------------- */

function defaultConfig_() {
  return {
    epochs: { samstag: 0, sonntag: 0 },
    prices: { waffel: 2, kinderpunsch: 2 },
    standgebuehr: 0,
    spende: { samstag: 0, sonntag: 0 },
    waffelnProTeig: 15,
    closed: { samstag: null, sonntag: null },
    ts: 0
  };
}
function readConfig_() {
  var cfg = defaultConfig_();
  try {
    var raw = kvReadAll_(SHEET_KASSE)['cfg2'];
    if (raw) {
      var s = JSON.parse(raw);
      DAYS.forEach(function (d) {
        cfg.epochs[d] = num_(s.epochs && s.epochs[d], 0);
        cfg.spende[d] = Math.max(0, num_(s.spende && s.spende[d], 0));
      });
      PRODUCTS.forEach(function (p) { cfg.prices[p] = Math.max(0, num_(s.prices && s.prices[p], 2)); });
      cfg.standgebuehr = Math.max(0, num_(s.standgebuehr, 0));
      cfg.waffelnProTeig = Math.max(0, Math.floor(num_(s.waffelnProTeig, 15)));
      cfg.ts = num_(s.ts, 0);
      DAYS.forEach(function (d) {
        var c = s.closed && s.closed[d];
        cfg.closed[d] = c && num_(c.ts, 0) > 0 ? { ts: num_(c.ts, 0), by: str_(c.by, 40) } : null;
      });
    }
  } catch (ignore) {}
  return cfg;
}

function validProduct_(p) {
  return p === 'waffel' || p === 'kinderpunsch' || /^p[A-Za-z0-9]{2,30}$/.test(String(p));
}
function emptyCounts_() {
  var c = {};
  DAYS.forEach(function (d) {
    c[d] = {};
    PRODUCTS.forEach(function (p) { c[d][p] = { paid: 0, free: 0 }; });
  });
  return c;
}
function cleanCounts_(src) {
  var c = emptyCounts_();
  DAYS.forEach(function (d) {
    var day = (src && src[d]) || {};
    Object.keys(day).forEach(function (p) {
      if (!validProduct_(p) || !day[p]) return;
      c[d][p] = { paid: Math.max(0, Math.floor(num_(day[p].paid, 0))), free: Math.max(0, Math.floor(num_(day[p].free, 0))) };
    });
  });
  return c;
}
// Erstmalig: Zaehler der bisherigen Geraete (Blatt "Kasse", dev2_*) zusammenrechnen
function migrateCounts_(all) {
  var cfg = readConfig_();
  var c = emptyCounts_();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('dev2_') !== 0) return;
    var dev;
    try { dev = JSON.parse(all[key]); } catch (ignore) { return; }
    DAYS.forEach(function (d) {
      if (num_(dev.epochs && dev.epochs[d], 0) !== cfg.epochs[d]) return;
      Object.keys(dev.data || {}).forEach(function (k) {
        var m = /^(samstag|sonntag)_([A-Za-z0-9]+)_(paid|free)$/.exec(k);
        if (!m || m[1] !== d || !validProduct_(m[2])) return;
        c[d][m[2]] = c[d][m[2]] || { paid: 0, free: 0 };
        c[d][m[2]][m[3]] += Math.max(0, Math.floor(num_(dev.data[k], 0)));
      });
    });
  });
  return c;
}
function loadCounts_(all, locked) {
  if (all['counts3']) {
    try { return cleanCounts_(JSON.parse(all['counts3'])); } catch (ignore) {}
  }
  var c = migrateCounts_(all);
  seedOnce_(SHEET_KASSE, 'counts3_seeded', { counts3: JSON.stringify(c) }, locked);
  return c;
}
function readKasse_() {
  var all = kvReadAll_(SHEET_KASSE);
  return { config: readConfig_(), counts: loadCounts_(all, false) };
}
// Gemeinsamer Zaehler: jede Buchung ist eine Aenderung (+1/-1) oder ein Setzen (Korrektur), mit eindeutiger Kennung
function kasseOps_(b) {
  var all = kvReadAll_(SHEET_KASSE);
  var cfg = readConfig_();
  var counts = loadCounts_(all, true);
  var seen = [];
  try { seen = JSON.parse(all['opids'] || '[]'); } catch (ignore) {}
  if (!Array.isArray(seen)) seen = [];
  var seenMap = {};
  seen.forEach(function (id) { seenMap[id] = true; });
  var applied = [];
  var rejected = [];
  var closedRejected = [];
  var corrections = [];
  var rows = [];
  var nowTs = now_();
  var A = makeActor_(b.token);
  var deniedIds = [];
  (Array.isArray(b.ops) ? b.ops : []).slice(0, 200).forEach(function (op) {
    var id = str_(op && op.id, 40);
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) return;
    if (seenMap[id]) { applied.push(id); return; }
    if (!A.check(op && op.set !== undefined && op.set !== null ? ['kasse.correct'] : ['kasse.book'], 'Kasse: ' + (op && op.set !== undefined && op.set !== null ? 'Korrektur' : 'Buchung'))) { rejected.push(id); deniedIds.push(id); return; }
    var day = op.day;
    var prod = op.p;
    var type = op.t === 'free' ? 'free' : 'paid';
    if (DAYS.indexOf(day) < 0 || !validProduct_(prod) || num_(op.e, 0) < cfg.epochs[day]) { rejected.push(id); return; }
    // Abgeschlossener Tag: nur Buchungen, die schon vor dem Abschluss entstanden sind (Geraet war offline), zaehlen noch
    var opTs = num_(op.ts, 0);
    var cl = cfg.closed[day];
    if (cl && !(opTs > 0 && opTs <= cl.ts)) { rejected.push(id); closedRejected.push(id); return; }
    counts[day][prod] = counts[day][prod] || { paid: 0, free: 0 };
    var cur = counts[day][prod][type];
    var before = cur;
    var delta = 0;
    if (op.set !== undefined && op.set !== null) cur = Math.floor(num_(op.set, cur));
    else { delta = Math.max(-1000, Math.min(1000, Math.floor(num_(op.d, 0)))); cur = cur + delta; }
    counts[day][prod][type] = Math.max(0, Math.min(1000000, cur));
    if (op.set !== undefined && op.set !== null) {
      if (before !== counts[day][prod][type]) corrections.push('Kasse: Korrektur ' + day + ' ' + prod + ' ' + (type === 'free' ? 'Helfer' : 'bezahlt') + ': ' + before + ' → ' + counts[day][prod][type]);
    } else if (delta !== 0) {
      rows.push([opTs > 0 && opTs <= nowTs + 60000 ? opTs : nowTs, day, prod, type, delta]);
    }
    applied.push(id);
    seen.push(id);
    seenMap[id] = true;
  });
  kvWrite_(SHEET_KASSE, 'counts3', JSON.stringify(counts));
  kvWrite_(SHEET_KASSE, 'opids', JSON.stringify(seen.slice(-500)));
  try { appendBuchungen_(rows); } catch (ignore) {}
  var actor = actorOf_(b);
  logMany_('Kasse', corrections, actor);
  if (closedRejected.length) logChange_('Kasse', closedRejected.length + (closedRejected.length === 1 ? ' Buchung' : ' Buchungen') + ' für einen abgeschlossenen Tag nicht gezählt', actor);
  return { status: 'success', counts: counts, applied: applied, rejected: rejected, closedRejected: closedRejected, denied: deniedIds, config: cfg };
}
function kasseReset_(b) {
  try { if (makeActor_(b.token).check(['kasse.reset', 'system.reset'], 'Kasse zurücksetzen')) saveBackup_('vor-reset'); } catch (ignoreBackup) {}
  if (!makeActor_(b.token).check(['kasse.reset', 'system.reset'], 'Kasse zurücksetzen')) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var all = kvReadAll_(SHEET_KASSE);
  var cfg = readConfig_();
  var counts = loadCounts_(all, true);
  var wanted = (Array.isArray(b.days) ? b.days : []).filter(function (d) { return DAYS.indexOf(d) >= 0; });
  var shut = wanted.filter(function (d) { return cfg.closed[d]; });
  if (shut.length) return { status: 'error', code: 'closed', message: 'Der Tag ist abgeschlossen. Bitte zuerst wieder öffnen.' };
  dropBuchungen_(wanted);
  (Array.isArray(b.days) ? b.days : []).forEach(function (d) {
    if (DAYS.indexOf(d) < 0) return;
    Object.keys(counts[d]).forEach(function (p) { counts[d][p] = { paid: 0, free: 0 }; });
    cfg.epochs[d] = Math.max(now_(), cfg.epochs[d] + 1);
  });
  cfg.ts = now_();
  kvWrite_(SHEET_KASSE, 'counts3', JSON.stringify(counts));
  kvWrite_(SHEET_KASSE, 'cfg2', JSON.stringify(cfg));
  logChange_('Kasse', 'Kasse zurückgesetzt: ' + (Array.isArray(b.days) ? b.days.filter(function (d) { return DAYS.indexOf(d) >= 0; }).join(', ') : ''), actorOf_(b));
  return { status: 'success', counts: counts, config: cfg };
}

function saveKasseConfig_(b) {
  var patch = JSON.parse(JSON.stringify(b.patch || {}));
  var Ac = makeActor_(b.token);
  [['prices', 'finance.prices'], ['spende', 'finance.spende'], ['standgebuehr', 'finance.standgebuehr'], ['waffelnProTeig', 'finance.teig'], ['epochs', 'kasse.reset']].forEach(function (f) {
    if (patch[f[0]] !== undefined && !Ac.check(f[0] === 'prices' ? ['finance.prices', 'finance.productEdit'] : [f[1]], 'Kasse einstellen: ' + f[0])) delete patch[f[0]];
  });
  var cfg = readConfig_();
  PRODUCTS.forEach(function (p) {
    if (patch.prices && patch.prices[p] !== undefined) cfg.prices[p] = Math.max(0, num_(patch.prices[p], cfg.prices[p]));
  });
  DAYS.forEach(function (d) {
    if (patch.spende && patch.spende[d] !== undefined) cfg.spende[d] = Math.max(0, num_(patch.spende[d], cfg.spende[d]));
    if (patch.epochs && patch.epochs[d] !== undefined) cfg.epochs[d] = Math.max(cfg.epochs[d], num_(patch.epochs[d], 0));
  });
  if (patch.standgebuehr !== undefined) cfg.standgebuehr = Math.max(0, num_(patch.standgebuehr, cfg.standgebuehr));
  if (patch.waffelnProTeig !== undefined) cfg.waffelnProTeig = Math.max(0, Math.floor(num_(patch.waffelnProTeig, cfg.waffelnProTeig)));
  cfg.ts = now_();
  kvWrite_(SHEET_KASSE, 'cfg2', JSON.stringify(cfg));
  logChange_('Kasse', describeConfig_(patch), actorOf_(b));
  return { status: 'success', config: cfg };
}




/* ------------- Buchungen mit Uhrzeit, Tag abschliessen -------- */
function buchungenSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_BUCHUNGEN);
  if (!sh) {
    sh = ss.insertSheet(SHEET_BUCHUNGEN);
    sh.getRange('A1:E1').setValues([['Zeit', 'Tag', 'Produkt', 'Art', 'Menge']]);
  }
  return sh;
}
function appendBuchungen_(rows) {
  if (!rows.length) return;
  var sh = buchungenSheet_();
  var start = Math.max(sh.getLastRow(), 1) + 1;
  var need = start + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(need - sh.getMaxRows(), 500));
  sh.getRange(start, 1, rows.length, 5).setValues(rows);
}
function dropBuchungen_(days) {
  var sh = buchungenSheet_();
  var last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, 5).getValues();
  var keep = rows.filter(function (r) { return days.indexOf(String(r[1])) < 0; });
  if (keep.length === rows.length) return;
  sh.getRange(2, 1, rows.length, 5).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, 5).setValues(keep);
}
function berlinHour_(ts) {
  return Number(Utilities.formatDate(new Date(ts), 'Europe/Berlin', 'H'));
}
// Verkaeufe (bezahlt) je Tag, Produkt und Stunde
function hourly_(token) {
  var s = session_(token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('view.statistik') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var sh = buchungenSheet_();
  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, 5).getValues() : [];
  var out = {};
  DAYS.forEach(function (d) { out[d] = {}; });
  var n = 0;
  rows.forEach(function (r) {
    var day = String(r[1]);
    var prod = String(r[2]);
    if (!out[day] || String(r[3]) !== 'paid' || !validProduct_(prod)) return;
    var ts = num_(r[0], 0);
    if (!ts) return;
    var h = String(berlinHour_(ts));
    out[day][prod] = out[day][prod] || {};
    out[day][prod][h] = (out[day][prod][h] || 0) + num_(r[4], 0);
    n++;
  });
  return { status: 'success', hours: out, rows: n };
}
function kasseClose_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('kasse.close') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var day = String(b.day || '');
  if (DAYS.indexOf(day) < 0) return { status: 'error', message: 'Unbekannter Tag' };
  var cfg = readConfig_();
  if (!cfg.closed[day]) {
    cfg.closed[day] = { ts: now_(), by: s.userName || s.roles[0].name };
    cfg.ts = now_();
    kvWrite_(SHEET_KASSE, 'cfg2', JSON.stringify(cfg));
    logChange_('Kasse', 'Tag abgeschlossen: ' + day, { n: s.userName, r: s.roles[0].name, d: actorOf_(b).d });
  }
  return { status: 'success', config: cfg };
}
function kasseReopen_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('kasse.reopen') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var day = String(b.day || '');
  if (DAYS.indexOf(day) < 0) return { status: 'error', message: 'Unbekannter Tag' };
  var cfg = readConfig_();
  if (cfg.closed[day]) {
    cfg.closed[day] = null;
    cfg.ts = now_();
    kvWrite_(SHEET_KASSE, 'cfg2', JSON.stringify(cfg));
    logChange_('Kasse', 'Tag wieder geöffnet: ' + day, { n: s.userName, r: s.roles[0].name, d: actorOf_(b).d });
  }
  return { status: 'success', config: cfg };
}

/* ------------------------- Protokoll -------------------------- */
var LOG_MAX = 6000;
var LOG_TRIM = 1000;
function logSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_LOG);
    sh.getRange('A1:F1').setValues([['Zeit', 'Bereich', 'Person', 'Rolle', 'Geraet', 'Text']]);
  }
  return sh;
}
// Keine Formeln aus Texten entstehen lassen
function safeText_(v, max) {
  var t = str_(v, max);
  return /^[=+\-@]/.test(t) ? ' ' + t : t;
}
function actorOf_(b) {
  var a = (b && b.actor) || {};
  return { n: str_(a.n, 40), r: str_(a.r, 40), d: str_(a.d, 12) };
}
function logChange_(area, text, actor) {
  try {
    if (!text) return;
    actor = actor || {};
    var sh = logSheet_();
    sh.appendRow([now_(), safeText_(area, 30), safeText_(actor.n, 40), safeText_(actor.r, 40), safeText_(actor.d, 12), safeText_(text, 400)]);
    if (sh.getLastRow() > LOG_MAX + 1) sh.deleteRows(2, LOG_TRIM);
  } catch (ignore) {}
}
function logMany_(area, texts, actor) {
  var list = texts.filter(function (t) { return !!t; });
  list.slice(0, 30).forEach(function (t) { logChange_(area, t, actor); });
  if (list.length > 30) logChange_(area, '… und ' + (list.length - 30) + ' weitere Änderungen', actor);
}
function trim_(v, n) {
  return str_(v, n).replace(/^\s+|\s+$/g, '');
}
function titleOf_(it) {
  return str_(it && (it.name || it.title || it.label || it.zeit || it.time || it.id), 50);
}
function describeInvOp_(state, op) {
  var ci = op.c ? indexById_(state, op.c) : -1;
  var cat = ci >= 0 ? state[ci] : null;
  var ct = cat ? cat.title : '';
  var it = null;
  if (cat && op.i) { var ii = indexById_(cat.items, op.i); if (ii >= 0) it = cat.items[ii]; }
  switch (op.op) {
    case 'set':
      if (!it || INV_FIELDS.indexOf(op.f) < 0) return '';
      if (String(it[op.f] === undefined ? '' : it[op.f]) === String(op.v)) return '';
      return 'Inventar: ' + ct + ' / ' + (it.name || '(ohne Name)') + ': ' + op.f + ' ' + str_(it[op.f], 40) + ' → ' + str_(op.v, 40);
    case 'addItem': return 'Inventar: Eintrag angelegt: ' + str_(op.item && op.item.name, 60) + ' (' + ct + ')';
    case 'delItem': return it ? 'Inventar: Eintrag gelöscht: ' + (it.name || '(ohne Name)') + ' (' + ct + ')' : '';
    case 'moveItem': return it ? 'Inventar: Eintrag verschoben: ' + (it.name || '(ohne Name)') : '';
    case 'addCat': return 'Inventar: Kategorie angelegt: ' + str_(op.cat && op.cat.title, 60);
    case 'renameCat': case 'editCat': case 'setStatuses': return cat ? 'Inventar: Kategorie geändert: ' + ct : '';
    case 'delCat': return cat ? 'Inventar: Kategorie gelöscht: ' + ct : '';
    case 'moveCat': return cat ? 'Inventar: Kategorie verschoben: ' + ct : '';
    case 'replaceAll': return 'Inventar: komplett ersetzt';
  }
  return '';
}
var LIST_AREA = { leihgaben: 'Leihgaben', abnahme: 'Abnahme', skizze: 'Standskizze', archiv: 'Saison-Archiv', kassensturz: 'Kassensturz', expenses: 'Ausgaben', boxes: 'Boxen', strom: 'Strom', aufbau: 'Aufbau', aushang: 'Aushang', produkte: 'Produkte', rezepte: 'Rezepte' };
function describeListOp_(name, items, op) {
  var area = LIST_AREA[name] || name;
  var at = indexById_(items, op.id);
  switch (op.op) {
    case 'save':
      var it = op.item || {};
      var exists = indexById_(items, it.id) >= 0;
      return area + ': ' + titleOf_(it) + (exists ? ' geändert' : ' angelegt');
    case 'del': return at >= 0 ? area + ': ' + titleOf_(items[at]) + ' gelöscht' : '';
    case 'move': return at >= 0 ? area + ': ' + titleOf_(items[at]) + ' verschoben' : '';
    case 'addName': return at >= 0 ? area + ': „' + str_(op.entry && op.entry.n, 40) + '“ eingetragen bei ' + titleOf_(items[at]) : '';
    case 'delName': return at >= 0 ? area + ': „' + str_(op.entry && op.entry.n, 40) + '“ ausgetragen bei ' + titleOf_(items[at]) : '';
    case 'claim': return at >= 0 ? area + ': Waffelteig ' + titleOf_(items[at]) + ' übernommen von „' + str_(op.name, 40) + '“' : '';
    case 'clear': return at >= 0 ? area + ': Waffelteig ' + titleOf_(items[at]) + ' freigegeben' : '';
  }
  return '';
}
function describeConfig_(patch) {
  var parts = [];
  patch = patch || {};
  if (patch.prices) parts.push('Preise');
  if (patch.spende) parts.push('Spendenente');
  if (patch.standgebuehr !== undefined) parts.push('Standgebühr');
  if (patch.waffelnProTeig !== undefined) parts.push('Waffeln pro Teig');
  return parts.length ? 'Kasse: geändert: ' + parts.join(', ') : '';
}
var LOG_COLL_ = { aufgaben: ['Aufgaben', 'Aufgabe'], wettkaempfe: ['Wettkämpfe', 'Wettkampf'], trainingEinheiten: ['Wettkampfgruppe', 'Trainingseinheit'], trainingBeob: ['Wettkampfgruppe', 'Beobachtung'], trainingTage: ['Wettkampfgruppe', 'Trainingstag'], wgMitglieder: ['Wettkampfgruppe', 'Mitglied'], veranstaltungen: ['Veranstaltungen', 'Veranstaltung'], vorstandAntraege: ['Vorstand', 'Antrag'], vorstandProtokolle: ['Vorstand', 'Protokoll'], vorstandBeschluesse: ['Vorstand', 'Beschluss'], vorstandSitzungen: ['Vorstand', 'Sitzung'], vorstandUmlauf: ['Vorstand', 'Umlaufbeschluss'], material: ['Material', 'Material'], abzeichen: ['Jugend', 'Abzeichen'], abzListe: ['Jugend', 'Abzeichen-Liste'], vorlagen: ['Veranstaltungen', 'Vorlage'], kasseBuchungen: ['Jugend', 'Kassenbuchung'], kasseAuslagen: ['Jugend', 'Auslage'], kasseCfg: ['Jugend', 'Kassen-Einstellung'], kasseSturz: ['Jugend', 'Kassensturz'], kasseBudgets: ['Jugend', 'Budget'], kasseAbschluss: ['Jugend', 'Monatsabschluss'], abrechnungen: ['Abrechnung', 'Abrechnung'], fahrten: ['Abrechnung', 'Fahrt'], profile: ['Profil', 'Profil'], saetze: ['Abrechnung', 'Sätze'] };
var LOG_AREA_ = { 'Kasse': 'Weihnachtsmarkt', 'Inventar': 'Weihnachtsmarkt', 'Bilder': 'Weihnachtsmarkt', 'Leihgaben': 'Weihnachtsmarkt', 'Abnahme': 'Weihnachtsmarkt', 'Standskizze': 'Weihnachtsmarkt', 'Saison-Archiv': 'Weihnachtsmarkt', 'Kassensturz': 'Weihnachtsmarkt', 'Ausgaben': 'Weihnachtsmarkt', 'Boxen': 'Weihnachtsmarkt', 'Strom': 'Weihnachtsmarkt', 'Aufbau': 'Weihnachtsmarkt', 'Aushang': 'Weihnachtsmarkt', 'Produkte': 'Weihnachtsmarkt', 'Rezepte': 'Weihnachtsmarkt' };
// Macht aus rohen Protokollzeilen lesbare Texte und fasst Bereiche zusammen (auch fuer alte Eintraege)
function logView_(area, text) {
  area = String(area || ''); text = String(text || '');
  if (area === 'Daten') {
    var m = /^(Geändert|Neu|Gelöscht): ([A-Za-z0-9_]+)(?:: (?:set |del |patch |order )?(.*))?$/.exec(text);
    if (m) {
      var d = LOG_COLL_[m[2]] || ['Daten', m[2]];
      var verb = m[1] === 'Neu' ? 'angelegt' : m[1] === 'Gelöscht' ? 'gelöscht' : 'geändert';
      var title = (m[3] || '').replace(/^\s+|\s+$/g, '');
      return { area: d[0], text: d[1] + (title ? ' „' + title + '“' : '') + ' ' + verb };
    }
    return { area: 'Sonstiges', text: text };
  }
  if (LOG_AREA_[area]) { var low = area + ': '; return { area: LOG_AREA_[area], text: text.indexOf(low) === 0 || text.indexOf(area) === 0 ? text : area + ': ' + text }; }
  return { area: area, text: text };
}
function readLog_(p) {
  var s = session_(p.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('view.protokoll') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var sh = logSheet_();
  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, 6).getValues() : [];
  var area = str_(p.area, 30);
  var q = str_(p.q, 60).toLowerCase();
  var before = num_(p.before, 0);
  var from = num_(p.from, 0);
  var to = num_(p.to, 0);
  var limit = Math.max(1, Math.min(300, Math.floor(num_(p.limit, 100))));
  var out = [];
  var areas = {};
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    var lv = logView_(r[1], r[5]);
    areas[lv.area] = true;
    if (area && lv.area !== area) continue;
    if (before && num_(r[0], 0) >= before) continue;
    if (from && num_(r[0], 0) < from) continue;
    if (to && num_(r[0], 0) > to) continue;
    if (q && (String(r[2]) + ' ' + r[5]).toLowerCase().indexOf(q) < 0) continue;
    if (out.length < limit) out.push({ t: num_(r[0], 0), a: lv.area, n: r[2], r: r[3], d: r[4], x: lv.text });
  }
  return { entries: out, total: rows.length, areas: Object.keys(areas).sort(), more: out.length >= limit };
}

/* ------------------------- Sicherung -------------------------- */
var BACKUP_CHUNK = 40000;
var BACKUP_KEEP = { auto: 4, manuell: 100000, 'vor-wiederherstellung': 3, 'vor-reset': 3 };
function backupSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_SICHERUNG);
  if (!sh) {
    sh = ss.insertSheet(SHEET_SICHERUNG);
    sh.getRange('F:F').setNumberFormat('@');
    sh.getRange('A1:F1').setValues([['ID', 'Zeit', 'Art', 'Teil', 'Teile', 'Daten']]);
  }
  return sh;
}
function snapshot_() {
  var kasse = kvReadAll_(SHEET_KASSE);
  var kk = {};
  Object.keys(kasse).forEach(function (k) { if (k.indexOf('dev2_') !== 0 && k !== 'opids') kk[k] = kasse[k]; });
  return { v: 10, ts: now_(), inventar: String(stateSheet_().getRange('A1').getValue() || ''), kasse: kk, listen: kvReadAll_(SHEET_LISTEN), daten: kvReadAll_(SHEET_DATEN) };
}
function saveBackup_(kind) {
  var text = JSON.stringify(snapshot_());
  var sh = backupSheet_();
  var id = 'b' + now_().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  var parts = Math.max(1, Math.ceil(text.length / BACKUP_CHUNK));
  var ts = now_();
  for (var i = 0; i < parts; i++) sh.appendRow([id, ts, kind, i + 1, parts, 'B' + text.substring(i * BACKUP_CHUNK, (i + 1) * BACKUP_CHUNK)]);
  if (kind === 'auto') sh.getRange('H1').setValue(ts);
  pruneBackups_(sh);
  return { id: id, parts: parts, chars: text.length, ts: ts };
}
function backupGroups_(sh) {
  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, 5).getValues() : [];
  var groups = [];
  var byId = {};
  rows.forEach(function (r, i) {
    if (!r[0]) return;
    var g = byId[r[0]];
    if (!g) { g = byId[r[0]] = { id: String(r[0]), ts: num_(r[1], 0), kind: String(r[2]), parts: num_(r[4], 1), firstRow: i + 2, count: 0 }; groups.push(g); }
    g.count++;
  });
  groups.sort(function (a, b) { return b.ts - a.ts; });
  return groups;
}
function pruneBackups_(sh) {
  var groups = backupGroups_(sh);
  var seen = {};
  var drop = [];
  groups.forEach(function (g) {
    seen[g.kind] = (seen[g.kind] || 0) + 1;
    var keep = BACKUP_KEEP[g.kind] || 5;
    if (seen[g.kind] > keep) drop.push(g);
  });
  drop.sort(function (a, b) { return b.firstRow - a.firstRow; });
  drop.forEach(function (g) { sh.deleteRows(g.firstRow, g.count); });
}
function maybeBackup_() {
  try {
    var sh = backupSheet_();
    if (now_() - num_(sh.getRange('H1').getValue(), 0) < 24 * 3600 * 1000) return;
    saveBackup_('auto');
    logChange_('System', 'Automatische Sicherung', { n: 'System' });
  } catch (ignore) {}
}
// Fuer einen zeitgesteuerten Ausloeser im Apps-Script (optional, die Sicherung laeuft sonst bei der ersten Aenderung des Tages)
function dailyBackup() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    saveBackup_('auto');
    logChange_('System', 'Automatische Sicherung (Zeitplan)', { n: 'System' });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}
function installBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyBackup').timeBased().atHour(3).everyDays(1).create();
}
function mailCfg_() {
  var c = {}; try { c = JSON.parse(kvReadAll_(SHEET_DATEN)['einstellungen/mail'] || '{}'); } catch (e) {}
  return { to: String(c.to || 'jan@barnstorf.de'), aus: c.aus === true };
}
function setMailCfg_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('system.backup') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var to = String(b.to || '').replace(/^\s+|\s+$/g, '').substring(0, 120);
  if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { status: 'error', message: 'Das ist keine gültige E-Mail-Adresse.' };
  kvWrite_(SHEET_DATEN, 'einstellungen/mail', JSON.stringify({ to: to, aus: b.aus === true }));
  logChange_('System', 'Adresse für Meldeschluss-Mails geändert', { n: s.userName, r: s.roles[0].name });
  return { status: 'success', mail: mailCfg_() };
}
// Dateiablage im Google Drive (Ordner "SG Barnstorf Intranet" / Unterordner), z. B. Antrags-PDFs und Anwesenheitslisten
var FILE_AREAS_ = { antraege: ['vorstand.edit', 'vorstand.antraege.edit', 'vorstand.antrag'], anwesenheit: ['anwesenheit.upload', 'anwesenheit.edit', 'training.tage.edit'], dokumente: ['dokumente.edit'] };
function driveFolder_(parts) {
  var cur = null;
  var it = DriveApp.getFoldersByName('SG Barnstorf Intranet');
  cur = it.hasNext() ? it.next() : DriveApp.createFolder('SG Barnstorf Intranet');
  parts.forEach(function (n) { var i2 = cur.getFoldersByName(n); cur = i2.hasNext() ? i2.next() : cur.createFolder(n); });
  return cur;
}
function fileSave_(b) {
  var A = makeActor_(b.token);
  var area = String(b.area || '');
  if (!FILE_AREAS_[area]) return { status: 'error', message: 'Unbekannter Bereich.' };
  if (!A.check(FILE_AREAS_[area], 'Datei ablegen')) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var data = String(b.data || '');
  if (!data || data.length > 9000000) return { status: 'error', message: 'Datei fehlt oder ist zu groß (max. ca. 6 MB).' };
  var name = String(b.name || 'Datei.pdf').replace(/[\\\/:*?"<>|]/g, '_').substring(0, 100);
  if (!/\.pdf$/i.test(name)) return { status: 'error', message: 'Nur PDF-Dateien.' };
  var sub = String(b.sub || '').replace(/[^0-9A-Za-zÄÖÜäöüß_ \-]/g, '').substring(0, 40);
  try {
    var folder = driveFolder_([area === 'antraege' ? 'Anträge' : area === 'anwesenheit' ? 'Anwesenheitslisten' : 'Dokumente'].concat(sub ? [sub] : []));
    var blob = Utilities.newBlob(Utilities.base64Decode(data), 'application/pdf', name);
    var f = folder.createFile(blob);
    logChange_('Dateien', 'PDF abgelegt: ' + name + ' (' + area + ')', actorOf_(b));
    return { status: 'success', id: f.getId(), url: f.getUrl(), name: name };
  } catch (e) { return { status: 'error', message: 'Ablage im Drive fehlgeschlagen (Berechtigung im Apps-Script erteilen und neu bereitstellen): ' + e }; }
}
function hasTrigger_(fn) {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; }); } catch (e) { return null; }
}
// Zeitplaene (Sicherung 03:00, Meldeschluss-Mails 20:00) per Knopf in der Verwaltung einrichten
function installTriggers_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('system.backup') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  try {
    installBackupTrigger();
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'meldeschlussMails') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('meldeschlussMails').timeBased().atHour(20).everyDays(1).create();
  } catch (e) { return { status: 'error', message: 'Zeitplan konnte nicht eingerichtet werden (Berechtigung im Apps-Script erteilen und neu bereitstellen): ' + e }; }
  logChange_('System', 'Zeitpläne eingerichtet (Sicherung 03:00, Meldeschluss-Mails 20:00)', { n: s.userName, r: s.roles[0].name });
  return { status: 'success', backup: hasTrigger_('dailyBackup'), mails: hasTrigger_('meldeschlussMails') };
}
// Meldeschluss-Erinnerung per E-Mail: am Tag des internen Meldeschlusses und 5 Tage davor (laeuft taeglich um 20 Uhr)
function meldeschlussMails() {
  var cfg = {};
  try { cfg = JSON.parse(kvReadAll_(SHEET_DATEN)['einstellungen/mail'] || '{}'); } catch (e) {}
  var to = String(cfg.to || 'jan@barnstorf.de');
  if (cfg.aus === true || !to) return;
  var all = kvReadAll_(SHEET_DATEN);
  var today = Utilities.formatDate(new Date(), 'Europe/Berlin', 'yyyy-MM-dd');
  function plus(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().substring(0, 10); }
  var lines = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('wettkaempfe/') !== 0) return;
    var w; try { w = JSON.parse(all[k]); } catch (e) { return; }
    if (!w || !w.intMs || (w.chk && w.chk.versendet)) return;
    var t = w.title || 'Wettkampf';
    if (w.intMs === today) lines.push('HEUTE interner Meldeschluss: ' + t + (w.meldeschluss ? ' (Meldeschluss ' + w.meldeschluss.split('-').reverse().join('.') + ')' : ''));
    else if (plus(w.intMs, -5) === today) lines.push('In 5 Tagen interner Meldeschluss (' + w.intMs.split('-').reverse().join('.') + '): ' + t);
  });
  if (!lines.length) return;
  try { MailApp.sendEmail(to, 'SG Barnstorf: Meldeschluss-Erinnerung', lines.join('\n') + '\n\nZum Intranet: Wettkämpfe → Meldung prüfen und versenden.'); logChange_('System', 'Meldeschluss-Mail gesendet (' + lines.length + ')', { n: 'System' }); } catch (e) { logChange_('System', 'Meldeschluss-Mail fehlgeschlagen: ' + e, { n: 'System' }); }
}
function listBackupsApi_(token) {
  var s = session_(token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('system.backup') < 0 && s.perms.indexOf('system.restore') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  return { backups: backupGroups_(backupSheet_()).map(function (g) { return { id: g.id, ts: g.ts, kind: g.kind, kb: Math.round(g.parts * BACKUP_CHUNK / 1000) }; }), triggers: { backup: hasTrigger_('dailyBackup'), mails: hasTrigger_('meldeschlussMails') }, mail: mailCfg_() };
}
function backupNow_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('system.backup') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var r = saveBackup_('manuell');
  logChange_('System', 'Sicherung erstellt', { n: s.userName, r: s.roles[0].name });
  return { status: 'success', id: r.id, ts: r.ts };
}
function restoreBackup_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('system.restore') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var sh = backupSheet_();
  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, 6).getValues() : [];
  var mine = rows.filter(function (r) { return String(r[0]) === String(b.id); }).sort(function (a, c) { return num_(a[3], 0) - num_(c[3], 0); });
  if (!mine.length || mine.length !== num_(mine[0][4], -1)) return { status: 'error', message: 'Diese Sicherung ist unvollständig oder nicht mehr vorhanden.' };
  var snap;
  try { snap = JSON.parse(mine.map(function (r) { return String(r[5]).substring(1); }).join('')); } catch (e) { return { status: 'error', message: 'Die Sicherung ist beschädigt.' }; }
  if (!snap || typeof snap !== 'object' || !snap.listen || !snap.kasse) return { status: 'error', message: 'Die Sicherung ist beschädigt.' };
  saveBackup_('vor-wiederherstellung');
  var inv = null;
  try { inv = snap.inventar ? JSON.parse(snap.inventar) : null; } catch (ignore) {}
  if (inv && validInventar_(inv)) stateSheet_().getRange('A1').setValue(snap.inventar);
  Object.keys(snap.kasse).forEach(function (k) { kvWrite_(SHEET_KASSE, k, snap.kasse[k]); });
  var cur = kvReadAll_(SHEET_LISTEN);
  Object.keys(cur).forEach(function (k) {
    if ((k.indexOf('list_') === 0 || k.indexOf('seeded_') === 0) && snap.listen[k] === undefined) kvDelete_(SHEET_LISTEN, k);
  });
  Object.keys(snap.listen).forEach(function (k) { kvWrite_(SHEET_LISTEN, k, snap.listen[k]); });
  if (snap.daten) {
    var curD = kvReadAll_(SHEET_DATEN);
    var wr = {};
    Object.keys(curD).forEach(function (k) { if (snap.daten[k] === undefined) wr[k] = null; });
    Object.keys(snap.daten).forEach(function (k) { wr[k] = snap.daten[k]; });
    if (Object.keys(wr).length) kvWriteMany_(SHEET_DATEN, wr);
  }
  logChange_('System', 'Sicherung vom ' + new Date(num_(snap.ts, 0)).toISOString().substring(0, 16).replace('T', ' ') + ' (UTC) wiederhergestellt', { n: s.userName, r: s.roles[0].name });
  return { status: 'success', ts: num_(snap.ts, 0) };
}

/* ------------------------ Systemstatus ------------------------ */
function status_(token) {
  var s = session_(token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('view.status') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cells = 0;
  var sheets = [];
  (ss.getSheets ? ss.getSheets() : []).forEach(function (sh) {
    var c = (sh.getMaxRows ? sh.getMaxRows() : 0) * (sh.getMaxColumns ? sh.getMaxColumns() : 0);
    cells += c;
    sheets.push({ name: sh.getName(), cells: c });
  });
  var parts = [{ name: 'Weihnachtsmarkt: Inventar', chars: String(stateSheet_().getRange('A1').getValue() || '').length }];
  var listen = kvReadAll_(SHEET_LISTEN);
  Object.keys(listen).forEach(function (k) {
    if (k.indexOf('list_') === 0) parts.push({ name: 'Weihnachtsmarkt: ' + (LIST_AREA[k.substring(5)] || k.substring(5)), chars: String(listen[k]).length });
  });
  var DATEN_NAMEN = { aufgaben: 'Aufgaben', wettkaempfe: 'Wettkämpfe', trainingEinheiten: 'Training', trainingBeob: 'Training', trainingTage: 'Trainingstage', wgMitglieder: 'Wettkampfgruppe', veranstaltungen: 'Veranstaltungen', material: 'Material', abzeichen: 'Abzeichen', abzListe: 'Abzeichen', vorlagen: 'Vorlagen', abrechnungen: 'Abrechnungen', fahrten: 'Fahrten', profile: 'Profile', saetze: 'Sätze' };
  var daten = kvReadAll_(SHEET_DATEN), dsum = {};
  Object.keys(daten).forEach(function (k) {
    var c = k.split('/')[0]; var nm = DATEN_NAMEN[c] || (c.indexOf('vorstand') === 0 ? 'Vorstand' : c.indexOf('kasse') === 0 ? 'Jugendkasse' : c);
    dsum[nm] = (dsum[nm] || 0) + String(daten[k]).length;
  });
  Object.keys(dsum).forEach(function (nm) { parts.push({ name: nm, chars: dsum[nm] }); });
  var wmSum = 0, merged = [];
  parts.forEach(function (x) { if (String(x.name).indexOf('Weihnachtsmarkt') === 0) wmSum += x.chars; else merged.push(x); });
  if (wmSum) merged.push({ name: 'Weihnachtsmarkt', chars: wmSum });
  parts = merged;
  var zugang = kvReadAll_(SHEET_ZUGANG);
  var sessions = Object.keys(zugang).filter(function (k) { return k.indexOf('sess_') === 0; }).length;
  var groups = backupGroups_(backupSheet_());
  var logSh = logSheet_();
  return {
    status: 'success', version: 11, now: now_(), cells: cells, cellLimit: 10000000, sheets: sheets,
    cellMax: MAX_STATE_CHARS, parts: parts, sessions: sessions,
    users: loadUsers_().length, logRows: Math.max(0, logSh.getLastRow() - 1),
    backups: { count: groups.length, last: groups.length ? { ts: groups[0].ts, kind: groups[0].kind } : null }
  };
}

/* ------------------- Rollen, Benutzer, Anmeldung -------------- */
// Rechte-Schluessel mit Standard-Rollen (g=Gast, h=Helfer, o=Orga, a=Admin). Muss zur Liste in der Seite passen.
var PERM_DEFS = [
  ['hub.mitglieder', 'oa'],
  ['mitglieder.view', 'oa'],
  ['mitglieder.edit', 'oa'],
  ['mitglieder.anlegen', 'oa'],
  ['mitglieder.loeschen', 'a'],
  ['mitglieder.import', 'oa'],
  ['hub.trainer', 'hoa'],
  ['trainer.eigene', 'hoa'],
  ['trainer.view', 'oa'],
  ['trainer.edit', 'oa'],
  ['hub.anwesenheit', 'hoa'],
  ['anwesenheit.view', 'hoa'],
  ['anwesenheit.upload', 'hoa'],
  ['anwesenheit.edit', 'oa'],
  ['anwesenheit.loeschen', 'a'],
  ['hub.auswertung', 'oa'],
  ['auswertung.view', 'oa'],
  ['auswertung.upload', 'oa'],
  ['auswertung.print', 'oa'],
  ['hub.dokumente', 'hoa'],
  ['dokumente.view', 'hoa'],
  ['dokumente.edit', 'oa'],
  ['hub.weihnachtsmarkt', 'ghoa'],
  ['hub.jugend', 'a'],
  ['hub.aufgaben', 'a'],
  ['hub.wettkaempfe', 'a'],
  ['hub.training', 'a'],
  ['hub.veranstaltungen', 'a'],
  ['hub.vorstand', 'a'],
  ['hub.material', 'a'],
  ['view.aushang', 'ghoa'],
  ['view.inventar', 'hoa'],
  ['view.verkauf', 'hoa'],
  ['view.statistik', 'a'],
  ['view.einkaufsliste', 'hoa'],
  ['view.verkabelung', 'hoa'],
  ['view.leihgaben', 'hoa'],
  ['view.hilfe', 'ghoa'],
  ['view.lagerbestand', 'hoa'],
  ['view.boxen', 'hoa'],
  ['view.rezepte', 'hoa'],
  ['view.aufbau', 'hoa'],
  ['view.admin', 'a'],
  ['view.status', 'oa'],
  ['view.protokoll', 'a'],
  ['aushang.signup', 'ghoa'],
  ['aushang.unsignOthers', 'oa'],
  ['aushang.editRows', 'oa'],
  ['aushang.editTitle', 'oa'],
  ['aushang.editTeig', 'oa'],
  ['aushang.print', 'oa'],
  ['aushang.editInfo', 'oa'],
  ['aushang.fullNames', 'hoa'],
  ['aushang.countdown', 'a'],
  ['aushang.upload', 'a'],
  ['inventar.editBedarf', 'hoa'],
  ['inventar.editLager', 'hoa'],
  ['inventar.editStatus', 'hoa'],
  ['inventar.editName', 'oa'],
  ['inventar.editMeta', 'hoa'],
  ['inventar.cart', 'hoa'],
  ['inventar.addItem', 'oa'],
  ['inventar.deleteItem', 'oa'],
  ['inventar.moveItem', 'oa'],
  ['inventar.catAdd', 'oa'],
  ['inventar.catEdit', 'oa'],
  ['inventar.catDelete', 'oa'],
  ['einkauf.check', 'hoa'],
  ['einkauf.editPack', 'hoa'],
  ['einkauf.editPreis', 'hoa'],
  ['einkauf.editLaden', 'hoa'],
  ['einkauf.addItem', 'hoa'],
  ['einkauf.removeItem', 'hoa'],
  ['rezepte.calc', 'hoa'],
  ['rezepte.toShopping', 'hoa'],
  ['rezepte.add', 'oa'],
  ['rezepte.edit', 'oa'],
  ['rezepte.delete', 'oa'],
  ['boxen.add', 'oa'],
  ['boxen.edit', 'oa'],
  ['boxen.delete', 'oa'],
  ['strom.steckerAdd', 'oa'],
  ['strom.steckerEdit', 'oa'],
  ['strom.steckerDelete', 'oa'],
  ['strom.plan', 'oa'],
  ['strom.watt', 'oa'],
  ['strom.verteiler', 'oa'],
  ['strom.print', 'hoa'],
  ['aufbau.check', 'hoa'],
  ['aufbau.stepAdd', 'oa'],
  ['aufbau.stepEdit', 'oa'],
  ['aufbau.stepDelete', 'oa'],
  ['aufbau.noteAdd', 'oa'],
  ['aufbau.noteEdit', 'oa'],
  ['aufbau.noteDelete', 'oa'],
  ['aufbau.imageAdd', 'oa'],
  ['aufbau.imageEdit', 'oa'],
  ['aufbau.imageDelete', 'oa'],
  ['aufbau.sort', 'oa'],
  ['aufbau.print', 'hoa'],
  ['skizze.edit', 'oa'],
  ['leihgaben.add', 'oa'],
  ['leihgaben.edit', 'oa'],
  ['leihgaben.delete', 'oa'],
  ['leihgaben.status', 'hoa'],
  ['abnahme.check', 'oa'],
  ['abnahme.edit', 'oa'],
  ['abnahme.sign', 'oa'],
  ['kasse.book', 'hoa'],
  ['kasse.correct', 'a'],
  ['kasse.reset', 'a'],
  ['kasse.sturz', 'oa'],
  ['kasse.close', 'oa'],
  ['kasse.reopen', 'a'],
  ['kasse.practice', 'hoa'],
  ['kasse.report', 'oa'],
  ['finance.expenseAdd', 'a'],
  ['finance.expenseDelete', 'a'],
  ['finance.spende', 'a'],
  ['finance.standgebuehr', 'a'],
  ['finance.prices', 'a'],
  ['finance.productAdd', 'a'],
  ['finance.productEdit', 'a'],
  ['finance.productDelete', 'a'],
  ['finance.teig', 'a'],
  ['finance.receipt', 'a'],
  ['finance.export', 'a'],
  ['system.roles', 'a'],
  ['system.rechte', 'a'],
  ['system.users', 'a'],
  ['system.passwords', 'a'],
  ['system.backup', 'a'],
  ['system.restore', 'a'],
  ['system.kiosk', 'oa'],
  ['archiv.view', 'a'],
  ['archiv.create', 'a'],
  ['archiv.delete', 'a'],
  ['account.password', 'ghoa'],
  ['system.reset', 'a'],
  ['aufgaben.view', 'a'],
  ['aufgaben.own', 'a'],
  ['aufgaben.edit', 'a'],
  ['wettkaempfe.view', 'a'],
  ['wettkaempfe.import', 'a'],
  ['wettkaempfe.zeiten', 'a'],
  ['wettkaempfe.print', 'a'],
  ['training.view', 'a'],
  ['training.edit', 'a'],
  ['training.beobachtung', 'a'],
  ['training.print', 'a'],
  ['veranstaltungen.view', 'a'],
  ['veranstaltungen.edit', 'a'],
  ['veranstaltungen.check', 'a'],
  ['veranstaltungen.print', 'a'],
  ['vorstand.view', 'a'],
  ['vorstand.edit', 'a'],
  ['vorstand.print', 'a'],
  ['vorstand.antraege.view', 'a'], ['vorstand.antraege.edit', 'a'], ['vorstand.sitzungen.view', 'a'], ['vorstand.sitzungen.edit', 'a'], ['vorstand.protokolle.view', 'a'], ['vorstand.protokolle.edit', 'a'], ['vorstand.beschluesse.view', 'a'], ['vorstand.beschluesse.edit', 'a'],
  ['veranstaltungen.vorlagen', 'a'], ['wettkaempfe.vorort', 'a'], ['wettkaempfe.kampfgericht', 'a'], ['wettkaempfe.artikel', 'a'], ['wettkaempfe.meldegeld', 'oa'],
  ['material.view', 'a'],
  ['material.edit', 'a'],
  ['material.ausleihe', 'a'],
  ['material.print', 'a'],
  ['jugend.abzeichen.view', 'a'],
  ['jugend.abzeichen.edit', 'a'],
  ['hub.abrechnung', 'hoa'],
  ['hub.fahrten', 'hoa'],
  ['wettkaempfe.check', 'oa'],
  ['training.mitglieder.view', 'a'],
  ['training.mitglieder.edit', 'a'],
  ['training.tage.view', 'a'],
  ['training.tage.edit', 'a'],
  ['training.rueckblick', 'a'],
  ['vorstand.antrag', 'a'],
  ['jugend.kasse.view', 'a'],
  ['jugend.kasse.buchen', 'a'],
  ['jugend.kasse.bestaetigen', 'a'],
  ['jugend.kasse.verwalten', 'a'],
  ['jugend.kasse.print', 'a'],
  ['abrechnung.eigene', 'hoa'],
  ['abrechnung.alle', 'a'],
  ['abrechnung.saetze', 'a'],
  ['fahrten.eigene', 'hoa'],
  ['fahrten.alle', 'a'],
  ['aufgaben.anlegen', 'a'],
  ['aufgaben.loeschen', 'a'],
  ['wettkaempfe.anlegen', 'a'],
  ['wettkaempfe.loeschen', 'a'],
  ['wettkaempfe.teilnahme', 'oa'],
  ['wettkaempfe.krzahl', 'oa'],
  ['training.anlegen', 'a'],
  ['training.loeschen', 'a'],
  ['training.mitglieder.anlegen', 'a'],
  ['training.mitglieder.loeschen', 'a'],
  ['training.tage.anlegen', 'a'],
  ['training.tage.loeschen', 'a'],
  ['veranstaltungen.anlegen', 'a'],
  ['veranstaltungen.loeschen', 'a'],
  ['material.anlegen', 'a'],
  ['material.loeschen', 'a'],
  ['material.bestand', 'a'],
  ['jugend.abzeichen.anlegen', 'a'],
  ['jugend.abzeichen.loeschen', 'a'],
  ['abrechnung.ansehen', 'a'],
  ['abrechnung.bezahlen', 'a'],
  ['fahrten.ansehen', 'a'],
  ['fahrten.abrechnen', 'a']
];
var PERM_KEYS = PERM_DEFS.map(function (d) { return d[0]; });
// Diese Rechte behaelt die Administrator-Rolle immer, damit sich niemand aussperren kann
var ADMIN_CORE = ['view.admin', 'system.roles', 'system.rechte', 'system.users', 'system.passwords'];
var ROLE_LETTER = { gast: 'g', helfer: 'h', orga: 'o', admin: 'a' };
// Rechte, die mit Version 11 neu dazugekommen sind: bestehende Rollen bekommen sie einmalig nach Standard
var NEW_PERMS = [
  { v: 10, list: [['view.status', 'oa'], ['view.protokoll', 'a'], ['system.restore', 'a']] },
  { v: 11, list: [['kasse.sturz', 'oa'], ['kasse.close', 'oa'], ['kasse.reopen', 'a'], ['kasse.practice', 'hoa'], ['finance.receipt', 'a'], ['finance.export', 'a'], ['system.kiosk', 'oa']] },
  { v: 12, list: [['aushang.print', 'oa'], ['strom.print', 'hoa'], ['aufbau.print', 'hoa']] },
  { v: 13, list: [['aushang.fullNames', 'hoa'], ['aushang.countdown', 'a']] },
  { v: 14, list: [['view.leihgaben', 'hoa'], ['view.hilfe', 'ghoa'], ['aushang.editInfo', 'oa'], ['skizze.edit', 'oa'],
    ['leihgaben.add', 'oa'], ['leihgaben.edit', 'oa'], ['leihgaben.delete', 'oa'], ['leihgaben.status', 'hoa'],
    ['abnahme.check', 'oa'], ['abnahme.edit', 'oa'], ['abnahme.sign', 'oa'], ['archiv.view', 'a'], ['archiv.create', 'a'], ['archiv.delete', 'a']] },
  { v: 15, list: [['account.password', 'ghoa']] },
  { v: 16, list: [['kasse.report', 'oa']] },
  { v: 17, list: [['hub.weihnachtsmarkt', 'ghoa'], ['hub.jugend', 'a']] },
  { v: 18, list: [] },
  { v: 20, list: [] },
  { v: 21, list: [['aufgaben.anlegen', 'a'], ['aufgaben.loeschen', 'a'], ['wettkaempfe.anlegen', 'a'], ['wettkaempfe.loeschen', 'a'], ['wettkaempfe.teilnahme', 'oa'], ['wettkaempfe.krzahl', 'oa'], ['training.anlegen', 'a'], ['training.loeschen', 'a'], ['training.mitglieder.anlegen', 'a'], ['training.mitglieder.loeschen', 'a'], ['training.tage.anlegen', 'a'], ['training.tage.loeschen', 'a'], ['veranstaltungen.anlegen', 'a'], ['veranstaltungen.loeschen', 'a'], ['material.anlegen', 'a'], ['material.loeschen', 'a'], ['material.bestand', 'a'], ['jugend.abzeichen.anlegen', 'a'], ['jugend.abzeichen.loeschen', 'a'], ['abrechnung.ansehen', 'a'], ['abrechnung.bezahlen', 'a'], ['fahrten.ansehen', 'a'], ['fahrten.abrechnen', 'a']] },
  { v: 23, list: [['hub.mitglieder', 'oa'], ['mitglieder.view', 'oa'], ['mitglieder.edit', 'oa'], ['mitglieder.anlegen', 'oa'], ['mitglieder.loeschen', 'a'], ['mitglieder.import', 'oa'], ['hub.trainer', 'hoa'], ['trainer.eigene', 'hoa'], ['trainer.view', 'oa'], ['trainer.edit', 'oa'], ['hub.anwesenheit', 'hoa'], ['anwesenheit.view', 'hoa'], ['anwesenheit.upload', 'hoa'], ['anwesenheit.edit', 'oa'], ['anwesenheit.loeschen', 'a'], ['hub.auswertung', 'oa'], ['auswertung.view', 'oa'], ['auswertung.upload', 'oa'], ['auswertung.print', 'oa'], ['hub.dokumente', 'hoa'], ['dokumente.view', 'hoa'], ['dokumente.edit', 'oa']] },
  { v: 19, list: [['hub.abrechnung', 'hoa'], ['hub.fahrten', 'hoa'], ['wettkaempfe.check', 'oa'], ['abrechnung.eigene', 'hoa'], ['fahrten.eigene', 'hoa']] }
];

// Entwurf der Rollenrechte (einmalig mit Version 22): wird nur bei Rollen mit gleichem Namen UND noch ohne Rechte eingetragen.
// Verwaltung, Rechte, Passwoerter und Sicherung bleiben ausschliesslich beim Administrator. Geld: Kassenwart. Jugendkasse: nur ueber das Sonderrecht "JV | Kasse".
var ROLE_PRESETS_ = {
  'Geschäftsführung': { desc: 'Leitung des Vereinsbetriebs: Aufgaben, Wettkämpfe, Training, Veranstaltungen, Vorstand, Material', perms: ['hub.aufgaben', 'aufgaben.view', 'aufgaben.own', 'aufgaben.edit', 'aufgaben.anlegen', 'aufgaben.loeschen', 'hub.wettkaempfe', 'wettkaempfe.view', 'wettkaempfe.import', 'wettkaempfe.anlegen', 'wettkaempfe.zeiten', 'wettkaempfe.print', 'wettkaempfe.check', 'wettkaempfe.teilnahme', 'wettkaempfe.krzahl', 'wettkaempfe.meldegeld', 'wettkaempfe.vorort', 'wettkaempfe.kampfgericht', 'wettkaempfe.artikel', 'hub.training', 'training.view', 'training.edit', 'training.anlegen', 'training.beobachtung', 'training.print', 'training.mitglieder.view', 'training.mitglieder.edit', 'training.mitglieder.anlegen', 'training.tage.view', 'training.tage.edit', 'training.tage.anlegen', 'training.rueckblick', 'hub.veranstaltungen', 'veranstaltungen.view', 'veranstaltungen.edit', 'veranstaltungen.anlegen', 'veranstaltungen.check', 'veranstaltungen.print', 'veranstaltungen.vorlagen', 'hub.vorstand', 'vorstand.view', 'vorstand.edit', 'vorstand.print', 'vorstand.antrag', 'hub.material', 'material.view', 'material.edit', 'material.anlegen', 'material.ausleihe', 'material.bestand', 'material.print', 'account.password'] },
  'Kassenwart': { desc: 'Alles rund ums Geld: Abrechnungen und Fahrten prüfen, bezahlen, Sätze pflegen (nicht die Jugendkasse)', perms: ['hub.abrechnung', 'hub.fahrten', 'abrechnung.eigene', 'abrechnung.alle', 'abrechnung.ansehen', 'abrechnung.bezahlen', 'abrechnung.saetze', 'fahrten.eigene', 'fahrten.alle', 'fahrten.ansehen', 'fahrten.abrechnen', 'hub.vorstand', 'vorstand.view', 'vorstand.print', 'hub.aufgaben', 'aufgaben.view', 'aufgaben.own', 'hub.wettkaempfe', 'wettkaempfe.view', 'wettkaempfe.meldegeld', 'hub.veranstaltungen', 'veranstaltungen.view', 'account.password'] },
  'Vorstand': { desc: 'Vorstandsmitglieder: Anträge, Sitzungen, Protokolle und Beschlüsse', perms: ['hub.vorstand', 'vorstand.view', 'vorstand.edit', 'vorstand.print', 'vorstand.antrag', 'hub.aufgaben', 'aufgaben.view', 'aufgaben.own', 'hub.wettkaempfe', 'wettkaempfe.view', 'hub.veranstaltungen', 'veranstaltungen.view', 'hub.material', 'material.view', 'account.password'] },
  'Jugendvertretung': { desc: 'Jugendvertreter: Schwimmabzeichen und Veranstaltungen (die Jugendkasse nur mit dem Sonderrecht „JV | Kasse“)', perms: ['hub.jugend', 'jugend.abzeichen.view', 'jugend.abzeichen.edit', 'jugend.abzeichen.anlegen', 'hub.aufgaben', 'aufgaben.own', 'hub.veranstaltungen', 'veranstaltungen.view', 'veranstaltungen.check', 'account.password'] },
  'Trainer': { desc: 'Trainer/innen: Wettkampfgruppe, Training, Wettkämpfe, eigene Abrechnung und Fahrten', perms: ['hub.training', 'training.view', 'training.edit', 'training.anlegen', 'training.beobachtung', 'training.print', 'training.mitglieder.view', 'training.mitglieder.edit', 'training.mitglieder.anlegen', 'training.tage.view', 'training.tage.edit', 'training.tage.anlegen', 'training.rueckblick', 'hub.wettkaempfe', 'wettkaempfe.view', 'wettkaempfe.zeiten', 'wettkaempfe.print', 'wettkaempfe.check', 'wettkaempfe.teilnahme', 'wettkaempfe.krzahl', 'wettkaempfe.vorort', 'wettkaempfe.kampfgericht', 'hub.aufgaben', 'aufgaben.own', 'hub.abrechnung', 'hub.fahrten', 'abrechnung.eigene', 'fahrten.eigene', 'hub.veranstaltungen', 'veranstaltungen.view', 'veranstaltungen.check', 'hub.material', 'material.view', 'material.ausleihe', 'hub.jugend', 'jugend.abzeichen.view', 'jugend.abzeichen.edit', 'hub.vorstand', 'vorstand.antrag', 'account.password'] },
  'Helfer': { desc: 'Unterstützung für die Trainer: eigene Aufgaben, Wettkampf- und Veranstaltungshilfe', perms: ['hub.aufgaben', 'aufgaben.own', 'hub.wettkaempfe', 'wettkaempfe.view', 'wettkaempfe.vorort', 'wettkaempfe.check', 'hub.veranstaltungen', 'veranstaltungen.view', 'veranstaltungen.check', 'hub.training', 'training.view', 'training.tage.view', 'hub.material', 'material.view', 'account.password'] }
};
var JV_KASSE_EXTRA_ = { name: 'JV | Kasse', desc: 'Jugendkasse: ansehen, buchen, bestätigen, verwalten und drucken (nur für die Jugendvertretung)', perms: ['hub.jugend', 'jugend.kasse.view', 'jugend.kasse.buchen', 'jugend.kasse.bestaetigen', 'jugend.kasse.verwalten', 'jugend.kasse.print', 'jugend.abzeichen.view'] };
var PERM_VERSION = 23;
var PERM_CHILDREN_ = { 'vorstand.view': ['vorstand.antraege.view', 'vorstand.sitzungen.view', 'vorstand.protokolle.view', 'vorstand.beschluesse.view'], 'vorstand.edit': ['vorstand.antraege.edit', 'vorstand.sitzungen.edit', 'vorstand.protokolle.edit', 'vorstand.beschluesse.edit'], 'veranstaltungen.edit': ['veranstaltungen.vorlagen', 'veranstaltungen.anlegen', 'veranstaltungen.loeschen'], 'wettkaempfe.zeiten': ['wettkaempfe.vorort'], 'wettkaempfe.import': ['wettkaempfe.kampfgericht', 'wettkaempfe.artikel', 'wettkaempfe.anlegen', 'wettkaempfe.loeschen'], 'wettkaempfe.check': ['wettkaempfe.meldegeld', 'wettkaempfe.teilnahme', 'wettkaempfe.krzahl'], 'aufgaben.edit': ['aufgaben.anlegen', 'aufgaben.loeschen'], 'training.edit': ['training.anlegen', 'training.loeschen'], 'training.mitglieder.edit': ['training.mitglieder.anlegen', 'training.mitglieder.loeschen'], 'training.tage.edit': ['training.tage.anlegen', 'training.tage.loeschen'], 'material.edit': ['material.anlegen', 'material.loeschen', 'material.bestand'], 'material.ausleihe': ['material.bestand'], 'jugend.abzeichen.edit': ['jugend.abzeichen.anlegen', 'jugend.abzeichen.loeschen'], 'abrechnung.alle': ['abrechnung.ansehen', 'abrechnung.bezahlen'], 'fahrten.alle': ['fahrten.ansehen', 'fahrten.abrechnen'] };
var START_PASSWORDS = { helfer: '1', orga: '2', admin: '3' };   // nur fuer die Erstbefuellung, danach in der App aendern
var SESSION_DAYS = 60;

function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return out;
}
function hashPw_(salt, pw) {
  var h = salt + '|' + pw;
  for (var i = 0; i < 100; i++) h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + salt));
  return h;
}
function withPw_(obj, pw) {
  obj.salt = Utilities.getUuid().replace(/-/g, '');
  obj.hash = hashPw_(obj.salt, String(pw));
  return obj;
}
function defaultRoles_() {
  var meta = [
    { id: 'gast', name: 'Gast', desc: 'Aushänge ansehen und sich eintragen', letter: 'g', builtin: true },
    { id: 'helfer', name: 'Helfer', desc: 'Kasse, Rezepte, Lager', letter: 'h', builtin: false },
    { id: 'orga', name: 'Orga-Team', desc: 'Inventar, Einkäufe, Strom', letter: 'o', builtin: false },
    { id: 'admin', name: 'Administrator', desc: 'Vollzugriff', letter: 'a', builtin: true }
  ];
  return meta.map(function (m) {
    var r = { id: m.id, name: m.name, desc: m.desc, builtin: m.builtin, perms: [], mv: PERM_VERSION, rank: { admin: 0, orga: 1, helfer: 2, gast: 3 }[m.id] };
    PERM_DEFS.forEach(function (d) { if (d[1].indexOf(m.letter) >= 0) r.perms.push(d[0]); });
    if (START_PASSWORDS[m.id]) withPw_(r, START_PASSWORDS[m.id]);
    return r;
  }).sort(function (a, b) { return a.rank - b.rank; });
}
function normalizeRanks_(roles) {
  var base = { admin: 0, orga: 1, helfer: 2 };
  roles.forEach(function (r, i) {
    if (typeof r.rank !== 'number') r.rank = base[r.id] !== undefined ? base[r.id] : (r.id === 'gast' ? 1000 : 10 + i);
  });
  roles.sort(function (a, b) { return a.rank - b.rank; });
  roles.forEach(function (r, i) { r.rank = i; });
  return roles;
}
function loadRoles_(locked) {
  var roles = normalizeRanks_(loadRolesRaw_(locked));
  var changed = false, presetDone = false;
  roles.forEach(function (r) {
    var mv = typeof r.mv === 'number' ? r.mv : (r.m10 ? 10 : 0);
    if (mv >= PERM_VERSION) return;
    var letter = ROLE_LETTER[r.id];
    if (letter && r.id !== 'admin') {
      NEW_PERMS.forEach(function (g) {
        if (g.v <= mv) return;
        g.list.forEach(function (n) { if (n[1].indexOf(letter) >= 0 && (r.perms || []).indexOf(n[0]) < 0) r.perms = (r.perms || []).concat([n[0]]); });
      });
    }
    Object.keys(PERM_CHILDREN_).forEach(function (par) { if ((r.perms || []).indexOf(par) >= 0) PERM_CHILDREN_[par].forEach(function (ch) { if (r.perms.indexOf(ch) < 0) r.perms.push(ch); }); });
    if (mv < 22 && ROLE_PRESETS_[r.name] && !(r.perms || []).length) {
      r.perms = cleanPerms_(ROLE_PRESETS_[r.name].perms);
      if (!r.desc) r.desc = ROLE_PRESETS_[r.name].desc;
      presetDone = true;
      Object.keys(PERM_CHILDREN_).forEach(function (par) { if (r.perms.indexOf(par) >= 0) PERM_CHILDREN_[par].forEach(function (ch) { if (r.perms.indexOf(ch) < 0) r.perms.push(ch); }); });
    } else if (mv < 22 && ROLE_PRESETS_[r.name] && !r.desc) r.desc = ROLE_PRESETS_[r.name].desc;
    r.mv = PERM_VERSION;
    delete r.m10;
    changed = true;
  });
  if (changed) saveRoles_(roles);
  if (presetDone) {
    try {
      var ex = loadExtras_();
      if (!ex.some(function (x) { return x.name === JV_KASSE_EXTRA_.name; })) { ex.push({ id: 'x' + Utilities.getUuid().replace(/-/g, '').slice(0, 8), name: JV_KASSE_EXTRA_.name, desc: JV_KASSE_EXTRA_.desc, perms: cleanPerms_(JV_KASSE_EXTRA_.perms) }); saveExtras_(ex); }
    } catch (ignore) {}
  }
  return roles;
}
function loadRolesRaw_(locked) {
  var all = kvReadAll_(SHEET_ZUGANG);
  var roles = null;
  if (all['roles']) { try { roles = JSON.parse(all['roles']); } catch (ignore) {} }
  if (!roles || !roles.length) {
    roles = defaultRoles_();
    if (seedOnce_(SHEET_ZUGANG, 'roles_seeded', { roles: JSON.stringify(roles) }, locked)) return roles;
    var fresh = kvReadAll_(SHEET_ZUGANG)['roles'];
    if (fresh) { try { roles = JSON.parse(fresh); } catch (ignore) {} }
  }
  return roles;
}
function saveRoles_(roles) { kvWrite_(SHEET_ZUGANG, 'roles', JSON.stringify(roles)); bumpActors_(); }
function cleanIds_(list, max) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (id) {
    id = String(id || '');
    if (/^[A-Za-z0-9_-]{2,40}$/.test(id) && out.indexOf(id) < 0 && out.length < (max || 20)) out.push(id);
  });
  return out;
}
// Benutzer: mehrere Rollen (roles) plus Sonderrechte (extras). Aeltere Eintraege mit nur einer Rolle werden umgewandelt.
function loadUsers_() {
  var raw = kvReadAll_(SHEET_ZUGANG)['users'];
  var users = [];
  if (raw) { try { users = JSON.parse(raw); } catch (ignore) {} }
  if (!Array.isArray(users)) return [];
  users.forEach(function (u) {
    u.roles = cleanIds_(Array.isArray(u.roles) ? u.roles : (u.role ? [u.role] : []));
    u.extras = cleanIds_(u.extras);
    delete u.role;
  });
  return users;
}
function loadExtras_() {
  var raw = kvReadAll_(SHEET_ZUGANG)['extras'];
  var list = [];
  if (raw) { try { list = JSON.parse(raw); } catch (ignore) {} }
  return Array.isArray(list) ? list : [];
}
function saveExtras_(list) { kvWrite_(SHEET_ZUGANG, 'extras', JSON.stringify(list)); bumpActors_(); }
function cleanPerms_(p) {
  return Array.isArray(p) ? p.filter(function (k, i, a) { return PERM_KEYS.indexOf(k) >= 0 && a.indexOf(k) === i; }) : [];
}
function publicExtras_(extras) {
  return extras.map(function (x) { return { id: x.id, name: x.name, desc: x.desc || '', perms: cleanPerms_(x.perms) }; });
}
function extraById_(extras, id) {
  for (var i = 0; i < extras.length; i++) if (extras[i].id === id) return extras[i];
  return null;
}
// Rechte eines Benutzers = alle Rechte seiner Rollen + seiner Sonderrechte
function userAccess_(u, roles, extras) {
  var ids = (u.roles || []).filter(function (id) { return roleById_(roles, id); });
  if (!ids.length) ids = ['gast'];
  ids.sort(function (a, b) { return roleById_(roles, a).rank - roleById_(roles, b).rank; });   // hoechste Rolle zuerst
  var perms = [];
  var add = function (list) { list.forEach(function (k) { if (perms.indexOf(k) < 0) perms.push(k); }); };
  ids.forEach(function (id) { add(permsOf_(roleById_(roles, id))); });
  (u.extras || []).forEach(function (eid) { var x = extraById_(extras, eid); if (x) add(cleanPerms_(x.perms)); });
  return {
    roleIds: ids,
    roles: ids.map(function (id) { var r = roleById_(roles, id); return { id: r.id, name: r.name }; }),
    extras: (u.extras || []).map(function (eid) { var x = extraById_(extras, eid); return x ? { id: x.id, name: x.name } : null; }).filter(function (x) { return !!x; }),
    perms: perms
  };
}
function saveUsers_(users) { kvWrite_(SHEET_ZUGANG, 'users', JSON.stringify(users)); bumpActors_(); }
function permsOf_(role) {
  if (!role) return [];
  if (role.id === 'admin') {
    // Administrator: alles, ausser was ausdruecklich abgewaehlt wurde (neue Rechte kommen automatisch dazu)
    var excluded = role.excluded || [];
    return PERM_KEYS.filter(function (k) { return ADMIN_CORE.indexOf(k) >= 0 || excluded.indexOf(k) < 0; });
  }
  return (role.perms || []).filter(function (k) { return PERM_KEYS.indexOf(k) >= 0; });
}
function publicRoles_(roles) {
  return roles.map(function (r) {
    return { id: r.id, name: r.name, desc: r.desc || '', perms: permsOf_(r), hasPw: rollenLogin_() && !!r.hash, builtin: !!r.builtin, rank: r.rank, last: r.last || 0 };
  });
}
function publicUsers_(users) {
  return users.map(function (u) { return { id: u.id, name: u.name, role: (u.roles || [])[0] || 'gast', roles: u.roles || [], extras: u.extras || [], disabled: !!u.disabled, last: u.last || 0 }; });
}
function roleById_(roles, id) {
  for (var i = 0; i < roles.length; i++) if (roles[i].id === id) return roles[i];
  return null;
}
function newSession_(roleId, userId) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  kvWrite_(SHEET_ZUGANG, 'sess_' + token, JSON.stringify({ role: roleId, user: userId || '', ts: now_() }));
  // aufraeumen: abgelaufene und uebergrosse Mengen
  var all = kvReadAll_(SHEET_ZUGANG);
  var list = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    var v = {};
    try { v = JSON.parse(all[k]); } catch (ignore) {}
    list.push({ k: k, ts: num_(v.ts, 0) });
  });
  list.sort(function (a, b) { return b.ts - a.ts; });
  list.forEach(function (x, i) {
    if (now_() - x.ts > SESSION_DAYS * 86400000 || i >= 150) kvDelete_(SHEET_ZUGANG, x.k);
  });
  return token;
}
function dropSessions_(filter) {
  var all = kvReadAll_(SHEET_ZUGANG);
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0) return;
    var v = {};
    try { v = JSON.parse(all[k]); } catch (ignore) {}
    if (filter(v)) kvDelete_(SHEET_ZUGANG, k);
  });
}
// Liefert { roleId, userId, perms, userName } oder null
// Liefert { roleId, roleIds, roles, userId, userName, perms } oder null
function session_(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  var raw = kvReadAll_(SHEET_ZUGANG)['sess_' + token];
  if (!raw) return null;
  var v;
  try { v = JSON.parse(raw); } catch (e) { return null; }
  if (now_() - num_(v.ts, 0) > SESSION_DAYS * 86400000) return null;
  var roles = loadRoles_(true);
  if (v.user) {
    var u = null;
    loadUsers_().forEach(function (x) { if (x.id === v.user) u = x; });
    if (!u || u.disabled) return null;
    var acc = userAccess_(u, roles, loadExtras_());
    // Startpasswort noch nicht geaendert: bis dahin keine Rechte ausser "Passwort aendern"
    if (u.mustChange) return { roleId: acc.roleIds[0], roleIds: acc.roleIds, roles: acc.roles, extras: acc.extras, userId: u.id, userName: u.name, perms: ['account.password'], mustChange: true };
    return { roleId: acc.roleIds[0], roleIds: acc.roleIds, roles: acc.roles, extras: acc.extras, userId: u.id, userName: u.name, perms: acc.perms };
  }
  var role = roleById_(roles, v.role);
  if (!role) return null;
  return { roleId: role.id, roleIds: [role.id], roles: [{ id: role.id, name: role.name }], userId: '', userName: '', perms: permsOf_(role) };
}
function login_(b) {
  var roles = loadRoles_(true);
  var users = loadUsers_();
  var pw = String(b.password === undefined ? '' : b.password);
  var actor = actorOf_(b);
  var roleId = null;
  var userId = '';
  var locked = false;
  var tried = '';
  if (b.kind === 'user') {
    var nm = str_(b.name, 60).replace(/^\s+|\s+$/g, '').toLowerCase();
    tried = 'Benutzer „' + str_(b.name, 40) + '“';
    users.forEach(function (u) {
      if (!userId && nm && u.name.toLowerCase() === nm && u.hash && hashPw_(u.salt, u.ci ? pw.toLowerCase() : pw) === u.hash) {
        if (u.disabled) locked = true;
        else userId = u.id;
      }
    });
    if (userId) roleId = 'user';
  } else {
    var r = roleById_(roles, String(b.role || ''));
    tried = 'Rolle ' + (r ? r.name : str_(b.role, 30));
    if (rollenLogin_() && r && r.id !== 'gast' && r.hash && hashPw_(r.salt, pw) === r.hash) roleId = r.id;
  }
  if (!roleId) {
    Utilities.sleep(600);
    logChange_('Anmeldung', 'Fehlgeschlagen: ' + tried + (locked ? ' (Konto gesperrt)' : ''), actor);
    return { status: 'error', message: locked ? 'Dieses Konto ist gesperrt.' : 'Falsche Anmeldedaten' };
  }
  var token = newSession_(roleId === 'user' ? '' : roleId, userId);
  var s = session_(token);
  var now = now_();
  if (userId) { users.forEach(function (u) { if (u.id === userId) u.last = now; }); saveUsers_(users); }
  else { roles.forEach(function (r) { if (r.id === roleId) r.last = now; }); saveRoles_(roles); }
  logChange_('Anmeldung', (s.userName ? s.userName : 'Rollen-Anmeldung') + ' angemeldet als ' + s.roles[0].name, { n: s.userName, r: s.roles[0].name, d: actor.d });
  return { status: 'success', token: token, role: { id: s.roleId, name: s.roles[0].name }, roles: s.roles, user: s.userName, perms: s.perms, mustChange: !!s.mustChange, systems: systemsFor_(s.perms) };
}
function me_(token) {
  var s = session_(token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  return { status: 'success', user: s.userName, role: { id: s.roleId, name: s.roles[0].name }, roles: s.roles, extras: s.extras || [], perms: s.perms, mustChange: !!s.mustChange, systems: systemsFor_(s.perms) };
}
// Alles, was der Hub zum Start braucht, in EINEM Aufruf (statt drei): wer bin ich, welche Systeme, welche Rollen zur Anmeldung.
// Die Antwort wird zwischengespeichert und mit jeder Aenderung an Rollen/Benutzern/Abmeldungen ungueltig (bumpActors_).
function hub_(token) {
  var cache = actorCache_();
  var key = null;
  if (cache) {
    try {
      key = 'hub_' + (cache.get('act_ver') || '0') + '_' + (token ? String(token).slice(0, 64) : 'gast');
      var raw = cache.get(key);
      if (raw) return JSON.parse(raw);
    } catch (e) { key = key || null; }
  }
  var a = makeActor_(token);
  var out = { status: 'success', me: null, authFailed: false, systems: systemsFor_(a.perms), roles: [] };
  if (a.s) out.me = { status: 'success', user: a.s.userName, role: { id: a.s.roles[0].id, name: a.s.roles[0].name }, roles: a.s.roles, extras: a.s.extras || [], perms: a.s.perms, mustChange: !!a.s.mustChange, systems: out.systems };
  else if (token) out.authFailed = true;
  out.roles = loadRoles_(false).filter(function (r) { return rollenLogin_() && r.id !== 'gast' && r.hash; }).map(function (r) { return { id: r.id, name: r.name, desc: r.desc || '', hasPw: true }; });
  if (cache && key && !out.authFailed) { try { cache.put(key, JSON.stringify(out), 120); } catch (e) { /* egal */ } }
  return out;
}
// Alles fuer die Verwaltung im Hub in EINEM Aufruf: Konto, Rollen, Rechte-Katalog, Benutzer, Sonderrechte.
function verwaltung_(token) {
  var a = makeActor_(token);
  if (!a.s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  var systems = systemsFor_(a.perms);
  var out = {
    status: 'success',
    me: { status: 'success', user: a.s.userName, role: { id: a.s.roles[0].id, name: a.s.roles[0].name }, roles: a.s.roles, extras: a.s.extras || [], perms: a.s.perms, mustChange: !!a.s.mustChange, systems: systems },
    systems: systems,
    roles: publicRoles_(loadRoles_(false)),
    catalog: { status: 'success', groups: PERM_CATALOG, sections: PERM_SECTIONS_, core: ADMIN_CORE_PERMS_ },
    users: null, extras: null
  };
  if (a.perms.indexOf('system.users') >= 0 || a.perms.indexOf('system.rechte') >= 0 || a.perms.indexOf('system.roles') >= 0) {
    out.users = publicUsers_(loadUsers_());
    out.extras = publicExtras_(loadExtras_());
  }
  return out;
}
// Persoenliches Konto: eigenes Passwort aendern (altes Passwort noetig). Andere Sitzungen dieses Kontos werden beendet.
function changePassword_(b) {
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (!s.userId) return { status: 'error', code: 'role', message: 'Rollen-Passwörter ändert ein Administrator. Nur persönliche Konten haben ein eigenes Passwort.' };
  if (s.perms.indexOf('account.password') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  var forced = !!s.mustChange;
  var oldPw = String(b.oldPassword === undefined ? '' : b.oldPassword);
  var newPw = String(b.newPassword === undefined ? '' : b.newPassword);
  var actor = { n: s.userName, r: s.roles[0].name, d: actorOf_(b).d };
  if (newPw.length < 6 || newPw.length > 100) return { status: 'error', message: 'Das neue Passwort braucht mindestens 6 Zeichen.' };
  var users = loadUsers_();
  var u = null;
  users.forEach(function (x) { if (x.id === s.userId) u = x; });
  if (!u || (!forced && (!u.hash || hashPw_(u.salt, u.ci ? oldPw.toLowerCase() : oldPw) !== u.hash))) {
    Utilities.sleep(600);
    logChange_('Anmeldung', 'Passwort ändern fehlgeschlagen: ' + s.userName, actor);
    return { status: 'error', message: 'Das aktuelle Passwort stimmt nicht.' };
  }
  if (forced ? newPw.toLowerCase() === String(u.name).toLowerCase() : newPw === oldPw) return { status: 'error', message: forced ? 'Das neue Passwort darf nicht dein Name sein.' : 'Das neue Passwort muss sich vom alten unterscheiden.' };
  withPw_(u, newPw);
  delete u.mustChange; delete u.ci;
  saveUsers_(users);
  var keep = 'sess_' + b.token;
  var all = kvReadAll_(SHEET_ZUGANG);
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('sess_') !== 0 || k === keep) return;
    var v = {};
    try { v = JSON.parse(all[k]); } catch (ignore) {}
    if (v.user === s.userId) kvDelete_(SHEET_ZUGANG, k);
  });
  bumpActors_();
  logChange_('Anmeldung', 'Passwort geändert: ' + s.userName, actor);
  return { status: 'success' };
}
/* ------------------- Einmalige Einrichtung der persönlichen Konten ------------------- */
// Im Apps-Script-Editor oben die Funktion "kontenNeuAnlegen" wählen und auf "Ausführen" tippen.
// Ersetzt ALLE persönlichen Konten außer deinem (Name "Jan Kettler" oder "Jan") durch die Liste unten.
// Login = Vorname, Startpasswort = Vorname (Groß-/Kleinschreibung egal). Beim ersten Login muss jede Person ein eigenes Passwort setzen,
// bis dahin hat das Konto keine Rechte. Rollen (Rechte) vergibst du danach in der Verwaltung. Rollen-Passwörter (Helfer, Orga ...) bleiben unverändert.
var NEUE_KONTEN_ = ['Nane', 'Frieda', 'Jakob', 'Finja', 'Amy', 'Philip', 'Karin', 'Henrik', 'Marina', 'Anita'];
// Rollen-Passwörter (Helfer/Orga/Admin) sind abgeschaltet: angemeldet wird nur noch mit Benutzerkonto. Rollen gelten nur als Berechtigungen.
// Notfalls wieder einschaltbar mit der Script-Eigenschaft ROLLEN_LOGIN = 1.
function rollenLogin_() {
  try { return PropertiesService.getScriptProperties().getProperty('ROLLEN_LOGIN') === '1'; } catch (e) { return false; }
}
// Läuft einmalig von selbst bei der ersten Anfrage nach dem Einspielen (Script-Eigenschaft KONTEN_V1 merkt sich, dass es erledigt ist).
function autoSetup_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('KONTEN_V1')) return;
    var lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      if (props.getProperty('KONTEN_V1')) return;
      kontenNeuAnlegen();
      props.setProperty('KONTEN_V1', '1');
    } finally { lock.releaseLock(); }
  } catch (err) { Logger.log('autoSetup_: ' + err); }
}
function kontenNeuAnlegen() {
  var users = loadUsers_();
  var keep = users.filter(function (u) { var n = String(u.name || '').toLowerCase(); return n === 'jan kettler' || n === 'jan'; }).slice(0, 1);
  if (!keep.length) {
    // Kein Konto von Jan vorhanden: neu anlegen, damit sich jemand anmelden und Rollen vergeben kann
    var nj = { id: uniqueId_('u', users.map(function (y) { return y.id; })), name: 'Jan Kettler', roles: ['admin'], extras: [], disabled: false, mustChange: true, ci: true };
    withPw_(nj, 'jan'); keep = [nj];
  }
  // Jan bleibt immer Administrator, damit nach dem Wegfall der Rollen-Anmeldung niemand ausgesperrt ist
  if ((keep[0].roles || []).indexOf('admin') < 0) keep[0].roles = (keep[0].roles || []).concat(['admin']);
  var removed = users.filter(function (u) { return u.id !== keep[0].id; });
  var out = keep.slice();
  NEUE_KONTEN_.forEach(function (name) {
    var u = { id: uniqueId_('u', out.map(function (y) { return y.id; })), name: name, roles: [], extras: [], disabled: false, mustChange: true, ci: true };
    withPw_(u, name.toLowerCase());
    out.push(u);
  });
  saveUsers_(out);
  dropSessions_(function (v) { return !!v.user && v.user !== keep[0].id; });
  logChange_('Zugang', 'Konten neu angelegt: ' + removed.length + ' alte entfernt, ' + NEUE_KONTEN_.length + ' neue (' + NEUE_KONTEN_.join(', ') + ')', { n: 'Einrichtung', r: 'Script', d: '' });
  var res = 'Fertig. Behalten: ' + keep[0].name + '. Entfernt: ' + (removed.map(function (u) { return u.name; }).join(', ') || 'keine') + '. Neu: ' + NEUE_KONTEN_.join(', ') + '.';
  Logger.log(res); return res;
}

function logout_(b) {
  bumpActors_();
  if (/^[a-f0-9]{64}$/.test(String(b.token || ''))) kvDelete_(SHEET_ZUGANG, 'sess_' + b.token);
  return { status: 'success' };
}
function listUsers_(token) {
  var s = session_(token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf('system.users') < 0 && s.perms.indexOf('system.rechte') < 0 && s.perms.indexOf('system.roles') < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  return { users: publicUsers_(loadUsers_()), extras: publicExtras_(loadExtras_()) };
}
function uniqueId_(prefix, taken) {
  var id;
  do { id = prefix + Utilities.getUuid().replace(/-/g, '').substring(0, 8); } while (taken.indexOf(id) >= 0);
  return id;
}
function accessOps_(b) {
  bumpActors_();
  var s = session_(b.token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  var can = function (perm) { return s.perms.indexOf(perm) >= 0; };
  var roles = loadRoles_(true);
  var users = loadUsers_();
  var extras = loadExtras_();
  var errors = [];
  var logs = [];
  var actorS = { n: s.userName || '', r: s.roles[0].name, d: '' };
  var minPw = function (pw) { return String(pw).length >= 4; };
  // Niemand kann anderen (oder sich selbst) Rechte geben, die er selbst nicht hat
  var isAdminActor = s.roleIds.indexOf('admin') >= 0;
  var missing = function (perms) { return isAdminActor ? [] : cleanPerms_(perms).filter(function (k) { return s.perms.indexOf(k) < 0; }); };
  var sameSet = function (a, b) { return JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort()); };
  (Array.isArray(b.ops) ? b.ops : []).slice(0, 20).forEach(function (op) {
    if (!op || typeof op !== 'object') return;
    if (op.op === 'saveRole') {
      var r = op.role || {};
      var name = str_(r.name, 40).replace(/^\s+|\s+$/g, '');
      var desc = str_(r.desc, 120);
      var existing = roleById_(roles, String(r.id || ''));
      if (!name) { errors.push('Die Rolle braucht einen Namen.'); return; }
      var dup = roles.some(function (x) { return x.name.toLowerCase() === name.toLowerCase() && (!existing || x.id !== existing.id); });
      if (dup) { errors.push('Den Rollennamen „' + name + '“ gibt es schon.'); return; }
      var perms = Array.isArray(r.perms) ? cleanPerms_(r.perms) : null;
      var hasPw = op.password !== undefined && op.password !== null && String(op.password) !== '';
      if (existing) {
        if (missing(permsOf_(existing)).length) { errors.push('Du kannst nur Rollen bearbeiten, deren Rechte du selbst hast.'); return; }
        if ((name !== existing.name || desc !== (existing.desc || '')) && !can('system.roles')) { errors.push('Keine Berechtigung, Rollen zu bearbeiten.'); return; }
        var changed = perms && !sameSet(perms, permsOf_(existing));
        if (changed && !can('system.rechte')) { errors.push('Keine Berechtigung, Rechte zu ändern.'); return; }
        if (changed) {
          var added = perms.filter(function (k) { return permsOf_(existing).indexOf(k) < 0; });
          if (missing(added).length) { errors.push('Du kannst nur Rechte vergeben, die du selbst hast.'); return; }
        }
        if (hasPw && !can('system.passwords')) { errors.push('Keine Berechtigung, Passwörter zu ändern.'); return; }
        if (hasPw && existing.id === 'gast') { errors.push('Der Gast hat kein Passwort.'); return; }
        if (hasPw && !minPw(op.password)) { errors.push('Das Passwort braucht mindestens 4 Zeichen.'); return; }
        existing.name = name;
        existing.desc = desc;
        if (perms) {
          if (existing.id === 'admin') existing.excluded = PERM_KEYS.filter(function (k) { return perms.indexOf(k) < 0 && ADMIN_CORE.indexOf(k) < 0; });
          else existing.perms = perms;
        }
        if (hasPw) withPw_(existing, op.password);
        if (op.clearPassword === true && can('system.passwords') && existing.id !== 'admin') { delete existing.hash; delete existing.salt; }
        logs.push('Rolle „' + existing.name + '“ geändert' + (changed ? ' (Rechte)' : '') + (hasPw ? ' (Passwort)' : '') + (op.clearPassword === true ? ' (Anmeldung mit Rollen-Passwort abgeschaltet)' : ''));
      } else {
        if (!can('system.roles')) { errors.push('Keine Berechtigung, Rollen anzulegen.'); return; }
        if (hasPw && !minPw(op.password)) { errors.push('Das Passwort braucht mindestens 4 Zeichen.'); return; }
        var use = can('system.rechte') && perms ? perms : [];
        if (missing(use).length) { errors.push('Du kannst nur Rechte vergeben, die du selbst hast.'); return; }
        var gastRole = roleById_(roles, 'gast');
        var nr = { id: uniqueId_('r', roles.map(function (x) { return x.id; })), name: name, desc: desc, builtin: false, perms: use, mv: PERM_VERSION, rank: (gastRole ? gastRole.rank : roles.length) - 0.5 };
        if (hasPw) withPw_(nr, op.password);
        roles.push(nr);
        logs.push('Rolle „' + name + '“ angelegt');
      }
    } else if (op.op === 'moveRole') {
      if (!can('system.roles')) { errors.push('Keine Berechtigung, Rollen zu sortieren.'); return; }
      roles = normalizeRanks_(roles);
      var mi = -1;
      roles.forEach(function (x, i) { if (x.id === String(op.id || '')) mi = i; });
      var mj = mi + (num_(op.dir, 1) < 0 ? -1 : 1);
      if (mi < 0 || mj < 0 || mj >= roles.length) return;
      var mt = roles[mi].rank; roles[mi].rank = roles[mj].rank; roles[mj].rank = mt;
      roles = normalizeRanks_(roles);
      logs.push('Reihenfolge der Rollen geändert');
    } else if (op.op === 'logoutRole') {
      var lr = roleById_(roles, String(op.id || ''));
      if (!can('system.roles')) { errors.push('Keine Berechtigung.'); return; }
      if (!lr || missing(permsOf_(lr)).length) { errors.push('Du kannst nur Rollen abmelden, deren Rechte du selbst hast.'); return; }
      dropSessions_(function (v) { return !v.user && v.role === lr.id; });
      logs.push('Alle Anmeldungen mit Rollen-Passwort „' + lr.name + '“ beendet');
    } else if (op.op === 'logoutUser') {
      var lu = null;
      users.forEach(function (y) { if (y.id === op.id) lu = y; });
      if (!can('system.users')) { errors.push('Keine Berechtigung.'); return; }
      if (!lu || missing(userAccess_(lu, roles, extras).perms).length) { errors.push('Du kannst nur Benutzer abmelden, deren Rechte du selbst hast.'); return; }
      dropSessions_(function (v) { return v.user === lu.id; });
      logs.push('Benutzer „' + lu.name + '“ überall abgemeldet');
    } else if (op.op === 'delRole') {
      var dr = roleById_(roles, String(op.id || ''));
      if (!can('system.roles')) { errors.push('Keine Berechtigung, Rollen zu löschen.'); return; }
      if (!dr || dr.builtin) { errors.push('Diese Rolle kann nicht gelöscht werden.'); return; }
      if (missing(permsOf_(dr)).length) { errors.push('Du kannst nur Rollen löschen, deren Rechte du selbst hast.'); return; }
      roles = roles.filter(function (x) { return x.id !== dr.id; });
      logs.push('Rolle „' + dr.name + '“ gelöscht');
      users.forEach(function (u) { u.roles = u.roles.filter(function (id) { return id !== dr.id; }); });
      dropSessions_(function (v) { return !v.user && v.role === dr.id; });
    } else if (op.op === 'saveExtra') {
      var x = op.extra || {};
      var xname = str_(x.name, 40).replace(/^\s+|\s+$/g, '');
      var xe = extraById_(extras, String(x.id || ''));
      if (!can('system.rechte')) { errors.push('Keine Berechtigung, Sonderrechte zu verwalten.'); return; }
      if (xe && missing(cleanPerms_(xe.perms)).length) { errors.push('Du kannst nur Sonderrechte bearbeiten, deren Rechte du selbst hast.'); return; }
      if (!xname) { errors.push('Das Sonderrecht braucht einen Namen.'); return; }
      if (extras.some(function (y) { return y.name.toLowerCase() === xname.toLowerCase() && (!xe || y.id !== xe.id); })) { errors.push('Den Namen „' + xname + '“ gibt es bei den Sonderrechten schon.'); return; }
      var xperms = cleanPerms_(x.perms);
      var xadded = xperms.filter(function (k) { return !xe || cleanPerms_(xe.perms).indexOf(k) < 0; });
      if (missing(xadded).length) { errors.push('Du kannst nur Rechte vergeben, die du selbst hast.'); return; }
      logs.push('Sonderrecht „' + xname + '“ ' + (xe ? 'geändert' : 'angelegt'));
      if (xe) { xe.name = xname; xe.desc = str_(x.desc, 120); xe.perms = xperms; }
      else extras.push({ id: uniqueId_('x', extras.map(function (y) { return y.id; })), name: xname, desc: str_(x.desc, 120), perms: xperms });
    } else if (op.op === 'delExtra') {
      if (!can('system.rechte')) { errors.push('Keine Berechtigung, Sonderrechte zu löschen.'); return; }
      var dx = extraById_(extras, String(op.id || ''));
      if (dx && missing(cleanPerms_(dx.perms)).length) { errors.push('Du kannst nur Sonderrechte löschen, deren Rechte du selbst hast.'); return; }
      extras = extras.filter(function (y) { return y.id !== op.id; });
      logs.push('Sonderrecht „' + (dx ? dx.name : '?') + '“ gelöscht');
      users.forEach(function (u) { u.extras = u.extras.filter(function (id) { return id !== op.id; }); });
    } else if (op.op === 'saveUser') {
      var u = op.user || {};
      var uname = str_(u.name, 40).replace(/^\s+|\s+$/g, '');
      var eu = null;
      users.forEach(function (y) { if (y.id === u.id) eu = y; });
      var pwGiven = op.password !== undefined && op.password !== null && String(op.password) !== '';
      var wantRoles = cleanIds_(Array.isArray(u.roles) ? u.roles : (u.role ? [u.role] : []));
      var wantExtras = cleanIds_(u.extras);
      var wantDisabled = u.disabled === true;
      var disabledGiven = u.disabled !== undefined;
      if (!uname) { errors.push('Der Benutzer braucht einen Namen.'); return; }
      if (!wantRoles.length) { errors.push('Bitte mindestens eine Rolle wählen.'); return; }
      if (wantRoles.some(function (id) { return !roleById_(roles, id); }) || wantExtras.some(function (id) { return !extraById_(extras, id); })) { errors.push('Rolle oder Sonderrecht gibt es nicht (mehr).'); return; }
      if (users.some(function (y) { return y.name.toLowerCase() === uname.toLowerCase() && (!eu || y.id !== eu.id); })) { errors.push('Den Benutzernamen „' + uname + '“ gibt es schon.'); return; }
      if (!can('system.users')) { errors.push('Keine Berechtigung, Benutzer zu verwalten.'); return; }
      var newRoles = wantRoles.filter(function (id) { return id !== 'gast' && (!eu || eu.roles.indexOf(id) < 0); });   // Gast ist die Grundstufe und braucht keine Vergabe-Pruefung
      var newExtras = wantExtras.filter(function (id) { return !eu || eu.extras.indexOf(id) < 0; });
      var grant = [];
      newRoles.forEach(function (id) { grant = grant.concat(permsOf_(roleById_(roles, id))); });
      newExtras.forEach(function (id) { grant = grant.concat(cleanPerms_(extraById_(extras, id).perms)); });
      if (missing(grant).length) { errors.push('Du kannst nur Rollen und Sonderrechte vergeben, deren Rechte du selbst hast.'); return; }
      if (eu) {
        if (missing(userAccess_(eu, roles, extras).perms).length) { errors.push('Du kannst nur Benutzer bearbeiten, deren Rechte du selbst hast.'); return; }
        if (pwGiven && !can('system.passwords')) { errors.push('Keine Berechtigung, Passwörter zu ändern.'); return; }
        if (pwGiven && !minPw(op.password)) { errors.push('Das Passwort braucht mindestens 4 Zeichen.'); return; }
        eu.name = uname;
        eu.roles = wantRoles;
        eu.extras = wantExtras;
        if (disabledGiven) {
          if (wantDisabled && !eu.disabled) dropSessions_(function (v) { return v.user === eu.id; });
          if (wantDisabled !== !!eu.disabled) logs.push('Benutzer „' + uname + '“ ' + (wantDisabled ? 'gesperrt' : 'entsperrt'));
          eu.disabled = wantDisabled;
        }
        if (pwGiven) { withPw_(eu, op.password); delete eu.ci; if (String(eu.name).toLowerCase() !== String(actorS && actorS.n || '').toLowerCase()) eu.mustChange = true; }
        logs.push('Benutzer „' + uname + '“ geändert' + (pwGiven ? ' (Passwort)' : ''));
      } else {
        if (!pwGiven || !minPw(op.password)) { errors.push('Neue Benutzer brauchen ein Passwort (mindestens 4 Zeichen).'); return; }
        users.push(withPw_({ id: uniqueId_('u', users.map(function (y) { return y.id; })), name: uname, roles: wantRoles, extras: wantExtras, disabled: wantDisabled, mustChange: true }, op.password));
        logs.push('Benutzer „' + uname + '“ angelegt');
      }
    } else if (op.op === 'delUser') {
      if (!can('system.users')) { errors.push('Keine Berechtigung, Benutzer zu löschen.'); return; }
      var du = null;
      users.forEach(function (y) { if (y.id === op.id) du = y; });
      if (du && missing(userAccess_(du, roles, extras).perms).length) { errors.push('Du kannst nur Benutzer löschen, deren Rechte du selbst hast.'); return; }
      users = users.filter(function (y) { return y.id !== op.id; });
      dropSessions_(function (v) { return v.user === op.id; });
      logs.push('Benutzer „' + (du ? du.name : '?') + '“ gelöscht');
    }
  });
  roles = normalizeRanks_(roles);
  saveRoles_(roles);
  saveUsers_(users);
  saveExtras_(extras);
  logMany_('Zugang', logs, actorS);
  return { status: errors.length ? 'partial' : 'success', errors: errors, roles: publicRoles_(roles), users: publicUsers_(users), extras: publicExtras_(extras) };
}

/* ---------------------- Listen (Ausgaben, Boxen) -------------- */

var LIST_NAMES = ['expenses', 'boxes', 'strom', 'aufbau', 'aushang', 'produkte', 'rezepte', 'kassensturz', 'leihgaben', 'abnahme', 'skizze', 'archiv'];
function listName_(name) {
  if (LIST_NAMES.indexOf(name) < 0) throw new Error('Unbekannte Liste');
  return name;
}
function idOk_(id) {
  return /^[A-Za-z0-9_-]{3,40}$/.test(String(id || ''));
}
function cardIdOk_(id) {
  return /^[A-Za-z0-9_~-]{3,60}$/.test(String(id || ''));
}
function defaultBoxes_() {
  var out = [];
  for (var i = 1; i <= 10; i++) out.push({ id: 'box' + (i < 10 ? '0' : '') + i, name: 'Box ' + i, desc: '' });
  return out;
}
function defaultAushang_() {
  var out = [];
  var days = [
    { key: 'sa', day: 'samstag', text: 'Samstag', slots: [['aufbau', 'Aufbau (ab 12:30 Uhr)'], ['14', '14 - 15 Uhr'], ['15', '15 - 16 Uhr'], ['16', '16 - 17 Uhr'], ['17', '17 - 18 Uhr'], ['18', '18 - 19 Uhr'], ['abbau', 'Abbau (ab 19 Uhr)']] },
    { key: 'so', day: 'sonntag', text: 'Sonntag', slots: [['aufbau', 'Aufbau (ab 13 Uhr)'], ['14', '14 - 15 Uhr'], ['15', '15 - 16 Uhr'], ['16', '16 - 17 Uhr'], ['17', '17 - 18 Uhr'], ['abbau', 'Abbau (ab 18 Uhr)']] }
  ];
  days.forEach(function (d) {
    out.push({ id: 'meta_' + d.day, kind: 'meta', day: d.day, dateText: d.text, auxLabel: 'Aufsicht (Ü18)' });
    d.slots.forEach(function (sl) {
      out.push({ id: d.key + '_' + sl[0], kind: 'slot', day: d.day, label: sl[1], names: [], aufsicht: [], extra: '' });
    });
    for (var n = 1; n <= 10; n++) out.push({ id: 't_' + d.key + '_' + n, kind: 'teig', day: d.day, n: n, name: '', d: '' });
  });
  return out;
}
function defaultRezepte_() {
  return [
    {
      id: 'r_waffel', name: 'Belgische Waffeln', emoji: '🧇', color: 'amber', portions: 'pro Teigspende', calc: false, basis: 0,
      zutaten: [
        { id: 'z1', name: 'Eier', amount: 5, unit: '', noBuy: false, r: '' },
        { id: 'z2', name: 'Zucker', amount: 300, unit: 'g', noBuy: false, r: '' },
        { id: 'z3', name: 'Vanillezucker', amount: 2, unit: 'Päckchen', noBuy: false, r: '' },
        { id: 'z4', name: 'Salz', amount: 2, unit: 'Prisen', noBuy: false, r: '' },
        { id: 'z5', name: 'weiche Butter', amount: 400, unit: 'g', noBuy: false, r: '' },
        { id: 'z6', name: 'Mehl', amount: 500, unit: 'g', noBuy: false, r: '' },
        { id: 'z7', name: 'Backpulver', amount: 0.5, unit: 'Päckchen', noBuy: false, r: '' },
        { id: 'z8', name: 'Milch', amount: 200, unit: 'ml', noBuy: false, r: '' }],
      steps: 'Eier, Zucker, Vanillezucker und Salz miteinander verrühren, bis der Zucker aufgelöst und die Masse hell schaumig ist.\nWeiche Butter dazugeben und kurz unterrühren.\nMehl mit Backpulver vermischen und mit der Milch zur Eier-Zucker-Butter-Masse geben. Gut unterrühren.',
      note: 'Bitte eine ausreichend große Schüssel benutzen (2 l reichen nicht).'
    },
    {
      id: 'r_punsch', name: 'Winter-Kinderpunsch', emoji: '☕', color: 'rose', portions: 'Vereinsrezept, ca. 8 Liter', calc: true, basis: 8,
      zutaten: [
        { id: 'z1', name: 'Wasser', amount: 2, unit: 'l', noBuy: true, r: '' },
        { id: 'z2', name: 'Wintertee', amount: 10, unit: 'Btl.', noBuy: false, r: 'half' },
        { id: 'z3', name: 'Orangensaft', amount: 1, unit: 'l', noBuy: false, r: '' },
        { id: 'z4', name: 'Apfelsaft', amount: 2.5, unit: 'l', noBuy: false, r: '' },
        { id: 'z5', name: 'Roter Traubensaft', amount: 2.5, unit: 'l', noBuy: false, r: '' },
        { id: 'z6', name: 'Zimtstangen', amount: 2, unit: 'Stk.', noBuy: false, r: 'up' },
        { id: 'z7', name: 'Glühfix', amount: 5, unit: 'Btl.', noBuy: false, r: 'half' }],
      steps: 'Tee kochen, ziehen lassen, Beutel raus.\nDen Rest nach und nach zugeben.\nZiehen lassen.',
      note: ''
    }
  ];
}
function defaultAbnahme_() {
  var t = [
    'Strom: Verteiler und Kabel geprüft (Prüfplakette vorhanden, keine Schäden)',
    'Kabel so verlegt, dass niemand darüber stolpert',
    'Feuerlöscher griffbereit und gut zugänglich',
    'Zugang und Fluchtweg sind frei',
    'Waffeleisen und Geräte stehen sicher und standfest',
    'Handwaschmöglichkeit und Desinfektionsmittel vorhanden',
    'Preise und Hinweise zu Allergenen gut sichtbar ausgehängt',
    'Kasse eingerichtet und Wechselgeld gezählt',
    'Müllbehälter aufgestellt',
    'Erste-Hilfe-Kasten vorhanden'
  ];
  return t.map(function (x, i) { return { id: 'ab' + (i + 1), kind: 'item', title: x, text: '', done: false, by: '', at: 0 }; });
}
function defaultSkizze_() {
  var out = [
    { id: 'plan', kind: 'plan', w: 600, d: 450 },
    { id: 'huette', kind: 'huette', x: 100, y: 30, w: 400, h: 300, t: 8, label: 'Hütte' },
    { id: 'sk_tuer', kind: 'tuer', wall: 't', off: 155, len: 90, hinge: 'l', label: 'Tür' },
    { id: 'sk_klappe', kind: 'klappe', wall: 'b', off: 100, len: 200, hinge: 'l', label: 'Verkaufsklappe' }
  ];
  var els = [
    ['theke', 'Theke', '🪵', 'brown', 'rect', 160, 255, 280, 60, 1], ['eisen1', 'Waffeleisen 1', '🧇', 'amber', 'rect', 170, 265, 45, 40, 2],
    ['eisen2', 'Waffeleisen 2', '🧇', 'amber', 'rect', 222, 265, 45, 40, 2], ['eisen3', 'Waffeleisen 3', '🧇', 'amber', 'rect', 274, 265, 45, 40, 2],
    ['kasse', 'Kasse', '💶', 'emerald', 'rect', 326, 265, 40, 40, 2], ['punsch', 'Punsch', '🍷', 'rose', 'rect', 372, 262, 60, 45, 2],
    ['kuehl', 'Kühlbox', '🧊', 'sky', 'rect', 420, 160, 50, 40, 2], ['tisch1', 'Tisch schmal 1', '🪑', 'slate', 'rect', 120, 80, 120, 40, 1],
    ['tisch2', 'Tisch schmal 2', '🪑', 'slate', 'rect', 120, 130, 120, 40, 1], ['steh1', 'Stehtisch 1', '🥂', 'violet', 'round', 170, 355, 70, 70, 1],
    ['steh2', 'Stehtisch 2', '🥂', 'violet', 'round', 260, 355, 70, 70, 1], ['steh3', 'Stehtisch 3', '🥂', 'violet', 'round', 350, 355, 70, 70, 1],
    ['strom', 'Verteiler', '⚡', 'orange', 'rect', 460, 60, 30, 30, 2]
  ];
  els.forEach(function (r, i) { out.push({ id: 'sk_' + r[0], kind: 'el', label: r[1], emoji: r[2], color: r[3], shape: r[4], x: r[5], y: r[6], w: r[7], h: r[8], layer: r[9], z: i }); });
  return out;
}
function defaultList_(name) {
  if (name === 'boxes') return defaultBoxes_();
  if (name === 'strom') return [{ id: 'verteiler', kind: 'verteiler', dosen: 6, ampGesamt: 16, ampDose: 16, phasen: 1, zuordnung: 'rund' }];
  if (name === 'aushang') return defaultAushang_();
  if (name === 'rezepte') return defaultRezepte_();
  if (name === 'abnahme') return defaultAbnahme_();
  if (name === 'skizze') return defaultSkizze_();
  return [];
}
// Standardeintraege (Boxen, Verteiler, Aushang, Rezepte) werden genau einmal gespeichert,
// danach gilt nur noch der gespeicherte Stand.
function readList_(name, locked) {
  name = listName_(name);
  var all = kvReadAll_(SHEET_LISTEN);
  var raw = all['list_' + name];
  var arr = [];
  if (raw !== undefined) {
    try { arr = JSON.parse(raw); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
  }
  var defaults = defaultList_(name);
  if (defaults.length && !all['seeded_' + name]) {
    defaults.forEach(function (d) { if (indexById_(arr, d.id) < 0) arr.push(d); });
    var writes = {};
    writes['list_' + name] = JSON.stringify(arr);
    seedOnce_(SHEET_LISTEN, 'seeded_' + name, writes, locked);
    // falls jemand anderes gleichzeitig gespeichert hat: gespeicherten Stand nehmen
    var fresh = kvReadAll_(SHEET_LISTEN)['list_' + name];
    if (fresh !== undefined) { try { arr = JSON.parse(fresh); } catch (ignore) {} }
  }
  return arr;
}
function cleanNames_(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (e) {
    var n = str_(e && e.n, 40).replace(/^\s+|\s+$/g, '');
    if (n && out.length < 20) out.push({ n: n, d: str_(e && e.d, 40) });
  });
  return out;
}
function cleanIdList_(list, max) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (id) {
    if (cardIdOk_(id) && out.indexOf(String(id)) < 0 && out.length < max) out.push(String(id));
  });
  return out;
}
var DENOMS = ['1', '2', '5', '10', '20', '50', '100', '200', '500', '1000', '2000', '5000', '10000'];   // in Cent, 1 ct bis 100 Euro
function cleanDenoms_(src) {
  var out = {};
  DENOMS.forEach(function (k) { out[k] = Math.max(0, Math.min(9999, Math.floor(num_(src && src[k], 0)))); });
  return out;
}
function cleanListItem_(name, it) {
  if (!it) return null;
  if (name === 'strom' ? !(idOk_(it.id)) : !idOk_(it.id)) return null;
  var id = String(it.id);
  if (name === 'expenses') {
    var amount = Math.round(num_(it.amount, NaN) * 100) / 100;
    if (!isFinite(amount) || amount < 0 || amount > 1000000) return null;
    var beleg = /^beleg_[A-Za-z0-9_-]{3,40}$/.test(String(it.beleg || '')) ? String(it.beleg) : '';
    return { id: id, amount: amount, note: str_(it.note, 120), ts: num_(it.ts, now_()), beleg: beleg, bt: beleg ? (it.bt === 'pdf' ? 'pdf' : 'img') : '' };
  }
  if (name === 'kassensturz') {
    if (id !== 'samstag' && id !== 'sonntag') return null;
    var ent = [];
    (Array.isArray(it.entnahmen) ? it.entnahmen : []).slice(0, 30).forEach(function (e, i) {
      var a = Math.round(num_(e && e.amount, NaN) * 100) / 100;
      if (!isFinite(a) || a <= 0 || a > 1000000) return;
      ent.push({ id: /^[A-Za-z0-9_-]{2,30}$/.test(String(e.id || '')) ? String(e.id) : 'n' + (i + 1), amount: a, note: str_(e.note, 80), ts: num_(e.ts, 0) });
    });
    return { id: id, anfang: cleanDenoms_(it.anfang), abend: cleanDenoms_(it.abend), anfangAt: num_(it.anfangAt, 0), abendAt: num_(it.abendAt, 0), entnahmen: ent, by: str_(it.by, 40) };
  }
  if (name === 'produkte') {
    if (!/^p[A-Za-z0-9]{2,30}$/.test(id)) return null;
    var pName = str_(it.name, 30).replace(/^\s+|\s+$/g, '');
    if (!pName) return null;
    var color = String(it.color || '');
    return { id: id, name: pName, emoji: str_(it.emoji, 8), unit: str_(it.unit, 12), price: Math.min(1000, Math.max(0, Math.round(num_(String(it.price).replace(',', '.'), 0) * 100) / 100)), color: /^(amber|rose|emerald|sky|violet|orange|teal|fuchsia)$/.test(color) ? color : 'emerald' };
  }
  if (name === 'rezepte') {
    if (!/^r[A-Za-z0-9_]{2,30}$/.test(id)) return null;
    var rName = str_(it.name, 60).replace(/^\s+|\s+$/g, '');
    if (!rName) return null;
    var zut = [];
    (Array.isArray(it.zutaten) ? it.zutaten : []).slice(0, 40).forEach(function (z, i) {
      var zn = str_(z && z.name, 80).replace(/^\s+|\s+$/g, '');
      if (!zn) return;
      var zid = /^[A-Za-z0-9]{1,12}$/.test(String(z.id || '')) ? String(z.id) : 'z' + (i + 1);
      zut.push({ id: zid, name: zn, amount: Math.min(100000, Math.max(0, Math.round(num_(String(z.amount).replace(',', '.'), 0) * 1000) / 1000)), unit: str_(z.unit, 12), noBuy: z.noBuy === true, r: z.r === 'up' || z.r === 'half' ? z.r : '' });
    });
    var rcolor = String(it.color || '');
    return {
      id: id, name: rName, emoji: str_(it.emoji, 8), portions: str_(it.portions, 60),
      color: /^(amber|rose|emerald|sky|violet|orange|teal|fuchsia)$/.test(rcolor) ? rcolor : 'emerald',
      calc: id === 'r_punsch', basis: id === 'r_punsch' ? Math.min(1000, Math.max(1, num_(it.basis, 8))) : 0,
      zutaten: zut, steps: str_(it.steps, 2000), note: str_(it.note, 300)
    };
  }
  if (name === 'boxes') {
    var boxName = str_(it.name, 60).replace(/^\s+|\s+$/g, '');
    if (!boxName) return null;
    return { id: id, name: boxName, desc: str_(it.desc, 120) };
  }
  if (name === 'strom') {
    if (it.kind === 'verteiler') {
      return { id: 'verteiler', kind: 'verteiler', dosen: Math.min(24, Math.max(1, Math.floor(num_(it.dosen, 6)))), ampGesamt: Math.min(200, Math.max(1, num_(it.ampGesamt, 16))), ampDose: Math.min(63, Math.max(1, num_(it.ampDose, 16))), phasen: num_(it.phasen, 1) === 3 ? 3 : 1, zuordnung: it.zuordnung === 'block' ? 'block' : 'rund' };
    }
    if (it.kind === 'karte') {
      if (!cardIdOk_(it.card)) return null;
      return { id: id, kind: 'karte', set: it.set === true, card: String(it.card), watt: Math.min(1000000, Math.max(0, num_(String(it.watt).replace(',', '.'), 0))), wattMax: Math.min(1000000, Math.max(0, num_(String(it.wattMax).replace(',', '.'), 0))), dosen: Math.min(48, Math.max(0, Math.floor(num_(it.dosen, 0)))), variant: str_(it.variant, 30) };
    }
    if (it.kind !== 'stecker') return null;
    var stName = str_(it.name, 40).replace(/^\s+|\s+$/g, '');
    return { id: id, kind: 'stecker', name: stName || 'Stecker', dose: Math.min(24, Math.max(0, Math.floor(num_(it.dose, 0)))), kabel: cleanIdList_(it.kabel, 24), geraete: cleanIdList_(it.geraete, 40) };
  }
  if (name === 'leihgaben') {
    var okD = function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : ''; };
    var lname = trim_(it.name, 80);
    if (!lname) return null;
    return { id: id, name: lname, menge: str_(it.menge, 30), von: str_(it.von, 80), kontakt: str_(it.kontakt, 80), abholung: okD(it.abholung), rueckgabe: okD(it.rueckgabe), notiz: str_(it.notiz, 300), status: ['offen', 'da', 'zurueck'].indexOf(it.status) >= 0 ? it.status : 'offen' };
  }
  if (name === 'abnahme') {
    if (it.kind === 'sign') {
      var sat = num_(it.at, 0);
      if (id !== 'sign' || !(sat > 0)) return null;
      return { id: 'sign', kind: 'sign', by: str_(it.by, 40), at: sat, note: str_(it.note, 200) };
    }
    var atitle = trim_(it.title, 120);
    if (!atitle) return null;
    return { id: id, kind: 'item', title: atitle, text: str_(it.text, 300), done: it.done === true, by: str_(it.by, 40), at: num_(it.at, 0) };
  }
  if (name === 'skizze') {
    var cl = function (v, lo, hi, def) { return Math.round(Math.max(lo, Math.min(hi, num_(v, def))) * 10) / 10; };
    var sk = it.kind;
    if (sk === 'plan') {
      if (id !== 'plan') return null;
      return { id: 'plan', kind: 'plan', w: cl(it.w, 200, 2000, 600), d: cl(it.d, 200, 2000, 450) };
    }
    if (sk === 'huette') {
      if (id !== 'huette') return null;
      return { id: 'huette', kind: 'huette', x: cl(it.x, 0, 2000, 0), y: cl(it.y, 0, 2000, 0), w: cl(it.w, 100, 2000, 400), h: cl(it.h, 100, 2000, 300), t: cl(it.t, 4, 30, 8), label: trim_(it.label, 40) || 'Hütte' };
    }
    if (sk === 'tuer' || sk === 'fenster' || sk === 'klappe') {
      return { id: id, kind: sk, wall: ['t', 'b', 'l', 'r'].indexOf(it.wall) >= 0 ? it.wall : 'b', off: cl(it.off, 0, 2000, 0), len: cl(it.len, 30, 1000, sk === 'tuer' ? 90 : (sk === 'fenster' ? 100 : 200)), hinge: it.hinge === 'r' ? 'r' : 'l', label: trim_(it.label, 40) };
    }
    var slabel = trim_(it.label, 40);
    if (!slabel) return null;
    var colors = ['brown', 'amber', 'emerald', 'sky', 'rose', 'violet', 'slate', 'orange'];
    var color = colors.indexOf(it.color) >= 0 ? it.color : 'slate';
    if (sk === 'el') {
      return { id: id, kind: 'el', label: slabel, emoji: str_(it.emoji, 8), color: color, shape: it.shape === 'round' ? 'round' : 'rect',
        x: cl(it.x, 0, 2000, 0), y: cl(it.y, 0, 2000, 0), w: cl(it.w, 5, 2000, 50), h: cl(it.h, 5, 2000, 50),
        layer: Math.max(0, Math.min(3, Math.floor(num_(it.layer, 2)))), z: Math.max(-1000, Math.min(1000, Math.floor(num_(it.z, 0)))) };
    }
    // alte Form (Prozentwerte), wird vom Client beim ersten Bearbeiten umgerechnet
    var sw = Math.max(4, Math.min(60, num_(it.w, 12)));
    var sh = Math.max(4, Math.min(60, num_(it.h, 12)));
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    return { id: id, label: slabel, emoji: str_(it.emoji, 8), shape: it.shape === 'round' ? 'round' : 'rect', color: color,
      x: r1(Math.max(0, Math.min(100 - sw, num_(it.x, 0)))), y: r1(Math.max(0, Math.min(100 - sh, num_(it.y, 0)))), w: r1(sw), h: r1(sh) };
  }
  if (name === 'archiv') {
    var alabel = trim_(it.label, 60);
    var ajson = String(it.json || '');
    if (!alabel || ajson.length > 5500) return null;
    try { var aobj = JSON.parse(ajson); if (!aobj || typeof aobj !== 'object') return null; } catch (e) { return null; }
    return { id: id, label: alabel, year: str_(it.year, 4), at: num_(it.at, now_()), by: str_(it.by, 40), json: ajson };
  }
  if (name === 'aufbau') {
    if (it.kind === 'step') return { id: id, kind: 'step', time: str_(it.time, 30), title: str_(it.title, 120), text: str_(it.text, 600), who: str_(it.who, 80), done: it.done === true, phase: it.phase === 'abbau' ? 'abbau' : 'aufbau' };
    if (it.kind === 'note') return { id: id, kind: 'note', title: str_(it.title, 120), text: str_(it.text, 3000) };
    if (it.kind === 'image') {
      if (!/^aufbau_[A-Za-z0-9_-]{3,40}$/.test(String(it.imageKey || ''))) return null;
      return { id: id, kind: 'image', title: str_(it.title, 120), text: str_(it.text, 300), imageKey: String(it.imageKey) };
    }
    return null;
  }
  if (name === 'aushang') {
    var day = it.day === 'sonntag' ? 'sonntag' : (it.day === 'samstag' ? 'samstag' : '');
    if (it.kind === 'info') {
      if (id !== 'info') return null;
      return { id: 'info', kind: 'info', text: str_(it.text, 1200) };
    }
    if (it.kind === 'countdown') {
      if (id !== 'countdown') return null;
      var okDt = function (x) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(x || '')) ? String(x) : ''; };
      var at = okDt(it.at);
      if (!at) return null;
      return { id: 'countdown', kind: 'countdown', at: at, endAt: okDt(it.endAt), label: str_(it.label, 60) };
    }
    if (!day) return null;
    if (it.kind === 'meta') return { id: id, kind: 'meta', day: day, dateText: str_(it.dateText, 40), auxLabel: str_(it.auxLabel, 30) };
    if (it.kind === 'slot') return { id: id, kind: 'slot', day: day, label: str_(it.label, 40), names: cleanNames_(it.names), aufsicht: cleanNames_(it.aufsicht), extra: str_(it.extra, 60), max: Math.max(0, Math.min(99, Math.floor(num_(it.max, 0)))), maxAux: Math.max(0, Math.min(99, Math.floor(num_(it.maxAux, 0)))) };
    if (it.kind === 'teig') return { id: id, kind: 'teig', day: day, n: Math.min(40, Math.max(1, Math.floor(num_(it.n, 1)))), name: str_(it.name, 40).replace(/^\s+|\s+$/g, ''), d: str_(it.d, 40) };
    return null;
  }
  return null;
}
function applyListOp_(name, items, op) {
  var idx = indexById_(items, op.id);
  switch (op.op) {
    case 'save':
      var clean = cleanListItem_(name, op.item);
      if (!clean) return items;
      var at = indexById_(items, clean.id);
      if (at >= 0) items[at] = clean;
      else if (items.length < MAX_LIST_ITEMS && !(name === 'produkte' && items.length >= 12) && !(name === 'archiv' && items.length >= 8)) items.push(clean);
      return items;
    case 'del':
      if (name === 'rezepte' && (op.id === 'r_waffel' || op.id === 'r_punsch')) return items;
      return items.filter(function (x) { return x.id !== op.id; });
    case 'move':
      if (idx >= 0) moveTo_(items, idx, op.to);
      return items;
    case 'addName':
      if (name === 'aushang' && idx >= 0 && items[idx].kind === 'slot') {
        var fld = op.f === 'aufsicht' ? 'aufsicht' : 'names';
        var list = cleanNames_([op.entry]);
        if (!list.length) return items;
        items[idx][fld] = items[idx][fld] || [];
        var exists = items[idx][fld].some(function (e) { return e.n.toLowerCase() === list[0].n.toLowerCase(); });
        var mx = fld === 'aufsicht' ? num_(items[idx].maxAux, 0) : num_(items[idx].max, 0);   // 0 = unbegrenzt
        if (!exists && items[idx][fld].length < 20 && (mx <= 0 || items[idx][fld].length < mx)) items[idx][fld].push(list[0]);
      }
      return items;
    case 'delName':
      if (name === 'aushang' && idx >= 0 && items[idx].kind === 'slot' && op.entry) {
        var n = str_(op.entry.n, 40).toLowerCase();
        var d = str_(op.entry.d, 40);
        var fld2 = op.f === 'aufsicht' ? 'aufsicht' : 'names';
        var found = -1;
        (items[idx][fld2] || []).forEach(function (e, i) { if (found < 0 && e.n.toLowerCase() === n && e.d === d) found = i; });
        if (found >= 0) items[idx][fld2].splice(found, 1);
      }
      return items;
    case 'claim':
      if (name === 'aushang' && idx >= 0 && items[idx].kind === 'teig' && !items[idx].name) {
        var who = str_(op.name, 40).replace(/^\s+|\s+$/g, '');
        if (who) { items[idx].name = who; items[idx].d = str_(op.d, 40); }
      }
      return items;
    case 'clear':
      if (name === 'aushang' && idx >= 0 && items[idx].kind === 'teig') { items[idx].name = ''; items[idx].d = ''; }
      return items;
  }
  return items;
}
function listOps_(b) {
  var name = listName_(b.list);
  var items = readList_(name, true);
  var texts = [];
  var A = makeActor_(b.token);
  var deniedIdx = [];
  (Array.isArray(b.ops) ? b.ops : []).forEach(function (op, oi) {
    if (op && typeof op === 'object') {
      if (!A.check(listWriteNeed_(name, op, items), 'Liste ändern: ' + name + ' (' + str_(op.op, 12) + ')')) { deniedIdx.push(oi); return; }
      try { texts.push(describeListOp_(name, items, op)); } catch (ignore) {}
      items = applyListOp_(name, items, op);
    }
  });
  logMany_(LIST_AREA[name] || name, texts, actorOf_(b));
  var text = JSON.stringify(items);
  if (text.length > MAX_STATE_CHARS) return { status: 'error', message: 'Liste zu gross' };
  kvWrite_(SHEET_LISTEN, 'list_' + name, text);
  if (defaultList_(name).length) kvWrite_(SHEET_LISTEN, 'seeded_' + name, '1');
  return { status: 'success', items: items, denied: A.denied, deniedIdx: deniedIdx };
}

/* ------------------------- Inventar --------------------------- */

function stateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_STATE) || ss.insertSheet(SHEET_STATE);
}
function validInventar_(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every(function (c) { return c && Array.isArray(c.items); });
}
// Vergibt fehlende IDs. Gleiche Reihenfolge => gleiche IDs (auch auf dem Geraet).
function withIds_(state) {
  var used = {};
  state.forEach(function (cat, ci) {
    if (!cat.id || used[cat.id]) cat.id = 'c' + ci;
    while (used[cat.id]) cat.id += 'x';
    used[cat.id] = true;
  });
  state.forEach(function (cat, ci) {
    var seen = {};
    cat.items.forEach(function (it, ii) {
      if (!it.id || seen[it.id]) it.id = 'i' + ci + '_' + ii;
      while (seen[it.id]) it.id += 'x';
      seen[it.id] = true;
    });
  });
  return state;
}
function readInventar_() {
  var raw = stateSheet_().getRange('A1').getValue();
  if (!raw) return null;
  try {
    var arr = JSON.parse(String(raw));
    return validInventar_(arr) ? withIds_(arr) : null;
  } catch (e) { return null; }
}
function writeInventar_(state) {
  var text = JSON.stringify(state);
  if (text.length > MAX_STATE_CHARS) throw new Error('Inventar zu gross fuer eine Zelle');
  stateSheet_().getRange('A1').setValue(text);
}
function seedInventar_(data) {
  if (readInventar_()) return { status: 'error', message: 'Es gibt bereits ein Inventar' };
  if (!validInventar_(data)) return { status: 'error', message: 'Ungueltige Inventardaten' };
  writeInventar_(withIds_(data));
  return { status: 'success' };
}

function cleanField_(field, v) {
  if (NUM_FIELDS.indexOf(field) >= 0) {
    var n = Math.min(1000000, Math.max(0, Math.round(num_(String(v).replace(',', '.'), 0) * 100) / 100));
    return field === 'dosen' ? Math.floor(n) : n;
  }
  if (field === 'pack' || field === 'einkauf' || field === 'lagerAus') return v === true || v === 'true';
  if (field === 'packEinheit' || field === 'einheit') return str_(v, 20);
  return str_(v, 200);
}
function cleanItem_(it) {
  var out = { id: str_(it.id, 40) };
  INV_FIELDS.forEach(function (f) {
    if (it[f] !== undefined) out[f] = cleanField_(f, it[f]);
  });
  if (out.bedarf === undefined) out.bedarf = 1;
  if (out.lager === undefined) out.lager = 0;
  if (!out.status) out.status = 'Offen';
  if (!out.name) out.name = 'Neu';
  return out;
}
function indexById_(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
  return -1;
}
function moveTo_(list, from, to) {
  if (from < 0) return;
  var target = Math.max(0, Math.min(list.length - 1, Math.floor(num_(to, from))));
  var moved = list.splice(from, 1)[0];
  list.splice(target, 0, moved);
}
function applyInventarOp_(state, op) {
  var ci = op.c ? indexById_(state, op.c) : -1;
  var cat = ci >= 0 ? state[ci] : null;
  switch (op.op) {
    case 'set':
      if (!cat || INV_FIELDS.indexOf(op.f) < 0) return;
      var ii = indexById_(cat.items, op.i);
      if (ii >= 0) cat.items[ii][op.f] = cleanField_(op.f, op.v);
      return;
    case 'addItem':
      if (cat && op.item && op.item.id && indexById_(cat.items, op.item.id) < 0) cat.items.push(cleanItem_(op.item));
      return;
    case 'delItem':
      if (cat) cat.items = cat.items.filter(function (x) { return x.id !== op.i; });
      return;
    case 'moveItem':
      if (cat) moveTo_(cat.items, indexById_(cat.items, op.i), op.to);
      return;
    case 'addCat':
      if (op.cat && op.cat.id && indexById_(state, op.cat.id) < 0) {
        state.push({ id: str_(op.cat.id, 40), title: str_(op.cat.title, 80) || 'Neue Kategorie', items: [] });
      }
      return;
    case 'renameCat':
      if (cat && str_(op.v, 80)) cat.title = str_(op.v, 80);
      return;
    case 'editCat':
      if (!cat) return;
      if (op.title !== undefined && str_(op.title, 80)) cat.title = str_(op.title, 80);
      if (op.statuses !== undefined) {
        if (Array.isArray(op.statuses) && op.statuses.length) cat.statuses = op.statuses.slice(0, 12).map(function (x) { return str_(x, 30); });
        else delete cat.statuses;
      }
      if (op.noStock !== undefined) cat.noStock = op.noStock === true;
      if (op.itemLabel !== undefined) {
        if (str_(op.itemLabel, 30)) cat.itemLabel = str_(op.itemLabel, 30);
        else delete cat.itemLabel;
      }
      return;
    case 'setStatuses':
      if (!cat) return;
      if (Array.isArray(op.v) && op.v.length) cat.statuses = op.v.slice(0, 12).map(function (s) { return str_(s, 30); });
      else delete cat.statuses;
      return;
    case 'delCat':
      if (ci >= 0) state.splice(ci, 1);
      return;
    case 'moveCat':
      moveTo_(state, ci, op.to);
      return;
    case 'replaceAll':
      if (validInventar_(op.data)) {
        state.length = 0;
        withIds_(op.data).forEach(function (c) { state.push(c); });
      }
      return;
  }
}
function inventarOps_(b) {
  var state = readInventar_();
  if (!state) return { status: 'error', message: 'Noch kein Inventar auf dem Server' };
  var texts = [];
  var A = makeActor_(b.token);
  var deniedIdx = [];
  (Array.isArray(b.ops) ? b.ops : []).forEach(function (op, oi) {
    if (op && typeof op === 'object') {
      var need = op.op === 'set' ? (INV_FIELD_PERMS_[String(op.f)] || ['inventar.editName']) : (INV_OP_PERMS_[String(op.op)] || ['system.restore']);
      if (!A.check(need, 'Inventar ändern: ' + str_(op.op, 12) + (op.op === 'set' ? ' ' + str_(op.f, 20) : ''))) { deniedIdx.push(oi); return; }
      try { texts.push(describeInvOp_(state, op)); } catch (ignore) {}
      applyInventarOp_(state, op);
    }
  });
  logMany_('Inventar', texts, actorOf_(b));
  writeInventar_(state);
  return { status: 'success', state: state, denied: A.denied, deniedIdx: deniedIdx };
}

/* ------------------------ Aushang-Bilder ---------------------- */
/* Pro Bild eine Zeile: A = Name, B = Meta (JSON), C... = Stuecke */

function imageSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_BILDER);
  if (!sh) {
    sh = ss.insertSheet(SHEET_BILDER);
    sh.getRange(1, 1, 1, 3).setValues([['name', 'meta', 'stuecke ab Spalte C']]);
    for (var i = 0; i < IMAGE_NAMES.length; i++) sh.getRange(i + 2, 1).setValue(IMAGE_NAMES[i]);
  }
  return sh;
}
// Belege sind nur mit Anmeldung und passendem Recht les- und aenderbar
function belegGuard_(names, token, perm) {
  var need = String(names || '').split(',').some(function (n) { return n.indexOf('beleg_') === 0; });
  if (!need) return null;
  var s = session_(token);
  if (!s) return { status: 'error', code: 'auth', message: 'Bitte neu anmelden.' };
  if (s.perms.indexOf(perm) < 0) return { status: 'error', code: 'perm', message: 'Keine Berechtigung.' };
  return null;
}
function imageName_(name) {
  name = String(name || '');
  if (name === 'samstag' || name === 'sonntag' || /^aufbau_[A-Za-z0-9_-]{3,40}$/.test(name) || /^beleg_[A-Za-z0-9_-]{3,40}$/.test(name)) return name;
  throw new Error('Unbekanntes Bild');
}
function imageRow_(name, create) {
  name = imageName_(name);
  var sh = imageSheet_();
  var last = sh.getLastRow();
  if (last >= 2) {
    var names = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) if (String(names[i][0]) === name) return i + 2;
  }
  if (!create) return -1;
  if (last >= 41) throw new Error('Zu viele Bilder');
  sh.getRange(last + 1, 1).setValue(name);
  return last + 1;
}
function readImageMeta_(names) {
  var sh = imageSheet_();
  var result = {};
  var wanted = names ? String(names).split(',').slice(0, 40) : IMAGE_NAMES;
  wanted.forEach(function (name) {
    var meta = null;
    try {
      var row = imageRow_(name, false);
      var raw = row > 0 ? sh.getRange(row, 2).getValue() : '';
      if (raw) meta = JSON.parse(String(raw));
    } catch (ignore) {}
    result[name] = meta && meta.chunks > 0 ? meta : null;
  });
  return result;
}
function readImage_(name) {
  var sh = imageSheet_();
  var row = imageRow_(name, false);
  if (row < 0) return { status: 'empty' };
  var raw = sh.getRange(row, 2).getValue();
  var meta = raw ? JSON.parse(String(raw)) : null;
  if (!meta || !(meta.chunks > 0)) return { status: 'empty' };
  var parts = sh.getRange(row, 3, 1, meta.chunks).getValues()[0];
  return { status: 'ok', sig: meta.sig, ts: meta.ts, data: parts.join('') };
}
function saveImage_(b) {
  var row = imageRow_(b.name, true);
  var data = String(b.data || '');
  var isPdf = data.indexOf('data:application/pdf;base64,') === 0;
  if (data.indexOf('data:image/') !== 0 && !(isPdf && String(b.name).indexOf('beleg_') === 0)) return { status: 'error', message: 'Kein Bild' };
  if (data.length > (isPdf ? 1000000 : MAX_IMAGE_CHARS)) return { status: 'error', message: isPdf ? 'PDF zu gross (hoechstens etwa 700 KB)' : 'Bild zu gross' };
  var parts = [];
  for (var i = 0; i < data.length; i += CHUNK_SIZE) parts.push(data.substring(i, i + CHUNK_SIZE));
  var sh = imageSheet_();
  var needCols = parts.length + 2;
  if (sh.getMaxColumns() < needCols) sh.insertColumnsAfter(sh.getMaxColumns(), needCols - sh.getMaxColumns());
  sh.getRange(row, 3, 1, sh.getMaxColumns() - 2).clearContent();
  sh.getRange(row, 2, 1, needCols - 1).setNumberFormat('@');
  sh.getRange(row, 3, 1, parts.length).setValues([parts]);
  sh.getRange(row, 2).setValue(JSON.stringify({ chunks: parts.length, sig: String(b.sig || ''), ts: now_() }));
  return { status: 'success', chunks: parts.length };
}
function deleteImage_(b) {
  var row = imageRow_(b.name, false);
  if (row < 0) return { status: 'success' };
  var sh = imageSheet_();
  sh.getRange(row, 3, 1, sh.getMaxColumns() - 2).clearContent();
  sh.getRange(row, 2).setValue(JSON.stringify({ chunks: 0, sig: '', ts: now_() }));
  return { status: 'success' };
}
