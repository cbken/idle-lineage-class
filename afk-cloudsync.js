/* ============================================================================
 * afk-cloudsync.js — 雲端存檔同步（Cloudflare Worker + KV）
 *
 * 解決什麼：進度存在「這台裝置的瀏覽器」裡，手機/電腦兩份進度不通。
 *   這裡讓「任何裝置打開網址 → 輸入一次同步金鑰 → 之後永遠是同一份進度」。
 *
 * 🚨 打包哲學完全沿用 afk-fullsave.js：整包 localStorage 搬、不挑 key、連白名單都不要。
 *   任何形式的清單都要跟著上游走，漏搬是安靜失效。B 變成 A 的完整複本，A 跑得動 B 就跑得動。
 *
 * 同步模型（新時間戳贏 + 樂觀鎖）：
 *   - 金鑰：一組 32 碼隨機字串（crypto 產生），即帳號即密碼，存 localStorage(afk_cs_key)。
 *   - 玩家槽（2026-08-18 Ken 要的「一份金鑰存兩個玩家」）：同一金鑰底下 4 份獨立存檔。
 *     每台裝置設定時選「這台是玩家幾」(afk_cs_slot，預設 1)，各槽各推各拉、可同時玩。
 *     切換槽位 = 這台裝置改認另一份雲端存檔（seen 歸零重拉），跟換金鑰同級的大動作。
 *   - 推（本地 → 雲端）：遊玩中每 300 秒 + 分頁躲起來(visibilitychange hidden)/pagehide 時。
 *     PUT 帶 baseTs =「我最後看過的雲端 ts」(afk_cs_seen)；Worker 發現雲端 ts > baseTs
 *     會回 409（別台裝置寫過我沒看到的版本）→ 這時不准蓋，改走拉的流程。
 *   - 拉（雲端 → 本地）：開頁 + 回到分頁(visibilitychange visible) 時 GET。
 *     雲端 ts > afk_cs_seen 才套用：走 fullsave 同款還原（clear + _lzSetStoredRaw 原樣寫回）
 *     → 補寫回金鑰/seen → reload。ts 沒比較新就什麼都不做。
 *   - 套用後 seen = 雲端 ts、推送後 seen = 自己的 ts → 同一台裝置 reload 不會重套、
 *     兩台輪流玩時「較新的那份」永遠贏。
 *
 * 為什麼推得這麼省：CF KV 免費額度寫入 1000 次/天，2026-08-24 實際用到 877（87.7%）。
 *   歸因：尖峰 192 寫/小時，但單一分頁上限只有 30 寫/小時 → 多分頁各跑各的迴圈把寫入乘上去。
 *   四道閘門（見下方「額度四道閘門」）：跨分頁單一寫者 / 內容沒變不寫 / 最小間隔 20 秒 /
 *   每日額度守門。單台掛 10 小時 ≈ 120 寫，開 5 個分頁也還是 120 寫。
 *   代價：當機或斷電最多丟 5 分鐘（正常關頁/切走有 hidden、pagehide 補推，不會丟）。
 *
 * ⚠️ 關頁那一刻的推：sendBeacon / fetch keepalive 有 64KB 上限，整包存檔遠大於此 →
 *   靠 visibilitychange(hidden) 用普通 fetch 推（手機切 app / 桌機切分頁 / 關頁前都會先 hidden）。
 *
 * 優雅降級：沒設金鑰就完全閒置；fetch 失敗只 toast 不打擾；缺 _lzSetStoredRaw 退回 setItem。
 * 掛接：index.html 的 </body> 前、afk-storage.js 之後加 <script src="afk-cloudsync.js"></script>
 * ========================================================================== */
