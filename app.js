(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const nf = new Intl.NumberFormat('en-US');
  const fmt = n => nf.format(n);
  const dateFmt = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai'});
  const timeFmt = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai'});
  const prettyDate = d => dateFmt.format(new Date(d)).replaceAll('/', '.');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const statusLabels = {A: '新增', M: '修改', D: '删除', R: '移动'};
  const statusClasses = {A: 'added', M: 'modified', D: 'deleted', R: 'renamed'};
  const state = {index: 0, playing: false, speed: 64, view: 'motion', query: '', selected: null, expanded: new Set(), historyQuery: '', historyLimit: 80, presentation: false, reduced: reducedMotion.matches};
  let data, editorial, milestoneIndices = [], milestoneMap = new Map(), playerRAF = null, frameStart = 0, elapsed = 0, motion = null, treeNodes = new Map(), pathState = new Set(), pathStateIndex = -2, toastTimer;
  const baseDuration = 2200;
  const minSpeed = 0.25, maxSpeed = 128;
  let activeMilestone = -1;
  let initialValues = null;
  let project = null, studio = null, previewSession = null, previewPaused = false, renderJob = null;
  let renderURL = null, reportURL = null;

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function link(text, href, cls) {
    const a = node('a', cls, text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function announce(text) { $('player-announcement').textContent = text; }
  function toast(text) {
    clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
  }
  function syncURL() {
    if (!data || location.protocol === 'file:') return;
    const url = new URL(location.href);
    url.searchParams.set('c', data.commits[state.index].short);
    url.searchParams.delete('scope');
    url.searchParams.set('speed', String(state.speed));
    if (state.presentation) url.searchParams.set('present', '1'); else url.searchParams.delete('present');
    url.searchParams.delete('autoplay');
    history.replaceState(null, '', url);
  }

  async function start() {
    try {
      const values = window.STARDEW_EMBEDDED ? [window.STARDEW_EMBEDDED.history, window.STARDEW_EMBEDDED.editorial, window.STARDEW_EMBEDDED.project] : await Promise.all([
        window.GitHistoryLoader.load(),
        fetch('./editorial.json').then(r => { if (!r.ok) throw new Error('介绍文件读取失败'); return r.json(); })
      ]);
      initialValues = values;
      studio = window.GitStudio.mount($('studio-editor'), {
        onChange: value => applyProject(value),
        onPreview: value => openPreview(value),
        onRender: value => renderVideo(value),
        onCancelRender: () => renderJob?.abort(),
        onSeek: index => seek(index)
      });
      activateDataset(values[0], values[1], {initial:true, project:values[2]});
      bindEvents();
      window.GitImportUI.init({
        activate: async (historyData, notes, importedProject) => {
          activateDataset(historyData, notes, {project:importedProject});
          if (state.presentation) togglePresentation(false);
          $('studio').scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth',block:'start'});
        },
        current: () => ({history:data,editorial,project:studio.getProject()}),
        restoreExample: async () => activateDataset(initialValues[0],initialValues[1],{project:initialValues[2]}),
        exportPage: exportCurrentPage
      });
      if (values[1]?.generic) $('import-example').textContent = '恢复初始项目';
      window.addEventListener('resize', () => { drawGrowth(); motion?.resize(); });
    } catch (error) {
      $('motion-focus').textContent = '日志未能完整打开，请刷新页面重试。';
      $('tree').replaceChildren(node('div', 'error-state', '这本日志暂时没有打开。请刷新页面重试。'));
      $('tree').setAttribute('aria-busy', 'false');
      $('story-title').textContent = '等待重新连接';
      $('story-summary').textContent = '历史数据未能完整加载，页面没有使用演示数据替代。';
      console.error(error);
    }
  }

  function activateDataset(historyData, notes, options = {}) {
      if (!historyData?.commits?.length || !historyData.validation?.passed) throw new Error('导入历史尚未通过完整性检查。');
      if (data) pause();
      closePreview(); renderJob?.abort();
      motion?.destroy();
      data = historyData; editorial = notes || {generic:true,milestones:[],pillars:[],roadmap:[]};
      studio.load(data, editorial, options.project);
      project = studio.getProject();
      milestoneIndices = []; milestoneMap = new Map(); activeMilestone = -1;
      pathState = new Set(); pathStateIndex = -2; treeNodes = new Map(); elapsed = 0;
      state.index = 0; state.selected = null; state.expanded = new Set(); state.query = ''; state.historyQuery = ''; state.historyLimit = 80;
      $('tree-search').value = ''; $('history-search').value = ''; $('timeline-ticks').replaceChildren();
      if (!data.commits?.length || !data.validation?.passed) throw new Error('历史数据尚未通过完整性检查');
      rebuildMilestones();
      $('total-commits').textContent = fmt(data.totalCommits);
      $('total-files').textContent = fmt(data.finalFileCount);
      $('total-modifications').textContent = fmt(data.totals.M);
      const days = Math.round((Date.parse(data.endDate.slice(0, 10)) - Date.parse(data.startDate.slice(0, 10))) / 86400000) + 1;
      $('day-span').textContent = `${days} 天`;
      $('date-span').textContent = `${prettyDate(data.startDate)} — ${prettyDate(data.endDate)}`;
      $('timeline-start').textContent = prettyDate(data.startDate);
      $('timeline-end').textContent = prettyDate(data.endDate);
      $('timeline').max = data.commits.length - 1;
      $('timeline').disabled = false;
      $('play-toggle').disabled = false;
      $('history-total').textContent = ` / ${fmt(data.totalCommits)}`;
      $('scope-footnote').textContent = `${fmt(data.totalCommits)} 个独立 SHA，含 ${fmt(data.nonMergeCount || 0)} 个非合并提交与 ${fmt(data.mergeCount || 0)} 个 Git 合并记录；全部逐个播放。按拓扑顺序展开 ${data.branch} 可达历史。分支切换仅调整上下文，彩色标记对应当前提交。${data.renameDetection === 'exact-oid' ? '移动仅识别内容完全一致的路径变化，其余按新增与删除呈现。' : ''}`;
      const headDate = data.headDate || data.commits[data.commits.length-1].date;
      $('snapshot-note').textContent = `历史快照：${data.branch} @ ${data.head.slice(0, 8)} · ${prettyDate(headDate)} ${timeFmt.format(new Date(headDate))}（UTC+8）`;
      $('tree-branch').textContent = data.branch;
      $('active-project-name').textContent = `当前影片：${data.name}`;
      document.title = `${data.name} · Git 生长影片`;
      $('vision').hidden = !!editorial.generic;
      for (const id of ['project-source','footer-source']) {
        const el = $(id); el.hidden = !data.repoUrl;
        if (data.repoUrl) el.href = data.repoUrl; else el.removeAttribute('href');
      }
      $('project-disclaimer').textContent = editorial.generic ? '介绍根据提交标题、目录与文件变化自动生成；不推断功能是否已完成。' : '示例项目仍在开发与测试；代码变化不等同于完整产品已验收。';
      motion = new window.StardewMotion($('motion-canvas'), {externalPlayback: true, onSelect: record => { state.selected = record.path; showInspector({...record, ghost: record.change?.status === 'D'}); }});
      motion.initialize(data);
      applyProject(project, {syncSpeed:false});
      const url = new URL(location.href);
      let savedSpeed = null;
      try { savedSpeed = localStorage.getItem('stardew-growth-speed'); } catch (_) {}
      const speed = project.output?.durationSeconds > 0 ? speedForProject(project) : project.playback.speed;
      setSpeed(speed || savedSpeed || 64, {persist:false});
      const chosen = options.initial ? url.searchParams.get('c') : null;
      const firstIndex = chosen ? data.commits.findIndex(c => c.sha.startsWith(chosen)) : 0;
      setIndex(Math.max(0, firstIndex), {updateURL: false, immediate: true});
      if (options.initial && url.searchParams.get('present') === '1') togglePresentation(true);
      if (options.initial && url.searchParams.get('autoplay') === '1' && !reducedMotion.matches) play();
      if (!options.initial) syncURL();
  }

  function rebuildMilestones() {
    milestoneIndices = []; milestoneMap = new Map(); activeMilestone = -1;
    for (let index = 0; index < data.commits.length; index++) {
      const c = data.commits[index], note = window.GitProject.story(project, c, editorial);
      if (note.chapter) { milestoneIndices.push(index); milestoneMap.set(index, {...note, sha:c.sha}); }
    }
    $('timeline-ticks').replaceChildren();
  }

  function speedForProject(value) {
    if (!(value.output.durationSeconds > 0)) return value.playback.speed;
    const plan = window.GitFilm.plan(value, data);
    const seconds = (plan.frameCount - plan.introFrames - plan.outroFrames) / plan.fps;
    return data.commits.length * baseDuration / Math.max(1 / plan.fps, seconds) / 1000;
  }

  function applyProject(value, options = {}) {
    if (!data || !value) return;
    project = window.GitProject.normalize(value, data, editorial);
    const colors = window.GitProject.palette(project);
    for (const [name, color] of Object.entries(colors)) document.documentElement.style.setProperty('--film-' + name.toLowerCase(), color);
    document.documentElement.style.setProperty('--film-scale', String(project.appearance.textScale));
    document.querySelectorAll('.brand-name').forEach(el => { el.textContent = project.copy.brand; });
    $('hero-title').textContent = project.copy.title;
    $('hero-subtitle').textContent = project.copy.subtitle;
    $('hero-description').textContent = project.copy.description;
    document.querySelector('.footer-note').textContent = project.copy.footer;
    const cta = $('project-cta'); cta.hidden = !project.copy.ctaUrl || !project.copy.ctaLabel;
    cta.textContent = project.copy.ctaLabel || '了解项目';
    if (project.copy.ctaUrl) { cta.href = project.copy.ctaUrl; cta.target = '_blank'; cta.rel = 'noopener noreferrer'; }
    else cta.removeAttribute('href');
    document.title = `${project.copy.title || data.name} · Git 生长影片`;
    state.reduced = project.appearance.reducedMotion || reducedMotion.matches;
    $('motion-intensity').value = state.reduced ? 'reduced' : 'soft';
    $('experience').classList.toggle('motion-reduced', state.reduced);
    motion?.setAppearance({palette:colors,showLabels:project.appearance.showLabels,reducedMotion:state.reduced,label:project.copy.brand || data.name});
    rebuildMilestones(); renderMilestones(); renderVision(); renderStory();
    if (options.syncSpeed !== false) setSpeed(speedForProject(project), {persist:false});
    if ($('history-panel').open) renderHistory();
  }

  const filmTime = seconds => `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`;

  function closePreview() {
    previewSession?.stop(); previewSession = null; previewPaused = false;
    if ($('film-preview').open) $('film-preview').close();
  }

  function openPreview(value = project) {
    if (renderJob) { toast('视频正在渲染，可以完成或取消后再预览。'); return; }
    pause(); closePreview(); applyProject(value);
    try {
      const plan = window.GitFilm.plan(project, data);
      $('preview-seek').max = Math.max(0, plan.frameCount - 1);
      $('preview-seek').value = 0;
      $('preview-toggle').textContent = '暂停';
      $('film-preview-title').textContent = project.copy.title || '预览最终画面';
      $('preview-note').textContent = `${plan.width} × ${plan.height} · ${plan.fps} fps · ${data.totalCommits} 个独立提交${plan.extended ? ' · 为保留每个提交，实际时长已自动延长' : ''}`;
      $('film-preview-canvas').style.aspectRatio = `${plan.width} / ${plan.height}`;
      $('film-preview').showModal();
      previewSession = window.GitVideo.preview({
        canvas:$('film-preview-canvas'), history:data, editorial, project,
        onProgress: progress => {
          $('preview-seek').value = progress.frame;
          $('preview-time').textContent = `${filmTime(progress.seconds)} / ${filmTime(plan.durationSeconds)}`;
        },
        onComplete: () => { previewPaused = true; $('preview-toggle').textContent = '重新播放'; }
      });
    } catch (error) { closePreview(); toast(error.message || '预览暂时无法打开。'); console.error(error); }
  }

  function lockImports(locked) {
    for (const id of ['repo-url','repo-ref','import-submit','import-file','import-example']) {
      $(id).disabled = locked || (location.protocol === 'file:' && ['repo-url','repo-ref','import-submit'].includes(id));
    }
  }

  async function renderVideo(value = project) {
    if (renderJob) return;
    if ($('import-form').getAttribute('aria-busy') === 'true') { studio.setRenderState({busy:false,progress:0,message:'仓库正在导入，完成后即可渲染。'}); toast('仓库正在导入，完成后即可渲染。'); return; }
    pause(); closePreview(); applyProject(value);
    const controller = new AbortController(); renderJob = controller;
    const renderingHistory = data, renderingEditorial = editorial, renderingProject = JSON.parse(JSON.stringify(project));
    lockImports(true);
    studio.setRenderState({busy:true,progress:0,message:'正在准备视频编码器…'});
    try {
      const result = await window.GitVideo.render({
        history:renderingHistory,editorial:renderingEditorial,project:renderingProject,signal:controller.signal,
        onProgress: progress => studio.setRenderState({busy:true,progress:progress.progress || 0,message:progress.phase === 'finalizing' ? '正在封装视频文件…' : progress.phase === 'checking' ? '正在检查视频编码支持…' : `正在渲染 ${fmt(progress.frame || 0)} / ${fmt(progress.frames || 0)} 帧${progress.format ? ' · ' + progress.format : ''}`})
      });
      if (controller.signal.aborted) throw new DOMException('已取消渲染','AbortError');
      if (renderURL) URL.revokeObjectURL(renderURL);
      if (reportURL) URL.revokeObjectURL(reportURL);
      renderURL = URL.createObjectURL(result.blob);
      reportURL = URL.createObjectURL(new Blob([JSON.stringify(result.report,null,2)],{type:'application/json'}));
      $('render-result-video').src = renderURL;
      $('render-download').href = renderURL; $('render-download').download = result.filename;
      $('render-download').textContent = `下载 ${result.extension.toUpperCase()} 视频`;
      $('render-report').href = reportURL; $('render-report').download = result.filename.replace(/\.[^.]+$/,'') + '.render-report.json';
      const plan = window.GitFilm.plan(renderingProject, renderingHistory);
      $('render-result-title').textContent = renderingProject.copy.title || renderingHistory.name;
      $('render-result-description').textContent = `${result.extension.toUpperCase()} · ${plan.width} × ${plan.height} · ${plan.fps} fps · ${plan.durationSeconds.toFixed(1)} 秒 · ${fmt(renderingHistory.totalCommits)} 个提交逐条保留`;
      $('render-result').hidden = false;
      studio.setRenderState({busy:false,progress:1,message:`渲染完成，${result.extension.toUpperCase()} 视频已可预览与下载。`});
      $('render-result').scrollIntoView({behavior:reducedMotion.matches?'instant':'smooth',block:'start'});
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      studio.setRenderState({busy:false,progress:0,message:cancelled ? '已取消渲染，编辑内容保留。' : `渲染未完成：${error.message || '请稍后重试。'}`});
      if (!cancelled) console.error(error);
    } finally { if (renderJob === controller) renderJob = null; lockImports(false); }
  }

  async function exportCurrentPage() {
    const cssNames=['style.css','cinema.css','import.css','studio.css','app-studio.css'];
    const scriptNames=['history-adapter.js','project-state.js','motion.js','film.js','vendor/mediabunny.js','render.js','studio.js','import.js','app.js'];
    const names=[...cssNames,...scriptNames,'vendor/isomorphic-git.js','vendor/lightning-fs.js','git-worker.js'];
    const get = async path => { const response = await fetch('./'+path); if(!response.ok) throw new Error('导出资源未能读取，请刷新后重试。'); return response.text(); };
    const template = window.GIT_EXPORT_TEMPLATE || await get('index.html');
    const assets = window.GIT_EXPORT_ASSETS || Object.fromEntries(await Promise.all(names.map(async name=>[name,await get(name)])));
    const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
    const script=value=>'<script>'+value.replace(/<\/script/gi,'<\\/script')+'</script>';
    let html=template;
    for(const name of cssNames) html=html.replace(`<link rel="stylesheet" href="./${name}">`,()=>'<style>'+assets[name]+'</style>');
    for(const name of scriptNames) html=html.replace(`<script src="./${name}" defer></script>`,'');
    const workerSource=window.GIT_WORKER_SOURCE || ['vendor/isomorphic-git.js','vendor/lightning-fs.js','history-adapter.js','git-worker.js'].map(name=>assets[name]).join('\n;\n');
    const globals='window.STARDEW_EMBEDDED='+json({history:data,editorial,project})+';window.GIT_WORKER_SOURCE='+json(workerSource)+';window.GIT_EXPORT_TEMPLATE='+json(template)+';window.GIT_EXPORT_ASSETS='+json(assets)+';';
    const scripts=script(globals)+scriptNames.map(name=>script(assets[name])).join('\n');
    html=html.replace('</body>',()=>scripts+'\n</body>');
    const blob=new Blob([html],{type:'text/html;charset=utf-8'}), url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url;a.download=(data.name||'Git_Growth').replace(/[^a-zA-Z0-9_-]/g,'_')+'_Growth.html';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }

  function applyCommit(paths, commit) {
    if (commit.transition) {
      for (const path of commit.transition.remove) paths.delete(path);
      for (const path of commit.transition.add) paths.add(path);
      return;
    }
    for (const c of commit.changes) {
      if (c.status === 'D') paths.delete(c.path);
      if (c.status === 'R' && c.previousPath) paths.delete(c.previousPath);
    }
    for (const c of commit.changes) if (c.status !== 'D') paths.add(c.path);
  }
  function snapshot(index) {
    if (index === pathStateIndex) return pathState;
    if (index === pathStateIndex + 1) { applyCommit(pathState, data.commits[index]); pathStateIndex = index; return pathState; }
    const checkpoints = data.checkpoints || [];
    let checkpoint = null;
    for (const cp of checkpoints) { if (cp.index <= index) checkpoint = cp; else break; }
    pathState = new Set(checkpoint ? checkpoint.paths : data.baseline || []);
    const from = checkpoint ? checkpoint.index + 1 : 0;
    for (let i = from; i <= index; i++) applyCommit(pathState, data.commits[i]);
    pathStateIndex = index;
    return pathState;
  }

  function ancestorPaths(path) {
    const bits = path.split('/'); const result = [];
    for (let i = 1; i < bits.length; i++) result.push(bits.slice(0, i).join('/'));
    return result;
  }
  function setIndex(index, options = {}) {
    state.index = Math.min(data.commits.length - 1, Math.max(0, index));
    const commit = data.commits[state.index];
    if (!options.keepClock) elapsed = 0;
    snapshot(state.index);
    state.selected = null;
    if (state.view !== 'full') state.expanded = new Set();
    for (const change of commit.changes) {
      for (const p of ancestorPaths(change.path)) state.expanded.add(p);
      if (change.previousPath) for (const p of ancestorPaths(change.previousPath)) state.expanded.add(p);
    }
    $('timeline').value = state.index;
    $('timeline').style.setProperty('--progress', `${state.index / Math.max(1, data.commits.length - 1) * 100}%`);
    $('timeline').setAttribute('aria-valuetext', `第 ${state.index + 1} 个独立提交：${commit.subject}`);
    $('current-position').textContent = `${String(state.index + 1).padStart(3, '0')} / ${fmt(data.totalCommits)}`;
    $('current-date').textContent = prettyDate(commit.date);
    $('tree-sha').textContent = commit.short;
    $('previous').disabled = state.index === 0;
    $('next').disabled = state.index === data.commits.length - 1;
    renderTree(); renderStory(); renderMotionNotes(); updateMilestoneState();
    studio?.setIndex(state.index);
    if (!state.presentation) drawGrowth();
    const fastFrame = state.playing && stepDuration() < 50;
    motion?.setFrame(commit, pathState, {immediate: !!options.immediate || fastFrame, duration: Math.max(12, Math.min(state.reduced ? 240 : 1100, stepDuration() * 0.78)), playing: state.playing});
    updateClock();
    if ($('history-panel').open && !state.playing) renderHistory();
    $('tree').scrollTop = 0;
    if (options.updateURL !== false) syncURL();
    if (options.announce) announce(`第 ${state.index + 1} 次更新，${commit.title}。新增 ${commit.stats.A}，修改 ${commit.stats.M}，删除 ${commit.stats.D}，移动 ${commit.stats.R}。`);
  }

  function nextIndex(direction) {
    return state.index + direction;
  }
  function stepDuration() { return baseDuration / state.speed; }
  function setSpeed(value, options = {}) {
    const requested = Number(value);
    const fraction = Math.min(1, Math.max(0, elapsed / stepDuration()));
    state.speed = Math.round(Math.max(minSpeed, Math.min(maxSpeed, Number.isFinite(requested) && requested > 0 ? requested : state.speed)) * 100) / 100;
    elapsed = fraction * stepDuration();
    frameStart = performance.now();
    const preset = [...$('play-speed').options].some(o => o.value === String(state.speed));
    $('play-speed').value = preset ? String(state.speed) : 'custom';
    $('custom-speed').value = state.speed;
    const seconds = data.commits.length * baseDuration / state.speed / 1000;
    const rounded = Math.ceil(seconds - 0.05);
    $('speed-estimate').textContent = `预计全程约 ${rounded < 60 ? `${rounded} 秒` : `${Math.floor(rounded / 60)} 分 ${String(rounded % 60).padStart(2,'0')} 秒`}`;
    document.querySelectorAll('[data-duration]').forEach(b => b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.duration) - seconds) < 0.1)));
    if (state.speed > 8) $('story-title').getAnimations().forEach(a => a.cancel());
    motion?.setPlayback({playing:state.playing,speed:state.speed,progress:fraction});
    updateClock();
    if (options.persist !== false) {
      studio?.setPlayback(state.speed,{resetDuration:true});
      if (studio) project = studio.getProject();
      try { localStorage.setItem('stardew-growth-speed', String(state.speed)); } catch (_) {}
      syncURL();
    }
  }
  function updateClock() {
    const total = Math.ceil(data.commits.length * baseDuration / state.speed / 1000 - 0.05);
    const complete = state.index === data.commits.length - 1 && elapsed >= stepDuration();
    const seconds = complete ? total : Math.floor((state.index + Math.min(1, elapsed / stepDuration())) * baseDuration / state.speed / 1000);
    const display = n => `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
    const label = `${display(seconds)} / ${display(total)}`;
    if ($('playback-time').textContent !== label) $('playback-time').textContent = label;
  }
  function pause() {
    state.playing = false; cancelAnimationFrame(playerRAF); playerRAF = null;
    $('play-symbol').textContent = '▶'; $('play-label').textContent = '播放';
    $('play-toggle').setAttribute('aria-label', '播放更新');
    motion?.setPlayback({playing: false, speed: state.speed, progress: elapsed / stepDuration()});
    if ($('history-panel').open) renderHistory();
    syncURL();
  }
  function playbackFrame(now) {
    if (!state.playing) return;
    const delta = frameStart ? Math.min(100, Math.max(0, now - frameStart)) : 0;
    frameStart = now; elapsed += delta;
    if (elapsed >= stepDuration()) {
      if (state.index >= data.commits.length - 1) { elapsed = stepDuration(); updateClock(); pause(); announce('全部独立提交已播放完毕'); return; }
      elapsed = Math.min(stepDuration(), elapsed - stepDuration());
      // Never collapse catch-up frames: even under load each SHA gets a visible frame.
      setIndex(state.index + 1, {updateURL:false, keepClock:true});
    }
    const progress = Math.min(1, elapsed / stepDuration());
    $('timeline').style.setProperty('--progress', `${Math.min(1, (state.index + progress) / Math.max(1, data.commits.length - 1)) * 100}%`);
    motion?.setPlayback({playing:true, speed:state.speed, progress});
    // One shared frame clock keeps the current SHA, caption and Canvas aligned.
    if (state.view === 'motion') motion?.renderAt(performance.now());
    updateClock(); playerRAF = requestAnimationFrame(playbackFrame);
  }
  function play() {
    if (state.index >= data.commits.length - 1) setIndex(0, {updateURL: false, immediate:true});
    state.playing = true;
    $('play-symbol').textContent = 'Ⅱ'; $('play-label').textContent = '暂停';
    $('play-toggle').setAttribute('aria-label', '暂停播放');
    motion?.setPlayback({playing:true, speed:state.speed, progress:elapsed / stepDuration()});
    frameStart = performance.now(); cancelAnimationFrame(playerRAF); playerRAF = requestAnimationFrame(playbackFrame);
  }
  function seek(index) { pause(); setIndex(index, {announce: true}); }

  function renderMilestones() {
    const fragment = document.createDocumentFragment();
    milestoneIndices.forEach((index, ordinal) => {
      const m = milestoneMap.get(index);
      const button = node('button', 'milestone-chip');
      button.append(node('span', 'milestone-number', String(ordinal + 1).padStart(2, '0')), node('span', '', m.title));
      button.dataset.index = index; button.title = `${prettyDate(data.commits[index].date)} · ${m.title}`;
      button.addEventListener('click', () => seek(index)); fragment.append(button);
      const tick = node('span', 'timeline-tick'); tick.style.left = `${index / Math.max(1, data.commits.length - 1) * 100}%`;
      $('timeline-ticks').append(tick);
    });
    $('milestones').replaceChildren(fragment);
  }
  function updateMilestoneState() {
    let active = milestoneIndices[0];
    for (const i of milestoneIndices) if (i <= state.index) active = i;
    if (active === activeMilestone) return;
    activeMilestone = active;
    document.querySelectorAll('.milestone-chip').forEach(b => {
      const isActive = Number(b.dataset.index) === active;
      b.classList.toggle('active', isActive); b.setAttribute('aria-current', isActive ? 'step' : 'false');
    });
    const current = document.querySelector('.milestone-chip.active');
    if (current) {
      const left = current.offsetLeft - $('milestones').offsetLeft;
      if (left < $('milestones').scrollLeft || left + current.offsetWidth > $('milestones').scrollLeft + $('milestones').clientWidth) {
        $('milestones').scrollTo({left: Math.max(0, left - 20), behavior: reducedMotion.matches ? 'instant' : 'smooth'});
      }
    }
  }

  function renderTree() {
    const commit = data.commits[state.index];
    const cinematic = state.view === 'motion';
    $('experience').classList.toggle('cinema-mode', cinematic);
    $('motion-stage').hidden = !cinematic;
    $('tree').hidden = cinematic;
    $('collapse-tree').hidden = cinematic;
    $('tree-search').closest('label').hidden = cinematic;
    $('tree-file-count').textContent = `${fmt(commit.fileCount)} 个文件 · 相对父提交 ${commit.stats.net > 0 ? '+' : commit.stats.net < 0 ? '−' : '±'}${Math.abs(commit.stats.net)}`;
    $('tree-change-count').textContent = `${fmt(commit.stats.total)} 个文件发生变化`;
    if (cinematic) {
      $('tree').setAttribute('aria-busy','false');
      $('tree-scope-note').textContent = commit.contextSwitch ? '分支上下文平滑切换 · 当前提交变化独立标记' : '每个节点对应真实文件 · 点击查看来源';
      const first = commit.changes.find(c => c.status === 'M') || commit.changes[0];
      if (first) showInspector({path:first.path,change:first,ghost:first.status==='D'});
      else { $('inspector-path').textContent='该提交保留独立位置'; $('inspector-detail').textContent='相对第一父提交没有文件差异。'; }
      return;
    }
    const changes = new Map(commit.changes.map(c => [c.path, c]));
    const records = new Map();
    if (state.view === 'full') for (const path of pathState) records.set(path, {path, change: changes.get(path) || null, ghost: false});
    for (const change of commit.changes) {
      records.set(change.path, {path: change.path, change, ghost: change.status === 'D'});
      if (change.status === 'R' && change.previousPath && change.previousPath !== change.path && !pathState.has(change.previousPath)) {
        records.set(change.previousPath, {path: change.previousPath, change, ghost: true, oldRename: true});
      }
    }
    const query = state.query.trim().toLowerCase();
    const root = {name: '', path: '', children: new Map(), changed: 0, files: 0};
    treeNodes = new Map();
    let visibleFiles = 0;
    for (const record of records.values()) {
      if (query && !record.path.toLowerCase().includes(query)) continue;
      visibleFiles++;
      const bits = record.path.split('/'); let parent = root;
      bits.forEach((name, i) => {
        const path = bits.slice(0, i + 1).join('/');
        if (!parent.children.has(name)) parent.children.set(name, {name, path, children: new Map(), changed: 0, files: 0});
        const child = parent.children.get(name); child.files++;
        if (record.change) child.changed++;
        if (i === bits.length - 1) child.record = record;
        treeNodes.set(path, child); parent = child;
      });
    }
    const fragment = document.createDocumentFragment();
    let rendered = 0;
    function walk(parent, depth) {
      const children = [...parent.children.values()].sort((a,b) => {
        const ad = a.children.size > 0, bd = b.children.size > 0;
        return ad !== bd ? (ad ? -1 : 1) : a.name.localeCompare(b.name, 'en');
      });
      for (const item of children) {
        const folder = item.children.size > 0;
        const expanded = query ? true : state.expanded.has(item.path);
        const change = item.record?.change;
        const row = node('button', 'tree-row'); row.type = 'button';
        row.style.setProperty('--depth', depth); row.style.setProperty('--row-index', Math.min(rendered++, 16));
        row.dataset.path = item.path; row.title = item.path;
        if (folder) {
          row.classList.add('folder'); if (item.changed) row.classList.add('changed');
          row.setAttribute('aria-expanded', String(expanded));
          row.append(node('span', 'tree-chevron', expanded ? '⌄' : '›'), node('span', 'tree-icon', expanded ? '▱' : '▸'), node('span', 'tree-name', item.name));
          const count = node('span', 'tree-count', item.changed ? `${item.changed} 处变化` : `${item.files}`); row.append(count);
          row.addEventListener('click', () => { if (state.expanded.has(item.path)) state.expanded.delete(item.path); else state.expanded.add(item.path); renderTree(); });
        } else {
          row.classList.toggle('selected', state.selected === item.path);
          if (change) row.classList.add('changed', statusClasses[change.status]);
          if (item.record.ghost) row.classList.add('ghost');
          row.append(node('span', 'tree-chevron', ''), node('span', 'tree-icon', fileIcon(item.name)), node('span', 'tree-name', item.name));
          if (change) {
            const badge = node('span', 'change-badge', item.record.oldRename ? 'R →' : `${change.status} ${statusLabels[change.status]}`); badge.dataset.status = change.status; row.append(badge);
            if (!item.record.oldRename) row.append(node('span', 'tree-lines', change.binary ? 'binary' : `+${fmt(change.added || 0)} −${fmt(change.removed || 0)}`));
          }
          row.addEventListener('click', () => selectFile(item.record));
        }
        fragment.append(row);
        if (folder && expanded) walk(item, depth + 1);
      }
    }
    walk(root, 0);
    if (!rendered) fragment.append(node('div', 'tree-empty', query ? '没有匹配的文件，试试较短的关键词。' : '本次提交没有文件差异。'));
    $('tree').replaceChildren(fragment); $('tree').setAttribute('aria-busy', 'false');
    const net = commit.stats.net;
    $('tree-file-count').textContent = `${fmt(commit.fileCount)} 个文件 · 相对父提交 ${net > 0 ? '+' : net < 0 ? '−' : '±'}${Math.abs(net)}`;
    $('tree-change-count').textContent = `${fmt(commit.stats.total)} 个文件发生变化`;
    $('tree-scope-note').textContent = query ? `${visibleFiles} 个匹配路径` : state.view === 'changes' ? '变化路径自动展开 · 删除项保留标记' : '当前完整结构 · 灰色标记为本次移出项';
    if (!state.selected) {
      const first = commit.changes.find(c => c.status === 'M') || commit.changes[0];
      if (first) showInspector({path: first.path, change: first, ghost: first.status === 'D'}, false);
      else { $('inspector-path').textContent = '本次提交没有文件差异'; $('inspector-detail').textContent = '文件树与前一版本保持一致。'; }
    }
  }
  function renderMotionNotes() {
    const c = data.commits[state.index];
    $('motion-commit-label').textContent = `${c.short} · ${c.isMerge ? 'Git 合并记录' : '独立提交'}`;
    const edited = c.changes.filter(ch => ch.status === 'M');
    $('motion-focus').textContent = c.stats.total === 0 ? '当前提交没有文件差异，记录仍完整保留。' : c.stats.net === 0 && c.stats.M > 0 ? `数量未变，${fmt(c.stats.M)} 个文件正在更新。` : `${fmt(c.fileCount)} 个真实文件，在各自的目录中继续生长。`;
    const sample = [...edited, ...c.changes.filter(ch=>ch.status !== 'M')].slice(0,3);
    const chips = sample.map(ch=>{
      const b=node('button','motion-event',`${ch.status} ${ch.path.split('/').pop()}`);
      b.dataset.status=ch.status; b.title=ch.path;
      b.addEventListener('click',()=>showInspector({path:ch.path,change:ch,ghost:ch.status==='D'})); return b;
    });
    if(c.changes.length > sample.length) chips.push(node('span','motion-event-count',`另 ${fmt(c.changes.length - sample.length)} 个文件`));
    $('motion-events').replaceChildren(...chips);
    $('motion-canvas').setAttribute('aria-label', `第 ${state.index+1} 个独立提交 ${c.short}，${c.fileCount} 个文件，新增 ${c.stats.A}，修改 ${c.stats.M}，删除 ${c.stats.D}，移动 ${c.stats.R}`);
  }
  function fileIcon(name) {
    if (/\.(cs|ts|js|py|ps1|sh)$/.test(name)) return '‹›';
    if (/\.(md|txt)$/.test(name)) return '≡';
    if (/\.(json|ya?ml|toml|csproj|props)$/.test(name)) return '◇';
    return '▫';
  }
  function selectFile(record) {
    state.selected = record.path;
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    for (const row of $('tree').children) if (row.dataset.path === record.path) row.classList.add('selected');
    showInspector(record, true);
  }
  function showInspector(record) {
    const commit = data.commits[state.index], c = record.change;
    $('inspector-path').textContent = record.path;
    $('inspector-path').title = record.path;
    const parts = [];
    if (c) {
      parts.push(`${c.status} ${statusLabels[c.status]}`);
      if (c.status === 'R') parts.push(`${c.previousPath} → ${c.path}`);
      parts.push(c.binary === true ? '二进制内容变化，行数不适用' : c.added == null || c.removed == null ? '已核对文件变化，未计算增删行数' : `新增 ${fmt(c.added)} 行，移除 ${fmt(c.removed)} 行`);
    } else parts.push('本次未修改 · 该文件已存在于当前版本');
    const detail = node('span', '', parts.join(' · '));
    const ref = record.ghost ? (commit.parent || commit.sha) : commit.sha;
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(data.repoUrl || '')) {
      const href = `${data.repoUrl}/blob/${ref}/${record.path.split('/').map(encodeURIComponent).join('/')}`;
      $('inspector-detail').replaceChildren(detail, document.createTextNode(' '), link(record.ghost ? '查看之前版本 ↗' : '查看文件 ↗', href, 'file-source-link'));
    } else $('inspector-detail').replaceChildren(detail);
  }

  const categoryWhy = {
    '世界读取': '本次更新涉及游戏状态的读取与表达，为后续规划提供可核对的输入。',
    '规划与决策': '本次更新涉及任务选择与约束处理，逐步补齐长期计划的细节。',
    '原生执行': '本次更新涉及行动执行与反馈，持续推进计划和真实游戏之间的连接。',
    '训练与策略': '本次更新涉及策略与学习流程，继续明确训练输入和判断标准。',
    '测试与验证': '本次更新涉及测试或校验材料，使变化具备更清晰的检查入口。',
    '文档与证据': '文件数量可以保持不变，设计、运行观察与验收依据仍在继续积累。',
    '工程维护': '本次更新调整工程与维护细节，让后续迭代更容易持续。',
    '项目起点': '从工程骨架开始，把一个长期伙伴的目标拆成可以逐步构建的部分。'
  };
  function renderStory() {
    const c = data.commits[state.index], story = window.GitProject.story(project, c, editorial);
    $('chapter-label').textContent = `COMMIT / ${String(state.index + 1).padStart(4, '0')}`;
    $('commit-date').textContent = `${prettyDate(c.date)} ${timeFmt.format(new Date(c.date))}`;
    $('commit-date').dateTime = c.date;
    $('story-category').textContent = `${story?.tag ?? c.category}${c.isMerge ? ' · Git 合并记录' : ''}`;
    const nextTitle = story?.title ?? c.title;
    const titleChanged = $('story-title').textContent !== nextTitle;
    $('story-title').textContent = nextTitle;
    $('story-summary').textContent = story?.summary ?? c.summary;
    $('commit-subject').textContent = c.subject;
    $('commit-subject').title = c.subject;
    for (const status of ['A', 'M', 'D', 'R']) $( `count-${status}`).textContent = fmt(c.stats[status]);
    const st = c.stats;
    if (st.total === 0) $('delta-note').textContent = '这次提交没有文件差异。';
    else if (st.net === 0 && st.M > 0) $('delta-note').textContent = `文件总数未变，但 ${fmt(st.M)} 个文件的内容已更新。`;
    else if (st.net === 0) $('delta-note').textContent = '文件总数未变，路径或文件组成已发生变化。';
    else $('delta-note').textContent = `相对父提交：${fmt(c.parentFileCount ?? c.fileCount - st.net)} → ${fmt(c.fileCount)} 个文件，${fmt(st.total)} 处变化。`;
    $('delta-note').classList.toggle('zero-net', st.net === 0 && st.total > 0);
    $('story-why').textContent = story?.why ?? (editorial.generic ? '介绍来自本条提交的标题、目录与文件差异，保留原始记录供逐条查看。' : categoryWhy[c.category]) ?? '这一笔真实的更新，继续补全工程与验证细节。';
    $('module-tags').replaceChildren(...c.modules.slice(0, 3).map(m => node('span', 'module-tag', m)));
    $('evidence-label').textContent = story.edited ? '自定义说明 · Git 原始记录保留' : 'Git 差异摘要 · 原始记录可核对';
    const hasCommitSource = /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(data.repoUrl || '');
    $('commit-link').hidden = !hasCommitSource;
    if (hasCommitSource) $('commit-link').href = `${data.repoUrl}/commit/${c.sha}`; else $('commit-link').removeAttribute('href');
    $('commit-link').textContent = `${c.short} 查看提交 ↗`;
    $('story').classList.remove('story-enter');
    if (titleChanged && !state.reduced && state.view === 'motion' && (!state.playing || state.speed <= 8)) {
      $('story-title').getAnimations().forEach(a => a.cancel());
      $('story-title').animate([{opacity:0.82,transform:'translateY(2px)'},{opacity:1,transform:'translateY(0)'}],{duration:420,easing:'ease-out'});
    }
  }

  function renderHistory() {
    const q = state.historyQuery.trim().toLowerCase();
    const matches = data.commits.map((c,i) => ({c,i})).filter(({c}) => !q || [c.subject, c.title, c.sha, c.category, ...c.modules, ...c.changes.map(ch => `${ch.path} ${ch.previousPath || ''}`)].some(t => t.toLowerCase().includes(q)));
    const shown = matches.slice(0, state.historyLimit);
    const fragment = document.createDocumentFragment();
    for (const {c,i} of shown) {
      const row = node('button', `history-row${i === state.index ? ' active' : ''}`); row.dataset.index = i;
      row.append(node('span', 'history-seq', String(i + 1).padStart(3,'0')), node('span', 'history-title', milestoneMap.get(i)?.title || c.subject), node('span', 'history-category', `${c.stats.total} 处变更`), node('time', 'history-date', prettyDate(c.date)));
      row.addEventListener('click', () => { seek(i); $('experience').scrollIntoView({behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start'}); });
      fragment.append(row);
    }
    if (!shown.length) fragment.append(node('p', 'tree-empty', '没有匹配的更新。可以搜索模块名、文件名或提交 SHA。'));
    $('history-list').replaceChildren(fragment);
    $('history-results').textContent = `${fmt(matches.length)} 条记录`;
    $('history-more').hidden = shown.length >= matches.length;
  }
  function renderVision() {
    const about = project.about;
    $('vision').hidden = !about.enabled;
    $('vision-title').textContent = about.title;
    $('vision-description').textContent = about.description;
    $('vision-grid').replaceChildren(...(about.pillars || []).map((pillar,i) => {
      const card = node('article', 'vision-card');
      card.append(node('span', 'vision-number', `0${i + 1}`), node('h3', '', pillar.title), node('p', '', pillar.description));
      return card;
    }));
    $('roadmap-items').replaceChildren(...(about.roadmap || []).map((item,i) => {
      const el = node('div', 'roadmap-item'), copy = node('div', 'roadmap-copy');
      copy.append(node('h3', '', item.title.replace(/^\d+\s*·\s*/,'')), node('p', '', item.description), node('span', 'roadmap-tag', item.status));
      el.append(node('span', 'roadmap-step', String(i + 1).padStart(2,'0')), copy); return el;
    }));
  }

  function togglePresentation(force) {
    state.presentation = force ?? !state.presentation;
    document.body.classList.toggle('presentation-mode', state.presentation);
    $('presentation-toggle').setAttribute('aria-pressed', String(state.presentation));
    $('presentation-toggle').textContent = state.presentation ? '⛶ 退出演示' : '⛶ 演示模式';
    window.scrollTo({top: 0, behavior: 'instant'});
    if (!state.presentation) drawGrowth();
    requestAnimationFrame(()=>motion?.resize());
    syncURL();
    if (state.presentation) toast('演示模式已开启。空格播放 / 暂停，Esc 退出。');
  }
  function bindEvents() {
    $('preview-close').addEventListener('click', closePreview);
    $('film-preview').addEventListener('close', closePreview);
    $('film-preview').addEventListener('cancel', closePreview);
    $('preview-toggle').addEventListener('click', () => {
      if (!previewSession) return;
      if (Number($('preview-seek').value) >= Number($('preview-seek').max)) { previewSession.seek(0); previewSession.resume(); previewPaused = false; }
      else if (previewPaused) { previewSession.resume(); previewPaused = false; }
      else { previewSession.pause(); previewPaused = true; }
      $('preview-toggle').textContent = previewPaused ? '继续播放' : '暂停';
    });
    $('preview-seek').addEventListener('input', event => { previewSession?.pause(); previewPaused = true; previewSession?.seek(Number(event.target.value)); $('preview-toggle').textContent = '继续播放'; });
    $('preview-render').addEventListener('click', () => renderVideo(studio.getProject()));
    $('render-result-close').addEventListener('click', () => { $('render-result-video').pause(); $('render-result').hidden = true; });
    $('hero-play').addEventListener('click', () => { $('experience').scrollIntoView({behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start'}); play(); });
    $('play-toggle').addEventListener('click', () => state.playing ? pause() : play());
    $('previous').addEventListener('click', () => seek(nextIndex(-1)));
    $('next').addEventListener('click', () => seek(nextIndex(1)));
    $('restart').addEventListener('click', () => seek(0));
    $('timeline').addEventListener('input', e => { pause(); setIndex(Number(e.target.value), {updateURL: false}); });
    $('timeline').addEventListener('change', e => setIndex(Number(e.target.value), {announce: true}));
    $('play-speed').addEventListener('change', e => {
      if (e.target.value === 'custom') { $('custom-speed').focus(); $('custom-speed').select(); return; }
      setSpeed(e.target.value);
    });
    $('custom-speed').addEventListener('change', e => setSpeed(e.target.value));
    $('custom-speed').addEventListener('keydown', e => { if (e.key === 'Enter') { setSpeed(e.target.value); e.target.blur(); } });
    document.querySelectorAll('[data-duration]').forEach(b => b.addEventListener('click', () => setSpeed(data.commits.length * baseDuration / (Number(b.dataset.duration) * 1000))));
    $('motion-intensity').addEventListener('change', e => {
      state.reduced=e.target.value==='reduced'; motion?.setReducedMotion?.(state.reduced);
      $('experience').classList.toggle('motion-reduced',state.reduced);
      studio.setAppearance({reducedMotion:state.reduced});
      project = studio.getProject();
    });
    document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
      state.view = b.dataset.view;
      document.querySelectorAll('[data-view]').forEach(t => { t.classList.toggle('active', t === b); t.setAttribute('aria-pressed', String(t === b)); });
      renderTree(); requestAnimationFrame(()=>motion?.resize());
    }));
    $('tree-search').addEventListener('input', e => { state.query = e.target.value; renderTree(); });
    $('collapse-tree').addEventListener('click', () => {
      const allCollapsed = state.expanded.size === 0;
      if (allCollapsed) for (const c of data.commits[state.index].changes) for (const p of ancestorPaths(c.path)) state.expanded.add(p);
      else state.expanded.clear();
      $('collapse-tree').textContent = allCollapsed ? '折叠目录' : '展开变化'; renderTree();
    });
    $('history-panel').addEventListener('toggle', () => { if ($('history-panel').open) renderHistory(); });
    $('history-search').addEventListener('input', e => { state.historyQuery = e.target.value; state.historyLimit = 80; renderHistory(); });
    $('history-more').addEventListener('click', () => { state.historyLimit += 100; renderHistory(); });
    $('presentation-toggle').addEventListener('click', () => togglePresentation());
    $('presentation-exit').addEventListener('click', () => togglePresentation(false));
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) pause(); });
    document.addEventListener('keydown', e => {
      if ($('film-preview').open) return;
      if (e.key === 'Escape' && state.presentation) { togglePresentation(false); return; }
      if (/INPUT|TEXTAREA|SELECT|BUTTON|A/.test(e.target.tagName) || e.target.isContentEditable || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(nextIndex(1)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); seek(nextIndex(-1)); }
    });
  }

  function drawGrowth() {
    if (!data) return;
    const canvas = $('growth-art'), ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = 600, h = 240; ctx.clearRect(0,0,w,h);
    const commit = data.commits[state.index], peakFiles = Math.max(1, ...data.commits.map(c => c.fileCount));
    const ratio = commit.fileCount / peakFiles;
    // A small, deterministic data graphic: each square aggregates up to 12 tracked files.
    const leaves = Math.ceil(commit.fileCount / 12);
    const maxLeaves = Math.ceil(peakFiles / 12);
    const changedLeaves = Math.ceil(commit.stats.total / 12);
    ctx.strokeStyle = '#d7ddd0'; ctx.lineWidth = 1;
    for (let x = 15; x < w; x += 24) for (let y = 10; y < h; y += 24) { ctx.fillStyle='#dce0d5'; ctx.fillRect(x,y,1,1); }
    const baseline = h-24;
    ctx.strokeStyle='#b4c0a9'; ctx.beginPath(); ctx.moveTo(18,baseline);ctx.lineTo(w-20,baseline);ctx.stroke();
    const columns = 35;
    for(let n = 0; n < maxLeaves; n++) {
      const col=n % columns, row=Math.floor(n/columns);
      const x=26+col*16, y=baseline-14-row*18;
      const isPresent=n < leaves, isChanged=isPresent && n >= Math.max(0, leaves-changedLeaves);
      ctx.fillStyle=isPresent ? (isChanged ? '#b5c965' : '#42604a') : '#e4e7da';
      ctx.fillRect(x,y,9,9);
      if(isChanged && commit.stats.M > 0) { ctx.fillStyle='#c89c42'; ctx.fillRect(x+6,y,3,3); }
    }
    ctx.fillStyle='#6d7a64'; ctx.font='10px monospace';
    ctx.fillText('FILE CANOPY', 26, 25);
    ctx.textAlign='right'; ctx.fillText(`${fmt(commit.fileCount)} FILES / ${Math.round(ratio*100)}% OF PEAK`, w-25,25);ctx.textAlign='left';
    ctx.fillStyle='#334d38';ctx.font='12px monospace';ctx.fillText(`COMMIT ${String(state.index+1).padStart(3,'0')}`,26,h-4);
    ctx.fillStyle='#778270';ctx.font='10px monospace';ctx.textAlign='right';ctx.fillText('1 SQUARE ≈ 12 FILES',w-25,h-4);ctx.textAlign='left';
  }
  start();
})();
