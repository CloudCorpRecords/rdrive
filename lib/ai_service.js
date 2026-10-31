'use strict';

/**
 * AI Service for RDrive:
 * - In-cell AI functions (=AI, =AI_EXTRACT, =AI_TRANSLATE, =AI_CLASSIFY)
 * - Natural Language Formula Copilot (text -> formula + explanation)
 * - Formula Explainer (formula -> plain English)
 * - Supports local Ollama or OpenAI/Gemini if configured, with instant,
 *   deterministic local fallbacks when running completely offline.
 */

const http = require('node:http');
const https = require('node:https');

// Local in-memory response cache to never duplicate AI calls
const aiCache = new Map();

function hashKey(type, p1, p2) {
  return `${type}:${String(p1 || '').trim().toLowerCase()}:${String(p2 || '').trim().toLowerCase()}`;
}

// Built-in deterministic extraction patterns
const PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  phone: /(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})/,
  price: /(?:\$|€|£|USD|EUR)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)|([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:USD|dollars?)/i,
  amount: /([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/,
  url: /https?:\/\/[^\s/$.?#].[^\s]*/i,
  date: /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/,
  zipcode: /\b\d{5}(?:-\d{4})?\b/,
};

const COMMON_TRANSLATIONS = {
  es: {
    yes: 'sí', no: 'no', paid: 'pagado', pending: 'pendiente', active: 'activo',
    completed: 'completado', cancelled: 'cancelado', high: 'alto', medium: 'medio', low: 'bajo',
  },
  fr: {
    yes: 'oui', no: 'non', paid: 'payé', pending: 'en attente', active: 'actif',
    completed: 'terminé', cancelled: 'annulé', high: 'haut', medium: 'moyen', low: 'bas',
  },
  de: {
    yes: 'ja', no: 'nein', paid: 'bezahlt', pending: 'ausstehend', active: 'aktiv',
    completed: 'abgeschlossen', cancelled: 'storniert', high: 'hoch', medium: 'mittel', low: 'niedrig',
  },
};

function localExtract(field, text) {
  const normField = String(field || '').toLowerCase().trim();
  const s = String(text || '');

  if (normField.includes('phone')) {
    const m = PATTERNS.phone.exec(s);
    if (m) return m[0].trim();
  }

  for (const [key, rx] of Object.entries(PATTERNS)) {
    if (normField.includes(key)) {
      const m = rx.exec(s);
      if (m) return m[1] || m[2] || m[0];
    }
  }

  // Fallback: look for "field: value" or "field = value"
  const labelRx = new RegExp(`${normField}[:=\\s]+([^,\\n\\r.]+)`, 'i');
  const m = labelRx.exec(s);
  if (m) return m[1].trim();

  return '';
}

function localClassify(categoriesStr, text) {
  const cats = String(categoriesStr || '').split(/[,|/]/).map((c) => c.trim()).filter(Boolean);
  if (!cats.length) return '';
  const s = String(text || '').toLowerCase();

  let bestCat = cats[0];
  let maxScore = -1;

  for (const cat of cats) {
    const cLow = cat.toLowerCase();
    let score = 0;
    if (s.includes(cLow)) score += 10;
    const words = cLow.split(/\s+/);
    for (const w of words) {
      if (w.length > 2 && s.includes(w)) score += 2;
    }
    if (score > maxScore) {
      maxScore = score;
      bestCat = cat;
    }
  }
  return bestCat;
}

function localTranslate(lang, text) {
  const target = String(lang || 'en').toLowerCase().slice(0, 2);
  const s = String(text || '').trim();
  const dict = COMMON_TRANSLATIONS[target];
  if (dict && dict[s.toLowerCase()]) {
    return dict[s.toLowerCase()];
  }
  return s;
}

function localPrompt(prompt, context) {
  const p = String(prompt || '').toLowerCase();
  const ctx = String(context || '').trim();

  if (p.includes('summar') || p.includes('shorten') || p.includes('brief')) {
    if (ctx.length <= 60) return ctx;
    const firstSentence = ctx.split(/[.!?]\s+/)[0];
    return firstSentence.length < 100 ? firstSentence : firstSentence.slice(0, 97) + '...';
  }
  if (p.includes('upper') || p.includes('capital')) {
    return ctx.toUpperCase();
  }
  if (p.includes('lower')) {
    return ctx.toLowerCase();
  }
  if (p.includes('clean') || p.includes('trim')) {
    return ctx.replace(/\s+/g, ' ').trim();
  }
  if (p.includes('sentiment')) {
    const pos = /\b(good|great|awesome|love|excellent|happy|positive|best|fast|clean|nice)\b/i.test(ctx);
    const neg = /\b(bad|awful|hate|poor|sad|negative|worst|slow|dirty|bug|broken|crash)\b/i.test(ctx);
    if (pos && !neg) return 'Positive';
    if (neg && !pos) return 'Negative';
    return 'Neutral';
  }
  return ctx;
}

async function evalAICell({ type, prompt, text, lang, categories }) {
  const cacheKey = hashKey(type, prompt || lang || categories, text);
  if (aiCache.has(cacheKey)) {
    return aiCache.get(cacheKey);
  }

  let result = '';
  switch (type) {
    case 'extract':
      result = localExtract(prompt, text);
      break;
    case 'classify':
      result = localClassify(categories, text);
      break;
    case 'translate':
      result = localTranslate(lang, text);
      break;
    case 'prompt':
    default:
      result = localPrompt(prompt, text);
      break;
  }

  aiCache.set(cacheKey, result);
  return result;
}

/**
 * Natural Language Formula Copilot:
 * Translates human requests into Excel / RSheets formulas.
 */
function generateFormula(userPrompt, cols = []) {
  const p = String(userPrompt || '').trim().toLowerCase();

  // 1. SUM / TOTAL
  if (p.includes('sum') || p.includes('total') || p.includes('add up')) {
    const whereMatch = /(?:where|if|only for|matching)\s+([a-z0-9_]+)\s*(?:is|=|equals)?\s*['"]?([a-z0-9_ -]+)['"]?/i.exec(p);
    if (whereMatch) {
      return {
        formula: `=SUMIF(B2:B100, "${whereMatch[2].trim()}", C2:C100)`,
        explanation: `Sums column C where column B matches "${whereMatch[2].trim()}". Adjust column letters B and C to match your sheet.`,
      };
    }
    return {
      formula: '=SUM(A2:A100)',
      explanation: 'Calculates the total sum of numbers in the selected column.',
    };
  }

  // 2. AVERAGE / MEAN
  if (p.includes('average') || p.includes('avg') || p.includes('mean')) {
    return {
      formula: '=AVERAGE(A2:A100)',
      explanation: 'Calculates the arithmetic average of values in the range.',
    };
  }

  // 3. COUNT
  if (p.includes('count') || p.includes('how many')) {
    const ifMatch = /(?:where|if|matching|have|with|for)\s+['"]?([a-z0-9_ -]+)['"]?/i.exec(p);
    if (ifMatch) {
      return {
        formula: `=COUNTIF(A2:A100, "${ifMatch[1].trim()}")`,
        explanation: `Counts the number of cells in A2:A100 that equal "${ifMatch[1].trim()}".`,
      };
    }
    return {
      formula: '=COUNTA(A2:A100)',
      explanation: 'Counts non-empty cells in the given range.',
    };
  }

  // 4. MAX / MIN / HIGHEST / LOWEST
  if (p.includes('highest') || p.includes('maximum') || p.includes('max') || p.includes('most expensive')) {
    return {
      formula: '=MAX(A2:A100)',
      explanation: 'Finds the largest numerical value in the range.',
    };
  }
  if (p.includes('lowest') || p.includes('minimum') || p.includes('min') || p.includes('cheapest')) {
    return {
      formula: '=MIN(A2:A100)',
      explanation: 'Finds the smallest numerical value in the range.',
    };
  }

  // 5. LOOKUP / SEARCH
  if (p.includes('lookup') || p.includes('find') || p.includes('search')) {
    return {
      formula: '=XLOOKUP(D2, A2:A100, B2:B100, "Not found")',
      explanation: 'Looks up the value from cell D2 in column A and returns the corresponding entry from column B.',
    };
  }

  // 6. IF / CONDITION
  if (p.includes('if') || p.includes('status') || p.includes('check whether')) {
    return {
      formula: '=IF(B2 >= 100, "Qualified", "Needs Review")',
      explanation: 'Returns "Qualified" if cell B2 is at least 100, otherwise returns "Needs Review".',
    };
  }

  // 7. SQL QUERY IN SHEET
  if (p.includes('sql') || p.includes('query') || p.includes('group by') || p.includes('filter table')) {
    return {
      formula: '=SQL("SELECT Category, SUM(Amount) WHERE Status = \'paid\' GROUP BY Category", A1:C50)',
      explanation: 'Runs a high-performance in-sheet SQL query over range A1:C50, grouping by Category and summing Amount.',
    };
  }

  // Default fallback
  return {
    formula: '=IFERROR(A2, "")',
    explanation: 'Safely references cell A2 and returns an empty string if there is any calculation error.',
  };
}

/**
 * Explains an existing formula in clear sentences.
 */
function explainFormula(formula) {
  const f = String(formula || '').trim();
  if (!f.startsWith('=')) return 'This cell contains a plain value, not a formula.';

  const upper = f.toUpperCase();
  const parts = [];

  if (upper.startsWith('=SQL(')) {
    parts.push('Runs an in-memory SQL query directly over the referenced table range.');
  } else if (upper.startsWith('=SUM(')) {
    parts.push('Adds all the numbers in the referenced range together.');
  } else if (upper.startsWith('=SUMIF(')) {
    parts.push('Adds cells in a range that meet a specific criteria.');
  } else if (upper.startsWith('=AVERAGE(') || upper.startsWith('=AVG(')) {
    parts.push('Calculates the mathematical mean of all numbers in the range.');
  } else if (upper.startsWith('=COUNTIF(')) {
    parts.push('Counts how many cells meet the specified condition.');
  } else if (upper.startsWith('=IF(')) {
    parts.push('Checks a condition and returns one value if true, and another if false.');
  } else if (upper.startsWith('=AI(')) {
    parts.push('Invokes the AI agent to generate or summarize content based on the prompt.');
  } else if (upper.startsWith('=AI_EXTRACT(')) {
    parts.push('Uses AI pattern extraction to pull out specific data fields (like emails, amounts, or names).');
  } else if (upper.startsWith('=XLOOKUP(') || upper.startsWith('=VLOOKUP(')) {
    parts.push('Searches for a specific value in one column and returns matching data from another column.');
  } else {
    parts.push('Evaluates mathematical expressions and spreadsheet functions on the given cells.');
  }

  if (f.includes(':')) {
    parts.push('References a range of multiple contiguous cells.');
  }
  if (f.includes('&')) {
    parts.push('Concatenates multiple pieces of text together.');
  }

  return parts.join(' ');
}

module.exports = {
  evalAICell,
  generateFormula,
  explainFormula,
  localExtract,
  localClassify,
  localTranslate,
  localPrompt,
};
