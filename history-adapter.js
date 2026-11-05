/* Validate imported Git history and derive repository-neutral presentation data. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GitHistoryAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const STATUSES = ['A', 'M', 'D', 'R'];
  const MAX_COMMITS = 30000;
  const MAX_PATHS = 150000;
  const fail = message => { throw new Error(`历史数据无效：${message}`); };
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const sameSet = (a, b) => a.size === b.size && [...a].every(path => b.has(path));

  function pathValue(value) {
    if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0') || value.startsWith('/') || value.split('/').some(bit => !bit || bit === '.' || bit === '..')) fail('文件路径格式不正确');
    return value;
  }
  function pathSet(value, label) {
    if (!Array.isArray(value)) fail(`${label} 必须是路径数组`);
    const result = new Set(value.map(pathValue));
    if (result.size !== value.length) fail(`${label} 包含重复路径`);
    if (result.size > MAX_PATHS) fail(`文件数超过 ${MAX_PATHS}；请在本地处理该仓库`);
    return result;
  }
  function checkCount(value, expected, label) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value !== expected)) fail(`${label} 与实际数据不符`);
  }
  function safeRepositoryUrl(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > 4096) fail('仓库地址格式不正确');
    let url;
    try { url = new URL(value); } catch (_) { fail('仓库地址必须是 HTTPS 地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) fail('仓库地址不能包含凭据、查询参数或非 HTTPS 协议');
    if (!url.hostname || /[\s\\]/.test(value)) fail('仓库地址格式不正确');
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (!path || path === '/' || path.split('/').some(bit => bit === '.' || bit === '..')) fail('仓库地址缺少仓库路径');
    return `${url.origin}${path}`;
  }
  function isGithub(url) {
    if (!url) return false;
    const parsed = new URL(url);
    return parsed.hostname === 'github.com' && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.pathname);
  }
  function textValue(value, fallback, max = 10000) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('文字字段格式不正确');
    return value;
  }
  function dateValue(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} 日期不正确`);
    return value;
  }
  function integerOrNull(value, label) {
    if (value === null || value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} 必须是非负整数`);
    return value;
  }
  function normalizeChange(raw) {
    if (!plain(raw) || !STATUSES.includes(raw.status)) fail('文件变更必须使用 A/M/D/R 状态');
    const change = {status:raw.status, path:pathValue(raw.path), previousPath:null};
    if (raw.status === 'R') change.previousPath = pathValue(raw.previousPath);
    else if (raw.previousPath != null) change.previousPath = pathValue(raw.previousPath);
    if (raw.status === 'R' && change.previousPath === change.path) fail('重命名前后路径相同');
    const added = integerOrNull(raw.added, '新增行数'), removed = integerOrNull(raw.removed, '删除行数');
    const binary = raw.binary === true ? true : raw.binary === false ? false : null;
    const available = raw.lineStatsAvailable === false ? false : binary === true || (added !== null && removed !== null);
    change.lineStatsAvailable = available;
    change.binary = binary;
    change.added = available && binary !== true ? added : null;
    change.removed = available && binary !== true ? removed : null;
    if (typeof raw.rawStatus === 'string' && /^[AMDRCT][0-9]{0,3}$/.test(raw.rawStatus)) change.rawStatus = raw.rawStatus;
    if (raw.submodule === true) change.submodule = true;
    if (raw.typeChanged === true) change.typeChanged = true;
    if (raw.modeChanged === true) change.modeChanged = true;
    if (Number.isInteger(raw.similarity) && raw.similarity >= 0 && raw.similarity <= 100) change.similarity = raw.similarity;
    if (raw.renameDetection === 'exact-oid' || raw.renameDetection === 'git-similarity-50') change.renameDetection = raw.renameDetection;
    return change;
  }
  function categoryFor(subject, first, merged) {
    if (first) return '项目起点';
    if (merged) return '合并记录';
    const match = /^\s*(feat|fix|docs|test|refactor|perf|build|ci|style|chore|revert)(?:\([^)]*\))?!?:/i.exec(subject);
    return match ? ({feat:'功能变更', fix:'问题修正', docs:'文档更新', test:'测试变更', refactor:'代码整理', perf:'性能相关', build:'构建变更', ci:'持续集成', style:'格式调整', chore:'工程维护', revert:'回退记录'})[match[1].toLowerCase()] : '代码更新';
  }
  function annotate(commit, first) {
    const modules = new Map();
    for (const change of commit.changes) {
      const module = change.path.includes('/') ? change.path.split('/')[0] : '根目录';
      modules.set(module, (modules.get(module) || 0) + 1);
    }
    commit.modules = [...modules].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).map(item => item[0]);
    commit.category = categoryFor(commit.subject, first, commit.isMerge);
    commit.title = commit.subject || `提交 ${commit.short}`;
    const s = commit.stats;
    if (!s.total) commit.summary = '本次提交相对第一父提交没有文件差异，仍保留独立播放位置。';
    else {
      const changes = [['A','新增'],['M','修改'],['D','删除'],['R','移动或重命名']].filter(([key]) => s[key]).map(([key,label]) => `${label} ${s[key]} 个文件`).join('，');
      commit.summary = `本次提交${changes}。`;
      if (commit.modules.length) commit.summary += `涉及 ${commit.modules.slice(0,3).join('、')}。`;
      if (!s.net && s.M) commit.summary += '文件总数未变，内容修改仍单独显示。';
    }
    commit.evidence = '依据导入的提交说明与文件差异；不推断功能完成情况';
  }

  function normalize(input) {
    const raw = plain(input) && plain(input.history) ? input.history : input;
    if (!plain(raw) || !Array.isArray(raw.commits) || !raw.commits.length) fail('没有可播放的提交');
    if (raw.commits.length > MAX_COMMITS) fail(`提交数超过 ${MAX_COMMITS}；请在本地处理完整仓库`);
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 2) fail('不支持这个历史数据版本');
    if (raw.historyMode !== undefined && raw.historyMode !== 'topo-all') fail('必须导入完整拓扑提交历史');
    if (raw.baseline !== undefined && pathSet(raw.baseline, '起始快照').size) fail('完整历史必须从空快照开始');
    const repoUrl = safeRepositoryUrl(raw.repoUrl);
    const head = raw.head;
    if (typeof head !== 'string' || !SHA.test(head)) fail('HEAD 必须是完整 Git 对象 ID');
    const indices = new Map(), parentUses = new Map();
    const commits = raw.commits.map((item,index) => {
      if (!plain(item) || typeof item.sha !== 'string' || !SHA.test(item.sha) || item.sha.length !== head.length) fail(`第 ${index+1} 个提交 ID 不正确`);
      if (indices.has(item.sha)) fail(`重复提交 ${item.sha.slice(0,8)}`);
      indices.set(item.sha,index);
      if (!Array.isArray(item.parents) || item.parents.some(parent => typeof parent !== 'string' || !SHA.test(parent)) || new Set(item.parents).size !== item.parents.length) fail(`提交 ${item.sha.slice(0,8)} 的父列表不正确`);
      for (const parent of item.parents) if (!indices.has(parent) || indices.get(parent) >= index) fail(`缺少父提交或拓扑顺序不正确：${item.sha.slice(0,8)}`);
      const parent = item.parents[0] || null;
      if (item.parent !== undefined && item.parent !== parent) fail('第一父提交不一致');
      if (parent) parentUses.set(parent,(parentUses.get(parent)||0)+1);
      if (!Array.isArray(item.changes)) fail(`提交 ${item.sha.slice(0,8)} 缺少文件差异`);
      const changes = item.changes.map(normalizeChange);
      if (new Set(changes.map(c=>c.path)).size !== changes.length) fail('同一提交包含重复的变更目标路径');
      checkCount(item.index,index,'提交序号');
      if (item.parentIndex !== undefined && item.parentIndex !== (parent ? indices.get(parent) : null)) fail('父提交序号不一致');
      if (item.isMerge !== undefined && item.isMerge !== (item.parents.length > 1)) fail('合并标记不一致');
      return {sha:item.sha, short:item.sha.slice(0,8), parents:[...item.parents], parent, parentIndex:parent ? indices.get(parent) : null, index, date:dateValue(item.date,'提交'), authorDate:dateValue(item.authorDate || item.date,'作者'), subject:textValue(item.subject,`提交 ${item.sha.slice(0,8)}`), isMerge:item.parents.length>1, changes};
    });
    if (commits[commits.length-1].sha !== head) fail('最后一个提交不是所选 HEAD');
    const reachable = new Set(), pending = [head];
    while (pending.length) { const sha = pending.pop(); if (reachable.has(sha)) continue; reachable.add(sha); pending.push(...commits[indices.get(sha)].parents); }
    if (reachable.size !== commits.length) fail('包含所选 HEAD 无法到达的提交');
    const rawCheckpoints = new Map();
    if (raw.checkpoints !== undefined) {
      if (!Array.isArray(raw.checkpoints)) fail('检查点格式不正确');
      for (const cp of raw.checkpoints) {
        if (!plain(cp) || !Number.isInteger(cp.index) || cp.index < 0 || cp.index >= commits.length || rawCheckpoints.has(cp.index)) fail('检查点序号不正确');
        rawCheckpoints.set(cp.index,pathSet(cp.paths,'检查点'));
      }
    }
    const snapshots = new Map(), display = new Set(), checkpoints = [];
    const totals = {A:0,M:0,D:0,R:0,added:0,removed:0,binary:0,total:0,net:0};
    const examples = {};
    let zeroNetUpdates=0, zeroNetWithEdits=0, contextSwitchCount=0;
    for (const c of commits) {
      const source = raw.commits[c.index];
      const parent = c.parent ? snapshots.get(c.parent) : new Set();
      if (!parent) fail('父提交快照缺失');
      const next = new Set(parent), removals = new Set(), additions = new Set();
      for (const change of c.changes) {
        if (change.status === 'M' && !parent.has(change.path)) fail(`修改了不存在的文件：${change.path}`);
        if (change.status === 'D' || change.status === 'R') {
          const previous = change.status === 'R' ? change.previousPath : change.path;
          if (!parent.has(previous) || removals.has(previous)) fail(`删除或移动源不存在：${previous}`);
          removals.add(previous);
        }
        if (change.status === 'A' || change.status === 'R') {
          if (additions.has(change.path)) fail('重复新增路径');
          additions.add(change.path);
        }
      }
      for (const path of removals) next.delete(path);
      for (const path of additions) { if (next.has(path)) fail(`新增或移动目标已存在：${path}`); next.add(path); }
      if (next.size > MAX_PATHS) fail(`文件数超过 ${MAX_PATHS}；请在本地处理该仓库`);
      if (!plain(source.transition)) fail(`提交 ${c.short} 缺少连续快照过渡`);
      const removed = pathSet(source.transition.remove,'过渡删除'), added = pathSet(source.transition.add,'过渡新增');
      for (const path of removed) if (!display.has(path) || added.has(path)) fail('连续快照删除了不存在的路径或含重复增删');
      for (const path of added) if (display.has(path)) fail('连续快照重复新增路径');
      for (const path of removed) display.delete(path);
      for (const path of added) display.add(path);
      if (!sameSet(display,next)) fail(`提交 ${c.short} 的真实父差异与播放快照不一致`);
      c.fileCount=next.size; c.parentFileCount=parent.size;
      checkCount(source.fileCount,c.fileCount,'文件数量'); checkCount(source.parentFileCount,c.parentFileCount,'父提交文件数量');
      c.transition={add:[...added].sort(),remove:[...removed].sort()};
      c.displayPreviousSha=c.index ? commits[c.index-1].sha : null;
      c.contextSwitch=c.displayPreviousSha!==c.parent;
      if (source.displayPreviousSha !== undefined && source.displayPreviousSha !== c.displayPreviousSha) fail('播放前序提交不一致');
      if (source.contextSwitch !== undefined && source.contextSwitch !== c.contextSwitch) fail('分支上下文标记不一致');
      const stats={A:0,M:0,D:0,R:0,added:0,removed:0,binary:0,total:c.changes.length,net:c.fileCount-c.parentFileCount};
      for (const change of c.changes) { stats[change.status]++; stats.added+=change.added||0; stats.removed+=change.removed||0; stats.binary+=change.binary===true ? 1 : 0; }
      if (stats.net!==stats.A-stats.D) fail('文件净变化不一致');
      if (source.stats !== undefined) { if (!plain(source.stats)) fail('提交统计格式不正确'); for (const key of Object.keys(stats)) checkCount(source.stats[key],stats[key],`提交 ${key} 统计`); }
      c.stats=stats; c.lineStatsAvailable=c.changes.every(change=>change.lineStatsAvailable); annotate(c,c.index===0);
      for (const key of Object.keys(totals)) totals[key]+=stats[key];
      if (stats.total && stats.net===0) { zeroNetUpdates++; examples.zeroNet ??= c.index; }
      if (stats.M && stats.net===0) { zeroNetWithEdits++; examples.zeroNetWithEdits ??= c.index; }
      if (stats.M && !stats.A && !stats.D && !stats.R) examples.onlyModified ??= c.index;
      if (stats.R) examples.renamed ??= c.index;
      if (stats.D) examples.deleted ??= c.index;
      if (c.isMerge) examples.merge ??= c.index;
      if (!stats.total) examples.empty ??= c.index;
      if (c.contextSwitch) { contextSwitchCount++; examples.contextSwitch ??= c.index; }
      if (rawCheckpoints.has(c.index) && !sameSet(next,rawCheckpoints.get(c.index))) fail(`检查点 ${c.index} 与提交快照不一致`);
      if (c.index%50===0 || c.index===commits.length-1) checkpoints.push({index:c.index,paths:[...next].sort()});
      if (parentUses.get(c.sha)) snapshots.set(c.sha,next);
      if (c.parent) { const left=parentUses.get(c.parent)-1; parentUses.set(c.parent,left); if (!left) snapshots.delete(c.parent); }
    }
    let firstParentCount=0, first=head;
    while (first) { firstParentCount++; first=commits[indices.get(first)].parent; }
    const mergeCount=commits.filter(c=>c.isMerge).length;
    for (const [key,value] of Object.entries({totalCommits:commits.length,allReachableCommitCount:commits.length,finalFileCount:display.size,mergeCount,nonMergeCount:commits.length-mergeCount,firstParentCount,zeroNetUpdates,zeroNetWithEdits,contextSwitchCount})) checkCount(raw[key],value,key);
    if (raw.totals !== undefined) { if (!plain(raw.totals)) fail('汇总统计格式不正确'); for (const key of Object.keys(totals)) checkCount(raw.totals[key],totals[key],`汇总 ${key}`); }
    const byDate=[...commits].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
    const fallbackName=repoUrl ? new URL(repoUrl).pathname.split('/').filter(Boolean).pop() : '导入的 Git 仓库';
    const name=textValue(raw.name,fallbackName,256), branch=textValue(raw.branch,'HEAD',256);
    return {schemaVersion:2,name,repoUrl,provider:isGithub(repoUrl)?'github':repoUrl?'generic':'local',branch,sourceRef:textValue(raw.sourceRef,branch,512),head,headDate:commits[commits.length-1].date,generatedAt:new Date().toISOString(),historyMode:'topo-all',historyLabel:`${branch} 可达完整提交历史 · 每个 SHA 独立播放`,historyNote:'每个提交独立保留，变化相对第一父提交计算，跨分支快照过渡单独记录。',totalCommits:commits.length,allReachableCommitCount:commits.length,firstParentCount,mergeCount,nonMergeCount:commits.length-mergeCount,contextSwitchCount,finalFileCount:display.size,startDate:byDate[0].date,endDate:byDate[byDate.length-1].date,baseline:[],checkpoints,totals,zeroNetUpdates,zeroNetWithEdits,lineStatsAvailable:commits.every(c=>c.lineStatsAvailable),renameDetection:raw.renameDetection==='git-similarity-50'?'git-similarity-50':raw.renameDetection==='exact-oid'?'exact-oid':'unspecified',validation:{passed:true,checkedCommits:commits.length,uniqueShaCoverage:true,parentDiffTreesChecked:commits.length,displayTransitionTreesChecked:commits.length,method:'重新校验全部提交拓扑、第一父差异、连续快照与统计的一致性；不凭输入的 passed 标记放行',source:'import-consistency-check',examples},commits};
  }

  function editorial(history) {
    if (!plain(history) || !Array.isArray(history.commits) || !history.commits.length) fail('没有可生成介绍的历史');
    const count=Math.min(12,history.commits.length), chosen=new Set();
    for (let i=0;i<count;i++) chosen.add(count===1?0:Math.round(i*(history.commits.length-1)/(count-1)));
    const github=isGithub(history.repoUrl);
    const milestones=[...chosen].map(index=>{
      const c=history.commits[index];
      const sourceEvidence=github?[{label:`提交 ${c.short}`,url:`${history.repoUrl}/commit/${c.sha}`}]:[];
      return {sha:c.sha,title:c.subject,summary:c.summary,why:`这是第 ${index+1} 个独立提交。文件统计和内容变化均来自这一条提交，章节按钮仅用于定位。`,tag:c.category,sourcePaths:[],sourceUrls:[],sourceEvidence,evidenceLevel:'提交与文件差异',confidence:'高'};
    });
    return {generic:true,hero:{eyebrow:'GIT GROWTH JOURNAL',title:history.name,line2:'让每次提交留下轨迹。',description:`沿着 ${history.totalCommits.toLocaleString('en-US')} 个独立提交，观看文件结构与内容修改的变化。`,status:'自动生成'},milestones,pillars:[],roadmap:[],evidence:{head:history.head,repoUrl:history.repoUrl,method:'按提交与文件差异生成描述，不推断产品能力'}};
  }
  return {normalize,editorial,safeRepositoryUrl,limits:{maxCommits:MAX_COMMITS,maxPaths:MAX_PATHS}};
});
