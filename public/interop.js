'use strict';

// RDrive interoperability: converts RDocs (.rdoc) and RDrive Sheets (.rsheet) to and from the
// formats other office apps use (Word .docx, OpenDocument .odt/.ods, Excel .xlsx, Markdown, HTML,
// plain text). Pure functions: the format libraries and a DOMParser are passed in, so the same code
// runs in the browser (libraries loaded on demand from /vendor) and in Node (for the tests).
(function () {
  const DOC_FORMAT = 'rdrive-doc';
  const SHEET_DEFAULT_ROWS = 50;
  const SHEET_DEFAULT_COLS = 16;

  // ===================================================================================
  // Shared helpers
  // ===================================================================================

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function colToLetter(col) {
    let s = '';
    let n = col + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function letterToCol(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function parseKey(key) {
    const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(key);
    return m ? { c: letterToCol(m[1]), r: Number(m[2]) - 1 } : null;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('Expected binary data.');
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // "data:image/png;base64,..." -> { mime, ext, bytes } (only real image types).
  function parseDataImage(src) {
    const m = /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(src || ''));
    if (!m) return null;
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    return { mime: `image/${ext === 'jpg' ? 'jpeg' : ext}`, ext, bytes: base64ToBytes(m[2].replace(/\s/g, '')) };
  }

  // Pixel size from the image header, so exported documents keep the picture's proportions.
  function imageSize(bytes) {
    const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { w: u32(16), h: u32(20) }; // PNG
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return { w: bytes[6] | (bytes[7] << 8), h: bytes[8] | (bytes[9] << 8) }; // GIF
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      // JPEG: find a start-of-frame marker
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = bytes[i + 1];
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
        }
        i += 2 + len;
      }
    }
    return { w: 400, h: 300 };
  }

  function fitImage(size, maxW = 600) {
    const w = size.w || 400;
    const h = size.h || 300;
    if (w <= maxW) return { w, h };
    return { w: maxW, h: Math.round((h * maxW) / w) };
  }

  // ===================================================================================
  // RDocs: model and HTML sanitizer
  // ===================================================================================

  // An .rdoc file is JSON: { format: "rdrive-doc", version: 1, html: "<p>…</p>" }.
  // The html only ever contains the allowlisted tags below; it is sanitized on load, paste,
  // import and save, so shared documents can't carry scripts or tracking pixels.
  const ALLOWED = {
    p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
    strong: [], em: [], u: [], s: [], sub: [], sup: [], code: [], mark: [],
    a: ['href'], br: [], hr: [],
    ul: [], ol: [], li: [],
    blockquote: [], pre: [],
    table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
    img: ['src', 'alt', 'width', 'height'],
  };
  const RENAME = { b: 'strong', i: 'em', strike: 's', del: 's', ins: 'u', tt: 'code', kbd: 'code', samp: 'code' };
  const DROP_WITH_CONTENT = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'head', 'title', 'meta', 'link', 'svg', 'math', 'button', 'select', 'textarea', 'input', 'form']);
  const ALIGNABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th']);

  function emptyDoc() {
    return { format: DOC_FORMAT, version: 1, html: '<p><br></p>' };
  }

  function parseDoc(text) {
    if (!String(text || '').trim()) return emptyDoc();
    const data = JSON.parse(text);
    if (!data || data.format !== DOC_FORMAT || typeof data.html !== 'string') throw new Error('This is not an RDoc file.');
    return { format: DOC_FORMAT, version: 1, html: data.html };
  }

  function serializeDoc(html) {
    return JSON.stringify({ format: DOC_FORMAT, version: 1, html }, null, 2);
  }

  function safeHref(href) {
    const h = String(href || '').trim();
    if (/^(https?:|mailto:)/i.test(h) || h.startsWith('#')) return h;
    return null;
  }

  function parseHtml(html, DOMParserImpl) {
    const P = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!P) throw new Error('No DOMParser available.');
    return new P().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  }

  // Rebuilds the document from scratch, copying only allowlisted elements/attributes.
  function sanitizeHtml(html, DOMParserImpl) {
    const doc = parseHtml(html, DOMParserImpl);
    const out = doc.createElement('div');

    function copyChildren(from, to) {
      for (const node of Array.from(from.childNodes)) copyNode(node, to);
    }

    function copyNode(node, to) {
      if (node.nodeType === 3) {
        to.appendChild(doc.createTextNode(node.nodeValue));
        return;
      }
      if (node.nodeType !== 1) return; // comments, processing instructions…
      let tag = node.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) return;
      tag = RENAME[tag] || tag;
      // Word/Google often express bold/italic as styled spans.
      if (tag === 'span' || tag === 'font') {
        const style = (node.getAttribute('style') || '').toLowerCase();
        let target = to;
        if (/font-weight:\s*(bold|[6-9]00)/.test(style)) target = target.appendChild(doc.createElement('strong'));
        if (/font-style:\s*italic/.test(style)) target = target.appendChild(doc.createElement('em'));
        if (/text-decoration[^;]*underline/.test(style)) target = target.appendChild(doc.createElement('u'));
        if (/text-decoration[^;]*line-through/.test(style)) target = target.appendChild(doc.createElement('s'));
        copyChildren(node, target);
        return;
      }
      if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'header' || tag === 'footer' || tag === 'main') {
        // Block wrappers: keep their content. Loose text becomes a paragraph.
        const hasBlocks = Array.from(node.children || []).some((c) => /^(p|h[1-6]|ul|ol|table|pre|blockquote|div|hr)$/i.test(c.tagName));
        if (hasBlocks) copyChildren(node, to);
        else copyChildren(node, to.appendChild(doc.createElement('p')));
        return;
      }
      if (!Object.hasOwn(ALLOWED, tag)) {
        copyChildren(node, to); // unknown wrapper: keep text, drop the tag
        return;
      }
      if (tag === 'img') {
        const img = parseDataImage(node.getAttribute('src'));
        if (!img) return; // only embedded pictures; never remote URLs (tracking pixels)
        const el = doc.createElement('img');
        el.setAttribute('src', node.getAttribute('src').replace(/\s/g, ''));
        if (node.getAttribute('alt')) el.setAttribute('alt', node.getAttribute('alt'));
        for (const dim of ['width', 'height']) {
          const v = parseInt(node.getAttribute(dim), 10);
          if (v > 0 && v < 5000) el.setAttribute(dim, String(v));
        }
        to.appendChild(el);
        return;
      }
      const el = doc.createElement(tag);
      for (const attr of ALLOWED[tag]) {
        const v = node.getAttribute(attr);
        if (v == null) continue;
        if (attr === 'href') {
          const href = safeHref(v);
          if (href) el.setAttribute('href', href);
        } else if (/^\d{1,3}$/.test(v)) {
          el.setAttribute(attr, v);
        }
      }
      if (tag === 'a') el.setAttribute('rel', 'noopener noreferrer');
      if (ALIGNABLE.has(tag)) {
        const m = /text-align:\s*(left|center|right|justify)/i.exec(node.getAttribute('style') || '') || /^(left|center|right|justify)$/i.exec(node.getAttribute('align') || '');
        if (m && m[1].toLowerCase() !== 'left') el.setAttribute('style', `text-align: ${m[1].toLowerCase()}`);
      }
      copyChildren(node, el);
      to.appendChild(el);
    }

    copyChildren(doc.body, out);
    const result = out.innerHTML.trim();
    return result || '<p><br></p>';
  }

  // ===================================================================================
  // Markdown <-> HTML
  // ===================================================================================

  function inlineMarkdown(text) {
    // Protect code spans first so their contents aren't formatted.
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    // Backslash escapes (\* \_ \| \\ …) become literal characters.
    const literals = [];
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, ch) => {
      literals.push(ch);
      return `\u0001${literals.length - 1}\u0001`;
    });
    s = escapeHtml(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    s = s.replace(/ {2,}$/g, '<br>');
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => escapeHtml(literals[Number(i)]));
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  }

  // Splits "| a | b\|c |" into cells on unescaped pipes, keeping escapes for inlineMarkdown.
  function splitTableRow(line) {
    const body = line.trim().replace(/^\|/, '');
    const cells = [];
    let cur = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && i + 1 < body.length) {
        cur += body[i] + body[i + 1];
        i++;
      } else if (body[i] === '|') {
        cells.push(cur);
        cur = '';
      } else cur += body[i];
    }
    if (cur.trim()) cells.push(cur);
    return cells.map((c) => inlineMarkdown(c.trim()));
  }

  function markdownToHtml(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const isBlank = (l) => !l.trim();
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      let m;
      if ((m = /^```/.exec(line))) {
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        out.push(`<h${m[1].length}>${inlineMarkdown(m[2])}</h${m[1].length}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = splitTableRow;
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(
          '<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
            rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>'
        );
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        out.push(parseMdList(lines, i, (next) => (i = next)));
        continue;
      }
      const para = [];
      while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s+|\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`);
    }
    return out.join('\n');
  }

  // Lists, including nesting by indentation.
  function parseMdList(lines, start, setIndex) {
    const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;
    const baseIndent = indentOf(lines[start]);
    const ordered = /^\s*\d+[.)]/.test(lines[start]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // A blank line only continues the list if the next item is the same kind (bullets vs numbers).
        const next = lines[i + 1];
        const sameKind = next && (indentOf(next) > baseIndent || /^\s*\d+[.)]\s/.test(next) === ordered);
        if (next && /^\s*([-*+]|\d+[.)])\s+/.test(next) && indentOf(next) >= baseIndent && sameKind) {
          i++;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
      if (m && ind === baseIndent && /^\d/.test(m[1]) !== ordered) break; // a different list starts here
      if (m && ind === baseIndent) {
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[2]);
        items.push({ html: task ? `${task[1].trim() ? '☑' : '☐'} ${inlineMarkdown(task[2])}` : inlineMarkdown(m[2]), children: '' });
        i++;
      } else if (ind > baseIndent && items.length) {
        if (m) {
          items[items.length - 1].children += parseMdList(lines, i, (next) => (i = next));
        } else {
          items[items.length - 1].html += '<br>' + inlineMarkdown(l.trim());
          i++;
        }
      } else {
        break;
      }
    }
    setIndex(i);
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>` + items.map((it) => `<li>${it.html}${it.children}</li>`).join('') + `</${tag}>`;
  }

  function htmlToMarkdown(html, DOMParserImpl) {
    const doc = parseHtml(html, DOMParserImpl);
    // Backslash first-class: every Markdown meta-character (including "|" for tables) is escaped in one pass.
    const esc = (t) => t.replace(/([\\`*_[\]|])/g, '\\$1');

    function inline(node) {
      let s = '';
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) {
          s += esc(n.nodeValue.replace(/\s+/g, ' '));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        const inner = inline(n);
        if (tag === 'strong' || tag === 'b') s += inner.trim() ? `**${inner}**` : inner;
        else if (tag === 'em' || tag === 'i') s += inner.trim() ? `*${inner}*` : inner;
        else if (tag === 's' || tag === 'del') s += `~~${inner}~~`;
        else if (tag === 'code') s += '`' + n.textContent + '`';
        else if (tag === 'a') s += `[${inner}](${n.getAttribute('href') || ''})`;
        else if (tag === 'br') s += '  \n';
        else if (tag === 'img') s += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`;
        else s += inner; // u, sub, sup, mark: Markdown has no syntax, keep the text
      }
      return s;
    }

    function list(node, depth) {
      const ordered = node.tagName.toLowerCase() === 'ol';
      let n = 1;
      let s = '';
      for (const li of Array.from(node.children)) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const nested = Array.from(li.children).filter((c) => /^(ul|ol)$/i.test(c.tagName));
        const clone = li.cloneNode(true);
        for (const c of Array.from(clone.children)) if (/^(ul|ol)$/i.test(c.tagName)) c.remove();
        s += `${'   '.repeat(depth)}${ordered ? `${n++}.` : '-'} ${inline(clone).trim()}\n`;
        for (const sub of nested) s += list(sub, depth + 1);
      }
      return s;
    }

    function block(node) {
      const parts = [];
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) {
          if (n.nodeValue.trim()) parts.push(esc(n.nodeValue.trim()));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) parts.push(`${'#'.repeat(Number(tag[1]))} ${inline(n).trim()}`);
        else if (tag === 'ul' || tag === 'ol') parts.push(list(n, 0).trimEnd());
        else if (tag === 'blockquote') parts.push(block(n).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n'));
        else if (tag === 'pre') parts.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```');
        else if (tag === 'hr') parts.push('---');
        else if (tag === 'table') {
          // Cell text is already escaped by inline() (which escapes "|"), so it's safe inside "| … |".
          const rows = Array.from(n.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => inline(c).trim()));
          if (rows.length) {
            const width = Math.max(...rows.map((r) => r.length));
            const pad = (r) => r.concat(Array(width - r.length).fill(''));
            parts.push([pad(rows[0]), Array(width).fill('---'), ...rows.slice(1).map(pad)].map((r) => `| ${r.join(' | ')} |`).join('\n'));
          }
        } else if (tag === 'div') parts.push(block(n));
        else {
          const text = inline(n).trim();
          if (text) parts.push(text);
        }
      }
      return parts.filter(Boolean).join('\n\n');
    }

    return block(doc.body) + '\n';
  }

  function htmlToText(html, DOMParserImpl) {
    const doc = parseHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h[1-6]|li|tr|blockquote|pre)>/gi, '\n$&'), DOMParserImpl);
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function textToHtml(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function htmlDocument(title, html) {
    return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n<style>body{font:16px/1.6 Georgia,serif;max-width:46em;margin:2em auto;padding:0 1em}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}img{max-width:100%}</style>\n</head><body>\n${html}\n</body></html>\n`;
  }

  // ===================================================================================
  // Word (.docx)
  // ===================================================================================

  async function docxToHtml(data, { mammoth, DOMParser: P }) {
    const bytes = toBytes(data);
    const input = typeof Buffer !== 'undefined' && !(typeof window !== 'undefined') ? { buffer: Buffer.from(bytes) } : { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    // Mammoth drops underline/strikethrough unless mapped explicitly.
    const result = await mammoth.convertToHtml(input, { styleMap: ['u => u', 'strike => s'] });
    return sanitizeHtml(result.value, P);
  }

  async function htmlToDocx(html, { docx: D, DOMParser: P }) {
    const doc = parseHtml(sanitizeHtml(html, P), P);
    const HEADINGS = { h1: D.HeadingLevel.HEADING_1, h2: D.HeadingLevel.HEADING_2, h3: D.HeadingLevel.HEADING_3, h4: D.HeadingLevel.HEADING_4, h5: D.HeadingLevel.HEADING_5, h6: D.HeadingLevel.HEADING_6 };
    const ALIGN = { center: D.AlignmentType.CENTER, right: D.AlignmentType.RIGHT, justify: D.AlignmentType.JUSTIFIED };
    let listInstance = 0;

    const alignOf = (el) => {
      const m = /text-align:\s*(\w+)/.exec(el.getAttribute('style') || '');
      return m ? ALIGN[m[1]] : undefined;
    };

    function runs(node, marks = {}) {
      const out = [];
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) {
          const text = n.nodeValue.replace(/\s+/g, ' ');
          if (text) out.push(new D.TextRun({ text, ...marks }));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (tag === 'br') out.push(new D.TextRun({ text: '', break: 1 }));
        else if (tag === 'strong') out.push(...runs(n, { ...marks, bold: true }));
        else if (tag === 'em') out.push(...runs(n, { ...marks, italics: true }));
        else if (tag === 'u') out.push(...runs(n, { ...marks, underline: {} }));
        else if (tag === 's') out.push(...runs(n, { ...marks, strike: true }));
        else if (tag === 'sub') out.push(...runs(n, { ...marks, subScript: true }));
        else if (tag === 'sup') out.push(...runs(n, { ...marks, superScript: true }));
        else if (tag === 'mark') out.push(...runs(n, { ...marks, highlight: 'yellow' }));
        else if (tag === 'code') out.push(...runs(n, { ...marks, font: 'Consolas' }));
        else if (tag === 'a') {
          const href = n.getAttribute('href');
          const children = runs(n, { ...marks, style: 'Hyperlink' });
          out.push(href && /^(https?:|mailto:)/i.test(href) ? new D.ExternalHyperlink({ link: href, children }) : children);
        } else if (tag === 'img') {
          const img = parseDataImage(n.getAttribute('src'));
          if (img && ['png', 'jpg', 'gif', 'bmp'].includes(img.ext)) {
            const size = fitImage({ w: parseInt(n.getAttribute('width'), 10) || imageSize(img.bytes).w, h: parseInt(n.getAttribute('height'), 10) || imageSize(img.bytes).h });
            out.push(new D.ImageRun({ type: img.ext, data: img.bytes, transformation: { width: size.w, height: size.h } }));
          }
        } else out.push(...runs(n, marks));
      }
      return out.flat();
    }

    function listParagraphs(listEl, level, out) {
      const ordered = listEl.tagName.toLowerCase() === 'ol';
      const instance = ++listInstance;
      for (const li of Array.from(listEl.children)) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const nested = [];
        const inlineHolder = li.ownerDocument.createElement('span');
        for (const c of Array.from(li.childNodes)) {
          if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) nested.push(c);
          else inlineHolder.appendChild(c.cloneNode(true));
        }
        out.push(
          new D.Paragraph({
            children: runs(inlineHolder),
            alignment: alignOf(li),
            ...(ordered ? { numbering: { reference: 'rdoc-numbers', level: Math.min(level, 5), instance } } : { bullet: { level: Math.min(level, 5) } }),
          })
        );
        for (const sub of nested) listParagraphs(sub, level + 1, out);
      }
    }

    function blocks(container, out, extra = {}) {
      for (const n of Array.from(container.childNodes)) {
        if (n.nodeType === 3) {
          if (n.nodeValue.trim()) out.push(new D.Paragraph({ children: [new D.TextRun(n.nodeValue.trim())], ...extra }));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (HEADINGS[tag]) out.push(new D.Paragraph({ heading: HEADINGS[tag], alignment: alignOf(n), children: runs(n) }));
        else if (tag === 'p') out.push(new D.Paragraph({ alignment: alignOf(n), children: runs(n), ...extra }));
        else if (tag === 'ul' || tag === 'ol') listParagraphs(n, 0, out);
        else if (tag === 'blockquote') blocks(n, out, { indent: { left: 720 } });
        else if (tag === 'pre') {
          for (const line of n.textContent.replace(/\n$/, '').split('\n')) out.push(new D.Paragraph({ children: [new D.TextRun({ text: line, font: 'Consolas' })] }));
        } else if (tag === 'hr') out.push(new D.Paragraph({ thematicBreak: true, children: [] }));
        else if (tag === 'table') {
          const rows = Array.from(n.querySelectorAll('tr')).map(
            (tr) =>
              new D.TableRow({
                children: Array.from(tr.children).map((cell) => {
                  const paras = [];
                  const holder = cell.ownerDocument.createElement('p');
                  for (const c of Array.from(cell.childNodes)) holder.appendChild(c.cloneNode(true));
                  paras.push(new D.Paragraph({ children: cell.tagName.toLowerCase() === 'th' ? runs(holder, { bold: true }) : runs(holder), alignment: alignOf(cell) }));
                  return new D.TableCell({
                    children: paras,
                    columnSpan: parseInt(cell.getAttribute('colspan'), 10) || undefined,
                    rowSpan: parseInt(cell.getAttribute('rowspan'), 10) || undefined,
                  });
                }),
              })
          );
          if (rows.length) out.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }));
        } else if (tag === 'img') out.push(new D.Paragraph({ children: runs({ childNodes: [n] }) }));
        else blocks(n, out, extra);
      }
    }

    const children = [];
    blocks(doc.body, children);
    if (!children.length) children.push(new D.Paragraph({ children: [] }));
    const levels = [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      format: D.LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: D.AlignmentType.START,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }));
    const document = new D.Document({
      creator: 'rdrive',
      numbering: { config: [{ reference: 'rdoc-numbers', levels }] },
      sections: [{ children }],
    });
    if (typeof window !== 'undefined' && D.Packer.toBlob) return D.Packer.toBlob(document);
    return D.Packer.toBuffer(document);
  }

  // ===================================================================================
  // OpenDocument text (.odt)
  // ===================================================================================

  const ODF_NS = {
    office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
    text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
    fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    xlink: 'http://www.w3.org/1999/xlink',
    svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
    of: 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
    manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  };
  const NS_DECL = Object.entries(ODF_NS).filter(([k]) => k !== 'manifest').map(([k, v]) => `xmlns:${k}="${v}"`).join(' ');

  function manifestXml(mime, extra = []) {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="${ODF_NS.manifest}" manifest:version="1.3">` +
      `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${mime}"/>` +
      `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
      `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>` +
      extra.map(([p, t]) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="${t}"/>`).join('') +
      `</manifest:manifest>`
    );
  }

  // Writes the zip with "mimetype" first and uncompressed, as the ODF spec requires.
  async function odfZip(JSZip, mime, content, styles, extraFiles = []) {
    const zip = new JSZip();
    zip.file('mimetype', mime, { compression: 'STORE' });
    zip.file('META-INF/manifest.xml', manifestXml(mime, extraFiles.map(([p, , t]) => [p, t])));
    zip.file('content.xml', content);
    zip.file('styles.xml', styles);
    for (const [p, bytes] of extraFiles) zip.file(p, bytes);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: mime });
  }

  // Spaces, tabs and line breaks need explicit ODF elements.
  function odfText(s) {
    return escapeXml(s)
      .replace(/\t/g, '<text:tab/>')
      .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
  }

  async function htmlToOdt(html, { JSZip, DOMParser: P }) {
    const doc = parseHtml(sanitizeHtml(html, P), P);
    const MIME = 'application/vnd.oasis.opendocument.text';
    const textStyles = new Map(); // "b|i|u|s|sub|sup|code" -> style name
    const paraStyles = new Map(); // "align|indent" -> style name
    const pictures = [];
    let listCount = 0;

    function textStyle(marks) {
      const key = ['b', 'i', 'u', 's', 'sub', 'sup', 'code', 'mark'].filter((k) => marks[k]).join('|');
      if (!key) return null;
      if (!textStyles.has(key)) textStyles.set(key, { name: `T${textStyles.size + 1}`, marks: { ...marks } });
      return textStyles.get(key).name;
    }

    function paraStyle(el, indent = 0) {
      const m = el && /text-align:\s*(\w+)/.exec(el.getAttribute ? el.getAttribute('style') || '' : '');
      const align = m ? m[1] : '';
      if (!align && !indent) return null;
      const key = `${align}|${indent}`;
      if (!paraStyles.has(key)) paraStyles.set(key, { name: `P${paraStyles.size + 1}`, align, indent });
      return paraStyles.get(key).name;
    }

    function inline(node, marks = {}) {
      let s = '';
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) {
          const text = n.nodeValue.replace(/[\r\n]+/g, ' ');
          if (!text) continue;
          const st = textStyle(marks);
          s += st ? `<text:span text:style-name="${st}">${odfText(text)}</text:span>` : odfText(text);
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        const map = { strong: 'b', em: 'i', u: 'u', s: 's', sub: 'sub', sup: 'sup', code: 'code', mark: 'mark' };
        if (tag === 'br') s += '<text:line-break/>';
        else if (map[tag]) s += inline(n, { ...marks, [map[tag]]: true });
        else if (tag === 'a') s += `<text:a xlink:type="simple" xlink:href="${escapeXml(n.getAttribute('href') || '')}">${inline(n, marks)}</text:a>`;
        else if (tag === 'img') {
          const img = parseDataImage(n.getAttribute('src'));
          if (img) {
            const p = `Pictures/image${pictures.length + 1}.${img.ext}`;
            pictures.push([p, img.bytes, img.mime]);
            const size = fitImage({ w: parseInt(n.getAttribute('width'), 10) || imageSize(img.bytes).w, h: parseInt(n.getAttribute('height'), 10) || imageSize(img.bytes).h });
            const cm = (px) => `${((px / 96) * 2.54).toFixed(2)}cm`;
            s += `<draw:frame draw:name="Image${pictures.length}" text:anchor-type="as-char" svg:width="${cm(size.w)}" svg:height="${cm(size.h)}"><draw:image xlink:href="${p}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
          }
        } else s += inline(n, marks);
      }
      return s;
    }

    function para(tagName, el, content, indent = 0, extraStyle = null) {
      const st = extraStyle || paraStyle(el, indent);
      return `<text:${tagName}${st ? ` text:style-name="${st}"` : ''}>${content}</text:${tagName}>`;
    }

    function list(el, level) {
      const ordered = el.tagName.toLowerCase() === 'ol';
      let s = `<text:list${level === 0 ? ` xml:id="list${++listCount}" text:style-name="${ordered ? 'LNumber' : 'LBullet'}"` : ''}>`;
      for (const li of Array.from(el.children)) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const holder = li.ownerDocument.createElement('span');
        const nested = [];
        for (const c of Array.from(li.childNodes)) {
          if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) nested.push(c);
          else holder.appendChild(c.cloneNode(true));
        }
        s += `<text:list-item>${para('p', li, inline(holder))}${nested.map((n) => list(n, level + 1)).join('')}</text:list-item>`;
      }
      return s + '</text:list>';
    }

    function blocks(container, indent = 0) {
      let s = '';
      for (const n of Array.from(container.childNodes)) {
        if (n.nodeType === 3) {
          if (n.nodeValue.trim()) s += para('p', null, odfText(n.nodeValue.trim()), indent);
          continue;
        }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const lvl = Number(tag[1]);
          s += `<text:h text:style-name="Heading_20_${lvl}" text:outline-level="${lvl}">${inline(n)}</text:h>`;
        } else if (tag === 'p') s += para('p', n, inline(n), indent);
        else if (tag === 'ul' || tag === 'ol') s += list(n, 0);
        else if (tag === 'blockquote') s += blocks(n, indent + 1);
        else if (tag === 'pre') {
          for (const line of n.textContent.replace(/\n$/, '').split('\n')) {
            s += para('p', null, `<text:span text:style-name="${textStyle({ code: true })}">${odfText(line)}</text:span>`, indent);
          }
        } else if (tag === 'hr') s += '<text:p text:style-name="Rule"/>';
        else if (tag === 'table') {
          const rows = Array.from(n.querySelectorAll('tr'));
          const cols = Math.max(1, ...rows.map((r) => Array.from(r.children).reduce((a, c) => a + (parseInt(c.getAttribute('colspan'), 10) || 1), 0)));
          s += `<table:table table:name="Table${++listCount}" table:style-name="Tbl"><table:table-column table:number-columns-repeated="${cols}"/>`;
          for (const tr of rows) {
            s += '<table:table-row>';
            for (const cell of Array.from(tr.children)) {
              const span = parseInt(cell.getAttribute('colspan'), 10) || 1;
              const marks = cell.tagName.toLowerCase() === 'th' ? { b: true } : {};
              s += `<table:table-cell table:style-name="Cell" office:value-type="string"${span > 1 ? ` table:number-columns-spanned="${span}"` : ''}>${para('p', cell, inline(cell, marks))}</table:table-cell>`;
              for (let k = 1; k < span; k++) s += '<table:covered-table-cell/>';
            }
            s += '</table:table-row>';
          }
          s += '</table:table>';
        } else if (tag === 'img') s += para('p', null, inline({ childNodes: [n] }), indent);
        else s += blocks(n, indent);
      }
      return s;
    }

    const body = blocks(doc.body) || '<text:p/>';
    const fmtText = ({ b, i, u, s, sub, sup, code, mark }) =>
      '<style:text-properties' +
      (b ? ' fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"' : '') +
      (i ? ' fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"' : '') +
      (u ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : '') +
      (s ? ' style:text-line-through-style="solid"' : '') +
      (sub ? ' style:text-position="sub 58%"' : sup ? ' style:text-position="super 58%"' : '') +
      (code ? ' fo:font-family="Consolas, monospace" style:font-family-generic="modern"' : '') +
      (mark ? ' fo:background-color="#ffff00"' : '') +
      '/>';
    const autoStyles =
      [...textStyles.values()].map((t) => `<style:style style:name="${t.name}" style:family="text">${fmtText(t.marks)}</style:style>`).join('') +
      [...paraStyles.values()]
        .map((p) => `<style:style style:name="${p.name}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties${p.align ? ` fo:text-align="${p.align === 'right' ? 'end' : p.align}"` : ''}${p.indent ? ` fo:margin-left="${(p.indent * 1.25).toFixed(2)}cm"` : ''}/></style:style>`)
        .join('') +
      '<style:style style:name="Rule" style:family="paragraph"><style:paragraph-properties fo:border-bottom="0.06pt solid #808080" fo:padding-bottom="0.1cm" fo:margin-bottom="0.3cm"/></style:style>' +
      '<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="16.5cm" table:align="margins"/></style:style>' +
      '<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #999999"/></style:style>' +
      '<text:list-style style:name="LBullet">' +
      [1, 2, 3, 4, 5, 6].map((l) => `<text:list-level-style-bullet text:level="${l}" text:bullet-char="${['•', '◦', '▪'][(l - 1) % 3]}"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.63cm" fo:margin-left="${(l * 1.27).toFixed(2)}cm"/></style:list-level-properties></text:list-level-style-bullet>`).join('') +
      '</text:list-style><text:list-style style:name="LNumber">' +
      [1, 2, 3, 4, 5, 6].map((l) => `<text:list-level-style-number text:level="${l}" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:text-indent="-0.63cm" fo:margin-left="${(l * 1.27).toFixed(2)}cm"/></style:list-level-properties></text:list-level-style-number>`).join('') +
      '</text:list-style>';

    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS_DECL} office:version="1.3"><office:automatic-styles>${autoStyles}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
    const headingSizes = [20, 16, 14, 13, 12, 12];
    const styles =
      `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS_DECL} office:version="1.3"><office:styles>` +
      '<style:style style:name="Standard" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.21cm"/><style:text-properties fo:font-size="11pt"/></style:style>' +
      headingSizes
        .map((sz, i) => `<style:style style:name="Heading_20_${i + 1}" style:display-name="Heading ${i + 1}" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="${i + 1}"><style:paragraph-properties fo:margin-top="0.42cm" fo:margin-bottom="0.21cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="${sz}pt" fo:font-weight="bold"/></style:style>`)
        .join('') +
      '</office:styles></office:document-styles>';
    return odfZip(JSZip, MIME, content, styles, pictures);
  }

  // Reads automatic and named styles into { name: { b, i, u, s, sub, sup, code, align, heading, list } }.
  function readOdfStyles(...xmlDocs) {
    const map = {};
    for (const xml of xmlDocs) {
      if (!xml) continue;
      for (const st of Array.from(xml.getElementsByTagNameNS(ODF_NS.style, 'style'))) {
        const name = st.getAttributeNS(ODF_NS.style, 'name') || st.getAttribute('style:name');
        const info = { parent: st.getAttributeNS(ODF_NS.style, 'parent-style-name') || st.getAttribute('style:parent-style-name') };
        const tp = st.getElementsByTagNameNS(ODF_NS.style, 'text-properties')[0];
        const pp = st.getElementsByTagNameNS(ODF_NS.style, 'paragraph-properties')[0];
        const cp = st.getElementsByTagNameNS(ODF_NS.style, 'table-cell-properties')[0];
        const attr = (el, ns, n) => (el ? el.getAttributeNS(ODF_NS[ns], n) || el.getAttribute(`${ns}:${n}`) : null);
        if (tp) {
          if (attr(tp, 'fo', 'font-weight') === 'bold' || /^[6-9]00$/.test(attr(tp, 'fo', 'font-weight') || '')) info.b = true;
          if (attr(tp, 'fo', 'font-style') === 'italic') info.i = true;
          const ul = attr(tp, 'style', 'text-underline-style');
          if (ul && ul !== 'none') info.u = true;
          const lt = attr(tp, 'style', 'text-line-through-style');
          if (lt && lt !== 'none') info.s = true;
          const pos = attr(tp, 'style', 'text-position') || '';
          if (/^sub|^-/.test(pos)) info.sub = true;
          else if (/^super|^\d/.test(pos) && !/^0/.test(pos)) info.sup = true;
          if (/mono|consolas|courier/i.test(attr(tp, 'fo', 'font-family') || '') || attr(tp, 'style', 'font-family-generic') === 'modern') info.code = true;
          const color = attr(tp, 'fo', 'color');
          if (color && /^#[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== '#000000') info.fg = color;
        }
        const align = attr(pp, 'fo', 'text-align');
        if (align) info.align = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' }[align];
        const colp = st.getElementsByTagNameNS(ODF_NS.style, 'table-column-properties')[0];
        const cw = /^([\d.]+)(cm|mm|in|pt)$/.exec(attr(colp, 'style', 'column-width') || '');
        if (cw) info.colPx = Math.round(Number(cw[1]) * { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72 }[cw[2]]);
        const bg = attr(cp, 'fo', 'background-color');
        if (bg && /^#[0-9a-f]{6}$/i.test(bg) && bg.toLowerCase() !== '#ffffff') info.bg = bg;
        const hm = /^Heading_20_(\d)$/.exec(name || '');
        if (hm) info.heading = Number(hm[1]);
        const dataStyle = st.getAttributeNS(ODF_NS.style, 'data-style-name') || st.getAttribute('style:data-style-name');
        if (dataStyle) info.dataStyle = dataStyle;
        map[name] = info;
      }
      for (const ls of Array.from(xml.getElementsByTagNameNS(ODF_NS.text, 'list-style'))) {
        const name = ls.getAttributeNS(ODF_NS.style, 'name') || ls.getAttribute('style:name');
        const first = Array.from(ls.childNodes).find((c) => c.nodeType === 1);
        map[name] = { list: first && first.localName === 'list-level-style-number' ? 'ol' : 'ul' };
      }
    }
    // Resolve inheritance (one level is enough in practice; loop guards against cycles).
    const resolve = (name, depth = 0) => {
      const s = map[name];
      if (!s) return {};
      if (!s.parent || depth > 5) return s;
      return { ...resolve(s.parent, depth + 1), ...s };
    };
    return (name) => (name ? resolve(name) : {});
  }

  // XMLParser is optional: browsers' DOMParser handles XML namespaces; in Node pass one that does.
  async function odtToHtml(data, { JSZip, DOMParser: P, XMLParser }) {
    const zip = await JSZip.loadAsync(toBytes(data));
    const contentFile = zip.file('content.xml');
    if (!contentFile) throw new Error('This is not an OpenDocument text file.');
    const parser = new (XMLParser || P || DOMParser)();
    const content = parser.parseFromString(await contentFile.async('string'), 'application/xml');
    const stylesFile = zip.file('styles.xml');
    const stylesXml = stylesFile ? parser.parseFromString(await stylesFile.async('string'), 'application/xml') : null;
    const styleOf = readOdfStyles(content, stylesXml);
    const textBody = content.getElementsByTagNameNS(ODF_NS.office, 'text')[0];
    if (!textBody) return '<p><br></p>';

    const pics = {};
    for (const frameImg of Array.from(content.getElementsByTagNameNS(ODF_NS.draw, 'image'))) {
      const href = frameImg.getAttributeNS(ODF_NS.xlink, 'href') || frameImg.getAttribute('xlink:href');
      const f = href && zip.file(href);
      if (f && !pics[href]) {
        const ext = (href.split('.').pop() || 'png').toLowerCase();
        const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' }[ext];
        if (mime) pics[href] = `data:image/${mime};base64,${bytesToBase64(await f.async('uint8array'))}`;
      }
    }

    const styleName = (el, n = 'style-name') => el.getAttributeNS(ODF_NS.text, n) || el.getAttribute(`text:${n}`) || el.getAttributeNS(ODF_NS.table, n) || el.getAttribute(`table:${n}`);
    const wrap = (html, st) => {
      let s = html;
      if (st.code) s = `<code>${s}</code>`;
      if (st.sub) s = `<sub>${s}</sub>`;
      if (st.sup) s = `<sup>${s}</sup>`;
      if (st.s) s = `<s>${s}</s>`;
      if (st.u) s = `<u>${s}</u>`;
      if (st.i) s = `<em>${s}</em>`;
      if (st.b) s = `<strong>${s}</strong>`;
      return s;
    };
    const alignAttr = (st) => (st.align && st.align !== 'left' ? ` style="text-align: ${st.align}"` : '');

    function inline(node) {
      let s = '';
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) {
          s += escapeHtml(n.nodeValue);
          continue;
        }
        if (n.nodeType !== 1) continue;
        const ln = n.localName;
        if (ln === 's') s += ' '.repeat(parseInt(n.getAttributeNS(ODF_NS.text, 'c') || n.getAttribute('text:c'), 10) || 1);
        else if (ln === 'tab') s += '\t';
        else if (ln === 'line-break') s += '<br>';
        else if (ln === 'span') s += wrap(inline(n), styleOf(styleName(n)));
        else if (ln === 'a') s += `<a href="${escapeHtml(n.getAttributeNS(ODF_NS.xlink, 'href') || n.getAttribute('xlink:href') || '')}">${inline(n)}</a>`;
        else if (ln === 'frame') {
          const img = n.getElementsByTagNameNS(ODF_NS.draw, 'image')[0];
          const href = img && (img.getAttributeNS(ODF_NS.xlink, 'href') || img.getAttribute('xlink:href'));
          if (href && pics[href]) s += `<img src="${pics[href]}" alt="">`;
        } else if (ln === 'note' || ln === 'annotation' || ln === 'bookmark' || ln === 'bookmark-start' || ln === 'bookmark-end' || ln === 'soft-page-break') continue;
        else s += inline(n);
      }
      return s;
    }

    function paragraph(n, forceTag) {
      const st = styleOf(styleName(n));
      const tag = forceTag || (st.heading ? `h${Math.min(st.heading, 6)}` : 'p');
      // Headings are bold by definition; don't repeat their style's bold as <strong>.
      const inner = (tag === 'p' ? wrap(inline(n), { ...st, align: undefined }) : inline(n)) || '<br>';
      return `<${tag}${alignAttr(st)}>${inner}</${tag}>`;
    }

    function list(n) {
      const st = styleOf(styleName(n));
      const tag = st.list || 'ul';
      let s = `<${tag}>`;
      for (const item of Array.from(n.childNodes)) {
        if (item.nodeType !== 1 || (item.localName !== 'list-item' && item.localName !== 'list-header')) continue;
        let content = '';
        for (const c of Array.from(item.childNodes)) {
          if (c.nodeType !== 1) continue;
          if (c.localName === 'list') content += list(c);
          else if (c.localName === 'p' || c.localName === 'h') content += (content && !content.endsWith('>') ? '<br>' : '') + wrap(inline(c), styleOf(styleName(c)));
        }
        s += `<li>${content}</li>`;
      }
      return s + `</${tag}>`;
    }

    function table(n) {
      let s = '<table>';
      for (const row of Array.from(n.getElementsByTagNameNS(ODF_NS.table, 'table-row'))) {
        s += '<tr>';
        for (const cell of Array.from(row.childNodes)) {
          if (cell.nodeType !== 1 || cell.localName !== 'table-cell') continue;
          const span = parseInt(cell.getAttributeNS(ODF_NS.table, 'number-columns-spanned') || cell.getAttribute('table:number-columns-spanned'), 10);
          s += `<td${span > 1 ? ` colspan="${span}"` : ''}>${Array.from(cell.childNodes).filter((c) => c.nodeType === 1).map((c) => (c.localName === 'list' ? list(c) : inline(c))).join('<br>')}</td>`;
        }
        s += '</tr>';
      }
      return s + '</table>';
    }

    function blocks(node) {
      let s = '';
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType !== 1) continue;
        const ln = n.localName;
        if (ln === 'h') {
          const lvl = parseInt(n.getAttributeNS(ODF_NS.text, 'outline-level') || n.getAttribute('text:outline-level'), 10) || styleOf(styleName(n)).heading || 1;
          s += paragraph(n, `h${Math.min(lvl, 6)}`);
        } else if (ln === 'p') s += paragraph(n);
        else if (ln === 'list') s += list(n);
        else if (ln === 'table' && n.namespaceURI === ODF_NS.table) s += table(n);
        else if (ln === 'section' || ln === 'index-body' || ln === 'table-of-content') s += blocks(n);
      }
      return s;
    }

    return sanitizeHtml(blocks(textBody), P);
  }

  // ===================================================================================
  // Spreadsheets: formula dialects
  // ===================================================================================

  // Runs fn on the parts of a formula outside "string literals".
  function mapOutsideStrings(formula, fn) {
    return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : fn(part))).join('');
  }

  const REF = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;

  // RDrive/Excel  =SUM(A1:B2, 'Sheet 2'!C3)  ->  ODF  of:=SUM([.A1:.B2]; ['Sheet 2'.C3])
  function formulaToOdf(formula) {
    let f = String(formula).replace(/^=/, '');
    f = mapOutsideStrings(f, (part) =>
      part
        .replace(new RegExp(String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!(${REF})(?::(${REF}))?`, 'g'), (_, q, plain, a, b) => {
          const sheet = q != null ? `'${q}'` : plain;
          return `[$${sheet}.${a}${b ? `:.${b}` : ''}]`;
        })
        .replace(new RegExp(String.raw`(^|[^A-Za-z0-9_.$\[])(${REF}):(${REF})(?![A-Za-z0-9_(])`, 'g'), '$1[.$2:.$3]')
        .replace(new RegExp(String.raw`(^|[^A-Za-z0-9_.$\[:])(${REF})(?![A-Za-z0-9_(:\]])`, 'g'), '$1[.$2]')
        .replace(/,/g, ';')
    );
    return `of:=${f}`;
  }

  // ODF  of:=SUM([.A1:.B2];[$'Sheet 2'.C3])  ->  =SUM(A1:B2,'Sheet 2'!C3)
  function formulaFromOdf(formula) {
    let f = String(formula).replace(/^(of|oooc|msoxl):/, '').replace(/^=?/, '');
    f = mapOutsideStrings(f, (part) =>
      part
        .replace(/\[\$?(?:'((?:[^']|'')+)'|([^.\]:']*))?\.(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::\$?(?:'(?:[^']|'')+'|[^.\]:']*)?\.(\$?[A-Za-z]{1,3}\$?\d{1,7}))?\]/g, (_, q, plain, a, b) => {
          const sheet = q != null ? (/^[A-Za-z0-9_]+$/.test(q) ? q : `'${q}'`) : plain || '';
          return `${sheet ? `${sheet}!` : ''}${a}${b ? `:${b}` : ''}`;
        })
        .replace(/;/g, ',')
    );
    return `=${f}`;
  }

  function emptyWorkbook() {
    return { format: 'rdrive-sheet', version: 1, activeSheet: 0, sheets: [] };
  }

  function finishSheet(sheet, maxR, maxC) {
    sheet.rows = Math.max(SHEET_DEFAULT_ROWS, maxR + 16);
    sheet.cols = Math.max(SHEET_DEFAULT_COLS, maxC + 5);
    return sheet;
  }

  const NUMFMT = { currency: '"$"#,##0.00', percent: '0.0%', integer: '#,##0', decimal: '#,##0.00' };

  function fmtFromNumFmt(numFmt) {
    if (!numFmt || numFmt === 'General') return null;
    if (numFmt.includes('%')) return 'percent';
    if (/[$€£¥]/.test(numFmt)) return 'currency';
    if (/0\.0/.test(numFmt)) return 'decimal';
    if (/#,##0|^0$/.test(numFmt)) return 'integer';
    return null;
  }

  function hexToArgb(hex) {
    return 'FF' + String(hex).replace('#', '').toUpperCase();
  }

  function argbToHex(argb) {
    if (!argb || typeof argb !== 'string' || argb.length < 6) return null;
    const hex = `#${argb.slice(-6).toLowerCase()}`;
    return hex === '#000000' || hex === '#ffffff' ? null : hex;
  }

  // Sheet names: Excel allows 31 characters and none of []:*?/\
  function safeSheetName(name, used) {
    let n = String(name || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let candidate = n;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${n.slice(0, 28)} ${i}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  // ===================================================================================
  // Excel (.xlsx)
  // ===================================================================================

  async function workbookToXlsx(workbook, { ExcelJS, evaluate }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'rdrive';
    const values = evaluate ? evaluate(workbook) : [];
    const used = new Set();
    workbook.sheets.forEach((sheet, idx) => {
      const ws = wb.addWorksheet(safeSheetName(sheet.name, used));
      const cache = values[idx] || new Map();
      for (const [key, cell] of Object.entries(sheet.cells || {})) {
        if (!cell || !parseKey(key)) continue;
        const target = ws.getCell(key);
        const v = cell.v;
        if (typeof v === 'string' && v.startsWith('=') && v.length > 1) {
          const result = cache.get(key);
          target.value = { formula: v.slice(1), result: typeof result === 'string' && result.startsWith('#') ? undefined : result };
        } else if (v !== undefined && v !== null && v !== '') {
          target.value = v;
        }
        const font = {};
        if (cell.b) font.bold = true;
        if (cell.i) font.italic = true;
        if (cell.u) font.underline = true;
        if (cell.fg) font.color = { argb: hexToArgb(cell.fg) };
        if (Object.keys(font).length) target.font = font;
        if (cell.align) target.alignment = { horizontal: cell.align };
        if (cell.bg) target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(cell.bg) } };
        if (cell.fmt && NUMFMT[cell.fmt]) target.numFmt = NUMFMT[cell.fmt];
      }
      for (const [col, px] of Object.entries(sheet.colWidths || {})) {
        ws.getColumn(Number(col) + 1).width = Math.max(4, Math.round(Number(px) / 7));
      }
      if (sheet.frozenRows) ws.views = [{ state: 'frozen', ySplit: sheet.frozenRows }];
    });
    if (!workbook.sheets.length) wb.addWorksheet('Sheet 1');
    return wb.xlsx.writeBuffer();
  }

  async function xlsxToWorkbook(data, { ExcelJS }) {
    const wb = new ExcelJS.Workbook();
    const bytes = toBytes(data);
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const out = emptyWorkbook();
    wb.eachSheet((ws) => {
      const sheet = { name: ws.name, colWidths: {}, frozenRows: 0, cells: {} };
      let maxR = 0;
      let maxC = 0;
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const key = `${colToLetter(colNumber - 1)}${rowNumber}`;
          const out = {};
          const val = cell.value;
          if (cell.formula || (val && typeof val === 'object' && (val.formula || val.sharedFormula))) {
            const f = cell.formula || val.formula;
            if (f) out.v = `=${f}`;
            else if (val.result !== undefined) out.v = val.result instanceof Date ? val.result.toISOString().slice(0, 10) : val.result;
          } else if (val instanceof Date) out.v = val.toISOString().slice(0, 10);
          else if (val && typeof val === 'object') {
            if (Array.isArray(val.richText)) out.v = val.richText.map((r) => r.text).join('');
            else if (val.text !== undefined) out.v = typeof val.text === 'object' && val.text.richText ? val.text.richText.map((r) => r.text).join('') : val.text;
            else if (val.error) out.v = val.error;
            else if (val.result !== undefined) out.v = val.result;
          } else if (val !== null && val !== undefined) out.v = val;
          const font = cell.font || {};
          if (font.bold) out.b = 1;
          if (font.italic) out.i = 1;
          if (font.underline) out.u = 1;
          const fg = font.color && argbToHex(font.color.argb);
          if (fg) out.fg = fg;
          const align = cell.alignment && cell.alignment.horizontal;
          if (align === 'center' || align === 'right' || align === 'left') out.align = align;
          const fill = cell.fill;
          const bg = fill && fill.type === 'pattern' && fill.pattern === 'solid' && fill.fgColor && argbToHex(fill.fgColor.argb);
          if (bg) out.bg = bg;
          const fmt = fmtFromNumFmt(cell.numFmt);
          if (fmt) out.fmt = fmt;
          if (out.v === undefined && Object.keys(out).length === 0) return;
          if (out.v === undefined) out.v = '';
          sheet.cells[key] = out;
          maxR = Math.max(maxR, rowNumber);
          maxC = Math.max(maxC, colNumber);
        });
      });
      (ws.columns || []).forEach((col, i) => {
        if (col && col.width && Math.abs(col.width - 9.140625) > 0.5 && i < 500) sheet.colWidths[i] = Math.round(col.width * 7);
      });
      const view = (ws.views || [])[0];
      if (view && view.state === 'frozen' && view.ySplit) sheet.frozenRows = view.ySplit;
      out.sheets.push(finishSheet(sheet, maxR, maxC));
    });
    if (!out.sheets.length) out.sheets.push(finishSheet({ name: 'Sheet 1', colWidths: {}, frozenRows: 0, cells: {} }, 0, 0));
    return out;
  }

  // ===================================================================================
  // OpenDocument spreadsheet (.ods)
  // ===================================================================================

  async function workbookToOds(workbook, { JSZip, evaluate }) {
    const MIME = 'application/vnd.oasis.opendocument.spreadsheet';
    const values = evaluate ? evaluate(workbook) : [];
    const cellStyles = new Map();
    const styleFor = (cell) => {
      const key = ['b', 'i', 'u', 'align', 'bg', 'fg', 'fmt'].map((k) => cell[k] || '').join('|');
      if (key.replace(/\|/g, '') === '') return null;
      if (!cellStyles.has(key)) cellStyles.set(key, { name: `ce${cellStyles.size + 1}`, cell });
      return cellStyles.get(key).name;
    };
    const used = new Set();
    let tables = '';
    workbook.sheets.forEach((sheet, idx) => {
      const cache = values[idx] || new Map();
      const byRow = new Map();
      let maxC = 0;
      for (const [key, cell] of Object.entries(sheet.cells || {})) {
        const p = parseKey(key);
        if (!p || !cell) continue;
        if (!byRow.has(p.r)) byRow.set(p.r, new Map());
        byRow.get(p.r).set(p.c, { key, cell });
        maxC = Math.max(maxC, p.c + 1);
      }
      const cols = Math.max(1, maxC);
      let colsXml = '';
      for (let c = 0; c < cols; c++) {
        const px = (sheet.colWidths || {})[c];
        colsXml += px ? `<table:table-column table:style-name="co${Math.round(px)}"/>` : '<table:table-column/>';
        if (px) cellStyles.set(`col${Math.round(px)}`, { name: `co${Math.round(px)}`, colPx: Math.round(px) });
      }
      let rowsXml = '';
      const maxR = byRow.size ? Math.max(...byRow.keys()) : -1;
      let blank = 0;
      for (let r = 0; r <= maxR; r++) {
        const row = byRow.get(r);
        if (!row) {
          blank++;
          continue;
        }
        if (blank) rowsXml += `<table:table-row table:number-rows-repeated="${blank}"><table:table-cell table:number-columns-repeated="${cols}"/></table:table-row>`;
        blank = 0;
        rowsXml += '<table:table-row>';
        let emptyCells = 0;
        for (let c = 0; c < cols; c++) {
          const entry = row.get(c);
          if (!entry) {
            emptyCells++;
            continue;
          }
          if (emptyCells) rowsXml += `<table:table-cell table:number-columns-repeated="${emptyCells}"/>`;
          emptyCells = 0;
          const { key, cell } = entry;
          const st = styleFor(cell);
          const styleAttr = st ? ` table:style-name="${st}"` : '';
          let v = cell.v;
          let formulaAttr = '';
          if (typeof v === 'string' && v.startsWith('=') && v.length > 1) {
            formulaAttr = ` table:formula="${escapeXml(formulaToOdf(v))}"`;
            v = cache.get(key);
          }
          if (typeof v === 'number') {
            const type = cell.fmt === 'percent' ? 'percentage' : cell.fmt === 'currency' ? 'currency' : 'float';
            rowsXml += `<table:table-cell${styleAttr}${formulaAttr} office:value-type="${type}"${type === 'currency' ? ' office:currency="USD"' : ''} office:value="${v}" calcext:value-type="${type}"><text:p>${v}</text:p></table:table-cell>`;
          } else if (typeof v === 'boolean') {
            rowsXml += `<table:table-cell${styleAttr}${formulaAttr} office:value-type="boolean" office:boolean-value="${v}"><text:p>${v ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`;
          } else {
            const text = v == null ? '' : String(v);
            rowsXml += `<table:table-cell${styleAttr}${formulaAttr}${text || formulaAttr ? ' office:value-type="string"' : ''}>${text.split('\n').map((l) => `<text:p>${odfText(l)}</text:p>`).join('')}</table:table-cell>`;
          }
        }
        rowsXml += '</table:table-row>';
      }
      if (!rowsXml) rowsXml = '<table:table-row><table:table-cell/></table:table-row>';
      tables += `<table:table table:name="${escapeXml(safeSheetName(sheet.name, used))}">${colsXml}${rowsXml}</table:table>`;
    });
    const dataStyles =
      '<number:number-style style:name="Ninteger"><number:number number:decimal-places="0" number:min-decimal-places="0" number:min-integer-digits="1" number:grouping="true"/></number:number-style>' +
      '<number:number-style style:name="Ndecimal"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>' +
      '<number:percentage-style style:name="Npercent"><number:number number:decimal-places="1" number:min-decimal-places="1" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>' +
      '<number:currency-style style:name="Ncurrency"><number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>';
    const autoStyles = [...cellStyles.values()]
      .map((s) => {
        if (s.colPx) return `<style:style style:name="${s.name}" style:family="table-column"><style:table-column-properties style:column-width="${((s.colPx / 96) * 2.54).toFixed(3)}cm"/></style:style>`;
        const c = s.cell;
        return (
          `<style:style style:name="${s.name}" style:family="table-cell" style:parent-style-name="Default"${c.fmt ? ` style:data-style-name="N${c.fmt}"` : ''}>` +
          (c.bg ? `<style:table-cell-properties fo:background-color="${c.bg}"/>` : '') +
          (c.align ? `<style:paragraph-properties fo:text-align="${c.align === 'right' ? 'end' : c.align === 'left' ? 'start' : 'center'}"/>` : '') +
          ((c.b || c.i || c.u || c.fg) ? `<style:text-properties${c.b ? ' fo:font-weight="bold"' : ''}${c.i ? ' fo:font-style="italic"' : ''}${c.u ? ' style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"' : ''}${c.fg ? ` fo:color="${c.fg}"` : ''}/>` : '') +
          '</style:style>'
        );
      })
      .join('');
    const ns = `${NS_DECL} xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"`;
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ns} office:version="1.3"><office:automatic-styles>${dataStyles}${autoStyles}</office:automatic-styles><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`;
    const styles = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ns} office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`;
    return odfZip(JSZip, MIME, content, styles);
  }

  const MAX_ODS_ROWS = 100000;
  const MAX_ODS_COLS = 1000;

  async function odsToWorkbook(data, { JSZip, DOMParser: P, XMLParser }) {
    const zip = await JSZip.loadAsync(toBytes(data));
    const contentFile = zip.file('content.xml');
    if (!contentFile) throw new Error('This is not an OpenDocument spreadsheet.');
    const parser = new (XMLParser || P || DOMParser)();
    const content = parser.parseFromString(await contentFile.async('string'), 'application/xml');
    const stylesFile = zip.file('styles.xml');
    const styleOf = readOdfStyles(content, stylesFile ? parser.parseFromString(await stylesFile.async('string'), 'application/xml') : null);
    const attr = (el, ns, n) => el.getAttributeNS(ODF_NS[ns] || ns, n) || el.getAttribute(`${ns}:${n}`);
    const OFFICE = ODF_NS.office;
    const out = emptyWorkbook();

    for (const tableEl of Array.from(content.getElementsByTagNameNS(ODF_NS.table, 'table'))) {
      const sheet = { name: attr(tableEl, 'table', 'name') || `Sheet ${out.sheets.length + 1}`, colWidths: {}, frozenRows: 0, cells: {} };
      let col = 0;
      for (const colEl of Array.from(tableEl.getElementsByTagNameNS(ODF_NS.table, 'table-column'))) {
        const repeat = Math.min(parseInt(attr(colEl, 'table', 'number-columns-repeated'), 10) || 1, MAX_ODS_COLS);
        const px = styleOf(attr(colEl, 'table', 'style-name')).colPx;
        // Only keep widths that differ noticeably from the default (~2.26 cm ≈ 85 px).
        if (px && Math.abs(px - 85) > 8) for (let k = 0; k < Math.min(repeat, 50); k++) sheet.colWidths[col + k] = px;
        col += repeat;
        if (col >= MAX_ODS_COLS) break;
      }
      let r = 0;
      let maxR = 0;
      let maxC = 0;
      const rows = Array.from(tableEl.getElementsByTagNameNS(ODF_NS.table, 'table-row'));
      for (const row of rows) {
        const repeatRows = Math.min(parseInt(attr(row, 'table', 'number-rows-repeated'), 10) || 1, MAX_ODS_ROWS);
        const rowCells = [];
        let c = 0;
        for (const cell of Array.from(row.childNodes)) {
          if (cell.nodeType !== 1 || (cell.localName !== 'table-cell' && cell.localName !== 'covered-table-cell')) continue;
          const repeatCols = Math.min(parseInt(attr(cell, 'table', 'number-columns-repeated'), 10) || 1, MAX_ODS_COLS);
          const type = cell.getAttributeNS(OFFICE, 'value-type') || cell.getAttribute('office:value-type');
          const formula = attr(cell, 'table', 'formula');
          const st = styleOf(attr(cell, 'table', 'style-name'));
          let v;
          if (formula) v = formulaFromOdf(formula);
          else if (type === 'float' || type === 'percentage' || type === 'currency') v = Number(cell.getAttributeNS(OFFICE, 'value') || cell.getAttribute('office:value'));
          else if (type === 'boolean') v = (cell.getAttributeNS(OFFICE, 'boolean-value') || cell.getAttribute('office:boolean-value')) === 'true';
          else if (type === 'date') v = (cell.getAttributeNS(OFFICE, 'date-value') || cell.getAttribute('office:date-value') || '').slice(0, 10);
          else {
            const paras = Array.from(cell.getElementsByTagNameNS(ODF_NS.text, 'p')).map((p) => p.textContent);
            v = paras.join('\n');
          }
          const hasContent = v !== '' && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
          const fmt = type === 'percentage' ? 'percent' : type === 'currency' ? 'currency' : st.dataStyle && /percent/i.test(st.dataStyle) ? 'percent' : null;
          if (hasContent && cell.localName === 'table-cell' && c < MAX_ODS_COLS) {
            const value = { v };
            if (st.b) value.b = 1;
            if (st.i) value.i = 1;
            if (st.u) value.u = 1;
            if (st.align && st.align !== 'justify') value.align = st.align;
            if (st.bg) value.bg = st.bg;
            if (st.fg) value.fg = st.fg;
            if (fmt) value.fmt = fmt;
            // Repeated identical cells with content are rare (and could be huge); cap them.
            for (let k = 0; k < Math.min(repeatCols, 200); k++) rowCells.push([c + k, value]);
          }
          c += repeatCols;
        }
        if (rowCells.length) {
          for (let k = 0; k < Math.min(repeatRows, 200); k++) {
            for (const [col, value] of rowCells) {
              sheet.cells[`${colToLetter(col)}${r + k + 1}`] = { ...value };
              maxC = Math.max(maxC, col + 1);
            }
            maxR = Math.max(maxR, r + k + 1);
          }
        }
        r += repeatRows;
        if (r > MAX_ODS_ROWS) break;
      }
      out.sheets.push(finishSheet(sheet, maxR, maxC));
    }
    if (!out.sheets.length) out.sheets.push(finishSheet({ name: 'Sheet 1', colWidths: {}, frozenRows: 0, cells: {} }, 0, 0));
    return out;
  }

  // ===================================================================================
  // Browser loader for the vendored libraries
  // ===================================================================================

  const VENDOR = {
    ExcelJS: '/vendor/exceljs.min.js',
    JSZip: '/vendor/jszip.min.js',
    mammoth: '/vendor/mammoth.browser.min.js',
    docx: '/vendor/docx.iife.js',
  };
  const loading = {};

  // Loads the named libraries (by their global name) and returns them, e.g. await load('docx', 'JSZip').
  async function load(...names) {
    const libs = {};
    for (const name of names) {
      if (!window[name]) {
        loading[name] =
          loading[name] ||
          new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = VENDOR[name];
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Could not load the ${name} library.`));
            document.head.appendChild(s);
          });
        await loading[name];
      }
      libs[name] = window[name];
    }
    return libs;
  }

  const api = {
    // documents
    emptyDoc,
    parseDoc,
    serializeDoc,
    sanitizeHtml,
    markdownToHtml,
    htmlToMarkdown,
    htmlToText,
    textToHtml,
    htmlDocument,
    docxToHtml,
    htmlToDocx,
    htmlToOdt,
    odtToHtml,
    // spreadsheets
    formulaToOdf,
    formulaFromOdf,
    workbookToXlsx,
    xlsxToWorkbook,
    workbookToOds,
    odsToWorkbook,
    // browser
    load,
  };
  if (typeof window !== 'undefined') window.RDriveInterop = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
