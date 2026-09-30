/* ============================================================================
 * afk-glowlite.js — 物品發光「分段呼吸」（省效能）
 *
 * 站主 2026-09-30 🩺 實報（i5＋Intel HD 620，1920×1080）：畫面上 129 個動畫、121 個是背包/裝備圖示的發光
 * （遺物閃光/遺物藍光/傳說金光/遠古光/祝福光…），14 fps。這些發光是 `filter: drop-shadow` 的呼吸動畫，
 * 瀏覽器**每一幀**都要重算樣式並重畫那些圖示（filter 動畫不能交給顯示卡合成），弱 CPU/內顯扛不住。
 *
 * 作法：只改「時間曲線」成 steps()——光一樣亮、一樣會呼吸，但每段只換 10 格（每秒約 10 次），
 * 不再每秒重畫 60 次。純 CSS 覆寫，不動任何遊戲邏輯；遺物星芒（relicSpark，transform/opacity，本來就便宜）不動。

 * 設定可關（關掉＝原版平滑呼吸，重新整理後生效）。另有「物品發光不呼吸（最省）」：停在最亮、不動畫。
 * ⚠️ 實測（王族存檔武器頁、CPU 降速 3 倍、兩輪）：主執行緒 原版 11.2s／分段 9.5s（-15%）／不呼吸 8.3s（-26%）；fps 52.6→54.4→58.5。弱內顯實機可能差更多，請用 🩺 比對。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'glowlite', name: '物品發光省效能', group: '遊戲介面', def: true,
    desc: '背包/裝備的發光改成「分段呼吸」（光一樣亮，重畫次數少八成以上）；電腦不夠力時比較順。關掉＝原本的平滑呼吸（重新整理後生效）'
  });
  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'glowstatic', name: '物品發光不呼吸（最省）', group: '遊戲介面', def: false,
    desc: '發光停在最亮的樣子、不再一明一暗（比「分段呼吸」更省，效能最好）；開這個會蓋過上面那個。重新整理後生效'
  });
  var _static = !!(window.AFK_TOGGLES && AFK_TOGGLES.enabled('glowstatic'));
  if (!_static && window.AFK_TOGGLES && !AFK_TOGGLES.enabled('glowlite')) { console.log('[AFK-glowlite] hooks OK（已關閉）'); return; }
  var SEL = [
    '.legend-glow', '.mana-glow', '.relic-glow', '.bless-glow', '.curse-glow', '.ancient-glow', '.anc-bless-glow',
    '.ancient-glow-strong', '.bless-glow-strong', '.tri-glow', '.grace-glow', '.sherine-glow-icon', '.c-sherine',
    '.attr-glow-fr5', '.attr-glow-wa5', '.attr-glow-wi5', '.attr-glow-ea5'
  ];
  var st = document.createElement('style');
  st.id = 'afk-glowlite-css';
  // 不呼吸：暫停在循環的中間（多數發光 2 秒一循環、50% 是最亮）；分段：timing 改 steps(10)
  st.textContent = _static
    ? SEL.join(',') + '{animation-play-state:paused!important;animation-delay:-1s!important}'
    : SEL.join(',') + '{animation-timing-function:steps(10,jump-none)!important}';
  (document.head || document.documentElement).appendChild(st);
  console.log('[AFK-glowlite] hooks OK（' + (_static ? '不呼吸' : '分段呼吸') + '）');
})();
