/* ============================================================================
 * afk-textmode.js — 掛機顯示模式（完整 / 只留日誌 / 文字版）
 *
 * 解決什麼：掛機時畫面卡（Ken 2026-08-26 回報）。效能報告 docs/perf-battery.md 的結論是
 *   前景成本大宗在「畫圖」——每張 <img> 常駐濾鏡(C1)、8fps sprite 換圖解碼(B8)、
 *   怪物列每 tick 重建(B5)、粒子(C8)。掛機時這些畫面其實沒人在看。
 *
 * 三段模式（存本機、per 裝置，不進存檔）：
 *   full  完整版   什麼都不做，跟沒裝這支外掛一模一樣  ← 預設
 *   log   只留日誌 收起整個 #battle-view，只剩戰鬥日誌
 *   text  文字版   藏掉 #mob-list 的圖，改成一行「怪名 血量%」
 *
 * 🚨 為什麼預設一定是 full：Ken 明講「原本的不要移除，我哥會用他電腦好」。
 *   預設不作為＝別人那台不會有任何變化。這條有測試守著（sim-textmode.mjs 第 1 組）。
 *
 * 做法上刻意保守：**不攔截、不覆寫任何核心函式**，只做兩件事——
 *   ① 注入一段 CSS 把該藏的藏起來  ② 自己建一個文字列節點、自己用低頻計時器更新。
 *   關掉外掛開關 → 完全回原版。核心照常跑，戰鬥數值完全不受影響。
 *
 * ⚠️ 省的是「畫」不是「算」：核心仍會每 tick 組怪物列的 HTML 字串(B5)，
 *   省下來的是排版、繪製、濾鏡與圖片解碼。實際省多少一律以實測為準，不憑直覺
 *   （前車之鑑：作者的「降低畫面更新頻率」直覺最該有用，實測只省 4%，最後整個移除）。
 *
 * 掛接：index.html 的 </body> 前加 <script src="afk-textmode.js"></script>
 * ========================================================================== */
