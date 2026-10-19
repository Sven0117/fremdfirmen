'use strict';

// Seite (index.html) und Programm (app.js) müssen zusammenpassen. Nach einem Update kann der Browser kurz eine
// alte Seite mit neuem Programm mischen – dann einmal neu laden. Bei jedem Update hier, in index.html und sw.js hochzählen.
const APP_VERSION = '8';
if (/^https?:$/.test(location.protocol)) {
  const seite = (document.querySelector('meta[name="app-version"]') || {}).content;
  if (seite !== APP_VERSION && sessionStorage.getItem('neuGeladen') !== APP_VERSION) {
    sessionStorage.setItem('neuGeladen', APP_VERSION);
    location.reload();
  }
}
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ---------- Speicher (Android-Datei oder localStorage im Browser) ----------
const Store = {
  load() {
    try {
      const s = window.Android ? Android.loadData() : localStorage.getItem('fremdfirmen');
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  },
  save(d) {
    const s = JSON.stringify(d);
    try { if (window.Android) Android.saveData(s); else localStorage.setItem('fremdfirmen', s); } catch (e) {}
  },
};

// data.firmen[] = { id, name, t, del?, personen[] = { id, name, t, del?, monate: { 'JJJJ-MM': { tage: { 1: { h, von, bis, p, b, t } } } } } }
// h = Arbeitsstunden, von/bis = Anwesenheit 'HH:MM' (Pause = Differenz), p = von Hand gewählte Pause in Minuten, b = Ort/Bemerkung
// t = Zeitstempel der letzten Änderung (für den Dropbox-Abgleich: der neuere Eintrag gewinnt)
// del = gelöscht (bleibt als Markierung stehen, damit die Löschung auch beim Kollegen ankommt)
const gespeichert = Store.load() || {};
let data = { firmen: gespeichert.firmen || [] };
// lokal = bleibt nur auf diesem Handy (Dropbox-Zugang, Abgleich-Stand) und wird nie hochgeladen
// pauseSa = Pause samstags in Minuten ('' = wie werktags nach Arbeitszeit)
let lokal = Object.assign({ key: '', pkce: '', dbx: null, rev: null, dirty: false, letzter: 0, beginn: '06:00', pauseSa: 15 }, gespeichert.lokal || {});
let aenderungen = 0;

// Ältere Daten nachrüsten: Zeitstempel ergänzen, Stundensätze entfernen (gibt es nicht mehr),
// Einträge mit Stunden aber ohne Uhrzeiten bekommen Beginn/Ende nach der Standard-Regel
function stempeln(firmen) {
  firmen.forEach((f) => {
    if (!f.t) f.t = 1;
    delete f.satz;
    f.personen = f.personen || [];
    f.personen.forEach((p) => {
      if (!p.t) p.t = 1;
      delete p.satz;
      p.monate = p.monate || {};
      Object.values(p.monate).forEach((mo) => Object.values(mo.tage).forEach((t) => {
        if (!t.t) t.t = 1;
        const h = zahl(t.h);
        if (h > 0 && !t.von && !t.bis) {
          const von = zuMin(lokal.beginn) != null ? zuMin(lokal.beginn) : 360;
          t.von = zuUhr(von);
          t.bis = zuUhr(von + h * 60 + pauseFuer(h));
        }
      }));
    });
  });
}

const saveLokal = () => Store.save({ firmen: data.firmen, lokal });
function save() {
  aenderungen++;
  lokal.dirty = true;
  saveLokal();
  planeSync(3000);
}
const aktFirmen = () => data.firmen.filter((f) => !f.del);
const leute = (f) => f.personen.filter((p) => !p.del);

const heute = new Date();
let cur = { y: heute.getFullYear(), m: heute.getMonth() };
let ansicht = { name: 'firmen', firma: null, person: null };

const $ = (id) => document.getElementById(id);
const key = (y = cur.y, m = cur.m) => `${y}-${String(m + 1).padStart(2, '0')}`;
const tageImMonat = (y, m) => new Date(y, m + 1, 0).getDate();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nachName = (a, b) => a.name.localeCompare(b.name, 'de');

// ---------- Zahlen ----------
function zahl(s) {
  if (s == null) return 0;
  const t = String(s).trim().replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : 0;
}
const fmtH = (v) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' h';

// ---------- Feiertage NRW ----------
function ostern(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mon = Math.floor((h + l - 7 * m + 114) / 31), tag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mon - 1, tag);
}
const feiertagCache = {};
function feiertage(y) {
  if (feiertagCache[y]) return feiertagCache[y];
  const o = ostern(y), plus = (n) => new Date(o.getFullYear(), o.getMonth(), o.getDate() + n);
  const liste = [new Date(y, 0, 1), plus(-2), plus(1), new Date(y, 4, 1), plus(39), plus(50), plus(60),
    new Date(y, 9, 3), new Date(y, 10, 1), new Date(y, 11, 25), new Date(y, 11, 26)];
  return (feiertagCache[y] = new Set(liste.map((d) => `${d.getMonth()}-${d.getDate()}`)));
}
function frei(y, m, d) {
  const wd = new Date(y, m, d).getDay();
  return wd === 0 || wd === 6 || feiertage(y).has(`${m}-${d}`);
}

