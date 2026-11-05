/* Presentation edits are separate from immutable Git history. Shared by editor and film. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GitProject = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const THEMES = Object.freeze({
    forest: Object.freeze({name:'林间绿',background:'#172821',foreground:'#d6decf',accent:'#b1c78b',A:'#b1c78b',M:'#c8b27c',D:'#b29183',R:'#aaa0bc'}),
    slate: Object.freeze({name:'暮色蓝',background:'#1c2732',foreground:'#d9e0e7',accent:'#9cbccb',A:'#9abeb5',M:'#c7b687',D:'#bb9692',R:'#aca7cf'}),
    dusk: Object.freeze({name:'暖砂棕',background:'#302821',foreground:'#e4dcd0',accent:'#c4b18d',A:'#b6bb90',M:'#d0b887',D:'#c19786',R:'#b9a5be'})
  });
  const own = (o,k) => !!o && Object.prototype.hasOwnProperty.call(o,k);
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clone = value => JSON.parse(JSON.stringify(value));
  const text = (value,fallback,max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max) : fallback;
  const number = (value,fallback,min,max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min,Math.min(max,value)) : fallback;
  const color = (value,fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  const bool = (value,fallback) => typeof value === 'boolean' ? value : fallback;
  function safeURL(value) {
    if (typeof value !== 'string' || value.length > 1000 || /[\u0000-\u0020\u007f]/.test(value)) return '';
    try { const url=new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
  }
  function defaults(history, editorial={}) {
    const name=text(history?.name,'我的 Git 影片',140) || '我的 Git 影片';
    const branch=text(history?.branch,'HEAD',100);
    return {
      version:1,
      copy:{brand:name.slice(0,60),title:name,subtitle:`${branch} · 每个提交，独立留痕`,description:text(editorial?.hero?.description,'从第一笔提交开始，看看文件、目录和想法如何逐步生长。',800),ctaLabel:'继续了解这个项目',ctaUrl:safeURL(history?.repoUrl || ''),footer:'让每一次提交，都留下可见的痕迹。'},
      appearance:{theme:'forest',background:THEMES.forest.background,foreground:THEMES.forest.foreground,accent:THEMES.forest.accent,textScale:1,showLabels:true,reducedMotion:false},
      playback:{speed:64},
      output:{aspect:'16:9',resolution:720,fps:60,introSeconds:2,outroSeconds:3,durationSeconds:0},
      about:{enabled:!!((editorial.pillars || []).length || (editorial.roadmap || []).length),title:'继续生长的方向',description:'从已有的进展，走向下一段旅程。',pillars:(editorial.pillars || []).slice(0,8).map(item=>({title:text(item.title,'',100),description:text(item.description,'',600)})),roadmap:(editorial.roadmap || []).slice(0,8).map(item=>({title:text(item.title,'',100),description:text(item.description,'',600),status:text(item.status,'',60)}))},
      stories:{}
    };
  }
  function normalize(raw, history, editorial={}) {
    const source=object(raw), base=defaults(history,editorial), result=clone(base);
    const copy=object(source.copy), appearance=object(source.appearance), playback=object(source.playback), output=object(source.output);
    for (const [key,max] of Object.entries({brand:60,title:140,subtitle:200,description:800,ctaLabel:160,footer:200})) result.copy[key]=text(copy[key],base.copy[key],max);
    for (const key of ['brand','title']) if(!result.copy[key].trim()) result.copy[key]=base.copy[key];
    result.copy.ctaUrl=own(copy,'ctaUrl') ? safeURL(copy.ctaUrl) : base.copy.ctaUrl;
    const theme=own(THEMES,appearance.theme) ? appearance.theme : 'forest';
    result.appearance={theme,background:color(appearance.background,THEMES[theme].background),foreground:color(appearance.foreground,THEMES[theme].foreground),accent:color(appearance.accent,THEMES[theme].accent),textScale:number(appearance.textScale,1,.8,1.4),showLabels:bool(appearance.showLabels,true),reducedMotion:bool(appearance.reducedMotion,false)};
    result.playback.speed=Math.round(number(playback.speed,64,.25,128)*100)/100;
    result.output={aspect:['16:9','9:16','1:1'].includes(output.aspect)?output.aspect:'16:9',resolution:[720,1080].includes(output.resolution)?output.resolution:720,fps:[30,60].includes(output.fps)?output.fps:60,introSeconds:number(output.introSeconds,2,0,10),outroSeconds:number(output.outroSeconds,3,0,10),durationSeconds:number(output.durationSeconds,0,0,7200)};
    const about=object(source.about);
    result.about={enabled:bool(about.enabled,base.about.enabled),title:text(about.title,base.about.title,140),description:text(about.description,base.about.description,800),pillars:[],roadmap:[]};
    for(const list of ['pillars','roadmap']) {
      const values=Array.isArray(about[list])?about[list]:base.about[list];
      result.about[list]=values.slice(0,8).map(value=>{const item=object(value);return {title:text(item.title,'',100),description:text(item.description,'',600),...(list==='roadmap'?{status:text(item.status,'',60)}:{})};});
    }
    const allowed=new Set((history?.commits || []).map(c=>c.sha));
    const stories=object(source.stories);
    for (const sha of Object.keys(stories)) {
      if (!allowed.has(sha)) continue;
      const input=object(stories[sha]), entry={};
      for (const [key,max] of Object.entries({title:200,summary:1200,why:800,tag:80})) if (own(input,key) && typeof input[key]==='string') entry[key]=text(input[key],'',max);
      if (typeof input.chapter==='boolean') entry.chapter=input.chapter;
      if (Object.keys(entry).length) result.stories[sha]=entry;
    }
    return result;
  }

  function normalizeEditorial(raw, history) {
    const commits=history?.commits || [];
    let generated;
    const adapter=typeof globalThis!=='undefined' ? globalThis.GitHistoryAdapter : null;
    if(adapter && typeof adapter.editorial==='function') generated=adapter.editorial(history);
    else {
      const count=Math.min(12,commits.length),chosen=new Set();
      for(let i=0;i<count;i++) chosen.add(count===1?0:Math.round(i*(commits.length-1)/(count-1)));
      generated={generic:true,hero:{title:history?.name || 'Git 影片',description:`沿着 ${commits.length} 个独立提交，观看文件结构与内容修改的变化。`},milestones:[...chosen].map(index=>{const c=commits[index];return {sha:c.sha,title:c.subject || c.title || '',summary:c.summary || '',why:`这是第 ${index+1} 个独立提交，文件变化按原始 Git 记录呈现。`,tag:c.category || '代码更新'};}),pillars:[],roadmap:[]};
    }
    if(!raw || typeof raw!=='object' || Array.isArray(raw)) return clone(generated);
    const source=object(raw),hero=object(source.hero),baseHero=object(generated.hero),allowed=new Set(commits.map(c=>c.sha));
    const result={generic:bool(source.generic,generated.generic),imported:true,hero:{},milestones:[],pillars:[],roadmap:[]};
    for(const [key,max] of Object.entries({eyebrow:160,title:200,line2:200,description:1200,status:120})) result.hero[key]=text(hero[key],text(baseHero[key],'',max),max);
    const notes=Array.isArray(source.milestones)?source.milestones:generated.milestones || [];
    if(notes.length>1000) throw new Error('导入文案的章节数量超过 1,000。请保留章节定位点，将逐条说明放在项目编辑数据中。');
    const seen=new Set();
    for(const value of notes) {
      const item=object(value);
      if(typeof item.sha!=='string' || !allowed.has(item.sha) || seen.has(item.sha)) continue;
      seen.add(item.sha);
      result.milestones.push({sha:item.sha,title:text(item.title,'',200),summary:text(item.summary,'',1200),why:text(item.why,'',800),tag:text(item.tag,'',80),userAuthored:true,evidenceLevel:'导入文案',confidence:'未核验',sourcePaths:[],sourceUrls:[]});
    }
    for(const list of ['pillars','roadmap']) {
      const values=Array.isArray(source[list])?source[list]:generated[list] || [];
      result[list]=values.slice(0,8).map(value=>{const item=object(value);return {title:text(item.title,'',100),description:text(item.description,'',600),...(list==='roadmap'?{status:text(item.status,'',60)}:{})};});
    }
    result.evidence={head:history?.head || '',method:'展示文案来自导入文件；SHA、文件统计与提交顺序仍由 Git 历史核验。'};
    return result;
  }

  function story(project,commit,editorial={}) {
    const milestone=(editorial.milestones || []).find(item=>item.sha===commit.sha);
    const generic='介绍来自本条提交的标题、目录与文件差异，保留原始记录供逐条查看。';
    const base={title:milestone?.title || commit.title || commit.subject || '独立提交',summary:milestone?.summary || commit.summary || '',why:milestone?.why || generic,tag:milestone?.tag || commit.category || '代码更新',chapter:!!milestone};
    const custom=project?.stories?.[commit.sha];
    if(custom && typeof custom==='object') for(const key of ['title','summary','why','tag','chapter']) if(own(custom,key)) base[key]=custom[key];
    return {...base,edited:!!custom || !!milestone?.userAuthored};
  }
  function mix(a,b,f) {
    return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-f)+parseInt(b.slice(i,i+2),16)*f).toString(16).padStart(2,'0')).join('');
  }
  function palette(project) {
    const settings=object(project?.appearance), theme=THEMES[settings.theme] || THEMES.forest;
    const background=color(settings.background,theme.background), foreground=color(settings.foreground,theme.foreground), accent=color(settings.accent,theme.accent);
    return {background,panel:mix(background,foreground,.035),line:mix(background,foreground,.16),text:foreground,foreground,muted:mix(background,foreground,.61),dim:mix(background,foreground,.41),accent,branch:mix(background,accent,.53),file:mix(background,accent,.7),directory:mix(accent,foreground,.36),A:accent,M:theme.M,D:theme.D,R:theme.R};
  }
  function chapters(project,history,editorial={}) {
    return (history?.commits || []).map((commit,index)=>({sha:commit.sha,index,...story(project,commit,editorial)})).filter(item=>item.chapter);
  }
  function draftKey(history) { return `git-growth-studio-v1:${history?.repoUrl || history?.name || 'local'}:${history?.head || 'unknown'}`; }
  return Object.freeze({version:1,themes:THEMES,defaults,normalize,normalizeEditorial,story,palette,chapters,draftKey,safeURL,clone});
});
