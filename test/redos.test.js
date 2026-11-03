'use strict';
// Regression tests for the two CodeQL ReDoS alerts fixed alongside this file:
//  - alert 15 (js/redos): lib/rdoc.js TOKEN/ATTR tokenizer regexes. The old
//    unquoted-value class [^\s>]+ also matched a leading quote, so a value like
//    "" could be repartitioned exponentially many ways on malformed tags.
//  - alert 16 (js/polynomial-redos): lib/ai_service.js PATTERNS.phone. The old
//    pattern opened with an optional country code plus an unbounded separator
//    run, so every position in a long run of spaces retried the whole run:
//    O(n^2) on separator-heavy cell text.
// Both fixes keep behavior on well-formed input (batteries below pin that);
// only malformed/adversarial shapes change, from "hangs" to "fails fast".
const test = require('node:test');
const assert = require('node:assert');
const { MiniDOMParser } = require('../lib/rdoc');
const { localExtract } = require('../lib/ai_service');

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('rdoc tokenizer: CodeQL witness shapes finish fast', () => {
  const parser = new MiniDOMParser();
  const witnesses = [
    '<A !=' + '"" !='.repeat(24), // the alert's own witness shape
    "<A !=" + "'' !=".repeat(24),
    '<A b=' + '"x" != '.repeat(24),
    '<A ' + 'q="1" '.repeat(24) + '!',
  ];
  for (const html of witnesses) {
    const { ms } = timed(() => parser.parseFromString(html));
    assert.ok(ms < 1000, `witness took ${ms.toFixed(1)}ms: ${html.slice(0, 40)}...`);
  }
});

test('rdoc tokenizer: attribute forms parse exactly as before', () => {
  const parser = new MiniDOMParser();
  const doc = parser.parseFromString(
    '<p id="p1" class=\'a b\' data-n=42 hidden title="has > bracket">Hi &amp; bye</p>'
  );
  const p = doc.body.childNodes[0];
  assert.equal(p.tagName, 'P');
  assert.equal(p.getAttribute('id'), 'p1');
  assert.equal(p.getAttribute('class'), 'a b');
  assert.equal(p.getAttribute('data-n'), '42');
  assert.equal(p.getAttribute('hidden'), '');
  assert.equal(p.getAttribute('title'), 'has > bracket');
  assert.equal(p.textContent, 'Hi & bye');
});

test('ai_service phone pattern: long separator runs finish fast', () => {
  const spaces = 'call me' + ' '.repeat(40000) + 'later';
  const { out, ms } = timed(() => localExtract('phone', spaces));
  assert.equal(out, '');
  assert.ok(ms < 1000, `space-run extraction took ${ms.toFixed(1)}ms`);
});

test('ai_service phone pattern: realistic numbers extract exactly as before', () => {
  const cases = [
    ['My mobile number is 415-555-0199 call anytime', '415-555-0199'],
    ['Call +1 415-555-0199 today', '+1 415-555-0199'],
    ['Call +1 (415) 555-0199 today', '+1 (415) 555-0199'],
    ['Reach us at (415) 555-0199', '(415) 555-0199'],
    ['phone: 415.555.0199', '415.555.0199'],
    ['415 555 0199', '415 555 0199'],
    ['1-415-555-0199', '1-415-555-0199'],
    ['+14155550199', '+14155550199'],
    ['Call 415 - 555 - 0199 now', '415 - 555 - 0199'],
    ['Nothing to extract', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(localExtract('phone', input), expected, `input: ${input}`);
  }
});
