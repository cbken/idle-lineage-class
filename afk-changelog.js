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
    { ver: 'v3.13.1', date: '2026-10-01', items: [
      '🔍 搜尋打一個字就會動：倉庫搜尋、黑市收購的名稱提示、社交找玩家，原本都要打兩個字才開始找'
    ] },
    { ver: 'v3.13.0', date: '2026-10-01', items: [
      '👥 組隊改 16 人：所有職業都能同時帶 15 名傭兵（帳號其他 15 個角色全部可帶），不再看魅力',
      '🧍 戰場多一排站位：第 8～15 名傭兵站在第三排，不會全部疊在同一格',
      '💰 掉落／金幣的組隊倍率維持最高 ×8（第 9 人起只加戰力，避免通膨）',
      '⚡ 離線快轉的殺速紀錄會分隊伍組成記：換了隊員會先重新量一次，不會拿 7 人的速度去算 15 人'
    ] },
    { ver: 'v3.12.1', date: '2026-10-01', items: [
      '⚡ 補跑變快：離線不到 15 分鐘、而且還在同一張地圖同一套裝備時，直接用之前量好的打怪速度快轉（實測 7 分鐘離線 3.3 秒 → 0.6 秒）',
      '⚡ 逐拍模擬也變快：寵物每拍都在重算全隊裝備的寵物加成，改成每拍只算一次（實測 1 小時全模擬 19.6 秒 → 11.4 秒）'
    ] },
    { ver: 'v3.12.0', date: '2026-10-01', items: [
      '🎒 新背包：武器／防具／道具只畫看得到的那十幾格（幾百件也不卡），上方可選排列方式（分類／品質／強化值／最新取得／名稱），會記住你的選擇',
      '🗑️ 標廢品模式：切到「標廢品」後點一下就標／再點取消，可勾「同名一起標」；上面隨時顯示廢品幾件，一鍵賣出',
      '⚒️ 快速強化：操作列不會再一直被刷掉（不用搶快點下拉選單）；可設「強化到 +N」和「+N 起改用祝卷」，勾好要強化的裝備按一次就跑完',
      '🩸 批次弱化：勾選多件武器／防具，用紅卷（詛咒卷軸）一次降到指定強化值',
      '⚙️ 想用舊背包：設定 →「新背包」關掉即可'
    ] },
    { ver: 'v3.11.4', date: '2026-10-01', items: [
      '🚀 背包更跟手：背包更新時，沒變的格子直接沿用、只重畫有變的那幾格（重建時間少約 3 成，點背包、撿東西時比較不會頓）'
    ] },
    { ver: 'v3.11.3', date: '2026-09-30', items: [
      '📱 手機：點按鈕跳出的小提示改到畫面下方（不再蓋住視窗右上角的「關閉」），而且點得穿；「遊戲進度已儲存」這句不再每次跳出來',
      '📱 手機：左下角的 🩺 移到底部選單上面，不再壓到「戰鬥」按鈕'
    ] },
    { ver: 'v3.11.2', date: '2026-09-30', items: [
      '✨ 物品發光更省效能：背包／裝備的發光改成「分段呼吸」（光一樣亮、一樣會呼吸，重畫少很多）；設定裡還有「物品發光不呼吸（最省）」可以選，想要原本的平滑呼吸也能關掉'
    ] },
    { ver: 'v3.11.1', date: '2026-09-30', items: [
      '⚡ 修正：補跑（離線結算）時如果切到別的分頁或縮小視窗，有時會拖到 10 分鐘；現在跟停在前景一樣快（實測 27 小時補跑 112 秒 → 4 秒）',
      '🩺 效能檢測會多顯示「顯示卡有沒有被 Chrome 用到」和畫面上最多的是哪種動畫'
    ] },
    { ver: 'v3.11.0', date: '2026-09-30', items: [
      '💎 潘朵拉黑市可以用金幣換龍之鑽石：10 億金幣換 1 顆，不限次數（只能金幣換鑽，不能換回金幣）',
      '🚀 背包開著打怪更順：武器／防具／道具只重建你正在看的那一頁，其他頁切過去才更新；戰鬥中背包最快一秒更新一次',
      '🩺 效能檢測修正：按下後不再跳確認框，也不會把按鈕那一下誤算成卡頓'
    ] },
    { ver: 'v3.10.0', date: '2026-09-30', items: [
      '🚀 動畫全開更順：戰鬥日誌不再每寫一行就讓畫面重新排版；背包／武器／防具分頁沒打開時不再一直重建（切過去才更新）。實測卡頓幀減少約 9 成',
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
