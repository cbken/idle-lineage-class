/* ============================================================================
 * afk-nobanner.js — 隱藏「非官方轉載版本」橫幅（預設關，開啟要先確認過才生效）
 *
 * 橫幅是上游 js/00 的 _origEnforce 在非官方網域蓋的一條 fixed 列（id `_orig_pbar`）,
 *   而 js/03 gameLoop **每 100ms 檢查一次、被移掉就重蓋** —— 所以只能「藏」不能「刪」:
 *   注一條 `#_orig_pbar{display:none}` 就好,元素還在 → _origEnforce 的
 *   `getElementById('_orig_pbar')` 仍為真 → 它自己就不會再蓋一次,不必跟 gameLoop 打架。
 *   藏起來之後 afk-banner 量到高度 0 → --orig-bar-h 歸零、body.afk-bar 拿掉,
 *   讓位規則整組自動失效,版面把那條空間收回去(所以要 remeasure 一次,不必等它輪詢)。
 *
 * 🚨 隱藏前一定要玩家確認過:橫幅講的是「這不是原版」,藏掉等於把那句話從畫面上拿走,
 *   所以那句話要在確認視窗裡至少讓他讀過一次,並告訴他外掛的問題該找誰。
 *   實作成**兩把鎖**:開關(afk_toggle_nobanner)＋同意紀錄(afk_nobanner_ack),
 *   `enabled() && acked()` 兩者都成立才隱藏。分開存的理由是「開關」玩家可以從面板、
 *   「全部恢復預設」等好幾條路徑改到(其中「全部恢復預設」是直接刪 localStorage、
 *   不經過 set()、我們攔不到),而同意紀錄只有本檔寫 → 不管開關怎麼被改,
 *   都不可能在沒問過的情況下把橫幅藏起來。
 *
 * 開關流程:面板勾起來 → 包住的 AFK_TOGGLES.set 攔到 → 跳確認視窗 →
 *   確定＝記下同意並當場隱藏(不必重新整理);取消＝把開關撥回去、面板上的勾也取消掉。
 *   撥回關閉時一併清掉同意紀錄 → 下次再開會再問一次。
 *
 * 掛接:在 index.html 的 </body> 前 <script src="afk-nobanner.js">(排在 afk-banner 之後)。
 * ========================================================================== */
