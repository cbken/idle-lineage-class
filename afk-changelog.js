/* ============================================================================
 * afk-changelog.js — 版本更新內容（登入頁「📜 更新內容」＋更新後第一次開啟自動跳出）
 *
 * 站主 2026-09-29：「開始發展我們的版本控制，並且在頁面上面寫上每一版更新的內容」
 * 原作者已停更、不再同步上游 → 從 v3.9.0 起版本號由我們自己管（js/00 GAME_VERSION）。
 *
 * 🚨 發版規則（docs/versioning.md）：每次上線都要
 *   ① js/00-data.js 的 GAME_VERSION ＋ index.html 的 #login-version 後備文字 一起 bump
 *      （修正 → 末段 +1；新功能 → 中段 +1、末段歸 0）
 *   ② 在下面 CHANGELOG 最上面加一筆（玩家看得懂的話，不寫檔名/函式/內部機制）
 *   ③ 版號跟 CHANGELOG[0].ver 不一致時，console 會 warn（防漏寫）
 *
 * 顯示：
 *   ・登入頁版本號旁邊加「📜 更新內容」連結 → 視窗列出每一版
 *   ・這台裝置第一次看到新版本（localStorage afk_seen_ver ≠ GAME_VERSION）→ 自動跳一次「已更新到 vX」
 *   ・版本號取自已載入的程式（GAME_VERSION），所以「舊分頁」會顯示舊版號＝一眼看得出有沒有重整到新版
 * 純顯示、不動存檔。
 * ========================================================================== */
(function () {
  'use strict';

  var CHANGELOG = [
    { ver: 'v3.10.0', date: '2026-09-30', items: [
      '🩺 新增「效能檢測」：遊戲畫面左下角的 🩺，按下錄 30 秒，列出幀數、卡頓和畫面每一塊各花多少時間，方便回報哪裡卡（設定可關）'
    ] },
    { ver: 'v3.9.0', date: '2026-09-29', items: [
      '🆕 版本號改由我們自己管理，登入頁可以點「📜 更新內容」看每一版改了什麼；更新後第一次開啟會自動跳出這次的更新',
      '🆕 潘朵拉黑市收購可以設定數量：命中後自動買下並重新掛單，直到買滿（金幣不夠會自動停，不會扣成負的）',
      '🔧 修正：開啟遊戲時版本號會先顯示舊的 v2.4.0，過一陣子才變正確'
    ] },
    { ver: 'v3.8.37', date: '2026-09-25', items: [
      '⏱️ 魔物追蹤效期 8 小時 → 24 小時（費用不變）'
    ] },
    { ver: 'v3.8.36', date: '2026-09-24', items: [
      '🎁 敵對血盟成員、白目、PvP 玩家身上噴的東西，改成依你的等級挑選（不再大半是新手裝；設定可關閉）'
    ] },
    { ver: 'v3.8.35', date: '2026-09-24', items: [
      '⬆️ 等級上限 100 → 200（傭兵一起），100 級以上經驗曲線延續原作公式'
    ] },
    { ver: 'v3.8.34（加掛修正）', date: '2026-09-17 ~ 09-20', items: [
      '☁️ 修正：手機休眠或切換網路後，雲端存檔會卡住存不進去',
      '🔐 修正：新裝置登入時畫面一直重新整理、無法輸入通行碼'
    ] }
  ];

  var LS_SEEN = 'afk_seen_ver';
  var curVer = (typeof GAME_VERSION !== 'undefined') ? GAME_VERSION : null;
  if (curVer && CHANGELOG[0] && CHANGELOG[0].ver !== curVer) console.warn('[AFK-changelog] GAME_VERSION ' + curVer + ' 與最新更新紀錄 ' + CHANGELOG[0].ver + ' 不一致——發版漏寫了？');

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function entryHTML(e, open) {
    return '<details' + (open ? ' open' : '') + ' style="margin:6px 0;border:1px solid rgba(148,163,184,.25);border-radius:8px;padding:6px 10px">' +
      '<summary style="cursor:pointer;font-weight:700;color:#fcd34d">' + esc(e.ver) + ' <span style="color:#94a3b8;font-weight:400;font-size:12px">' + esc(e.date) + '</span></summary>' +
      '<ul style="margin:6px 0 2px 18px;padding:0;list-style:disc">' + e.items.map(function (t) { return '<li style="margin:3px 0">' + esc(t) + '</li>'; }).join('') + '</ul></details>';
  }
  function openModal(onlyLatest) {
    var old = document.getElementById('afk-changelog-modal'); if (old) old.remove();
    var list = onlyLatest ? CHANGELOG.slice(0, 1) : CHANGELOG;
    var wrap = document.createElement('div');
    wrap.id = 'afk-changelog-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
    wrap.innerHTML = '<div style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;max-width:560px;width:100%;max-height:80vh;overflow:auto;padding:14px 16px;font-size:14px;line-height:1.55">' +
      '<div style="font-size:17px;font-weight:800;margin-bottom:4px">' + (onlyLatest ? '🎉 已更新到 ' + esc(curVer || CHANGELOG[0].ver) : '📜 更新內容') + '</div>' +
      '<div style="color:#94a3b8;font-size:12px;margin-bottom:6px">目前版本：' + esc(curVer || '?') + '</div>' +
      list.map(function (e, i) { return entryHTML(e, i === 0); }).join('') +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">' +
      (onlyLatest ? '<button id="afk-cl-all" class="btn" style="padding:4px 10px">看全部紀錄</button>' : '') +
      '<button id="afk-cl-close" class="btn" style="padding:4px 12px">關閉</button></div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (ev) { if (ev.target === wrap) wrap.remove(); });
    document.getElementById('afk-cl-close').onclick = function () { wrap.remove(); };
    var all = document.getElementById('afk-cl-all'); if (all) all.onclick = function () { openModal(false); };
  }
  window.AFK_CHANGELOG = { open: function () { openModal(false); }, list: CHANGELOG };

  function addLink() {
    var v = document.getElementById('login-version');
    if (!v || document.getElementById('afk-changelog-link')) return;
    var a = document.createElement('div');
    a.id = 'afk-changelog-link';
    a.textContent = '📜 更新內容';
    a.style.cssText = 'text-align:center;font-size:12px;color:#fcd34d;cursor:pointer;text-decoration:underline;margin-top:2px;user-select:none';
    a.onclick = function (ev) { ev.stopPropagation(); openModal(false); };
    v.insertAdjacentElement('afterend', a);
  }
  function autoPopup() {
    if (!curVer || CHANGELOG[0].ver !== curVer) return;
    var seen = null; try { seen = localStorage.getItem(LS_SEEN); } catch (e) {}
    if (seen === curVer) return;
    try { localStorage.setItem(LS_SEEN, curVer); } catch (e) {}
    setTimeout(function () { openModal(true); }, 1200);
  }
  function init() { try { addLink(); } catch (e) {} try { autoPopup(); } catch (e) {} console.log('[AFK-changelog] hooks OK'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
