/* Interactive presentation editor. Git history is read-only; all changes are project edits. */
(function(root) {
  'use strict';
  const nf=new Intl.NumberFormat('zh-CN');
  const field=(label,path,options={})=>`<label class="studio-field ${options.wide?'studio-wide':''}"><span>${label}${options.hint?`<small>${options.hint}</small>`:''}</span>${options.multiline?`<textarea data-project="${path}" rows="${options.rows||3}" maxlength="${options.max||800}"></textarea>`:`<input data-project="${path}" type="${options.type||'text'}" ${options.max?`maxlength="${options.max}"`:''} ${options.min!=null?`min="${options.min}"`:''} ${options.high!=null?`max="${options.high}"`:''} ${options.step?`step="${options.step}"`:''} autocomplete="off">`}</label>`;
  function mount(container,options={}) {
    if(!container || !root.GitProject) throw new Error('GitStudio requires a mount element and GitProject.');
    const P=root.GitProject;
    let history=null,editorial={},project=null,activeIndex=0,selectedIndex=0,saveTimer=null,busy=false,destroyed=false,resetBackup=null;
    const listeners=new AbortController(), signal=listeners.signal;
    container.classList.add('git-studio');
    container.innerHTML=`
      <div class="studio-heading"><div><p class="section-label">02 / 编辑你的影片</p><h2>写下你想讲的故事。</h2><p>改文案、选画面、定节奏，再预览和渲染。</p></div><span id="studio-draft-status" class="studio-draft-status" role="status">正在准备编辑器</span></div>
      <div class="studio-tabs" role="tablist" aria-label="影片编辑区域">
        <button type="button" role="tab" id="studio-tab-copy" aria-controls="studio-panel-copy" aria-selected="true" tabindex="0" data-studio-tab="copy">全局文案</button>
        <button type="button" role="tab" id="studio-tab-story" aria-controls="studio-panel-story" aria-selected="false" tabindex="-1" data-studio-tab="story">提交说明</button>
        <button type="button" role="tab" id="studio-tab-style" aria-controls="studio-panel-style" aria-selected="false" tabindex="-1" data-studio-tab="style">画面样式</button>
        <button type="button" role="tab" id="studio-tab-output" aria-controls="studio-panel-output" aria-selected="false" tabindex="-1" data-studio-tab="output">视频输出</button>
      </div>
      <div class="studio-panels">
        <section id="studio-panel-copy" class="studio-panel" role="tabpanel" aria-labelledby="studio-tab-copy">
          <div class="studio-form-grid">
            ${field('品牌 / 项目短名','copy.brand',{max:60})}
            ${field('影片标题','copy.title',{max:140})}
            ${field('副标题','copy.subtitle',{wide:true,max:200})}
            ${field('影片简介','copy.description',{wide:true,multiline:true,max:800})}
            ${field('片尾引导语','copy.ctaLabel',{max:160})}
            ${field('片尾链接','copy.ctaUrl',{type:'url',max:1000,hint:'选填，http / https 地址'})}
            ${field('页脚署名 / 结束语','copy.footer',{wide:true,max:200})}
          </div>
          <details class="studio-about"><summary>补充介绍与路线图 <span>可编辑卡片和后续方向</span></summary>
            <label class="studio-check"><input type="checkbox" data-project="about.enabled">显示补充介绍</label>
            <div class="studio-form-grid">
              ${field('介绍标题','about.title',{max:140,wide:true})}
              ${field('介绍正文','about.description',{max:800,multiline:true,wide:true})}
            </div>
            <div class="studio-card-heading"><h3>介绍卡片</h3><button type="button" class="studio-small-button" data-add-card="pillars">＋ 添加卡片</button></div><div id="studio-pillars" class="studio-card-list"></div>
            <div class="studio-card-heading"><h3>路线图</h3><button type="button" class="studio-small-button" data-add-card="roadmap">＋ 添加方向</button></div><div id="studio-roadmap" class="studio-card-list"></div>
          </details>
        </section>
        <section id="studio-panel-story" class="studio-panel" role="tabpanel" aria-labelledby="studio-tab-story" hidden>
          <div class="studio-story-layout"><div class="studio-commit-picker">
            <label class="studio-field"><span>定位一条提交</span><input id="studio-commit-search" type="search" placeholder="搜索标题或 SHA…" autocomplete="off"></label>
            <label class="studio-field studio-commit-select-label"><span class="sr-only">选择要编辑的提交</span><select id="studio-commit-select" size="7" aria-label="选择要编辑的提交"></select></label>
            <p id="studio-search-count" class="studio-note"></p>
            <label class="studio-check"><input id="studio-follow" type="checkbox" checked>跟随播放位置</label>
            <button id="studio-current-commit" class="studio-small-button" type="button">使用当前播放的提交</button>
          </div><div class="studio-story-form">
            <p id="studio-commit-meta" class="studio-commit-meta"></p><p id="studio-original-subject" class="studio-original-subject"></p>
            <div class="studio-form-grid">
              ${field('展示标题','story.title',{wide:true,max:200})}
              ${field('这次做了什么','story.summary',{wide:true,multiline:true,max:1200})}
              ${field('想补充的介绍','story.why',{wide:true,multiline:true,rows:2,max:800})}
              ${field('分类标签','story.tag',{max:80})}
              <label class="studio-check studio-chapter"><input type="checkbox" data-project="story.chapter">标记为章节定位点</label>
            </div>
            <div class="studio-story-actions"><button id="studio-reset-story" type="button" class="studio-small-button">恢复本条默认说明</button><span class="studio-note">章节用来定位，每个提交仍独立播放。</span></div>
          </div></div>
        </section>
        <section id="studio-panel-style" class="studio-panel" role="tabpanel" aria-labelledby="studio-tab-style" hidden>
          <div class="studio-form-grid">
            <label class="studio-field"><span>画面主题</span><select data-project="appearance.theme"><option value="forest">林间绿</option><option value="slate">暮色蓝</option><option value="dusk">暖砂棕</option></select></label>
            <label class="studio-field"><span>文字大小 <output id="studio-scale-value">100%</output></span><input data-project="appearance.textScale" type="range" min="0.8" max="1.4" step="0.05"></label>
            <div class="studio-color-fields studio-wide">
              ${field('背景色','appearance.background',{type:'color'})}${field('文字色','appearance.foreground',{type:'color'})}${field('强调色','appearance.accent',{type:'color'})}
            </div>
            <label class="studio-check"><input type="checkbox" data-project="appearance.showLabels">显示目录与节点标签</label>
            <label class="studio-check"><input type="checkbox" data-project="appearance.reducedMotion">减少运动幅度</label>
          </div>
          <div class="studio-palette-preview" aria-label="当前画面配色"><span>一段持续生长的记录</span><strong>A <i></i> M <i></i> D <i></i> R</strong><p>预览与输出使用同一套画面设置。</p></div>
        </section>
        <section id="studio-panel-output" class="studio-panel" role="tabpanel" aria-labelledby="studio-tab-output" hidden>
          <div class="studio-form-grid">
            <label class="studio-field"><span>画幅比例</span><select data-project="output.aspect"><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option><option value="1:1">方形 1:1</option></select></label>
            <label class="studio-field"><span>输出尺寸</span><select data-project="output.resolution"><option value="720">720p</option><option value="1080">1080p</option></select></label>
            <label class="studio-field"><span>帧率</span><select data-project="output.fps"><option value="60">60 fps · 更流畅</option><option value="30">30 fps</option></select></label>
            ${field('播放倍率','playback.speed',{type:'number',min:.25,high:128,step:.01,hint:'0.25× – 128×'})}
            <div class="studio-duration-row studio-wide"><span>目标时长</span><button type="button" data-studio-duration="0">按倍率</button><button type="button" data-studio-duration="30">30 秒</button><button type="button" data-studio-duration="60">1 分钟</button><button type="button" data-studio-duration="90">90 秒</button><button type="button" data-studio-duration="180">3 分钟</button></div>
            ${field('片头停留 / 秒','output.introSeconds',{type:'number',min:0,high:10,step:.5})}
            ${field('片尾停留 / 秒','output.outroSeconds',{type:'number',min:0,high:10,step:.5})}
          </div>
          <div class="studio-output-note"><strong id="studio-output-estimate">正在读取影片信息</strong><p id="studio-output-coverage"></p></div>
        </section>
      </div>
      <div class="studio-action-bar"><div class="studio-draft-actions"><button id="studio-save-draft" class="studio-small-button" type="button">保存草稿</button><button id="studio-reset-all" class="text-button" type="button">恢复默认</button><button id="studio-undo-reset" class="text-button" type="button" hidden>撤销重置</button></div><div class="studio-main-actions"><button id="studio-preview" class="secondary-btn" type="button" disabled><span aria-hidden="true">▷</span> 预览影片</button><button id="studio-render" class="primary-btn" type="button" disabled><span aria-hidden="true">↧</span> 渲染视频</button></div></div>
      <div id="studio-render-status" class="studio-render-status" role="status" hidden><div><strong id="studio-render-message"></strong><button id="studio-cancel-render" class="studio-small-button" type="button" hidden>取消渲染</button></div><progress id="studio-render-progress" max="1" value="0"></progress></div>
      <p class="studio-footnote">文案和画面单独保存。SHA、文件差异与提交顺序来自 Git。</p>`;
    const $=id=>container.querySelector('#'+id);
    const fields=[...container.querySelectorAll('[data-project]')];
    function draftStatus(message) { if(!destroyed) $('studio-draft-status').textContent=message; }
    function persist() {
      clearTimeout(saveTimer);
      if(!history || !project || destroyed) return;
      try { localStorage.setItem(P.draftKey(history),JSON.stringify(project)); draftStatus('草稿已保存在此浏览器'); }
      catch (_) { draftStatus('当前页面已更新，可保存项目数据继续使用'); }
    }
    function changed() {
      project=P.normalize(project,history,editorial);
      draftStatus('修改已应用');clearTimeout(saveTimer);saveTimer=setTimeout(persist,450);
      updateEstimate();updatePalette();
      options.onChange?.(P.clone(project));
    }
    function valueAt(path) {
      const [group,key]=path.split('.');
      if(group==='story') return history ? P.story(project,history.commits[selectedIndex],editorial)[key] : '';
      return project?.[group]?.[key];
    }
    function syncFields(includeStory=true) {
      for(const input of fields) {
        if(!includeStory && input.dataset.project.startsWith('story.')) continue;
        const value=valueAt(input.dataset.project);
        if(input.type==='checkbox') input.checked=!!value;
        else input.value=value == null ? '' : String(value);
      }
      updatePalette();updateEstimate();
    }
    function updatePalette() {
      if(!project) return;
      const palette=P.palette(project), preview=container.querySelector('.studio-palette-preview');
      preview.style.setProperty('--preview-bg',palette.background);preview.style.setProperty('--preview-text',palette.text);preview.style.setProperty('--preview-accent',palette.accent);
      $('studio-scale-value').textContent=Math.round(project.appearance.textScale*100)+'%';
    }
    function seconds(value) { const sec=Math.max(0,Math.round(value));return sec<60?`${sec} 秒`:`${Math.floor(sec/60)} 分 ${String(sec%60).padStart(2,'0')} 秒`; }
    function updateEstimate() {
      if(!history || !project) return;
      const output=project.output, count=history.commits.length;
      let plan;
      try { plan=options.plan?options.plan(project,history):root.GitFilm?.plan?.(project,history); } catch (_) {}
      const requested=output.durationSeconds || count*2.2/project.playback.speed+output.introSeconds+output.outroSeconds;
      const min=count/output.fps+output.introSeconds+output.outroSeconds;
      const actual=plan?.durationSeconds || Math.max(requested,min);
      const width=plan?.width || (output.aspect==='16:9'?Math.round(output.resolution*16/9):output.resolution), height=plan?.height || (output.aspect==='9:16'?Math.round(output.resolution*16/9):output.resolution);
      $('studio-output-estimate').textContent=`${width} × ${height} · ${output.fps} fps · 预计 ${seconds(actual)}`;
      $('studio-output-coverage').textContent=actual>requested+.1?`目标 ${seconds(requested)}，完整保留 ${nf.format(count)} 个提交至少需要 ${seconds(actual)}；输出会自动延长。`:`完整保留 ${nf.format(count)} 个独立提交，每个 SHA 至少呈现一帧。`;
      for(const button of container.querySelectorAll('[data-studio-duration]')) button.setAttribute('aria-pressed',String(Number(button.dataset.studioDuration)===output.durationSeconds));
    }
    function renderPicker() {
      if(!history) return;
      const query=$('studio-commit-search').value.trim().toLowerCase();
      const matches=[];
      history.commits.forEach((commit,index)=>{if(!query || [commit.subject,commit.title,commit.sha,project.stories[commit.sha]?.title].some(value=>String(value || '').toLowerCase().includes(query))) matches.push(index);});
      const shown=matches.slice(0,200);
      if(!shown.includes(selectedIndex)) shown.unshift(selectedIndex);
      const fragment=document.createDocumentFragment();
      for(const index of shown) { const commit=history.commits[index],option=document.createElement('option');option.value=String(index);option.textContent=`${String(index+1).padStart(3,'0')} · ${commit.short || commit.sha.slice(0,8)} · ${P.story(project,commit,editorial).title}`;option.selected=index===selectedIndex;fragment.append(option); }
      $('studio-commit-select').replaceChildren(fragment);
      $('studio-search-count').textContent=matches.length>200?`共 ${nf.format(matches.length)} 条匹配，显示前 200 条。可继续输入标题或 SHA 定位。`:`${nf.format(matches.length)} 条匹配 · ${nf.format(history.commits.length)} 个独立提交`;
    }
    function renderStoryFields() {
      if(!history) return;
      const commit=history.commits[selectedIndex];
      $('studio-commit-meta').textContent=`第 ${nf.format(selectedIndex+1)} 条 / ${nf.format(history.commits.length)} · ${commit.short || commit.sha.slice(0,8)} · ${commit.date.slice(0,10)}`;
      $('studio-original-subject').textContent='原始提交：'+commit.subject;
      for(const input of fields.filter(el=>el.dataset.project.startsWith('story.'))) { const value=valueAt(input.dataset.project);if(input.type==='checkbox') input.checked=!!value;else input.value=value || ''; }
      if($('studio-commit-select').value!==String(selectedIndex)) {
        if([...$('studio-commit-select').options].some(option=>option.value===String(selectedIndex))) $('studio-commit-select').value=String(selectedIndex);else renderPicker();
      }
    }
    function chooseCommit(index,seek=false) {
      if(!history) return;
      selectedIndex=Math.max(0,Math.min(history.commits.length-1,Number(index)||0));renderStoryFields();
      if(seek) options.onSeek?.(selectedIndex);
    }
    function renderCards() {
      if(!project) return;
      for(const list of ['pillars','roadmap']) {
        const fragment=document.createDocumentFragment();
        project.about[list].forEach((card,index)=>{
          const article=document.createElement('div');article.className='studio-edit-card';
          const header=document.createElement('div');header.className='studio-edit-card-top';
          const number=document.createElement('strong');number.textContent=String(index+1).padStart(2,'0');
          const remove=document.createElement('button');remove.type='button';remove.className='text-button';remove.textContent='移除';remove.setAttribute('aria-label',`移除${list==='pillars'?'介绍卡片':'路线方向'} ${index+1}`);remove.addEventListener('click',()=>{project.about[list].splice(index,1);renderCards();changed();},{signal});header.append(number,remove);article.append(header);
          for(const key of list==='pillars'?['title','description']:['title','description','status']) {
            const label=document.createElement('label');label.className='studio-field';const caption=document.createElement('span');caption.textContent={title:'标题',description:'说明',status:'阶段标签'}[key];
            const input=document.createElement(key==='description'?'textarea':'input');if(key==='description') input.rows=2;else input.type='text';input.value=card[key]||'';input.maxLength=key==='description'?600:key==='title'?100:60;input.addEventListener('input',()=>{project.about[list][index][key]=input.value;changed();},{signal});label.append(caption,input);article.append(label);
          }
          fragment.append(article);
        });
        $('studio-'+list).replaceChildren(fragment);
        container.querySelector(`[data-add-card="${list}"]`).disabled=busy || project.about[list].length>=8;
      }
    }
    function setRenderState(value={}) {
      if(destroyed) return;
      if(typeof value.busy==='boolean') busy=value.busy;
      const status=$('studio-render-status');
      if(value.message) { $('studio-render-message').textContent=String(value.message);status.hidden=false; }
      else if(busy) status.hidden=false;
      const progress=$('studio-render-progress');progress.hidden=!busy;if(Number.isFinite(value.progress)) progress.value=Math.max(0,Math.min(1,value.progress));
      $('studio-cancel-render').hidden=!busy || typeof options.onCancelRender!=='function';
      for(const control of container.querySelectorAll('.studio-panels input,.studio-panels textarea,.studio-panels select,.studio-panels button,.studio-draft-actions button')) control.disabled=busy || !history;
      for(const button of [$('studio-preview'),$('studio-render')]) button.disabled=busy || !history;
      if(!busy && project) for(const list of ['pillars','roadmap']) container.querySelector(`[data-add-card="${list}"]`).disabled=project.about[list].length>=8;
      container.setAttribute('aria-busy',String(busy));
    }
    for(const input of fields) input.addEventListener('input',()=>{
      if(!project || busy) return;
      const [group,key]=input.dataset.project.split('.');
      let value=input.type==='checkbox'?input.checked:['number','range'].includes(input.type)||['resolution','fps'].includes(key)?Number(input.value):input.value;
      if(group==='story') { const sha=history.commits[selectedIndex].sha;project.stories[sha] ||= {};project.stories[sha][key]=value; }
      else project[group][key]=value;
      if(group==='appearance' && key==='theme') {const theme=P.themes[value];Object.assign(project.appearance,{background:theme.background,foreground:theme.foreground,accent:theme.accent});syncFields(false);}
      if(group==='playback') project.output.durationSeconds=0;
      if(key==='ctaUrl') input.setCustomValidity(input.value && !P.safeURL(input.value)?'请输入不含账号密码的 http 或 https 地址。':'');
      changed();
      if(group==='story' && key==='title') {const option=$('studio-commit-select').selectedOptions[0],commit=history.commits[selectedIndex];if(option)option.textContent=`${String(selectedIndex+1).padStart(3,'0')} · ${commit.short || commit.sha.slice(0,8)} · ${P.story(project,commit,editorial).title}`;}
    },{signal});
    for(const button of container.querySelectorAll('[data-studio-tab]')) {
      button.addEventListener('click',()=>{
        for(const tab of container.querySelectorAll('[data-studio-tab]')) { const active=tab===button;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$('studio-panel-'+tab.dataset.studioTab).hidden=!active; }
      },{signal});
      button.addEventListener('keydown',event=>{
        const tabs=[...container.querySelectorAll('[data-studio-tab]')],index=tabs.indexOf(button);
        const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
        if(next!==null) {event.preventDefault();tabs[next].click();tabs[next].focus();}
      },{signal});
    }
    $('studio-commit-search').addEventListener('input',renderPicker,{signal});
    $('studio-commit-select').addEventListener('change',()=>{ $('studio-follow').checked=false;chooseCommit($('studio-commit-select').value,true); },{signal});
    $('studio-current-commit').addEventListener('click',()=>{ $('studio-follow').checked=true;chooseCommit(activeIndex,true); },{signal});
    $('studio-follow').addEventListener('change',()=>{if($('studio-follow').checked) chooseCommit(activeIndex);},{signal});
    $('studio-reset-story').addEventListener('click',()=>{resetBackup=P.clone(project);delete project.stories[history.commits[selectedIndex].sha];$('studio-undo-reset').hidden=false;renderStoryFields();renderPicker();changed();},{signal});
    $('studio-reset-all').addEventListener('click',()=>{resetBackup=P.clone(project);project=P.defaults(history,editorial);$('studio-undo-reset').hidden=false;syncFields();renderCards();renderPicker();changed();},{signal});
    $('studio-undo-reset').addEventListener('click',()=>{if(!resetBackup)return;project=resetBackup;resetBackup=null;$('studio-undo-reset').hidden=true;syncFields();renderCards();renderPicker();changed();},{signal});
    $('studio-save-draft').addEventListener('click',persist,{signal});
    for(const button of container.querySelectorAll('[data-add-card]')) button.addEventListener('click',()=>{const list=button.dataset.addCard;if(project.about[list].length>=8)return;project.about[list].push({title:'',description:'',...(list==='roadmap'?{status:''}:{})});renderCards();changed();},{signal});
    for(const button of container.querySelectorAll('[data-studio-duration]')) button.addEventListener('click',()=>{project.output.durationSeconds=Number(button.dataset.studioDuration);changed();},{signal});
    $('studio-preview').addEventListener('click',async()=>{if(!project || busy)return;persist();try{await options.onPreview?.(P.clone(project));}catch(error){setRenderState({busy:false,message:error?.message || '预览未能打开，请重试。'});}},{signal});
    $('studio-render').addEventListener('click',async()=>{if(!project || busy)return;persist();setRenderState({busy:true,progress:0,message:'正在准备渲染…'});try{await options.onRender?.(P.clone(project));}catch(error){setRenderState({busy:false,message:error?.message || '渲染未完成，请重试。'});}finally{if(busy)setRenderState({busy:false});}},{signal});
    $('studio-cancel-render').addEventListener('click',()=>options.onCancelRender?.(),{signal});
    setRenderState({busy:false});
    return Object.freeze({
      load(nextHistory,nextEditorial={},rawProject) {
        clearTimeout(saveTimer);history=nextHistory;editorial=nextEditorial || {};activeIndex=0;selectedIndex=0;resetBackup=null;$('studio-undo-reset').hidden=true;$('studio-commit-search').value='';
        let input=rawProject,restored=false;
        if(input==null) {try{const saved=localStorage.getItem(P.draftKey(history));if(saved){input=JSON.parse(saved);restored=true;}}catch(_){}}
        project=P.normalize(input,history,editorial);syncFields();renderCards();renderPicker();renderStoryFields();setRenderState({busy:false});
        $('studio-render-status').hidden=true;draftStatus(restored?'已恢复此项目的本地草稿':rawProject?'已载入项目编辑设置':'修改会自动保存在此浏览器');
      },
      getProject:()=>project?P.clone(project):null,
      setIndex(index) {
        if(!history)return;activeIndex=Math.max(0,Math.min(history.commits.length-1,index));
        if($('studio-follow').checked && selectedIndex!==activeIndex && !container.querySelector('.studio-story-form')?.contains(document.activeElement)) chooseCommit(activeIndex);
      },
      setPlayback(speed,settings={}) {
        if(!project)return;project.playback.speed=Math.max(.25,Math.min(128,Number(speed)||64));if(settings.resetDuration)project.output.durationSeconds=0;
        const input=container.querySelector('[data-project="playback.speed"]');if(input!==document.activeElement)input.value=project.playback.speed;updateEstimate();clearTimeout(saveTimer);saveTimer=setTimeout(persist,450);
      },
      setAppearance(patch={}) {
        if(!project)return;project.appearance={...project.appearance,...patch};project=P.normalize(project,history,editorial);
        for(const input of fields.filter(el=>el.dataset.project.startsWith('appearance.'))) {const value=valueAt(input.dataset.project);if(input.type==='checkbox')input.checked=!!value;else input.value=String(value);}
        updatePalette();clearTimeout(saveTimer);saveTimer=setTimeout(persist,450);
      },
      setRenderState,
      destroy(){if(destroyed)return;persist();destroyed=true;clearTimeout(saveTimer);listeners.abort();container.replaceChildren();}
    });
  }
  root.GitStudio=Object.freeze({mount});
})(typeof window!=='undefined'?window:globalThis);
