/* Loon request script: scan all pages and run rate-limited unfollow batches. */
(function () {
  const STORE_KEY = "finka.unmatched.manager.v1";
  const CONTROL_URL = "http://finka-unfollow.loon.invalid/";
  const LIST_SOURCES = [
    { key: "unmatched", label: "未回关", url: "https://api.finka.cn/vas/relation/liked/unmatched" },
    { key: "banned", label: "封禁/注销", url: "https://api.finka.cn/vas/relation/liked/ban" }
  ];
  const UNFOLLOW_URL = "https://api.finka.cn/user/match/dislike/v3";
  const BATCH_SIZE = 100;
  const CONCURRENCY = 4;
  const LAUNCH_INTERVAL_MS = 120;
  const RETRY_DELAY_MS = 1800;
  const MAX_RETRIES = 2;
  const RUN_LOCK_TTL_MS = 10 * 60 * 1000;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function messageOf(error) {
    if (error && error.message) return error.message;
    try { return String(error); } catch (_) { return "unknown error"; }
  }

  function createActionToken() {
    let token = Date.now().toString(36);
    for (let i = 0; i < 4; i += 1) {
      token += ("0000000" + Math.floor(Math.random() * 0x100000000).toString(36)).slice(-7);
    }
    return token;
  }

  function loadDb() {
    const raw = $persistentStore.read(STORE_KEY);
    if (!raw) return null;
    try {
      const db = JSON.parse(raw);
      if (!db || !Array.isArray(db.ids) || !db.headers) return null;
      if (!db.progress) db.progress = { nextIndex: 0, success: 0, failed: 0, failures: [] };
      if (!Array.isArray(db.progress.failures)) db.progress.failures = [];
      let changed = false;
      if (!db.actionToken) {
        db.actionToken = createActionToken();
        changed = true;
      }
      if (db.progress.running) {
        const startedAt = Date.parse(db.progress.runningAt || "");
        if (!startedAt || Date.now() - startedAt > RUN_LOCK_TTL_MS) {
          db.progress.running = false;
          delete db.progress.runningAt;
          changed = true;
        }
      }
      if (changed) saveDb(db);
      return db;
    } catch (_) { return null; }
  }

  function saveDb(db) {
    db.updatedAt = new Date().toISOString();
    if (!$persistentStore.write(JSON.stringify(db), STORE_KEY)) {
      throw new Error("persistent store write failed");
    }
  }

  function actionUrl(db, path) {
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(db.actionToken);
  }

  function hasActionToken(db, parsed) {
    return !!db && typeof db.actionToken === "string" && parsed.searchParams.get("token") === db.actionToken;
  }

  function mergeIds(current, additions) {
    const seen = {};
    const result = [];
    (current || []).concat(additions || []).forEach(function (id) {
      if (typeof id === "string" && id && !seen[id]) {
        seen[id] = true;
        result.push(id);
      }
    });
    return result;
  }

  function cloneDb(db) {
    return JSON.parse(JSON.stringify(db));
  }

  function requestHeaders(db, isPost) {
    const blocked = {
      "accept-encoding": true,
      "connection": true,
      "content-length": true,
      "digest": true,
      "host": true,
      "proxy-connection": true,
      "transfer-encoding": true
    };
    const headers = {};
    Object.keys(db.headers || {}).forEach(function (name) {
      if (!blocked[String(name).toLowerCase()]) headers[name] = db.headers[name];
    });
    if (isPost) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    else {
      Object.keys(headers).forEach(function (name) {
        if (String(name).toLowerCase() === "content-type") delete headers[name];
      });
    }
    return headers;
  }

  function html(db, notice, autoContinue) {
    const total = db && Array.isArray(db.ids) ? db.ids.length : 0;
    const nextIndex = db && db.progress ? Number(db.progress.nextIndex) || 0 : 0;
    const success = db && db.progress ? Number(db.progress.success) || 0 : 0;
    const failed = db && db.progress ? Number(db.progress.failed) || 0 : 0;
    const remaining = Math.max(0, total - nextIndex);
    const percent = total > 0 ? Math.min(100, Math.round(nextIndex / total * 100)) : 0;
    const capturedAt = db && db.capturedAt ? new Date(db.capturedAt).toLocaleString() : "未采集";
    const scanLabel = db && db.scanComplete ? "名单已完整" : "尚未完成全部分页";
    let actions = "";
    if (!db) {
      actions = '<p class="hint">请先打开翻咔的“未回关”页面一次，再刷新这里。</p>';
    } else {
      actions += '<button class="button secondary navigate-action" type="button" data-url="' + escapeHtml(actionUrl(db, "/scan")) + '">获取完整名单</button>';
      if (db.scanComplete && remaining > 0) {
        actions += '<button id="runAllButton" class="button danger" type="button">一键取关全部剩余用户</button>';
        actions += '<button id="stopButton" class="button ghost" type="button" hidden>完成当前轮后停止</button>';
        actions += '<button class="button secondary confirm-action" type="button" data-url="' + escapeHtml(actionUrl(db, "/run")) + '" data-message="确定只取关下一批最多 ' + BATCH_SIZE + ' 人吗？">只执行下一批（最多 ' + BATCH_SIZE + ' 人）</button>';
      }
      actions += '<button class="button ghost confirm-action" type="button" data-url="' + escapeHtml(actionUrl(db, "/reset")) + '" data-message="确定清除本地名单和进度吗？">清除本地数据</button>';
    }
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      (autoContinue && remaining > 0 ? '<meta http-equiv="refresh" content="1;url=' + escapeHtml(actionUrl(db, "/run-all?continue=1")) + '">' : '') +
      '<title>翻咔未回关管理</title><style>' +
      ':root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
      'body{margin:0;background:#f3f5f7;color:#17202a}.wrap{max-width:560px;margin:auto;padding:24px 18px 48px}' +
      'h1{font-size:28px;margin:12px 0 8px}.sub{color:#68717d;margin:0 0 22px}' +
      '.card{background:#fff;border-radius:18px;padding:18px;box-shadow:0 8px 30px rgba(0,0,0,.07);margin:14px 0}' +
      '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.stat{background:#f6f7f9;border-radius:14px;padding:14px}' +
      '.num{font-size:26px;font-weight:700}.label{font-size:13px;color:#68717d;margin-top:3px}' +
      '.button{display:block;width:100%;box-sizing:border-box;border:0;text-align:center;text-decoration:none;border-radius:14px;padding:15px;margin:12px 0;font-weight:700;font-size:16px;cursor:pointer}' +
      '.secondary{background:#1f6feb;color:#fff}.danger{background:#d92d20;color:#fff}.ghost{background:#e9edf2;color:#27313d}' +
      '.notice{background:#fff3cd;color:#664d03;border-radius:12px;padding:12px;margin:12px 0}.hint{line-height:1.65;color:#68717d}' +
      'progress{display:block;width:100%;height:14px;margin-top:16px;border:0;border-radius:999px;overflow:hidden;background:#e5e9ef}progress::-webkit-progress-bar{background:#e5e9ef;border-radius:999px}progress::-webkit-progress-value{background:#1f6feb;border-radius:999px;transition:width .3s ease}progress::-moz-progress-bar{background:#1f6feb;border-radius:999px}.progress-line{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:14px}.running{opacity:.65;pointer-events:none}' +
      'dialog{width:min(420px,calc(100% - 36px));box-sizing:border-box;border:0;border-radius:16px;padding:20px;background:#fff;color:#17202a}dialog:modal{overscroll-behavior:contain}dialog::backdrop{background:rgba(0,0,0,.45);overflow:hidden;overscroll-behavior:contain}.dialog-actions{display:flex;gap:10px;margin-top:18px}.dialog-actions .button{margin:0}.small{font-size:12px;color:#7a838e;line-height:1.55}@media(prefers-color-scheme:dark){body{background:#111417;color:#eef2f6}.card,dialog{background:#1c2228;color:#eef2f6}.stat{background:#252c33}.sub,.label,.hint,.small{color:#aab4bf}.ghost{background:#303841;color:#f2f5f8}.notice{background:#443a17;color:#ffe69c}}' +
      '</style></head><body><main class="wrap"><h1>翻咔未回关管理</h1>' +
      '<p class="sub">未回关 + 封禁/注销 · 自动合并去重</p>' +
      '<div id="liveNotice" class="notice" role="status" aria-live="polite"' + (notice ? '' : ' hidden') + '>' + escapeHtml(notice || '') + '</div>' +
      '<div class="card"><div class="grid">' +
      '<div class="stat"><div id="totalCount" class="num">' + total + '</div><div class="label">名单人数</div></div>' +
      '<div class="stat"><div id="remainingCount" class="num">' + remaining + '</div><div class="label">剩余人数</div></div>' +
      '<div class="stat"><div id="successCount" class="num">' + success + '</div><div class="label">成功</div></div>' +
      '<div class="stat"><div id="failedCount" class="num">' + failed + '</div><div class="label">失败</div></div>' +
      '</div><progress id="progressBar" max="100" value="' + percent + '" aria-label="取关进度">' + percent + '%</progress>' +
      '<div class="progress-line"><span id="progressText">已处理 ' + nextIndex + ' / ' + total + '</span><strong id="progressPercent">' + percent + '%</strong></div>' +
      '<p class="hint">' + scanLabel + ' · 采集时间：' + escapeHtml(capturedAt) + '</p></div>' +
      '<div class="card">' + actions + '<a class="button ghost" href="/">刷新状态</a></div>' +
      '<p class="small">执行时页面每约 0.5 秒读取本地进度。极速模式最多同时处理 ' + CONCURRENCY + ' 个请求，每 0.12 秒启动 1 个，每轮最多 ' + BATCH_SIZE + ' 人；遇到接口错误或限流会自动放慢并重试。</p>' +
      '</main><dialog id="confirmDialog" aria-labelledby="confirmTitle"><form method="dialog"><h2 id="confirmTitle">确认操作</h2><p id="confirmMessage"></p><div class="dialog-actions"><button class="button ghost" value="cancel" autofocus>取消</button><button class="button danger" value="confirm">确定</button></div></form></dialog><script>' +
      '(function(){var running=false,actionToken=' + JSON.stringify(db ? db.actionToken : "") + ';function byId(id){return document.getElementById(id)}function text(id,value){var el=byId(id);if(el)el.textContent=String(value)}' +
      'function actionUrl(path){return path+(path.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(actionToken)}' +
      'function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}function showNotice(message){var n=byId("liveNotice");if(n){n.hidden=false;n.textContent=message}}' +
      'function ask(message){var dialog=byId("confirmDialog");if(!dialog||typeof dialog.showModal!=="function")return Promise.resolve(confirm(message));text("confirmMessage",message);return new Promise(function(resolve){function closed(){dialog.removeEventListener("close",closed);resolve(dialog.returnValue==="confirm")}dialog.addEventListener("close",closed);dialog.showModal()})}' +
      'function update(s){if(!s)return;text("totalCount",s.total);text("remainingCount",s.remaining);text("successCount",s.success);text("failedCount",s.failed);text("progressText","已处理 "+s.processed+" / "+s.total);text("progressPercent",s.percent+"%");var bar=byId("progressBar");if(bar)bar.value=s.percent;if(s.notice)showNotice(s.notice)}' +
      'async function readStatus(){var r=await fetch("/status?_="+Date.now(),{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);var s=await r.json();update(s);return s}' +
      'async function runRound(){var settled=false,result=null,failure=null;fetch(actionUrl("/run-all?ajax=1")+"&_="+Date.now(),{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(v){result=v;settled=true}).catch(function(e){failure=e;settled=true});while(!settled){await wait(500);try{await readStatus()}catch(_){}}if(failure)throw failure;update(result);return result}' +
      'async function startAll(){if(running)return;var current=await readStatus();if(!current.scanComplete||!current.remaining)return;if(!await ask("确定连续取关剩余 "+current.remaining+" 人吗？"))return;running=true;var start=byId("runAllButton"),stop=byId("stopButton");if(start){start.classList.add("running");start.textContent="正在取关…"}if(stop)stop.hidden=false;try{while(running){var state=await runRound();if(!state.remaining)break}var finalState=await readStatus();showNotice(finalState.failed?"处理结束，失败 "+finalState.failed+" 人。请重新获取名单后重试。":(finalState.remaining?"已停止。剩余 "+finalState.remaining+" 人。":"全部处理完成。"))}catch(e){showNotice("执行中断："+e.message)}running=false;if(start){start.classList.remove("running");start.textContent="一键取关全部剩余用户"}if(stop)stop.hidden=true}' +
      'var runAll=byId("runAllButton");if(runAll)runAll.addEventListener("click",startAll);var stop=byId("stopButton");if(stop)stop.addEventListener("click",function(){running=false;showNotice("将在当前轮完成后停止。")} );document.querySelectorAll(".navigate-action").forEach(function(button){button.addEventListener("click",function(){location.href=button.dataset.url})});document.querySelectorAll(".confirm-action").forEach(function(button){button.addEventListener("click",async function(){if(await ask(button.dataset.message))location.href=button.dataset.url})});' +
      '})();</script></body></html>';
  }

  function progressPayload(db, notice) {
    const total = db && Array.isArray(db.ids) ? db.ids.length : 0;
    const processed = db && db.progress ? Number(db.progress.nextIndex) || 0 : 0;
    const success = db && db.progress ? Number(db.progress.success) || 0 : 0;
    const failed = db && db.progress ? Number(db.progress.failed) || 0 : 0;
    return {
      total: total,
      processed: processed,
      remaining: Math.max(0, total - processed),
      success: success,
      failed: failed,
      percent: total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0,
      scanComplete: !!(db && db.scanComplete),
      running: !!(db && db.progress && db.progress.running),
      notice: notice || ""
    };
  }

  function responseHeaders(contentType) {
    return {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY"
    };
  }

  function finishPage(db, notice, autoContinue, status) {
    $done({ response: { status: status || 200, headers: responseHeaders("text/html; charset=utf-8"), body: html(db, notice, autoContinue === true) } });
  }

  function finishJson(db, notice, status) {
    $done({ response: { status: status || 200, headers: responseHeaders("application/json; charset=utf-8"), body: JSON.stringify(progressPayload(db, notice)) } });
  }

  function scan(db) {
    const previousDb = cloneDb(db);
    const candidate = cloneDb(db);
    db.scanComplete = false;
    saveDb(db);
    candidate.ids = [];
    candidate.sources = {};
    candidate.scanComplete = false;
    candidate.progress = { nextIndex: 0, success: 0, failed: 0, failures: [] };
    let sourceIndex = 0;
    let cursor = "";
    let pagesForSource = 0;
    const seenCursors = {};
    const seenIdsBySource = {};

    function stopAndRestore(notice) {
      try {
        saveDb(previousDb);
        finishPage(previousDb, notice);
      } catch (restoreError) {
        finishPage(db, notice + "；恢复旧名单失败：" + messageOf(restoreError), false, 500);
      }
    }

    function next() {
      if (sourceIndex >= LIST_SOURCES.length) {
        candidate.scanComplete = true;
        saveDb(candidate);
        finishPage(candidate, "完整名单获取完成，已合并未回关与封禁/注销用户。");
        return;
      }
      const source = LIST_SOURCES[sourceIndex];
      const cursorKey = source.key + ":" + cursor;
      if (cursor && seenCursors[cursorKey]) {
        stopAndRestore(source.label + "名单出现重复分页游标，已保留上次完整名单。");
        return;
      }
      if (cursor) seenCursors[cursorKey] = true;
      const url = source.url + "?_t=" + Date.now() + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      $httpClient.get({ url: url, headers: requestHeaders(candidate, false), timeout: 10000 }, function (error, response, data) {
        try {
          if (error) throw new Error(error);
          if (!response || response.status < 200 || response.status >= 300) throw new Error("HTTP " + (response && response.status));
          const root = JSON.parse(data || "");
          if (!root || root.success !== true || !root.data || !Array.isArray(root.data.list)) throw new Error("unexpected page response");
          const ids = root.data.list.map(function (item) { return item && item.id; }).filter(function (id) { return typeof id === "string" && id; });
          const nextCursor = typeof root.data.nextCursorId === "string" ? root.data.nextCursorId : "";
          const sourceSeen = seenIdsBySource[source.key] || (seenIdsBySource[source.key] = {});
          let newForSource = 0;
          ids.forEach(function (id) {
            if (!sourceSeen[id]) {
              sourceSeen[id] = true;
              newForSource += 1;
            }
          });
          if (ids.length && newForSource === 0 && nextCursor && nextCursor !== cursor) {
            stopAndRestore(source.label + "分页内容没有新增用户，已停止并保留上次完整名单。");
            return;
          }
          candidate.ids = mergeIds(candidate.ids, ids);
          pagesForSource += 1;
          candidate.sources[source.key] = {
            label: source.label,
            pages: pagesForSource,
            count: (candidate.sources[source.key] ? Number(candidate.sources[source.key].count) || 0 : 0) + newForSource,
            complete: !ids.length || !nextCursor || nextCursor === cursor
          };
          if (!ids.length || !nextCursor || nextCursor === cursor) {
            sourceIndex += 1;
            cursor = "";
            pagesForSource = 0;
          } else {
            cursor = nextCursor;
          }
          setTimeout(next, 250);
        } catch (caught) {
          stopAndRestore("分页获取停止：" + messageOf(caught) + "；已保留上次完整名单。");
        }
      });
    }
    next();
  }

  function runBatch(db, autoContinue, jsonMode) {
    const start = Number(db.progress.nextIndex) || 0;
    const end = Math.min(db.ids.length, start + BATCH_SIZE);
    if (start >= end) {
      db.progress.running = false;
      delete db.progress.runningAt;
      saveDb(db);
      const completeNotice = db.progress.failed > 0 ? "处理结束，失败 " + db.progress.failed + " 人。请重新获取名单后重试。" : "当前名单已处理完成。";
      if (jsonMode) finishJson(db, completeNotice);
      else finishPage(db, completeNotice);
      return;
    }
    db.progress.running = true;
    db.progress.runningAt = new Date().toISOString();
    saveDb(db);
    let nextToLaunch = start;
    let active = 0;
    let finished = false;
    let launchScheduled = false;
    const completed = {};

    function abortRun(error) {
      if (finished) return;
      finished = true;
      db.progress.running = false;
      delete db.progress.runningAt;
      try { saveDb(db); } catch (_) {}
      const notice = "执行中断：" + messageOf(error);
      if (jsonMode) finishJson(db, notice, 500);
      else finishPage(db, notice, false, 500);
    }

    function finishIfDone() {
      if (!finished && nextToLaunch >= end && active === 0) {
        finished = true;
        db.progress.running = false;
        delete db.progress.runningAt;
        try { saveDb(db); } catch (saveError) {
          finished = false;
          abortRun(saveError);
          return true;
        }
        const remaining = Math.max(0, db.ids.length - (Number(db.progress.nextIndex) || 0));
        const completeNotice = db.progress.failed > 0 ? "处理结束，失败 " + db.progress.failed + " 人。请重新获取名单后重试。" : "全部处理完成。";
        if (jsonMode) {
          finishJson(db, remaining > 0 ? "本轮处理完成。" : completeNotice);
        } else if (autoContinue && remaining > 0) {
          finishPage(db, "本轮处理完成，1 秒后自动继续。剩余 " + remaining + " 人。", true);
        } else {
          finishPage(db, remaining > 0 ? "本批处理完成，可继续下一批。" : completeNotice, false);
        }
        return true;
      }
      return false;
    }

    function schedulePump(delay) {
      if (finished || launchScheduled) return;
      launchScheduled = true;
      setTimeout(function () {
        launchScheduled = false;
        pump();
      }, delay);
    }

    function recordCompletion(itemIndex, userId, success, reason) {
      if (success) db.progress.success += 1;
      else {
        db.progress.failed += 1;
        db.progress.failures.push({ id: userId, reason: reason, at: new Date().toISOString() });
      }
      completed[itemIndex] = true;
      while (completed[db.progress.nextIndex]) {
        delete completed[db.progress.nextIndex];
        db.progress.nextIndex += 1;
      }
      active -= 1;
      try { saveDb(db); } catch (saveError) {
        abortRun(saveError);
        return;
      }
      if (!finishIfDone()) schedulePump(0);
    }

    function send(itemIndex, retryCount) {
      const userId = db.ids[itemIndex];
      const body = "_t=" + Date.now() +
        "&recommendContext=" + encodeURIComponent("{\n\n}") +
        "&refer=" + encodeURIComponent("followingUserToProfile") +
        "&userId=" + encodeURIComponent(userId);
        $httpClient.post({ url: UNFOLLOW_URL, headers: requestHeaders(db, true), body: body, timeout: 10000 }, function (error, response, data) {
          let success = false;
          let reason = "unknown error";
          try {
            if (error) throw new Error(error);
            if (!response || response.status < 200 || response.status >= 300) throw new Error("HTTP " + (response && response.status));
            const root = JSON.parse(data || "");
            success = root && root.success === true;
            if (!success) reason = "API success=false";
          } catch (caught) {
            reason = messageOf(caught);
          }
          if (!success && retryCount < MAX_RETRIES) {
            setTimeout(function () { send(itemIndex, retryCount + 1); }, RETRY_DELAY_MS * (retryCount + 1));
            return;
          }
          recordCompletion(itemIndex, userId, success, reason);
        });
    }

    function pump() {
      if (finishIfDone() || active >= CONCURRENCY || nextToLaunch >= end) return;
      const itemIndex = nextToLaunch;
      nextToLaunch += 1;
      active += 1;
      send(itemIndex, 0);
      schedulePump(LAUNCH_INTERVAL_MS);
    }
    pump();
  }

  try {
    const parsed = new URL($request.url);
    const path = parsed.pathname || "/";
    const db = loadDb();
    if (path === "/reset") {
      if (!hasActionToken(db, parsed)) { finishPage(db, "操作链接无效，请从当前管理页面重新进入。", false, 403); return; }
      if (db.progress && db.progress.running) { finishPage(db, "正在执行取关，不能清除数据。", false, 409); return; }
      if (!$persistentStore.write("", STORE_KEY)) { finishPage(db, "清除本地数据失败。", false, 500); return; }
      finishPage(null, "本地名单和执行进度已清除。");
      return;
    }
    if (path === "/scan") {
      if (!db) { finishPage(null, "尚未采集名单，请先打开翻咔的未回关页面。"); return; }
      if (!hasActionToken(db, parsed)) { finishPage(db, "操作链接无效，请从当前管理页面重新进入。", false, 403); return; }
      if (db.progress.running) { finishPage(db, "正在执行取关，请结束后再获取名单。", false, 409); return; }
      scan(db);
      return;
    }
    if (path === "/run") {
      if (!db) { finishPage(null, "尚未采集名单，请先打开翻咔的未回关页面。"); return; }
      if (!hasActionToken(db, parsed)) { finishPage(db, "操作链接无效，请从当前管理页面重新进入。", false, 403); return; }
      if (!db.scanComplete) { finishPage(db, "名单尚未完整获取，已阻止执行取关。", false, 409); return; }
      if (db.progress.running) { finishPage(db, "已有取关任务正在执行。", false, 409); return; }
      runBatch(db, false, false);
      return;
    }
    if (path === "/run-all") {
      const jsonMode = parsed.searchParams.get("ajax") === "1";
      if (!db) {
        if (jsonMode) finishJson(null, "尚未采集名单，请先打开翻咔的未回关页面。");
        else finishPage(null, "尚未采集名单，请先打开翻咔的未回关页面。");
        return;
      }
      if (!hasActionToken(db, parsed)) {
        if (jsonMode) finishJson(db, "操作链接无效，请从当前管理页面重新进入。", 403);
        else finishPage(db, "操作链接无效，请从当前管理页面重新进入。", false, 403);
        return;
      }
      if (!db.scanComplete) {
        if (jsonMode) finishJson(db, "名单尚未完整获取，已阻止执行取关。", 409);
        else finishPage(db, "名单尚未完整获取，已阻止执行取关。", false, 409);
        return;
      }
      if (db.progress.running) {
        if (jsonMode) finishJson(db, "已有取关任务正在执行。", 409);
        else finishPage(db, "已有取关任务正在执行。", false, 409);
        return;
      }
      runBatch(db, true, jsonMode);
      return;
    }
    if (path === "/status") {
      finishJson(db, "");
      return;
    }
    finishPage(db, "");
  } catch (error) {
    finishPage(loadDb(), "页面执行失败：" + messageOf(error));
  }
})();

