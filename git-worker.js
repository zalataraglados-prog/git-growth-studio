/* Git objects are parsed locally in a dedicated Worker. Public GitHub transport
 * uses this Site's read-only proxy; local bundles never leave the browser. */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({packBytes:100 * 1024 * 1024, commits:10000, paths:100000, headerBytes:1024 * 1024});
  const OID = /^[a-f0-9]{40}$/;
  const EMPTY = new Map();
  const decoder = new TextDecoder('utf-8');
  const noop = () => {};
  const bytesLabel = n => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  const failure = message => { throw new Error(message); };

  function repository(value) {
    if (typeof value !== 'string') failure('请输入 GitHub 公开仓库地址。');
    let input = value.trim();
    if (/^git@github\.com:/i.test(input)) input = input.replace(/^git@github\.com:/i, 'https://github.com/');
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) input = `https://github.com/${input}`;
    let url;
    try { url = new URL(input); } catch (_) { failure('仓库地址格式不正确，请使用 https://github.com/拥有者/仓库。'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) failure('在线导入仅接受不含凭据的 GitHub 公开仓库 HTTPS 地址；其他仓库请导入本地 .bundle。');
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(url.pathname);
    if (!match) failure('请填写仓库首页地址，分支名称请填在单独的分支框中。');
    const owner = match[1], name = match[2].replace(/\.git$/i, '');
    if (!name || [owner,name].some(s=>s==='.' || s==='..' || s.length>100)) failure('仓库名称格式不正确。');
    return {owner,name,url:`https://github.com/${owner}/${name}`};
  }

  function branch(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') failure('分支名称格式不正确。');
    const ref = value.trim();
    if (!ref || ref.length > 512 || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(s=>s.startsWith('.') || s.endsWith('.lock'))) failure('分支名称格式不正确。');
    return ref;
  }

  function dateOf(person) {
    const date = new Date(Number(person?.timestamp) * 1000);
    if (!Number.isFinite(date.getTime())) failure('Git 提交中包含无法解析的时间。');
    return date.toISOString();
  }

  function parseBundle(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength > LIMITS.packBytes) failure('本地 bundle 超过 100 MiB，请使用较小的仓库或在本地导出历史数据。');
    let boundary = -1;
    for (let i = 1; i < Math.min(bytes.length, LIMITS.headerBytes); i++) {
      if (bytes[i-1] === 10 && bytes[i] === 10) { boundary = i + 1; break; }
    }
    if (boundary < 0) failure('未找到完整 Git bundle 文件头；普通源码 ZIP 不包含提交历史。');
    const header = decoder.decode(bytes.subarray(0, boundary));
    const lines = header.trimEnd().split('\n');
    if (!/^# v[23] git bundle$/.test(lines.shift() || '')) failure('仅支持 Git v2/v3 的完整 .bundle 文件。');
    const refs = new Map();
    for (const line of lines) {
      if (line.startsWith('-')) failure('这是依赖其他历史的增量 bundle。请用 git bundle create history.bundle HEAD 生成完整文件。');
      if (line.startsWith('@')) {
        if (line !== '@object-format=sha1') failure('此 bundle 使用了当前不支持的过滤或对象格式；请导入完整 SHA-1 Git bundle。');
        continue;
      }
      const match = /^([a-f0-9]{40}) (.+)$/.exec(line);
      if (!match || /[\0\r]/.test(match[2]) || refs.has(match[2])) failure('Git bundle 的引用列表格式不正确。');
      refs.set(match[2], match[1]);
    }
    if (!refs.size || decoder.decode(bytes.subarray(boundary, boundary+4)) !== 'PACK' || bytes.length - boundary < 32) failure('Git bundle 缺少引用或完整 pack 对象。');
    const pack = bytes.subarray(boundary);
    const checksum = [...pack.subarray(pack.length-20)].map(b=>b.toString(16).padStart(2,'0')).join('');
    return {refs,pack,checksum};
  }

  function selectBundleRef(refs, requested) {
    const ref = branch(requested);
    if (ref) {
      for (const key of [ref,`refs/heads/${ref}`,`refs/remotes/${ref}`,`refs/tags/${ref}`]) {
        if (refs.has(key)) return {ref:key,oid:refs.get(key)};
      }
      failure(`bundle 中没有分支或引用“${ref}”。可用引用：${[...refs.keys()].slice(0,8).join('、')}`);
    }
    const key = refs.has('HEAD') ? 'HEAD' : refs.has('refs/heads/main') ? 'refs/heads/main' : refs.has('refs/heads/master') ? 'refs/heads/master' : [...refs.keys()].find(k=>k.startsWith('refs/heads/')) || refs.keys().next().value;
    return {ref:key,oid:refs.get(key)};
  }

  function httpClient(repo, {report=noop, fetchImpl=root.fetch?.bind(root), origin=root.location?.origin, signal} = {}) {
    if (!fetchImpl || !/^https?:\/\//.test(origin || '')) failure('请在在线页面中导入仓库链接；离线页面可以直接导入本地 bundle。');
    let received = 0;
    return {
      async request({url, method='GET', headers={}, body}) {
        const source = new URL(url);
        const prefix = `/${repo.owner}/${repo.name}`;
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const match = new RegExp(`^${escaped}(?:\\.git)?/(info/refs|git-upload-pack)$`).exec(source.pathname);
        if (source.protocol !== 'https:' || source.hostname !== 'github.com' || source.username || source.password || source.port || !match) failure('Git 请求超出了所选公开仓库范围。');
        const endpoint = match[1];
        if ((endpoint === 'info/refs' && (method !== 'GET' || source.search !== '?service=git-upload-pack')) || (endpoint === 'git-upload-pack' && (method !== 'POST' || source.search))) failure('仅支持读取 Git 提交的请求。');
        const destination = `${origin}/api/git/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${endpoint}${source.search}`;
        const safeHeaders = {};
        for (const [name,value] of Object.entries(headers)) {
          if (['accept','content-type','git-protocol'].includes(name.toLowerCase())) safeHeaders[name]=String(value);
        }
        let outgoing;
        if (body) {
          const chunks=[]; let length=0;
          const iterable = body instanceof Uint8Array || body instanceof ArrayBuffer ? [body] : body;
          for await (const chunk of iterable) {
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            length += bytes.length;
            if (length > 1024*1024) failure('Git 协商请求过大，已停止导入。');
            chunks.push(bytes);
          }
          outgoing = new Uint8Array(length); let offset=0;
          for (const chunk of chunks) { outgoing.set(chunk,offset); offset+=chunk.length; }
        }
        const response = await fetchImpl(destination,{method,headers:safeHeaders,body:outgoing,signal,redirect:'error'});
        if (!response.ok) {
          if (response.status===404 || response.status===401 || response.status===403) failure('无法读取这个公开仓库。请核对地址；私有仓库请改用本地 bundle 导入。');
          if (response.status===429) failure('Git 服务暂时限流，请稍后重试或导入本地 bundle。');
          failure(`Git 下载失败（HTTP ${response.status}），请稍后重试。`);
        }
        if (!response.body) failure('Git 服务返回了空响应。');
        const responseHeaders = Object.fromEntries(response.headers.entries());
        const reader = response.body.getReader();
        const responseBody = (async function* () {
          try {
            for (;;) {
              const {done,value}=await reader.read(); if(done) break;
              received += value.byteLength;
              if (received > LIMITS.packBytes) failure('仓库下载超过 100 MiB，已停止导入；没有截断或生成不完整历史。请使用较小的仓库或本地导出的历史数据。');
              report({phase:'download',message:`正在读取 Git 对象 · 已接收 ${bytesLabel(received)}`,loaded:received});
              yield value;
            }
          } finally { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
        })();
        return {url,method,headers:responseHeaders,body:responseBody,statusCode:response.status,statusMessage:response.statusText};
      }
    };
  }

  function change(status,path,oldEntry,newEntry) {
    const result = {status,path,added:null,removed:null,binary:null,lineStatsAvailable:false};
    if (oldEntry && newEntry && oldEntry.mode !== newEntry.mode) result.modeChanged=true;
    if (oldEntry && newEntry && oldEntry.type !== newEntry.type) result.typeChanged=true;
    if (oldEntry?.type==='commit' || newEntry?.type==='commit') result.submodule=true;
    return result;
  }

  function compareTrees(parent,current) {
    const edits=[], removed=new Map(), added=new Map();
    for (const [path,entry] of parent) {
      const next=current.get(path);
      if (!next) removed.set(path,entry);
      else if (entry.oid!==next.oid || entry.mode!==next.mode || entry.type!==next.type) edits.push(change('M',path,entry,next));
    }
    for (const [path,entry] of current) if(!parent.has(path)) added.set(path,entry);
    const oldOids=new Map(),newOids=new Map();
    for (const [path,entry] of removed) { const key=`${entry.type}:${entry.oid}`; const paths=oldOids.get(key)||[];paths.push(path);oldOids.set(key,paths); }
    for (const [path,entry] of added) { const key=`${entry.type}:${entry.oid}`; const paths=newOids.get(key)||[];paths.push(path);newOids.set(key,paths); }
    for (const [key,oldPaths] of oldOids) {
      const newPaths=newOids.get(key);
      // Duplicate identical blobs do not establish an unambiguous move.
      if (oldPaths.length===1 && newPaths?.length===1) {
        const before=oldPaths[0],after=newPaths[0];
        edits.push({...change('R',after,removed.get(before),added.get(after)),previousPath:before,similarity:100,renameDetection:'exact-oid'});
        removed.delete(before); added.delete(after);
      }
    }
    for (const [path,entry] of removed) edits.push(change('D',path,entry,null));
    for (const [path,entry] of added) edits.push(change('A',path,null,entry));
    return edits.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  }

  async function extractHistory({git,fs,dir,head,repoUrl='',name='',branch:branchName='HEAD',report=noop}) {
    if (!OID.test(head)) failure('当前仅支持 SHA-1 Git 仓库。');
    let cache={};
    const commits=new Map(), colors=new Map(), ordered=[], stack=[{oid:head,parentIndex:0,entered:false}];
    report({phase:'commits',message:'正在遍历所有父提交，保留每个独立 SHA。',loaded:0});
    while(stack.length) {
      const frame=stack[stack.length-1];
      if(!frame.entered) {
        if(commits.size>=LIMITS.commits) failure(`提交超过 ${LIMITS.commits.toLocaleString('zh-CN')} 条，已停止导入；没有合并或省略提交。`);
        const result=await git.readCommit({fs,dir,oid:frame.oid,cache});
        const c=result.commit;
        if(!Array.isArray(c.parent) || c.parent.some(oid=>!OID.test(oid)) || !OID.test(c.tree)) failure('Git 提交引用格式不正确或历史不完整。');
        if(new Set(c.parent).size!==c.parent.length) failure('Git 提交包含重复父引用。');
        commits.set(frame.oid,c);colors.set(frame.oid,1);frame.entered=true;
        report({phase:'commits',message:`已读取 ${commits.size.toLocaleString('zh-CN')} 个独立提交`,loaded:commits.size});
      }
      const c=commits.get(frame.oid);
      if(frame.parentIndex<c.parent.length) {
        const parent=c.parent[frame.parentIndex++], color=colors.get(parent)||0;
        if(color===1) failure('Git 历史包含循环引用，无法生成完整时间线。');
        if(color===0) stack.push({oid:parent,parentIndex:0,entered:false});
      } else { colors.set(frame.oid,2);ordered.push(frame.oid);stack.pop(); }
    }
    const treeCache=new Map(),snapshotCache=new Map(),seenPaths=new Set();
    async function treeEntries(oid) {
      if(treeCache.has(oid)) return treeCache.get(oid);
      const {tree}=await git.readTree({fs,dir,oid,cache});
      if(!Array.isArray(tree)) failure('Git 目录对象不完整。');
      for(const entry of tree) {
        if(!entry.path || entry.path==='.' || entry.path==='..' || /[\0/]/.test(entry.path) || !OID.test(entry.oid) || !['tree','blob','commit'].includes(entry.type)) failure('Git 目录中存在无法解析的路径或对象。');
      }
      if(treeCache.size>=12000) treeCache.delete(treeCache.keys().next().value);
      treeCache.set(oid,tree);return tree;
    }
    async function snapshot(treeOid) {
      if(snapshotCache.has(treeOid)) { const hit=snapshotCache.get(treeOid);snapshotCache.delete(treeOid);snapshotCache.set(treeOid,hit);return hit; }
      const paths=new Map(),pending=[{oid:treeOid,prefix:'',depth:0}];
      while(pending.length) {
        const item=pending.pop();
        if(item.depth>512) failure('仓库目录层级过深，浏览器无法继续解析。');
        const entries=await treeEntries(item.oid);
        for(const entry of entries) {
          const full=item.prefix+entry.path;
          if(full.length>16384) failure('仓库中存在过长的文件路径。');
          if(entry.type==='tree') pending.push({oid:entry.oid,prefix:full+'/',depth:item.depth+1});
          else {
            if(paths.has(full)) failure('Git 目录中存在重复文件路径。');
            paths.set(full,{oid:entry.oid,mode:entry.mode,type:entry.type});seenPaths.add(full);
            if(paths.size>LIMITS.paths || seenPaths.size>LIMITS.paths) failure(`历史文件路径超过 ${LIMITS.paths.toLocaleString('zh-CN')} 个，已停止导入；没有生成截断结果。`);
          }
        }
      }
      if(snapshotCache.size>=5) snapshotCache.delete(snapshotCache.keys().next().value);
      snapshotCache.set(treeOid,paths);return paths;
    }
    const output=[];let previous=EMPTY;
    for(let index=0;index<ordered.length;index++) {
      const sha=ordered[index],c=commits.get(sha),parent=c.parent[0]||null;
      const current=await snapshot(c.tree),before=parent?await snapshot(commits.get(parent).tree):EMPTY;
      const changes=compareTrees(before,current);
      const transition={add:[],remove:[]};
      for(const path of previous.keys()) if(!current.has(path)) transition.remove.push(path);
      for(const path of current.keys()) if(!previous.has(path)) transition.add.push(path);
      transition.add.sort();transition.remove.sort();
      output.push({sha,short:sha.slice(0,8),parent,parents:[...c.parent],index,date:dateOf(c.committer),authorDate:dateOf(c.author),subject:c.message.split('\n')[0].trim()||`提交 ${sha.slice(0,8)}`,isMerge:c.parent.length>1,fileCount:current.size,parentFileCount:before.size,changes,transition,contextSwitch:index>0&&ordered[index-1]!==parent,displayPreviousSha:index?ordered[index-1]:null,lineStatsAvailable:false});
      previous=current;
      report({phase:'trees',message:`正在核对文件变化 · ${index+1} / ${ordered.length}`,loaded:index+1,total:ordered.length});
    }
    cache=null;treeCache.clear();snapshotCache.clear();
    return {schemaVersion:2,historyMode:'topo-all',head,name,repoUrl,branch:branchName,sourceRef:branchName,baseline:[],renameDetection:'exact-oid',commits:output};
  }

  async function importBundle(request,{git,fs,dir,report=noop}) {
    const file=request.file;
    if(!file || typeof file.arrayBuffer!=='function') failure('请选择完整的 .bundle 文件。');
    if(file.size>LIMITS.packBytes) failure('本地 bundle 超过 100 MiB，无法在此浏览器导入。');
    report({phase:'bundle',message:'正在本地读取 bundle，文件不会上传到服务器。'});
    const parsed=parseBundle(await file.arrayBuffer()),selected=selectBundleRef(parsed.refs,request.ref);
    await git.init({fs,dir,defaultBranch:'main'});
    const relative=`.git/objects/pack/pack-${parsed.checksum}.pack`;
    await fs.promises.writeFile(`${dir}/${relative}`,parsed.pack);
    report({phase:'indexing',message:'正在为本地 Git 对象建立索引。'});
    await git.indexPack({fs,dir,filepath:relative,onProgress:event=>report({phase:'indexing',message:`正在建立对象索引 · ${event.loaded} / ${event.total}`,loaded:event.loaded,total:event.total})});
    // Read directly from the selected object; a bundle may advertise an annotated tag.
    const resolved=await git.readCommit({fs,dir,oid:selected.oid});
    return extractHistory({git,fs,dir,head:resolved.oid,name:request.name || String(file.name||'本地 Git 仓库').replace(/\.bundle$/i,''),branch:selected.ref.replace(/^refs\/heads\//,''),report});
  }

  async function importClone(request,{git,fs,dir,report=noop,origin,fetchImpl}) {
    const repo=repository(request.url),ref=branch(request.ref);
    report({phase:'download',message:'正在连接公开 GitHub 仓库并读取完整提交历史。'});
    await git.clone({fs,http:httpClient(repo,{report,origin,fetchImpl}),dir,url:repo.url,singleBranch:true,noCheckout:true,noTags:true,...(ref?{ref}:{}),onProgress:event=>report({phase:'indexing',message:`正在解析 Git 对象 · ${event.loaded} / ${event.total}`,loaded:event.loaded,total:event.total})});
    const head=await git.resolveRef({fs,dir,ref:'HEAD'});
    const currentBranch=await git.currentBranch({fs,dir,fullname:false});
    return extractHistory({git,fs,dir,head,repoUrl:repo.url,name:request.name||repo.name,branch:currentBranch||ref||'HEAD',report});
  }

  function deleteDatabase(name) {
    return new Promise(resolve=>{
      const timer=setTimeout(()=>resolve(false),2000);
      try {
        const request=root.indexedDB.deleteDatabase(name);
        request.onsuccess=()=>{clearTimeout(timer);resolve(true);};
        request.onerror=()=>{clearTimeout(timer);resolve(false);};
        request.onblocked=()=>{};
      } catch (_) { clearTimeout(timer);resolve(false); }
    });
  }

  if(typeof module==='object' && module.exports) {
    module.exports={LIMITS,repository,branch,parseBundle,selectBundleRef,httpClient,compareTrees,extractHistory,importBundle,importClone};
    return;
  }
  // Offline exports prepend these exact, vendored scripts to a Blob Worker.
  if(!root.git) importScripts('./vendor/isomorphic-git.js');
  if(!root.LightningFS) importScripts('./vendor/lightning-fs.js');
  if(!root.GitHistoryAdapter) importScripts('./history-adapter.js');
  let busy=false;
  root.onmessage=async event=>{
    const request=event.data||{},id=request.id;
    if(busy) { root.postMessage({id,type:'error',message:'已有导入正在进行，请先取消或等待完成。'});return; }
    if(!['clone','bundle'].includes(request.action)) { root.postMessage({id,type:'error',message:'不支持的 Git 导入方式。'});return; }
    busy=true;
    const name=`git-growth-${Date.now()}-${root.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`;
    const names=[name,name+'_lock'];
    root.postMessage({id,type:'database',name,names});
    let fs,lastProgress=0,lastPhase='',result,error;
    const report=progress=>{
      const now=Date.now();
      if(now-lastProgress<120 && progress.phase===lastPhase && progress.loaded!==progress.total) return;
      lastProgress=now;lastPhase=progress.phase;root.postMessage({id,type:'progress',...progress});
    };
    try {
      if(!root.indexedDB) failure('此浏览器无法使用临时存储，请启用 IndexedDB 或换一个浏览器。');
      fs=new root.LightningFS(name,{wipe:true});
      const dependencies={git:root.git,fs,dir:'/repository',report};
      const raw=request.action==='bundle'?await importBundle(request,dependencies):await importClone(request,dependencies);
      report({phase:'validate',message:'正在校验每个 SHA、父提交差异与连续快照。',loaded:raw.commits.length,total:raw.commits.length});
      result=root.GitHistoryAdapter.normalize(raw);
    } catch (caught) {
      root.console?.error('Git import failed:',caught);
      const message=String(caught?.message||caught||'未知错误');
      error=/Could not find|MissingObject|Object.*not found|ENOENT.*objects/i.test(message)?'Git 历史缺少所需对象，请使用完整仓库或重新生成自包含 bundle。':message.slice(0,800);
    } finally {
      if(fs) {
        try { await fs.promises.flush(); } catch (_) {}
        try {
          // Public backend reinitialization closes the former IDB and its mutex.
          await fs.promises.init(name,{backend:new root.LightningFS.MemoryBackend(),defer:true});
        } catch (_) {}
      }
      await Promise.all(names.map(deleteDatabase));
      busy=false;
    }
    if(error) root.postMessage({id,type:'error',message:error});
    else root.postMessage({id,type:'result',history:result});
  };
})(typeof self!=='undefined'?self:globalThis);
