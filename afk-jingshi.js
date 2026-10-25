/*
 * afk-jingshi.js — 💎 精石：分解裝備換精石 → ✨ 洗煉（裝備隨機三條屬性）＋ 🎲 骰武器（重骰武器傷害）
 *   Ken 10/25：「限時黑市跟融合把他們變成精石，用精石去把武器或裝備的數值隨機改變 會增加會減少，每次參與要天幣，還有更高級的去骰武器功能」
 *   Ken 10/25：「遺物每個 2 這跟一般裝備比例不對」「傳說 5」「這遊戲走賭徒系統 要狂」
 *
 * 分解（潘朵拉黑市、融合選單）：一般 1／祝福或遠古 3／傳說 5／遺物 10＋🔥每級 5；一般裝備每強化 +1 再 +1。
 *   不分解：身上穿的、上鎖的、巨靈願望、魔眼、寵物裝、箭、天梯物品。預設每種留 1 個。
 * ✨ 洗煉：精石 5＋天梯幣 3（鎖 1 條再 +2 幣）。三條全部重抽（屬性跟數字都重來），不能還原。
 *   每條等級：詛咒 12%（扣數值）／普通 48%／優秀 28%／極品 10%／神品 2%。
 * 🎲 骰武器：精石 30＋天梯幣 10。小型／大型傷害重骰成原本的 60%～150%；3% 神骰 180%～200%。不能還原。
 *
 * 資料：物品實例 rf=[{k,v,t}]（洗煉三條；t＝等級 0~4）、rw={s,l}（骰過的小型／大型骰面）；角色 player.jsStone（精石數）。
 *   ⚠️ itemSig 一定要含 rf／rw，不然洗過的會跟白板同名裝備疊成一堆。
 *   🎲 戰鬥讀主武器走核心 afkWpnDef()（js/01，js/03/04/07 原本是 DB.items[player.eq.wpn.id]），有 rw 就換骰面。
 *   ✨ 六圍（力敏智體）要在核心 Phase 1 之前加進去，衍生值（傷害、命中、HP…）才會跟著變：
 *     重算時暫時加到 player.panacea（萬能藥那格，核心 Phase 0 會讀），算完馬上還原；其他屬性算完再補。
 *   能力、名字、簽章這三個包裝不受開關影響（關掉只藏入口），跟融合同做法。
 */
