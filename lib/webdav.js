// WebDAV server mounted at /dav so rdrive can be mounted like a native network drive.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HttpError, segments } = require('./files');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function encodeDavHref(clientPath, isDir) {
  const parts = String(clientPath || '/')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg));
  const base = '/dav' + (parts.length ? '/' + parts.join('/') : '');
  return isDir && !base.endsWith('/') ? base + '/' : base;
}

function parseBasicAuth(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header || '').trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function davSubpath(pathname) {
  const raw = pathname.replace(/^\/dav\b/, '') || '/';
  const parts = raw
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw new HttpError(400, 'Invalid path encoding.');
      }
    });
  return '/' + segments('/' + parts.join('/')).join('/');
}

function propResponseXml({ href, name, isDir, size, mtime }) {
  const typeXml = isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
  const sizeXml = isDir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`;
  const mimeXml = isDir ? '' : '<D:getcontenttype>application/octet-stream</D:getcontenttype>';
  return `<D:response>
  <D:href>${xmlEscape(href)}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${xmlEscape(name)}</D:displayname>
      ${typeXml}
      ${sizeXml}
      ${mimeXml}
      <D:getlastmodified>${mtime.toUTCString()}</D:getlastmodified>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
}

async function handleWebdav(req, res, { auth, files, ip, sessionUser, serveDownload, onChanged }) {
  const methods = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK';
  res.setHeader('DAV', '1, 2');
  res.setHeader('MS-Author-Via', 'DAV');

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { Allow: methods, 'Content-Length': '0' });
    return res.end();
  }

  // The browser session cookie is only honoured for read-only methods. Anything that changes files must
  // authenticate explicitly (HTTP Basic), so a page can't ride the cookie to modify the drive (CSRF).
  const readOnlyMethod = ['GET', 'HEAD', 'PROPFIND'].includes(req.method);
  let user = readOnlyMethod ? sessionUser : null;
  if (!user) {
    const wait = auth.lockedFor(ip);
    if (wait) throw new HttpError(429, 'Too many failed attempts. Try again later.');
    const creds = parseBasicAuth(req.headers.authorization);
    if (!creds || !auth.verifyPassword(creds.username, creds.password)) {
      if (creds) auth.recordFailure(ip);
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="rdrive"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return res.end('Authentication required.');
    }
    user = creds.username;
  }

  const url = new URL(req.url, 'http://x');
  const clientPath = davSubpath(url.pathname);
  const full = files.resolve(user, clientPath);

  if (req.method === 'LOCK') {
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>infinity</D:depth>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>${token}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` });
    return res.end(body);
  }

  if (req.method === 'UNLOCK') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'PROPFIND') {
    const st = await files.stat(full);
    const isDir = st.isDirectory();
    const depth = String(req.headers.depth ?? '1').trim();
    const responses = [
      propResponseXml({
        href: encodeDavHref(clientPath, isDir),
        name: clientPath === '/' ? 'rdrive' : path.basename(full),
        isDir,
        size: st.size,
        mtime: st.mtime,
      }),
    ];
    if (isDir && depth !== '0') {
      const entries = await files.list(user, clientPath);
      for (const e of entries) {
        const subPath = (clientPath === '/' ? '' : clientPath) + '/' + e.name;
        responses.push(
          propResponseXml({
            href: encodeDavHref(subPath, e.type === 'folder'),
            name: e.name,
            isDir: e.type === 'folder',
            size: e.size || 0,
            mtime: new Date(e.modified),
          })
        );
      }
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${responses.join('\n')}\n</D:multistatus>`;
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end(xml);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const st = await files.stat(full);
    if (st.isDirectory()) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : 'rdrive WebDAV folder');
    }
    const file = await files.fileForDownload(user, clientPath);
    return serveDownload(req, res, file, false);
  }

  if (req.method === 'PUT') {
    if (clientPath === '/') throw new HttpError(400, 'Cannot overwrite root.');
    const existed = fs.existsSync(full);
    const segs = segments(clientPath);
    const name = segs.pop();
    const dirPath = '/' + segs.join('/');
    await files.upload(user, dirPath, name, req, { overwrite: true });
    if (onChanged) onChanged();
    res.writeHead(existed ? 204 : 201);
    return res.end();
  }

  if (req.method === 'MKCOL') {
    if (clientPath === '/') throw new HttpError(405, 'Root already exists.');
    if (fs.existsSync(full)) throw new HttpError(405, 'Already exists.');
    const segs = segments(clientPath);
    const name = segs.pop();
    const dirPath = '/' + segs.join('/');
    await files.mkdir(user, dirPath, name);
    if (onChanged) onChanged();
    res.writeHead(201);
    return res.end();
  }

  if (req.method === 'DELETE') {
    await files.trash(user, clientPath);
    if (onChanged) onChanged();
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'MOVE' || req.method === 'COPY') {
    const destHeader = req.headers.destination;
    if (!destHeader) throw new HttpError(400, 'Missing Destination header.');
    const destUrl = new URL(destHeader, 'http://x');
    if (!destUrl.pathname.startsWith('/dav')) throw new HttpError(502, 'Destination must be under /dav.');
    const dstPath = davSubpath(destUrl.pathname);
    const dstFull = files.resolve(user, dstPath);
    const existed = fs.existsSync(dstFull);
    const overwrite = String(req.headers.overwrite || 'T').toUpperCase() !== 'F';
    if (existed && !overwrite) throw new HttpError(412, 'Destination already exists.');
    if (existed && overwrite && dstFull !== full) {
      await fsp.rm(dstFull, { recursive: true, force: true });
    }
    if (req.method === 'MOVE') {
      await files.move(user, clientPath, dstPath);
    } else {
      await files.copy(user, clientPath, dstPath);
    }
    if (onChanged) onChanged();
    res.writeHead(existed ? 204 : 201);
    return res.end();
  }

  res.writeHead(405, { Allow: methods });
  res.end();
}

module.exports = { handleWebdav };
