/* Loon response script: capture Finka relationship-list pages and request context. */
(function () {
  const STORE_KEY = "finka.unmatched.manager.v1";
  const NOTIFY_KEY = "finka.unmatched.notify.v1";
  const CONTROL_URL = "http://finka-unfollow.loon.invalid/";
  const NOTIFY_COOLDOWN_MS = 60000;

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

  function queryValue(url, name) {
    const query = String(url || "").split("?")[1] || "";
    const parts = query.split("#")[0].split("&");
    for (let i = 0; i < parts.length; i += 1) {
      const pair = parts[i].split("=");
      try {
        if (decodeURIComponent(pair[0] || "") === name) {
          return decodeURIComponent(pair.slice(1).join("=") || "");
        }
      } catch (_) {}
    }
    return null;
  }

  function copyHeaders(headers) {
    const allowed = {
      "accept": true,
      "accept-language": true,
      "user-agent": true,
      "x-aloha-sassid": true,
      "x-app-auth": true,
      "x-app-bluedeviceinfo": true,
      "x-app-device": true,
      "x-app-devicename": true,
      "x-app-digitalalliance-id": true,
      "x-app-guid": true,
      "x-app-location": true,
      "x-app-package": true,
      "x-app-user": true,
      "x-app-version": true,
      "x-screen-height": true,
      "x-screen-topsafeareaheight": true,
      "x-screen-width": true,
      "x-version-build": true
    };
    const result = {};
    Object.keys(headers || {}).forEach(function (name) {
      if (allowed[String(name).toLowerCase()]) result[name] = headers[name];
    });
    return result;
  }

  function validIds(list) {
    return (Array.isArray(list) ? list : []).map(function (item) {
      return item && typeof item.id === "string" ? item.id : null;
    }).filter(function (id) { return !!id; });
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

  function maybeNotify(sourceKey, count) {
    if (typeof $notification === "undefined" || !$notification || typeof $notification.post !== "function") return;
    const nowMs = Date.now();
    let state = {};
    const raw = $persistentStore.read(NOTIFY_KEY);
    if (raw) {
      try { state = JSON.parse(raw) || {}; } catch (_) { state = {}; }
    }
    const lastAt = Number(state[sourceKey]) || 0;
    if (nowMs - lastAt < NOTIFY_COOLDOWN_MS) return;
    state[sourceKey] = nowMs;
    $persistentStore.write(JSON.stringify(state), NOTIFY_KEY);
    const label = sourceKey === "banned" ? "封禁/注销" : "未回关";
    $notification.post(
      "翻咔取关助手",
      label + "名单已识别",
      "本页采集 " + count + " 人，点击进入一键取关页面。",
      CONTROL_URL
    );
  }

  try {
    if (!$response || typeof $response.body !== "string") {
      throw new Error("missing response body");
    }
    const root = JSON.parse($response.body);
    if (!root || root.success !== true || !root.data || !Array.isArray(root.data.list)) {
      throw new Error("unexpected API response");
    }

    const cursorUsed = queryValue($request.url, "cursor");
    const sourceKey = String($request.url || "").indexOf("/vas/relation/liked/ban") >= 0 ? "banned" : "unmatched";
    const pageIds = validIds(root.data.list);
    const now = new Date().toISOString();
    let db = null;
    const raw = $persistentStore.read(STORE_KEY);
    if (raw) {
      try { db = JSON.parse(raw); } catch (_) { db = null; }
    }

    if (!db || !Array.isArray(db.ids)) {
      db = {
        version: 1,
        capturedAt: now,
        updatedAt: now,
        ids: pageIds,
        headers: copyHeaders($request.headers),
        actionToken: createActionToken(),
        sources: {},
        scanComplete: false,
        progress: { nextIndex: 0, success: 0, failed: 0, failures: [] }
      };
    } else {
      if (!db.actionToken) db.actionToken = createActionToken();
      if (!cursorUsed) {
        db.ids = pageIds;
        db.sources = {};
        db.capturedAt = now;
        db.progress = { nextIndex: 0, success: 0, failed: 0, failures: [] };
      } else {
        db.ids = mergeIds(db.ids, pageIds);
      }
      db.headers = copyHeaders($request.headers);
      if (!db.sources || typeof db.sources !== "object") db.sources = {};
      db.scanComplete = false;
      db.updatedAt = now;
    }
    db.sources[sourceKey] = {
      captured: true,
      nextCursor: typeof root.data.nextCursorId === "string" ? root.data.nextCursorId : "",
      firstPageCount: pageIds.length
    };

    if (!$persistentStore.write(JSON.stringify(db), STORE_KEY)) {
      throw new Error("persistent store write failed");
    }
    if (!cursorUsed) maybeNotify(sourceKey, pageIds.length);
    console.log("Finka " + sourceKey + " page captured: " + pageIds.length + " items.");
  } catch (error) {
    console.log("Finka relationship capture failed: " + messageOf(error));
  }
  $done({});
})();