(function () {
  'use strict';
  if (window.AFK_TOGGLES && !window.AFK_TOGGLES.enabled('textmode')) return;   // 🎚️ 外掛開關

  if (window.AFK_TOGGLES) window.AFK_TOGGLES.register({
    id: 'textmode', name: '掛機顯示模式', group: '系統與其他', def: true,
    desc: '掛機時可以把戰鬥畫面收起來或改成文字，減少畫面卡頓（預設不改變任何東西）'
  });

  var K_MODE   = 'afk_tm_mode';        // 'full' | 'log' | 'text'
  var STYLE_ID = 'afk-tm-style';
  var LINE_ID  = 'afk-tm-line';
  var TICK_MS  = 500;                  // 文字列更新頻率：2Hz 就夠讀，核心是 10Hz

  function mode() {
    try { var v = localStorage.getItem(K_MODE); return (v === 'log' || v === 'text') ? v : 'full'; }
    catch (e) { return 'full'; }       // 讀不到就回完整版：壞設定不該把畫面弄壞
  }

  // ── 該藏什麼 ───────────────────────────────────────────────
  //   log  ：整個戰鬥區（含狀態圖示列）收起來，最省
  //   text ：只藏 #mob-list 的圖，#battle-view 要留著給文字列掛
  function cssFor(m) {
    if (m === 'log')  return '#battle-view{display:none!important;}';
    // 🔬 實測導向，改了兩次才對（2026-08-26）：
    //    v1 只藏 #mob-list              → 省 9%
    //    v2 再加藏 #status-icon-bar      → 省 17%
    //    v3 直接整塊藏 #battle-view      → 追平「只留日誌」
    //    關鍵不是藏了哪些子元素，而是**整個容器要退出版面**；留著它、只藏裡面的東西，
    //    版面與繪製的成本大半還在。文字列因此改掛在 #battle-view 外面（同層前面）。
    if (m === 'text') return '#battle-view{display:none!important;}'
      + '#' + LINE_ID + '{font-family:ui-monospace,Consolas,monospace;font-size:14px;line-height:1.9;'
      + 'color:#cbd5e1;background:#0b1222;border:1px solid #1e293b;border-radius:8px;'
      + 'padding:10px 12px;margin:2px 0;word-break:break-all;}'
      + '#' + LINE_ID + ' .tm-t{color:#fcd34d;font-weight:700;}'
      + '#' + LINE_ID + ' .tm-none{color:#64748b;}';
    return '';
  }

  function applyCss(m) {
    var css = cssFor(m);
    var el = document.getElementById(STYLE_ID);
    if (!css) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
  }

  // ── 文字列 ─────────────────────────────────────────────────
  function pct(m) {
    var max = m.hp || 1, cur = m.curHp;
    if (typeof cur !== 'number') cur = max;
    return Math.max(0, Math.min(100, Math.round((cur / max) * 100)));
  }
  // 純函式，好測：吃 mapState 吐字串
  function buildLine(ms) {
    var out = [], mobs = (ms && ms.mobs) || [];
    for (var i = 0; i < mobs.length; i++) {
      var m = mobs[i];
      if (!m || !m.n) continue;                       // 空格子不顯示
      var tag = (i === ms.targetIdx ? '▶ ' : '') + (m.boss ? '👑 ' : '');
      out.push(tag + m.n + ' ' + pct(m) + '%');
    }
    return out.length ? out.join('　｜　') : '（等待怪物出現…）';
  }

  // 文字列要掛在 #battle-view 的**外面**（同層、排在它前面）：
  //   放裡面的話，#battle-view 就不能整塊藏起來，而實測顯示「整塊退出版面」才是省的關鍵。
  function lineNode() {
    var el = document.getElementById(LINE_ID);
    if (el) return el;
    var bv = document.getElementById('battle-view');
    if (!bv || !bv.parentNode) return null;
    el = document.createElement('div');
    el.id = LINE_ID;
    bv.parentNode.insertBefore(el, bv);
    return el;
  }
  function dropLine() { var el = document.getElementById(LINE_ID); if (el) el.remove(); }

  // 🚨 核心的 mapState / state 是用 let 宣告的頂層變數 —— 那種變數住在「全域語彙環境」，
  //    **不會**變成 window 的屬性（只有 var 與 function 宣告會）。所以 window.mapState 恆為 undefined。
  //    2026-08-26 就是這樣：單元測試（用假的 window 物件）全綠，真瀏覽器裡文字列永遠是空的。
  //    → 先用裸識別字（沿作用域鏈找得到全域 let），找不到才退回 window。
  function gMapState() {
    try { if (typeof mapState !== 'undefined') return mapState; } catch (e) {}
    return window.mapState;
  }
  function gState() {
    try { if (typeof state !== 'undefined') return state; } catch (e) {}
    return window.state;
  }

  function refresh() {
    if (mode() !== 'text') return;
    // 🔋 分頁在背景就不更新：效能報告 A4 說 65 支外掛「沒有任何一支」在隱藏時停下自己的
    //    setInterval——這支不要再犯。畫面沒人看的時候更新它純粹是燒電。
    if (document.visibilityState === 'hidden') return;
    // 離線補跑期間核心自己也不刷畫面（js/03 的 state.ff），跟它一致
    try { var _st = gState(); if (_st && _st.ff) return; } catch (e) {}
    var el = lineNode();
    if (!el) return;
    var txt;
    try { txt = buildLine(gMapState()); } catch (e) { return; }   // 讀不到就維持上一次，不要把畫面清空
    if (el.textContent !== txt) el.textContent = txt;
  }

  function apply() {
    var m = mode();
    applyCss(m);
    if (m !== 'text') dropLine(); else refresh();
  }

  function setMode(v) {
    if (v !== 'log' && v !== 'text') v = 'full';
    try { localStorage.setItem(K_MODE, v); } catch (e) {}
    apply();
  }

  // ── 設定面板 ───────────────────────────────────────────────
  var OPTS = [
    { v: 'full', n: '🖼️ 完整版（預設）', d: '原本的畫面，什麼都不改' },
    { v: 'log',  n: '📜 只留日誌',       d: '把整個戰鬥區收起來，只看戰鬥日誌的文字 — 最省' },
    { v: 'text', n: '🔤 文字版',         d: '戰鬥區改成一行文字（怪名＋血量%），沒有圖也沒有動畫' }
  ];
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function openPanel() {
    if (document.getElementById('afk-tm-overlay')) return;
    var ov = document.createElement('div');
    ov.id = 'afk-tm-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.66);display:flex;align-items:flex-start;justify-content:center;padding:calc(var(--orig-bar-h,0px) + 14px) 12px 12px;';
    if (window.AFK_TOGGLES && window.AFK_TOGGLES.applyBannerPad) window.AFK_TOGGLES.applyBannerPad(ov);
    var cur = mode();
    var rows = OPTS.map(function (o) {
      return '<label style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid ' + (o.v === cur ? '#22c55e' : '#1e293b') + ';border-radius:10px;margin-bottom:8px;cursor:pointer;background:#0b1222;">'
        + '<input type="radio" name="afk-tm" data-tm="' + o.v + '" ' + (o.v === cur ? 'checked' : '') + ' style="width:18px;height:18px;flex:none;accent-color:#22c55e;">'
        + '<span><span style="font-weight:600;">' + esc(o.n) + '</span>'
        + '<span style="display:block;font-size:11px;color:#94a3b8;margin-top:2px;">' + esc(o.d) + '</span></span></label>';
    }).join('');
    ov.innerHTML = '<div style="background:#0f172a;border:1px solid #334155;border-radius:14px;padding:18px;max-width:460px;width:94vw;color:#e2e8f0;font-family:system-ui,sans-serif;">'
      + '<div style="color:#7dd3fc;font-weight:700;font-size:16px;margin-bottom:4px;">📃 掛機顯示模式</div>'
      + '<div style="font-size:12px;color:#94a3b8;margin-bottom:12px;">只影響這台裝置的畫面，戰鬥數值與掉落完全不受影響。想更省電再搭配「🔋 省電模式」。</div>'
      + rows
      + '<button id="afk-tm-close" style="width:100%;margin-top:6px;padding:10px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-weight:700;cursor:pointer;font-family:inherit;">關閉</button>'
      + '</div>';
    (document.body || document.documentElement).appendChild(ov);
    ov.addEventListener('click', function (e) {
      var t = e.target;
      if (t === ov || (t && t.id === 'afk-tm-close')) { ov.remove(); return; }
      var v = t && t.getAttribute && t.getAttribute('data-tm');
      if (v) setMode(v);
    });
  }

  window.AFK_SETTINGS = window.AFK_SETTINGS || { _items: [], add: function (it) { this._items.push(it); } };
  window.AFK_SETTINGS.add({ label: '📃 掛機顯示模式', onClick: openPanel });

  apply();
  setInterval(refresh, TICK_MS);

  // 測試與除錯用的把手（其他外掛也有這種 window.__afk 慣例）
  window.AFK_TEXTMODE = { mode: mode, setMode: setMode, buildLine: buildLine, refresh: refresh };
})();
