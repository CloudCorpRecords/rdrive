'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { executeSQL } = require('../lib/sql_engine');
const { parseDelimited, serializeDelimited, newEmptySheet } = require('../public/sheet');

test('in-memory SQL engine: basic queries, filters, and aggregations', () => {
  const table = [
    ['Product', 'Category', 'Price', 'Stock', 'Active'],
    ['Laptop', 'Electronics', 1200, 15, true],
    ['Phone', 'Electronics', 800, 40, true],
    ['Desk', 'Furniture', 350, 8, true],
    ['Chair', 'Furniture', 150, 0, false],
    ['Monitor', 'Electronics', 300, 25, true],
  ];

  // 1. Scalar SUM
  const totalElectronics = executeSQL("SELECT SUM(Price) WHERE Category = 'Electronics'", table);
  assert.strictEqual(totalElectronics, 2300);

  // 2. Scalar COUNT
  const inStockCount = executeSQL('SELECT COUNT(*) WHERE Stock > 0', table);
  assert.strictEqual(inStockCount, 4);

  // 3. Scalar AVG
  const avgFurniture = executeSQL("SELECT AVG(Price) WHERE Category = 'Furniture'", table);
  assert.strictEqual(avgFurniture, 250);

  // 4. GROUP BY
  const grouped = executeSQL('SELECT Category, SUM(Price) AS TotalPrice GROUP BY Category ORDER BY TotalPrice DESC', table);
  assert.strictEqual(grouped.length, 2);
  assert.strictEqual(grouped[0].Category, 'Electronics');
  assert.strictEqual(grouped[0].TotalPrice, 2300);
  assert.strictEqual(grouped[1].Category, 'Furniture');
  assert.strictEqual(grouped[1].TotalPrice, 500);

  // 5. WHERE with LIKE and boolean
  const laptop = executeSQL("SELECT Product WHERE Product LIKE 'Lap%' AND Active = true", table);
  assert.strictEqual(laptop, 'Laptop');
});

test('RSheets formula evaluation with =SQL and =AI functions', () => {
  // Mock workbook
  const workbook = {
    sheets: [
      {
        name: 'Sheet 1',
        cells: {
          A1: { v: 'Department' },
          B1: { v: 'Expense' },
          C1: { v: 'Status' },
          A2: { v: 'Dev' },
          B2: { v: 500 },
          C2: { v: 'paid' },
          A3: { v: 'Design' },
          B3: { v: 300 },
          C3: { v: 'pending' },
          A4: { v: 'Dev' },
          B4: { v: 700 },
          C4: { v: 'paid' },
          // Formulas:
          D1: { v: '=SQL("SELECT SUM(Expense) WHERE Status = \'paid\'", A1:C4)' },
          D2: { v: '=SQL("SELECT AVG(Expense) WHERE Department = \'Dev\'", A1:C4)' },
          D3: { v: '=AI_EXTRACT("email", "Contact: test@rdrive.io")' },
          D4: { v: '=AI_CLASSIFY("The app crashed", "Bug, Feature, Question")' },
        },
      },
    ],
    activeSheet: 0,
  };

  const { evaluateWorkbook } = require('../public/sheet');
  const evaluated = evaluateWorkbook(workbook);
  const sheetEval = evaluated[0];

  assert.strictEqual(sheetEval.get('D1'), 1200, 'SUM of paid expenses should be 1200');
  assert.strictEqual(sheetEval.get('D2'), 600, 'AVG of Dev expenses should be 600');
  assert.strictEqual(sheetEval.get('D3'), 'test@rdrive.io', 'AI_EXTRACT should extract email');
  assert.strictEqual(sheetEval.get('D4'), 'Bug', 'AI_CLASSIFY should classify as Bug');
});
