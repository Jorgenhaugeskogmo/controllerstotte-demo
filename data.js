/* Syntetiske demodata. Alt er oppdiktet: avdelinger, beløp, leverandører og bilag.
   Budsjettarkene er identiske med testdata/ (laget av make_testdata.py), gjengitt som rader × celler. */
(function (root) {
  'use strict';

  var M12 = function (v) { var a = []; for (var i = 0; i < 12; i++) a.push(v); return a; };
  var MND = ['Jan', 'Feb', 'Mar', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Des'];

  var budsjettfiler = [
    {
      navn: 'Budsjett_2027_OPS.xlsx',
      sha256: 'beaf20198eb06195c065bb9bed40b8bcfc6a998f5405975032a32daa079f45cb',
      ark: [{
        navn: 'Budsjett',
        rader: [
          ['Budsjett 2027 – alle tall i kNOK'],
          ['Avdeling: OPS'],
          [],
          ['Post', 'Konto'].concat(MND).concat(['Sum']),
          ['Lønn', 5000].concat(M12(850)).concat([10200]),
          ['Arbeidsgiveravgift', 5400].concat(M12(120)).concat([1440]),
          ['Leie lokaler', 6300].concat(M12(95)).concat([1140]),
          ['Reise', 7140, 40, 40, 60, 60, 60, 40, 20, 40, 60, 60, 60, 20, 580],
          ['Diverse', null].concat(M12(25)).concat([300]),
          ['Sum kostnader', null].concat(M12(null)).concat([13660]),
        ],
      }],
    },
    {
      navn: 'Budsjett_komm_v3_ENDELIG_ny.xlsx',
      sha256: '9941a5dc709cd101dd45c0da5e7b928e24d1a2dec0e6b4f0547dfa5008bc87c1',
      ark: [{
        navn: 'Ark1',
        rader: [
          ['Aktivitet', 'Beløp (i 1000)', 'Fordeling'],
          ['Lønn kommunikasjonsrådgivere (3 årsv.)', 2900, 'jevnt'],
          ['Digital annonsering', 1200, 'halvparten Q4, resten jevnt'],
          ['Trykk høstkampanje', 450, 'okt'],
          ['Foto og video', 380, null],
        ],
      }],
    },
    {
      navn: 'Medlemsservice_budsjett.xlsx',
      sha256: '1e0ed0c4cc59e3e4142ce7bf327a1d2d8f4d289b5db9fd9ad0526273d2864fd4',
      ark: [{
        navn: 'Medlemsservice',
        rader: [
          ['Budsjett 2027, hele kroner, ekskl. mva'],
          [],
          ['Beskrivelse', 'Q1', 'Q2', 'Q3', 'Q4'],
          ['Lønnskostnader', '2 100 000', '2 100 000', '2 100 000', '2 100 000'],
          ['Arbeidsgiveravgift', '296 000', '296 000', '296 000', '296 000'],
          ['Porto og trykksaker', '180 000', '120 000', '120 000', '260 000'],
          ['Lisenser og programvare', '75 000', '75 000', '75 000', '75 000'],
          ['Medlemsinntekter', '3 500 000', '3 500 000', '3 500 000', '3 500 000'],
        ],
      }],
    },
  ];

  var kontoplanCsv = [
    'konto;navn;type;nokkelord;merknad',
    '3000;Medlemsinntekter;inntekt;medlemsinntekt|medlemsinntekter|medlemskontingent;',
    '5000;Lønn;kostnad;lønn|lønnskostnad|lønnskostnader|lønninger|fastlønn;',
    '5400;Arbeidsgiveravgift;kostnad;arbeidsgiveravgift|arb giveravgift|aga;',
    '6300;Leie lokaler;kostnad;leie|husleie|lokaler|lokale;',
    '6550;Programvare og lisenser;kostnad;programvare|lisens|software|abonnement;Lisenser over aktiveringsgrensen skal vurderes som investering (se regnskapsinstruks).',
    '6800;Kontorrekvisita og driftsmateriell;kostnad;kontorrekvisita|rekvisita|kontor|driftsmateriell;',
    '6820;Trykksaker og porto;kostnad;trykk|trykksaker|porto|forsendelse|brosjyre;',
    '6860;Møter, kurs og konferanser;kostnad;kurs|konferanse|møte|møter|opplæring;',
    '7140;Reisekostnad;kostnad;reise|reiser|billett|diett|overnatting;',
    '7320;Reklame og annonsering;kostnad;annonse|annonsering|reklame|kampanje|markedsføring;',
    '7350;Foto, video og produksjon;kostnad;foto|video|produksjon|film;',
    '7790;Annen driftskostnad;kostnad;annen driftskostnad;',
  ].join('\n');

  var avdelingerCsv = [
    'kode;navn;nokkelord',
    'OPS;Operativ støtte;ops|operativ',
    'MEDL;Medlemsservice;medl',
    'KOM;Kommunikasjon;komm',
  ].join('\n');

  /* Kontonumre, AGA-sats og terskler: samme innhold som data/konfig.json (paritetstesten kontrollerer det). */
  var konfig = {
    kontoplan: 'kontoplan.csv',
    avdelinger: 'avdelinger.csv',
    kontoer: {
      lonn: '5000',
      arbeidsgiveravgift: '5400',
      generisk: [{ konto: '6800', score: 0.41 }, { konto: '7790', score: 0.23 }],
    },
    aga: { sats: 0.141, toleranse: 0.15 },
    terskler: {
      sikker_konto: 0.85, hoy_konfidens: 0.9, modell: 0.9, modell_maks: 0.85, tekst_uenig: 0.9,
      hopp_faktor: 1.5, hopp_min_belop: 20000,
    },
  };

  /* ---------- Kontering (eget spor) ---------- */
  var konteringKontoplan = [
    { konto: '6300', navn: 'Leie lokaler', nokkelord: ['husleie', 'leie', 'lokaler', 'felleskostnader'] },
    { konto: '6340', navn: 'Lys og varme', nokkelord: ['strøm', 'energi', 'fjernvarme', 'nettleie'] },
    { konto: '6550', navn: 'Programvare og lisenser', nokkelord: ['lisens', 'årslisens', 'lisenser', 'programvare'] },
    { konto: '6600', navn: 'Reparasjon og vedlikehold', nokkelord: ['reparasjon', 'vedlikehold', 'service', 'utbedring'] },
    { konto: '6720', navn: 'Konsulenttjenester', nokkelord: ['konsulent', 'konsulentbistand', 'rådgivning', 'bistand', 'timer'] },
    { konto: '6800', navn: 'Kontorrekvisita og driftsmateriell', nokkelord: ['kontorrekvisita', 'rekvisita', 'kaffe', 'papir'] },
    { konto: '6820', navn: 'Trykksaker og porto', nokkelord: ['trykk', 'trykking', 'porto', 'utsendelse', 'medlemsblad', 'brosjyrer'] },
    { konto: '6860', navn: 'Møter, kurs og konferanser', nokkelord: ['kurs', 'konferanse', 'seminar', 'deltakere'] },
    { konto: '6900', navn: 'Telefon og datakommunikasjon', nokkelord: ['mobil', 'mobilabonnement', 'telefon', 'bredbånd'] },
    { konto: '7140', navn: 'Reisekostnad', nokkelord: ['reise', 'flybilletter', 'fly', 'hotell', 'overnatting'] },
    { konto: '7320', navn: 'Reklame og annonsering', nokkelord: ['annonsering', 'annonse', 'annonseplass', 'kampanje', 'reklame'] },
    { konto: '7350', navn: 'Foto, video og produksjon', nokkelord: ['video', 'videoproduksjon', 'foto', 'fotografering', 'film', 'kampanjefilm'] },
    { konto: '7500', navn: 'Forsikring', nokkelord: ['forsikring', 'ansvarsforsikring', 'forsikringspremie', 'premie'] },
    { konto: '7790', navn: 'Annen driftskostnad', nokkelord: [] },
  ];

  var kostnadssteder = [
    { kode: 'OPS', navn: 'Operativ støtte' },
    { kode: 'MEDL', navn: 'Medlemsservice' },
    { kode: 'KOM', navn: 'Kommunikasjon' },
  ];

  /* Historikk: tidligere godkjente konteringer (fasit fra «Eyeshare»), generert deterministisk. */
  var mnd = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september'];
  var monstre = [
    ['Fjordtrykk Demo AS', function (i) { return 'Trykk av medlemsblad nr. ' + (i + 1); }, '6820', 'MEDL', 5, [62000, 91000]],
    ['Fjordtrykk Demo AS', function (i) { return 'Trykk av brosjyrer ' + ['vår', 'høst'][i]; }, '6820', 'KOM', 2, [14000, 26000]],
    ['Fjordtrykk Demo AS', function () { return 'Porto utsendelse medlemsblad'; }, '6820', 'MEDL', 2, [38000, 52000]],
    ['Fjordtrykk Demo AS', function () { return 'Annonseplass i lokalavis'; }, '7320', 'KOM', 1, [9000, 12000]],
    ['Nordlys Energi Demo AS', function (i) { return 'Strøm ' + mnd[i]; }, '6340', 'OPS', 9, [28000, 56000]],
    ['Kvisten Eiendom Demo AS', function (i) { return 'Husleie ' + mnd[i]; }, '6300', 'OPS', 9, [95000, 95000]],
    ['Kvisten Eiendom Demo AS', function (i) { return 'Felleskostnader Q' + (i + 1); }, '6300', 'OPS', 3, [18000, 22000]],
    ['Skybrett Programvare Demo AS', function (i) { return 'Lisens økonomimodul Q' + (i + 1); }, '6550', 'OPS', 3, [36000, 36000]],
    ['Skybrett Programvare Demo AS', function (i) { return 'Lisens medlemsregister Q' + (i + 1); }, '6550', 'MEDL', 3, [42000, 42000]],
    ['Skybrett Programvare Demo AS', function (i) { return 'Konsulentbistand integrasjon, ' + [8, 14][i] + ' timer'; }, '6720', 'MEDL', 2, [14000, 25000]],
    ['Trolltind Reisebyrå Demo AS', function (i) { return 'Flybilletter OSL–' + ['BGO', 'TRD', 'BOO', 'TOS', 'SVG'][i]; }, '7140', 'OPS', 5, [2400, 6800]],
    ['Trolltind Reisebyrå Demo AS', function (i) { return 'Hotell ' + ['Bergen', 'Tromsø'][i]; }, '7140', 'KOM', 2, [3100, 5200]],
    ['Havblikk Media Demo AS', function (i) { return 'Annonsering ' + ['sosiale medier', 'nettaviser', 'radio', 'sosiale medier', 'podkast'][i]; }, '7320', 'KOM', 5, [25000, 70000]],
    ['Havblikk Media Demo AS', function () { return 'Fotografering medlemskampanje'; }, '7350', 'KOM', 1, [18000, 18000]],
    ['Bjørkli Kontorservice Demo AS', function (i) { return 'Kontorrekvisita ' + mnd[i * 2]; }, '6800', 'OPS', 4, [2100, 5600]],
    ['Bjørkli Kontorservice Demo AS', function () { return 'Kaffe og frukt'; }, '6800', 'MEDL', 2, [1800, 2600]],
    ['Polarnett Demo AS', function (i) { return 'Mobilabonnement ' + mnd[i]; }, '6900', 'OPS', 6, [11800, 12600]],
    ['Polarnett Demo AS', function (i) { return 'Bredbånd ' + mnd[i * 3]; }, '6900', 'KOM', 3, [1490, 1490]],
    ['Rådgivergruppen Vest Demo AS', function (i) { return 'Rådgivning ' + ['innkjøpsavtaler', 'internkontroll', 'risikostyring'][i]; }, '6720', 'OPS', 3, [30000, 60000]],
    ['Trygghet Forsikring Demo AS', function () { return 'Forsikringspremie 2026'; }, '7500', 'OPS', 1, [36500, 36500]],
    ['Trygghet Forsikring Demo AS', function () { return 'Reiseforsikring'; }, '7500', 'KOM', 1, [4200, 4200]],
  ];
  var historikk = [];
  var frø = 7;
  var tilfeldig = function () { frø = (frø * 48271) % 2147483647; return frø / 2147483647; };
  monstre.forEach(function (m) {
    for (var i = 0; i < m[4]; i++) {
      var lo = m[5][0], hi = m[5][1];
      var belop = Math.round((lo + (hi - lo) * tilfeldig()) / 10) * 10;
      historikk.push({ leverandor: m[0], tekst: m[1](i), konto: m[2], kostnadssted: m[3], belop: belop });
    }
  });
  historikk.forEach(function (h, i) {
    h.bilag = 'H-2026-' + String(i + 1).padStart(3, '0');
    h.dato = '2026-' + String(1 + (i % 9)).padStart(2, '0') + '-' + String(5 + (i % 20)).padStart(2, '0');
  });

  /* Nye fakturaer til vurdering, med fasit (endelig kontering) for evaluering. */
  var fakturaer = [
    { bilag: 'F-1001', leverandor: 'Fjordtrykk Demo AS', tekst: 'Trykk av medlemsblad nr. 4', belop: 86400, dato: '2026-10-02', fasit: '6820' },
    { bilag: 'F-1002', leverandor: 'Nordlys Energi Demo AS', tekst: 'Strøm oktober', belop: 41230, dato: '2026-10-03', fasit: '6340' },
    { bilag: 'F-1003', leverandor: 'Kvisten Eiendom Demo AS', tekst: 'Husleie november', belop: 95000, dato: '2026-10-05', fasit: '6300' },
    { bilag: 'F-1004', leverandor: 'Skybrett Programvare Demo AS', tekst: 'Årslisens budsjettmodul 2027', belop: 148000, dato: '2026-10-06', fasit: '6550' },
    { bilag: 'F-1005', leverandor: 'Skybrett Programvare Demo AS', tekst: 'Konsulentbistand oppsett, 12 timer', belop: 21600, dato: '2026-10-06', fasit: '6720' },
    { bilag: 'F-1006', leverandor: 'Trolltind Reisebyrå Demo AS', tekst: 'Flybilletter OSL–TOS t/r', belop: 7840, dato: '2026-10-07', fasit: '7140' },
    { bilag: 'F-1007', leverandor: 'Havblikk Media Demo AS', tekst: 'Annonsering høstkampanje sosiale medier', belop: 62500, dato: '2026-10-08', fasit: '7320' },
    { bilag: 'F-1008', leverandor: 'Havblikk Media Demo AS', tekst: 'Videoproduksjon kampanjefilm', belop: 118000, dato: '2026-10-08', fasit: '7350' },
    { bilag: 'F-1009', leverandor: 'Polarnett Demo AS', tekst: 'Mobilabonnement oktober', belop: 12480, dato: '2026-10-09', fasit: '6900' },
    { bilag: 'F-1010', leverandor: 'Lysaker Kursforlag Demo AS', tekst: 'Kurs i budsjettering, 2 deltakere', belop: 9800, dato: '2026-10-12', fasit: '6860' },
    { bilag: 'F-1011', leverandor: 'Østlandet Verksted Demo AS', tekst: 'Faktura iht. avtale', belop: 27350, dato: '2026-10-13', fasit: '6600' },
    { bilag: 'F-1012', leverandor: 'Bjørkli Kontorservice Demo AS', tekst: 'Kontorrekvisita oktober', belop: 4315, dato: '2026-10-14', fasit: '6800' },
    { bilag: 'F-1013', leverandor: 'Rådgivergruppen Vest Demo AS', tekst: 'Rådgivning budsjettprosess', belop: 45000, dato: '2026-10-14', fasit: '6720' },
    { bilag: 'F-1014', leverandor: 'Trygghet Forsikring Demo AS', tekst: 'Ansvarsforsikring 2027', belop: 38900, dato: '2026-10-15', fasit: '7500' },
    { bilag: 'F-1015', leverandor: 'Fjordtrykk Demo AS', tekst: 'Trykk og annonseplass høstkampanje', belop: 33700, dato: '2026-10-16', fasit: '6820' },
    { bilag: 'F-1016', leverandor: 'Kvisten Eiendom Demo AS', tekst: 'Husleie november', belop: 95000, dato: '2026-10-16', fasit: '6300' },
  ];

  var data = {
    budsjettfiler: budsjettfiler,
    kontoplanCsv: kontoplanCsv,
    avdelingerCsv: avdelingerCsv,
    konfig: konfig,
    konteringKontoplan: konteringKontoplan,
    kostnadssteder: kostnadssteder,
    historikk: historikk,
    fakturaer: fakturaer,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = data;
  else root.DemoData = data;
})(typeof window !== 'undefined' ? window : globalThis);