// ---------- Zeiten ----------
// Pause nach Arbeitszeit: über 6 h = 30 min, über 9 h = 45 min (10 h ab 06:00 -> Ende 16:45)
const pauseFuer = (h) => (h > 9 ? 45 : h > 6 ? 30 : 0);
const zuMin = (uhr) => { const m = /^(\d{1,2}):(\d{2})$/.exec(uhr || ''); return m ? +m[1] * 60 + +m[2] : null; };
const zuUhr = (min) => { min = ((Math.round(min) % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };
const hText = (h) => String(Math.round(h * 100) / 100).replace('.', ',');
const spanne = (von, bis) => (zuMin(bis) - zuMin(von) + 1440) % 1440;   // Anwesenheit in Minuten (auch über Mitternacht)
// Feste Pause eines Tages in Minuten: von Hand gewählt, sonst samstags laut Einstellung; null = nach Arbeitszeit
function festePause(t, datum) {
  if (t.p != null && t.p !== '') return +t.p;
  if (datum && lokal.pauseSa !== '' && lokal.pauseSa != null && new Date(datum.y, datum.m, datum.d).getDay() === 6) return +lokal.pauseSa;
  return null;
}
const pauseTag = (t, h, datum) => { const p = festePause(t, datum); return p != null ? p : pauseFuer(h); };
// Anwesenheit (Minuten) -> Arbeitsstunden, Pause abgezogen (feste Pause oder Regel nach Arbeitszeit)
function stundenAusSpanne(min, fest) {
  if (fest != null) return Math.max(0, min - fest) / 60;
  if (min - 45 > 540) return (min - 45) / 60;
  if (min - 30 > 540) return 9;
  if (min - 30 > 360) return (min - 30) / 60;
  if (min > 360) return 6;
  return min / 60;
}
// Pause eines Eintrags in Minuten (null, wenn Zeiten fehlen)
function pauseVon(t) {
  const h = zahl(t.h);
  if (!h || zuMin(t.von) == null || zuMin(t.bis) == null) return null;
  return Math.max(0, spanne(t.von, t.bis) - Math.round(h * 60));
}
const pauseText = (min) => (min == null ? '' : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`);
const hatEintrag = (t) => !!t && (zahl(t.h) > 0 || !!t.von || !!t.bis);
// übertragbar ist auch ein Tag nur mit Bemerkung (z. B. „Urlaub“)
const kopierbar = (t) => hatEintrag(t) || !!(t && t.b);

// Ein Feld eines Tages ändern; Stunden, Beginn, Ende und Pause hängen zusammen. datum = { y, m, d } (für Samstag)
function setzeTag(t, feld, wert, datum) {
  if (feld === 'b') {
    if (wert) t.b = wert; else delete t.b;
  } else if (feld === 'h') {
    const h = zahl(wert);
    if (wert) t.h = wert; else { delete t.h; delete t.von; delete t.bis; delete t.p; }
    if (h > 0) {
      const von = zuMin(t.von) != null ? zuMin(t.von) : zuMin(lokal.beginn);
      t.von = zuUhr(von);
      t.bis = zuUhr(von + h * 60 + pauseTag(t, h, datum));
    }
  } else if (feld === 'von') {
    if (!wert) { delete t.von; }
    else {
      t.von = wert;
      const h = zahl(t.h);
      if (h > 0) t.bis = zuUhr(zuMin(wert) + h * 60 + pauseTag(t, h, datum));   // Stunden bleiben, Ende wandert mit
      else if (zuMin(t.bis) != null) t.h = hText(stundenAusSpanne(spanne(wert, t.bis), festePause(t, datum)));
    }
  } else if (feld === 'bis') {
    if (!wert) { delete t.bis; }
    else {
      t.bis = wert;
      if (zuMin(t.von) == null) t.von = lokal.beginn;
      t.h = hText(stundenAusSpanne(spanne(t.von, wert), festePause(t, datum)));   // Ende geändert -> Stunden neu
    }
  } else if (feld === 'p') {
    t.p = Math.max(0, Math.round(zahl(wert)));
    const h = zahl(t.h);
    if (h > 0 && zuMin(t.von) != null) t.bis = zuUhr(zuMin(t.von) + h * 60 + t.p);   // Pause geändert: Stunden bleiben, Ende wandert
  }
  t.t = Date.now();
}

// Pause-Auswahl einer Tageszeile (nur wenn Stunden, Beginn und Ende da sind)
function pauseHtml(t) {
  const ps = pauseVon(t);
  if (ps == null) return '';
  const werte = [0, 15, 30, 45, 60];
  if (!werte.includes(ps)) { werte.push(ps); werte.sort((a, b) => a - b); }
  return `<select class="pause" data-f="p" aria-label="Pause">` +
    werte.map((w) => `<option value="${w}"${w === ps ? ' selected' : ''}>Pause ${pauseText(w)}</option>`).join('') + '</select>';
}

// ---------- Rechnen ----------
function stundenMonat(p, k) {
  const mo = p.monate[k];
  return mo ? Object.values(mo.tage).reduce((a, t) => a + zahl(t.h), 0) : 0;
}
const stundenGesamt = (p) => Object.keys(p.monate).reduce((a, k) => a + stundenMonat(p, k), 0);
// k = Monatsschlüssel oder null für alle Monate
const summePerson = (p, k) => (k ? stundenMonat(p, k) : stundenGesamt(p));
const summeFirma = (f, k) => leute(f).reduce((a, p) => a + summePerson(p, k), 0);
const tageMonat = (p, k) => (p.monate[k] ? Object.values(p.monate[k].tage).filter((t) => zahl(t.h) > 0).length : 0);

// Immer frisch nachschlagen: nach einem Abgleich sind die Objekte ausgetauscht
const firma = () => data.firmen.find((f) => f.id === ansicht.firma && !f.del);
const person = () => { const f = firma(); return f && f.personen.find((p) => p.id === ansicht.person && !p.del); };

// ---------- Ansichten ----------
function summenKarte(titel, monat, gesamt) {
  return `<div class="card"><div class="summe"><span class="lbl">${esc(titel)}</span>` +
    `<span class="h">${fmtH(monat)}</span></div>` +
    (gesamt != null ? `<div class="gesamt"><span>Gesamt alle Monate</span><span>${fmtH(gesamt)}</span></div>` : '') +
    `</div>`;
}

function render() {
  const mText = `${MONATE[cur.m]} ${cur.y}`;
  $('monat').textContent = mText;
  $('zurueck').hidden = ansicht.name === 'firmen';
  $('settingsBtn').hidden = ansicht.name !== 'firmen';
  $('logo').hidden = ansicht.name !== 'firmen';                     // Logo nur auf der Startseite, sonst Zurück + Name
  document.body.classList.toggle('start', ansicht.name === 'firmen');
  const main = $('main');
  const k = key();

  if (ansicht.name === 'firmen') {
    $('titel').innerHTML = 'Fremd<b>firmen</b>';
    const firmen = aktFirmen();
    let html = summenKarte(`Alle Firmen – ${mText}`, firmen.reduce((a, f) => a + summeFirma(f, k), 0));
    html += `<button class="pdfbtn" id="pdfAlle">Anwesenheitsliste (alle Firmen)</button>`;
    if (firmen.length) {
      html += '<div class="h2">Firmen</div>' + firmen.sort(nachName).map((f) => {
        const n = leute(f).length;
        return `<div class="card firma" data-firma="${f.id}"><div class="name">${esc(f.name)}</div>` +
          `<div class="sub">${n} ${n === 1 ? 'Person' : 'Personen'}</div>` +
          `<div class="zahlen"><span>${MONATE[cur.m]}</span><b>${fmtH(summeFirma(f, k))}</b></div></div>`;
      }).join('');
    } else {
      html += '<p class="leerhinweis">Noch keine Fremdfirma angelegt.</p>';
    }
    html += '<button class="add" id="addBtn">+ Firma hinzufügen</button>';
    main.innerHTML = html;
    main.querySelectorAll('[data-firma]').forEach((li) => (li.onclick = () => gehe({ name: 'firma', firma: li.dataset.firma })));
    $('pdfAlle').onclick = () => pdfAnwesenheit(null);
    $('addBtn').onclick = () => dialog({ titel: 'Neue Firma', nameLbl: 'Firmenname' }, (name) => {
      data.firmen.push({ id: uid(), name, t: Date.now(), personen: [] });
    });
    return;
  }

  const f = firma();
  if (!f) return gehe({ name: 'firmen' });

  if (ansicht.name === 'firma') {
    $('titel').textContent = f.name;
    let html = summenKarte(`${f.name} – ${mText}`, summeFirma(f, k), summeFirma(f, null));
    html += `<button class="pdfbtn" id="pdfListe">Anwesenheitsliste (wer, wann, wo)</button>` +
      `<button class="pdfbtn hell" id="pdfBtn">Monatsübersicht (Stunden)</button>`;
    if (leute(f).length) {
      html += '<ul class="liste">' + leute(f).sort(nachName).map((p) => {
        const tg = tageMonat(p, k);
        return `<li class="klick" data-person="${p.id}"><div class="links"><div class="name">${esc(p.name)}</div>` +
          `<div class="sub">${tg} ${tg === 1 ? 'Tag' : 'Tage'}</div></div>` +
          `<div class="rechts"><div class="h">${fmtH(summePerson(p, k))}</div></div><span class="pfeil">›</span></li>`;
      }).join('') + '</ul>';
    } else {
      html += '<p class="leerhinweis">Noch keine Person in dieser Firma.</p>';
    }
    html += '<button class="add" id="addBtn">+ Person hinzufügen</button>' +
      `<div class="card"><div class="aktionen" style="margin-top:0"><button id="umbenennen">Firma umbenennen</button><button class="del" id="loeschen">Firma löschen</button></div></div>`;
    main.innerHTML = html;
    main.querySelectorAll('[data-person]').forEach((li) => (li.onclick = () => gehe({ name: 'person', firma: f.id, person: li.dataset.person })));
    // In den Handlern immer firma() frisch holen (siehe oben)
    $('pdfBtn').onclick = pdfFirma;
    $('pdfListe').onclick = () => pdfAnwesenheit(firma());
    $('umbenennen').onclick = () => dialog({ titel: 'Firma umbenennen', nameLbl: 'Firmenname', name: firma().name }, (name) => {
      const x = firma(); if (x) { x.name = name; x.t = Date.now(); }
    });
    $('loeschen').onclick = () => {
      const x = firma();
      if (!x || !confirm(`Firma „${x.name}“ mit allen Personen und Stunden löschen?`)) return;
      x.del = true; x.t = Date.now(); x.personen = [];
      save();
      gehe({ name: 'firmen' });
    };
    $('addBtn').onclick = () => dialog({ titel: 'Neue Person', nameLbl: 'Name' }, (name) => {
      const x = firma(); if (x) x.personen.push({ id: uid(), name, t: Date.now(), monate: {} });
    });
    return;
  }

  // ----- Person: Tagesliste -----
  const p = person();
  if (!p) return gehe({ name: 'firma', firma: f.id });
  $('titel').innerHTML = `${esc(p.name)}<span id="untertitel">${esc(f.name)}</span>`;
  let html = `<div id="sumBox">${summenKarte(`${p.name} – ${mText}`, summePerson(p, k), summePerson(p, null))}</div>` +
    `<button class="pdfbtn" id="pdfBtn">Stundennachweis</button>`;
  const mo = p.monate[k] || { tage: {} };
  const n = tageImMonat(cur.y, cur.m);
  html += '<ul class="liste" id="tage">';
  for (let d = 1; d <= n; d++) {
    const t = mo.tage[d] || {};
    const cls = [frei(cur.y, cur.m, d) ? 'frei' : '',
      cur.y === heute.getFullYear() && cur.m === heute.getMonth() && d === heute.getDate() ? 'heute' : ''].join(' ').trim();
    html += `<li class="${cls}" data-tag="${d}"><div class="tag"><b>${d}</b><small>${WT[new Date(cur.y, cur.m, d).getDay()]}</small></div>` +
      `<div class="felder"><div class="z1">` +
      `<input class="std" inputmode="decimal" data-f="h" value="${esc(t.h || '')}" placeholder="Std" autocomplete="off">` +
      `<input class="uhr" type="time" data-f="von" value="${esc(t.von || '')}" aria-label="Beginn">` +
      `<span class="strich">–</span>` +
      `<input class="uhr" type="time" data-f="bis" value="${esc(t.bis || '')}" aria-label="Ende"></div>` +
      `<div class="z2"><input class="bem" data-f="b" value="${esc(t.b || '')}" placeholder="Ort / Bemerkung" autocomplete="off">` +
      `<span class="pausebox">${pauseHtml(t)}</span>` +
      `<button class="kopie" data-kopie${kopierbar(t) ? '' : ' hidden'} aria-label="Auf andere Personen oder Tage übertragen">Auf alle</button></div></div></li>`;
  }
  html += '</ul>' +
    `<div class="card"><div class="aktionen" style="margin-top:0"><button id="umbenennen">Person umbenennen</button><button class="del" id="loeschen">Person löschen</button></div></div>`;
  main.innerHTML = html;

  const beiEingabe = (e) => {
    const feld = e.target.dataset.f, li = e.target.closest('li[data-tag]'), x = person();
    if (!feld || !li || !x) return;
    const d = li.dataset.tag;
    const m2 = x.monate[k] || (x.monate[k] = { tage: {} });
    const t = m2.tage[d] || (m2.tage[d] = {});   // leerer Eintrag bleibt mit Zeitstempel stehen (Löschen wird so abgeglichen)
    setzeTag(t, feld, e.target.value.trim(), { y: cur.y, m: cur.m, d: +d });
    // die anderen Felder der Zeile nachziehen (nicht das, in dem gerade getippt wird)
    li.querySelectorAll('input').forEach((inp) => { if (inp !== e.target && inp.dataset.f !== 'b') inp.value = t[inp.dataset.f] || ''; });
    li.querySelector('.pausebox').innerHTML = pauseHtml(t);
    li.querySelector('[data-kopie]').hidden = !kopierbar(t);
    save();
    aktualisiereSummen();
  };
  $('tage').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kopie]');
    if (b) oeffneKopie(+b.closest('li[data-tag]').dataset.tag);
  });
  $('tage').addEventListener('input', beiEingabe);
  $('tage').addEventListener('change', (e) => { if (e.target.type === 'time') beiEingabe(e); });
  $('tage').addEventListener('focusin', (e) => { if (e.target.classList.contains('std')) setTimeout(() => e.target.select(), 0); });
  $('pdfBtn').onclick = pdfPerson;
  $('umbenennen').onclick = () => dialog({ titel: 'Person umbenennen', nameLbl: 'Name', name: person().name }, (name) => {
    const x = person(); if (x) { x.name = name; x.t = Date.now(); }
  });
  $('loeschen').onclick = () => {
    const x = person();
    if (!x || !confirm(`„${x.name}“ mit allen Stunden löschen?`)) return;
    x.del = true; x.t = Date.now(); x.monate = {};
    save();
    gehe({ name: 'firma', firma: ansicht.firma });
  };
}

// Summenkarte neu rechnen, ohne die Eingabefelder neu aufzubauen (sonst springt die Tastatur weg)
function aktualisiereSummen() {
  const f = firma(), k = key(), mText = `${MONATE[cur.m]} ${cur.y}`;
  if (!f) return;
  if (ansicht.name === 'person') {
    const p = person();
    if (!p || !$('sumBox')) return;
    $('sumBox').innerHTML = summenKarte(`${p.name} – ${mText}`, summePerson(p, k), summePerson(p, null));
  }
}

function gehe(neu) {
  ansicht = Object.assign({ firma: null, person: null }, neu);
  render();
  window.scrollTo(0, 0);
  if (ansicht.name === 'person') {
    const h = document.querySelector('#tage li.heute');
    if (h) h.scrollIntoView({ block: 'center' });
  }
}
function zurueck() {
  if (ansicht.name === 'person') gehe({ name: 'firma', firma: ansicht.firma });
  else if (ansicht.name === 'firma') gehe({ name: 'firmen' });
}

// ---------- Tageseintrag auf andere Personen der Firma übertragen ----------
let kopieTag = null;
const tagText = (d) => `${WT[new Date(cur.y, cur.m, d).getDay()]} ${String(d).padStart(2, '0')}.${String(cur.m + 1).padStart(2, '0')}.`;
function oeffneKopie(d) {
  const f = firma(), p = person(), k = key();
  const t = p && p.monate[k] && p.monate[k].tage[d];
  if (!kopierbar(t)) return;
  const andere = leute(f).filter((x) => x.id !== p.id).sort(nachName);
  kopieTag = d;
  $('kopieText').textContent = `${tagText(d)}: ` + (hatEintrag(t) ? `${t.h || '–'} Std., ${t.von || '?'}–${t.bis || '?'}${t.b ? ', ' + t.b : ''}` : t.b);
  // Wer an dem Tag schon etwas eingetragen hat, ist zur Sicherheit nicht vorausgewählt
  $('kopieListe').innerHTML = andere.length ? andere.map((x) => {
    const alt = x.monate[k] && x.monate[k].tage[d], hat = kopierbar(alt);
    const was = hat && (hatEintrag(alt) ? `${alt.h || '–'} Std. (${alt.von || '?'}–${alt.bis || '?'})` : `„${alt.b}“`);
    return `<label class="wahl"><input type="checkbox" data-id="${x.id}"${hat ? '' : ' checked'}><span>${esc(x.name)}` +
      (hat ? `<small>hat schon ${esc(was)} – wird ersetzt</small>` : '') + `</span></label>`;
  }).join('') : '<p class="hint" style="margin:0">Keine weiteren Personen in dieser Firma.</p>';
  $('kopieAlle').hidden = !andere.length;
  // Folgetage bis Monatsende zur Auswahl
  const n = tageImMonat(cur.y, cur.m);
  let opt = `<option value="${d}">nein, nur ${tagText(d)}</option>`;
  for (let e = d + 1; e <= n; e++) opt += `<option value="${e}">bis ${tagText(e)}</option>`;
  $('kopieBis').innerHTML = opt;
  $('kopieBisWrap').hidden = d >= n;
  $('kopieWe').checked = hatEintrag(t);   // Arbeitsstunden: Wochenende auslassen; Urlaub o. Ä.: durchgehend
  $('kopieWeWrap').hidden = true;
  $('kopieBis').onchange = () => { $('kopieWeWrap').hidden = +$('kopieBis').value === kopieTag; };
  $('kopie').hidden = false;
}
function kopieOk() {
  const f = firma(), p = person(), k = key();
  const t = p && p.monate[k] && p.monate[k].tage[kopieTag];
  if (!f || !kopierbar(t)) { $('kopie').hidden = true; return; }
  const bis = Math.max(kopieTag, +$('kopieBis').value || kopieTag), ohneWe = $('kopieWe').checked;
  const muster = () => {
    const neu = { t: Date.now() };
    ['h', 'von', 'bis', 'p', 'b'].forEach((feld) => { if (t[feld] != null && t[feld] !== '') neu[feld] = t[feld]; });
    return neu;
  };
  // Ziel: angehakte Personen (gleicher Tag + Folgetage) und die Person selbst (nur Folgetage)
  const ziele = [p];
  $('kopieListe').querySelectorAll('input:checked').forEach((cb) => {
    const x = f.personen.find((y) => y.id === cb.dataset.id && !y.del);
    if (x) ziele.push(x);
  });
  let n = 0, belegt = 0;
  const personen = new Set();
  ziele.forEach((x) => {
    const tage = (x.monate[k] || (x.monate[k] = { tage: {} })).tage;
    for (let d = kopieTag; d <= bis; d++) {
      if (x === p && d === kopieTag) continue;                          // Ausgangstag selbst
      if (d > kopieTag && ohneWe && frei(cur.y, cur.m, d)) continue;
      if (d > kopieTag && kopierbar(tage[d])) { belegt++; continue; }   // Folgetage: Vorhandenes nie überschreiben
      tage[d] = muster();
      n++;
      personen.add(x.id);
    }
  });
  $('kopie').hidden = true;
  if (!n) { toast(belegt ? 'Alle gewählten Tage sind schon belegt' : 'Nichts ausgewählt'); return; }
  save();
  render();
  toast(`${n} ${n === 1 ? 'Eintrag' : 'Einträge'} für ${personen.size} ${personen.size === 1 ? 'Person' : 'Personen'} übertragen` +
    (belegt ? ` (${belegt} schon ${belegt === 1 ? 'belegter Tag' : 'belegte Tage'} übersprungen)` : ''));
}

// ---------- Dialog (Name eingeben) ----------
let dlgCb = null;
function dialog(opt, cb) {
  $('dlgTitel').textContent = opt.titel;
  $('dlgNameLbl').textContent = opt.nameLbl || 'Name';
  $('dlgName').value = opt.name || '';
  dlgCb = cb;
  $('dialog').hidden = false;
  setTimeout(() => $('dlgName').focus(), 50);
}
function dialogOk() {
  const name = $('dlgName').value.trim();
  if (!name) { toast('Bitte einen Namen eingeben'); return; }
  dlgCb(name);
  dlgCb = null;
  save();
  $('dialog').hidden = true;
  render();
}

window.onAndroidBack = function () {
  if (!$('vorschau').hidden) { schliesseVorschau(); return true; }
  for (const id of ['kopie', 'dialog', 'settings']) if (!$(id).hidden) { $(id).hidden = true; return true; }
  if (ansicht.name !== 'firmen') { zurueck(); return true; }
  return false;
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- Backup ----------
function bytesZuBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function backupTeilen() {
  const json = JSON.stringify({ firmen: data.firmen }, null, 1);   // ohne Dropbox-Zugang
  const name = `fremdfirmen-backup-${new Date().toISOString().slice(0, 10)}.json`;
  if (window.Android) {
    Android.shareFile(bytesZuBase64(new TextEncoder().encode(json)), name, 'application/json', 'Fremdfirmen Backup');
  } else {
    teileImBrowser(json, name, 'application/json', 'Fremdfirmen Backup');
  }
}
function backupLaden(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.firmen)) throw new Error();
      const frage = lokal.dbx
        ? 'Backup laden? Es wird mit den Dropbox-Daten zusammengeführt (der neuere Eintrag gewinnt).'
        : 'Backup laden? Die aktuellen Daten auf dem Handy werden dadurch ersetzt.';
      if (!confirm(frage)) return;
      stempeln(d.firmen);
      data.firmen = lokal.dbx ? mergeListe(data.firmen, d.firmen, mergeFirma) : d.firmen;
      save();
      $('settings').hidden = true;
      gehe({ name: 'firmen' });
      toast('Backup geladen');
    } catch (e) { alert('Das ist keine gültige Fremdfirmen-Backup-Datei.'); }
  };
  r.readAsText(file);
}

// ---------- PDF: Blätter zeichnen (Einheiten = A4 bei 96 dpi) ----------
const A4K = 793.76, A4L = 1122.56;   // kurze / lange Seite
const PDF_SCALE = 2.5;
const FONT = 'Arial, Helvetica, "Liberation Sans", Roboto, sans-serif';
const fmtZ = (v) => (v ? v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '');

function neueSeite(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * PDF_SCALE);
  c.height = Math.round(h * PDF_SCALE);
  const ctx = c.getContext('2d');
  ctx.scale(PDF_SCALE, PDF_SCALE);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const z = {
    c, w, h,
    txt(s, x, y, { size = 11, bold = false, align = 'left', maxW = 0, farbe = '#000' } = {}) {
      s = String(s);
      let sz = size;
      ctx.font = `${bold ? 'bold ' : ''}${sz}px ${FONT}`;
      if (maxW) while (sz > 5 && ctx.measureText(s).width > maxW) { sz -= 0.5; ctx.font = `${bold ? 'bold ' : ''}${sz}px ${FONT}`; }
      ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = farbe;
      ctx.fillText(s, x, y);
    },
    fill(x1, y1, x2, y2, farbe) { ctx.fillStyle = farbe; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); },
    box(x1, y1, x2, y2, lw = 1) { ctx.lineWidth = lw; ctx.strokeStyle = '#000'; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); },
    linie(x1, y1, x2, y2, lw = 0.8) { ctx.lineWidth = lw; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); },
  };
  return z;
}
const datumHeute = () => new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

// Monatsübersicht einer Firma: Querformat, Zeile je Person, Spalte je Tag (nur Stunden)
function seitenFirma(f, y, m) {
  const k = key(y, m), n = tageImMonat(y, m);
  const leute = f.personen.filter((p) => !p.del && stundenMonat(p, k) > 0).sort(nachName);
  const PRO = 22, anz = Math.max(1, Math.ceil(leute.length / PRO));
  const L = 40, NAMEW = 190, TAGEW = 760, dw = TAGEW / n;
  const xT = L + NAMEW, xS = xT + TAGEW, R = xS + 93;
  const T = 105, KH = 34, RH = 22;
  const seiten = [];

  for (let s = 0; s < anz; s++) {
    const z = neueSeite(A4L, A4K);
    const teil = leute.slice(s * PRO, (s + 1) * PRO);
    const letzte = s === anz - 1;
    z.txt('Stundenübersicht Fremdfirma', L, 48, { size: 20, bold: true });
    if (anz > 1) z.txt(`Seite ${s + 1} / ${anz}`, R, 48, { size: 11, align: 'right' });
    z.txt('Firma:', L, 80, { size: 13, bold: true });
    z.txt(f.name, L + 52, 80, { size: 13, maxW: 480 });
    z.txt('Monat:', 640, 80, { size: 13, bold: true });
    z.txt(`${MONATE[m]} ${y}`, 692, 80, { size: 13 });

    const zeilen = teil.length + (letzte ? 1 : 0);
    const B = T + KH + zeilen * RH;
    z.fill(L, T, R, T + KH, '#D9D9D9');
    for (let d = 1; d <= n; d++) {
      if (!frei(y, m, d)) continue;
      const x = xT + (d - 1) * dw;
      z.fill(x, T, x + dw, T + KH, '#FFC000');
      if (teil.length) z.fill(x, T + KH, x + dw, T + KH + teil.length * RH, '#FFF4D1');
    }
    if (letzte) z.fill(L, B - RH, R, B, '#D9D9D9');

    z.txt('Name', L + 6, T + KH / 2, { size: 12, bold: true });
    for (let d = 1; d <= n; d++) {
      const cx = xT + (d - 0.5) * dw;
      z.txt(d, cx, T + 12, { size: 10.5, bold: true, align: 'center' });
      z.txt(WT[new Date(y, m, d).getDay()], cx, T + 25, { size: 8, align: 'center' });
    }
    z.txt('Stunden', (xS + R) / 2, T + KH / 2, { size: 11.5, bold: true, align: 'center' });

    teil.forEach((p, i) => {
      const cy = T + KH + (i + 0.5) * RH, tage = p.monate[k].tage;
      z.txt(p.name, L + 6, cy, { size: 11, maxW: NAMEW - 10 });
      for (let d = 1; d <= n; d++) {
        const v = tage[d] && zahl(tage[d].h);
        if (v) z.txt(fmtZ(v), xT + (d - 0.5) * dw, cy, { size: 10, align: 'center', maxW: dw - 2 });
      }
      z.txt(fmtZ(stundenMonat(p, k)), (xS + R) / 2, cy, { size: 11.5, bold: true, align: 'center' });
    });

    if (letzte) {
      const cy = B - RH / 2;
      z.txt(leute.length ? 'Summe' : 'Keine Stunden in diesem Monat', L + 6, cy, { size: 12, bold: true });
      for (let d = 1; d <= n; d++) {
        const v = leute.reduce((a, p) => a + (p.monate[k].tage[d] ? zahl(p.monate[k].tage[d].h) : 0), 0);
        if (v) z.txt(fmtZ(v), xT + (d - 0.5) * dw, cy, { size: 9.5, bold: true, align: 'center', maxW: dw - 2 });
      }
      z.txt(fmtZ(leute.reduce((a, p) => a + stundenMonat(p, k), 0)), (xS + R) / 2, cy, { size: 12, bold: true, align: 'center', maxW: 86 });
    }

    for (let r = 0; r <= zeilen; r++) z.linie(L, T + KH + r * RH, R, T + KH + r * RH, r === 0 || (letzte && r === zeilen - 1) ? 1.3 : 0.7);
    for (let d = 0; d <= n; d++) z.linie(xT + d * dw, T, xT + d * dw, B, 0.7);
    z.box(L, T, R, B, 1.6);
    z.txt(`Erstellt am ${datumHeute()}`, L, B + 18, { size: 9, farbe: '#555' });
    seiten.push(z);
  }
  return seiten;
}

// Anwesenheitsliste: wer war wann wo. f = eine Firma oder null für alle Firmen. Hochformat, nach Tagen sortiert.
function seitenAnwesenheit(f, y, m) {
  const k = key(y, m), alle = !f;
  const zeilen = [];
  (alle ? aktFirmen() : [f]).forEach((fa) => leute(fa).forEach((p) => {
    const tage = (p.monate[k] || { tage: {} }).tage;
    Object.keys(tage).forEach((d) => { if (hatEintrag(tage[d])) zeilen.push({ d: +d, firma: fa.name, name: p.name, t: tage[d] }); });
  }));
  zeilen.sort((a, b) => a.d - b.d || a.firma.localeCompare(b.firma, 'de') || a.name.localeCompare(b.name, 'de'));

  const L = 40, R = 754, T = 130, KH = 26, RH = 20, PRO = 44;
  // Spalten: Datum | (Firma) | Name | Beginn | Ende | Pause | Stunden | Ort
  const W = alle ? [78, 130, 130, 52, 52, 46, 50] : [78, 0, 190, 56, 56, 50, 54];
  const X = [L];
  W.forEach((w) => X.push(X[X.length - 1] + w));
  X.push(R);
  const kopf = ['Datum', 'Firma', 'Name', 'Beginn', 'Ende', 'Pause', 'Std', 'Ort / Bemerkung'];
  const anz = Math.max(1, Math.ceil((zeilen.length + 1) / PRO));   // +1 für die Summenzeile
  const gesamt = zeilen.reduce((a, r) => a + zahl(r.t.h), 0);
  const seiten = [];

  for (let s = 0; s < anz; s++) {
    const z = neueSeite(A4K, A4L);
    const teil = zeilen.slice(s * PRO, (s + 1) * PRO);
    const letzte = s === anz - 1;
    z.txt('Anwesenheitsliste Fremdfirmen', L, 50, { size: 20, bold: true });
    if (anz > 1) z.txt(`Seite ${s + 1} / ${anz}`, R, 50, { size: 11, align: 'right' });
    z.txt('Firma:', L, 84, { size: 13, bold: true });
    z.txt(alle ? 'Alle Firmen' : f.name, L + 52, 84, { size: 13, maxW: 380 });
    z.txt('Monat:', 500, 84, { size: 13, bold: true });
    z.txt(`${MONATE[m]} ${y}`, 552, 84, { size: 13 });
    const sa = lokal.pauseSa !== '' && lokal.pauseSa != null ? `, samstags ${lokal.pauseSa} min` : '';
    z.txt(`Pause automatisch: über 6 Std. 30 min, über 9 Std. 45 min${sa} – sofern nicht anders eingetragen.`, L, 108, { size: 9, farbe: '#555' });

    const n = teil.length + (letzte ? 1 : 0), B = T + KH + n * RH;
    z.fill(L, T, R, T + KH, '#D9D9D9');
    kopf.forEach((t, i) => {
      if (!alle && i === 1) return;
      if (i === 2 || i === 1 || i === 7) z.txt(t, X[i] + 5, T + KH / 2, { size: 11.5, bold: true });
      else z.txt(t, (X[i] + X[i + 1]) / 2, T + KH / 2, { size: 11.5, bold: true, align: 'center' });
    });

    let vorTag = s > 0 ? zeilen[s * PRO - 1].d : null;
    teil.forEach((r, i) => {
      const top = T + KH + i * RH, cy = top + RH / 2, neuerTag = r.d !== vorTag;
      if (frei(y, m, r.d)) z.fill(X[0], top, X[1], top + RH, '#FFE699');
      if (neuerTag) {
        z.txt(`${WT[new Date(y, m, r.d).getDay()]} ${String(r.d).padStart(2, '0')}.${String(m + 1).padStart(2, '0')}.`, X[0] + 5, cy, { size: 11, bold: true });
        if (i > 0) z.linie(L, top, R, top, 1.2);
      } else {
        z.linie(X[1], top, R, top, 0.5);
      }
      if (alle) z.txt(r.firma, X[1] + 5, cy, { size: 10.5, maxW: W[1] - 8 });
      z.txt(r.name, X[2] + 5, cy, { size: 10.5, maxW: W[2] - 8 });
      if (r.t.von) z.txt(r.t.von, (X[3] + X[4]) / 2, cy, { size: 10.5, align: 'center' });
      if (r.t.bis) z.txt(r.t.bis, (X[4] + X[5]) / 2, cy, { size: 10.5, align: 'center' });
      z.txt(pauseText(pauseVon(r.t)), (X[5] + X[6]) / 2, cy, { size: 10.5, align: 'center' });
      if (r.t.h) z.txt(String(r.t.h).replace('.', ','), (X[6] + X[7]) / 2, cy, { size: 10.5, bold: true, align: 'center', maxW: W[6] - 4 });
      if (r.t.b) z.txt(r.t.b, X[7] + 5, cy, { size: 10.5, maxW: R - X[7] - 8 });
      vorTag = r.d;
    });

    if (letzte) {
      const top = B - RH;
      z.fill(L, top, R, B, '#D9D9D9');
      z.txt(zeilen.length ? 'Summe' : 'Keine Einträge in diesem Monat', X[0] + 5, top + RH / 2, { size: 11.5, bold: true });
      if (zeilen.length) z.txt(fmtZ(gesamt), (X[6] + X[7]) / 2, top + RH / 2, { size: 11.5, bold: true, align: 'center', maxW: W[6] - 4 });
      z.linie(L, top, R, top, 1.3);
    }
    z.linie(L, T + KH, R, T + KH, 1.3);
    X.slice(1, 8).forEach((x, i) => { if (alle || i !== 1) z.linie(x, T, x, letzte ? B - RH : B, 0.6); });
    z.box(L, T, R, B, 1.6);
    z.txt(`Erstellt am ${datumHeute()}`, L, B + 16, { size: 9, farbe: '#555' });
    seiten.push(z);
  }
  return seiten;
}

// Stundennachweis einer Person: Hochformat, mit Beginn/Ende/Pause und Unterschriftszeilen
function seitenPerson(f, p, y, m) {
  const k = key(y, m), n = tageImMonat(y, m), tage = (p.monate[k] || { tage: {} }).tage;
  const z = neueSeite(A4K, A4L);
  const L = 40, R = 754, X = [L, 82, 150, 212, 274, 332, 396, R], T = 175, KH = 26, RH = 24, B = T + KH + n * RH;
  z.txt('Stundennachweis', L, 58, { size: 22, bold: true });
  [['Firma:', f.name], ['Name:', p.name], ['Monat:', `${MONATE[m]} ${y}`]].forEach(([l, v], i) => {
    z.txt(l, L, 100 + i * 24, { size: 13, bold: true });
    z.txt(v, L + 62, 100 + i * 24, { size: 13, maxW: 640 });
  });
  z.fill(L, T, R, T + KH, '#D9D9D9');
  ['Tag', 'Wochentag', 'Beginn', 'Ende', 'Pause', 'Stunden'].forEach((t, i) => z.txt(t, (X[i] + X[i + 1]) / 2, T + KH / 2, { size: 11.5, bold: true, align: 'center', maxW: X[i + 1] - X[i] - 4 }));
  z.txt('Ort / Bemerkung', X[6] + 8, T + KH / 2, { size: 11.5, bold: true });
  for (let d = 1; d <= n; d++) {
    const top = T + KH + (d - 1) * RH, cy = top + RH / 2, t = tage[d] || {};
    z.fill(X[0], top, X[2], top + RH, frei(y, m, d) ? '#FFC000' : '#F2F2F2');
    z.txt(d, (X[0] + X[1]) / 2, cy, { size: 12, bold: true, align: 'center' });
    z.txt(WT[new Date(y, m, d).getDay()], (X[1] + X[2]) / 2, cy, { size: 11.5, align: 'center' });
    if (t.von) z.txt(t.von, (X[2] + X[3]) / 2, cy, { size: 11.5, align: 'center' });
    if (t.bis) z.txt(t.bis, (X[3] + X[4]) / 2, cy, { size: 11.5, align: 'center' });
    z.txt(pauseText(pauseVon(t)), (X[4] + X[5]) / 2, cy, { size: 11.5, align: 'center' });
    if (t.h) z.txt(String(t.h).replace('.', ','), (X[5] + X[6]) / 2, cy, { size: 12, bold: true, align: 'center', maxW: 58 });
    if (t.b) z.txt(t.b, X[6] + 8, cy, { size: 11, maxW: R - X[6] - 14 });
  }
  z.fill(L, B, R, B + RH, '#D9D9D9');
  z.txt('Summe', (X[0] + X[5]) / 2, B + RH / 2, { size: 12.5, bold: true, align: 'center' });
  z.txt(fmtZ(stundenMonat(p, k)) || '0', (X[5] + X[6]) / 2, B + RH / 2, { size: 12.5, bold: true, align: 'center' });
  for (let r = 0; r <= n; r++) z.linie(L, T + KH + r * RH, R, T + KH + r * RH, r === 0 || r === n ? 1.3 : 0.7);
  X.slice(1, 7).forEach((x, i) => z.linie(x, T, x, i < 4 ? B : B + RH, 0.7));   // links in der Summenzeile verbunden
  z.box(L, T, R, B + RH, 1.6);
  const uy = Math.min(B + RH + 80, A4L - 60);
  z.linie(L, uy, L + 300, uy, 0.8);
  z.txt('Datum, Unterschrift Fremdfirma', L, uy + 12, { size: 9.5, farbe: '#444' });
  z.linie(R - 300, uy, R, uy, 0.8);
  z.txt('Datum, Unterschrift Bauleitung', R - 300, uy + 12, { size: 9.5, farbe: '#444' });
  return [z];
}

// ---------- Minimaler PDF-Schreiber (je Seite ein JPEG) ----------
function base64ZuBytes(b64) {
  const s = atob(b64), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
function bauePdf(seiten) {
  const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  const teile = [], offs = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc(x) : x; teile.push(b); len += b.length; };
  const obj = (nr, body) => { offs[nr] = len; push(`${nr} 0 obj\n${body}\nendobj\n`); };
  const pt = (einheiten) => (einheiten * 0.75).toFixed(2);   // 96 dpi -> PDF-Punkte

  push('%PDF-1.4\n');
  push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${seiten.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${seiten.length} >>`);
  seiten.forEach((z, i) => {
    const nr = 3 + i * 3, W = pt(z.w), H = pt(z.h);
    const jpeg = base64ZuBytes(z.c.toDataURL('image/jpeg', 0.9).split(',')[1]);
    obj(nr, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${nr + 1} 0 R >> >> /Contents ${nr + 2} 0 R >>`);
    offs[nr + 1] = len;
    push(`${nr + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${z.c.width} /Height ${z.c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');
    const inhalt = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(nr + 2, `<< /Length ${inhalt.length} >>\nstream\n${inhalt}\nendstream`);
  });
  const anz = 3 + seiten.length * 3;   // Anzahl Objekte inkl. Objekt 0
  const xref = len;
  let x = `xref\n0 ${anz}\n0000000000 65535 f \n`;
  for (let i = 1; i < anz; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${anz} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let p = 0;
  teile.forEach((b) => { out.set(b, p); p += b.length; });
  return out;
}
const dateiName = (s) => s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe')
  .replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '_');

// ---------- PDF-Vorschau + Senden ----------
let aktPdf = null;   // { seiten, titel, datei, betreff, text }

function pdfFirma() {
  const f = firma(), mText = `${MONATE[cur.m]} ${cur.y}`;
  zeigeVorschau({
    seiten: seitenFirma(f, cur.y, cur.m),
    titel: `${f.name} – ${mText}`,
    datei: dateiName(`Stunden ${f.name} ${mText}`) + '.pdf',
    betreff: `Stundenübersicht ${f.name} – ${mText}`,
    text: `Hallo,\n\nanbei die Stundenübersicht ${f.name} für ${mText}.\n\nViele Grüße`,
  });
}
// f = Firma oder null für alle Firmen
function pdfAnwesenheit(f) {
  const mText = `${MONATE[cur.m]} ${cur.y}`, wer = f ? f.name : 'alle Firmen';
  zeigeVorschau({
    seiten: seitenAnwesenheit(f, cur.y, cur.m),
    titel: `Anwesenheit ${wer} – ${mText}`,
    datei: dateiName(`Anwesenheit ${wer} ${mText}`) + '.pdf',
    betreff: `Anwesenheitsliste ${wer} – ${mText}`,
    text: `Hallo,\n\nanbei die Anwesenheitsliste (${wer}) für ${mText}.\n\nViele Grüße`,
  });
}
function pdfPerson() {
  const f = firma(), p = person(), mText = `${MONATE[cur.m]} ${cur.y}`;
  zeigeVorschau({
    seiten: seitenPerson(f, p, cur.y, cur.m),
    titel: `${p.name} – ${mText}`,
    datei: dateiName(`Stundennachweis ${p.name} ${f.name} ${mText}`) + '.pdf',
    betreff: `Stundennachweis ${p.name} (${f.name}) – ${mText}`,
    text: `Hallo,\n\nanbei der Stundennachweis von ${p.name} (${f.name}) für ${mText}.\n\nViele Grüße`,
  });
}

function zeigeVorschau(def) {
  aktPdf = def;
  const body = $('vBody');
  body.innerHTML = '';
  def.seiten.forEach((z) => {
    const img = document.createElement('img');
    img.alt = 'PDF-Seite';
    img.src = z.c.toDataURL('image/jpeg', 0.85);
    body.appendChild(img);
  });
  $('vTitel').textContent = def.titel;
  body.classList.remove('zoom');
  body.scrollTo(0, 0);
  $('vorschau').hidden = false;
}
function schliesseVorschau() {
  $('vorschau').hidden = true;
  $('vBody').innerHTML = '';
  aktPdf = null;
}
// Tippen: an der getippten Stelle hinein- bzw. wieder herauszoomen
function vorschauZoom(e) {
  const body = $('vBody'), bild = e.target;
  if (bild.tagName !== 'IMG') return;
  if (body.classList.contains('zoom')) { body.classList.remove('zoom'); return; }
  const r = bild.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  body.classList.add('zoom');
  const r2 = bild.getBoundingClientRect(), b = body.getBoundingClientRect();
  body.scrollLeft += r2.left - b.left + fx * r2.width - body.clientWidth / 2;
  body.scrollTop += r2.top - b.top + fy * r2.height - body.clientHeight / 2;
}
function pdfSenden() {
  if (!aktPdf) return;
  const pdf = bauePdf(aktPdf.seiten);
  if (window.Android) {
    Android.sharePdf(bytesZuBase64(pdf), aktPdf.datei, '', '', aktPdf.betreff, aktPdf.text);
  } else {
    teileImBrowser(pdf, aktPdf.datei, 'application/pdf', aktPdf.betreff, aktPdf.text);
  }
}

// iPhone/Browser: Teilen-Menü (Mail, WhatsApp …); wenn das nicht geht, Datei herunterladen
function teileImBrowser(inhalt, name, mime, betreff, text) {
  try {
    const datei = new File([inhalt], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [datei] })) {
      navigator.share({ files: [datei], title: betreff, text: text || '' }).catch(() => {});
      return;
    }
  } catch (e) { /* weiter mit Download */ }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([inhalt], { type: mime }));
  a.download = name;
  a.click();
  toast('Datei heruntergeladen');
}

// ---------- Zusammenführen zweier Datenstände (pro Feld/Tag gewinnt der neuere Zeitstempel) ----------
const neuer = (a, b) => ((b.t || 0) > (a.t || 0) ? b : a);

function mergeListe(a, b, fn) {
  const out = [], pos = {};
  a.forEach((x) => { pos[x.id] = out.length; out.push(x); });
  b.forEach((y) => { if (y.id in pos) out[pos[y.id]] = fn(out[pos[y.id]], y); else out.push(y); });
  return out;
}
function mergeTage(a, b) {
  const out = {};
  Object.keys(Object.assign({}, a, b)).forEach((d) => { out[d] = Object.assign({}, a[d] && b[d] ? neuer(a[d], b[d]) : a[d] || b[d]); });
  return out;
}
function mergePerson(a, b) {
  const n = neuer(a, b), out = { id: a.id, name: n.name, t: n.t || 0, monate: {} };
  if (n.del) { out.del = true; return out; }
  Object.keys(Object.assign({}, a.monate, b.monate)).forEach((k) => {
    out.monate[k] = { tage: mergeTage((a.monate[k] || {}).tage || {}, (b.monate[k] || {}).tage || {}) };
  });
  return out;
}
function mergeFirma(a, b) {
  const n = neuer(a, b), out = { id: a.id, name: n.name, t: n.t || 0, personen: [] };
  if (n.del) { out.del = true; return out; }
  out.personen = mergeListe(a.personen || [], b.personen || [], mergePerson);
  return out;
}
// Einheitliche Textform zum Vergleichen (Schlüssel sortiert, Listen nach id)
function kanon(x) {
  if (Array.isArray(x)) return x.map(kanon).sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  if (x && typeof x === 'object') { const o = {}; Object.keys(x).sort().forEach((k) => { if (k !== 'satz' && x[k] !== '' && x[k] != null) o[k] = kanon(x[k]); }); return o; }
  return x;
}
const kanonText = (firmen) => JSON.stringify(kanon(firmen));

// ---------- Dropbox ----------
const DROPBOX_APP_KEY = '4i9ocbg02anqwyj';   // Dropbox-App "Fremdfirmen" (App folder); kein Geheimnis, nur die App-Kennung
const DBX_DATEI = '/fremdfirmen.json';   // liegt in Dropbox unter Apps/<App-Name>/
const appKey = () => DROPBOX_APP_KEY || lokal.key || '';

function zufall(n) {
  const z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const r = new Uint8Array(n);
  crypto.getRandomValues(r);
  return Array.from(r, (v) => z[v % z.length]).join('');
}
// Anmelde-Geheimnis (PKCE) vorab erzeugen: so kann der Knopf den Browser sofort öffnen
// (iPhone/Safari blockiert Fenster, die erst nach einer Wartezeit geöffnet werden).
async function bereitePkce(neu) {
  if (lokal.pkce && lokal.pkceCh && !neu) return;
  const v = zufall(64);
  let ch = v, m = 'plain';
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    ch = btoa(String.fromCharCode.apply(null, h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    m = 'S256';
  } catch (e) { /* ohne crypto.subtle: einfache Variante */ }
  lokal.pkce = v; lokal.pkceCh = ch; lokal.pkceM = m;
  saveLokal();
}
function dbxAnmelden() {
  const k = DROPBOX_APP_KEY || $('dbxKey').value.trim() || lokal.key;   // eingebauter Schlüssel hat Vorrang
  if (!k) { toast('Bitte zuerst den App-Schlüssel eintragen'); return; }
  lokal.key = k;
  const oeffne = () => {
    const url = 'https://www.dropbox.com/oauth2/authorize?response_type=code&token_access_type=offline' +
      `&client_id=${encodeURIComponent(k)}&code_challenge=${lokal.pkceCh}&code_challenge_method=${lokal.pkceM}`;
    if (window.Android && Android.openUrl) Android.openUrl(url);
    else if (!window.open(url, '_blank')) location.href = url;
  };
  if (lokal.pkce && lokal.pkceCh) oeffne(); else bereitePkce().then(oeffne);
}
async function dbxTokenAnfrage(params) {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: appKey() }, params)).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error_description || j.error || 'Anmeldung fehlgeschlagen'); e.auth = res.status === 400 || res.status === 401; throw e; }
  return j;
}
async function dbxVerbinden() {
  const code = $('dbxCode').value.replace(/\s+/g, '');   // Leerzeichen/Zeilenumbrüche vom Kopieren entfernen
  if (!code) { toast('Bitte den Code von Dropbox einfügen'); return; }
  if (!lokal.pkce) { toast('Bitte zuerst „Bei Dropbox anmelden“ antippen'); return; }
  const knopf = $('dbxVerbinden');
  if (knopf.disabled) return;                             // Doppeltipp: der Code gilt nur einmal
  knopf.disabled = true;
  knopf.textContent = 'Verbinde …';
  try {
    const j = await dbxTokenAnfrage({ grant_type: 'authorization_code', code, code_verifier: lokal.pkce });
    lokal.dbx = { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 0) * 1000 };
    lokal.pkce = ''; lokal.pkceCh = '';
    lokal.rev = null;
    lokal.dirty = true;
    saveLokal();
    $('dbxCode').value = '';
    toast('Mit Dropbox verbunden');
    zeigeDropbox();
    sync();
  } catch (e) {
    $('dbxCode').value = '';
    bereitePkce(true);   // der alte Code ist verbraucht -> neues Anmelde-Geheimnis für den nächsten Versuch
    alert('Verbinden hat nicht geklappt: ' + e.message + '\n\nDer Code gilt nur einmal und nur wenige Minuten. Bitte noch einmal „1. Bei Dropbox anmelden“ antippen und den neuen Code direkt einfügen.');
  } finally {
    knopf.disabled = false;
    knopf.textContent = '3. Verbinden';
  }
}
function dbxTrennen() {
  if (!confirm('Dropbox-Abgleich auf diesem Handy beenden? Die Daten bleiben auf dem Handy und in der Dropbox erhalten.')) return;
  lokal.dbx = null; lokal.rev = null; lokal.pkce = ''; lokal.pkceCh = '';
  saveLokal();
  setzeStatus('aus');
  zeigeDropbox();
}
async function dbxToken() {
  if (lokal.dbx.access && lokal.dbx.exp > Date.now() + 60000) return lokal.dbx.access;
  const j = await dbxTokenAnfrage({ grant_type: 'refresh_token', refresh_token: lokal.dbx.refresh });
  lokal.dbx.access = j.access_token;
  lokal.dbx.exp = Date.now() + (j.expires_in || 0) * 1000;
  saveLokal();
  return lokal.dbx.access;
}
// Antwort: { ok, status, text }. 409 = "gibt es nicht" bzw. Konflikt und wird vom Aufrufer behandelt.
async function dbxAufruf(url, headers, body) {
  for (let versuch = 0; versuch < 2; versuch++) {
    const token = await dbxToken();
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + token }, headers), body });
    if (res.status === 401 && versuch === 0) { lokal.dbx.access = ''; continue; }
    const text = await res.text();
    if (!res.ok && res.status !== 409) { const e = new Error(`Dropbox-Fehler ${res.status}: ${text.slice(0, 120)}`); e.auth = res.status === 401; throw e; }
    return { ok: res.ok, status: res.status, text };
  }
}
async function dbxRev() {
  const r = await dbxAufruf('https://api.dropboxapi.com/2/files/get_metadata', { 'Content-Type': 'application/json' }, JSON.stringify({ path: DBX_DATEI }));
  return r.ok ? JSON.parse(r.text).rev : null;
}
async function dbxLaden(rev) {
  const r = await dbxAufruf('https://content.dropboxapi.com/2/files/download', { 'Dropbox-API-Arg': JSON.stringify({ path: 'rev:' + rev }) });
  if (!r.ok) throw new Error('Datei konnte nicht geladen werden');
  return JSON.parse(r.text);
}
async function dbxSpeichern(text, rev) {
  const arg = { path: DBX_DATEI, mode: rev ? { '.tag': 'update', update: rev } : 'add', autorename: false, mute: true, strict_conflict: true };
  const r = await dbxAufruf('https://content.dropboxapi.com/2/files/upload',
    { 'Dropbox-API-Arg': JSON.stringify(arg), 'Content-Type': 'application/octet-stream' }, new TextEncoder().encode(text));
  return r.ok ? JSON.parse(r.text).rev : null;   // null = jemand war schneller -> nochmal abgleichen
}

