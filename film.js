/* Shared deterministic video composition. Preview and export render the same frames. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GitFilm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const number = value => Number(value).toLocaleString('en-US');
  const DEFAULT_PALETTE = {background:'#101d18',panel:'#172821',line:'#32473b',text:'#dce4d3',muted:'#95a58f',dim:'#798d7a',A:'#b1c78b',M:'#c8b27c',D:'#b29183',R:'#aaa0bc',accent:'#b1c78b'};
  const FONT = '"Noto Sans CJK SC", "Microsoft YaHei", system-ui, sans-serif';
  const MONO = 'ui-monospace, "SFMono-Regular", Consolas, "Noto Sans CJK SC", "Microsoft YaHei", monospace';

  function plan(project, history) {
    const commits = history?.commits;
    if (!Array.isArray(commits) || !commits.length) throw new Error('请先导入包含提交历史的项目。');
    if (new Set(commits.map(c => c.sha)).size !== commits.length) throw new Error('提交历史存在重复 SHA，无法渲染。');
    const settings = project?.output || {}, fps = Number(settings.fps) === 30 ? 30 : 60;
    const side = Number(settings.resolution) === 1080 ? 1080 : 720;
    const aspect = ['16:9','9:16','1:1'].includes(settings.aspect) ? settings.aspect : '16:9';
    const width = aspect === '16:9' ? side * 16 / 9 : side;
    const height = aspect === '9:16' ? side * 16 / 9 : side;
    const introFrames = Math.round(clamp(finite(settings.introSeconds, 2), 0, 30) * fps);
    const outroFrames = Math.round(clamp(finite(settings.outroSeconds, 3), 0, 30) * fps);
    const speed = clamp(finite(project?.playback?.speed, 64), .25, 128);
    const requestedDurationSeconds = finite(settings.durationSeconds, 0) > 0
      ? finite(settings.durationSeconds, 0)
      : commits.length * 2.2 / speed + (introFrames + outroFrames) / fps;
    const requestedFrames = Math.max(1, Math.round(requestedDurationSeconds * fps));
    // Each independent SHA receives one or more whole frames; short targets extend.
    const frameCount = Math.max(requestedFrames, introFrames + commits.length + outroFrames);
    if (!Number.isSafeInteger(frameCount) || frameCount > 10000000) throw new Error('影片时长过长，请提高倍率或缩短时长。');
    const commitFrames = frameCount - introFrames - outroFrames;
    const spans = commits.map((commit, index) => {
      const startFrame = introFrames + Math.floor(index * commitFrames / commits.length);
      const endFrame = introFrames + Math.floor((index + 1) * commitFrames / commits.length) - 1;
      return {index, sha:commit.sha, startFrame, endFrame, frames:endFrame - startFrame + 1};
    });
    return {width:Math.round(width),height:Math.round(height),aspect,fps,speed,introFrames,outroFrames,commitFrames,frameCount,requestedDurationSeconds,durationSeconds:frameCount / fps,extended:frameCount > requestedFrames,spans};
  }

  function frameState(filmPlan, frame) {
    const current = clamp(Math.floor(finite(frame, 0)), 0, filmPlan.frameCount - 1);
    let phase = 'commits', index;
    if (current < filmPlan.introFrames) { phase = 'intro'; index = 0; }
    else if (current >= filmPlan.frameCount - filmPlan.outroFrames) { phase = 'outro'; index = filmPlan.spans.length - 1; }
    else {
      let lo = 0, hi = filmPlan.spans.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (filmPlan.spans[mid].endFrame < current) lo = mid + 1; else hi = mid;
      }
      index = lo;
    }
    const span = filmPlan.spans[index];
    return {frame:current,frames:filmPlan.frameCount,phase,index,sha:span.sha,seconds:current / filmPlan.fps,progress:(current + 1) / filmPlan.frameCount,localFrame:clamp(current - span.startFrame, 0, span.frames - 1),span};
  }

  function applyCommit(paths, commit) {
    if (commit.transition) {
      for (const path of commit.transition.remove || []) paths.delete(path);
      for (const path of commit.transition.add || []) paths.add(path);
    } else {
      for (const change of commit.changes || []) {
        if (change.status === 'D') paths.delete(change.path);
        if (change.status === 'R' && change.previousPath) paths.delete(change.previousPath);
      }
      for (const change of commit.changes || []) if (change.status !== 'D') paths.add(change.path);
    }
    if (paths.size !== commit.fileCount) throw new Error(`文件快照不一致：${commit.short || commit.sha}`);
  }

  function canvasFactory(width, height) {
    if (typeof document === 'undefined') throw new Error('请提供 Canvas 创建方法。');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
  }
  function text(ctx, value, x, y, size, color, family = FONT, weight = 400) {
    ctx.fillStyle = color; ctx.font = `${weight} ${size}px ${family}`; ctx.textBaseline = 'alphabetic'; ctx.fillText(String(value || ''), x, y);
  }
  function wrap(ctx, value, width) {
    const result = []; let line = '';
    for (const char of Array.from(String(value || ''))) {
      if (char === '\n') { result.push(line); line = ''; continue; }
      if (line && ctx.measureText(line + char).width > width) {
        if (/^[，。！？、；：,.!?;:)\]】）》]$/.test(char)) {const chars=Array.from(line);const carry=chars.pop();result.push(chars.join('').trimEnd());line=carry+char;}
        else {result.push(line.trimEnd());line=char.trimStart();}
      }
      else line += char;
    }
    if (line) result.push(line.trimEnd());
    return result;
  }
  function paragraph(ctx, value, x, y, width, size, lineHeight, maxLines, color, weight = 400, family = FONT) {
    ctx.font = `${weight} ${size}px ${family}`;
    const all = wrap(ctx, value, width), visible = all.slice(0, maxLines);
    if (all.length > maxLines && visible.length) {
      let last = visible[visible.length - 1];
      while (last && ctx.measureText(last + '…').width > width) last = Array.from(last).slice(0, -1).join('');
      visible[visible.length - 1] = last + '…';
    }
    visible.forEach((line, i) => text(ctx, line, x, y + i * lineHeight, size, color, family, weight));
    return visible.length * lineHeight;
  }
  function line(ctx, x, y, width, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke();
  }

  class Compositor {
    constructor(options) {
      this.history = options.history; this.editorial = options.editorial || {};
      this.project = options.project || {}; this.plan = plan(this.project, this.history);
      this.canvas = options.canvas || (options.createCanvas || canvasFactory)(this.plan.width, this.plan.height);
      this.canvas.width = this.plan.width; this.canvas.height = this.plan.height;
      this.ctx = this.canvas.getContext('2d', {alpha:false});
      if (!this.ctx) throw new Error('浏览器无法创建影片画布。');
      this.projectApi = options.projectApi || root.GitProject;
      this.palette = {...DEFAULT_PALETTE,...(this.projectApi?.palette(this.project) || {})};
      this.copy = this.project.copy || {}; this.scale = Math.min(this.plan.width, this.plan.height) / 720;
      this.textScale = clamp(finite(this.project.appearance?.textScale, 1), .8, 1.4);
      this.portrait = this.plan.aspect !== '16:9';
      const w = this.plan.width / this.scale, h = this.plan.height / this.scale;
      this.graphBox = this.portrait ? {x:30,y:146,width:w-60,height:this.plan.aspect==='9:16'?565:290} : {x:32,y:126,width:776,height:500};
      this.graph = (options.createCanvas || canvasFactory)(Math.round(this.graphBox.width * this.scale), Math.round(this.graphBox.height * this.scale));
      this.clock = 0; this.index = -1; this.paths = new Set(this.history.baseline || []);
      const Motion = options.Motion || root.StardewMotion;
      if (!Motion) throw new Error('动画渲染器尚未载入。');
      this.motion = new Motion(this.graph,{autoStart:false,externalPlayback:true,now:()=>this.clock,width:this.graphBox.width,height:this.graphBox.height,pixelRatio:this.scale,reducedMotion:!!this.project.appearance?.reducedMotion});
      this.motion.initialize(this.history);
      this.motion.setAppearance?.({palette:this.palette,showLabels:this.project.appearance?.showLabels !== false,reducedMotion:!!this.project.appearance?.reducedMotion,label:this.copy.brand || this.copy.title || this.history.name});
      this.milestones = new Map((this.editorial.milestones || []).map(m=>[m.sha,m]));
    }

    story(commit) {
      if (this.projectApi?.story) return this.projectApi.story(this.project,commit,this.editorial);
      const original = this.milestones.get(commit.sha), custom = this.project.stories?.[commit.sha] || {};
      return {...{title:original?.title || commit.title || commit.subject,summary:original?.summary || commit.summary || '',why:original?.why || commit.why || '',tag:original?.tag || commit.category || '独立提交'},...custom};
    }

    moveTo(index) {
      if (index < this.index) { this.index = -1; this.paths = new Set(this.history.baseline || []); this.motion.initialize(this.history); }
      while (this.index < index) {
        this.index++;
        const span = this.plan.spans[this.index], commit = this.history.commits[this.index];
        this.clock = span.startFrame * 1000 / this.plan.fps;
        applyCommit(this.paths, commit);
        this.motion.setFrame(commit,this.paths,{duration:Math.min(900,span.frames * 1000 / this.plan.fps),playing:true,immediate:span.frames <= 3 || this.project.appearance?.reducedMotion});
      }
    }

    render(frame) {
      const state = frameState(this.plan,frame), {width,height,fps}=this.plan, c=this.ctx, p=this.palette;
      this.moveTo(state.index);
      this.clock = state.frame * 1000 / fps;
      c.setTransform(1,0,0,1,0,0); c.globalAlpha=1; c.clearRect(0,0,width,height); c.fillStyle=p.background; c.fillRect(0,0,width,height);
      c.save(); c.scale(this.scale,this.scale);
      const w=width/this.scale,h=height/this.scale;
      if (state.phase === 'intro') this.drawIntro(c,w,h,state);
      else {
        const localProgress=(state.localFrame + 1) / state.span.frames;
        this.motion.setPlayback({playing:state.phase==='commits',speed:this.plan.speed,progress:localProgress});
        this.motion.renderAt(this.clock);
        this.drawHeader(c,w,state);
        c.drawImage(this.graph,this.graphBox.x,this.graphBox.y,this.graphBox.width,this.graphBox.height);
        this.drawStory(c,w,h,state);
        if (state.phase === 'outro') this.drawOutro(c,w,h,state);
      }
      this.drawFooter(c,w,h,state);
      c.restore(); return state;
    }

    drawIntro(c,w,h,state) {
      const p=this.palette, copy=this.copy, center=w/2;
      const settle=this.project.appearance?.reducedMotion?1:clamp((state.frame+1)/Math.max(1,this.plan.fps*.7),0,1);
      const offset=(1-settle)*9;
      c.globalAlpha=.45+.55*settle; c.textAlign='center';
      text(c,copy.brand || this.history.name,center,h*.28+offset,15,p.accent||p.A,MONO);
      c.textAlign='left';
      const titleWidth=Math.min(w-80,950), titleSize=(this.portrait?39:48)*this.textScale;
      c.font=`600 ${titleSize}px ${FONT}`;
      const titleLines=wrap(c,copy.title||this.history.name,titleWidth).slice(0,this.portrait?3:2);
      c.textAlign='center'; titleLines.forEach((value,i)=>text(c,value,center,h*.39+offset+i*titleSize*1.3,titleSize,p.text,FONT,600));
      c.textAlign='left';
      const descWidth=Math.min(w-100,840), y=h*.39+titleLines.length*titleSize*1.3+12;
      paragraph(c,copy.subtitle||'每一次提交，独立留痕。',(w-descWidth)/2,y,descWidth,20*this.textScale,31*this.textScale,2,p.muted);
      const descriptionY=y+58;
      const descriptionLines=Math.max(0,Math.min(this.portrait?4:3,Math.floor((h-75-descriptionY)/(27*this.textScale))+1));
      if (descriptionLines) paragraph(c,copy.description||'',(w-descWidth)/2,descriptionY,descWidth,16*this.textScale,27*this.textScale,descriptionLines,p.dim);
      c.globalAlpha=1;c.textAlign='left';
    }

    drawHeader(c,w,state) {
      const p=this.palette, copy=this.copy;
      paragraph(c,copy.brand||this.history.name,32,31,w-160,12,16,1,p.muted,400,MONO);
      if (this.portrait) { c.textAlign='right';text(c,`${state.index+1} / ${number(this.history.commits.length)}`,w-32,31,11,p.muted,MONO);c.textAlign='left'; }
      paragraph(c,copy.title||this.history.name,32,67,w-(this.portrait?64:255),26*this.textScale,30*this.textScale,1,p.text,600);
      paragraph(c,copy.subtitle||'',32,96,w-64,13,18,1,p.muted);
      if (!this.portrait) { c.textAlign='right';text(c,`${String(state.index+1).padStart(4,'0')} / ${number(this.history.commits.length)}`,w-32,64,20,p.text,MONO);c.textAlign='left'; }
      line(c,32,112,w-64,p.line);
    }

    drawStory(c,w,h,state) {
      const commit=this.history.commits[state.index], story=this.story(commit), p=this.palette, s=commit.stats;
      const square=this.plan.aspect==='1:1';
      const x=this.portrait?34:850, y=this.portrait?this.graphBox.y+this.graphBox.height+(square?22:38):143;
      const available=w-x-32, factor=this.textScale;
      const titleSize=(this.plan.aspect==='1:1'?21:25)*factor;
      text(c,story.tag||'独立提交',x,y,12,p.M);
      const titleY=y+(square?27:39), titleHeight=paragraph(c,story.title||commit.subject,x,titleY,available,titleSize,titleSize*1.3,square?1:3,p.text,600);
      const metaY=titleY+titleHeight+(square?5:10);
      text(c,`${commit.date.slice(0,10)}  ·  ${commit.short || commit.sha.slice(0,8)}`,x,metaY,12,p.muted,MONO);
      const summaryY=metaY+(square?25:32), reservedBottom=this.plan.aspect==='9:16'?h-180:square?h-145:483;
      const maxSummaryLines=Math.max(1,Math.min(this.portrait?4:5,Math.floor((reservedBottom-summaryY)/(26*factor))));
      const summaryHeight=paragraph(c,story.summary||'',x,summaryY,available,16*factor,26*factor,maxSummaryLines,p.muted);
      const whyY=summaryY+summaryHeight+17, whyLines=Math.max(0,Math.min(2,Math.floor((h-185-whyY)/20)));
      if (this.plan.aspect==='9:16' && story.why && whyLines) paragraph(c,story.why,x,whyY,available,12,20,whyLines,p.dim);
      const statsY=this.plan.aspect==='9:16'?h-150:this.plan.aspect==='1:1'?h-110:510;
      line(c,x,statsY-22,available,p.line);
      [['A','新增'],['M','修改'],['D','删除'],['R','移动']].forEach(([key,label],i)=>{
        const col=x+i*available/4;text(c,`${key} ${label}`,col,statsY,11,p[key]);text(c,number(s[key]||0),col,statsY+30,23,p[key],MONO);
      });
      const note=s.A===0&&s.D===0&&s.R===0&&s.M>0?`文件数不变，${number(s.M)} 个文件更新`:s.total===0?'本次提交相对父提交无文件差异':`${number(commit.fileCount)} 个当前文件 · ${number(s.total)} 处变化`;
      paragraph(c,note,x,statsY+62,available,12,18,1,p.muted);
      if (!this.portrait) paragraph(c,story.why||'',x,602,available,12,18,2,p.dim);
    }

    drawOutro(c,w,h,state) {
      const p=this.palette, copy=this.copy;
      const age=state.frame-(this.plan.frameCount-this.plan.outroFrames);
      const progress=this.project.appearance?.reducedMotion?1:clamp((age+1)/(this.plan.fps*.5),0,1);
      c.globalAlpha=.9*progress; c.fillStyle=p.background;c.fillRect(0,112,w,h-146);c.globalAlpha=progress;
      const boxW=Math.min(w-80,880), x=(w-boxW)/2;
      const titleY=h*.38, titleHeight=paragraph(c,copy.ctaLabel||'让每一次提交，都留下可见的痕迹。',x,titleY,boxW,(this.portrait?32:39)*this.textScale,50*this.textScale,this.portrait?3:2,p.text,600);
      const descriptionY=titleY+titleHeight+28;
      const descriptionHeight=paragraph(c,copy.description||'',x,descriptionY,boxW,17*this.textScale,28*this.textScale,this.portrait?3:2,p.muted);
      paragraph(c,copy.ctaUrl||'',x,Math.min(h-80,descriptionY+descriptionHeight+30),boxW,14,23,2,p.accent||p.A,400,MONO);
      c.globalAlpha=1;
    }

    drawFooter(c,w,h,state) {
      const p=this.palette;c.fillStyle=p.line;c.fillRect(32,h-34,w-64,2);c.fillStyle=p.accent||p.A;c.fillRect(32,h-34,(w-64)*state.progress,2);
      paragraph(c,this.copy.footer||'每个提交，单独走过。',32,h-13,w*.56,10,12,1,p.dim);
      c.textAlign='right';text(c,`${number(this.history.commits.length)} 次提交 · ${number(this.history.finalFileCount)} 个文件`,w-32,h-13,10,p.dim,MONO);c.textAlign='left';
    }

    destroy() { this.motion.destroy(); }
  }
  return Object.freeze({plan,frameState,applyCommit,create:options=>new Compositor(options),Compositor});
});
