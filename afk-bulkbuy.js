/* ============================================================================
 * afk-bulkbuy.js — 潘朵拉黑市「連續收購 N 個」
 *
 * 站主 2026-09-29：「黑市買東西可以一次買多一點嗎？設定單一個價格跟要買多少個」
 *   原版收購單同時只能掛 1 張、數量固定 1：命中一次收購單就消失（js/14 _pandoraStock
 *   `market.buyOrder = null`），命中後東西只是「以你的價格上架」，還要自己點買，
 *   要買 10 個就得「等命中 → 手動買 → 重掛單」重複 10 次。
 *
 * 本外掛（不改原作程式，只包全域函式）：
 *   ・收購欄多一格「數量」（預設 1＝原版行為，完全不介入）
 *   ・數量 ≥2 時：每次命中上架後，自動呼叫原版 buyPandoraItem(i) 買下（原版扣錢/給物/祝福/日誌全照走），
 *     買成功才把同一張收購單原樣掛回去，直到買滿；錢不夠就停手、東西留在架上、提示玩家。
 *   ・命中機率、成交價完全照原作（每 10 分鐘一次輪換機會），只省掉手動重掛與手動點買。
 *   ・離線結算：核心每 100 tick 呼叫 refreshPandoraMarket（js/03），本外掛包在它外面 → 離線也照跑。
 *
 * 狀態存 localStorage `afk_bulkbuy_<存檔位>`＝{id, price, qty, bought}（per 角色；雲端同步整包搬 localStorage 會跟著走）。
 * 掛點：refreshPandoraMarket / pandoraSetBuyOrder / pandoraCancelBuyOrder / pandoraRenderMarket / buyPandoraItem（全是 js/14 全域函式）。
 * 任一缺席 → warn 後整支停用（不會半套）。關閉開關＝完全原版。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'bulkbuy', name: '黑市連續收購', group: '遊戲玩法', def: true,
    desc: '潘朵拉收購欄多一格「數量」：命中後自動買下並重掛同一張收購單，直到買滿（錢不夠會停）；命中機率照原版'
  });
  function enabled() { return !window.AFK_TOGGLES || AFK_TOGGLES.enabled('bulkbuy'); }

  var need = ['refreshPandoraMarket', 'pandoraSetBuyOrder', 'pandoraCancelBuyOrder', 'pandoraRenderMarket', 'buyPandoraItem'];
  for (var k = 0; k < need.length; k++) {
    if (typeof window[need[k]] !== 'function') { console.warn('[AFK-bulkbuy] 找不到 ' + need[k] + '，連續收購停用（遊戲照常運作）。'); return; }
  }
  if (window.refreshPandoraMarket.__afkBulk) { console.log('[AFK-bulkbuy] hooks OK'); return; }

  function slotKey() { return 'afk_bulkbuy_' + (typeof currentSlot !== 'undefined' && currentSlot != null ? currentSlot : 'x'); }
  function getState() { try { var s = JSON.parse(localStorage.getItem(slotKey()) || 'null'); return (s && s.id && s.qty > 1) ? s : null; } catch (e) { return null; } }
  function setState(s) { try { if (s) localStorage.setItem(slotKey(), JSON.stringify(s)); else localStorage.removeItem(slotKey()); } catch (e) {} }
  function market() { return (typeof player !== 'undefined' && player) ? player.pandoraMarket2 : null; }
  function itemName(id) { var d = (typeof DB !== 'undefined' && DB.items) ? DB.items[id] : null; return d ? d.n : id; }
  function log(html) { try { if (!(typeof state !== 'undefined' && state && state.ff)) logSys('<span class="text-amber-300 font-bold">【連續收購】</span>' + html); } catch (e) {} }

  // ── 掛單：原版掛好之後，讀數量欄記下目標 ──
  var origSet = window.pandoraSetBuyOrder;
  window.pandoraSetBuyOrder = function () {
    var qEl = document.getElementById('afk-bulk-qty');
    var qty = qEl ? Math.floor(Number(String(qEl.value).replace(/[,\s，]/g, ''))) : 1;
    var r = origSet.apply(this, arguments);
    if (!enabled()) return r;
    var m = market(), o = m && m.buyOrder;
    if (o && Number.isSafeInteger(qty) && qty >= 2) {
      setState({ id: o.id, price: o.price, qty: Math.min(qty, 9999), bought: 0 });
      log('已設定：以 <b>' + o.price.toLocaleString() + '</b> 金幣連續收購 <b>' + itemName(o.id) + '</b> × ' + Math.min(qty, 9999) + '（命中會自動買下並重掛）');
    } else if (o) {
      setState(null);   // 數量 1＝原版單次收購
    }
    try { decorate(); } catch (e) {}
    return r;
  };

  var origCancel = window.pandoraCancelBuyOrder;
  window.pandoraCancelBuyOrder = function () {
    var r = origCancel.apply(this, arguments);
    var m = market();
    if (!(m && m.buyOrder)) setState(null);   // 真的取消了才清
    return r;
  };

  // ── 輪換：原版跑完後，若命中的是我們的單 → 自動買、重掛 ──
  var busy = false;
  var origRefresh = window.refreshPandoraMarket;
  var wrapped = function (force) {
    var r = origRefresh.apply(this, arguments);
    if (busy || !enabled()) return r;
    var st = getState(), m = market();
    if (!st || !m || !Array.isArray(m.slots)) return r;
    if (st.bought >= st.qty) { setState(null); return r; }
    busy = true;
    try {
      for (var i = 0; i < m.slots.length && st.bought < st.qty; i++) {
        var s = m.slots[i];
        if (!s || s.sold || !s.buyOrder || s.id !== st.id || s.price !== st.price) continue;
        if ((player.gold || 0) < s.price) {
          log('金幣不足，<b>' + itemName(st.id) + '</b> 留在架上（已買 ' + st.bought + ' / ' + st.qty + '），連續收購暫停；補足金幣後手動買下並重新掛單即可續買。');
          setState(null);
          return r;
        }
        var goldBefore = player.gold;
        window.buyPandoraItem(i);
        if (s.sold && player.gold < goldBefore) {
          st.bought++;
          log('已買 <b>' + st.bought + ' / ' + st.qty + '</b>：' + itemName(st.id));
        }
      }
      if (st.bought >= st.qty) {
        setState(null);
        log('<b>' + itemName(st.id) + '</b> × ' + st.qty + ' 全部買齊 ✅');
      } else {
        setState(st);
        if (!m.buyOrder) m.buyOrder = { id: st.id, price: st.price, setTick: (typeof state !== 'undefined' && state) ? (state.ticks || 0) : 0 };   // 原版命中即清單 → 原樣掛回
      }
    } catch (e) {
      console.warn('[AFK-bulkbuy] 自動收購失敗：', e);
    } finally { busy = false; }
    return r;
  };
  wrapped.__afkBulk = true;
  window.refreshPandoraMarket = wrapped;

  // ── UI：收購欄加「數量」與進度 ──
  var origRender = window.pandoraRenderMarket;
  window.pandoraRenderMarket = function (div) {
    var r = origRender.apply(this, arguments);
    try { decorate(); } catch (e) {}
    return r;
  };
  function decorate() {
    if (!enabled()) return;
    var priceEl = document.getElementById('pandora-buy-price');
    if (!priceEl) return;
    var st = getState(), m = market(), o = m && m.buyOrder;
    var old = document.getElementById('afk-bulk-progress'); if (old) old.remove();
    if (!document.getElementById('afk-bulk-qty')) {
    var q = document.createElement('input');
    q.id = 'afk-bulk-qty'; q.type = 'text'; q.inputMode = 'numeric'; q.autocomplete = 'off';
    q.placeholder = '數量'; q.title = '要收購幾個（1＝原版單次）';
    q.value = st ? String(st.qty) : '1';
    q.style.cssText = 'width:3.6em;text-align:center;margin-left:4px';
    q.onkeydown = function (ev) { if (ev.key === 'Enter') window.pandoraSetBuyOrder(); };
    var x = document.createElement('span'); x.className = 'pandora-buy-comma'; x.textContent = '×';
    priceEl.insertAdjacentElement('afterend', q);
    priceEl.insertAdjacentElement('afterend', x);
    }
    var status = document.querySelector('.pandora-buy-status');
    if (status && st && o && o.id === st.id) {
      var p = document.createElement('div');
      p.id = 'afk-bulk-progress'; p.className = 'text-amber-300';
      p.style.cssText = 'font-size:12px;margin-top:2px';
      p.textContent = '連續收購：已買 ' + st.bought + ' / ' + st.qty + '（命中會自動買下並重掛）';
      status.insertAdjacentElement('afterend', p);
    }
  }

  window.AFK_BULKBUY = { state: getState, _setState: setState };
  console.log('[AFK-bulkbuy] hooks OK');
})();