// ---------- Abgleich ----------
let syncLaeuft = false, syncNochmal = false, syncTimer = null, renderOffen = false, syncFehler = '';

function planeSync(ms) {
  if (!lokal.dbx) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}

async function sync() {
  if (!lokal.dbx) return;
  if (syncLaeuft) { syncNochmal = true; return; }
  syncLaeuft = true;
  setzeStatus('laeuft');
  try {
    for (let runde = 0; runde < 5; runde++) {
      const rev = await dbxRev();
      if (rev && rev === lokal.rev && !lokal.dirty) break;            // nichts Neues, nichts zu senden
      const fern = rev ? await dbxLaden(rev) : null;
      const fernFirmen = fern && Array.isArray(fern.firmen) ? fern.firmen : null;
      // Ab hier ohne Unterbrechung: lokalen und fernen Stand zusammenführen
      const stand = aenderungen;
      const gemischt = fernFirmen ? mergeListe(data.firmen, fernFirmen, mergeFirma) : data.firmen;
      stempeln(gemischt);   // Daten aus älteren App-Versionen nachrüsten
      const gemischtText = kanonText(gemischt);
      if (gemischtText !== kanonText(data.firmen)) {
        data.firmen = gemischt;
        saveLokal();
        nachFremdAenderung();
      }
      if (fernFirmen && gemischtText === kanonText(fernFirmen)) {      // Dropbox ist schon aktuell
        lokal.rev = rev;
        lokal.dirty = aenderungen !== stand;
        break;
      }
      const neuRev = await dbxSpeichern(JSON.stringify({ v: 1, firmen: gemischt }), rev);
      if (neuRev) {
        lokal.rev = neuRev;
        lokal.dirty = aenderungen !== stand;
        break;
      }
    }
    lokal.letzter = Date.now();
    saveLokal();
    syncFehler = '';
    setzeStatus('ok');
  } catch (e) {
    syncFehler = e.auth ? 'Dropbox-Zugang abgelaufen – bitte neu verbinden' : (navigator.onLine === false ? 'Kein Internet' : e.message);
    setzeStatus('fehler');
  } finally {
    syncLaeuft = false;
    if (syncNochmal || (lokal.dirty && !syncFehler)) { syncNochmal = false; planeSync(1500); }
  }
}

