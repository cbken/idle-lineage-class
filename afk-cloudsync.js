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
 *   - 推（本地 → 雲端）：遊玩中每 120 秒 + 分頁躲起來(visibilitychange hidden)/pagehide 時。
 *     PUT 帶 baseTs =「我最後看過的雲端 ts」(afk_cs_seen)；Worker 發現雲端 ts > baseTs
 *     會回 409（別台裝置寫過我沒看到的版本）→ 這時不准蓋，改走拉的流程。
 *   - 拉（雲端 → 本地）：開頁 + 回到分頁(visibilitychange visible) 時 GET。
 *     雲端 ts > afk_cs_seen 才套用：走 fullsave 同款還原（clear + _lzSetStoredRaw 原樣寫回）
 *     → 補寫回金鑰/seen → reload。ts 沒比較新就什麼都不做。
 *   - 套用後 seen = 雲端 ts、推送後 seen = 自己的 ts → 同一台裝置 reload 不會重套、
 *     兩台輪流玩時「較新的那份」永遠贏。
 *
 * 為什麼推是 120 秒不是更密：CF KV 免費額度寫入 1000 次/天。120 秒 + 只在分頁可見時推，
 *   一天掛 10 小時 ≈ 300 寫，兩台同時掛也在額度內。放置遊戲 5 秒自動存檔，斷線最多丟 2 分鐘。
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

  var PUSH_EVERY_MS = 120 * 1000;
  var K_KEY  = 'afk_cs_key';    // 同步金鑰
  var K_SEEN = 'afk_cs_seen';   // 最後看過/寫過的雲端 ts（毫秒字串）
  var K_SLOT = 'afk_cs_slot';   // 這台裝置的玩家槽 1~4（預設 1）
  var KEY_RE = /^[A-Za-z0-9_-]{24,64}$/;
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
  function getSlot() { var s = localStorage.getItem(K_SLOT); return /^[1-4]$/.test(s) ? s : '1'; }
  function apiUrl(key) { return ENDPOINT + '?key=' + encodeURIComponent(key) + '&slot=' + getSlot(); }

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
    var names = Object.keys(pack.keys);
    try { localStorage.clear(); } catch (e) { _applying = false; return false; }
    for (var i = 0; i < names.length; i++) {
      if (!rawWrite(names[i], pack.keys[names[i]])) { _applying = false; return false; }
    }
    // 金鑰/槽位/seen 必須是「這台裝置的視角」：金鑰槽位照舊、seen = 剛套用的雲端 ts
    try { localStorage.setItem(K_KEY, myKey); localStorage.setItem(K_SLOT, mySlot); } catch (e) {}
    setSeen(cloudTs);
    return true;
  }

  // ── 推 / 拉 ────────────────────────────────────────────────
  var _busy = false, _lastPushAt = 0, _pendingPush = false;

  // 收尾：解除 busy；若期間有被擋掉的推（最常見：關頁前 hidden 推撞上進行中的拉）補推一次
  function release() {
    _busy = false;
    if (_pendingPush && !_applying) { _pendingPush = false; push('retry'); }
  }

  function push(reason) {
    if (!on() || _applying) return;
    if (_busy) { _pendingPush = true; return; }   // 別默默丟掉：等在途請求結束後補推
    var key = getKey(); if (!key) return;
    _busy = true;
    var ts = Math.max(Date.now(), getSeen() + 1);   // 裝置時鐘落後也保持單調遞增
    var body;
    try { body = JSON.stringify({ ts: ts, baseTs: getSeen(), pack: buildPack() }); }
    catch (e) { _busy = false; return; }
    fetch(apiUrl(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body
    }).then(function (r) {
      if (r.status === 409) {
        // 別台裝置寫過更新的 → 不准蓋，改拉（pending 推作廢：馬上要套更新的雲端版了）
        _busy = false; _pendingPush = false;
        pull('conflict');
        return;
      }
      if (r.ok) { setSeen(ts); _lastPushAt = Date.now(); setStatus('☁️ 已上傳 ' + fmtT(_lastPushAt)); }
      release();
    }).catch(function () { _busy = false; _pendingPush = false; /* 離線就算了，下一輪再推 */ });
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

  // ── 排程 ───────────────────────────────────────────────────
  var _booted = false;
  function boot() {
    if (!getKey() || _booted) return;   // 沒設定就完全閒置；設定後只掛一次排程
    _booted = true;
    if (!_busy) pull('load');   // force-link 正在推的話不搶（推完自然接手）
    setInterval(function () {
      if (document.visibilityState === 'visible' && Date.now() - _lastPushAt >= PUSH_EVERY_MS) push('interval');
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
      var k = String(el && el.value || '').trim();
      if (!KEY_RE.test(k)) { setStatus('❌ 金鑰格式不對（24 碼以上英數/-/_）。', true); return; }
      try { localStorage.setItem(K_KEY, k); } catch (e) { setStatus('❌ 無法寫入金鑰。', true); return; }
      setSeen(0);   // seen 歸零 → 雲端有東西就一定「比較新」→ 套用
      refreshBody(); setStatus('已連結，抓取雲端進度中…');
      pull('manual'); boot();
    });
    // 反向連結：這台的進度才是對的（例：剛把舊網站進度搬進這台、但雲端已有一份試玩檔）
    // → 設金鑰後不拉、直接把這台整包推上去蓋掉雲端。seen 設為現在，讓樂觀鎖放行。
    if ((b = document.getElementById('m-cs-force'))) b.addEventListener('click', function () {
      var el = document.getElementById('m-cs-in');
      var k = String(el && el.value || '').trim();
      if (!KEY_RE.test(k)) { setStatus('❌ 請先在上面欄位貼上金鑰（24 碼以上英數/-/_）。', true); return; }
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
      '.cs-ghost:hover{border-color:#0891b2;color:#7dd3fc;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }

  function init() {
    window.AFK_SETTINGS = window.AFK_SETTINGS || { _items: [], add: function (it) { this._items.push(it); } };
    window.AFK_SETTINGS.add({ label: '☁️ 雲端存檔同步', onClick: openModal });
    boot();
    try { console.log('[AFK-cloudsync] hooks OK' + (getKey() ? ' — 已設定金鑰，自動同步中。' : ' — 尚未設定金鑰（⚙ 選單可設定）。')); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
