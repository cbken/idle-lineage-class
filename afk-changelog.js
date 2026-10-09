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
    { ver: 'v3.18.2', date: '2026-10-09', items: [
      '⚡ 小幅效能改善：掛機與補跑時少做一些重複檢查，帶滿傭兵時會順一點'
    ] },
    { ver: 'v3.18.1', date: '2026-10-08', items: [
      '🎎 威頓村「魔法娃娃商人」換娃娃袋子／盒子：現在會把<b>所有角色背包</b>＋倉庫裡的多餘銀卡／金卡一起算，不用再把卡集中到同一個角色身上',
      '扣卡順序：自己背包 → 倉庫 → 其他角色；上鎖的卡不會動，正在別的分頁開著的角色也不會動'
    ] },
    { ver: 'v3.18.0', date: '2026-10-08', items: [
      '🎲 離線奇遇：離線掛機結算完，每 1 小時有機會遇到一件事（最多擲 6 次）——撿到藏寶圖、遇到流浪商人、路邊寶箱',
      '🗺️ 神秘藏寶圖：回村莊在背包使用，帶隊進 60 秒的寶藏小副本（3 波寶藏守衛），每隻都給金幣，全部清光再送一件天梯道具',
      '🧳 流浪商人用金幣賣天梯道具（不爆卷、重抽石、魔眼強化石），關掉視窗他就走了；🎁 路邊寶箱直接給金幣，偶爾附魔眼強化石',
      '成就新增「尋寶者」「寶藏獵人」'
    ] },
    { ver: 'v3.17.0', date: '2026-10-08', items: [
      '🐉 世界頭目：傲慢之塔入口多了「世界頭目」按鈕。每週一換一隻（安塔瑞斯、法利昂、林德拜爾、巴拉卡斯、巨大骷髏、冥皇丹特斯輪流），兩個玩家共用一條血一起打',
      '每個角色每天可以挑戰 3 次、每次 3 分鐘，倒下沒有損失、傷害照算；打倒後頭目會再站起來，每多討伐一次血量 ×1.5、打人也更痛',
      '每打一場送魔眼強化石（打得多送 2 顆）；每討伐成功一次，本週有出手的角色都能領：不爆強化卷 ×2、遺物詞綴重抽石 ×1、魔眼強化石 ×3',
      '有本週傷害排行和上週結果；成就新增「屠神者」「傳說討伐隊」'
    ] },
    { ver: 'v3.16.0', date: '2026-10-08', items: [
      '🏅 成就與稱號：42 個成就（等級、強化、頭目、天梯、財富、收藏、其他），每個成就送一個稱號；稱號只是好看，不加能力',
      '稱號會顯示在名字上方、手機上方狀態列、天梯排行榜上；點稱號就能打開成就面板、換稱號或不顯示',
      '舊角色一進遊戲會自動補發已經達成的成就；打倒頭目、爆裝、倒下次數從這版開始記',
      '修正：改名後天梯排行榜上的名字也會跟著更新'
    ] },
    { ver: 'v3.15.0', date: '2026-10-08', items: [
      '🗓️ 天梯每週詞綴：每週一換一組規則（2 個刁難＋1 個好處），兩個人同一組，比誰這週爬得高；天梯面板和爬塔畫面上方都看得到本週詞綴',
      '刁難可能是：狂暴（怪打更痛）、肉盾（怪血變厚但多給時間）、急行（時間變短）、連戰（過層不回血）、再生（怪會回血）、硬皮、荊棘（打怪會被反彈）、頭目潮（每 5 層就有頭目）；好處可能是：鬥志（傷害提高）、喘息（過層多回血）、從容（多給時間）',
      '🎯 週目標：每週第一次通過 20／40／60／80 層各送一次獎勵（不爆強化卷、遺物詞綴重抽石、魔眼強化石），每週一重置',
      '🏆 天梯排行多一頁「週榜」只比本週最高層，原本的個人榜改叫「總榜」；一輪開始時規則就固定，週一跨夜爬到一半不會突然換'
    ] },
    { ver: 'v3.14.2', date: '2026-10-08', items: [
      '✎ 角色可以改名了：選角畫面名字框右邊按「改名」就能改，不用進遊戲；遊戲裡沒取名時左上角會顯示「✎ 取名」，點了也能改（手機點上方狀態列的名字）',
      '名字最多 12 字，留空就回到未命名；改名不影響強化、存檔和天梯紀錄'
    ] },
    { ver: 'v3.14.1', date: '2026-10-06', items: [
      '🗼 天梯幣每個角色每天最多拿 60 枚（避免一直重爬刷爆不爆強化卷）；拿滿了照樣可以爬、衝紀錄、搶週冠軍，首通獎勵和魔眼不受影響'
    ] },
    { ver: 'v3.14.0', date: '2026-10-04', items: [
      '🗼 新玩法「無限天梯」：傲慢之塔入口最下面進去，帶整隊一層一層往上打，每層 60 秒內清光就上樓；時間到或倒下就結束，死了沒有任何損失',
      '🏆 天梯排行榜：個人榜、職業榜、隊伍榜，兩個玩家一起比；上週爬最高的玩家這週經驗與掉寶 +10%',
      '👁️ 天梯專屬獎勵：25／50／75／100 層首通拿魔眼（魔眼欄終於有東西了），還有不爆強化卷（強化時勾選，失敗裝備不會消失）、遺物詞綴重抽石、天梯幣商店'
    ] },
    { ver: 'v3.13.2', date: '2026-10-02', items: [
      '☁️ 修正：早上第一次打開時，如果網路還沒好、或拿到舊的雲端回應，會一直玩這台電腦上的舊檔，要重新整理才對。現在會自動每隔幾秒再問雲端，拿到最新的就自動換過去'
    ] },
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
