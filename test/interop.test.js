// Round-trips RDocs and RDrive Sheets through Word, Excel, OpenDocument and Markdown using the
// same converter code (public/interop.js) and library versions the browser uses.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { DOMParser } = require('linkedom');
const { DOMParser: XMLParser } = require('@xmldom/xmldom');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const docx = require('docx');
const interop = require('../public/interop');
const sheets = require('../public/sheet');

const deps = { DOMParser, XMLParser, ExcelJS, JSZip, mammoth, docx, evaluate: sheets.evaluateWorkbook };

const SAMPLE_HTML = [
  '<h1>Quarterly plan</h1>',
  '<p style="text-align: center">Intro with <strong>bold</strong>, <em>italic</em>, <u>underline</u> and <a href="https://example.com/x">a link</a>.</p>',
  '<h2>Goals</h2>',
  '<ul><li>Ship <strong>RDocs</strong></li><li>Import Word files</li></ul>',
  '<ol><li>First</li><li>Second</li></ol>',
  '<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Laptop</td><td>1200</td></tr></table>',
].join('');

test('vendored browser bundles match the installed libraries', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'vendor.js'), '--check'], { stdio: 'pipe' });
});

test('sanitizer keeps formatting and strips anything active', () => {
  const dirty =
    '<h2 onclick="evil()">Title</h2><script>alert(1)</script><p>Hi <b>there</b> <span style="font-weight:700">bold span</span></p>' +
    '<a href="javascript:alert(1)">bad</a><a href="https://ok.example">good</a>' +
    '<img src="https://tracker.example/pixel.gif"><img src="data:image/png;base64,iVBORw0KGgo=" onerror="x()">' +
    '<iframe src="https://x"></iframe><p style="color:red;text-align:right">aligned</p><style>p{}</style><!-- c -->';
  const clean = interop.sanitizeHtml(dirty, DOMParser);
  assert.doesNotMatch(clean, /script|onclick|onerror|javascript:|iframe|tracker|<style|color:red|<!--/i);
  assert.match(clean, /<h2>Title<\/h2>/);
  assert.match(clean, /<strong>there<\/strong>/);
  assert.match(clean, /<strong>bold span<\/strong>/);
  assert.match(clean, /<a [^>]*href="https:\/\/ok\.example"[^>]*>good<\/a>/);
  assert.match(clean, /<img src="data:image\/png;base64,iVBORw0KGgo=">/);
  assert.match(clean, /<p style="text-align: right">aligned<\/p>/);
  assert.match(clean, />bad</); // link text survives, the link doesn't
});

test('rdoc files are JSON and refuse foreign content', () => {
  const text = interop.serializeDoc('<p>x</p>');
  assert.equal(interop.parseDoc(text).html, '<p>x</p>');
  assert.equal(interop.parseDoc('').html, '<p><br></p>');
  assert.throws(() => interop.parseDoc('{"format":"something-else"}'), /not an RDoc/);
});

test('Markdown round trip', () => {
  const md = '# Title\n\nSome **bold** and *italic* with `code` and [a link](https://example.com).\n\n- one\n- two\n   - nested\n\n1. first\n2. second\n\n> quoted\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\nconst x = 1;\n```\n';
  const html = interop.sanitizeHtml(interop.markdownToHtml(md), DOMParser);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<table>/);
  const back = interop.htmlToMarkdown(html, DOMParser);
  for (const piece of ['# Title', '**bold**', '*italic*', '`code`', '[a link](https://example.com)', '- one', '   - nested', '1. first', '> quoted', '| A | B |', '```\nconst x = 1;\n```']) {
    assert.ok(back.includes(piece), `missing ${JSON.stringify(piece)} in:\n${back}`);
  }
  assert.doesNotMatch(interop.markdownToHtml('<script>x</script><SCRIPT>y</SCRIPT>'), /<script/i);
  // Pipes and backslashes in table cells survive the trip.
  const tricky = interop.htmlToMarkdown('<table><tr><th>a|b</th><th>c\\d</th></tr><tr><td>1</td><td>2</td></tr></table>', DOMParser);
  assert.match(tricky, /\| a\\\|b \| c\\\\d \|/);
  assert.match(interop.markdownToHtml(tricky), /<th>a\|b<\/th><th>c\\d<\/th>/);
});

test('Word (.docx) round trip', async () => {
  const buf = await interop.htmlToDocx(SAMPLE_HTML, deps);
  assert.equal(Buffer.from(buf).subarray(0, 2).toString(), 'PK'); // a zip
  const html = await interop.docxToHtml(buf, deps);
  assert.match(html, /<h1>Quarterly plan<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<a [^>]*href="https:\/\/example\.com\/x"[^>]*>a link<\/a>/);
  assert.match(html, /<ul><li>Ship <strong>RDocs<\/strong><\/li><li>Import Word files<\/li><\/ul>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<table>.*Laptop.*1200.*<\/table>/);
});

test('OpenDocument text (.odt) round trip', async () => {
  const bytes = await interop.htmlToOdt(SAMPLE_HTML, deps);
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), 'application/vnd.oasis.opendocument.text');
  assert.equal(Buffer.from(bytes).subarray(30, 38).toString(), 'mimetype'); // first entry, stored
  const html = await interop.odtToHtml(bytes, deps);
  assert.match(html, /<h1>Quarterly plan<\/h1>/);
  assert.match(html, /<p style="text-align: center">/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<u>underline<\/u>/);
  assert.match(html, /<a [^>]*href="https:\/\/example\.com\/x"[^>]*>a link<\/a>/);
  assert.match(html, /<ul><li>Ship <strong>RDocs<\/strong><\/li>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<table>.*Laptop.*1200.*<\/table>/);
});

