// RDocs on the server: .rdoc <-> Markdown, for AI agents (MCP) and ".md" share links.
// Stored .rdoc HTML only ever contains the allowlisted tags public/interop.js's sanitizer produces, so a
// tiny parser is enough to give interop.htmlToMarkdown the few DOM methods it uses, without a runtime
// dependency on a full DOM implementation.
const interop = require('../public/interop');

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

class MiniNode {
  constructor(type, tag, value) {
    this.nodeType = type; // 1 element, 3 text
    this.tagName = tag ? tag.toUpperCase() : undefined;
    this.nodeValue = type === 3 ? value : null;
    this.attrs = {};
    this.childNodes = [];
    this.parentNode = null;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get textContent() {
    return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join('');
  }

  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  appendChild(n) {
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }

  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    this.parentNode = null;
  }

  cloneNode() {
    const c = new MiniNode(this.nodeType, this.tagName, this.nodeValue);
    c.attrs = { ...this.attrs };
    for (const ch of this.childNodes) c.appendChild(ch.cloneNode(true));
    return c;
  }

  querySelectorAll(tag) {
    const want = String(tag).toUpperCase();
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (c.tagName === want) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)|</g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parse(html) {
  const body = new MiniNode(1, 'body');
  const stack = [body];
  const top = () => stack[stack.length - 1];
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(html))) {
    if (m[4] !== undefined) top().appendChild(new MiniNode(3, null, decode(m[4])));
    else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (tag === 'html' || tag === 'body' || tag === 'head') continue;
      const el = new MiniNode(1, tag);
      let a;
      ATTR.lastIndex = 0;
      while ((a = ATTR.exec(m[3] || ''))) el.attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      top().appendChild(el);
      if (!VOID.has(tag)) stack.push(el);
    } else if (m[1]) {
      const tag = m[1].toUpperCase();
      // Close the nearest matching element (tolerates the odd missing close tag).
      const i = stack.map((n) => n.tagName).lastIndexOf(tag);
      if (i > 0) stack.length = i;
    } else if (m[0] === '<') top().appendChild(new MiniNode(3, null, '<'));
  }
  return body;
}

// Stands in for the browser DOMParser in interop.htmlToMarkdown / htmlToText.
class MiniDOMParser {
  parseFromString(html) {
    const inner = String(html).replace(/^[\s\S]*?<body>/i, '').replace(/<\/body>[\s\S]*$/i, '');
    return { body: parse(inner) };
  }
}

function rdocToMarkdown(text) {
  return interop.htmlToMarkdown(interop.parseDoc(text).html, MiniDOMParser);
}

function rdocToText(text) {
  return interop.htmlToText(interop.parseDoc(text).html, MiniDOMParser);
}

// Markdown -> .rdoc file contents. markdownToHtml escapes any raw HTML in the input, and the
// editor sanitizes again whenever a document is opened.
function markdownToRdoc(md) {
  return interop.serializeDoc(interop.markdownToHtml(String(md || '')) || '<p><br></p>');
}

function appendMarkdown(rdocText, md) {
  const doc = interop.parseDoc(rdocText);
  const html = (doc.html === '<p><br></p>' ? '' : doc.html) + interop.markdownToHtml(String(md || ''));
  return interop.serializeDoc(html || '<p><br></p>');
}

function isRdocName(name) {
  return /\.rdoc$/i.test(String(name || ''));
}

module.exports = { MiniDOMParser, rdocToMarkdown, rdocToText, markdownToRdoc, appendMarkdown, isRdocName };