(function () {
  'use strict';

  // Worker 端點（2026-08-18 部署、cbken CF 帳號）
  var ENDPOINT = 'https://idle-lineage-cloudsave.cbken.workers.dev/save';

  // ── 寫入節流（2026-08-25 修：8/24 單日 877 寫、逼近 CF 免費額度 1000/天） ──
  //   實測歸因：尖峰時段 192 寫/小時，而單一分頁上限只有 30 寫/小時 →
  //   主因是「同一台裝置開多個分頁，每個分頁各跑各的上傳迴圈」，寫入次數 × 分頁數。
  //   四道閘門依序擋：① 跨分頁單一寫者 ② 內容沒變不寫 ③ 硬性最小間隔 ④ 每日額度守門。
  var PUSH_EVERY_MS   = 300 * 1000;   // 定時推：5 分鐘（原 120 秒）
  var MIN_PUSH_GAP_MS = 20 * 1000;    // 任何原因的推，兩次之間至少隔 20 秒
  var LEASE_MS        = 15 * 1000;    // 跨分頁「誰負責定時推」的租約
  // ⚠️ 2026-08-26 試過「切回分頁時節流拉取」，做完又拿掉，理由記在這免得以後有人再做一次：
  //   動機是實測一次 GET = 453KB / 約 0.75 秒（其中 410ms 是 workers.dev 從台灣繞路的固定延遲）。
  //   但 pull() 是背景非同步的，本來就不卡畫面 → 省下的 0.34s 使用者根本感覺不到；
  //   代價卻是「另一台剛存的進度，切回來要等 60 秒才看得到」—— 那是這個模組存在的意義本身。
  //   真正該省的是那 410ms（換掉 workers.dev 免費網域），不是砍掉同步即時性。
  var K_KEY  = 'afk_cs_key';    // 同步金鑰
  var K_SEEN = 'afk_cs_seen';   // 最後看過/寫過的雲端 ts（毫秒字串）
  var K_SLOT = 'afk_cs_slot';   // 這台裝置的玩家槽 1~4（🚨 沒有預設值，見 getSlot）
  var S_SLOTOK = 'afk_cs_slot_session';   // 這個分頁已確認過玩家身分（sessionStorage）
  var K_HASH = 'afk_cs_hash';   // 最後成功上傳那包的內容指紋（髒資料檢查用）
  var K_LEAD = 'afk_cs_lead';   // 跨分頁租約 "<分頁id>|<毫秒>"
  var K_WQ   = 'afk_cs_wq';     // 今日已用寫入數 "<UTC日期>|<次數>"
  var K_NP   = 'afk_cs_np';     // 今日實際在用的玩家數 "<UTC日期>|<1~4>"（額度要按人數均分）
  var KEY_RE = /^[A-Za-z0-9_-]{24,64}$/;

  // ── 固定家庭金鑰（2026-08-18 Ken 拍板：金鑰寫死、全家共用、開頁自動連結） ──
  // Worker 端要求 24~64 碼 → 短碼用「重複展開」補到 24+（同一短碼永遠展開成同一長碼）。
  // 頁面本身已有 gate.html 通行碼擋門，這裡的金鑰只是同步定位用。
  function normKey(s) {
    s = String(s || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(s)) return '';
    var out = s;
    while (out.length < 24) out += s;
    return out.slice(0, 64);
  }
  var FIXED_KEY = normKey('123ken456');
  var FORMAT = 'idle-lineage-full';   // 與 fullsave 同格式，備援時可互通
  var SCHEMA = 1;

  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'cloudsync', parent: 'storage', name: '雲端存檔同步', group: '系統與其他', def: true,
    desc: '用同步金鑰把進度存到雲端，任何裝置打開網址、輸入同一組金鑰，就是同一份進度'
  });
  function on() { try { return !window.AFK_TOGGLES || AFK_TOGGLES.enabled('cloudsync'); } catch (e) { return true; } }

  function getKey()  { try { return localStorage.getItem(K_KEY) || ''; } catch (e) { return ''; } }
  function getSeen() { var n = Number(localStorage.getItem(K_SEEN)); return isFinite(n) ? n : 0; }
  function setSeen(ts) { try { localStorage.setItem(K_SEEN, String(ts)); } catch (e) {} }
  // 🚨 2026-09-05：這裡原本是 `: '1'`（沒選過就當玩家1）。
  //    後果：新裝置／新瀏覽器／清過資料／直接開遊戲網址沒走 gate.html —— 通通落到玩家1，
  //    而玩家1 是 Ken 本人 → 別人一開就拉走他的存檔，再一推就蓋掉。9/5 真的發生了（槽1 被玩家2 整份覆蓋）。
  //    修法：不給預設值。沒選過就回空字串，由 slotGate() 擋住整個開機流程強制選人。
  function getSlot() { var s = localStorage.getItem(K_SLOT); return /^[1-4]$/.test(s) ? s : ''; }
  function slotChosen() {
    if (!/^[1-4]$/.test(getSlot())) return false;
    try { return sessionStorage.getItem(S_SLOTOK) === '1'; } catch (e) { return true; }   // 無 sessionStorage 就別擋死
  }
  function apiUrl(key) {
    var s = getSlot();
    if (!s) throw new Error('slot not chosen');   // 防呆：沒選人之前不准對雲端做任何事
    return ENDPOINT + '?key=' + encodeURIComponent(key) + '&slot=' + s;
  }

  // ── 額度四道閘門 ───────────────────────────────────────────
  // ① 跨分頁單一寫者：同一台裝置開 N 個分頁時，只有一個分頁跑定時上傳（其餘只讀不寫）。
  //    localStorage 同 origin 共享 → 拿它當租約即可；租約 15 秒沒續就換人接手（分頁關掉不會卡死）。
  //    ⚠️ 只擋「定時推」；使用者關頁/切走(hidden,pagehide)那一刻每個分頁都還是要推，不能擋。
  var _tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function leadOk() {
    try {
      var raw = String(localStorage.getItem(K_LEAD) || ''), i = raw.lastIndexOf('|');
      var id = i < 0 ? '' : raw.slice(0, i), at = i < 0 ? 0 : Number(raw.slice(i + 1));
      if (id && id !== _tabId && isFinite(at) && Date.now() - at < LEASE_MS) return false;
      localStorage.setItem(K_LEAD, _tabId + '|' + Date.now());
      return true;
    } catch (e) { return true; }   // localStorage 壞掉 → 退回舊行為，寧可多寫也不要不同步
  }

  // ② 內容指紋（髒資料檢查）：跟上次成功上傳的一模一樣就不用再寫一次。
  //    排除 afk_cs_*（seen/hash/lead/wq 每次都變）與 exportedAt（每次都是新時間）。
  function packFingerprint(pack) {
    var h = 0x811c9dc5;
    function mix(s) {
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i) & 0xff;
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
      }
    }
    var ks = [];
    try {
      var all = Object.keys(pack.keys);
      for (var i = 0; i < all.length; i++) if (all[i].indexOf('afk_cs_') !== 0) ks.push(all[i]);
      ks.sort();
      for (var j = 0; j < ks.length; j++) { mix(ks[j]); mix(' '); mix(pack.keys[ks[j]]); mix(''); }
    } catch (e) { return ''; }     // 算不出來就當作「有變」，照推
    return ks.length + '-' + h.toString(36);
  }
  function getHash() { try { return localStorage.getItem(K_HASH) || ''; } catch (e) { return ''; } }
  function setHash(v) { try { localStorage.setItem(K_HASH, v); } catch (e) {} }

  // ④ 每日額度守門：CF 免費額度 1000 寫/天、UTC 00:00 重置（台北 08:00）。
  //    越接近上限推得越省，最後只留 hidden/pagehide —— 保證「使用者要離開」那一次一定寫得進去。
  //    🚨 這是 Ken 的第一要求「存檔不能被刪除」的保險：額度撞牆會讓 PUT 失敗＝存不進去。
  function utcDay() { return new Date().toISOString().slice(0, 10); }
  function writesToday() {
    try { var p = String(localStorage.getItem(K_WQ) || '').split('|'); return p[0] === utcDay() ? (Number(p[1]) || 0) : 0; }
    catch (e) { return 0; }
  }
  function bumpWrites() { try { localStorage.setItem(K_WQ, utcDay() + '|' + (writesToday() + 1)); } catch (e) {} }

  // 🚨 額度是「整個 CF 帳號共用」的 1000 寫/天，不是每台裝置一份。
  //    每台裝置只數得到自己 → 門檻要除以「實際在用的玩家數」，否則 2 個玩家各數到 850 = 1700，穿透總額度。
  //    玩家數一天問雲端一次（1 次 list op，額度 1000/天，可忽略），存 afk_cs_np 快取。
  function players() {
    try {
      var p = String(localStorage.getItem(K_NP) || '').split('|');
      if (p[0] === utcDay()) { var n = Number(p[1]); if (n >= 1 && n <= 4) return n; }
    } catch (e) {}
    return 0;   // 0 = 還不知道
  }
  function refreshPlayers() {
    var key = getKey(); if (!key) return;
    if (players()) return;                                    // 今天問過了
    try { localStorage.setItem(K_NP, utcDay() + '|1'); } catch (e) {}   // 先卡住，避免多分頁同時問
    fetch(ENDPOINT + '?key=' + encodeURIComponent(key) + '&slots=1', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && Number(j.count);
        if (n >= 1 && n <= 4) { try { localStorage.setItem(K_NP, utcDay() + '|' + n); } catch (e) {} }
      })
      .catch(function () {});                                  // 問不到就先當 1 個玩家，明天再問
  }
  function intervalNow() {
    var share = 1 / Math.max(1, players() || 1);               // 不知道就先當 1 個（保守：門檻不會被放寬）
    var n = writesToday();
    if (n < 300 * share) return PUSH_EVERY_MS;      // 正常
    if (n < 600 * share) return 15 * 60 * 1000;     // 吃緊
    if (n < 850 * share) return 30 * 60 * 1000;     // 很緊
    return Infinity;                                // 見底：停掉定時推，只靠 hidden/pagehide
  }

  function genKey() {
    var a = new Uint8Array(24), s = '';
    (window.crypto || window.msCrypto).getRandomValues(a);
    var ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (var i = 0; i < a.length; i++) s += ABC[a[i] & 63];
    return s;
  }

  // ── 打包 / 還原（與 fullsave 同款，不挑 key） ──────────────────
  function buildPack() {
    var keys = {}, n = 0;
    for (var k in localStorage) {
      if (!Object.prototype.hasOwnProperty.call(localStorage, k)) continue;
      var v = localStorage.getItem(k);
      if (v != null) { keys[k] = v; n++; }
    }
    return { format: FORMAT, schema: SCHEMA, exportedAt: new Date().toISOString(), keyCount: n, keys: keys };
  }

  // 只驗「是不是我們的包、完不完整」，絕不檢查 keys 裡裝什麼（同 fullsave 的論證）
  function validatePack(d) {
    if (!d || typeof d !== 'object' || d.format !== FORMAT) return false;
    if (!(d.schema <= SCHEMA)) return false;
    var keys = d.keys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
    var names = Object.keys(keys);
    if (!names.length || (d.keyCount != null && d.keyCount !== names.length)) return false;
    for (var i = 0; i < names.length; i++) if (typeof keys[names[i]] !== 'string') return false;
    return true;
  }

  // 寫入走 _lzSetStoredRaw（原值原樣直寫 + bump rev 讓在途壓縮失效）；缺就退回 setItem
  function rawWrite(k, v) {
    if (typeof window._lzSetStoredRaw === 'function') {
      try { return window._lzSetStoredRaw(k, v) !== false; } catch (e) { return false; }
    }
    try { localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }

  var _applying = false;
  function applyCloud(cloudTs, pack, myKey) {
    _applying = true;
    var mySlot = getSlot();   // clear 前先記下，槽位屬於「這台裝置」不跟著存檔走
    var myGate = null; try { myGate = localStorage.getItem('ilc_gate_ok'); } catch (e) {}
    // 今日額度計數與玩家數不能被 clear 洗掉（洗掉＝守門員歸零，額度保護失效）
    var myWq = null, myNp = null;
    try { myWq = localStorage.getItem(K_WQ); myNp = localStorage.getItem(K_NP); } catch (e) {}
    var names = Object.keys(pack.keys);
    try { localStorage.clear(); } catch (e) { _applying = false; return false; }
    for (var i = 0; i < names.length; i++) {
      if (!rawWrite(names[i], pack.keys[names[i]])) { _applying = false; return false; }
    }
    // 金鑰/槽位/seen 必須是「這台裝置的視角」：金鑰槽位照舊、seen = 剛套用的雲端 ts
    try { localStorage.setItem(K_KEY, myKey); localStorage.setItem(K_SLOT, mySlot); } catch (e) {}
    // 通行碼/選人狀態也屬於「這台裝置」：沒這兩行，pull 完 reload 會被踢回 gate 重輸一次
    try { if (myGate) localStorage.setItem('ilc_gate_ok', myGate); localStorage.setItem('ilc_slot_ok', '1'); } catch (e) {}
    try { if (myWq) localStorage.setItem(K_WQ, myWq); if (myNp) localStorage.setItem(K_NP, myNp); } catch (e) {}
    setSeen(cloudTs);
    // 剛套用完＝這台的內容就是雲端那份 → 指紋記起來，省掉「套用後馬上又原樣推回去」那次寫入
    setHash(packFingerprint(pack));
    return true;
  }

  // ── 推 / 拉 ────────────────────────────────────────────────
  var _busy = false, _lastPushAt = 0, _pendingPush = false, _onPushOk = null;
  var _backoffUntil = 0, _conflicts = 0;   // 跟別台裝置搶同一槽時的退避

  // 收尾：解除 busy；若期間有被擋掉的推（最常見：關頁前 hidden 推撞上進行中的拉）補推一次
  function release() {
    _busy = false;
    if (_pendingPush && !_applying) { _pendingPush = false; push('retry'); }
  }

  function push(reason) {
    if (!on() || _applying) return;
    if (_busy) { _pendingPush = true; return; }   // 別默默丟掉：等在途請求結束後補推
    var key = getKey(); if (!key) return;
    // 🛡️ 空裝置不准上傳：沒有實際遊戲進度的包推上去，會在別台跳出誤導的「雲端已有存檔」
    if (!localHasProgress()) return;

    // 使用者親手按的覆蓋動作不受節流限制（他在等結果，不能靜靜跳過）
    var forced = (reason === 'forcelink' || reason === 'firstrun' || reason === 'manual');
    var now = Date.now();
    // ③ 硬性最小間隔：關頁時 hidden 與 pagehide 會連著觸發，沒這道＝每次關頁白寫兩次
    if (!forced && now - _lastPushAt < MIN_PUSH_GAP_MS) return;
    // 跟別台裝置搶同一槽撞 409 時退避，不要連環撞（每撞一次翻倍，上限 5 分鐘）
    if (!forced && now < _backoffUntil) return;

    var pack, fp;
    try { pack = buildPack(); } catch (e) { return; }
    // ② 髒資料檢查：內容跟上次成功上傳的完全一樣 → 不必花掉一次寫入額度
    fp = packFingerprint(pack);
    if (!forced && fp && fp === getHash()) { _lastPushAt = now; return; }

    _busy = true;
    var ts = Math.max(now, getSeen() + 1);   // 裝置時鐘落後也保持單調遞增
    var body;
    try { body = JSON.stringify({ ts: ts, baseTs: getSeen(), pack: pack }); }
    catch (e) { _busy = false; return; }
    fetch(apiUrl(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body
    }).then(function (r) {
      if (r.status === 409) {
        // 別台裝置寫過更新的 → 不准蓋，改拉（pending 推作廢：馬上要套更新的雲端版了）
        _conflicts++;
        _backoffUntil = Date.now() + Math.min(5 * 60 * 1000, 30 * 1000 * Math.pow(2, _conflicts - 1));
        _busy = false; _pendingPush = false;
        pull('conflict');
        return;
      }
      if (r.ok) {
        setSeen(ts); setHash(fp); bumpWrites();
        _lastPushAt = Date.now(); _backoffUntil = 0; _conflicts = 0;
        setStatus('☁️ 已上傳 ' + fmtT(_lastPushAt) + '（今日 ' + writesToday() + '/1000）');
        if (_onPushOk) { var f = _onPushOk; _onPushOk = null; try { f(); } catch (e) {} }
      } else if (r.status === 503) {
        // 雲端寫入額度用完 → 本機進度沒動、雲端舊存檔也沒動，等額度重置後下一輪自然補上
        setStatus('⏳ 雲端今日寫入額度已滿，進度暫存在這台、稍後自動補上傳。', true);
      }
      release();
    }).catch(function () { _busy = false; _pendingPush = false; /* 離線就算了，下一輪再推 */ });
  }

  // 💾 手動儲存（2026-08-26）：包一層 push('manual')，成功或失敗都一定要回應。
  //    自動推是靜默的沒關係，但「使用者親手按了儲存」如果沒有任何回饋，等於叫他自己猜有沒有存到。
  //    reason='manual' 屬 forced → 不受最小間隔／髒檢查／額度守門影響，按了就是真的送出去。
  function savingNow(cb) {
    var done = false, t0 = Date.now();
    _onPushOk = function () { if (!done) { done = true; cb(true); } };
    (function attempt() {
      if (done) return;
      if (Date.now() - t0 > 12000) { done = true; _onPushOk = null; cb(false); return; }
      push('manual');                       // 若正好有推在途中 → 只登記 pending，不會重複送
      setTimeout(attempt, 1200);            // 沒成功就再試，撐到逾時為止
    })();
  }

  function pull(reason) {
    if (!on() || _busy || _applying) return;
    var key = getKey(); if (!key) return;
    _busy = true;
    fetch(apiUrl(key), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.pack || !(j.ts > getSeen())) {
        if (reason === 'manual') setStatus('✅ 雲端沒有更新的進度（這台就是最新）。');
        release(); return;
      }
      if (!validatePack(j.pack)) { setStatus('❌ 雲端資料格式不對，未套用。', true); release(); return; }
      // 🛡️ 這台有真進度、雲端那包卻是空的 → 絕不套用（空包蓋真檔=災難）
      if (localHasProgress() && !packHasProgress(j.pack)) {
        setSeen(j.ts);   // 沒這行：baseTs < 雲端 ts → 之後每次推都 409 → 又拉 → 無限空轉
        setStatus('⚠️ 雲端那份是空存檔、這台有實際進度 → 未套用（下次上傳會把雲端蓋成這台的版本）。');
        release(); return;
      }
      _busy = false;   // 進套用流程：_applying 會接手擋推，busy 解除但不補推
      // 🚨 套用會蓋掉本機進度 → 只在「雲端確實比較新」時做，做完立刻 reload
      //    （fullsave 的教訓：不 reload 的話，記憶體裡的舊 player 5 秒後就把還原的內容蓋回去）
      if (applyCloud(j.ts, j.pack, key)) {
        setStatus('✅ 已同步雲端進度，重新載入中…');
        setTimeout(function () { try { location.reload(); } catch (e) {} }, 400);
      } else {
        setStatus('❌ 套用雲端進度失敗（儲存空間可能不足）。本機資料可能不完整，請到「完整資料備份與還原」用備份檔救回。', true);
      }
    }).catch(function () { _busy = false; _pendingPush = false; if (reason === 'manual') setStatus('❌ 連不上雲端（沒網路或服務未部署）。', true); });
  }

  // ── 自動連結（固定金鑰） ──────────────────────────────────
  // 這台還沒設金鑰 → 自動掛上 FIXED_KEY。方向判斷：
  //   本機沒進度 → 直接拉雲端（有就套、沒有就等推）。
  //   本機有進度 + 雲端也有 → 跳 confirm 問要用哪邊（防「搬完舊檔被雲端試玩檔蓋掉」）。
  //   本機有進度 + 雲端沒有 → 直接上傳。
  function localHasProgress() {
    var n = 0;
    try {
      for (var k in localStorage) {
        if (!Object.prototype.hasOwnProperty.call(localStorage, k)) continue;
        if (k.indexOf('afk_cs_') === 0 || k === 'ilc_gate_ok') continue;
        var v = localStorage.getItem(k);
        if (v) n += v.length;
      }
    } catch (e) {}
    return n > 4000;
  }
  // 雲端那包是不是「真的存檔」：空裝置誤傳的包只有 afk_cs_*/gate/toggle 幾個小 key。
  // （2026-08-18 實戰教訓：空包被當成「雲端已有存檔」跳確認框，按確定會把剛還原的舊資料洗掉）
  function packHasProgress(pack) {
    var n = 0;
    try {
      var ks = Object.keys(pack.keys);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (k.indexOf('afk_cs_') === 0 || k === 'ilc_gate_ok') continue;
        var v = pack.keys[k];
        if (v) n += v.length;
      }
    } catch (e) {}
    return n > 4000;
  }
  // 選檔畫面（2026-08-19 Ken 拍板：兩份進度不一樣時，給清楚的兩顆大按鈕自己選，
  //   資訊寫足 — 更新時間、角色數 — 取代看不懂的原生 confirm）
  function countChars(keys) {
    var n = 0;
    try { for (var k in keys) if (/^lineage_idle_save_/.test(k) && keys[k]) n++; } catch (e) {}
    return n;
  }
  function pickSave(j, onCloud, onLocal) {
    var cloudChars = 0;
    try { cloudChars = countChars(j.pack.keys); } catch (e) {}
    var localKeys = {};
    try { for (var k in localStorage) localKeys[k] = localStorage.getItem(k); } catch (e) {}
    var localChars = countChars(localKeys);
    var t = new Date(j.ts), pad = function (n) { return ('0' + n).slice(-2); };
    var ts = (t.getMonth() + 1) + '/' + t.getDate() + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
    var d = document.createElement('div');
    d.id = 'm-cs-pick';
    d.innerHTML = '<div class="csp-card"><div class="csp-title">📂 要載入哪一份進度？</div>'
      + '<button class="csp-b csp-cloud">☁️ 雲端的進度<span class="csp-sub">' + ts + ' 更新 · 角色 ' + cloudChars + ' 隻（各裝置同步的最新版）</span></button>'
      + '<button class="csp-b csp-local">💻 這台裝置的進度<span class="csp-sub">角色 ' + localChars + ' 隻 · 只存在這台（選這個會把它上傳成雲端版本）</span></button>'
      + '</div>';
    var st = document.createElement('style');
    st.textContent = pickStyleText();
    d.appendChild(st);
    (document.body || document.documentElement).appendChild(d);
    d.querySelector('.csp-cloud').addEventListener('click', function () { d.remove(); onCloud(); });
    d.querySelector('.csp-local').addEventListener('click', function () { d.remove(); onLocal(); });
  }

  // ── 首頁「☁️ 雲端進度」入口（2026-08-19 Ken 拍板：不靠自動跳，首頁隨時點、自己選要載哪份） ──
  function pickStyleText() {
    return '#m-cs-pick{position:fixed;inset:0;z-index:2147483000;background:rgba(2,6,23,.92);display:flex;align-items:center;justify-content:center;font-family:system-ui,"Segoe UI",sans-serif;}'
      + '#m-cs-pick .csp-card{position:relative;background:#0f172a;border:1px solid #334155;border-radius:14px;padding:22px;max-width:440px;width:92vw;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,.6);}'
      + '#m-cs-pick .csp-title{color:#7dd3fc;font-weight:700;font-size:17px;text-align:center;margin-bottom:4px;}'
      + '#m-cs-pick .csp-b{border-radius:10px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;border:1px solid #334155;color:#e2e8f0;text-align:left;line-height:1.5;font-family:inherit;}'
      + '#m-cs-pick .csp-save{background:#15803d;border-color:#22c55e;}'
      + '#m-cs-pick .csp-save:hover{background:#16a34a;}'
      + '#m-cs-pick .csp-hr{border-top:1px solid #1e293b;margin:2px 0;}'
      + '#m-cs-pick .csp-cloud{background:#0e7490;border-color:#0891b2;}'
      + '#m-cs-pick .csp-cloud:hover{background:#0891b2;}'
      + '#m-cs-pick .csp-local{background:#1e293b;}'
      + '#m-cs-pick .csp-local:hover{background:#273449;}'
      + '#m-cs-pick .csp-sub{display:block;font-size:12.5px;font-weight:400;color:#cbd5e1;margin-top:5px;}'
      + '#m-cs-pick .csp-x{position:absolute;top:8px;right:12px;background:none;border:0;color:#94a3b8;font-size:20px;cursor:pointer;padding:4px;}'
      + '#m-cs-pick .csp-note{font-size:12.5px;color:#94a3b8;text-align:center;}';
  }
  function fmtTs(ms) { var t = new Date(ms), p = function (n) { return ('0' + n).slice(-2); }; return (t.getMonth() + 1) + '/' + t.getDate() + ' ' + p(t.getHours()) + ':' + p(t.getMinutes()); }
  function localChars() {
    var lk = {}; try { for (var k in localStorage) lk[k] = localStorage.getItem(k); } catch (e) {}
    return countChars(lk);
  }
  function openPicker() {
    var key = getKey() || FIXED_KEY;
    fetch(apiUrl(key), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var hasCloud = j && j.pack && j.ts && validatePack(j.pack) && packHasProgress(j.pack);
        var synced = hasCloud && !(j.ts > getSeen());
        var old = document.getElementById('m-cs-pick'); if (old) old.remove();
        var d = document.createElement('div');
        d.id = 'm-cs-pick';
        d.innerHTML = '<div class="csp-card"><button class="csp-x" title="關閉">✕</button>'
          + '<div class="csp-title">📂 玩家' + getSlot() + ' 的進度</div>'
          // 💾 手動儲存（2026-08-26 Ken 要的「沒有手動儲存的功能」）：睡前／離開前想自己按一次的入口。
          //    平時是自動的，這顆只是讓人安心＋在自動推被節流擋住時能立刻補一次。
          + '<button class="csp-b csp-save">💾 立即儲存到雲端<span class="csp-sub">'
          + (synced ? '這台已經是雲端最新版了，再存一次也沒關係' : '把這台現在的進度馬上存上去') + '</span></button>'
          + '<div class="csp-hr"></div>'
          + (hasCloud
            ? '<button class="csp-b csp-cloud">☁️ 雲端的進度<span class="csp-sub">' + fmtTs(j.ts) + ' 更新 · 角色 ' + countChars(j.pack.keys) + ' 隻'
              + (synced ? ' · ✅ 這台就是這份' : '') + '</span></button>'
            : '<div class="csp-note">☁️ 雲端這個玩家槽還沒有存檔</div>')
          + '<button class="csp-b csp-local">💻 這台裝置的進度<span class="csp-sub">角色 ' + localChars() + ' 隻（點了會上傳成雲端版本）</span></button>'
          + '</div>';
        var st = document.createElement('style'); st.textContent = pickStyleText(); d.appendChild(st);
        (document.body || document.documentElement).appendChild(d);
        d.querySelector('.csp-x').addEventListener('click', function () { d.remove(); });
        d.querySelector('.csp-save').addEventListener('click', function () {
          if (!localHasProgress()) { window.alert('這台沒有實際進度可以儲存。'); return; }
          // 雲端有一份「這台沒看過的、更新的」→ 別台裝置寫過，硬存會蓋掉它 → 要問
          if (j && j.ts && j.ts > getSeen() && packHasProgress(j.pack || {})) {
            if (!window.confirm('⚠️ 雲端上有一份比這台新的進度（別台裝置存的）。\n\n按「確定」會用這台的蓋掉它（被蓋掉那份會留 30 天快照可救回）。')) return;
          }
          d.remove();
          setSeen(Math.max(Date.now(), (j && j.ts) || 0));   // 讓樂觀鎖放行
          savingNow(function (ok) {
            window.alert(ok ? '✅ 已儲存到雲端，可以安心關掉了。'
                            : '❌ 存不進去（沒網路或雲端額度滿了）。進度還在這台，等一下會自動再試。');
          });
        });
        var cb = d.querySelector('.csp-cloud');
        if (cb) cb.addEventListener('click', function () {
          d.remove();
          if (synced) { window.alert('這台目前就是雲端的最新進度 ✅ 直接玩就好。'); return; }
          setSeen(0); pull('manual');
        });
        d.querySelector('.csp-local').addEventListener('click', function () {
          if (!localHasProgress()) { window.alert('這台沒有實際進度可以上傳。'); return; }
          if (!window.confirm('⚠️ 確定要用「這台」的進度覆蓋雲端嗎？\n\n雲端目前那份會先存進快照（7 天內可救回）。')) return;
          d.remove();
          setSeen(Math.max(Date.now(), (j && j.ts) || 0));
          _onPushOk = function () { window.alert('✅ 已把這台的進度上傳成雲端版本，之後各裝置同步這份。'); };
          push('forcelink');
        });
      })
      .catch(function () { window.alert('❌ 連不上雲端（沒網路或被擋），稍後再試。'); });
  }
  function injectEntry() {
    if (!on()) return;
    var menu = document.getElementById('main-menu');
    if (!menu || document.getElementById('afk-cs-entry')) return;
    var b = document.createElement('button');
    b.id = 'afk-cs-entry';
    b.textContent = '☁️ 雲端進度';
    b.addEventListener('click', openPicker);
    menu.appendChild(b);
  }

  function autoLink() {
    // 玩家槽（1~4）在 gate.html 進門時就選好了（ilc_slot_ok），這裡直接沿用 getSlot()。
    try { localStorage.setItem(K_KEY, FIXED_KEY); } catch (e) { return; }
    if (!localHasProgress()) { setSeen(0); boot(); return; }
    fetch(apiUrl(FIXED_KEY), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.pack && j.ts && validatePack(j.pack) && packHasProgress(j.pack)) {
          pickSave(j, function () {   // ☁️ 用雲端
            setSeen(0); boot();
          }, function () {            // 💻 用這台
            if (!window.confirm('⚠️ 確定要用「這台」的進度覆蓋雲端嗎？\n\n雲端目前那份會先存進快照（7 天內可救回）。')) { autoLink(); return; }
            setSeen(Math.max(Date.now(), j.ts));
            _onPushOk = function () { window.alert('✅ 完成！已用這台的進度覆蓋雲端，之後各裝置自動同步。'); };
            push('forcelink'); boot();
          });
        } else {
          // 雲端沒有「真的存檔」（空的或空裝置誤傳的垃圾包）→ 不問，直接以這台為準蓋上去
          setSeen(Math.max(Date.now(), (j && j.ts) || 0));
          _onPushOk = function () { window.alert('✅ 完成！這台的進度已上傳雲端，之後各裝置自動同步。'); };
          push('firstrun');
          boot();
        }
      })
      .catch(function () { setSeen(Date.now()); boot(); /* 離線：先不動，之後照常同步 */ });
  }

  // ── 排程 ───────────────────────────────────────────────────
  var _booted = false;
  function boot() {
    if (!getKey() || _booted) return;   // 沒設定就完全閒置；設定後只掛一次排程
    _booted = true;
    refreshPlayers();           // 今天還沒問過就問一次「有幾個玩家在用」（額度門檻要除以人數）
    if (!_busy) pull('load');   // force-link 正在推的話不搶（推完自然接手）
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      var every = intervalNow();                        // ④ 額度越吃緊、間隔越長
      if (!isFinite(every)) return;                     //    見底 → 只剩 hidden/pagehide 會推
      if (Date.now() - _lastPushAt < every) return;
      if (!leadOk()) return;                            // ① 多分頁只讓其中一個負責定時推
      push('interval');
    }, 30 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') push('hidden');
      else pull('visible');
    });
    window.addEventListener('pagehide', function () { push('pagehide'); });
  }

  // ── 設定面板（掛進 afk-storage 的 ⚙ 選單，與 fullsave 同款 UI 模式） ──
  var _layer = null;
  function fmtT(ms) { var d = new Date(ms), p = function (n) { return ('0' + n).slice(-2); }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function setStatus(msg, bad) {
    var el = document.getElementById('m-cs-note');
    if (el) { el.className = bad ? 'cs-note cs-bad' : 'cs-note'; el.innerHTML = esc(msg).replace(/\n/g, '<br>'); }
    try { console.log('[AFK-cloudsync] ' + msg); } catch (e) {}
  }

  function slotRow() {
    var cur = getSlot(), h = '<div class="cs-slotrow"><span class="cs-slotlbl">👤 這台裝置是：</span>';
    for (var i = 1; i <= 4; i++) h += '<button class="cs-slot' + (String(i) === cur ? ' on' : '') + '" data-s="' + i + '">玩家' + i + '</button>';
    return h + '</div><div class="cs-desc">同一組金鑰底下有 4 個獨立玩家槽，一家人共用金鑰、各玩各的、可以同時玩。</div>';
  }

  function renderBody() {
    var key = getKey();
    var html = '<div class="cs-desc">把進度存到雲端。任何裝置打開遊戲、輸入<b>同一組同步金鑰</b>，就是同一份進度。'
      + '金鑰＝你的帳號＋密碼，<b>抄下來收好</b>，不要給別人。</div>'
      + slotRow();
    if (key) {
      html += '<div class="cs-keybox"><span class="cs-key" id="m-cs-key">' + esc(key) + '</span>'
        + '<button id="m-cs-copy" class="cs-b cs-mini">📋 複製</button></div>'
        + '<div class="cs-btns">'
        + '<button id="m-cs-push" class="cs-b cs-go">☁️ 立即上傳這台的進度</button>'
        + '<button id="m-cs-pull" class="cs-b cs-go">⬇️ 立即檢查雲端進度</button>'
        + '<button id="m-cs-off" class="cs-b cs-danger">✂️ 這台停用同步（清除金鑰）</button>'
        + '</div>';
    } else {
      html += '<div class="cs-btns">'
        + '<button id="m-cs-gen" class="cs-b cs-go">🆕 我是第一台：產生新金鑰</button>'
        + '<div class="cs-row"><input id="m-cs-in" class="cs-input" maxlength="64" autocomplete="off" '
        + 'autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="貼上既有金鑰">'
        + '<button id="m-cs-use" class="cs-b cs-danger cs-mini">連結</button></div>'
        + '<div class="cs-desc">「連結」會抓雲端進度<b>覆蓋這台</b>（雲端較新時）。這台若有想留的進度，先去「完整資料備份與還原」匯出一份。</div>'
        + '<button id="m-cs-force" class="cs-b cs-mini cs-ghost">🔄 這台的進度才是最新？連結並用這台蓋掉雲端</button>'
        + '</div>';
    }
    html += '<div id="m-cs-note" class="cs-note"></div>';
    return html;
  }

  function bindBody() {
    var b;
    // 玩家槽切換：換槽 = 這台改認另一份雲端存檔 → seen 歸零、立刻檢查該槽
    Array.prototype.forEach.call(document.querySelectorAll('.cs-slot'), function (el) {
      el.addEventListener('click', function () {
        var s = el.getAttribute('data-s');
        if (s === getSlot()) return;
        try { localStorage.setItem(K_SLOT, s); } catch (e) { setStatus('❌ 無法寫入槽位。', true); return; }
        setSeen(0);
        refreshBody();
        if (getKey()) { setStatus('已切到玩家' + s + '，檢查這個槽的雲端進度…（若雲端有進度會覆蓋這台）'); pull('manual'); }
        else setStatus('已選玩家' + s + '。');
      });
    });
    if ((b = document.getElementById('m-cs-copy'))) b.addEventListener('click', function () {
      var t = getKey();
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { setStatus('✅ 已複製金鑰。'); }, function () { setStatus('請長按選取金鑰自行複製。'); });
      else setStatus('請長按選取金鑰自行複製。');
    });
    if ((b = document.getElementById('m-cs-push'))) b.addEventListener('click', function () { setStatus('上傳中…'); push('manual'); });
    if ((b = document.getElementById('m-cs-pull'))) b.addEventListener('click', function () { setStatus('檢查中…'); pull('manual'); });
    if ((b = document.getElementById('m-cs-gen'))) b.addEventListener('click', function () {
      try { localStorage.setItem(K_KEY, genKey()); } catch (e) { setStatus('❌ 無法寫入金鑰。', true); return; }
      setSeen(0);
      refreshBody(); setStatus('✅ 金鑰已產生，開始自動同步。把金鑰抄到別台裝置就能接續。');
      push('firstrun'); boot();
    });
    if ((b = document.getElementById('m-cs-use'))) b.addEventListener('click', function () {
      var el = document.getElementById('m-cs-in');
      var k = normKey(String(el && el.value || ''));
      if (!KEY_RE.test(k)) { setStatus('❌ 金鑰格式不對（6 碼以上英數/-/_）。', true); return; }
      try { localStorage.setItem(K_KEY, k); } catch (e) { setStatus('❌ 無法寫入金鑰。', true); return; }
      setSeen(0);   // seen 歸零 → 雲端有東西就一定「比較新」→ 套用
      refreshBody(); setStatus('已連結，抓取雲端進度中…');
      pull('manual'); boot();
    });
    // 反向連結：這台的進度才是對的（例：剛把舊網站進度搬進這台、但雲端已有一份試玩檔）
    // → 設金鑰後不拉、直接把這台整包推上去蓋掉雲端。seen 設為現在，讓樂觀鎖放行。
    if ((b = document.getElementById('m-cs-force'))) b.addEventListener('click', function () {
      var el = document.getElementById('m-cs-in');
      var k = normKey(String(el && el.value || ''));
      if (!KEY_RE.test(k)) { setStatus('❌ 請先在上面欄位貼上金鑰（6 碼以上英數/-/_）。', true); return; }
      try { localStorage.setItem(K_KEY, k); } catch (e) { setStatus('❌ 無法寫入金鑰。', true); return; }
      refreshBody(); setStatus('已連結，正在用這台的進度覆蓋雲端…');
      // 先問雲端目前的 ts，seen 設成不小於它 → 不管兩台時鐘差多少，這台推的 ts 一定更新、樂觀鎖放行
      fetch(apiUrl(k), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { setSeen(Math.max(Date.now(), (j && j.ts || 0))); })
        .catch(function () { setSeen(Date.now()); })
        .then(function () { push('forcelink'); boot(); });
    });
    if ((b = document.getElementById('m-cs-off'))) b.addEventListener('click', function () {
      try { localStorage.removeItem(K_KEY); localStorage.removeItem(K_SEEN); } catch (e) {}
      refreshBody(); setStatus('這台已停用同步（雲端那份還在，重新輸入金鑰即可再連）。');
    });
  }
  function refreshBody() { var el = document.getElementById('m-cs-body'); if (el) { el.innerHTML = renderBody(); bindBody(); } }

  function openModal() {
    if (!on()) return;
    buildModal();
    if (_layer) return;
    var m = document.getElementById('m-cs-modal'); if (!m) return;
    refreshBody();
    m.classList.add('open');
    _layer = window.AFK_UI ? AFK_UI.openLayer(hideModal) : null;
  }
  function hideModal() { var m = document.getElementById('m-cs-modal'); if (m) m.classList.remove('open'); _layer = null; }
  function closeModal() { if (_layer && window.AFK_UI) AFK_UI.closeLayer(_layer); else hideModal(); }

  function buildModal() {
    injectCSS();
    if (document.getElementById('m-cs-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'm-cs-modal';
    modal.innerHTML = '<div id="m-cs-card">'
      + '<div id="m-cs-head"><span id="m-cs-title">☁️ 雲端存檔同步</span><button id="m-cs-close" title="關閉">✕</button></div>'
      + '<div id="m-cs-body"></div></div>';
    document.body.appendChild(modal);
    document.getElementById('m-cs-close').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  }

  function injectCSS() {
    if (document.getElementById('m-cs-style')) return;
    var s = document.createElement('style'); s.id = 'm-cs-style';
    s.textContent = [
      '#m-cs-modal{display:none;position:fixed;inset:0;top:var(--orig-bar-h,0px);z-index:1000;background:rgba(2,6,23,.82);align-items:flex-start;justify-content:center;padding:24px 12px;font-family:system-ui,"Segoe UI",sans-serif;}',
      '#m-cs-modal.open{display:flex;}',
      '#m-cs-card{background:#0f172a;border:1px solid #334155;border-radius:12px;max-width:520px;width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.6);}',
      '#m-cs-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #334155;}',
      '#m-cs-title{color:#7dd3fc;font-weight:700;}',
      '#m-cs-close{color:#94a3b8;background:none;border:0;font-size:18px;cursor:pointer;padding:2px 6px;}',
      '#m-cs-body{padding:14px;overflow:auto;color:#e2e8f0;font-size:13px;line-height:1.7;}',
      '.cs-desc{color:#94a3b8;font-size:12px;margin-bottom:12px;}',
      '.cs-desc b{color:#e2e8f0;}',
      '.cs-btns{display:flex;flex-direction:column;gap:8px;}',
      '.cs-b{border-radius:8px;padding:10px 12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid transparent;}',
      '.cs-go{background:#0e7490;border-color:#0891b2;color:#cffafe;}',
      '.cs-go:hover{background:#0891b2;}',
      '.cs-danger{background:#7f1d1d;border-color:#b91c1c;color:#fecaca;}',
      '.cs-danger:hover{background:#991b1b;}',
      '.cs-mini{padding:8px 12px;font-size:13px;flex:0 0 auto;}',
      '.cs-row{display:flex;gap:8px;}',
      '.cs-input{flex:1 1 auto;min-width:0;background:#020617;border:1px solid #475569;border-radius:8px;color:#e2e8f0;padding:10px 12px;font-size:14px;font-family:ui-monospace,Consolas,monospace;}',
      '.cs-input:focus{outline:none;border-color:#0891b2;}',
      '.cs-keybox{display:flex;align-items:center;gap:10px;background:#020617;border:1px solid #475569;border-radius:8px;padding:10px;margin-bottom:10px;}',
      '.cs-key{flex:1 1 auto;font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all;color:#fcd34d;user-select:all;}',
      '.cs-note{margin-top:10px;font-size:12.5px;color:#a7f3d0;min-height:1em;}',
      '.cs-note.cs-bad{color:#fca5a5;}',
      '.cs-slotrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;}',
      '.cs-slotlbl{color:#94a3b8;font-size:12.5px;}',
      '.cs-slot{border-radius:8px;padding:7px 10px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;background:#1e293b;border:1px solid #334155;color:#94a3b8;}',
      '.cs-slot:hover{background:#273449;color:#e2e8f0;}',
      '.cs-slot.on{background:#0e7490;border-color:#0891b2;color:#cffafe;}',
      '.cs-ghost{background:transparent;border:1px dashed #475569;color:#94a3b8;font-weight:400;}',
      '.cs-ghost:hover{border-color:#0891b2;color:#7dd3fc;}',
      // 🚪 開機選人閘門（全螢幕擋住，沒選不給玩）
      '#cs-gate{position:fixed;inset:0;z-index:100000;background:rgba(2,6,23,.96);display:flex;align-items:center;justify-content:center;padding:20px 14px;font-family:system-ui,"Segoe UI",sans-serif;}',
      '#cs-gate-card{background:#0f172a;border:1px solid #334155;border-radius:14px;max-width:460px;width:100%;padding:22px 18px;box-shadow:0 12px 40px rgba(0,0,0,.7);}',
      '#cs-gate-title{color:#7dd3fc;font-size:20px;font-weight:800;text-align:center;margin-bottom:4px;}',
      '#cs-gate-sub{color:#94a3b8;font-size:12.5px;text-align:center;margin-bottom:16px;}',
      '.cs-gs{display:flex;flex-direction:column;align-items:flex-start;gap:3px;width:100%;margin-bottom:9px;padding:12px 14px;border-radius:10px;cursor:pointer;text-align:left;font-family:inherit;background:#1e293b;border:1px solid #334155;transition:background .12s,border-color .12s;}',
      '.cs-gs:hover{background:#273449;border-color:#0891b2;}',
      '.cs-gs-n{color:#e2e8f0;font-size:15px;font-weight:700;}',
      '.cs-gs-d{color:#94a3b8;font-size:12px;}',
      '.cs-gs-empty{color:#64748b;font-style:italic;}',
      // 常駐身分標示
      '#cs-badge{position:fixed;left:6px;bottom:6px;z-index:9998;background:rgba(15,23,42,.85);border:1px solid #334155;color:#7dd3fc;font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;cursor:pointer;font-family:system-ui,sans-serif;pointer-events:auto;}',
      '#cs-badge:hover{background:#1e293b;color:#cffafe;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── 🚪 開機選人閘門（2026-09-05 Ken 拍板：「進去就點選你是玩一還是玩二，這樣紀錄永遠不會錯」）──
  //    在此之前是「沒選過就預設玩家1」，導致新裝置/清資料的人一開就踩進玩家1（Ken）的存檔並蓋掉。
  //    現在：沒選過 → 擋住整個同步流程，強制選；每個新分頁都要確認一次（sessionStorage）。
  //    按鈕上直接標出各槽是誰（角色數／等級／最後遊玩），選錯的機會降到最低。
  var CLS_CN = { royal:'王族', knight:'騎士', warrior:'戰士', elf:'妖精',
                 mage:'法師', dark:'黑暗妖精', dragon:'龍騎', illusion:'幻術' };
  function fmtAgo(ts) {
    if (!ts) return '';
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 3600) return Math.floor(s / 60) + ' 分鐘前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小時前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function slotGate(done) {
    injectCSS();
    var box = document.createElement('div');
    box.id = 'cs-gate';
    var h = '<div id="cs-gate-card"><div id="cs-gate-title">你是玩家幾？</div>'
          + '<div id="cs-gate-sub">選錯會讀到別人的存檔，請確認清楚。</div>';
    for (var i = 1; i <= 4; i++) {
      h += '<button class="cs-gs" data-s="' + i + '">'
         + '<span class="cs-gs-n">' + (i === 1 ? '👑' : '🎮') + ' 玩家' + i + '</span>'
         + '<span class="cs-gs-d" id="cs-gs-d' + i + '">讀取中…</span></button>';
    }
    box.innerHTML = h + '</div>';
    document.body.appendChild(box);

    // 摘要：一次要求拿四個槽（伺服器端已縮成幾百 bytes）。失敗就只是沒有副標，不擋選人。
    try {
      fetch(ENDPOINT + '?key=' + encodeURIComponent(FIXED_KEY) + '&slot=1&summary=1', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || !j.slots) return;
          j.slots.forEach(function (s) {
            var el = document.getElementById('cs-gs-d' + s.slot);
            if (!el) return;
            if (s.empty || !s.chars) { el.textContent = '（空的，還沒有存檔）'; el.className = 'cs-gs-d cs-gs-empty'; return; }
            var t = (s.top ? (CLS_CN[s.top.cls] || s.top.cls) + ' Lv' + s.top.lv + ' · ' : '') + s.chars + ' 個角色';
            var ago = fmtAgo(s.ts);
            el.textContent = t + (ago ? '　最後遊玩 ' + ago : '');
          });
        })
        .catch(function () {});
    } catch (e) {}

    Array.prototype.forEach.call(box.querySelectorAll('.cs-gs'), function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-s');
        try {
          if (localStorage.getItem(K_SLOT) !== s) setSeen(0);   // 換人 = 改認另一份雲端存檔，seen 歸零重拉
          localStorage.setItem(K_SLOT, s);
          localStorage.setItem('ilc_slot_ok', '1');             // 與 gate.html 同一個旗標
          sessionStorage.setItem(S_SLOTOK, '1');
        } catch (e) {}
        box.remove();
        done();
      });
    });
  }
  // 常駐標示現在是誰，免得玩到一半才發現選錯。純裝飾 → 整段包起來，絕不能因為它失敗就擋住同步。
  function slotBadge() {
    try {
      var s = getSlot(); if (!s) return;
      var el = document.getElementById('cs-badge');
      if (!el) { el = document.createElement('div'); el.id = 'cs-badge'; document.body.appendChild(el); }
      el.textContent = '玩家' + s;
      el.title = '目前是玩家' + s + '（點一下可換人）';
      el.onclick = function () { try { sessionStorage.removeItem(S_SLOTOK); } catch (e) {} location.reload(); };
    } catch (e) {}
  }

  function init() {
    window.AFK_SETTINGS = window.AFK_SETTINGS || { _items: [], add: function (it) { this._items.push(it); } };
    window.AFK_SETTINGS.add({ label: '☁️ 雲端存檔同步', onClick: openModal });
    // 首頁入口：#main-menu 是遊戲 js 之後才長出來的（且選角來回會重建）→ 輪詢補掛
    injectEntry();
    setInterval(injectEntry, 2000);
    var go = function () {
      slotBadge();
      // 金鑰已定案為固定家庭金鑰：任何裝置存著別的（舊隨機金鑰＝按過「產生新金鑰」的孤兒）
      // → 一律歸隊：走 autoLink 蓋成 FIXED_KEY + 重新對進度（2026-08-19 公司機就是這樣跑丟的）
      if (getKey() === FIXED_KEY) boot(); else autoLink();
      try { console.log('[AFK-cloudsync] hooks OK — 玩家' + getSlot()); } catch (e) {}
    };
    if (slotChosen()) { go(); return; }
    // 畫不出選人畫面時的降級：已經選過槽位就照舊用（安全，只是少了本次確認）；
    // 完全沒選過才真的擋住 —— 那時寧可不同步，也不能再預設成玩家1 把別人存檔蓋掉。
    try {
      slotGate(go);
    } catch (e) {
      try { console.warn('[AFK-cloudsync] 選人畫面失敗：' + (e && e.message)); } catch (e2) {}
      if (/^[1-4]$/.test(getSlot())) go();
      else try { console.error('[AFK-cloudsync] 尚未選擇玩家，暫停同步以免蓋到別人的存檔。'); } catch (e2) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