(function () {
  'use strict';

  var ID = 'nobanner';
  var ACK_KEY = 'afk_nobanner_ack';
  var STYLE_ID = 'afk-nobanner-style';
  var HIDE_CLASS = 'afk-nobanner-on';   // 掛在 <html> 上＝「現在藏著」
  // 確認視窗要蓋在「外掛開關面板」上面:那個 overlay 是 z-index 100000,而共用確認窗只有 10001
  //   → 不墊高的話玩家在面板裡勾選,視窗會開在面板底下、完全看不到(等於按了沒反應)。
  //   只在本檔要顯示時掛這個 class,不去動 AFK_UI 給別人用的預設值。
  var TOP_CLASS = 'afk-nobanner-top';

  // ⚠️ 預設「關」→ 讀不到 AFK_TOGGLES 時要當**關閉**(同 afk-anyclass;那條「讀不到就當開啟」
  //    是給預設開的外掛用的,套在這裡等於沒有開關就自己把橫幅藏了)。
  function on() { return !!(window.AFK_TOGGLES && AFK_TOGGLES.enabled(ID)); }
  function acked() { try { return localStorage.getItem(ACK_KEY) === '1'; } catch (e) { return false; } }
  function setAck(v) { try { v ? localStorage.setItem(ACK_KEY, '1') : localStorage.removeItem(ACK_KEY); } catch (e) {} }

  // ⚠️ 這份 style **永遠是啟用的**,開關靠 <html> 上那個 class 切 —— 不可以改成整份
  //    `disabled = true/false`:墊高確認視窗那條規則會跟著一起被停掉,而它正好要在
  //    「還沒隱藏」的時候生效(玩家在面板裡勾選的那一刻),結果視窗開在面板底下、按不到。
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = 'html.' + HIDE_CLASS + ' #_orig_pbar{display:none !important;}\n'
      + '#afk-confirm-modal.' + TOP_CLASS + '{z-index:100002 !important;}\n';
    (document.head || document.documentElement).appendChild(st);
  }

  // 兩把鎖都開才藏;藏/現之後都要讓 afk-banner 重量一次,讓位規則才會當場跟著變
  function apply() {
    ensureStyle();
    var root = document.documentElement, hide = on() && acked();
    if (root.classList.contains(HIDE_CLASS) === hide) return;
    root.classList.toggle(HIDE_CLASS, hide);
    if (window.AFK_BANNER && typeof AFK_BANNER.remeasure === 'function') AFK_BANNER.remeasure();
  }

  // 取消時把面板上那個勾撥回去(它不會自己跟著 set() 變)。找不到就算了——開關本身已經是關的。
  function uncheckPanel() {
    try {
      var cb = document.querySelector('#afk-toggles-overlay input[data-tgid="' + ID + '"]');
      if (cb) cb.checked = false;
    } catch (e) {}
  }

  var _asking = false;
  function ask() {
    if (_asking) return;
    if (!window.AFK_UI || typeof AFK_UI.confirm !== 'function') {   // 共用確認窗不在 → 不隱藏(絕不「問不到就當同意」)
      console.warn('[AFK-nobanner] 找不到 AFK_UI.confirm，橫幅維持顯示。');
      if (window.AFK_TOGGLES) AFK_TOGGLES.set(ID, false);
      return;
    }
    _asking = true;
    var modal = null;
    var done = function (ok) {
      _asking = false;
      if (modal) modal.classList.remove(TOP_CLASS);
      setAck(ok);
      if (!ok && window.AFK_TOGGLES) { AFK_TOGGLES.set(ID, false); uncheckPanel(); }
      apply();
    };
    AFK_UI.confirm({
      title: '確定要隱藏「非官方版本」橫幅？',
      // ⚠️ 官方網址寫死在這裡是刻意的:橫幅唯一的實質內容就是那個網址,藏掉之前至少讓玩家看過一次。
      //    **別改成「連結在首頁」** —— 首頁那條(afk-syncinfo)掛在「首頁外掛入口/資訊」那顆開關底下,
      //    玩家一關就沒了,而這裡正是要把橫幅拿掉的地方,不能指望另一支可停用的外掛替我們講。
      //    (AFK_UI.confirm 會把訊息 escape,所以是純文字、不可點。)
      // 「已有一段時間沒有更新」刻意不寫日期:寫死會過期(而且沒有任何東西會提醒我們回來改),
      //   要精確日期首頁本來就有「最後同步原版」那一列。(2026-08-14 查證:上游最後一次提交 2026-07-26。)
      message: '這裡是加掛版，不是原作者的官方版：\nshines871.github.io/idle-lineage-class\n\n'
        + '原作者的版本已有一段時間沒有更新，隱藏橫幅比較不會影響到他，所以開放這個選項。\n\n'
        + '外掛的問題請到巴哈討論串 301 樓回報，不要去問原作者。',
      align: 'left',
      requireText: '了解',   // 要手動打進去才解鎖「確定」——上面那幾句是重點,不能讓人一路點過去
      okText: '我知道了',
      cancelText: '取消',
      onOk: function () { done(true); },
      onCancel: function () { done(false); },
      onDismiss: function () { done(false); }   // 點背景/ESC/返回鍵＝沒同意
    });
    ensureStyle();
    modal = document.getElementById('afk-confirm-modal');
    if (modal) modal.classList.add(TOP_CLASS);
  }

  function init() {
    ensureStyle();
    // 面板勾起來的當下就問(面板本身不會重新整理,不攔的話玩家要按了「重新整理」才會有反應)
    if (window.AFK_TOGGLES && typeof AFK_TOGGLES.set === 'function' && !AFK_TOGGLES.set.__afkNoBanner) {
      var origSet = AFK_TOGGLES.set;
      AFK_TOGGLES.set = function (id, val) {
        var r = origSet.apply(this, arguments);
        if (id === ID) { if (val) ask(); else { setAck(false); apply(); } }
        return r;
      };
      AFK_TOGGLES.set.__afkNoBanner = true;
    }
    // 2026-08-19 Ken(站主)拍板 always-on：本站已改 gate.html 私人閘門、只有家人進得來，
    //   「這不是原版」的告知義務由站主對家人承擔 → 預設開 + 免逐台確認（原確認流程保留給「關掉再手動打開」的路徑）。
    if (on() && !acked()) setAck(true);
    apply();
    console.log('[AFK-nobanner] hooks OK — 橫幅隱藏（本站預設開啟·站主拍板）。');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
