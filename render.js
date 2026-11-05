/* Frame-exact local video export; no screen recording and no repository uploads. */
(function (root, factory) {
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.GitVideo=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const MAX_VIDEO_BYTES=192*1024*1024;
  const nextTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
  const abortError=()=>new DOMException('渲染已取消。','AbortError');
  function assertActive(signal){if(signal?.aborted)throw abortError();}
  function safeName(value){return String(value||'Git_Growth').normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu,'_').replace(/^[._]+|[._]+$/g,'').slice(0,100)||'Git_Growth';}
  function dependencies(){
    if(!root.GitFilm)throw new Error('影片渲染器尚未载入，请刷新后重试。');
    if(!root.GitMedia)throw new Error('视频编码组件尚未载入，请刷新后重试。');
    return {Film:root.GitFilm,Media:root.GitMedia};
  }
  function encodingSettings(plan){
    const bitrate=Math.round((plan.width*plan.height/(1280*720))*(plan.fps/30)*2200000);
    return {bitrate:Math.max(2200000,Math.min(14000000,bitrate)),width:plan.width,height:plan.height,frameRate:plan.fps};
  }
  async function checkSupport(project,history){
    const {Film,Media}=dependencies(), plan=Film.plan(project,history), settings=encodingSettings(plan);
    if(!root.VideoEncoder||!root.VideoFrame)throw new Error('当前浏览器没有可用的视频编码能力。请在支持 WebCodecs 的 HTTPS 页面使用渲染；预览和项目保存仍可使用。');
    const quality=new Media.Quality({bitrate:settings.bitrate});
    const common={width:settings.width,height:settings.height,frameRate:settings.frameRate,quality};
    for(const candidate of [{codec:'avc',format:'MP4',mimeType:'video/mp4',extension:'mp4'},{codec:'vp9',format:'WebM',mimeType:'video/webm',extension:'webm'},{codec:'vp8',format:'WebM',mimeType:'video/webm',extension:'webm'}]){
      try{if(await Media.canEncodeVideo(candidate.codec,common))return {...candidate,plan,bitrate:settings.bitrate,quality};}catch(_){}
    }
    throw new Error('此浏览器不支持所选尺寸的视频编码。可改为 720p / 30 fps 后重试，或使用支持 WebCodecs 的浏览器。');
  }

  function preview(options){
    if(!root.GitFilm)throw new Error('影片渲染器尚未载入。');
    const composition=root.GitFilm.create(options), plan=composition.plan;
    let frame=0,raf=0,playing=false,stopped=false,nextDue=0,completed=false;
    const publish=()=>{const state=composition.render(frame);options.onProgress?.(state);return state;};
    const schedule=()=>{if(!raf&&playing&&!stopped)raf=requestAnimationFrame(tick);};
    function tick(now){
      raf=0;if(!playing||stopped)return;
      if(now+.2>=nextDue){
        if(frame>=plan.frameCount-1){playing=false;completed=true;options.onComplete?.({plan,frame});return;}
        frame++;publish();
        // Slow devices extend preview playback instead of dropping any frame/SHA.
        nextDue=Math.max(nextDue+1000/plan.fps,now-1000/plan.fps);
      }
      schedule();
    }
    const player={plan,
      pause(){playing=false;if(raf)cancelAnimationFrame(raf);raf=0;},
      resume(){if(stopped)return;if(completed){frame=0;completed=false;publish();}playing=true;nextDue=performance.now()+1000/plan.fps;schedule();},
      seek(value){if(stopped)return;frame=Math.max(0,Math.min(plan.frameCount-1,Math.floor(Number(value)||0)));completed=false;publish();nextDue=performance.now()+1000/plan.fps;},
      stop(){if(stopped)return;player.pause();stopped=true;composition.destroy();},
      get playing(){return playing;},get frame(){return frame;}
    };
    publish();player.resume();return player;
  }

  async function render(options){
    const {Media,Film}=dependencies(),signal=options.signal;
    assertActive(signal);
    options.onProgress?.({phase:'checking',progress:0,frame:0,frames:0});
    const support=await checkSupport(options.project,options.history),plan=support.plan;
    assertActive(signal);
    const estimate=plan.durationSeconds*support.bitrate/8;
    if(estimate>MAX_VIDEO_BYTES*.92)throw new Error('预计视频超过当前浏览器的 192 MiB 渲染额度，请提高播放倍率或降低输出尺寸。所有提交都会保留。');
    let composition,output,source,encodedPackets=0,encodedBytes=0,renderedFrames=0,lastProgress=0,failure=null;
    const visited=new Set();
    const onAbort=()=>{if(output&&output.state!=='finalized'&&output.state!=='canceled')output.cancel().catch(()=>{});};
    signal?.addEventListener('abort',onAbort,{once:true});
    try{
      if(typeof document!=='undefined'&&document.fonts?.ready)await document.fonts.ready;
      assertActive(signal);
      composition=Film.create(options);
      const target=new Media.BufferTarget();
      output=new Media.Output({format:support.extension==='mp4'?new Media.Mp4OutputFormat({fastStart:'in-memory'}):new Media.WebMOutputFormat(),target});
      source=new Media.CanvasSource(composition.canvas,{codec:support.codec,quality:support.quality,latencyMode:'quality',keyFrameInterval:2,
        onEncodedPacket(packet){encodedPackets++;encodedBytes+=packet.data?.byteLength||0;if(encodedBytes>MAX_VIDEO_BYTES)failure=new Error('视频超过 192 MiB，请提高倍率或降低尺寸后重新渲染。');}
      });
      output.addVideoTrack(source,{frameRate:plan.fps});
      output.setMetadataTags?.({title:options.project?.copy?.title||options.history.name,comment:`Git Growth Film · ${options.history.commits.length} independent commits · ${options.history.head}`});
      await output.start();
      for(let frame=0;frame<plan.frameCount;frame++){
        assertActive(signal);if(failure)throw failure;
        const state=composition.render(frame);
        if(state.phase==='commits')visited.add(state.sha);
        // add() captures this exact canvas state and propagates encoder backpressure.
        await source.add(frame/plan.fps,1/plan.fps);
        renderedFrames++;
        const now=performance.now();
        if(now-lastProgress>100||frame===plan.frameCount-1){lastProgress=now;options.onProgress?.({...state,phase:'encoding',format:support.format,progress:(frame+1)/plan.frameCount*.96});}
        if(frame%8===7)await nextTurn();
      }
      assertActive(signal);if(failure)throw failure;
      source.close();
      options.onProgress?.({phase:'finalizing',progress:.97,frame:renderedFrames,frames:plan.frameCount,format:support.format});
      await output.finalize();
      assertActive(signal);if(failure)throw failure;
      if(visited.size!==options.history.commits.length||renderedFrames!==plan.frameCount||encodedPackets!==plan.frameCount)throw new Error('视频帧覆盖检查未通过，没有导出不完整影片。');
      const buffer=target.buffer;
      if(!buffer?.byteLength)throw new Error('编码没有生成可下载的视频。');
      if(buffer.byteLength>MAX_VIDEO_BYTES)throw new Error('视频超过 192 MiB，请提高倍率或降低尺寸。');
      const report={schemaVersion:1,renderer:'GitFilm',sourceHead:options.history.head,historyName:options.history.name,codec:support.codec,format:support.format,width:plan.width,height:plan.height,fps:plan.fps,durationSeconds:plan.durationSeconds,requestedDurationSeconds:plan.requestedDurationSeconds,extended:plan.extended,totalFrames:plan.frameCount,encodedPackets,totalCommits:options.history.commits.length,renderedCommits:visited.size,allCommitsRetained:true,bytes:buffer.byteLength,spans:plan.spans};
      const blob=new Blob([buffer],{type:support.mimeType});
      options.onProgress?.({phase:'complete',progress:1,frame:plan.frameCount,frames:plan.frameCount,format:support.format});
      return {blob,filename:safeName(options.project?.copy?.brand||options.history.name)+'_Growth.'+support.extension,report,mimeType:support.mimeType,extension:support.extension};
    }catch(error){
      if(output&&output.state!=='finalized'&&output.state!=='canceled')try{await output.cancel();}catch(_){}
      throw signal?.aborted?abortError():error;
    }finally{signal?.removeEventListener('abort',onAbort);composition?.destroy();}
  }
  return Object.freeze({preview,render,checkSupport,encodingSettings,limits:{maxVideoBytes:MAX_VIDEO_BYTES}});
});
