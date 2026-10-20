/* Beregningsmotor for demoen.
   Budsjettdelen er en linje-for-linje port av Python-PoC-en (poc/kontoplan.py, poc/parser.py, poc/pipeline.py)
   og skal gi identiske forslag, flagg, beløp og importfil. Kontering er et eget, enklere spor.
   Ingen språkmodell kjører her; alt er forklarbare regler. */
(function (root) {
  'use strict';

  var REGELSETT_VERSJON = '0.2';
  // Kontonumre, AGA-sats og terskler kommer fra konfigurasjonen (data.konfig = data/konfig.json, se poc/konfig.py).
  var TERSKLER = ['sikker_konto', 'hoy_konfidens', 'modell', 'modell_maks', 'tekst_uenig', 'hopp_faktor', 'hopp_min_belop'];
  // Høy-flagg som må kvitteres med kommentar før eksport (poc/pipeline.py KVITTER_KODER).
  var KVITTER_KODER = ['SUMAVVIK', 'ARKSUM_AVVIK', 'AAR_AVVIK', 'ENHET_UKJENT', 'UKJENT_KONTO'];
  var VALG = ['godta', 'endre', 'avvis', 'utenfor'];
  var MANEDER = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  var FULLE = ['januar', 'februar', 'mars', 'april', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember', 'mai'];
  var GENERISK = ['diverse', 'annet', 'øvrig', 'ovrig', 'ymse', 'andre'];

  // ---------- Python-kompatible hjelpere ----------

  /** Python round(x) til heltall: halvveis til nærmeste partall. */
  function pyRound(x) {
    var f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  function round2(x) { return Number(x.toFixed(2)); }

  /** Tilsvarer format(int(n), ",").replace(",", " ") i Python. */
  function kr(n) {
    var i = Math.trunc(n);
    var s = String(Math.abs(i)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (i < 0 ? '-' : '') + s;
  }

  function norm(s) {
    return String(s).toLowerCase().replace(/[^\p{L}\p{N}_ ]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function tokens(s) { var n = norm(s); return n ? n.split(' ') : []; }

  /** difflib.SequenceMatcher(None, a, b).ratio() */
  function seqRatio(a, b) {
    a = Array.from(a); b = Array.from(b);
    var la = a.length, lb = b.length;
    if (la + lb === 0) return 1.0;
    var b2j = new Map();
    b.forEach(function (ch, i) { if (!b2j.has(ch)) b2j.set(ch, []); b2j.get(ch).push(i); });
    if (lb >= 200) {
      var ntest = Math.floor(lb / 100) + 1;
      Array.from(b2j.keys()).forEach(function (ch) { if (b2j.get(ch).length > ntest) b2j.delete(ch); });
    }
    function lengste(alo, ahi, blo, bhi) {
      var besti = alo, bestj = blo, best = 0, j2len = new Map();
      for (var i = alo; i < ahi; i++) {
        var ny = new Map(), idx = b2j.get(a[i]) || [];
        for (var n = 0; n < idx.length; n++) {
          var j = idx[n];
          if (j < blo) continue;
          if (j >= bhi) break;
          var k = (j2len.get(j - 1) || 0) + 1;
          ny.set(j, k);
          if (k > best) { besti = i - k + 1; bestj = j - k + 1; best = k; }
        }
        j2len = ny;
      }
      while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; best++; }
      while (besti + best < ahi && bestj + best < bhi && a[besti + best] === b[bestj + best]) best++;
      return [besti, bestj, best];
    }
    var ko = [[0, la, 0, lb]], treff = 0;
    while (ko.length) {
      var q = ko.pop(), m = lengste(q[0], q[1], q[2], q[3]);
      if (m[2]) {
        treff += m[2];
        if (q[0] < m[0] && q[2] < m[1]) ko.push([q[0], m[0], q[2], m[1]]);
        if (m[0] + m[2] < q[1] && m[1] + m[2] < q[3]) ko.push([m[0] + m[2], q[1], m[1] + m[2], q[3]]);
      }
    }
    return 2.0 * treff / (la + lb);
  }

  function lesCsv(tekst) {
    var linjer = tekst.trim().split(/\r?\n/);
    var hode = linjer[0].split(';');
    return linjer.slice(1).filter(function (l) { return l.trim(); }).map(function (l) {
      var c = l.split(';'), r = {};
      hode.forEach(function (h, i) { r[h] = c[i] === undefined ? '' : c[i]; });
      return r;
    });
  }

  // ---------- Kontoplan (poc/kontoplan.py) ----------

  function Kontoplan(csvTekst, konfig) {
    var self = this;
    this.konfig = konfig;
    this.navn = konfig.kontoplan;
    this.kontoer = Object.create(null);
    this.rekkefolge = [];
    lesCsv(csvTekst).forEach(function (r) {
      r.nokkelord = r.nokkelord.split('|').filter(Boolean).map(norm);
      self.kontoer[r.konto] = r;
      self.rekkefolge.push(r.konto);
    });
    var k = konfig.kontoer;
    [['lonn', k.lonn], ['arbeidsgiveravgift', k.arbeidsgiveravgift]].concat(k.generisk.map(function (g) { return ['generisk', g.konto]; }))
      .forEach(function (x) {
        if (!self.kontoer[x[1]] || self.kontoer[x[1]].type !== 'kostnad') {
          throw new Error('Konfigurasjonen viser til konto ' + x[1] + ' («' + x[0] + '»), som ikke finnes som kostnadskonto i ' + self.navn + '.');
        }
      });
  }

  Kontoplan.prototype.kandidater = function (etikett, maks) {
    maks = maks || 5;
    var lab = norm(etikett), toks = lab ? lab.split(' ') : [], res = [], self = this;
    this.rekkefolge.forEach(function (k) {
      var r = self.kontoer[k], treff = [];
      r.nokkelord.forEach(function (kw) {
        if (kw.indexOf(' ') >= 0) {
          if (lab.indexOf(kw) >= 0) treff.push([0.9, kw]);
        } else if (toks.indexOf(kw) >= 0) {
          treff.push([1.0, kw]);
        } else if (Array.from(kw).length >= 4 && toks.some(function (t) { return t.indexOf(kw) >= 0; })) {
          treff.push([0.85, kw]);
        } else if (Array.from(kw).length >= 5 && toks.some(function (t) {
          return Array.from(t).length >= 5 && seqRatio(t, kw) >= 0.85;
        })) {
          treff.push([0.8, kw]);
        }
      });
      if (treff.length) {
        var best = Math.max.apply(null, treff.map(function (t) { return t[0]; }));
        var score = Math.min(1.0, best + 0.03 * (treff.length - 1));
        var kw;
        if (treff.length === 1) kw = treff[0][1];
        else {
          var mx = treff[0];
          treff.forEach(function (t) { if (t[0] > mx[0] || (t[0] === mx[0] && t[1] > mx[1])) mx = t; });
          kw = mx[1];
        }
        res.push([k, score, kw]);
      } else {
        var ratio = seqRatio(lab, norm(r.navn)) * 0.6;
        if (ratio >= 0.3) res.push([k, ratio, null]);
      }
    });
    res.sort(function (a, b) { return b[1] - a[1]; });
    return res.slice(0, maks);
  };

  Kontoplan.prototype.foreslaa = function (etikett) {
    var toks = tokens(etikett);
    if (toks.length && toks.length <= 2 && toks.some(function (t) { return GENERISK.indexOf(t) >= 0; })) {
      return this._pakk(etikett, this.konfig.kontoer.generisk.map(function (g) { return [g.konto, g.score, null]; }), true);
    }
    return this._pakk(etikett, this.kandidater(etikett));
  };

  Kontoplan.prototype._pakk = function (etikett, cands, generisk) {
    var self = this;
    if (!cands.length) {
      return { konto: null, navn: null, konf: 0.0, alternativer: [],
        begrunnelse: 'Ingen konto i kontoplanen ligner linjeteksten.', kilde_regel: null };
    }
    var best = cands[0], second = cands.length > 1 ? cands[1][1] : 0.0, konf;
    if (generisk) konf = best[1];
    else {
      var margin = Math.min(1.0, (best[1] - second) / 0.4);
      konf = round2(Math.min(0.98, best[1] * (0.75 + 0.25 * margin)));
    }
    var r = this.kontoer[best[0]], why;
    if (generisk) why = 'Generisk linjetekst uten tydelig innhold; forslaget er en gjetning og må velges av controller.';
    else if (best[2]) why = 'Linjeteksten inneholder nøkkelordet «' + best[2] + '» → konto ' + best[0] + ' ' + r.navn + '.';
    else why = 'Linjeteksten ligner kontonavnet «' + r.navn + '» (svak likhet).';
    return {
      konto: best[0], navn: r.navn, konf: konf,
      alternativer: cands.slice(1, 4).map(function (c) { return { konto: c[0], navn: self.kontoer[c[0]].navn, score: round2(c[1]) }; }),
      begrunnelse: why,
      kilde_regel: this.navn + ', konto ' + best[0],
    };
  };

  // ---------- Parser (poc/parser.py) ----------

  function flagg(alvor, kode, tekst) { return { alvor: alvor, kode: kode, tekst: tekst }; }

  var MAKS_BELOP = 1e13; // større tall er ikke et budsjettbeløp, men en feil i arket

  function lesTall(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) && Math.abs(v) <= MAKS_BELOP ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    var s = String(v).trim().replace(/ /g, '').replace(/ /g, '');
    if (s === '' || s === '-' || s === '–') return null;
    // Vanlige norske skrivemåter: «kr 25 000», «25 000 kr», «25 000,-», «(25 000)» for negativt beløp.
    s = s.replace(/^(kr\.?|nok)/i, '').replace(/(kr\.?|nok)$/i, '').replace(/[,.]-$/, '');
    var negativ = s.length > 2 && s.charAt(0) === '(' && s.charAt(s.length - 1) === ')';
    if (negativ) s = s.slice(1, -1);
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(/,/g, '.');
    else if ((s.match(/\./g) || []).length > 1 || /^[+-]?[1-9][0-9]{0,2}\.[0-9]{3}$/.test(s)) s = s.replace(/\./g, '');
    if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) return null;
    var f = parseFloat(s);
    if (negativ) f = -f;
    return isFinite(f) && Math.abs(f) <= MAKS_BELOP ? f : null;
  }

  var SUMRAD = /^(sum|totalt?|totalsum)( |$)/;
  var DATO = /[0-9]{1,2}[./-][0-9]{1,2}[./-](?:19|20)[0-9]{2}|20[0-9]{2}-[0-9]{2}(?:-[0-9]{2})?/g;
  function erTom(v) { return v === null || v === undefined || (typeof v === 'string' && ['', '-', '–'].indexOf(v.trim()) >= 0); }
  function erSumtekst(v) { return typeof v === 'string' && SUMRAD.test(norm(v)); }

  /** Budsjettåret: først et år rett etter «budsjett» i arket, så i ark- eller filnavn, til slutt et frittstående år (datoer ignoreres). */
  function finnAar(meta, navn) {
    var tekst = meta.replace(DATO, ' ');
    var kilder = [tekst].concat(navn.map(function (n) { return n.replace(/[_.-]/g, ' '); }));
    for (var i = 0; i < kilder.length; i++) {
      var m = /budsjett[a-zæøå]*\s*(?:for\s+|år\s+)?(20[0-9]{2})(?![0-9])/i.exec(kilder[i]);
      if (m) return Number(m[1]);
    }
    var m2 = /(?<![0-9])20[0-9]{2}(?![0-9])/.exec(tekst);
    return m2 ? Number(m2[0]) : null;
  }

  function periodeNokkel(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().toLowerCase().replace(/\.+$/, '');
    var m = /^q([1-4])$/.exec(s);
    if (m) return ['q', Number(m[1])];
    for (var i = 0; i < 12; i++) {
      var mnd = MANEDER[i];
      if (s === mnd || (s.length > 3 && s.indexOf(mnd) === 0 && FULLE.indexOf(s) >= 0)) return ['m', i + 1];
    }
    return null;
  }

  function fordel(total, maneder) {
    var n = maneder.length, base = Math.floor(total / n), ut = {};
    maneder.forEach(function (m) { ut[m] = base; });
    ut[maneder[n - 1]] = Math.trunc(total) - base * (n - 1);
    return ut;
  }

  function leggSammen(a, b) { Object.keys(b).forEach(function (k) { a[k] = (a[k] || 0) + b[k]; }); return a; }

  function finnAvdeling(avdelinger, metaTekst, arknavn, filnavn) {
    var koder = Object.create(null);
    avdelinger.forEach(function (a) { koder[a.kode.toUpperCase()] = a; });
    var m = /avdeling:\s*([\p{L}\p{N}_]+)/iu.exec(metaTekst);
    if (m && koder[m[1].toUpperCase()]) return [m[1].toUpperCase(), 'celle'];
    var kilder = [[arknavn, 'arknavn'], [filnavn, 'filnavn']];
    for (var i = 0; i < kilder.length; i++) {
      var t = kilder[i][0].toLowerCase();
      for (var j = 0; j < avdelinger.length; j++) {
        if (avdelinger[j].nokkelord.some(function (k) { return t.indexOf(k) >= 0; })) return [avdelinger[j].kode, kilder[i][1]];
      }
    }
    return [null, null];
  }

  function finnEnhet(tekster) {
    var t = tekster.join(' ').toLowerCase();
    if (/knok|k nok|i 1000|\(1000\)|tusen|1000 kr/.test(t)) return [1000, true];
    if (/hele kr|hele kroner/.test(t)) return [1, true];
    return [1, false];
  }

  function tolkFordeling(tekst, total) {
    var t = (tekst === null || tekst === undefined || tekst === '') ? '' : String(tekst).trim().toLowerCase();
    var alle = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    if (!t) {
      return [fordel(total, alle), 'jevnt (fordeling mangler i arket)', [
        flagg('middels', 'MANGLER_PERIODISERING', 'Fordeling er ikke oppgitt. Foreslår jevnt over 12 måneder; må bekreftes.')]];
    }
    if (t === 'jevnt') return [fordel(total, alle), 'jevnt over 12 måneder', []];
    for (var i = 0; i < 12; i++) {
      if (t === MANEDER[i]) { var o = {}; o[i + 1] = Math.trunc(total); return [o, 'hele beløpet i ' + MANEDER[i], []]; }
    }
    var m = /^(halvparten|(\d+)\s*%)\s*(i\s*)?q([1-4])\s*,?\s*resten jevnt$/.exec(t);
    if (m) {
      var andel = m[1] === 'halvparten' ? 0.5 : Number(m[2]) / 100;
      var q = Number(m[4]);
      var delQ = Math.trunc(pyRound(total * andel));
      var qm = [1, 2, 3].map(function (k) { return 3 * (q - 1) + k; });
      var ut = fordel(total - delQ, alle);
      leggSammen(ut, fordel(delQ, qm));
      var forkl = pyRound(andel * 100) + ' % (' + kr(delQ) + ' kr) fordelt over Q' + q + ', resten jevnt over 12 måneder';
      return [ut, forkl, [flagg('middels', 'TOLKET_FORDELING',
        'Fordelingen «' + tekst + '» er tolket som: ' + forkl + '. Bekreft tolkningen.')]];
    }
    return [fordel(total, alle), 'jevnt (kunne ikke tolke «' + tekst + '»)', [
      flagg('middels', 'UTOLKET_FORDELING', 'Fordelingen «' + tekst + '» ble ikke forstått. Foreslår jevnt; må bekreftes.')]];
  }

  function kolonne(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
  function celle(r, i) { return r && i < r.length && r[i] !== undefined ? r[i] : null; }
  function erTekst(c) { return typeof c === 'string'; }
  /** Linjeskift og Excel-escapes (_x000D_) i en celle blir til ett mellomrom. */
  function renTekst(s) { return s.replace(/_x000[dD]_/g, ' ').replace(/[\s\x85\x1c-\x1f\ufeff\u200b]+/g, ' ').trim(); }
  function stamme(filnavn) { var i = filnavn.lastIndexOf('.'); return i > 0 ? filnavn.slice(0, i) : filnavn; }

  function lesArk(rader, arknavn, filnavn, aar, avdelinger) {
    var hdr = null, layout = null, i, r;
    for (i = 0; i < rader.length; i++) {
      r = rader[i] || [];
      if (r.filter(function (c) { return periodeNokkel(c); }).length >= 3) { hdr = i; layout = 'bred'; break; }
      if (r.some(function (c) { return erTekst(c) && /beløp|belop/i.test(c); })) { hdr = i; layout = 'liste'; break; }
    }
    if (hdr === null) return null;

    var meta = [];
    rader.slice(0, hdr).forEach(function (rr) { (rr || []).forEach(function (c) { if (erTekst(c)) meta.push(c); }); });
    var hdrRad = rader[hdr];
    var enh = finnEnhet(meta.concat(hdrRad.filter(erTekst)));
    var enhet = enh[0];
    var avd = finnAvdeling(avdelinger, meta.join(' '), arknavn, stamme(filnavn));
    var funnet = finnAar(meta.join(' '), [arknavn, stamme(filnavn)]);

    var ark = { fil: filnavn, ark: arknavn, avdeling: avd[0], avdeling_kilde: avd[1], enhet: enhet,
      layout: layout, aar: funnet || aar, flagg: [], linjer: [], ulest: 0, hdr: hdr };
    var sumrad = null;
    function ulest(i, belop) {
      ark.ulest += belop;
      ark.flagg.push(flagg('høy', 'RAD_UTEN_ETIKETT', 'Rad ' + (i + 1) + ' har beløp (' + kr(belop) +
        ' kr) men ingen tekst i kolonne A. Raden er ikke lest; må avklares.'));
    }
    function ugyldig(i, etikett, j) {
      ark.flagg.push(flagg('høy', 'UGYLDIG_BELOP', 'Rad ' + (i + 1) + (etikett ? ' («' + renTekst(etikett) + '»)' : '') + ': cellen ' +
        kolonne(j + 1) + (i + 1) + ' kan ikke leses som beløp. Raden er ikke lest riktig; rett kildearket.'));
    }
    if (enhet === 1000) ark.flagg.push(flagg('info', 'ENHET', 'Enhet er tusen kr; omregnet til NOK.'));
    else if (!enh[1]) ark.flagg.push(flagg('høy', 'ENHET_UKJENT', 'Enhet er ikke oppgitt. Antar hele kroner; må bekreftes.'));
    if (avd[0] === null) ark.flagg.push(flagg('høy', 'AVDELING_UKJENT', 'Fant ikke avdeling i ark, arknavn eller filnavn.'));
    else if (avd[1] === 'filnavn') {
      ark.flagg.push(flagg('middels', 'AVDELING_FRA_FILNAVN',
        'Avdeling (' + avd[0] + ') er utledet fra filnavnet «' + filnavn + '». Bekreft avdeling og at dette er siste versjon.'));
    }
    if (funnet && funnet !== aar) {
      ark.flagg.push(flagg('høy', 'AAR_AVVIK', 'Arket ser ut til å gjelde ' + funnet + ', men kjøringen gjelder ' + aar + '. Importen bruker ' + aar +
        '; kontroller budsjettåret.'));
    }

    function ref(radNr, c1, c2) {
      var a = kolonne(c1 + 1) + (radNr + 1);
      return arknavn + '!' + (c2 === undefined ? a : a + ':' + kolonne(c2 + 1) + (radNr + 1));
    }

    if (layout === 'bred') {
      var pcols = [];
      hdrRad.forEach(function (c, j) { var p = periodeNokkel(c); if (p) pcols.push([j, p]); });
      var kcol = null, scol = null;
      hdrRad.forEach(function (c, j) {
        if (kcol === null && erTekst(c) && norm(c) === 'konto') kcol = j;
        if (scol === null && erTekst(c) && norm(c).indexOf('sum') === 0) scol = j;
      });
      var typer = {};
      pcols.forEach(function (p) { typer[p[1][0]] = true; });
      if (Object.keys(typer).length !== 1) {
        ark.flagg.push(flagg('høy', 'BLANDET_PERIODE', 'Arket blander måneder og kvartaler.'));
        return ark;
      }
      var sett = {};
      if (pcols.some(function (p) { var k = p[1][0] + p[1][1]; if (sett[k]) return true; sett[k] = true; return false; })) {
        ark.flagg.push(flagg('høy', 'DUPLISERT_PERIODE', 'Samme periode står i flere kolonner (for eksempel budsjett og fjorår side om side). ' +
          'Arket er ikke lest; fjern blokken som ikke er budsjett.'));
        return ark;
      }
      var kvartal = !!typer.q;
      var lest = 0;
      var pindekser = pcols.map(function (p) { return p[0]; });
      var jmin = Math.min.apply(null, pcols.map(function (p) { return p[0]; }));
      var jmax = Math.max.apply(null, pcols.map(function (p) { return p[0]; }));
      for (i = hdr + 1; i < rader.length; i++) {
        r = rader[i] || [];
        var etikett = celle(r, 0);
        var harEtikett = erTekst(etikett) && !!renTekst(etikett);
        var verdier = {};
        pcols.forEach(function (p) { if (p[0] < r.length) verdier[p[1][0] + p[1][1]] = lesTall(r[p[0]]); });
        var finnes = Object.keys(verdier).map(function (k) { return verdier[k]; });
        var radsum = finnes.reduce(function (s, v) { return v === null ? s : s + pyRound(v * enhet); }, 0);
        var ugyldige = pindekser.concat(scol !== null ? [scol] : []).filter(function (j) { return j < r.length && !erTom(r[j]) && lesTall(r[j]) === null; });
        if (ugyldige.length) ugyldig(i, harEtikett ? etikett : null, ugyldige[0]);
        var erSum = harEtikett ? (erSumtekst(etikett) && erTom(celle(r, kcol === null ? 1e9 : kcol)))
          : r.some(function (c, j) { return pindekser.indexOf(j) < 0 && j !== scol && erSumtekst(c); });
        if (erSum) {
          var ssv = scol !== null ? lesTall(celle(r, scol)) : null;
          var opp = ssv !== null ? pyRound(ssv * enhet) : (finnes.some(function (v) { return v !== null; }) ? radsum : null);
          if (opp !== null) sumrad = [i, opp, lest + ark.ulest];
          continue;
        }
        if (!harEtikett) {
          if (finnes.some(function (v) { return v; })) ulest(i, radsum);
          continue;
        }
        if (finnes.every(function (v) { return v === null; })) continue;
        var n = kvartal ? 4 : 12, orig = [];
        for (var k = 1; k <= n; k++) {
          var vv = verdier[(kvartal ? 'q' : 'm') + k];
          orig.push(pyRound((vv ? vv : 0.0) * enhet));
        }
        var perioder = {};
        if (kvartal) orig.forEach(function (v, qi) { leggSammen(perioder, fordel(v, [1, 2, 3].map(function (x) { return 3 * qi + x; }))); });
        else orig.forEach(function (v, mi) { perioder[mi + 1] = v; });
        var total = Object.keys(perioder).reduce(function (s, kk) { return s + perioder[kk]; }, 0);
        var kontoOpp = null, kc = celle(r, kcol === null ? 1e9 : kcol);
        if (kcol !== null && kc !== null && kc !== '') {
          kontoOpp = (typeof kc === 'number' || typeof kc === 'boolean') ? String(Math.trunc(Number(kc))) : String(kc).trim();
        }
        var linje = { etikett: renTekst(etikett), konto_oppgitt: kontoOpp, total: total, perioder: perioder, orig_perioder: orig,
          periodisering: kvartal ? 'kvartalsbeløp fordelt jevnt på måneder' : 'månedlig fra arket',
          kilde: filnavn + ' ' + ref(i, jmin, jmax), flagg: [],
          celler: { ark: arknavn, rad: i, kolonner: pcols.map(function (p) { return p[0]; }), ref: ref(i, jmin, jmax) } };
        lest += total;
        var sv = scol !== null ? lesTall(celle(r, scol)) : null;
        if (scol !== null && scol < r.length && sv !== null) {
          var oppgitt = pyRound(sv * enhet);
          lest += oppgitt - total;
          if (oppgitt !== total) {
            linje.flagg.push(flagg('høy', 'SUMAVVIK', 'Sum i arket (' + kr(oppgitt) + ' kr) stemmer ikke med periodene (' +
              kr(total) + ' kr). Avvik: ' + kr(oppgitt - total) + ' kr. Ingenting er rettet.'));
            linje.celler.sum = scol;
            linje.oppgitt_sum = oppgitt;
          }
        }
        ark.linjer.push(linje);
      }
    } else {
      var bcol = null, fcol = null;
      hdrRad.forEach(function (c, j) {
        if (bcol === null && erTekst(c) && /beløp|belop/i.test(c)) bcol = j;
        if (fcol === null && erTekst(c) && norm(c).indexOf('fordeling') === 0) fcol = j;
      });
      var lestL = 0;
      for (i = hdr + 1; i < rader.length; i++) {
        r = rader[i] || [];
        var et = celle(r, 0);
        var harEt = erTekst(et) && !!renTekst(et);
        var raa = bcol < r.length ? r[bcol] : null;
        var v2 = lesTall(raa);
        if (!erTom(raa) && v2 === null) ugyldig(i, harEt ? et : null, bcol);
        var erSumL = harEt ? erSumtekst(et) : r.some(function (c, j) { return j !== bcol && erSumtekst(c); });
        if (erSumL) {
          if (v2 !== null) sumrad = [i, pyRound(v2 * enhet), lestL + ark.ulest];
          continue;
        }
        if (!harEt) {
          if (v2) ulest(i, pyRound(v2 * enhet));
          continue;
        }
        if (v2 === null) continue;
        var tot = pyRound(v2 * enhet);
        lestL += tot;
        var ftekst = fcol !== null && fcol < r.length ? celle(r, fcol) : null;
        var tf = tolkFordeling(ftekst, tot);
        ark.linjer.push({ etikett: renTekst(et), konto_oppgitt: null, total: tot, perioder: tf[0], orig_perioder: null,
          periodisering: tf[1], kilde: filnavn + ' ' + ref(i, bcol), flagg: tf[2],
          celler: { ark: arknavn, rad: i, kolonner: fcol !== null ? [bcol, fcol] : [bcol], ref: ref(i, bcol) } });
      }
    }
    if (sumrad && sumrad[1] !== sumrad[2]) {
      ark.flagg.push(flagg('høy', 'ARKSUM_AVVIK', 'Arkets totalsum i rad ' + (sumrad[0] + 1) + ' (' + kr(sumrad[1]) +
        ' kr) stemmer ikke med radene over (' + kr(sumrad[2]) + ' kr). Avvik: ' + kr(sumrad[1] - sumrad[2]) + ' kr.'));
    }
    return ark;
  }

  function lesArbeidsbok(fil, aar, avdelinger) {
    var ut = [];
    fil.ark.forEach(function (a) { var r = lesArk(a.rader, a.navn, fil.navn, aar, avdelinger); if (r) ut.push(r); });
    return ut;
  }

  // ---------- Pipeline (poc/pipeline.py) ----------

  function Motor(data) {
    var konfig = data.konfig;
    TERSKLER.forEach(function (n) { if (typeof konfig.terskler[n] !== 'number') throw new Error('Konfigurasjonen mangler terskelen «' + n + '».'); });
    this.konfig = konfig;
    this.terskler = konfig.terskler;
    this.kp = new Kontoplan(data.kontoplanCsv, konfig);
    this.avdelinger = lesCsv(data.avdelingerCsv).map(function (a) { a.nokkelord = a.nokkelord.split('|'); return a; });
  }

  /** Stopper med en feil (med .funn) før noe leses hvis arkene ser ut til å inneholde persondata, som analyser() i Python. */
  Motor.prototype.analyser = function (filer, aar, runId) {
    var self = this, kp = this.kp;
    aar = aar || 2027;
    var funn = filer.reduce(function (a, f) { return a.concat(finnPersondata(f)); }, []);
    if (funn.length) { var feil = new Error(persondataTekst(funn)); feil.funn = funn; throw feil; }
    var run = { id: runId || nyId(), aar: aar, versjon: { regelsett: REGELSETT_VERSJON, modell: 'regelbasert', kontoplan: { fil: kp.navn } },
      filer: filer.map(function (f) { return { navn: f.navn }; }), ark: [], beslutninger: {}, kvitteringer: {}, eksport: null };
    filer.forEach(function (f) { run.ark = run.ark.concat(lesArbeidsbok(f, aar, self.avdelinger)); });
    var n = 0;
    run.ark.forEach(function (ark) {
      ark.linjer.forEach(function (l) {
        n += 1;
        l.id = 'l' + n;
        l.avdeling = ark.avdeling;
        foreslaKonto(l, kp);
        sjekkLinje(l, kp);
      });
    });
    sjekkArbeidsgiveravgift(run, this.konfig);
    return run;
  };

  function foreslaKonto(l, kp) {
    var opp = l.konto_oppgitt;
    l.modell = 'regler'; l.krever_valg = false; l.utenfor = false;
    if (opp) {
      if (kp.kontoer[opp]) {
        l.konto = opp; l.navn = kp.kontoer[opp].navn; l.konf = 0.99; l.alternativer = [];
        l.begrunnelse = 'Konto ' + opp + ' er oppgitt i arket og finnes i kontoplanen.';
        l.kilde_regel = kp.navn + ', konto ' + opp;
        return;
      }
      l.flagg.push(flagg('høy', 'UKJENT_KONTO', 'Konto ' + opp + ' i arket finnes ikke i kontoplanen.'));
    }
    var f = kp.foreslaa(l.etikett);
    ['konto', 'navn', 'konf', 'alternativer', 'begrunnelse', 'kilde_regel'].forEach(function (k) { l[k] = f[k]; });
  }

  function sjekkLinje(l, kp) {
    var t = kp.konfig.terskler, fl = l.flagg, konto = l.konto;
    if (konto && kp.kontoer[konto].type === 'inntekt' && l.konf >= t.sikker_konto) {
      l.utenfor = true;
      fl.push(flagg('høy', 'INNTEKT_I_KOSTNADSARK', 'Inntektslinje i kostnadsark (konto ' + konto +
        '). Holdes utenfor kostnadsimporten; legg den inn i inntektsbudsjettet. Velg en kostnadskonto hvis linjen egentlig er en kostnad.'));
    } else if (konto === null || l.konf < t.sikker_konto) {
      l.krever_valg = true;
      fl.push(flagg('middels', 'KONTO_MA_VELGES', 'Usikkert kontoforslag (konfidens ' + l.konf.toFixed(2) + '). Velg konto selv.'));
    }
    if (konto && kp.kontoer[konto].merknad && !l.utenfor) fl.push(flagg('middels', 'KONTOMERKNAD', kp.kontoer[konto].merknad));
    if (l.konto_oppgitt && kp.kontoer[l.konto_oppgitt]) {
      var alt = kp.kandidater(l.etikett, 1);
      if (alt.length && alt[0][1] >= t.tekst_uenig && alt[0][0] !== l.konto_oppgitt) {
        fl.push(flagg('middels', 'KONTO_TEKST_UENIG', 'Konto ' + l.konto_oppgitt + ' i arket, men teksten «' + l.etikett +
          '» peker mot konto ' + alt[0][0] + '.'));
      }
    }
    var orig = l.orig_perioder;
    if (orig && orig.length >= 3) {
      for (var i = 0; i < orig.length; i++) {
        var v = orig[i], andre = orig.slice(0, i).concat(orig.slice(i + 1));
        var snitt = andre.reduce(function (s, x) { return s + x; }, 0) / andre.length;
        if (snitt > 0 && v > t.hopp_faktor * snitt && v - snitt >= t.hopp_min_belop) {
          var navn = orig.length === 4 ? 'Q' + (i + 1) : MANEDER[i];
          fl.push(flagg('middels', 'HOPP', navn + ' (' + kr(v) + ' kr) er ' + pyRound((v / snitt - 1) * 100) +
            ' % over snittet av øvrige perioder (' + kr(snitt) + ' kr). Er det planlagt?'));
          l.hopp_periode = i;
          break;
        }
      }
    }
  }

  function sjekkArbeidsgiveravgift(run, konfig) {
    var perAvd = new Map(), lonn = konfig.kontoer.lonn, aga = konfig.kontoer.arbeidsgiveravgift;
    var AGA_SATS = konfig.aga.sats, toleranse = konfig.aga.toleranse;
    run.ark.forEach(function (ark) {
      ark.linjer.forEach(function (l) {
        if (!perAvd.has(ark.avdeling)) perAvd.set(ark.avdeling, { lonn: 0, aga: 0, lonnLinjer: [] });
        var d = perAvd.get(ark.avdeling);
        if (l.konto === lonn) { d.lonn += l.total; d.lonnLinjer.push(l); }
        else if (l.konto === aga) d.aga += l.total;
      });
    });
    perAvd.forEach(function (d) {
      if (d.lonn <= 0) return;
      var forventet = pyRound(d.lonn * AGA_SATS), tekst;
      if (d.aga === 0) {
        tekst = 'Avdelingen har lønn (' + kr(d.lonn) + ' kr) men ingen linje for arbeidsgiveravgift. Forventet ca. ' +
          kr(forventet) + ' kr (' + (AGA_SATS * 100).toFixed(1) + ' %). Kun flagg; ingenting er lagt til.';
      } else if (Math.abs(d.aga - forventet) / forventet > toleranse) {
        tekst = 'Arbeidsgiveravgift (' + kr(d.aga) + ' kr) avviker fra forventet ca. ' + kr(forventet) + ' kr (' +
          (AGA_SATS * 100).toFixed(1) + ' % av lønn).';
      } else return;
      d.lonnLinjer.forEach(function (l) { l.flagg.push(flagg('middels', 'AGA', tekst)); });
    });
  }

  function alleLinjer(run) { return run.ark.reduce(function (a, ark) { return a.concat(ark.linjer); }, []); }

  function effektivKonto(l, b) {
    if (!b) return null;
    if (b.valg === 'godta') return l.konto;
    if (b.valg === 'endre') return b.konto;
    return null;
  }

  /** Én beslutning, med samme regler som bruk_beslutninger. Returnerer {feil} eller {beslutning, endret}.
      Inntektslinjer (utenfor) kan bare bekreftes holdt utenfor («utenfor») eller tas med som kostnad («endre»). */
  Motor.prototype.vurder = function (run, l, valg, konto, kommentar) {
    var kp = this.kp;
    if (l.utenfor && valg && valg !== 'endre' && valg !== 'utenfor') return { feil: null, endret: false };
    if (!valg) { var had = !!run.beslutninger[l.id]; delete run.beslutninger[l.id]; if (had) run.eksport = null; return { feil: null, endret: had }; }
    if (VALG.indexOf(valg) < 0) return { feil: '«' + l.etikett + '»: ukjent valg «' + valg + '».' };
    if (valg === 'utenfor' && !l.utenfor) return { feil: '«' + l.etikett + '»: bare inntektslinjer kan holdes utenfor. Bruk «Avvis» for å utelate linjen.' };
    var valgt = (konto || '').trim();
    if (valg === 'endre' && !valgt) return { feil: '«' + l.etikett + '»: velg konto i listen først.' };
    konto = valgt || l.konto;
    kommentar = (kommentar || '').trim();
    if (valg === 'godta' && konto !== l.konto) valg = 'endre';
    if (valg === 'godta' && (l.konto === null || l.krever_valg)) {
      return { feil: '«' + l.etikett + '»: forslaget er for usikkert til å godtas direkte. Velg konto og bruk «Endre».' };
    }
    if (valg === 'endre' && (!kp.kontoer[konto] || kp.kontoer[konto].type !== 'kostnad')) {
      return { feil: '«' + l.etikett + '»: velg en gyldig kostnadskonto.' };
    }
    var ny = { valg: valg, konto: valg === 'godta' || valg === 'endre' ? konto : null, kommentar: kommentar };
    var gml = run.beslutninger[l.id];
    var endret = !gml || gml.valg !== ny.valg || gml.konto !== ny.konto || gml.kommentar !== ny.kommentar;
    if (endret) { run.beslutninger[l.id] = ny; run.eksport = null; }
    return { feil: null, endret: endret, beslutning: ny };
  };

  function utelatt(l, b) { return (!!b && (b.valg === 'avvis' || b.valg === 'utenfor')) || (l.utenfor && !b); }

  /** Høy-flagg som må kvitteres med kommentar, i samme rekkefølge som i arkene (kvitteringspliktige i Python).
      «gjelder» er usann når flagget bare gjelder linjer som er utelatt; da trengs ingen kvittering. */
  function kvitteringspliktige(run) {
    var ut = [];
    run.ark.forEach(function (a, n) {
      var med = a.linjer.map(function (l) { return !utelatt(l, run.beslutninger[l.id]); });
      a.flagg.forEach(function (f) {
        if (KVITTER_KODER.indexOf(f.kode) >= 0) {
          ut.push({ nokkel: 'a' + (n + 1) + ':' + f.kode, kode: f.kode, hvor: a.fil + '/' + a.ark, tekst: f.tekst, gjelder: med.some(Boolean), flagg: f });
        }
      });
      a.linjer.forEach(function (l, i) {
        l.flagg.forEach(function (f) {
          if (KVITTER_KODER.indexOf(f.kode) >= 0) ut.push({ nokkel: l.id + ':' + f.kode, kode: f.kode, hvor: l.etikett, tekst: f.tekst, gjelder: med[i], flagg: f });
        });
      });
    });
    return ut;
  }

  /** Kvitterer ut et høy-flagg med kommentar; tom kommentar angrer. Returnerer {feil} eller {endret, kvittering}. */
  Motor.prototype.kvitter = function (run, nokkel, kommentar) {
    var k = kvitteringspliktige(run).find(function (x) { return x.nokkel === nokkel; });
    if (!k) return { feil: 'Ukjent flagg: ' + nokkel + '.' };
    kommentar = (kommentar || '').trim();
    var gml = run.kvitteringer[nokkel];
    if (kommentar) {
      if (gml && gml.kommentar === kommentar) return { feil: null, endret: false };
      run.kvitteringer[nokkel] = { kode: k.kode, kommentar: kommentar };
    } else if (gml) delete run.kvitteringer[nokkel];
    else return { feil: null, endret: false };
    run.eksport = null;
    return { feil: null, endret: true, kvittering: k };
  };

  /** Skjema-variant (som bruk_beslutninger i Python), brukt i paritetstesten. Mangler 'q_<flagg>', er kvitteringen uendret. */
  Motor.prototype.brukBeslutninger = function (run, skjema) {
    var self = this, feil = [];
    alleLinjer(run).forEach(function (l) {
      var r = self.vurder(run, l, (skjema['d_' + l.id] || '').trim(), skjema['k_' + l.id], skjema['c_' + l.id]);
      if (r.feil) feil.push(r.feil);
    });
    kvitteringspliktige(run).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(skjema, 'q_' + k.nokkel)) self.kvitter(run, k.nokkel, skjema['q_' + k.nokkel]);
    });
    return feil;
  };

  var ULEST_KODER = ['RAD_UTEN_ETIKETT', 'DUPLISERT_PERIODE', 'BLANDET_PERIODE', 'UGYLDIG_BELOP'];

  function avstemming(run) {
    var a = { kilde: 0, godkjent: 0, avvist: 0, utenfor: 0, ikke_vurdert: 0 };
    alleLinjer(run).forEach(function (l) {
      a.kilde += l.total;
      var b = run.beslutninger[l.id];
      if (l.utenfor && (!b || b.valg === 'utenfor')) a.utenfor += l.total;
      else if (!b) a.ikke_vurdert += l.total;
      else if (b.valg === 'avvis') a.avvist += l.total;
      else a.godkjent += l.total;
    });
    a.ulest = run.ark.reduce(function (s, ark) { return s + (ark.ulest || 0); }, 0);
    a.ulest_ark = run.ark.filter(function (ark) { return ark.flagg.some(function (f) { return ULEST_KODER.indexOf(f.kode) >= 0; }); }).length;
    a.stemmer = a.kilde === a.godkjent + a.avvist + a.utenfor + a.ikke_vurdert && a.ulest === 0 && a.ulest_ark === 0;
    return a;
  }

  function liste(navn) { return navn.slice(0, 5).join(', ') + (navn.length > 5 ? '…' : ''); }

  function eksportfeil(run) {
    var feil = [], lin = alleLinjer(run);
    var mangler = lin.filter(function (l) { return !l.utenfor && !run.beslutninger[l.id]; }).map(function (l) { return l.etikett; });
    if (mangler.length) feil.push(mangler.length + ' linje(r) er ikke vurdert: ' + liste(mangler));
    var inntekt = lin.filter(function (l) { return l.utenfor && !run.beslutninger[l.id]; }).map(function (l) { return l.etikett; });
    if (inntekt.length) feil.push(inntekt.length + ' inntektslinje(r) er verken bekreftet holdt utenfor eller tatt med som kostnad: ' + liste(inntekt));
    var ulest = Array.from(new Set(run.ark.filter(function (a) {
      return a.flagg.some(function (f) { return ULEST_KODER.indexOf(f.kode) >= 0; });
    }).map(function (a) { return a.fil + '/' + a.ark; }))).sort();
    if (ulest.length) feil.push('Deler av kildearkene er ikke lest (' + ulest.join(', ') + '). Rett arkene og last dem inn på nytt.');
    var ukjent = run.ark.filter(function (a) { return !a.avdeling; }).map(function (a) { return a.fil; });
    if (ukjent.length) feil.push('Avdeling mangler for: ' + Array.from(new Set(ukjent)).sort().join(', '));
    var ukvittert = kvitteringspliktige(run).filter(function (k) { return k.gjelder && !run.kvitteringer[k.nokkel]; })
      .map(function (k) { return k.hvor + ' (' + k.kode + ')'; });
    if (ukvittert.length) feil.push(ukvittert.length + ' høy-flagg er ikke kvittert med kommentar: ' + liste(ukvittert));
    return feil;
  }

  // ---------- Persondata (poc/persondata.py) ----------

  var PD_FNR = /(?<![0-9])([0-9]{6}) ?([0-9]{5})(?![0-9])/g;
  var PD_EPOST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
  // Med landkode, eller gruppert som 912 34 567 / 22 33 44 55. Beløp grupperes i tre og treffer ikke.
  var PD_TLF = /(?<![0-9])(\+|00)47[ -]?[0-9]([ -]?[0-9]){7}(?![0-9])|(?<![0-9] )(?<![0-9])([2-9][0-9]{2} [0-9]{2} [0-9]{3}|[2-9][0-9] [0-9]{2} [0-9]{2} [0-9]{2})(?![0-9]| [0-9])/;
  // Åtte sifre uten mellomrom regnes bare som telefonnummer når cellen også sier at det er det.
  var PD_TLF_ORD = /tlf|telefon|mobil/i;
  var PD_TLF_8 = /(?<![0-9])[2-9][0-9]{7}(?![0-9])/;
  var PD_TYPER = { fnr: 'fødselsnummer', epost: 'e-postadresse', tlf: 'telefonnummer' };

  /** 11 sifre med gyldig dato (også D-, H- og syntetiske nummer) og begge kontrollsifrene. */
  function gyldigFnr(s) {
    var d = Array.from(s).map(Number), dag = Number(s.slice(0, 2)), mnd = Number(s.slice(2, 4));
    if (dag > 40) dag -= 40;
    mnd = mnd > 80 ? mnd - 80 : (mnd > 40 ? mnd - 40 : mnd);
    if (!(dag >= 1 && dag <= 31 && mnd >= 1 && mnd <= 12)) return false;
    return [[[3, 7, 6, 1, 8, 9, 4, 5, 2], 9], [[5, 4, 3, 2, 7, 6, 5, 4, 3, 2], 10]].every(function (v) {
      var k = (11 - v[0].reduce(function (s, w, i) { return s + w * d[i]; }, 0) % 11) % 11;
      return k !== 10 && k === d[v[1]];
    });
  }

  /** Typene persondata som finnes i én celleverdi (tom liste hvis ingen). */
  function skannVerdi(v) {
    if (v === null || v === undefined || typeof v === 'boolean' || v instanceof Date) return [];
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) return [];
      var t = String(v);
      return /^[0-9]+$/.test(t) && (t.length === 10 || t.length === 11) && gyldigFnr(t.padStart(11, '0')) ? ['fnr'] : [];
    }
    var s = String(v), ut = [], m;
    PD_FNR.lastIndex = 0;
    while ((m = PD_FNR.exec(s))) { if (gyldigFnr(m[1] + m[2])) { ut.push('fnr'); break; } }
    if (PD_EPOST.test(s)) ut.push('epost');
    if (PD_TLF.test(s) || (PD_TLF_ORD.test(s) && PD_TLF_8.test(s))) ut.push('tlf');
    return ut;
  }

  /** Alle ark i arbeidsboken (rader × celler som fra arbeidsbokFraSheetJS), også skjulte og ark uten budsjettabell. */
  function finnPersondata(fil) {
    var funn = [];
    fil.ark.forEach(function (a) {
      skannVerdi(a.navn).forEach(function (t) { funn.push({ fil: fil.navn, ark: a.navn, celle: a.navn + ' (arknavn)', type: t }); });
      a.rader.forEach(function (r, i) {
        (r || []).forEach(function (v, j) {
          skannVerdi(v).forEach(function (t) { funn.push({ fil: fil.navn, ark: a.navn, celle: a.navn + '!' + kolonne(j + 1) + (i + 1), type: t }); });
        });
      });
    });
    return funn;
  }

  function persondataTekst(funn) {
    var steder = funn.slice(0, 10).map(function (f) { return PD_TYPER[f.type] + ' i ' + f.fil + ' ' + f.celle; }).join(', ');
    return 'Innlesingen er stoppet fordi arkene ser ut til å inneholde persondata (' + steder +
      (funn.length > 10 ? ' og ' + (funn.length - 10) + ' til' : '') + '). Fjern persondataene og last opp på nytt. Verdiene er ikke lagret eller logget.';
  }

  function csvFelt(v) {
    var s = String(v);
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function byggEksport(run) {
    var feil = eksportfeil(run);
    if (feil.length) throw new Error(feil.join(' '));
    var rader = [['Avdeling', 'Konto', 'Periode', 'Belop_NOK', 'Versjon', 'Kommentar', 'Kilde']], sum = 0;
    alleLinjer(run).forEach(function (l) {
      var konto = effektivKonto(l, run.beslutninger[l.id]);
      if (!konto) return;
      Object.keys(l.perioder).map(Number).sort(function (a, b) { return a - b; }).forEach(function (m) {
        var belop = l.perioder[m];
        if (belop === 0) return;
        rader.push([l.avdeling, konto, run.aar + '-' + String(m).padStart(2, '0'), belop, 'UTKAST-' + run.id,
          l.etikett.replace(/;/g, ','), l.kilde]);
        sum += belop;
      });
    });
    var av = avstemming(run);
    if (sum !== av.godkjent) throw new Error('Avstemming feilet: importfil ' + sum + ' ≠ godkjent ' + av.godkjent);
    var tekst = rader.map(function (r) { return r.map(csvFelt).join(';'); }).join('\n') + '\n';
    return { filnavn: 'genus_import_' + run.id + '.csv', tekst: tekst, avstemming: av, rader: rader.length - 1, sum: sum };
  }

  function nyId() {
    var b = new Uint8Array(5);
    (root.crypto || globalThis.crypto).getRandomValues(b);
    return Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  async function sha256Bytes(buf) {
    var d = await (root.crypto || globalThis.crypto).subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  var FEILKODER = { 0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#NAME?', 36: '#NUM!', 42: '#N/A', 43: '#GETTING_DATA' };

  /** Leser en xlsx (ArrayBuffer/Uint8Array) med SheetJS til samme rader × celler som openpyxl gir Python-PoC-en:
      området regnes fra cellene (ikke <dimension>), datoer blir datoobjekter, feilverdier blir tekst som «#N/A». */
  function arbeidsbokFraSheetJS(XLSX, data, navn) {
    var wb = XLSX.read(data, { type: 'array', cellDates: true });
    return { navn: navn, ark: wb.SheetNames.map(function (n) {
      var ws = wb.Sheets[n], maxR = -1, maxC = -1, celler = [];
      Object.keys(ws).forEach(function (k) {
        if (k.charAt(0) === '!') return;
        var a = XLSX.utils.decode_cell(k);
        celler.push([a, ws[k]]);
        if (a.r > maxR) maxR = a.r;
        if (a.c > maxC) maxC = a.c;
      });
      var rader = [];
      for (var r = 0; r <= maxR; r++) { var rad = []; for (var c = 0; c <= maxC; c++) rad.push(null); rader.push(rad); }
      celler.forEach(function (x) {
        var a = x[0], cell = x[1], v;
        if (cell.t === 'e') v = cell.w !== undefined ? cell.w : (FEILKODER[cell.v] || '#ERR');
        else if (cell.t === 'z' || cell.v === undefined) v = null;
        else v = cell.v;
        rader[a.r][a.c] = v;
      });
      return { navn: n, rader: rader };
    }) };
  }

  async function sha256(tekst) {
    var buf = await (root.crypto || globalThis.crypto).subtle.digest('SHA-256', new TextEncoder().encode(tekst));
    return Array.from(new Uint8Array(buf)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  // ---------- Kontering (eget spor, kun demo) ----------

  var STOPP = ['og', 'i', 'av', 'nr', 'for', 'til', 'på', 'med', 'iht', 't', 'r', 'q1', 'q2', 'q3', 'q4',
    'januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember',
    'vår', 'høst'];
  function innhold(tekst) {
    return tokens(tekst).filter(function (t) { return t.length > 1 && !/^\d+$/.test(t) && STOPP.indexOf(t) < 0; });
  }
  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var A = new Set(a), B = new Set(b), felles = 0;
    A.forEach(function (x) { if (B.has(x)) felles++; });
    return felles / (A.size + B.size - felles);
  }

  function Kontering(data) {
    this.kontoplan = data.konteringKontoplan;
    this.navn = {};
    var self = this;
    this.kontoplan.forEach(function (k) { self.navn[k.konto] = k.navn; });
  }

  Kontering.prototype.regel = function (tekst) {
    var toks = tokens(tekst), ut = {};
    this.kontoplan.forEach(function (k) {
      var best = 0, kw = null;
      k.nokkelord.forEach(function (o) {
        var s = toks.indexOf(o) >= 0 ? 1.0 : (o.length >= 4 && toks.some(function (t) { return t.indexOf(o) >= 0; }) ? 0.85 : 0);
        if (s > best) { best = s; kw = o; }
      });
      if (best > 0) ut[k.konto] = { score: best, ord: kw };
    });
    return ut;
  };

  /** Forslag for én faktura ut fra historikk (uten fakturaen selv), regler og tekstlikhet. */
  Kontering.prototype.foreslaa = function (f, historikk) {
    var self = this;
    var lev = historikk.filter(function (h) { return h.leverandor === f.leverandor; });
    var levTelling = {};
    lev.forEach(function (h) { levTelling[h.konto] = (levTelling[h.konto] || 0) + 1; });
    var regel = this.regel(f.tekst);
    var ord = innhold(f.tekst);
    var likhet = {};
    historikk.forEach(function (h) {
      var j = jaccard(ord, innhold(h.tekst));
      if (j > 0 && (!likhet[h.konto] || j > likhet[h.konto].score)) likhet[h.konto] = { score: j, bilag: h };
    });
    var kandidater = this.kontoplan.map(function (k) {
      var l = lev.length ? (levTelling[k.konto] || 0) / lev.length : 0;
      var r = regel[k.konto] ? regel[k.konto].score : 0;
      var t = likhet[k.konto] ? likhet[k.konto].score : 0;
      var s = 0.5 * l + 0.3 * r + 0.2 * t;
      var belegg = [];
      if (levTelling[k.konto]) belegg.push(levTelling[k.konto] + ' av ' + lev.length + ' tidligere fakturaer fra ' + f.leverandor + ' er ført på ' + k.konto + '.');
      if (regel[k.konto]) belegg.push('Teksten inneholder «' + regel[k.konto].ord + '» (konteringsregel for ' + k.konto + ').');
      if (likhet[k.konto]) belegg.push('Ligner bilag ' + likhet[k.konto].bilag.bilag + ' «' + likhet[k.konto].bilag.tekst + '» (' + k.konto + ').');
      return { konto: k.konto, navn: k.navn, score: s, deler: { leverandor: l, regel: r, likhet: t }, belegg: belegg };
    }).filter(function (k) { return k.score > 0; }).sort(function (a, b) { return b.score - a.score; });

    var forslag = { bilag: f.bilag, kandidater: kandidater.slice(0, 3), konto: null, navn: null, konf: 0, flagg: [], kostnadssted: null };
    if (kandidater.length) {
      var s1 = kandidater[0].score, s2 = kandidater.length > 1 ? kandidater[1].score : 0;
      forslag.konto = kandidater[0].konto;
      forslag.navn = kandidater[0].navn;
      forslag.konf = round2(Math.min(0.97, s1 * (0.55 + 0.45 * Math.min(1, (s1 - s2) / 0.35))));
      var ks = {}, nks = 0;
      lev.filter(function (h) { return h.konto === forslag.konto; }).forEach(function (h) { ks[h.kostnadssted] = (ks[h.kostnadssted] || 0) + 1; nks++; });
      var rang = Object.keys(ks).sort(function (a, b) { return ks[b] - ks[a] || (a < b ? -1 : 1); });
      if (rang.length) {
        var andre = rang.slice(1).map(function (k) { return ks[k] + ' på ' + k; });
        forslag.kostnadsstedBegrunnelse = ks[rang[0]] + ' av ' + nks + ' tidligere ' + forslag.konto + '-fakturaer fra ' + f.leverandor +
          ' er ført på ' + rang[0] + (andre.length ? ' (' + andre.join(', ') + ')' : '') + '.';
        if (ks[rang[0]] / nks >= 0.6) forslag.kostnadssted = rang[0];
        else forslag.flagg.push(flagg('middels', 'KOSTNADSSTED_UAVKLART', 'Historikken peker ikke tydelig mot ett kostnadssted (' +
          rang.map(function (k) { return k + ' ' + ks[k]; }).join(', ') + '). Velg kostnadssted selv.'));
      }
    }
    if (!lev.length) forslag.flagg.push(flagg('middels', 'NY_LEVERANDOR', 'Ny leverandør. Ingen tidligere konteringer å støtte seg på.'));
    if (!kandidater.length) forslag.flagg.push(flagg('høy', 'INGEN_FORSLAG', 'Fant ikke grunnlag for et forslag. Velg konto selv.'));
    // Flere kontoer: minst to kontoer har et helt ord i teksten (ikke bare en orddel).
    var sterke = Object.keys(regel).filter(function (k) { return regel[k].score === 1.0; });
    if (sterke.length >= 2) {
      forslag.flagg.push(flagg('middels', 'FLERE_KONTOER', 'Teksten peker mot flere kontoer (' + sterke.join(', ') + '). Vurder å splitte fakturaen.'));
    }
    var levTopp = Object.keys(levTelling).sort(function (a, b) { return levTelling[b] - levTelling[a]; })[0];
    var regelTopp = Object.keys(regel).sort(function (a, b) { return regel[b].score - regel[a].score; })[0];
    if (levTopp && regelTopp && regel[regelTopp].score === 1.0 && regelTopp !== levTopp &&
        !(regel[levTopp] && regel[levTopp].score === 1.0)) {
      forslag.flagg.push(flagg('middels', 'AVVIK_FRA_HISTORIKK', f.leverandor + ' føres vanligvis på ' + levTopp + ' ' + self.navn[levTopp] +
        ', men teksten peker mot ' + regelTopp + ' ' + self.navn[regelTopp] + '.'));
    }
    var fremtid = (f.tekst.match(/20\d\d/g) || []).filter(function (y) { return Number(y) > Number(f.dato.slice(0, 4)); });
    if (fremtid.length) {
      forslag.flagg.push(flagg('middels', 'PERIODISERING', 'Teksten gjelder ' + fremtid[0] + ', mens fakturadato er ' + f.dato +
        '. Vurder periodisering (forskuddsbetalt kostnad).'));
    }
    return forslag;
  };

  Kontering.prototype.foreslaaAlle = function (fakturaer, historikk) {
    var self = this;
    var ut = fakturaer.map(function (f) { return self.foreslaa(f, historikk); });
    fakturaer.forEach(function (f, i) {
      var dup = fakturaer.slice(0, i).filter(function (g) { return g.leverandor === f.leverandor && g.belop === f.belop && norm(g.tekst) === norm(f.tekst); })[0];
      if (dup) ut[i].flagg.unshift(flagg('høy', 'MULIG_DUPLIKAT', 'Samme leverandør, tekst og beløp som ' + dup.bilag + '. Kontroller før godkjenning.'));
    });
    return ut;
  };

  /** Enkel sammenligningsregel: kontoen leverandøren oftest er ført på. */
  function baseline(f, historikk) {
    var t = {};
    historikk.forEach(function (h) { if (h.leverandor === f.leverandor) t[h.konto] = (t[h.konto] || 0) + 1; });
    return Object.keys(t).sort(function (a, b) { return t[b] - t[a] || (a < b ? -1 : 1); })[0] || null;
  }

  /** Offline-evaluering: hver historisk faktura vurderes mot resten av historikken (leave-one-out),
      og sammenlignes med den enkle regelen «hyppigste konto for leverandøren». */
  Kontering.prototype.evaluer = function (historikk) {
    var self = this, res = [];
    historikk.forEach(function (h, i) {
      var resten = historikk.slice(0, i).concat(historikk.slice(i + 1));
      var f = self.foreslaa({ bilag: h.bilag, leverandor: h.leverandor, tekst: h.tekst, belop: h.belop, dato: h.dato }, resten);
      res.push({ bilag: h.bilag, fasit: h.konto, forslag: f.konto, konf: f.konf, baseline: baseline(h, resten),
        topp3: f.kandidater.some(function (k) { return k.konto === h.konto; }) });
    });
    return oppsummer(res);
  };

  function oppsummer(res) {
    var n = res.length;
    var topp1 = res.filter(function (r) { return r.forslag === r.fasit; }).length;
    var topp3 = res.filter(function (r) { return r.topp3; }).length;
    var base = res.filter(function (r) { return r.baseline !== undefined && r.baseline === r.fasit; }).length;
    var band = [
      { navn: 'Høy (≥ 0,90)', fra: 0.9, til: 1.01 },
      { navn: 'Middels (0,60–0,89)', fra: 0.6, til: 0.9 },
      { navn: 'Lav (< 0,60)', fra: -1, til: 0.6 },
    ].map(function (b) {
      var i = res.filter(function (r) { return r.konf >= b.fra && r.konf < b.til; });
      return { navn: b.navn, antall: i.length, riktige: i.filter(function (r) { return r.forslag === r.fasit; }).length };
    });
    return { n: n, topp1: topp1, topp3: topp3, baseline: base, band: band, detaljer: res };
  }

  var api = {
    Motor: Motor, Kontoplan: Kontoplan, Kontering: Kontering,
    alleLinjer: alleLinjer, avstemming: avstemming, eksportfeil: eksportfeil, byggEksport: byggEksport,
    effektivKonto: effektivKonto, oppsummer: oppsummer, baseline: baseline, sha256: sha256, sha256Bytes: sha256Bytes, nyId: nyId,
    arbeidsbokFraSheetJS: arbeidsbokFraSheetJS, ULEST_KODER: ULEST_KODER, KVITTER_KODER: KVITTER_KODER,
    kvitteringspliktige: kvitteringspliktige, finnPersondata: finnPersondata, persondataTekst: persondataTekst,
    skannVerdi: skannVerdi, gyldigFnr: gyldigFnr,
    kr: kr, norm: norm, seqRatio: seqRatio, lesTall: lesTall, kolonne: kolonne, pyRound: pyRound,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Motor = api;
})(typeof window !== 'undefined' ? window : globalThis);
