import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url),'utf8'));
test('all frozen example commits and exact checkpoints are present, without squashing',async()=>{
  const m=await read('history-parts/manifest.json');
  const all=async records=>(await Promise.all(records.map(async r=>{
    const items=await read(r.path);
    assert.equal(items.length,r.count);
    return items;
  }))).flat();
  const commits=await all(m.commits), checkpoints=await all(m.checkpoints);
  assert.equal(commits.length,m.base.totalCommits);
  assert.equal(commits.length,1367);
  assert.equal(new Set(commits.map(c=>c.sha)).size,commits.length);
  assert.equal(checkpoints.length,29);
  assert.equal(m.base.validation.passed,true);
  assert.equal(commits.at(-1).sha,m.base.head);
  assert.equal(checkpoints.at(-1).index<=commits.length-1,true);
});