test('pictures survive Word and ODT round trips', async () => {
  // 1x1 transparent PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const html = `<p>Logo: <img src="data:image/png;base64,${png}" alt="logo"></p>`;
  const fromDocx = await interop.docxToHtml(await interop.htmlToDocx(html, deps), deps);
  assert.match(fromDocx, /<img src="data:image\/png;base64,/);
  const fromOdt = await interop.odtToHtml(await interop.htmlToOdt(html, deps), deps);
  assert.match(fromOdt, /<img src="data:image\/png;base64,/);
});

test('formulas convert between Excel and OpenDocument syntax', () => {
  const cases = [
    ['=SUM(A1:B2)', 'of:=SUM([.A1:.B2])'],
    ['=A1+B$2*2', 'of:=[.A1]+[.B$2]*2'],
    ["=SUM('Sheet 2'!A1:A3, Totals!B1)", "of:=SUM([$'Sheet 2'.A1:.A3]; [$Totals.B1])"],
    ['=IF(A1>10,"big, really","A1")', 'of:=IF([.A1]>10;"big, really";"A1")'],
    ['=LOG10(A2)', 'of:=LOG10([.A2])'],
  ];
  for (const [rdrive, odf] of cases) {
    assert.equal(interop.formulaToOdf(rdrive), odf);
    assert.equal(interop.formulaFromOdf(odf), rdrive);
  }
});

function sampleWorkbook() {
  return {
    format: 'rdrive-sheet',
    version: 1,
    activeSheet: 0,
    sheets: [
      {
        name: 'Budget',
        rows: 50,
        cols: 16,
        colWidths: { 0: 140 },
        frozenRows: 1,
        cells: {
          A1: { v: 'Item', b: 1, bg: '#e3f2fd' },
          B1: { v: 'Cost', b: 1, align: 'right' },
          A2: { v: 'Laptop' },
          B2: { v: 1200, fmt: 'currency' },
          A3: { v: 'Phone', i: 1 },
          B3: { v: 800, fmt: 'currency' },
          A4: { v: 'Total', u: 1 },
          B4: { v: '=SUM(B2:B3)', fmt: 'currency' },
          C4: { v: '=B4/Rates!A1', fmt: 'percent' },
        },
      },
      { name: 'Rates', rows: 50, cols: 16, colWidths: {}, frozenRows: 0, cells: { A1: { v: 4000 } } },
    ],
  };
}

function assertSampleSurvived(wb) {
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Budget', 'Rates']);
  const c = wb.sheets[0].cells;
  assert.equal(c.A1.v, 'Item');
  assert.equal(c.A1.b, 1);
  assert.equal(c.A1.bg, '#e3f2fd');
  assert.equal(c.B1.align, 'right');
  assert.equal(c.B2.v, 1200);
  assert.equal(c.B2.fmt, 'currency');
  assert.equal(c.A3.i, 1);
  assert.equal(c.A4.u, 1);
  assert.equal(c.B4.v, '=SUM(B2:B3)');
  assert.equal(c.C4.v, '=B4/Rates!A1');
  assert.equal(c.C4.fmt, 'percent');
  assert.equal(wb.sheets[1].cells.A1.v, 4000);
  // And the formulas still calculate in RDrive Sheets.
  const values = sheets.evaluateWorkbook(wb);
  assert.equal(values[0].get('B4'), 2000);
  assert.equal(values[0].get('C4'), 0.5);
}

test('Excel (.xlsx) round trip keeps values, formulas, styles and sheets', async () => {
  const buf = await interop.workbookToXlsx(sampleWorkbook(), deps);
  // What Excel/Google Sheets will see before recalculating: formula plus cached result.
  const check = new ExcelJS.Workbook();
  await check.xlsx.load(buf);
  assert.deepEqual(check.getWorksheet('Budget').getCell('B4').value, { formula: 'SUM(B2:B3)', result: 2000 });
  assert.equal(check.getWorksheet('Budget').getColumn(1).width, 20);
  const wb = await interop.xlsxToWorkbook(buf, deps);
  assertSampleSurvived(wb);
  assert.equal(wb.sheets[0].frozenRows, 1);
});

test('OpenDocument spreadsheet (.ods) round trip keeps values, formulas, styles and sheets', async () => {
  const bytes = await interop.workbookToOds(sampleWorkbook(), deps);
  const zip = await JSZip.loadAsync(bytes);
  assert.equal(await zip.file('mimetype').async('string'), 'application/vnd.oasis.opendocument.spreadsheet');
  const content = await zip.file('content.xml').async('string');
  assert.match(content, /table:formula="of:=SUM\(\[\.B2:\.B3\]\)"[^>]*office:value="2000"/);
  const back = await interop.odsToWorkbook(bytes, deps);
  assertSampleSurvived(back);
  assert.equal(back.sheets[0].colWidths[0], 140);
});

test('ODS reader handles LibreOffice-style repeated rows and columns without blowing up', async () => {
  const xml =
    '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet>' +
    '<table:table table:name="Data"><table:table-row><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16383"/></table:table-row>' +
    '<table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>';
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  zip.file('content.xml', xml);
  const wb = await interop.odsToWorkbook(await zip.generateAsync({ type: 'uint8array' }), deps);
  assert.deepEqual(Object.keys(wb.sheets[0].cells), ['A1']);
  assert.ok(wb.sheets[0].rows < 100);
});
