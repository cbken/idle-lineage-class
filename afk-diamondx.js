/* ============================================================================
 * afk-diamondx.js — 潘朵拉黑市「金幣換龍之鑽石」（10 億金幣 = 1 顆，單向、不限次數）
 *
 * 站主 2026-09-30 拍板：「十億換一顆龍鑽…無限換，不要限制一天換幾顆（一天也打不到這麼多錢）」。
 * 平衡備註（研究結論見 docs/plugins.md 本支說明）：龍鑽原本只有「在線遇到龍鑽收購者」一條來源；
 *   刻意做成**單向**（沒有龍鑽換金幣），避免收購者給的鑽變成金幣來源造成通膨。
 *
 * 一致性：金幣存在角色存檔、龍鑽存在全帳號共用資料（兩份）。比照 afk-dograce 的做法：
 *   先加龍鑽（共用資料鎖內完成）→ 再扣金幣 → saveGame() 必須回 true，否則兩邊都退回，
 *   不會出現「錢扣了鑽沒到」或「鑽到了錢沒扣」。
 * UI：潘朵拉黑市收購欄下方一列「💎 金幣換龍之鑽石」＋數量＋兌換鈕（包 pandoraRenderMarket）。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'diamondx', name: '金幣換龍之鑽石', group: '遊戲玩法', def: true,
    desc: '潘朵拉黑市可以用 10 億金幣換 1 顆龍之鑽石（只能金幣換鑽，不限次數）'
  });
  function enabled() { return !window.AFK_TOGGLES || AFK_TOGGLES.enabled('diamondx'); }

  var PRICE = 1000000000;   // 10 億
  if (typeof window.pandoraRenderMarket !== 'function') { console.warn('[AFK-diamondx] 找不到 pandoraRenderMarket，停用。'); return; }
  if (window.pandoraRenderMarket.__afkDia) { console.log('[AFK-diamondx] hooks OK'); return; }

  function diaReady() { return typeof window.pandoraGetSharedDiamonds === 'function' && typeof window.pandoraAdjustSharedDiamonds === 'function'; }
  function diaBalance() { var n = diaReady() ? Number(window.pandoraGetSharedDiamonds()) : 0; return isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }
  function gold() { return (typeof player !== 'undefined' && player && Number(player.gold)) || 0; }
  function msg(html, bad) {
    var el = document.getElementById('afk-dx-msg'); if (el) { el.innerHTML = html; el.style.color = bad ? '#f87171' : '#86efac'; }
    try { if (!bad) logSys('<span class="text-sky-300 font-bold">💎【潘朵拉】</span>' + html); } catch (e) {}
  }

  function exchange(n) {
    n = Math.floor(Number(n) || 0);
    if (!(n >= 1)) { msg('請輸入要換幾顆（1 以上的整數）。', true); return false; }
    if (typeof player === 'undefined' || !player || !player.cls) { msg('尚未載入角色。', true); return false; }
    if (typeof state !== 'undefined' && state.ff) { msg('離線結算中，請稍後再換。', true); return false; }
    if (!diaReady()) { msg('龍之鑽石系統尚未載入，請重新整理後再試。', true); return false; }
    var cost = PRICE * n;
    if (!Number.isSafeInteger(cost)) { msg('數量太大了。', true); return false; }
    if (gold() < cost) { msg('金幣不足：換 ' + n + ' 顆需要 ' + cost.toLocaleString() + ' 金幣（目前 ' + Math.floor(gold()).toLocaleString() + '）。', true); return false; }
    var add = window.pandoraAdjustSharedDiamonds(n) || {};
    if (!add.ok) { msg(add.error || (add.busy ? '共用資料忙碌中，請稍後再試。' : '龍之鑽石異動失敗。'), true); return false; }
    player.gold -= cost;
    var saved = false; try { saved = typeof saveGame === 'function' && saveGame() === true; } catch (e) { saved = false; }
    if (!saved) {
      player.gold += cost; window.pandoraAdjustSharedDiamonds(-n);
      msg('存檔沒成功，已全部退回（金幣與龍鑽都沒變）。', true); return false;
    }
    try { if (typeof updateUI === 'function') updateUI(); } catch (e) {}
    msg('花費 ' + cost.toLocaleString() + ' 金幣，換得 <b>' + n + '</b> 顆龍之鑽石（現在共 ' + diaBalance().toLocaleString() + ' 顆）。');
    return true;
  }

  function decorate() {
    if (!enabled()) return;
    var box = document.querySelector('.pandora-buy-box');
    if (!box || document.getElementById('afk-dx-row')) return;
    var row = document.createElement('div');
    row.id = 'afk-dx-row';
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;padding:6px 8px;border:1px solid rgba(56,189,248,.35);border-radius:8px;background:rgba(8,47,73,.35);font-size:13px';
    row.innerHTML = '<span style="color:#7dd3fc;font-weight:700">💎 金幣換龍之鑽石</span>' +
      '<span style="color:#cbd5e1">10 億 / 顆</span><span style="color:#94a3b8">×</span>' +
      '<input id="afk-dx-n" type="text" inputmode="numeric" value="1" autocomplete="off" style="width:4em;text-align:center">' +
      '<button id="afk-dx-go" type="button" class="btn" style="padding:2px 10px">兌換</button>' +
      '<span style="color:#94a3b8;font-size:12px">（只能金幣換鑽）持有 <b id="afk-dx-bal" style="color:#7dd3fc">' + diaBalance().toLocaleString() + '</b> 顆</span>' +
      '<div id="afk-dx-msg" style="flex-basis:100%;font-size:12px"></div>';
    box.insertAdjacentElement('afterend', row);
    var go = function () {
      var n = Math.floor(Number(String(document.getElementById('afk-dx-n').value).replace(/[,\s，]/g, '')) || 0);
      if (!(n >= 1)) { msg('請輸入要換幾顆（1 以上的整數）。', true); return; }
      if (!confirm('確定用 ' + (PRICE * n).toLocaleString() + ' 金幣換 ' + n + ' 顆龍之鑽石？\n（只能金幣換鑽，不能換回金幣）')) return;
      exchange(n);
      var b = document.getElementById('afk-dx-bal'); if (b) b.textContent = diaBalance().toLocaleString();
    };
    document.getElementById('afk-dx-go').onclick = go;
    document.getElementById('afk-dx-n').onkeydown = function (ev) { if (ev.key === 'Enter') go(); };
  }

  var origRender = window.pandoraRenderMarket;
  var w = function () { var r = origRender.apply(this, arguments); try { decorate(); } catch (e) {} return r; };
  w.__afkDia = true;
  window.pandoraRenderMarket = w;
  window.AFK_DIAMONDX = { exchange: exchange, PRICE: PRICE };
  console.log('[AFK-diamondx] hooks OK');
})();
