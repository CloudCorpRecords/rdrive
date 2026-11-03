'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  evalAICell,
  generateFormula,
  explainFormula,
  localExtract,
  localClassify,
  localTranslate,
  localPrompt,
} = require('../lib/ai_service');

test('ai service: pattern extraction, classification, and translation', () => {
  // Extract
  assert.strictEqual(localExtract('email', 'Send invoice to alex@company.com please'), 'alex@company.com');
  assert.strictEqual(localExtract('phone', 'My mobile number is 415-555-0199 call anytime'), '415-555-0199');
  assert.strictEqual(localExtract('price', 'Total amount: EUR 89.50 with tax'), '89.50');

  // Classify
  assert.strictEqual(localClassify('Billing, Technical Support, General Inquiry', 'My card was charged twice'), 'Billing');
  assert.strictEqual(localClassify('Bug, Feature Request, Question', 'The app crashes on launch'), 'Bug');

  // Translate
  assert.strictEqual(localTranslate('es', 'paid'), 'pagado');
  assert.strictEqual(localTranslate('fr', 'yes'), 'oui');

  // Prompt / Sentiment
  assert.strictEqual(localPrompt('sentiment', 'This drive is remarkably fast and easy to use!'), 'Positive');
  assert.strictEqual(localPrompt('sentiment', 'Horrible broken mess with so many bugs'), 'Negative');
});

test('ai formula copilot: natural language to formulas and plain english explanations', () => {
  // 1. Sum / Sumif
  const sumif = generateFormula('sum of sales where status is paid');
  assert.ok(sumif.formula.startsWith('=SUMIF('));
  assert.ok(sumif.explanation.includes('paid'));

  // 2. Average
  const avg = generateFormula('calculate average revenue');
  assert.ok(avg.formula.startsWith('=AVERAGE('));

  // 3. Count
  const count = generateFormula('count how many rows have active');
  assert.ok(count.formula.startsWith('=COUNTIF('));

  // 4. In-Sheet SQL
  const sql = generateFormula('run sql query to group by category');
  assert.ok(sql.formula.startsWith('=SQL('));

  // 5. Formula Explainer
  const expSql = explainFormula('=SQL("SELECT SUM(Amount)", A1:B10)');
  assert.ok(expSql.includes('SQL query'));

  const expSum = explainFormula('=SUM(B2:B20)');
  assert.ok(expSum.includes('Adds all the numbers'));
});