// Daten kamen vom Kollegen: neu zeichnen – aber nicht, während gerade getippt wird (Tastatur würde zugehen)
function nachFremdAenderung() {
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT' && $('main').contains(a)) { renderOffen = true; aktualisiereSummen(); }
  else render();
}

function setzeStatus(s) {
  const b = $('syncBtn');
  b.hidden = s === 'aus';
  b.textContent = { ok: '✓', laeuft: '↻', fehler: '!' }[s] || '';
  b.className = 'sync ' + s;
  if (!$('settings').hidden) zeigeDropbox();
}
function zeigeDropbox() {
  const an = !!lokal.dbx;
  $('dbxAus').style.display = an ? 'none' : '';
  $('dbxAn').style.display = an ? '' : 'none';
  $('dbxKeyWrap').style.display = DROPBOX_APP_KEY ? 'none' : '';
  if (!an) { if (!$('dbxKey').value) $('dbxKey').value = lokal.key || ''; bereitePkce(); return; }
  const zeit = lokal.letzter ? new Date(lokal.letzter).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
  $('dbxStatus').textContent = syncFehler ? `⚠ ${syncFehler}` : (syncLaeuft ? 'Abgleich läuft …' : `Verbunden ✓ – letzter Abgleich ${zeit} Uhr`);
}
window.onAppResume = () => planeSync(300);

