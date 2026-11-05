import { createServer as createHttpServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 100 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
};
const USERNAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

/** Strict, deterministic route validation. Never accepts an upstream URL supplied by callers. */
export function parseGitRoute(pathname, search, method) {
  const m = /^\/api\/git\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack)$/.exec(pathname);
  if (!m) return null;
  const [,owner, repo, action] = m;
  if (![owner, repo].every(s => !['.', '..'].includes(s)) ||
      !USERNAME.test(owner) || !REPOSITORY.test(repo)) return null;
  if (action === 'info/refs' && (method !== 'GET' || search !== '?service=git-upload-pack')) return null;
  if (action === 'git-upload-pack' && (method !== 'POST' || search !== '')) return null;
  return { owner, repo, action, upstream: `https://github.com/${owner}/${repo}.git/${action}${search}` };
}

function fail(res, status, msg) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(msg);
}

async function readBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST) throw Object.assign(new Error('Git negotiation request exceeds 1 MiB'),{code:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function gitProxy(req, res, route, upstreamFetch) {
  let body;
  try { if (req.method === 'POST') body = await readBody(req); }
  catch (err) { return fail(res, err.code || 400, err.message); }
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 90_000);
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const h = {'user-agent':'git-growth-studio/0.1'};
    if (route.action === 'git-upload-pack') {
      h['content-type'] = 'application/x-git-upload-pack-request';
      h['accept'] = 'application/x-git-upload-pack-result';
    } else h['accept'] = 'application/x-git-upload-pack-advertisement';
    const protocol = req.headers['git-protocol'];
    if (typeof protocol === 'string' && /^version=[012]$/.test(protocol)) h['git-protocol'] = protocol;
    const response = await upstreamFetch(route.upstream, {method:req.method,headers:h,body,signal:abort.signal,redirect:'error'});
    if (!response.ok || !response.body) return fail(res, response.status || 502, 'Public GitHub Git fetch failed');
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (!/^application\/x-git-upload-pack-(advertisement|result)(?:;|$)/i.test(contentType)) return fail(res,502,'Unexpected GitHub media type');
    const advertised = Number(response.headers.get('content-length') || 0);
    if (advertised > MAX_RESPONSE) return fail(res,413,'Git response exceeds 100 MiB');
    res.writeHead(200, {'content-type':contentType,'cache-control':'no-store','x-content-type-options':'nosniff'});
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_RESPONSE) { abort.abort(); res.destroy(); return; }
      if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    if (!res.destroyed) fail(res, 502, 'GitHub connection failed');
  } finally { clearTimeout(timeout); }
}

/** Only serve checked-in front-end assets, not server implementation or incidental files. */
const allowed = new Set([
  'index.html','style.css','cinema.css','import.css','studio.css','app-studio.css',
  'history-adapter.js','project-state.js','motion.js','film.js','render.js','studio.js',
  'import.js','app.js','git-worker.js','history.json','editorial.json',
  'vendor/isomorphic-git.js','vendor/lightning-fs.js','vendor/mediabunny.js','history-loader.js',
]);

export function createAppServer({upstreamFetch=fetch}={}) {
  return createHttpServer(async (req,res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return fail(res,400,'Malformed URL'); }
    if (url.pathname.startsWith('/api/git/')) {
      const route = parseGitRoute(url.pathname, url.search, req.method);
      if (!route) return fail(res, 400, 'Invalid Git read request');
      return gitProxy(req,res,route,upstreamFetch);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res,405,'Method Not Allowed');
    let name;
    try { name=decodeURIComponent(url.pathname.replace(/^\//,'') || 'index.html'); }
    catch { return fail(res,400,'Invalid path encoding'); }
    if (!(allowed.has(name) || /^history-parts\/(?:manifest|commit-\d{3}|checkpoint-\d{3})\.json$/.test(name)) || url.search) return fail(res,404,'Not Found');
    const path = resolve(ROOT, name);
    if (!(path.startsWith(ROOT + sep))) return fail(res,404,'Not Found');
    try {
      const stat = await fs.stat(path);
      res.writeHead(200, {'content-type':MIME[extname(path)] || 'application/octet-stream',
        'content-length':stat.size, 'x-content-type-options':'nosniff', 'cache-control':'no-cache'});
      if (req.method==='HEAD') res.end(); else createReadStream(path).pipe(res);
    } catch { fail(res,404,'Not Found'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1';
  createAppServer().listen(port,host,()=>console.log(`Git Growth Studio → http://${host}:${port}`));
}