(function () {
  'use strict';
  if (typeof DB === 'undefined' || !DB.items) return;

  var VAL = { normal: 1, good: 3, legend: 5, relic: 10, relicFz: 5 };
  var REFINE_JS = 5, REFINE_COIN = 3, LOCK_COIN = 2;
  var REROLL_JS = 30, REROLL_COIN = 10;
  var TIERS = [
    { n: '詛咒', w: 12, c: '#f87171' },
    { n: '普通', w: 48, c: '#cbd5e1' },
    { n: '優秀', w: 28, c: '#60a5fa' },
    { n: '極品', w: 10, c: '#c084fc' },
    { n: '神品', w: 2, c: '#fbbf24' }
  ];
  var R_SMALL = [[-2, -1], [1, 2], [3, 4], [5, 7], [8, 12]];
  var R_STAT = [[-2, -1], [1, 1], [2, 2], [3, 4], [5, 7]];
  var LINES = {
    dmg: { n: '額外傷害', r: R_SMALL },
    hit: { n: '命中', r: R_SMALL },
    ac: { n: 'AC', r: R_SMALL },   // v＝好處：v=5 → AC −5
    mr: { n: 'MR', r: [[-4, -2], [2, 4], [5, 8], [9, 14], [15, 25]] },
    hp: { n: 'HP', r: [[-40, -20], [20, 40], [50, 80], [90, 150], [160, 300]] },
    mp: { n: 'MP', r: [[-30, -10], [10, 30], [35, 60], [65, 100], [110, 200]] },
    str: { n: '力量', r: R_STAT },
    dex: { n: '敏捷', r: R_STAT },
    int: { n: '智力', r: R_STAT },
    con: { n: '體質', r: R_STAT }
  };
  var KEYS = Object.keys(LINES);
  var STAT6 = ['str', 'dex', 'int', 'con'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ri(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function isGearDef(d) { return !!d && (d.type === 'wpn' || d.type === 'arm' || d.type === 'acc') && d.slot !== 'petwpn' && d.slot !== 'petarm' && d.slot !== 'eye' && !d.isArrow; }
  function isLadderId(id) { return String(id || '').indexOf('afk_') === 0; }
  function rfOf(it) { return it && Array.isArray(it.rf) ? it.rf.filter(function (x) { return x && LINES[x.k] && isFinite(x.v); }) : []; }
  function rwOf(it) { return it && it.rw && it.rw.s > 0 && it.rw.l > 0 ? it.rw : null; }
  function lineText(x) {
    var L = LINES[x.k], v = Math.round(x.v);
    if (x.k === 'ac') return 'AC ' + (v >= 0 ? '−' + v : '+' + (-v));
    return L.n + ' ' + (v >= 0 ? '+' + v : '−' + (-v));
  }
  function lineHtml(x) { var t = TIERS[x.t] || TIERS[1]; return '<span style="color:' + t.c + '">' + (x.t >= 3 ? '【' + t.n + '】' : '') + esc(lineText(x)) + '</span>'; }
  function bestTier(it) { return rfOf(it).reduce(function (m, x) { return Math.max(m, x.t || 0); }, -1); }

  // ===== 簽章：含洗煉／骰武器 =====
  if (typeof window.itemSig === 'function') {
    var _sig = window.itemSig;
    window.itemSig = function (it) {
      var s = _sig.apply(this, arguments), rf = rfOf(it), rw = rwOf(it);
      if (rf.length) s += '|rf' + rf.map(function (x) { return x.k + x.v; }).join(',');
      if (rw) s += '|rw' + rw.s + '.' + rw.l;
      return s;
    };
  }

  // ===== 名字：✨／🎲 前綴 =====
  if (typeof window.getItemFullName === 'function') {
    var _name = window.getItemFullName;
    window.getItemFullName = function (it) {
      var h = _name.apply(this, arguments), pre = '';
      try {
        var bt = bestTier(it); if (bt >= 0) pre += '<span style="color:' + TIERS[bt].c + ';font-weight:800">✨</span>';
        if (rwOf(it)) pre += '<span style="font-weight:800">🎲</span>';
      } catch (e) {}
      return pre ? pre + ' ' + h : h;
    };
  }

  // ===== 能力 =====
  function eqSum() {
    var s = {}; KEYS.forEach(function (k) { s[k] = 0; });
    try {
      for (var slot in player.eq) {
        if (slot === 'offwpn') continue;   // 副手武器跟核心一樣不算能力
        var e = player.eq[slot]; if (!e) continue;
        rfOf(e).forEach(function (x) { s[x.k] += Math.round(x.v); });
      }
    } catch (e) {}
    return s;
  }
  if (typeof window.recomputeStats === 'function') {
    var _rs = window.recomputeStats;
    window.recomputeStats = function () {
      var sum = null, pn = null, made = false, prev = {};
      try {
        if (typeof player !== 'undefined' && player && player.eq && player.d) {
          sum = eqSum();
          if (STAT6.some(function (k) { return sum[k]; })) {
            if (!player.panacea || typeof player.panacea !== 'object') { player.panacea = {}; made = true; }
            pn = player.panacea;
            STAT6.forEach(function (k) { prev[k] = Object.prototype.hasOwnProperty.call(pn, k) ? pn[k] : undefined; if (sum[k]) pn[k] = (Number(pn[k]) || 0) + sum[k]; });
          }
        }
      } catch (e) { sum = null; }
      var r;
      try { r = _rs.apply(this, arguments); }
      finally {
        if (pn) {
          if (made) { try { delete player.panacea; } catch (e) {} }
          else STAT6.forEach(function (k) { if (prev[k] === undefined) delete pn[k]; else pn[k] = prev[k]; });
        }
      }
      try {
        if (sum) {
          var d = player.d;
          if (sum.dmg) d.extraDmg = (d.extraDmg || 0) + sum.dmg;
          if (sum.hit) d.extraHit = (d.extraHit || 0) + sum.hit;
          if (sum.ac) d.ac = (d.ac || 0) - sum.ac;
          if (sum.mr) d.mr = (d.mr || 0) + sum.mr;
          if (sum.hp) { player.mhp = Math.max(1, (player.mhp || 0) + sum.hp); if (player.hp > player.mhp) player.hp = player.mhp; }
          if (sum.mp) { player.mmp = Math.max(0, (player.mmp || 0) + sum.mp); if (player.mp > player.mmp) player.mp = player.mmp; }
        }
      } catch (e) {}
      return r;
    };
  }

  // ===== 說明欄 =====
  if (typeof window.buildItemDescHTML === 'function') {
    var _desc = window.buildItemDescHTML;
    window.buildItemDescHTML = function (it) {
      var h = _desc.apply(this, arguments);
      try {
        if (typeof h !== 'string' || !it) return h;
        var rf = rfOf(it), rw = rwOf(it), d = DB.items[it.id];
        if (rw && d) h += '<br><span class="font-bold" style="color:#fbbf24">🎲 骰過的武器：小型傷害 ' + rw.s + '（原 ' + d.dmgS + '）／大型傷害 ' + rw.l + '（原 ' + d.dmgL + '）</span>';
        if (rf.length) h += '<br><span class="font-bold" style="color:#a5f3fc">✨ 洗煉：</span>' + rf.map(lineHtml).join('、');
      } catch (e) {}
      return h;
    };
  }

  function stones() { try { return Math.max(0, Math.floor(Number(player.jsStone) || 0)); } catch (e) { return 0; } }
  function L() { try { return window.__afkLadder && window.__afkLadder.data ? window.__afkLadder.data() : null; } catch (e) { return null; } }
  function coins() { var x = L(); return x ? (x.coins || 0) : 0; }

  // 分解價值
  function value(it) {
    var d = it && DB.items[it.id]; if (!d) return 0;
    if (d.relic) return VAL.relic + VAL.relicFz * Math.max(0, Math.min(10, Math.floor(Number(it.fz) || 0)));
    var v = d.legend ? VAL.legend : ((it.bless === true || it.anc) ? VAL.good : VAL.normal);
    return v + Math.max(0, Math.floor(Number(it.en) || 0));
  }
  function breakable(it) {
    var d = it && DB.items[it.id];
    return isGearDef(d) && !isLadderId(it.id) && !it.lock && !it.gw && !rfOf(it).length && !rwOf(it);
  }

  // ===== 洗煉 =====
  function pickTier() {
    var tot = TIERS.reduce(function (a, t) { return a + t.w; }, 0), r = Math.random() * tot;
    for (var i = 0; i < TIERS.length; i++) { r -= TIERS[i].w; if (r < 0) return i; }
    return 1;
  }
  function rollLine(k) { var t = pickTier(), rg = LINES[k].r[t]; return { k: k, v: ri(rg[0], rg[1]), t: t }; }
  function rollAll(old, lockIdx) {
    var keep = (lockIdx != null && old[lockIdx]) ? old[lockIdx] : null, out = [], used = {};
    if (keep) used[keep.k] = 1;
    for (var i = 0; i < 3; i++) {
      if (keep && i === lockIdx) { out.push(keep); continue; }
      var pool = KEYS.filter(function (k) { return !used[k]; });
      var k = pool[Math.floor(Math.random() * pool.length)]; used[k] = 1;
      out.push(rollLine(k));
    }
    return out;
  }
  // 🎲 骰武器
  function rollWeapon(d) {
    var god = Math.random() < 0.03;
    var m = god ? 1.8 + Math.random() * 0.2 : 0.6 + Math.random() * 0.9;
    function one(b) { return Math.max(1, Math.round(b * m * (0.95 + Math.random() * 0.1))); }
    return { s: one(d.dmgS || 1), l: one(d.dmgL || 1), god: god, m: m };
  }

  window.afkJingshi = { value: value, breakable: breakable, rollAll: rollAll, rollWeapon: rollWeapon, LINES: LINES, TIERS: TIERS, stones: stones };

  // ===== 以下是入口與介面（開關只管這段） =====
  if (window.AFK_TOGGLES && !AFK_TOGGLES.enabled('jingshi')) return;

  function inTown() { try { return !!(mapState && mapState.current && String(mapState.current).indexOf('town_') === 0); } catch (e) { return false; } }
  function wh() { try { return inTown() && typeof loadWarehouse === 'function' ? loadWarehouse() : null; } catch (e) { return null; } }
  function nm(it) { try { return window.getItemFullName(Object.assign({}, it, { cnt: 1 })); } catch (e) { return esc((DB.items[it.id] || {}).n || it.id); } }
  function plainName(id) { return (DB.items[id] || {}).n || id; }
  function sigSafe(it) { try { return window.itemSig(it); } catch (e) { return it.uid; } }
  function refreshAll() {
    try { if (typeof window.calcStats === 'function') window.calcStats(); } catch (e) {}
    try { if (typeof window.renderTabs === 'function') window.renderTabs(true); } catch (e) {}
    try { if (typeof window.updateUI === 'function') window.updateUI(); } catch (e) {}
  }
  function log(h) { try { if (typeof logSys === 'function') logSys(h); } catch (e) {} }

  var BOX = 'afk-js-modal';
  function css() {
    if (document.getElementById('afk-js-css')) return;
    var s = document.createElement('style'); s.id = 'afk-js-css';
    var B = '#' + BOX;
    s.textContent = [
      B + '{position:fixed;inset:0;z-index:2147483000;background:rgba(2,6,23,.72);display:flex;align-items:center;justify-content:center;padding:16px}',
      B + ' .js-card{background:#0b1220;border:1px solid #155e75;border-radius:10px;max-width:480px;width:100%;max-height:88vh;display:flex;flex-direction:column;color:#e2e8f0;box-shadow:0 10px 40px rgba(0,0,0,.6)}',
      B + ' .js-head{padding:12px 14px 8px;border-bottom:1px solid #1e293b}',
      B + ' .js-title{font-weight:800;font-size:16px;color:#67e8f9}',
      B + ' .js-sub{font-size:12px;color:#94a3b8;margin-top:2px;line-height:1.5}',
      B + ' .js-body{padding:8px 14px;overflow:auto;flex:1}',
      B + ' .js-foot{padding:10px 14px;border-top:1px solid #1e293b;display:flex;gap:8px}',
      B + ' .js-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;font-size:14px}',
      B + ' button.js-row:hover{background:#0f2433;border-color:#334155}',
      B + ' .js-r{margin-left:auto;font-size:12px;color:#94a3b8;white-space:nowrap}',
      B + ' .js-src{font-size:11px;color:#64748b;white-space:nowrap}',
      B + ' .js-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 6px;font-size:12px}',
      B + ' .js-tools button{padding:3px 8px;border:1px solid #334155;border-radius:5px;background:#0f172a;color:#cbd5e1}',
      B + ' .js-res{font-size:13px;line-height:1.7}',
      B + ' .js-go{flex:1;padding:9px;border-radius:6px;font-weight:800;background:#0e7490;color:#ecfeff;border:1px solid #06b6d4}',
      B + ' .js-go[disabled]{background:#1e293b;color:#64748b;border-color:#334155}',
      B + ' .js-x{padding:9px 14px;border-radius:6px;background:#1e293b;color:#cbd5e1;border:1px solid #334155}',
      B + ' input[type=search]{width:100%;padding:6px 8px;border-radius:6px;background:#020617;border:1px solid #334155;color:#e2e8f0;font-size:14px;margin:4px 0 6px}',
      B + ' .js-line{display:flex;align-items:center;gap:8px;padding:6px 8px;margin:4px 0;border-radius:6px;background:#0f172a;border:1px solid #1e293b;font-size:14px}',
      B + ' .js-line.lock{border-color:#0891b2}',
      B + ' .js-wallet{font-size:12px;color:#a5f3fc;margin-top:4px}',
      B + ' .js-flash{animation:jsflash .7s ease-out}',
      '@keyframes jsflash{0%{transform:scale(1.04);filter:brightness(2.2)}100%{transform:scale(1);filter:none}}',
      B + ' .js-god{font-size:18px;font-weight:900;color:#fbbf24;text-align:center;margin:6px 0;text-shadow:0 0 12px #f59e0b}',
      '.afk-js-bar{display:flex;gap:6px;margin:0 0 8px}',
      '.afk-js-bar button{flex:1;padding:7px 4px;border-radius:6px;font-weight:800;font-size:13px;background:#083344;color:#a5f3fc;border:1px solid #0e7490}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }
  function close() { var w = document.getElementById(BOX); if (w) w.remove(); }
  function wallet() { return '<div class="js-wallet">💎 精石 <b>' + stones().toLocaleString() + '</b>　🗼 天梯幣 <b>' + coins().toLocaleString() + '</b></div>'; }
  function shell(title, sub, body, foot) {
    close(); css();
    var w = document.createElement('div'); w.id = BOX;
    w.innerHTML = '<div class="js-card"><div class="js-head"><div class="js-title">' + title + '</div>' + (sub ? '<div class="js-sub">' + sub + '</div>' : '') + wallet() +
      '</div><div class="js-body">' + body + '</div><div class="js-foot">' + (foot || '') + '<button class="js-x" data-act="close">關閉</button></div></div>';
    w.addEventListener('click', function (e) { if (e.target === w) close(); });
    w.querySelector('[data-act=close]').onclick = close;
    document.body.appendChild(w);
    return w;
  }
  function setWallet(w) { var x = w.querySelector('.js-wallet'); if (x) x.outerHTML = wallet(); }
  var SRC = { eq: '身上', inv: '背包', wh: '倉庫' };

  // ---------------- 💎 分解 ----------------
  function breakRows() {
    var out = [], w = wh();
    (player.inv || []).forEach(function (i) { if (i && breakable(i)) out.push({ it: i, src: 'inv' }); });
    if (w) (w.items || []).forEach(function (i) { if (i && breakable(i)) out.push({ it: i, src: 'wh' }); });
    out.forEach(function (o) { o.val = value(o.it); o.cnt = o.it.cnt || 1; o.relic = !!(DB.items[o.it.id] || {}).relic; });
    out.sort(function (a, b) { return (b.val - a.val) || (plainName(a.it.id) < plainName(b.it.id) ? -1 : 1); });
    return out;
  }
  // 每種留 1 個：同 id 的總數減 1，從排在最後的那一疊扣（最後一疊＝價值最低）
  function breakPlan(rows, picked, keepOne) {
    var byId = {}, plan = [], total = 0, n = 0;
    rows.forEach(function (o, i) { if (picked[i]) (byId[o.it.id] = byId[o.it.id] || []).push(i); });
    var owned = {};
    rows.forEach(function (o) { owned[o.it.id] = (owned[o.it.id] || 0) + o.cnt; });
    Object.keys(byId).forEach(function (id) {
      var idx = byId[id], keep = 0;
      // 只有「這個 id 全部都被勾」才需要留：有沒勾的就已經留下了
      var pickedCnt = idx.reduce(function (a, i) { return a + rows[i].cnt; }, 0);
      if (keepOne && pickedCnt >= owned[id]) keep = 1;
      for (var j = idx.length - 1; j >= 0; j--) {
        var o = rows[idx[j]], take = o.cnt;
        if (keep) { var k = Math.min(keep, take); take -= k; keep -= k; }
        if (take > 0) { plan.push({ o: o, n: take }); total += take * o.val; n += take; }
      }
    });
    return { plan: plan, total: total, n: n };
  }
  function openBreak() {
    if (typeof player === 'undefined' || !player || !player.cls) return;
    var rows = breakRows(), picked = {}, keepOne = true, q = '';
    var w = shell('💎 分解成精石', '一般 1／祝福或遠古 3／傳說 5／遺物 10（🔥每級 +5）；一般裝備每強化 +1 再 +1。<br>不會分解：身上穿的、上鎖的、洗過或骰過的。' + (inTown() ? '倉庫裡的也算。' : '回村莊就能分解倉庫裡的。'),
      '<input type="search" placeholder="搜尋裝備名稱" data-act="q"><div class="js-tools"><button data-act="all">全選（搜尋結果）</button><button data-act="relic">只選遺物</button><button data-act="norm">只選一般裝備</button><button data-act="none">全不選</button>' +
      '<label style="margin-left:auto;display:flex;gap:4px;align-items:center;color:#cbd5e1"><input type="checkbox" data-act="keep" checked>每種留 1 個</label></div><div data-act="sum" class="js-res"></div><div data-act="list"></div>',
      '<button class="js-go" data-act="go" disabled>分解</button>');
    function shown() { return rows.map(function (o, i) { return i; }).filter(function (i) { return !q || plainName(rows[i].it.id).indexOf(q) >= 0; }); }
    function draw() {
      var p = breakPlan(rows, picked, keepOne), vis = shown();
      w.querySelector('[data-act=sum]').innerHTML = p.n ? '分解 <b>' + p.n.toLocaleString() + '</b> 件 → <b style="color:#67e8f9">💎 ' + p.total.toLocaleString() + ' 精石</b>' : '<span class="js-sub">勾選要分解的裝備</span>';
      var lim = vis.slice(0, 300), take = {};
      p.plan.forEach(function (x) { take[x.o.it.uid + '|' + x.o.src] = x.n; });
      w.querySelector('[data-act=list]').innerHTML = lim.length ? lim.map(function (i) {
        var o = rows[i], tk = take[o.it.uid + '|' + o.src] || 0, kept = picked[i] && tk < o.cnt;
        return '<label class="js-row" style="cursor:pointer"><input type="checkbox" data-i="' + i + '"' + (picked[i] ? ' checked' : '') + '><span class="js-src">' + SRC[o.src] + '</span><span>' + nm(o.it) + '</span>' +
          '<span class="js-r">' + (kept ? '<span style="color:#fbbf24">留 ' + (o.cnt - tk) + '</span> · ' : '') + o.cnt + ' 個 · 各 ' + o.val + '</span></label>';
      }).join('') + (vis.length > lim.length ? '<div class="js-sub" style="padding:6px 0">還有 ' + (vis.length - lim.length) + ' 筆沒列出來（全選會一起選），可以用搜尋縮小。</div>' : '')
        : '<div class="js-sub" style="padding:10px 0">' + (rows.length ? '找不到符合的裝備。' : '沒有可以分解的裝備。') + '</div>';
      [].forEach.call(w.querySelectorAll('[data-i]'), function (c) { c.onchange = function () { var i = +c.getAttribute('data-i'); if (c.checked) picked[i] = 1; else delete picked[i]; draw(); }; });
      var go = w.querySelector('[data-act=go]'); go.disabled = !p.n; go.textContent = p.n ? '分解 ' + p.n.toLocaleString() + ' 件（+' + p.total.toLocaleString() + ' 精石）' : '分解';
    }
    w.querySelector('[data-act=q]').oninput = function (e) { q = e.target.value.trim(); draw(); };
    w.querySelector('[data-act=all]').onclick = function () { shown().forEach(function (i) { picked[i] = 1; }); draw(); };
    w.querySelector('[data-act=relic]').onclick = function () { picked = {}; shown().forEach(function (i) { if (rows[i].relic) picked[i] = 1; }); draw(); };
    w.querySelector('[data-act=norm]').onclick = function () { picked = {}; shown().forEach(function (i) { if (!rows[i].relic) picked[i] = 1; }); draw(); };
    w.querySelector('[data-act=none]').onclick = function () { picked = {}; draw(); };
    w.querySelector('[data-act=keep]').onchange = function (e) { keepOne = e.target.checked; draw(); };
    var busy = false;
    w.querySelector('[data-act=go]').onclick = function () {
      if (busy) return; busy = true;
      var p = breakPlan(rows, picked, keepOne), r = p.n ? execBreak(p.plan) : null; busy = false;
      if (!r) return;
      shell('💎 分解完成', '', '<div class="js-res">分解了 ' + r.n.toLocaleString() + ' 件裝備，拿到 <b style="color:#67e8f9">💎 ' + r.gain.toLocaleString() + ' 精石</b>。</div>',
        '<button class="js-go" data-act="ref">去洗煉</button>');
      var b = document.querySelector('#' + BOX + ' [data-act=ref]'); if (b) b.onclick = openRefinePicker;
    };
    draw();
  }
  function execBreak(plan) {
    var useWh = plan.some(function (x) { return x.o.src === 'wh'; });
    if (useWh && !inTown()) { alert('離開村莊了，倉庫不能用。'); return null; }
    var w = useWh ? loadWarehouse() : null;
    var snap = typeof whTxnSnapshot === 'function' ? whTxnSnapshot() : { inv: JSON.parse(JSON.stringify(player.inv || [])), gold: player.gold };
    var before = stones(), gain = 0, n = 0;
    plan.forEach(function (x) {
      var arr = x.o.src === 'wh' ? (w && w.items) : player.inv; if (!arr) return;
      var i = arr.findIndex(function (s) { return s && s.uid === x.o.it.uid; });
      if (i < 0 || !breakable(arr[i]) || arr[i].id !== x.o.it.id) return;
      var s = arr[i], c = s.cnt || 1, k = Math.min(c, x.n), v = value(s);
      if (k >= c) arr.splice(i, 1); else s.cnt = c - k;
      gain += k * v; n += k;
    });
    if (!n) { if (typeof whTxnRestore === 'function') whTxnRestore(snap); alert('東西已經不在了，請重新打開。'); return null; }
    player.jsStone = before + gain;
    var ok;
    if (w) ok = whTxnCommit(w, snap);
    else { ok = typeof saveGame === 'function' && saveGame(); if (!ok && typeof whTxnRestore === 'function') whTxnRestore(snap); }
    if (!ok) { player.jsStone = before; try { saveGame(); } catch (e) {} alert('存檔失敗，分解已取消，東西都還在。'); return null; }
    refreshAll();
    try { var ic = document.getElementById('interaction-content'); if (useWh && ic && ic.querySelector('#wh-store-list') && typeof renderWarehouseNPC === 'function') renderWarehouseNPC(ic); } catch (e) {}
    log('<span style="color:#67e8f9;font-weight:700">💎 分解了 ' + n + ' 件裝備，拿到 ' + gain + ' 精石（共 ' + stones() + '）</span>');
    return { n: n, gain: gain };
  }

  // ---------------- 選裝備（洗煉／骰武器共用） ----------------
  function gearChoices(wpnOnly) {
    var out = [], seen = {};
    Object.keys(player.eq || {}).forEach(function (k) {
      var e = player.eq[k], d = e && DB.items[e.id];
      if (!e || !isGearDef(d) || isLadderId(e.id) || e.gw) return;
      if (wpnOnly && (d.type !== 'wpn' || k === 'offwpn')) return;
      out.push({ it: e, src: 'eq', slot: k });
    });
    (player.inv || []).forEach(function (i) {
      var d = i && DB.items[i.id];
      if (!i || !isGearDef(d) || isLadderId(i.id) || i.gw) return;
      if (wpnOnly && d.type !== 'wpn') return;
      var key = sigSafe(i); if (seen[key]) return; seen[key] = 1;
      out.push({ it: i, src: 'inv' });
    });
    function sc(it) { try { return typeof window.afkGearScore === 'function' ? (window.afkGearScore(it) || 0) : 0; } catch (e) { return 0; } }
    out.forEach(function (o) { o.v = sc(o.it); });
    out.sort(function (a, b) { return ((b.src === 'eq') - (a.src === 'eq')) || (b.v - a.v); });
    return out;
  }
  function openChooser(wpnOnly, title, sub, onPick) {
    var rows = gearChoices(wpnOnly), q = '';
    var w = shell(title, sub, '<input type="search" placeholder="搜尋名稱" data-act="q"><div data-act="list"></div>');
    function draw() {
      var list = rows.filter(function (o) { return !q || plainName(o.it.id).indexOf(q) >= 0; }).slice(0, 200);
      w.querySelector('[data-act=list]').innerHTML = list.length ? list.map(function (o) {
        return '<button class="js-row" data-i="' + rows.indexOf(o) + '"><span class="js-src">' + SRC[o.src] + '</span><span>' + nm(o.it) + '</span><span class="js-r">⭐ ' + Math.round(o.v).toLocaleString() + '</span></button>';
      }).join('') : '<div class="js-sub" style="padding:10px 0">身上和背包沒有可以用的' + (wpnOnly ? '武器' : '裝備') + '（倉庫裡的要先拿出來）。</div>';
      [].forEach.call(w.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { onPick(rows[+b.getAttribute('data-i')]); }; });
    }
    w.querySelector('[data-act=q]').oninput = function (e) { q = e.target.value.trim(); draw(); };
    draw();
  }
  // 背包裡一疊的話拆一件出來（洗過的要自己一格）
  function single(t) {
    if (t.src === 'eq') return t.it;
    var arr = player.inv, i = arr.findIndex(function (s) { return s && s.uid === t.it.uid; });
    if (i < 0) return null;
    var s = arr[i];
    if ((s.cnt || 1) > 1) {
      s.cnt -= 1;
      var one = Object.assign({}, s, { cnt: 1, uid: window.uid() });
      delete one.junk; delete one.junkSince; delete one._autoSellQty; delete one._ruleJunk;
      arr.push(one); return one;
    }
    return s;
  }
  // 扣精石＋天梯幣、改裝備、存檔；失敗全部還原
  function pay(jsCost, coinCost, mutate) {
    var LL = L();
    if (!LL) { alert('天梯資料讀不到。'); return null; }
    if (stones() < jsCost) { alert('精石不夠。'); return null; }
    if ((LL.coins || 0) < coinCost) { alert('天梯幣不夠。'); return null; }
    var invSnap = JSON.parse(JSON.stringify(player.inv || [])), eqSnap = JSON.parse(JSON.stringify(player.eq || {}));
    var js0 = stones(), c0 = LL.coins;
    var res = mutate();
    if (!res) { player.inv = invSnap; return null; }
    player.jsStone = js0 - jsCost; LL.coins = c0 - coinCost;
    var ok = typeof saveGame === 'function' && saveGame();
    if (!ok) {
      player.inv = invSnap;
      Object.keys(eqSnap).forEach(function (k) { if (player.eq[k] && eqSnap[k]) { var e = player.eq[k]; Object.keys(e).forEach(function (f) { delete e[f]; }); Object.assign(e, eqSnap[k]); } });
      player.jsStone = js0; LL.coins = c0; try { saveGame(); } catch (e) {}
      alert('存檔失敗，已取消，精石和天梯幣都還在。'); return null;
    }
    refreshAll();
    return res;
  }
  function lockIt(it) { it.lock = true; delete it.junk; delete it.junkSince; delete it._ruleJunk; delete it._autoSellQty; }

  // ---------------- ✨ 洗煉 ----------------
  function openRefinePicker() {
    if (typeof player === 'undefined' || !player || !player.cls) return;
    openChooser(false, '✨ 洗煉', '挑一件裝備。每次花 💎' + REFINE_JS + '＋🗼' + REFINE_COIN + '，三條屬性全部重抽，<b>不能還原</b>。可以鎖 1 條（再 +' + LOCK_COIN + ' 幣）。<br>' +
      TIERS.map(function (t) { return '<span style="color:' + t.c + '">' + t.n + ' ' + t.w + '%</span>'; }).join('　'), openRefine);
  }
  function openRefine(t) {
    var cur = t, lockIdx = null, last = null;
    var w = shell('✨ 洗煉', '三條全部重抽，抽到詛咒會扣數值。洗過的會自動上鎖。', '<div data-act="body"></div>', '<button class="js-go" data-act="go">洗煉</button>');
    function draw(flash) {
      var it = cur.it, rf = rfOf(it), cost = REFINE_COIN + (lockIdx != null ? LOCK_COIN : 0);
      if (lockIdx != null && !rf[lockIdx]) lockIdx = null;
      var h = '<div class="js-res">' + nm(it) + ' <span class="js-src">（' + SRC[cur.src] + '）</span></div>';
      if (last && last.god) h += '<div class="js-god js-flash">🎰 神品！</div>';
      else if (last && last.epic) h += '<div class="js-god js-flash" style="color:#c084fc;text-shadow:0 0 10px #a855f7">💜 極品！</div>';
      h += rf.length ? rf.map(function (x, i) {
        return '<label class="js-line' + (lockIdx === i ? ' lock' : '') + (flash && lockIdx !== i ? ' js-flash' : '') + '"><span style="flex:1">' + lineHtml(x) + ' <span class="js-src">' + (TIERS[x.t] || TIERS[1]).n + '</span></span>' +
          '<span style="font-size:12px;color:#94a3b8;display:flex;gap:4px;align-items:center"><input type="checkbox" data-l="' + i + '"' + (lockIdx === i ? ' checked' : '') + '>🔒 鎖</span></label>';
      }).join('') : '<div class="js-sub" style="padding:8px 0">還沒洗過，第一次會直接抽出三條。</div>';
      h += '<div class="js-res" style="margin-top:8px">每次花費：💎 ' + REFINE_JS + '＋🗼 ' + cost + (lockIdx != null ? '（含鎖 1 條）' : '') + '</div>';
      w.querySelector('[data-act=body]').innerHTML = h;
      [].forEach.call(w.querySelectorAll('[data-l]'), function (c) { c.onchange = function () { var i = +c.getAttribute('data-l'); lockIdx = c.checked ? i : null; last = null; draw(); }; });
      setWallet(w);
      var go = w.querySelector('[data-act=go]'), can = stones() >= REFINE_JS && coins() >= cost;
      go.disabled = !can; go.textContent = can ? '✨ 洗煉' : (stones() < REFINE_JS ? '精石不夠' : '天梯幣不夠');
    }
    var busy = false;
    w.querySelector('[data-act=go]').onclick = function () {
      if (busy) return; busy = true;
      var cost = REFINE_COIN + (lockIdx != null ? LOCK_COIN : 0), li = lockIdx;
      var r = pay(REFINE_JS, cost, function () {
        var it = single(cur); if (!it) { alert('找不到這件裝備了。'); return null; }
        var nl = rollAll(rfOf(it), li);
        it.rf = nl; lockIt(it);
        return { it: it, rf: nl };
      });
      busy = false;
      if (!r) return;
      cur = { it: r.it, src: cur.src, slot: cur.slot };
      var bt = r.rf.reduce(function (m, x, i) { return i === li ? m : Math.max(m, x.t); }, -1);
      last = { god: bt >= 4, epic: bt === 3 };
      log('<span style="color:#a5f3fc;font-weight:700">✨ 洗煉 ' + nm(r.it) + '：' + r.rf.map(lineText).join('、') + '</span>');
      draw(true);
    };
    draw();
  }

  // ---------------- 🎲 骰武器 ----------------
  function openRerollPicker() {
    if (typeof player === 'undefined' || !player || !player.cls) return;
    openChooser(true, '🎲 骰武器', '挑一把武器。每次花 💎' + REROLL_JS + '＋🗼' + REROLL_COIN + '，小型／大型傷害重骰成原本的 60%～150%，<span style="color:#fbbf24">3% 神骰 180%～200%</span>，<b>不能還原</b>。', openReroll);
  }
  function openReroll(t) {
    var cur = t, last = null;
    var w = shell('🎲 骰武器', '骰過的武器會自動上鎖。', '<div data-act="body"></div>', '<button class="js-go" data-act="go">🎲 骰</button>');
    function draw(flash) {
      var it = cur.it, d = DB.items[it.id], rw = rwOf(it), s = rw ? rw.s : d.dmgS, l = rw ? rw.l : d.dmgL;
      var pct = Math.round(((s + l) / ((d.dmgS || 1) + (d.dmgL || 1))) * 100);
      var col = pct >= 180 ? '#fbbf24' : (pct >= 120 ? '#c084fc' : (pct >= 100 ? '#86efac' : '#f87171'));
      var h = '<div class="js-res">' + nm(it) + ' <span class="js-src">（' + SRC[cur.src] + '）</span></div>';
      if (last && last.god) h += '<div class="js-god js-flash">🎰 神骰！×' + last.m.toFixed(2) + '</div>';
      h += '<div class="js-res' + (flash ? ' js-flash' : '') + '" style="margin-top:6px;font-size:15px">小型傷害 <b>' + s + '</b>　大型傷害 <b>' + l + '</b>　<b style="color:' + col + '">' + pct + '%</b></div>' +
        '<div class="js-sub">原本：小型 ' + d.dmgS + '／大型 ' + d.dmgL + (last ? '　上一把：小型 ' + last.ps + '／大型 ' + last.pl : '') + '</div>' +
        '<div class="js-res" style="margin-top:8px">每次花費：💎 ' + REROLL_JS + '＋🗼 ' + REROLL_COIN + '</div>';
      w.querySelector('[data-act=body]').innerHTML = h;
      setWallet(w);
      var go = w.querySelector('[data-act=go]'), can = stones() >= REROLL_JS && coins() >= REROLL_COIN;
      go.disabled = !can; go.textContent = can ? '🎲 骰' : (stones() < REROLL_JS ? '精石不夠' : '天梯幣不夠');
    }
    var busy = false;
    w.querySelector('[data-act=go]').onclick = function () {
      if (busy) return; busy = true;
      var r = pay(REROLL_JS, REROLL_COIN, function () {
        var it = single(cur); if (!it) { alert('找不到這把武器了。'); return null; }
        var d = DB.items[it.id], old = rwOf(it), ps = old ? old.s : d.dmgS, pl = old ? old.l : d.dmgL;
        var x = rollWeapon(d);
        if (x.s === d.dmgS && x.l === d.dmgL) delete it.rw; else it.rw = { s: x.s, l: x.l };
        lockIt(it);
        return { it: it, x: x, ps: ps, pl: pl };
      });
      busy = false;
      if (!r) return;
      cur = { it: r.it, src: cur.src, slot: cur.slot };
      last = { god: r.x.god, m: r.x.m, ps: r.ps, pl: r.pl };
      log('<span style="color:#fbbf24;font-weight:700">🎲 骰武器 ' + nm(r.it) + '：小型 ' + r.x.s + '／大型 ' + r.x.l + (r.x.god ? '（神骰！）' : '') + '</span>');
      draw(true);
    };
    draw();
  }

  // ---------------- 入口 ----------------
  function openMenu() {
    var w = shell('💎 精石', '分解用不到的裝備換精石，再拿精石去洗煉裝備、骰武器。',
      '<button class="js-row" data-act="b" style="padding:12px 10px"><b style="color:#67e8f9">💎 分解成精石</b><span class="js-r">裝備、遺物換精石</span></button>' +
      '<button class="js-row" data-act="r" style="padding:12px 10px"><b style="color:#a5f3fc">✨ 洗煉</b><span class="js-r">💎' + REFINE_JS + '＋🗼' + REFINE_COIN + '　三條屬性重抽</span></button>' +
      '<button class="js-row" data-act="w" style="padding:12px 10px"><b style="color:#fbbf24">🎲 骰武器</b><span class="js-r">💎' + REROLL_JS + '＋🗼' + REROLL_COIN + '　武器傷害重骰</span></button>');
    w.querySelector('[data-act=b]').onclick = openBreak;
    w.querySelector('[data-act=r]').onclick = openRefinePicker;
    w.querySelector('[data-act=w]').onclick = openRerollPicker;
  }
  window.afkJingshi.open = openMenu; window.afkJingshi.openBreak = openBreak; window.afkJingshi.openRefine = openRefinePicker; window.afkJingshi.openReroll = openRerollPicker;

  // 潘朵拉黑市：上面加一排按鈕
  if (typeof window.renderPandoraGacha === 'function') {
    var _pg = window.renderPandoraGacha;
    window.renderPandoraGacha = function (div) {
      var r = _pg.apply(this, arguments);
      try {
        if (div && !div.querySelector('.afk-js-bar')) {
          css();
          var bar = document.createElement('div'); bar.className = 'afk-js-bar';
          bar.innerHTML = '<button data-a="b">💎 分解成精石</button><button data-a="r">✨ 洗煉</button><button data-a="w">🎲 骰武器</button>';
          bar.querySelector('[data-a=b]').onclick = openBreak;
          bar.querySelector('[data-a=r]').onclick = openRefinePicker;
          bar.querySelector('[data-a=w]').onclick = openRerollPicker;
          div.insertBefore(bar, div.firstChild);
        }
      } catch (e) {}
      return r;
    };
  }
  css();
})();