// ---------- Ereignisse ----------
function init() {
  $('logo').src = window.LOGO_BREIT || '';   // Jansen-Logo im Kopf
  stempeln(data.firmen);
  $('prev').onclick = () => { cur.m--; if (cur.m < 0) { cur.m = 11; cur.y--; } render(); };
  $('next').onclick = () => { cur.m++; if (cur.m > 11) { cur.m = 0; cur.y++; } render(); };
  $('zurueck').onclick = zurueck;
  const oeffneEinstellungen = () => { zeigeDropbox(); $('settings').hidden = false; };
  $('settingsBtn').onclick = oeffneEinstellungen;
  $('syncBtn').onclick = oeffneEinstellungen;
  $('dbxStart').onclick = dbxAnmelden;
  $('dbxVerbinden').onclick = dbxVerbinden;
  $('dbxTrennen').onclick = dbxTrennen;
  $('dbxJetzt').onclick = () => { lokal.rev = null; sync(); };
  // Aufgeschobenes Neuzeichnen nachholen, sobald nicht mehr getippt wird
  $('main').addEventListener('focusout', () => setTimeout(() => {
    const a = document.activeElement;
    if (renderOffen && !(a && a.tagName === 'INPUT' && $('main').contains(a))) { renderOffen = false; render(); }
  }, 250));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) planeSync(300); });
  setInterval(() => { if (!document.hidden) sync(); }, 30000);
  setzeStatus(lokal.dbx ? 'ok' : 'aus');
  planeSync(500);
  // Web-App (iPhone): Offline-Betrieb. In der Android-App (file://) nicht nötig.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  $('dlgOk').onclick = dialogOk;
  $('dlgName').addEventListener('keydown', (e) => { if (e.key === 'Enter') dialogOk(); });
  $('kopieOk').onclick = kopieOk;
  $('kopieAlle').onclick = () => {
    const boxen = [...$('kopieListe').querySelectorAll('input')], alleAn = boxen.every((b) => b.checked);
    boxen.forEach((b) => (b.checked = !alleAn));
  };
  $('setBeginn').value = lokal.beginn;
  $('setBeginn').onchange = (e) => { if (zuMin(e.target.value) != null) { lokal.beginn = e.target.value; saveLokal(); } };
  $('setPauseSa').value = lokal.pauseSa === '' || lokal.pauseSa == null ? '' : String(lokal.pauseSa);
  $('setPauseSa').onchange = (e) => { lokal.pauseSa = e.target.value === '' ? '' : +e.target.value; saveLokal(); };
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => (b.closest('.backdrop').hidden = true)));
  document.querySelectorAll('.backdrop').forEach((bd) => bd.addEventListener('click', (e) => { if (e.target === bd) bd.hidden = true; }));
  document.querySelectorAll('[data-vclose]').forEach((b) => (b.onclick = schliesseVorschau));
  $('vBody').addEventListener('click', vorschauZoom);
  $('vSenden').onclick = () => { try { pdfSenden(); } catch (e) { alert('PDF-Fehler: ' + e.message); } };
  $('backupBtn').onclick = backupTeilen;
  $('restoreBtn').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = (e) => { if (e.target.files[0]) backupLaden(e.target.files[0]); e.target.value = ''; };
  render();
}

init();
