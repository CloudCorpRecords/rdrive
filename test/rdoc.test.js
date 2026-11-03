const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MiniDOMParser,
  rdocToMarkdown,
  rdocToText,
  markdownToRdoc,
  appendMarkdown,
  isRdocName,
} = require('../lib/rdoc');

test('isRdocName detects .rdoc extension case-insensitively', () => {
  assert.equal(isRdocName('Notes.rdoc'), true);
  assert.equal(isRdocName('path/to/PLAN.RDOC'), true);
  assert.equal(isRdocName('doc.rdoc.txt'), false);
  assert.equal(isRdocName('sheet.rsheet'), false);
  assert.equal(isRdocName(null), false);
});

test('markdownToRdoc converts markdown into valid .rdoc structure', () => {
  const md = '# Title\n\nA paragraph with **bold** and *italic*.';
  const rdoc = markdownToRdoc(md);
  const parsed = JSON.parse(rdoc);
  assert.equal(parsed.format, 'rdrive-doc');
  assert.equal(parsed.version, 1);
  assert.ok(parsed.html.includes('<h1>Title</h1>'));
  assert.ok(parsed.html.includes('<strong>bold</strong>'));
  assert.ok(parsed.html.includes('<em>italic</em>'));
});

test('rdocToMarkdown round-trips markdown structures via MiniDOMParser', () => {
  const md = [
    '# Main Title',
    '',
    'Intro paragraph with **bold**, *italic*, `inline code` and [a link](https://example.com).',
    '',
    '## Section 2',
    '',
    '> A helpful blockquote.',
    '',
    '- First bullet',
    '- Second bullet',
    '',
    '1. First ordered',
    '2. Second ordered',
    '',
    '| Key | Value |',
    '| --- | --- |',
    '| Port | 8443 |',
    '| Host | 127.0.0.1 |',
  ].join('\n');

  const rdoc = markdownToRdoc(md);
  const out = rdocToMarkdown(rdoc);
  assert.ok(out.includes('# Main Title'));
  assert.ok(out.includes('## Section 2'));
  assert.ok(out.includes('**bold**'));
  assert.ok(out.includes('*italic*'));
  assert.ok(out.includes('`inline code`'));
  assert.ok(out.includes('[a link](https://example.com)'));
  assert.ok(out.includes('> A helpful blockquote.'));
  assert.ok(out.includes('- First bullet'));
  assert.ok(out.includes('1. First ordered'));
  assert.ok(out.includes('| Key | Value |'));
  assert.ok(out.includes('| Port | 8443 |'));
});

test('appendMarkdown appends new sections to existing rdoc', () => {
  const initial = markdownToRdoc('# Original\n\nExisting text.');
  const appended = appendMarkdown(initial, '## Additional\n\nAppended text.');
  const md = rdocToMarkdown(appended);
  assert.ok(md.includes('# Original'));
  assert.ok(md.includes('Existing text.'));
  assert.ok(md.includes('## Additional'));
  assert.ok(md.includes('Appended text.'));
});

test('rdocToText produces readable plain text', () => {
  const rdoc = markdownToRdoc('# Header\n\nText with [link](https://test.com) & symbols <tag>.');
  const txt = rdocToText(rdoc);
  assert.ok(txt.includes('Header'));
  assert.ok(txt.includes('Text with link'));
});

test('MiniDOMParser handles entity decoding and DOM methods', () => {
  const parser = new MiniDOMParser();
  const doc = parser.parseFromString('<body><p id="p1">Hello &amp; &quot;world&quot; &#39;test&#39;</p></body>');
  const body = doc.body;
  assert.equal(body.childNodes.length, 1);
  const p = body.childNodes[0];
  assert.equal(p.tagName, 'P');
  assert.equal(p.getAttribute('id'), 'p1');
  assert.equal(p.textContent, 'Hello & "world" \'test\'');

  const cloned = p.cloneNode();
  assert.equal(cloned.tagName, 'P');
  assert.equal(cloned.getAttribute('id'), 'p1');
  assert.equal(cloned.textContent, 'Hello & "world" \'test\'');

  const matches = body.querySelectorAll('p');
  assert.equal(matches.length, 1);
  assert.equal(matches[0], p);

  p.remove();
  assert.equal(body.childNodes.length, 0);
});
