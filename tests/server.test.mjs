import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGitRoute, createAppServer} from '../server/server.mjs';

test('Git read-only routes are narrowly scoped', () => {
  const route = parseGitRoute('/api/git/octocat/Hello-World/info/refs','?service=git-upload-pack','GET');
  assert.equal(route.upstream,'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack');
  assert.equal(parseGitRoute('/api/git/octocat/Hello-World/git-upload-pack','','POST')?.action,'git-upload-pack');
  for (const [path, query, method] of [
    ['/api/git/../repo/git-upload-pack','','POST'],
    ['/api/git/a/b/git-upload-pack?x=1','','POST'],
    ['/api/git/a/b/info/refs','?service=git-receive-pack','GET'],
    ['/api/git/a/b/git-receive-pack','','POST'],
    ['/api/git/a/b/git-upload-pack','','GET'],
    ['/api/git/a/b/info/refs','','GET'],
    ['/api/git/a/b/info/refs','?service=git-upload-pack','POST']
  ]) assert.equal(parseGitRoute(path, query, method),null, `${method} ${path}${query}`);
});

test('HTTP server serves assets but never exposes server source', async () => {
  const server = createAppServer({upstreamFetch: async() => {throw new Error('network must not be touched')}});
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let r=await fetch(`${url}/index.html`); assert.equal(r.status,200); assert.match(await r.text(),/Git 生长影片/);
    r=await fetch(`${url}/server/server.mjs`);assert.equal(r.status,404);
    r=await fetch(`${url}/api/git/a/b/info/refs?service=git-receive-pack`);assert.equal(r.status,400);
    r=await fetch(`${url}/git-worker.js`);assert.equal(r.status,200);
  } finally { await new Promise(done=>server.close(done)); }
});
