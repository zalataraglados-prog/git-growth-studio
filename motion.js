/* Persistent, data-backed directory animation. No external assets or libraries. */
(() => {
  'use strict';

  const COLORS = {
    background: '#172821', fog: '#20362b', branch: '#6c8876', file: '#8ba58f', directory: '#b8c8aa',
    A: '#b1c78b', M: '#c8b27c', D: '#b29183', R: '#aaa0bc', text: '#d6decf', muted: '#8c9e8d'
  };
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = p => p * p * (3 - 2 * p);
  const mix = (a, b, p) => a + (b - a) * p;
  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
  }
  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function shortName(value, length = 27) {
    return value.length <= length ? value : value.slice(0, length - 1) + '…';
  }

  class StardewMotion {
    constructor(canvas, options = {}) {
      if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('A canvas is required');
      this.canvas = canvas;
      this.colors = {...COLORS};
      this.showLabels = true;
      this.label = null;
      this.ctx = canvas.getContext('2d', {alpha: false});
      if (!this.ctx) throw new Error('Canvas 2D is unavailable');
      this.onSelect = options.onSelect || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.now = options.now || (() => performance.now());
      this.autoStart = options.autoStart !== false;
      this.externalPlayback = options.externalPlayback === true;
      this.fixedSize = options.width && options.height ? {width: options.width, height: options.height, pixelRatio: options.pixelRatio || 1} : null;
      this.nodes = [];
      this.files = new Map();
      this.directories = new Map();
      this.nodeMap = new Map();
      this.events = [];
      this.renameEvents = [];
      this.commit = null;
      this.playing = false;
      this.speed = 1;
      this.progress = 0;
      this.activeCount = 0;
      this.width = 800;
      this.height = 500;
      this.camera = {x: 400, y: 250, scale: 1};
      this.bounds = {minX: -300, maxX: 300, minY: -250, maxY: 250};
      this.frameAt = 0;
      this.lastTick = 0;
      this.duration = 950;
      this.raf = 0;
      this.drawnFrames = 0;
      this.destroyed = false;
      this.hovered = null;
      this.selected = null;
      this.pointer = null;
      this.hasFrame = false;
      this.needsDraw = true;
      this.motionQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : {matches: false};
      this.reducedMotion = options.reducedMotion ?? this.motionQuery.matches;
      this.handleMotion = e => { this.reducedMotion = e.matches; this.wake(); };
      this.motionQuery.addEventListener?.('change', this.handleMotion);
      this.handleMove = e => this.pointerMove(e);
      this.handleLeave = () => { this.hovered = null; this.pointer = null; this.canvas.style.cursor = ''; this.wake(); };
      this.handleClick = () => this.selectHovered();
      this.canvas.addEventListener?.('pointermove', this.handleMove, {passive: true});
      this.canvas.addEventListener?.('pointerleave', this.handleLeave, {passive: true});
      this.canvas.addEventListener?.('click', this.handleClick);
      this.handleVisibility = () => { if (typeof document === 'undefined' || !document.hidden) this.wake(); };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibility);
      if (typeof ResizeObserver !== 'undefined' && !this.fixedSize) {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas);
      }
      this.resize();
    }

    initialize(data) {
      this.data = data;
      const paths = new Set(data.baseline || []);
      for (const checkpoint of data.checkpoints || []) for (const path of checkpoint.paths || []) paths.add(path);
      for (const commit of data.commits || []) {
        for (const change of commit.changes || []) {
          paths.add(change.path);
          if (change.previousPath) paths.add(change.previousPath);
        }
        for (const path of commit.transition?.add || []) paths.add(path);
        for (const path of commit.transition?.remove || []) paths.add(path);
      }
      this.nodes = [];
      this.files.clear(); this.directories.clear(); this.nodeMap.clear();
      const root = this.makeNode('', '', true, null);
      this.root = root;
      for (const path of [...paths].sort()) {
        const parts = path.split('/'); let parent = root;
        for (let i = 0; i < parts.length; i++) {
          const nodePath = parts.slice(0, i + 1).join('/');
          const isDirectory = i < parts.length - 1;
          const key = `${isDirectory ? 'd' : 'f'}:${nodePath}`;
          let item = this.nodeMap.get(key);
          if (!item) {
            item = this.makeNode(nodePath, parts[i], isDirectory, parent);
            parent.children.push(item); this.nodeMap.set(key, item);
          }
          parent = item;
        }
      }
      const count = item => {
        item.descendants = item.isDirectory ? item.children.reduce((sum, child) => sum + count(child), 0) : 1;
        item.children.sort((a,b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'en'));
        return item.descendants;
      };
      count(root);
      root.x = root.tx = root.baseX = 0; root.y = root.ty = root.baseY = 0;
      const layout = (parent, start, end) => {
        const span = end - start;
        const weights = parent.children.map(child => child.isDirectory ? Math.pow(child.descendants, parent.depth === 0 ? 0.58 : 0.69) : 1);
        const total = weights.reduce((a,b) => a+b, 0) || 1;
        let cursor = start;
        parent.children.forEach((item, i) => {
          const interval = span * weights[i] / total;
          const gap = Math.min(0.015, interval * 0.06);
          const angle = cursor + interval / 2;
          item.angle = angle;
          const seed = hash(item.path);
          if (item.isDirectory) {
            item.radius = item.depth * 55;
            item.baseX = Math.cos(angle) * item.radius * 1.22;
            item.baseY = Math.sin(angle) * item.radius;
          } else {
            const depth = Math.max(1, parent.depth);
            // Quasi-uniform area distribution avoids concentric flickering rings.
            const radialSpan = parent.descendants > 80 ? 118 : parent.descendants > 15 ? 84 : 57;
            const radius = parent.depth === 0 ? 22 + seed * 28 : depth * 55 + 22 + Math.sqrt(seed) * radialSpan;
            const jitter = (hash(item.path + ':angle') - 0.5) * Math.min(interval * 0.75, 0.025);
            item.radius = radius;
            item.baseX = Math.cos(angle + jitter) * radius * 1.22;
            item.baseY = Math.sin(angle + jitter) * radius;
          }
          item.x = item.tx = item.baseX; item.y = item.ty = item.baseY;
          if (item.isDirectory) layout(item, cursor + gap, cursor + interval - gap);
          cursor += interval;
        });
      };
      layout(root, -Math.PI / 2 - 0.22, Math.PI * 1.5 - 0.34);
      this.bounds = this.nodes.reduce((b, n) => ({minX: Math.min(b.minX,n.baseX),maxX: Math.max(b.maxX,n.baseX),minY: Math.min(b.minY,n.baseY),maxY: Math.max(b.maxY,n.baseY)}), {minX:-80,maxX:80,minY:-80,maxY:80});
      this.resize();
      this.wake();
      return this;
    }

    makeNode(path, name, isDirectory, parent) {
      const item = {
        path,name,isDirectory,parent,children:[],depth:parent ? parent.depth+1 : 0,
        descendants:0,activeDescendants:0,baseX:0,baseY:0,x:0,y:0,tx:0,ty:0,
        fromX:0,fromY:0,alpha:0,fromAlpha:0,targetAlpha:0,active:false,event:null,
        color:isDirectory ? this.colors.directory : this.colors.file,angle:0,radius:0
      };
      this.nodes.push(item);
      if (isDirectory) this.directories.set(path,item); else this.files.set(path,item);
      return item;
    }

    setFrame(commit, paths, options = {}) {
      if (this.destroyed || !this.root) return;
      const now = this.now();
      this.updatePositions(now);
      this.commit = commit;
      this.frameAt = now;
      this.duration = clamp(Number(options.duration) || 950, 12, this.reducedMotion ? 240 : 1800);
      if (options.playing != null) this.playing = !!options.playing;
      this.progress = 0;
      this.events = [];
      this.renameEvents = [];
      this.activeCount = paths.size;
      const changeMap = new Map((commit.changes || []).map(c => [c.path,c]));
      for (const item of this.nodes) { item.activeDescendants = 0; item.event = null; }
      for (const path of paths) {
        const item = this.files.get(path);
        if (!item) continue;
        for (let parent = item.parent; parent; parent = parent.parent) parent.activeDescendants++;
      }
      for (const item of this.nodes) {
        const active = item.isDirectory ? item.activeDescendants > 0 : paths.has(item.path);
        const wasActive = item.active;
        const change = changeMap.get(item.path);
        item.fromAlpha = item.alpha;
        item.targetAlpha = active ? 1 : 0;
        item.fromX = item.x; item.fromY = item.y;
        item.tx = item.baseX; item.ty = item.baseY;
        if (active && !wasActive && !options.immediate && !this.reducedMotion) {
          const parent = item.parent || this.root;
          item.fromX = mix(parent.baseX, item.baseX, 0.46);
          item.fromY = mix(parent.baseY, item.baseY, 0.46);
          item.x = item.fromX; item.y = item.fromY;
        }
        if (!active && wasActive && !this.reducedMotion) {
          const parent = item.parent || this.root;
          item.tx = mix(item.baseX,parent.baseX,0.24);
          item.ty = mix(item.baseY,parent.baseY,0.24);
        }
        item.active = active;
        item.change = change || null;
        if (options.immediate) { item.x=item.tx; item.y=item.ty; item.alpha=item.targetAlpha; item.fromAlpha=item.targetAlpha; }
      }
      for (const change of commit.changes || []) {
        const item = this.files.get(change.path);
        if (!item) continue;
        const ev = {node:item,status:change.status,change,at:now,seed:hash(commit.sha + change.path),chain:[]};
        item.event = ev;
        let ancestor = item;
        while (ancestor) { ev.chain.unshift(ancestor); ancestor=ancestor.parent; }
        this.events.push(ev);
        if (change.status === 'D') {
          // A deleted leaf is a short-lived explicit ghost, never an active file.
          item.fromAlpha=Math.max(item.fromAlpha,0.6); item.alpha=item.fromAlpha;
        }
        if (change.status === 'R' && change.previousPath) {
          const oldNode = this.files.get(change.previousPath);
          if (oldNode) {
            oldNode.event = {...ev,node:oldNode};
            oldNode.fromAlpha=Math.max(oldNode.fromAlpha,0.55);
            this.renameEvents.push({from:oldNode,to:item,at:now});
            if (!options.immediate && !this.reducedMotion) {
              item.fromX=oldNode.x; item.fromY=oldNode.y;
              item.x=item.fromX; item.y=item.fromY;
            }
          }
        }
      }
      if (options.immediate) {
        for (const item of this.nodes) { item.x=item.tx;item.y=item.ty;item.alpha=item.targetAlpha;item.fromAlpha=item.targetAlpha; }
      }
      this.hasFrame=true;
      this.selected=null;
      this.hovered=null;
      this.onStatus({activeFileCount:this.activeCount,knownFileCount:this.files.size,changedFiles:this.events.length,sha:commit.sha,contextSwitch:!!commit.contextSwitch});
      this.wake();
    }

    setPlayback(options = {}) {
      if (options.playing != null) this.playing=!!options.playing;
      if (Number.isFinite(options.speed)) this.speed=options.speed;
      if (Number.isFinite(options.progress)) this.progress=clamp(options.progress,0,1);
      if (this.externalPlayback && this.playing && this.raf) { cancelAnimationFrame(this.raf); this.raf=0; }
      this.wake();
    }

    setAppearance(options = {}) {
      const palette = options.palette || {};
      const pick = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
      this.colors = {...COLORS,
        background: pick(palette.panel || palette.background, COLORS.background),
        fog: pick(palette.panel || palette.background, COLORS.fog),
        branch: pick(palette.branch || palette.muted, COLORS.branch),
        file: pick(palette.file || palette.muted, COLORS.file),
        directory: pick(palette.directory || palette.text, COLORS.directory),
        text: pick(palette.text || palette.foreground, COLORS.text),
        muted: pick(palette.muted, COLORS.muted)};
      for (const key of ['A','M','D','R']) this.colors[key] = pick(palette[key], COLORS[key]);
      if (options.showLabels != null) this.showLabels = !!options.showLabels;
      if (options.reducedMotion != null) this.reducedMotion = !!options.reducedMotion;
      if (options.label != null) this.label = String(options.label).slice(0, 160);
      this.wake();
    }

    setReducedMotion(value) {
      this.reducedMotion=!!value;
      this.wake();
    }

    resize() {
      const rect=this.fixedSize || this.canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      this.width=rect.width;this.height=rect.height;
      this.dpr=this.fixedSize ? this.fixedSize.pixelRatio : Math.min(window.devicePixelRatio||1,2);
      const pixelW=Math.round(this.width*this.dpr),pixelH=Math.round(this.height*this.dpr);
      if(this.canvas.width!==pixelW||this.canvas.height!==pixelH){this.canvas.width=pixelW;this.canvas.height=pixelH;}
      const b=this.bounds;
      const safeW=Math.max(120,this.width-88),safeH=Math.max(100,this.height-100);
      const scale=Math.min(safeW/(b.maxX-b.minX),safeH/(b.maxY-b.minY));
      this.camera={x:this.width/2-(b.minX+b.maxX)*scale/2,y:this.height/2-(b.minY+b.maxY)*scale/2-6,scale};
      this.wake();
    }

    updatePositions(now) {
      if(!this.hasFrame)return false;
      const p=ease(clamp((now-this.frameAt)/this.duration,0,1));
      let moving=false;
      for(const item of this.nodes){
        item.x=mix(item.fromX,item.tx,p);item.y=mix(item.fromY,item.ty,p);item.alpha=mix(item.fromAlpha,item.targetAlpha,p);
        if(p<1&&Math.abs(item.targetAlpha-item.fromAlpha)+Math.abs(item.tx-item.fromX)+Math.abs(item.ty-item.fromY)>.001)moving=true;
      }
      return moving;
    }

    wake() {
      this.needsDraw=true;
      if(this.autoStart&&!this.destroyed&&!this.raf&&!(this.externalPlayback&&this.playing))this.raf=requestAnimationFrame(now=>this.tick(now));
    }

    tick(now) {
      this.raf=0;
      if(this.destroyed||(this.externalPlayback&&this.playing))return;
      if(typeof document!=='undefined'&&document.hidden){this.lastTick=now;return;}
      const moving=this.updatePositions(now);
      const eventAlive=this.events.length>0&&now-this.frameAt<Math.max(1900,this.duration+600);
      this.draw(now);
      this.lastTick=now;
      if(this.autoStart&&(this.playing||moving||eventAlive))this.raf=requestAnimationFrame(t=>this.tick(t));
    }

    // Deterministic rendering for offline video. timeMs shares the injected now() clock.
    renderAt(timeMs) {
      if(this.destroyed)return;
      this.updatePositions(timeMs);
      this.draw(timeMs);
      this.lastTick=timeMs;
      return this.canvas;
    }

    screen(item) {
      return {x:this.camera.x+item.x*this.camera.scale,y:this.camera.y+item.y*this.camera.scale};
    }

    draw(now) {
      const ctx=this.ctx,w=this.width,h=this.height,s=this.camera.scale;
      ctx.setTransform(this.dpr||1,0,0,this.dpr||1,0,0);
      ctx.globalAlpha=1;ctx.fillStyle=this.colors.background;ctx.fillRect(0,0,w,h);
      const fog=ctx.createRadialGradient(w*.48,h*.45,30,w*.5,h*.5,Math.max(w,h)*.62);
      fog.addColorStop(0,this.colors.fog);fog.addColorStop(1,this.colors.background);ctx.fillStyle=fog;ctx.fillRect(0,0,w,h);
      if(!this.root||!this.hasFrame)return;
      ctx.save();ctx.translate(this.camera.x,this.camera.y);ctx.scale(s,s);
      const age=now-this.frameAt;
      const eventStrength=Math.exp(-Math.max(0,age-180)/1800);
      // Existing geometry persists between commits; the canvas is not replaced.
      ctx.lineCap='round';ctx.lineJoin='round';
      for(const item of this.nodes){
        if(!item.parent||item.alpha<.012)continue;
        const parent=item.parent;
        const a=item.alpha*Math.max(parent.alpha,.26);
        ctx.globalAlpha=a*(item.isDirectory?.28:.095);
        ctx.strokeStyle=this.colors.branch;
        ctx.lineWidth=(item.isDirectory?1.05:.55)/s;
        ctx.beginPath();ctx.moveTo(parent.x,parent.y);
        const middle=this.branchMiddle(parent,item);
        ctx.quadraticCurveTo(middle.x,middle.y,item.x,item.y);ctx.stroke();
      }
      // A capped stream of paths is sufficient to signal activity; every leaf is still drawn.
      const stream=this.events.length>42 ? this.events.filter((_,i)=>i%Math.ceil(this.events.length/42)===0) : this.events;
      if(!this.reducedMotion){
        for(const ev of stream){
          const duration=Math.max(1000,this.duration*1.55);
          const phase=this.playing?(this.progress*.78+ev.seed*.18):clamp(age/duration,0,1);
          const strength=this.playing?.62:eventStrength*.56;
          this.drawPacket(ctx,ev,phase,strength,s);
        }
      }
      for(const item of this.nodes){
        const ev=item.event;
        const ghost=ev&&ev.status==='D' ? .25*eventStrength:0;
        const alpha=Math.max(item.alpha,ghost);
        if(alpha<.008)continue;
        const changed=!!ev;
        const color=changed?this.colors[ev.status]||this.colors.file:item.isDirectory?this.colors.directory:this.colors.file;
        ctx.fillStyle=color;
        ctx.globalAlpha=alpha*(item.isDirectory?.72:changed? .67+.22*eventStrength:.57);
        const radius=(item===this.root?4.7:item.isDirectory?2.45:changed?1.95:1.28)/s;
        ctx.beginPath();ctx.arc(item.x,item.y,radius,0,TAU);ctx.fill();
        if(changed&&!item.isDirectory&&!this.reducedMotion){
          const progress=clamp(age/1850,0,1);
          ctx.strokeStyle=color;ctx.lineWidth=.8/s;ctx.globalAlpha=alpha*.24*(1-progress);
          const ring=(3.3+ease(progress)*7)/s;
          ctx.beginPath();ctx.arc(item.x,item.y,ring,0,TAU);ctx.stroke();
        }
        if(item===this.hovered||item===this.selected){
          ctx.strokeStyle=this.colors.text;ctx.lineWidth=1/s;ctx.globalAlpha=.65;
          ctx.beginPath();ctx.arc(item.x,item.y,5.8/s,0,TAU);ctx.stroke();
        }
      }
      ctx.restore();ctx.globalAlpha=1;
      if (this.showLabels) this.drawLabels(ctx);
      this.drawChangeCaption(ctx,now);
      if(this.hovered)this.drawTooltip(ctx,this.hovered);
      this.drawnFrames++;
    }

    branchMiddle(parent,item) {
      const midpoint={x:(parent.x+item.x)/2,y:(parent.y+item.y)/2};
      const tangent=(hash(item.path+':curve')-.5)*.12;
      return {x:midpoint.x-(item.y-parent.y)*tangent,y:midpoint.y+(item.x-parent.x)*tangent};
    }

    drawPacket(ctx,event,phase,strength,scale) {
      if(!event.chain.length||strength<.012)return;
      const chain=event.chain;
      const scaled=clamp(phase,0,.999999)*(chain.length-1);
      const index=Math.floor(scaled),p=ease(scaled-index);
      const a=chain[index],b=chain[index+1];if(!a||!b)return;
      const mid=this.branchMiddle(a,b),inv=1-p;
      const x=inv*inv*a.x+2*inv*p*mid.x+p*p*b.x,y=inv*inv*a.y+2*inv*p*mid.y+p*p*b.y;
      const color=this.colors[event.status]||this.colors.file;
      // Local accents only: no additive blend, large bloom or whole-panel flash.
      ctx.globalAlpha=strength*.15;ctx.strokeStyle=color;ctx.lineWidth=1/scale;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(mid.x,mid.y,b.x,b.y);ctx.stroke();
      ctx.globalAlpha=strength*.55;ctx.fillStyle=color;
      ctx.beginPath();ctx.arc(x,y,1.9/scale,0,TAU);ctx.fill();
    }

    drawLabels(ctx) {
      const occupied=[];
      ctx.font='11px ui-monospace, SFMono-Regular, Consolas, "Noto Sans CJK SC", "Microsoft YaHei", monospace';
      ctx.textBaseline='middle';
      const changedParents=new Set();
      for(const ev of this.events)for(const n of ev.chain)if(n.isDirectory)changedParents.add(n.path);
      const candidates=[...this.directories.values()].filter(n=>n.depth>0&&n.depth<=2&&n.alpha>.22&&(n.depth===1||n.activeDescendants>=25));
      candidates.sort((a,b)=>a.depth-b.depth||Number(changedParents.has(b.path))-Number(changedParents.has(a.path))||b.activeDescendants-a.activeDescendants);
      let count=0;
      for(const item of candidates){
        if(count>=11)break;
        const point=this.screen(item);
        const text=shortName(item.name,24);
        const textW=ctx.measureText(text).width;
        const preferRight=Math.cos(item.angle)>=0;
        const placements=[
          {x:point.x+(preferRight?8:-textW-8),y:point.y-17},
          {x:point.x+(preferRight?8:-textW-8),y:point.y+17},
          {x:point.x-textW/2,y:point.y-22}
        ];
        const position=placements.find(p=>p.x>12&&p.x+textW<this.width-12&&p.y>18&&p.y<this.height-70&&!occupied.some(rect=>overlaps({x:p.x-5,y:p.y-8,w:textW+10,h:17},rect)));
        if(!position)continue;
        const rect={x:position.x-5,y:position.y-8,w:textW+10,h:17};occupied.push(rect);
        ctx.globalAlpha=item.alpha*.8;ctx.fillStyle=this.colors.background;ctx.fillRect(rect.x,rect.y,rect.w,rect.h);
        ctx.globalAlpha=item.alpha*(changedParents.has(item.path)?.9:.62);ctx.fillStyle=this.colors.text;
        ctx.fillText(text,position.x,position.y);
        count++;
      }
      ctx.globalAlpha=this.root.alpha*.7;ctx.fillStyle=this.colors.text;ctx.font='10px ui-monospace, SFMono-Regular, Consolas, "Noto Sans CJK SC", "Microsoft YaHei", monospace';
      const root=this.screen(this.root);ctx.fillText(shortName(this.label || this.data?.name || 'Git',18),root.x+9,root.y+1);
      ctx.globalAlpha=1;
    }

    drawChangeCaption(ctx,now) {
      const pad=18,bottom=this.height-19;
      const age=now-this.frameAt;
      ctx.textBaseline='alphabetic';ctx.font='10px ui-monospace, SFMono-Regular, Consolas, "Noto Sans CJK SC", "Microsoft YaHei", monospace';
      ctx.fillStyle=this.colors.muted;ctx.globalAlpha=.68;
      ctx.fillText('节点 = 文件    连线 = 目录层级',pad,bottom);
      ctx.textAlign='right';ctx.fillText(`${this.activeCount.toLocaleString('en-US')} FILES`,this.width-pad,bottom);ctx.textAlign='left';
      const changes=this.commit?.changes||[];
      const featured=changes.find(c=>c.status==='M')||changes.find(c=>c.status==='R')||changes[0];
      if(featured&&this.width>340){
        const alpha=this.reducedMotion? .9 : clamp(age/350,.25,.9);
        const labels={A:'新增',M:'内容更新',D:'移除',R:'路径移动'};
        const name=featured.path.split('/').pop();
        let text=`${featured.status} ${labels[featured.status]||'变化'}  ${name}`;
        ctx.font='12px ui-monospace, SFMono-Regular, Consolas, "Noto Sans CJK SC", "Microsoft YaHei", monospace';
        const maxWidth=this.width-pad*2-20;
        while(ctx.measureText(text).width>maxWidth&&text.length>20)text=text.slice(0,-2)+'…';
        const size=ctx.measureText(text).width+22;
        ctx.globalAlpha=alpha*.85;ctx.fillStyle=this.colors.fog;ctx.fillRect(pad,bottom-48,size,27);
        ctx.globalAlpha=alpha;ctx.fillStyle=this.colors[featured.status]||this.colors.text;ctx.fillText(text,pad+10,bottom-30);
      }
      ctx.globalAlpha=1;
    }

    pointerMove(event) {
      const rect=this.canvas.getBoundingClientRect();
      const x=event.clientX-rect.left,y=event.clientY-rect.top;
      this.pointer={x,y};
      let nearest=null,distance=10*10;
      for(const item of this.files.values()){
        if(item.alpha<.25)continue;
        const p=this.screen(item),d=(p.x-x)**2+(p.y-y)**2;
        if(d<distance){nearest=item;distance=d;}
      }
      if(nearest!==this.hovered){this.hovered=nearest;this.canvas.style.cursor=nearest?'pointer':'';this.wake();}
    }

    selectHovered() {
      if(!this.hovered)return;
      this.selected=this.hovered;
      this.onSelect({path:this.hovered.path,change:this.hovered.change||null,isDirectory:false});
      this.wake();
    }

    drawTooltip(ctx,item) {
      const p=this.screen(item);let text=item.path;
      ctx.font='12px ui-monospace, SFMono-Regular, Consolas, "Noto Sans CJK SC", "Microsoft YaHei", monospace';
      const max=Math.max(120,this.width-36);
      while(ctx.measureText(text).width+20>max&&text.length>18)text='…'+text.slice(3);
      const width=ctx.measureText(text).width+20;
      const x=clamp(p.x-width/2,10,this.width-width-10),y=clamp(p.y-36,10,this.height-58);
      ctx.globalAlpha=.96;ctx.fillStyle=this.colors.fog;ctx.fillRect(x,y,width,28);
      ctx.globalAlpha=.35;ctx.strokeStyle=this.colors.branch;ctx.strokeRect(x+.5,y+.5,width-1,27);
      ctx.globalAlpha=1;ctx.fillStyle=this.colors.text;ctx.textBaseline='middle';ctx.fillText(text,x+10,y+14);
    }

    diagnostics() {
      return {initialized:!!this.root,activeFileCount:this.activeCount,knownFileCount:this.files.size,directoryCount:this.directories.size,drawnFrames:this.drawnFrames,playing:this.playing,reducedMotion:this.reducedMotion,commitSha:this.commit?.sha||null,changedNodes:this.events.length,width:this.width,height:this.height};
    }

    destroy() {
      this.destroyed=true;
      if(this.raf)cancelAnimationFrame(this.raf);
      this.raf=0;
      this.resizeObserver?.disconnect();
      this.motionQuery.removeEventListener?.('change',this.handleMotion);
      this.canvas.removeEventListener?.('pointermove',this.handleMove);
      this.canvas.removeEventListener?.('pointerleave',this.handleLeave);
      this.canvas.removeEventListener?.('click',this.handleClick);
      if(typeof document!=='undefined')document.removeEventListener('visibilitychange',this.handleVisibility);
    }
  }

  if(typeof module!=='undefined'&&module.exports)module.exports=StardewMotion;
  if(typeof window!=='undefined')window.StardewMotion=StardewMotion;
})();
