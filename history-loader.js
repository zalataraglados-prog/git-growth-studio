/* The example is split only for transport and storage. No commit is discarded or combined. */
(function(root){
  'use strict';
  const VALID_PART=/^history-parts\/(?:commit|checkpoint)-\d{3}\.json$/;
  async function json(path){
    const response=await fetch('./'+path,{cache:'no-cache'});
    if(!response.ok) throw new Error('历史文件读取失败：'+path);
    return response.json();
  }
  async function load(){
    const manifest=await json('history-parts/manifest.json');
    if(manifest?.schema!==1 || !manifest.base || !Array.isArray(manifest.commits) || !Array.isArray(manifest.checkpoints)) throw Error('历史清单格式错误');
    for(const entry of [...manifest.commits,...manifest.checkpoints]){
      if(!VALID_PART.test(entry.path)||!Number.isSafeInteger(entry.count)||entry.count<1||entry.count>50) throw Error('历史分片清单无效');
    }
    const fetchList=async list=>{
      const parts=new Array(list.length);
      let cursor=0;
      await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{
        for(;;){
          const i=cursor++;if(i>=list.length)break;
          const a=await json(list[i].path);
          if(!Array.isArray(a)||a.length!==list[i].count) throw Error('历史分片缺失或条目数量错误：'+list[i].path);
          parts[i]=a;
        }
      }));
      return parts.flat();
    };
    const [commits,checkpoints]=await Promise.all([fetchList(manifest.commits),fetchList(manifest.checkpoints)]);
    if(commits.length!==manifest.base.totalCommits || commits.length!==new Set(commits.map(c=>c.sha)).size ||
       !manifest.base.validation?.passed || checkpoints.some((x,i)=>i>0 && checkpoints[i-1].index>=x.index)) throw Error('历史数量、提交唯一性或索引校验失败');
    return {...manifest.base,commits,checkpoints};
  }
  root.GitHistoryLoader={load};
})(typeof window!=='undefined'?window:globalThis);
