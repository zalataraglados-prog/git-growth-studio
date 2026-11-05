/* Browser-only import controls. Repository bytes stay in the Git parsing worker. */
((root) => {
  'use strict';

  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  const formatNumber = new Intl.NumberFormat('zh-CN');
  let instance = null;

  function normalizeGitHubURL(value) {
    let input = String(value || '').trim();
    if (!input) throw new Error('请先填写 GitHub 仓库地址，或 owner/repository。');
    if (/^git@github\.com:/i.test(input)) input = input.replace(/^git@github\.com:/i, 'https://github.com/');
    else if (/^github\.com\//i.test(input)) input = 'https://' + input;
    else if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/?$/.test(input)) input = 'https://github.com/' + input;
    let url;
    try { url = new URL(input); } catch (_) { throw new Error('地址格式不正确，请使用 GitHub 仓库主页地址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password) {
      throw new Error('在线导入支持公开 GitHub 仓库。其他托管平台或私有仓库请导入本地 .bundle 文件。');
    }
    if (url.search || url.hash) throw new Error('请使用不带查询参数的仓库主页地址，分支名称填写在下方。');
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length !== 2) throw new Error('请填写仓库主页地址；文件、提交和分支页面不能作为仓库地址。');
    const owner = parts[0], repo = parts[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || /^\.+$/.test(repo)) {
      throw new Error('仓库名称格式不正确，请检查 owner/repository。');
    }
    return `https://github.com/${owner}/${repo}`;
  }

  function downloadName(value) {
    const name = String(value || 'git-growth').normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 100);
    return name || 'git-growth';
  }

  function readableError(error, fallback) {
    const text = typeof error === 'string' ? error : error?.message;
    return typeof text === 'string' && text.trim() ? text.trim().slice(0, 600) : fallback;
  }

  function saveBlob(blob, filename) {
    const objectURL = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectURL; a.download = filename; a.hidden = true;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  }

  function deleteDatabase(name) {
    if (typeof name !== 'string' || !name.startsWith('git-growth-') || !root.indexedDB) return;
    try {
      const request = root.indexedDB.deleteDatabase(name);
      // Worker termination closes its own connections. A blocked deletion can
      // complete later without preventing the user from importing again.
      request.onerror = () => {};
      request.onblocked = () => {};
    } catch (_) {}
  }

  function init(options = {}) {
    if (instance) return instance;
    if (typeof options.activate !== 'function' || typeof options.current !== 'function') throw new Error('GitImportUI requires activate and current callbacks.');
    const byId = id => document.getElementById(id);
    const ids = ['import-form', 'repo-url', 'repo-ref', 'import-submit', 'import-file', 'import-cancel', 'import-progress', 'import-phase', 'import-detail', 'import-status', 'import-example', 'export-data', 'export-page', 'import-command-copy', 'import-command'];
    const el = Object.fromEntries(ids.map(id => [id, byId(id)]));
    const missing = ids.filter(id => !el[id]);
    if (missing.length) throw new Error(`Missing Git import controls: ${missing.join(', ')}`);
    const section = el['import-form'].closest('.git-import');
    const feedback = el['import-progress'].closest('.import-feedback');
    const offline = location.protocol === 'file:';
    const listeners = new AbortController();
    let activeJob = null, sequence = 0, disposed = false;

    function status(kind, title, detail = '') {
      if (disposed) return;
      if (section) section.dataset.importState = kind;
      if (feedback) feedback.dataset.kind = kind;
      el['import-phase'].textContent = title;
      el['import-detail'].textContent = detail;
      el['import-status'].textContent = title + (detail ? `。${detail}` : '');
    }

    function busy(value) {
      el['import-submit'].disabled = value || offline;
      el['repo-url'].disabled = value || offline;
      el['repo-ref'].disabled = value || offline;
      el['import-file'].disabled = value;
      el['import-example'].disabled = value;
      el['export-data'].disabled = value;
      el['export-page'].disabled = value || typeof options.exportPage !== 'function';
      el['import-cancel'].hidden = !value;
      el['import-cancel'].disabled = false;
      el['import-form'].setAttribute('aria-busy', String(value));
      el['import-progress'].hidden = !value;
      if (section) section.classList.toggle('is-importing', value);
    }

    function begin(phase, message) {
      const job = {id: `import-${Date.now()}-${++sequence}`, worker: null, objectURL: null, databases: new Set(), applying: false};
      activeJob = job;
      busy(true);
      el['import-progress'].removeAttribute('value');
      status('working', phase, message);
      return job;
    }

    function release(job) {
      job.worker?.terminate();
      if (job.objectURL) URL.revokeObjectURL(job.objectURL);
      for (const name of job.databases) deleteDatabase(name);
      if (activeJob === job) activeJob = null;
      busy(false);
    }

    function fail(job, error) {
      if (activeJob !== job || disposed) return;
      release(job);
      status('error', '导入未完成', readableError(error, '请检查仓库地址或文件后重试。'));
    }

    async function activate(job, history, rawProject, rawEditorial) {
      if (activeJob !== job || disposed) return;
      job.applying = true;
      el['import-cancel'].disabled = true;
      status('working', '正在生成影片', '提交和文件变化已读取，正在准备画面。');
      const editorial = rawEditorial == null ? root.GitHistoryAdapter.editorial(history) : root.GitProject.normalizeEditorial(rawEditorial, history);
      const project = rawProject == null ? undefined : root.GitProject.normalize(rawProject, history, editorial);
      await options.activate(history, editorial, project);
      if (activeJob !== job || disposed) return;
      release(job);
      const name = history.name || 'Git 仓库';
      status('success', '影片已生成', `${name} · ${formatNumber.format(history.totalCommits)} 个独立提交 · ${formatNumber.format(history.finalFileCount)} 个文件。可以直接播放、调速或导出。`);
    }

    function cancel() {
      const job = activeJob;
      if (!job || job.applying) return;
      release(job);
      status('idle', '已取消导入', '当前影片保留，可以重新选择仓库或文件。');
    }

    function workerFor(job) {
      if (typeof Worker !== 'function') throw new Error('当前浏览器无法运行 Git 解析线程。可以换用支持 Web Worker 的浏览器，或导入已生成的 JSON 数据。');
      let url = new URL('./git-worker.js', document.baseURI);
      if (typeof root.GIT_WORKER_SOURCE === 'string' && root.GIT_WORKER_SOURCE.length) {
        job.objectURL = URL.createObjectURL(new Blob([root.GIT_WORKER_SOURCE], {type: 'text/javascript'}));
        url = job.objectURL;
      }
      const worker = new Worker(url);
      job.worker = worker;
      worker.onmessage = event => {
        const message = event.data;
        if (activeJob !== job || disposed || !message || message.id !== job.id) return;
        if (message.type === 'database') {
          for (const name of Array.isArray(message.names) ? message.names : [message.name]) {
            if (typeof name === 'string' && name.startsWith('git-growth-')) job.databases.add(name);
          }
        } else if (message.type === 'progress') {
          if (Number.isFinite(message.total) && message.total > 0 && Number.isFinite(message.loaded)) {
            el['import-progress'].max = message.total;
            el['import-progress'].value = Math.max(0, Math.min(message.total, message.loaded));
          } else el['import-progress'].removeAttribute('value');
          const labels = {clone: '正在读取远程仓库', download: '正在下载 Git 历史', fetch: '正在下载 Git 历史', index: '正在索引 Git 对象', indexing: '正在索引 Git 对象', commits: '正在读取全部提交', trees: '正在比较文件变化', compare: '正在比较文件变化', validate: '正在核验完整历史', normalize: '正在准备影片', bundle: '正在读取本地历史'};
          const phase = labels[message.phase] || String(message.phase || '正在导入');
          const count = Number.isFinite(message.total) && message.total > 0 && Number.isFinite(message.loaded) ? ` ${formatNumber.format(message.loaded)} / ${formatNumber.format(message.total)}` : '';
          status('working', phase, String(message.message || '请稍候，可以随时取消。') + count);
        } else if (message.type === 'result') {
          // This worker invokes the shared validator before posting a result.
          // User-authored JSON goes through normalize below instead.
          if (!message.history?.validation?.passed || !Array.isArray(message.history.commits)) {
            fail(job, 'Git 历史未通过完整性核验，没有替换当前影片。');
            return;
          }
          activate(job, message.history).catch(error => fail(job, error));
        } else if (message.type === 'error') fail(job, message.message);
      };
      worker.onerror = event => {
        event.preventDefault();
        fail(job, event.message || 'Git 解析线程未能完成，请检查文件是否包含完整历史。');
      };
      worker.onmessageerror = () => fail(job, '浏览器未能接收生成的数据，请重试或使用较小的仓库。');
      return worker;
    }

    async function importURL(value, ref = '') {
      if (activeJob || disposed) return;
      if (offline) { status('error', '请在在线页面导入 GitHub 地址', '当前离线页面可以直接导入 .bundle 或 .json 文件。'); return; }
      let url;
      try {
        url = normalizeGitHubURL(value);
        if (String(ref).length > 250 || /[\x00-\x1f\x7f]/.test(String(ref))) throw new Error('分支名称格式不正确。');
      } catch (error) { status('error', '请检查仓库地址', readableError(error, '请填写有效的 GitHub 仓库地址。')); return; }
      el['repo-url'].value = url;
      const job = begin('正在连接仓库', '将读取所选分支的完整可达提交历史。');
      try { workerFor(job).postMessage({id: job.id, action: 'clone', url, ref: String(ref || '').trim()}); }
      catch (error) { fail(job, error); }
    }

    async function importFile(file) {
      if (activeJob || disposed || !file) return;
      if (file.size > MAX_FILE_BYTES) { status('error', '文件过大', '单次导入上限为 100 MiB。请使用完整历史的精简 JSON，或在本地提取后导入。'); return; }
      if (!/\.(bundle|json)$/i.test(file.name)) { status('error', '请选择 Git 历史文件', '支持 .bundle 或生成过的 .json。普通源码 ZIP 不包含提交历史。'); return; }
      const json = /\.json$/i.test(file.name);
      const job = begin(json ? '正在读取项目数据' : '正在读取本地 Git 历史', `${file.name} · 在当前浏览器中处理。`);
      try {
        if (json) {
          let parsed;
          try { parsed = JSON.parse(await file.text()); }
          catch (_) { throw new Error('JSON 文件无法解析，请选择完整的 Git 生长影片数据文件。'); }
          if (activeJob !== job) return;
          const history = root.GitHistoryAdapter.normalize(parsed?.history || parsed);
          await activate(job, history, parsed?.project, parsed?.editorial);
        } else {
          workerFor(job).postMessage({id: job.id, action: 'bundle', file, ref: String(el['repo-ref'].value || '').trim(), name: file.name.replace(/\.bundle$/i, '')});
        }
      } catch (error) { fail(job, error); }
      finally { el['import-file'].value = ''; }
    }

    el['import-form'].addEventListener('submit', event => { event.preventDefault(); importURL(el['repo-url'].value, el['repo-ref'].value); }, {signal: listeners.signal});
    el['import-file'].addEventListener('change', event => importFile(event.target.files?.[0]), {signal: listeners.signal});
    el['import-cancel'].addEventListener('click', cancel, {signal: listeners.signal});
    el['import-example'].addEventListener('click', async () => {
      if (activeJob || typeof options.restoreExample !== 'function') return;
      const job = begin('正在恢复初始项目', '读取打开页面时的影片。');
      job.applying = true; el['import-cancel'].hidden = true;
      try { await options.restoreExample(); release(job); status('success', '初始影片已恢复', '也可以导入自己的 Git 仓库，生成另一段影片。'); }
      catch (error) { fail(job, error); }
    }, {signal: listeners.signal});
    el['export-data'].addEventListener('click', () => {
      if (activeJob) return;
      try {
        const current = options.current();
        if (!current?.history?.commits?.length) throw new Error('请先生成一段影片。');
        const payload = {format: 'git-growth-project', version: 2, exportedAt: new Date().toISOString(), history: current.history, editorial: current.editorial || null, project: current.project || null};
        saveBlob(new Blob([JSON.stringify(payload)], {type: 'application/json'}), downloadName(current.history.name) + '.git-growth.json');
        status('success', '项目数据已生成', '下载的 JSON 可以再次导入，恢复这段完整提交历史。');
      } catch (error) { status('error', '未能导出项目数据', readableError(error, '请重试。')); }
    }, {signal: listeners.signal});
    el['export-page'].addEventListener('click', async () => {
      if (activeJob || typeof options.exportPage !== 'function') return;
      el['export-page'].disabled = true;
      try { await options.exportPage(); status('success', '离线页面已生成', '下载后可直接打开，继续播放、调速或导入本地历史。'); }
      catch (error) { status('error', '未能导出离线页面', readableError(error, '请重试。')); }
      finally { el['export-page'].disabled = !!activeJob; }
    }, {signal: listeners.signal});
    el['import-command-copy'].addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(el['import-command'].textContent.trim());
        status('idle', '命令已复制', '在本地 Git 仓库目录中运行，然后选择生成的 history.bundle。');
      } catch (_) { status('idle', '可以手动复制这条命令', '选中下方命令，在本地 Git 仓库目录中运行。'); }
    }, {signal: listeners.signal});

    busy(false);
    status('idle', '准备好导入你的仓库', '粘贴公开 GitHub 地址，或选择本地 Git 历史包，自动生成影片。');
    if (offline) {
      const note = document.createElement('p'); note.className = 'import-offline-note';
      note.textContent = '离线页面可直接导入 .bundle / .json；GitHub 地址导入请打开在线页面。';
      el['import-form'].append(note);
      el['import-submit'].title = note.textContent;
    }
    instance = Object.freeze({importURL, importFile, cancel, dispose() {
      disposed = true; listeners.abort();
      if (activeJob) { activeJob.applying = false; release(activeJob); }
      instance = null;
    }});
    return instance;
  }

  root.GitImportUI = Object.freeze({init, normalizeGitHubURL, downloadName});
})(typeof window !== 'undefined' ? window : globalThis);
