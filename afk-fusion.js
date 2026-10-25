/*
 * afk-fusion.js — 🔥 遺物融合＋⚔️ 裝備融合（下半部）（Ken 10/20：「要設計融合系統 不然打太多好東西只是不夠強就都是廢物了」「現在是太多遺物了」）
 *
 * 規則：
 *   挑一件主遺物（身上／背包／在村莊時也可以是倉庫），拿其他遺物餵它換融合點數：同名 10 點、不同名 2 點。
 *   點數夠就升級 🔥1 → 🔥10；從 🔥N 升到 🔥N+1 要 (N+1)×10 點（滿級共 550 點），滿級就停，不會多吃。
 *   每一級：武器 額外傷害 +1、命中 +1；防具 AC −1；飾品 AC −1、MR +1（副手武器跟核心一樣不算能力）。
 *   不會被吃：身上穿的、上鎖的、已經融合過的；有詞綴的預設也吃（可取消勾選）；預設每種留 1 個（同名的主遺物本身就算留下的那個）。
 *
 * 資料：物品實例上的 fz（等級 0~10）、fzx（往下一級累積的點數）。
 *   ⚠️ itemSig 一定要含 fz，否則 🔥3 的遺物會跟 🔥0 的同名遺物疊成一堆（等級被吃掉或被複製）。
 *   能力、名字、簽章這三個包裝不受開關影響（關掉開關只藏入口），不然關掉後已融合的遺物會亂疊。
 */
(function () {
  'use strict';
  if (typeof DB === 'undefined' || !DB.items) return;

  var MAX = 10, P_SAME = 10, P_OTHER = 2;
  function need(lv) { return (lv + 1) * 10; }
  function isRelicDef(d) { return !!(d && d.relic && (d.type === 'wpn' || d.type === 'arm' || d.type === 'acc') && d.slot !== 'petwpn' && d.slot !== 'petarm' && !d.isArrow); }
  function lvOf(it) { return Math.max(0, Math.min(MAX, Math.floor(Number(it && it.fz) || 0))); }
  function kindOf(d) { return d.type === 'wpn' ? 'wpn' : (d.type === 'arm' ? 'arm' : 'acc'); }
  function perLevelText(d) {
    var k = kindOf(d);
    return k === 'wpn' ? '額外傷害 +1、命中 +1' : (k === 'arm' ? 'AC −1' : 'AC −1、MR +1');
  }
  function bonusText(d, lv) {
    var k = kindOf(d);
    if (!lv) return '尚未融合';
    return k === 'wpn' ? '額外傷害 +' + lv + '、命中 +' + lv : (k === 'arm' ? 'AC −' + lv : 'AC −' + lv + '、MR +' + lv);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ===== 簽章：含融合等級 =====
  if (typeof window.itemSig === 'function') {
    var _sig = window.itemSig;
    window.itemSig = function (it) { var s = _sig.apply(this, arguments); var lv = lvOf(it); return lv || (it && it.fzx) ? s + '|fz' + lv + '.' + (Number(it.fzx) || 0) : s; };
  }

  // ===== 名字：🔥N 前綴 =====
  if (typeof window.getItemFullName === 'function') {
    var _name = window.getItemFullName;
    window.getItemFullName = function (it) {
      var h = _name.apply(this, arguments), lv = lvOf(it);
      return lv ? '<span class="afk-fz-tag">🔥' + lv + '</span> ' + h : h;
    };
  }

  // ===== 能力：每級加成（重算後補上，跟鷹之魔眼同做法） =====
  if (typeof window.recomputeStats === 'function') {
    var _rs = window.recomputeStats;
    window.recomputeStats = function () {
      var r = _rs.apply(this, arguments);
      try {
        var d = player && player.d; if (!d || !player.eq) return r;
        for (var k in player.eq) {
          if (k === 'offwpn') continue;   // 核心：副手武器不走能力加成
          var e = player.eq[k], lv = lvOf(e); if (!lv) continue;
          var dd = DB.items[e.id]; if (!isRelicDef(dd)) continue;
          var kind = kindOf(dd);
          if (kind === 'wpn') { d.extraDmg = (d.extraDmg || 0) + lv; d.extraHit = (d.extraHit || 0) + lv; }
          else if (kind === 'arm') d.ac = (d.ac || 0) - lv;
          else { d.ac = (d.ac || 0) - lv; d.mr = (d.mr || 0) + lv; }
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
        var d = it && DB.items[it.id];
        if (isRelicDef(d) && typeof h === 'string') {
          var lv = lvOf(it);
          h += '<br><span class="text-orange-300 font-bold">🔥 遺物融合 ' + lv + '／' + MAX + '：' + bonusText(d, lv) + '</span>' +
            (lv < MAX ? '<br><span class="text-slate-400">下一級還要 ' + (need(lv) - (Number(it.fzx) || 0)) + ' 點（同名遺物 10 點、其他遺物 2 點）</span>' : '');
        }
      } catch (e) {}
      return h;
    };
  }

  window.afkFusion = { lv: lvOf, need: need, isRelicDef: isRelicDef, P_SAME: P_SAME, P_OTHER: P_OTHER, MAX: MAX };

  // ===== 以下是入口與介面（開關只管這段） =====
  if (window.AFK_TOGGLES && !AFK_TOGGLES.enabled('fusion')) return;

  function inTown() { try { return !!(mapState && mapState.current && String(mapState.current).indexOf('town_') === 0); } catch (e) { return false; } }
  function wh() { try { return inTown() && typeof loadWarehouse === 'function' ? loadWarehouse() : null; } catch (e) { return null; } }
  function nm(it) { try { return window.getItemFullName(it); } catch (e) { return esc((DB.items[it.id] || {}).n || it.id); } }
  function plainName(id) { return (DB.items[id] || {}).n || id; }
  function hasAffix(it) { return !!(it.bless || it.anc || it.attr || it.attrMagic); }
  var eatAffix = true;   // 有祝福／遠古詞綴的也吃（Ken 的倉庫遺物 2/3 都有詞綴，不吃就清不掉）；介面可以取消
  function edible(it) { var d = it && DB.items[it.id]; return isRelicDef(d) && !it.lock && (eatAffix || !hasAffix(it)) && !lvOf(it) && !(Number(it.fzx) > 0) && !it.gw; }

  // 主遺物候選：身上＋背包＋（村莊）倉庫
  function targets() {
    var out = [], w = wh();
    Object.keys(player.eq || {}).forEach(function (k) { var e = player.eq[k]; if (e && isRelicDef(DB.items[e.id])) out.push({ it: e, src: 'eq', slot: k }); });
    (player.inv || []).forEach(function (i) { if (i && isRelicDef(DB.items[i.id])) out.push({ it: i, src: 'inv' }); });
    if (w) (w.items || []).forEach(function (i) { if (i && isRelicDef(DB.items[i.id])) out.push({ it: i, src: 'wh' }); });
    return out;
  }
  // 素材：依物品 id 分組 {id, inv:[stack...], wh:[stack...], total}
  function materials(target, keepOne) {
    var g = {}, w = wh();
    function add(i, src) {
      if (!edible(i)) return;
      var c = i.cnt || 1;
      if (i.uid === target.uid) c -= 1;   // 主遺物在一疊裡：同疊其他的還是可以吃
      if (c <= 0) return;
      var x = g[i.id] || (g[i.id] = { id: i.id, inv: [], wh: [], total: 0 });
      x[src].push(i); x.total += c;
    }
    (player.inv || []).forEach(function (i) { if (i) add(i, 'inv'); });
    if (w) (w.items || []).forEach(function (i) { if (i) add(i, 'wh'); });
    var list = Object.keys(g).map(function (id) {
      var x = g[id], same = id === target.id;
      x.same = same; x.pts = same ? P_SAME : P_OTHER;
      // 每種留 1 個：同名的主遺物本身就是留下的那個，不用再留
      x.avail = Math.max(0, x.total - (keepOne && !same ? 1 : 0));
      return x;
    }).filter(function (x) { return x.avail > 0; });
    list.sort(function (a, b) { return (b.same - a.same) || (b.avail - a.avail) || (plainName(a.id) < plainName(b.id) ? -1 : 1); });
    return list;
  }
  // 依勾選算要吃幾個（同名優先，滿級就停）
  function plan(target, list, picked) {
    var lv = lvOf(target), x = Number(target.fzx) || 0, eat = [], total = 0;
    for (var i = 0; i < list.length && lv < MAX; i++) {
      var m = list[i]; if (!picked[m.id]) continue;
      var n = 0;
      while (n < m.avail && lv < MAX) { n++; x += m.pts; while (lv < MAX && x >= need(lv)) { x -= need(lv); lv++; } }
      if (n) { eat.push({ m: m, n: n }); total += n; }
    }
    if (lv >= MAX) x = 0;
    return { lv: lv, x: x, eat: eat, total: total };
  }

  // ===== 介面 =====
  var BOX = 'afk-fz-modal';
  function css() {
    if (document.getElementById('afk-fz-css')) return;
    var s = document.createElement('style'); s.id = 'afk-fz-css';
    s.textContent = [
      '.afk-fz-tag{color:#fb923c;font-weight:800}',
      '#' + BOX + '{position:fixed;inset:0;z-index:2147483000;background:rgba(2,6,23,.72);display:flex;align-items:center;justify-content:center;padding:16px}',
      '#' + BOX + ' .fz-card{background:#0b1220;border:1px solid #7c2d12;border-radius:10px;max-width:460px;width:100%;max-height:88vh;display:flex;flex-direction:column;color:#e2e8f0;box-shadow:0 10px 40px rgba(0,0,0,.6)}',
      '#' + BOX + ' .fz-head{padding:12px 14px 8px;border-bottom:1px solid #1e293b}',
      '#' + BOX + ' .fz-title{font-weight:800;font-size:16px;color:#fdba74}',
      '#' + BOX + ' .fz-sub{font-size:12px;color:#94a3b8;margin-top:2px;line-height:1.5}',
      '#' + BOX + ' .fz-body{padding:8px 14px;overflow:auto;flex:1}',
      '#' + BOX + ' .fz-foot{padding:10px 14px;border-top:1px solid #1e293b;display:flex;gap:8px}',
      '#' + BOX + ' .fz-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;font-size:14px}',
      '#' + BOX + ' button.fz-row:hover{background:#111c33;border-color:#334155}',
      '#' + BOX + ' .fz-row .fz-r{margin-left:auto;font-size:12px;color:#94a3b8;white-space:nowrap}',
      '#' + BOX + ' .fz-src{font-size:11px;color:#64748b;white-space:nowrap}',
      '#' + BOX + ' .fz-bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin-top:6px}',
      '#' + BOX + ' .fz-bar i{display:block;height:100%;background:#ea580c}',
      '#' + BOX + ' .fz-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 6px;font-size:12px}',
      '#' + BOX + ' .fz-tools button{padding:3px 8px;border:1px solid #334155;border-radius:5px;background:#0f172a;color:#cbd5e1}',
      '#' + BOX + ' .fz-res{font-size:13px;line-height:1.6}',
      '#' + BOX + ' .fz-go{flex:1;padding:9px;border-radius:6px;font-weight:800;background:#c2410c;color:#fff7ed;border:1px solid #ea580c}',
      '#' + BOX + ' .fz-go[disabled]{background:#1e293b;color:#64748b;border-color:#334155}',
      '#' + BOX + ' .fz-x{padding:9px 14px;border-radius:6px;background:#1e293b;color:#cbd5e1;border:1px solid #334155}',
      '#' + BOX + ' input[type=search]{width:100%;padding:6px 8px;border-radius:6px;background:#020617;border:1px solid #334155;color:#e2e8f0;font-size:14px;margin:4px 0 6px}',
      '#afk-fz-btn{grid-column:1/-1;background:linear-gradient(135deg,#431407 0%,#9a3412 30%,#431407 55%,#c2410c 80%,#3b1206 100%);color:#ffedd5;border-color:#ea580c}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  }
  function close() { var w = document.getElementById(BOX); if (w) w.remove(); }
  function shell(title, sub, body, foot) {
    close(); css();
    var w = document.createElement('div'); w.id = BOX;
    w.innerHTML = '<div class="fz-card"><div class="fz-head"><div class="fz-title">' + title + '</div>' + (sub ? '<div class="fz-sub">' + sub + '</div>' : '') +
      '</div><div class="fz-body">' + body + '</div><div class="fz-foot">' + (foot || '') + '<button class="fz-x" data-act="close">關閉</button></div></div>';
    w.addEventListener('click', function (e) { if (e.target === w) close(); });
    w.querySelector('[data-act=close]').onclick = close;
    document.body.appendChild(w);
    return w;
  }
  var SRC = { eq: '身上', inv: '背包', wh: '倉庫' };

  function openPicker() {
    if (typeof player === 'undefined' || !player || !player.cls) return;
    var town = inTown(), all = targets(), q = '';
    var keep = {};   // 每種只列一次「代表」：身上的全列，背包／倉庫同 id 同等級只列一筆
    var rows = all.filter(function (o) {
      if (o.src === 'eq') return true;
      var key = o.it.id + '|' + lvOf(o.it) + '|' + (Number(o.it.fzx) || 0) + '|' + (hasAffix(o.it) ? itemSigSafe(o.it) : '');
      if (keep[key]) return false; keep[key] = 1; return true;
    });
    var cnt = {}; all.forEach(function (o) { if (edible(o.it)) cnt[o.it.id] = (cnt[o.it.id] || 0) + (o.it.cnt || 1); });
    rows.sort(function (a, b) { return ((b.src === 'eq') - (a.src === 'eq')) || (lvOf(b.it) - lvOf(a.it)) || ((cnt[b.it.id] || 0) - (cnt[a.it.id] || 0)); });
    var sub = '挑一件要升級的遺物。' + (town ? '倉庫裡的遺物也算。' : '目前不在村莊，只看得到身上和背包；回村莊就能直接用倉庫的遺物。');
    var w = shell('🔥 遺物融合', sub, '<input type="search" placeholder="搜尋遺物名稱" data-act="q"><div data-act="list"></div>');
    function draw() {
      var list = rows.filter(function (o) { return !q || plainName(o.it.id).indexOf(q) >= 0; });
      w.querySelector('[data-act=list]').innerHTML = list.length ? list.map(function (o, i) {
        var same = cnt[o.it.id] || 0; if (edible(o.it)) same -= 1;
        return '<button class="fz-row" data-i="' + rows.indexOf(o) + '"><span class="fz-src">' + SRC[o.src] + '</span><span>' + nm(Object.assign({}, o.it, { cnt: 1 })) + '</span>' +
          '<span class="fz-r">' + (lvOf(o.it) >= MAX ? '已滿級' : (same > 0 ? '同名 ' + same + ' 個' : '')) + '</span></button>';
      }).join('') : '<div class="fz-sub" style="padding:10px 0">' + (rows.length ? '找不到符合的遺物。' : '身上和背包都沒有遺物' + (town ? '，倉庫也沒有。' : '。回村莊可以用倉庫的遺物。')) + '</div>';
      [].forEach.call(w.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { openFeed(rows[+b.getAttribute('data-i')]); }; });
    }
    w.querySelector('[data-act=q]').oninput = function (e) { q = e.target.value.trim(); draw(); };
    draw();
  }
  function itemSigSafe(it) { try { return window.itemSig(it); } catch (e) { return it.uid; } }

  function openFeed(t) {
    var target = t.it, d = DB.items[target.id];
    if (lvOf(target) >= MAX) { shell('🔥 遺物融合', '', '<div class="fz-res">' + nm(Object.assign({}, target, { cnt: 1 })) + ' 已經是 🔥' + MAX + ' 滿級了。</div>'); return; }
    var keepOne = true, picked = {}, list = materials(target, keepOne);
    list.forEach(function (m) { if (m.same) picked[m.id] = true; });   // 預設先勾同名
    var w = shell('🔥 融合：' + esc(plainName(target.id)), '同名遺物 10 點、其他遺物 2 點。每一級：' + perLevelText(d) + '。<br>不會被吃：身上穿的、上鎖的、融合過的。',
      '<div data-act="head"></div><div class="fz-tools"><button data-act="same">全選同名</button><button data-act="all">全選</button><button data-act="none">全不選</button>' +
      '<label style="margin-left:auto;display:flex;gap:4px;align-items:center;color:#cbd5e1"><input type="checkbox" data-act="keep" checked>每種留 1 個</label>' +
      '<label style="display:flex;gap:4px;align-items:center;color:#cbd5e1"><input type="checkbox" data-act="aff"' + (eatAffix ? ' checked' : '') + '>有詞綴的也吃</label></div><div data-act="list"></div>',
      '<button class="fz-go" data-act="go" disabled>融合</button>');
    function draw() {
      var lv = lvOf(target), x = Number(target.fzx) || 0, p = plan(target, list, picked);
      var pct = p.lv >= MAX ? 100 : Math.floor(p.x / need(p.lv) * 100);
      w.querySelector('[data-act=head]').innerHTML = '<div class="fz-res">' + nm(Object.assign({}, target, { cnt: 1 })) + ' <span class="fz-src">（' + SRC[t.src] + '）</span><br>' +
        '目前 🔥' + lv + '（' + x + '／' + need(lv) + '）：' + bonusText(d, lv) + '<br>' +
        (p.total ? '<b class="text-orange-300">吃掉 ' + p.total + ' 個 → 🔥' + p.lv + (p.lv < MAX ? '（' + p.x + '／' + need(p.lv) + '）' : '（滿級）') + '：' + bonusText(d, p.lv) + '</b>' : '<span class="fz-sub">勾選要吃掉的遺物</span>') +
        '</div><div class="fz-bar"><i style="width:' + pct + '%"></i></div>';
      var used = {}; p.eat.forEach(function (e) { used[e.m.id] = e.n; });
      w.querySelector('[data-act=list]').innerHTML = list.length ? list.map(function (m, i) {
        return '<label class="fz-row" style="cursor:pointer"><input type="checkbox" data-m="' + i + '"' + (picked[m.id] ? ' checked' : '') + '>' +
          '<span>' + esc(plainName(m.id)) + (m.same ? ' <span class="text-orange-300" style="font-size:11px">同名</span>' : '') + '</span>' +
          '<span class="fz-r">' + (used[m.id] != null ? '吃 ' + used[m.id] + '／' : '') + m.avail + ' 個 · ' + m.pts + ' 點</span></label>';
      }).join('') : '<div class="fz-sub" style="padding:10px 0">沒有可以吃的遺物' + (inTown() ? '' : '（回村莊可以用倉庫裡的）') + '。</div>';
      [].forEach.call(w.querySelectorAll('[data-m]'), function (c) { c.onchange = function () { var m = list[+c.getAttribute('data-m')]; if (c.checked) picked[m.id] = true; else delete picked[m.id]; draw(); }; });
      var go = w.querySelector('[data-act=go]'); go.disabled = !p.total; go.textContent = p.total ? '融合（吃掉 ' + p.total + ' 個）' : '融合';
    }
    w.querySelector('[data-act=same]').onclick = function () { picked = {}; list.forEach(function (m) { if (m.same) picked[m.id] = true; }); draw(); };
    w.querySelector('[data-act=all]').onclick = function () { list.forEach(function (m) { picked[m.id] = true; }); draw(); };
    w.querySelector('[data-act=none]').onclick = function () { picked = {}; draw(); };
    w.querySelector('[data-act=keep]').onchange = function (e) { keepOne = e.target.checked; list = materials(target, keepOne); draw(); };
    w.querySelector('[data-act=aff]').onchange = function (e) { eatAffix = e.target.checked; list = materials(target, keepOne); draw(); };
    var busy = false;
    w.querySelector('[data-act=go]').onclick = function () {
      if (busy) return; busy = true;
      var r = execute(t, list, picked);
      busy = false;
      if (!r) return;
      close();
      shell('🔥 融合完成', '', '<div class="fz-res">' + nm(Object.assign({}, r.item, { cnt: 1 })) + '<br>吃掉 ' + r.total + ' 個遺物，🔥' + r.from + ' → 🔥' + r.to + '<br>' + bonusText(d, r.to) + '</div>',
        '<button class="fz-go" data-act="again">繼續融合</button>');
      var again = document.querySelector('#' + BOX + ' [data-act=again]'); if (again) again.onclick = openPicker;
    };
    draw();
  }

  // 真正執行：重新讀一次背包／倉庫（介面開著時可能有變動），照計畫扣素材、改主遺物，再走跟倉庫一樣的存檔交易
  function execute(t, list, picked) {
    var p = plan(t.it, list, picked); if (!p.total) return null;
    var useWh = inTown() && (t.src === 'wh' || p.eat.some(function (e) { return e.m.wh.length; }));
    if ((t.src === 'wh' || useWh) && !inTown()) { alert('離開村莊了，倉庫不能用。'); return null; }
    var w = useWh ? loadWarehouse() : null;
    var snap = typeof whTxnSnapshot === 'function' ? whTxnSnapshot() : { inv: JSON.parse(JSON.stringify(player.inv || [])), gold: player.gold };
    var eqBefore = t.src === 'eq' ? { fz: t.it.fz, fzx: t.it.fzx } : null;

    // 找到「現在的」主遺物（背包／倉庫是從新讀的資料裡用 uid 找）
    var bag = player.inv, target;
    if (t.src === 'eq') target = t.it;
    else {
      var arr = t.src === 'wh' ? (w && w.items) : bag;
      var idx = (arr || []).findIndex(function (i) { return i && i.uid === t.it.uid; });
      if (idx < 0) { alert('找不到這件遺物了，請重新打開融合。'); return null; }
      target = arr[idx];
      if ((target.cnt || 1) > 1) {   // 一疊裡拆一件出來當主遺物
        target.cnt -= 1;
        var single = Object.assign({}, target, { cnt: 1, uid: window.uid() });
        delete single.junk; delete single.junkSince; delete single._autoSellQty; delete single._ruleJunk;
        arr.push(single); target = single;
      }
    }
    // 扣素材：先背包、後倉庫；每個素材 id 只扣計畫的數量
    var eaten = 0, pts = 0;
    function takeFrom(arr, id, n, per) {   // 先吃沒詞綴的，有詞綴的留到最後（「每種留 1 個」留下的會是比較好的那個）
      for (var pass = 0; pass < 2 && n > 0; pass++) {
        for (var i = arr.length - 1; i >= 0 && n > 0; i--) {
          var s = arr[i]; if (!s || s.id !== id || s.uid === target.uid || !edible(s) || (pass === 0) === hasAffix(s)) continue;
          var c = s.cnt || 1, k = Math.min(c, n);
          if (k >= c) arr.splice(i, 1); else s.cnt = c - k;
          n -= k; eaten += k; pts += k * per;
        }
      }
      return n;
    }
    p.eat.forEach(function (e) {
      var left = takeFrom(bag, e.m.id, e.n, e.m.pts);
      if (left > 0 && w) left = takeFrom(w.items, e.m.id, left, e.m.pts);
    });
    // 實際吃到的數量可能比計畫少（介面開著時被賣掉／移走）→ 照實際數量重算等級
    var lv = lvOf(target), x = Number(target.fzx) || 0, from = lv;
    x += pts; while (lv < MAX && x >= need(lv)) { x -= need(lv); lv++; }
    if (lv >= MAX) x = 0;
    if (!eaten) { if (typeof whTxnRestore === 'function') whTxnRestore(snap); alert('素材已經不在了，請重新打開融合。'); return null; }
    target.fz = lv; target.fzx = x;
    target.lock = true; delete target.junk; delete target.junkSince; delete target._ruleJunk; delete target._autoSellQty;   // 融合過的自動上鎖，免得被自動販賣

    var ok;
    if (w) ok = whTxnCommit(w, snap);
    else { ok = typeof saveGame === 'function' && saveGame(); if (!ok && typeof whTxnRestore === 'function') { whTxnRestore(snap); try { saveGame(); } catch (e) {} } }
    if (!ok) {
      if (eqBefore) { if (eqBefore.fz === undefined) delete t.it.fz; else t.it.fz = eqBefore.fz; if (eqBefore.fzx === undefined) delete t.it.fzx; else t.it.fzx = eqBefore.fzx; try { saveGame(); } catch (e) {} }
      alert('存檔失敗，融合已取消，東西都還在。'); return null;
    }
    try { if (typeof window.calcStats === 'function') window.calcStats(); } catch (e) {}
    try { if (typeof window.renderTabs === 'function') window.renderTabs(true); } catch (e) {}
    try { if (typeof window.updateUI === 'function') window.updateUI(); } catch (e) {}
    try { var ic = document.getElementById('interaction-content'); if (useWh && ic && ic.querySelector('#wh-store-list') && typeof renderWarehouseNPC === 'function') renderWarehouseNPC(ic); } catch (e) {}
    try { if (typeof logSys === 'function') logSys('<span class="text-orange-300 font-bold">🔥 遺物融合：' + nm(Object.assign({}, target, { cnt: 1 })) + ' 吃掉 ' + eaten + ' 個遺物（🔥' + from + ' → 🔥' + lv + '）</span>'); } catch (e) {}
    return { item: target, total: eaten, from: from, to: lv };
  }

  // =====================================================================
  // ⚔️ 裝備融合（Ken 10/20「那兩種融合都上吧」）：主裝備吃掉一件同部位的裝備
  //   強化值取高的；一樣高再 +1（必成、不超過上限）。祝福／遠古／屬性詞綴每項自己選留原本或換素材的，預設選評分最高的組合。
  //   不算：遺物、魔眼、寵物裝、箭、無法強化的、巨靈願望戒指；上鎖的、穿在身上的不能當素材。手續費 10 萬 ×（結果強化值＋1）。
  // =====================================================================
  var GROUPS = [
    { k: 'bless', n: '祝福', f: ['bless'] },
    { k: 'anc', n: '遠古詞綴', f: ['anc'] },
    { k: 'attr', n: '屬性詞綴', f: ['attr', 'attrMagic', 'attrMagicStar'] }
  ];
  function isGearDef(d) { return !!d && (d.type === 'wpn' || d.type === 'arm' || d.type === 'acc') && !d.relic && !d.noEnhance && d.slot !== 'petwpn' && d.slot !== 'petarm' && d.slot !== 'eye' && !d.isArrow; }
  function gKey(d) { return d.type === 'wpn' ? 'wpn' : d.type + ':' + (d.slot || ''); }
  function gs(it) { try { return typeof window.afkGearScore === 'function' ? (window.afkGearScore(it) || 0) : 0; } catch (e) { return 0; } }
  function capOf(d) { try { return typeof enhanceCap === 'function' ? enhanceCap(d) : (d.maxEn || 10); } catch (e) { return 10; } }
  function gearEdible(it) { var d = it && DB.items[it.id]; return isGearDef(d) && !it.lock && !it.gw; }
  function affixLabel(it, k) {
    try {
      if (k === 'bless') return it.bless ? blessName(it.bless).trim() : '無';
      if (k === 'anc') return it.anc ? ancName(it.anc).trim() : '無';
      var a = getAttrAffix(it.attr); return a ? a.n.trim() + (it.attrMagic ? '＋屬性魔法' : '') : '無';
    } catch (e) { return '?'; }
  }
  function sameGroup(a, b, k) { return GROUPS.filter(function (g) { return g.k === k; })[0].f.every(function (f) { return (a[f] || false) === (b[f] || false); }); }
  // 組出結果（choice[k] = 'me' | 'mat'）；不合法回 null
  function fuseResult(t, m, choice) {
    var d = DB.items[t.id], cap = capOf(d), te = Number(t.en) || 0, me = Number(m.en) || 0;
    var en = te === me ? Math.min(cap, te + 1) : Math.min(cap, Math.max(te, me));
    var r = Object.assign({}, t, { en: en, cnt: 1 });
    GROUPS.forEach(function (g) {
      if (choice[g.k] !== 'mat') return;
      g.f.forEach(function (f) { if (m[f] === undefined) delete r[f]; else r[f] = m[f]; });
    });
    if (r.attr) {   // 屬性第 4 階要 +10、第 5 階要 +11；屬性魔法只能掛在第 5 階、而且武器本身不能有觸發技能
      var a = null; try { a = getAttrAffix(r.attr); } catch (e) {}
      if (a && ((a.tier === 4 && en < 10) || (a.tier === 5 && en < 11))) return null;
      if (r.attrMagic) { var bad = !a || a.tier !== 5; try { if (!bad && typeof weaponHasBaseTriggeredSkill === 'function' && weaponHasBaseTriggeredSkill(d, t.id)) bad = true; } catch (e) {} if (bad) { delete r.attrMagic; delete r.attrMagicStar; } }
    }
    return r;
  }
  function diffGroups(t, m) { return GROUPS.filter(function (g) { return !sameGroup(t, m, g.k) && (g.k !== 'attr' || DB.items[t.id].type === 'wpn'); }); }
  function bestChoice(t, m) {
    var gsList = diffGroups(t, m), best = null;
    for (var mask = 0; mask < (1 << gsList.length); mask++) {
      var c = {}; gsList.forEach(function (g, i) { c[g.k] = (mask >> i) & 1 ? 'mat' : 'me'; });
      var r = fuseResult(t, m, c); if (!r) continue;
      var v = gs(r); if (!best || v > best.v) best = { c: c, r: r, v: v };
    }
    return best;
  }
  function fee(r) { return 100000 * ((Number(r.en) || 0) + 1); }

  function gearList() {
    var out = [], w = wh(), seen = {};
    Object.keys(player.eq || {}).forEach(function (k) { var e = player.eq[k]; if (e && isGearDef(DB.items[e.id]) && !e.gw) out.push({ it: e, src: 'eq', slot: k }); });
    function add(i, src) { if (!i || !isGearDef(DB.items[i.id]) || i.gw) return; var key = src + '|' + itemSigSafe(i); if (seen[key]) return; seen[key] = 1; out.push({ it: i, src: src }); }
    (player.inv || []).forEach(function (i) { add(i, 'inv'); });
    if (w) (w.items || []).forEach(function (i) { add(i, 'wh'); });
    return out;
  }

  function openGearPicker() {
    if (typeof player === 'undefined' || !player || !player.cls) return;
    var town = inTown(), rows = gearList(), q = '';
    rows.forEach(function (o) { o.v = gs(o.it); });
    rows.sort(function (a, b) { return ((b.src === 'eq') - (a.src === 'eq')) || (b.v - a.v); });
    var w = shell('⚔️ 裝備融合', '挑一件主裝備，再挑一件同部位的裝備吃掉，強化值和詞綴可以搬過來。' + (town ? '倉庫裡的裝備也算。' : '回村莊就能用倉庫裡的裝備。'),
      '<input type="search" placeholder="搜尋裝備名稱" data-act="q"><div data-act="list"></div>');
    function draw() {
      var list = rows.filter(function (o) { return !q || plainName(o.it.id).indexOf(q) >= 0; }).slice(0, 200);
      w.querySelector('[data-act=list]').innerHTML = list.length ? list.map(function (o) {
        return '<button class="fz-row" data-i="' + rows.indexOf(o) + '"><span class="fz-src">' + SRC[o.src] + '</span><span>' + nm(Object.assign({}, o.it, { cnt: 1 })) + '</span><span class="fz-r">⭐ ' + o.v.toLocaleString() + '</span></button>';
      }).join('') : '<div class="fz-sub" style="padding:10px 0">找不到裝備。</div>';
      [].forEach.call(w.querySelectorAll('[data-i]'), function (b) { b.onclick = function () { openGearMat(rows[+b.getAttribute('data-i')]); }; });
    }
    w.querySelector('[data-act=q]').oninput = function (e) { q = e.target.value.trim(); draw(); };
    draw();
  }

  function openGearMat(t) {
    var target = t.it, d = DB.items[target.id], key = gKey(d), base = gs(target), w0 = wh(), cands = [], seen = {};
    function add(i, src) {
      if (!gearEdible(i) || i.uid === target.uid && (i.cnt || 1) < 2) return;
      var dd = DB.items[i.id]; if (gKey(dd) !== key) return;
      var sk = src + '|' + itemSigSafe(i); if (seen[sk]) return; seen[sk] = 1;
      var b = bestChoice(target, i); if (!b || b.v <= base) return;
      cands.push({ it: i, src: src, best: b });
    }
    (player.inv || []).forEach(function (i) { add(i, 'inv'); });
    if (w0) (w0.items || []).forEach(function (i) { add(i, 'wh'); });
    cands.sort(function (a, b) { return b.best.v - a.best.v; });
    var w = shell('⚔️ 融合：' + esc(plainName(target.id)), nm(Object.assign({}, target, { cnt: 1 })) + '（' + SRC[t.src] + '）⭐ ' + base.toLocaleString() + '<br>只列出吃了會變強的素材，分數是能組出來的最好結果。',
      cands.length ? cands.slice(0, 150).map(function (c, i) {
        return '<button class="fz-row" data-c="' + i + '"><span class="fz-src">' + SRC[c.src] + '</span><span>' + nm(Object.assign({}, c.it, { cnt: 1 })) + '</span><span class="fz-r">⭐ ' + c.best.v.toLocaleString() + '（+' + (c.best.v - base).toLocaleString() + '）</span></button>';
      }).join('') : '<div class="fz-sub" style="padding:10px 0">沒有吃了會變強的同部位裝備' + (inTown() ? '' : '（回村莊可以連倉庫一起找）') + '。</div>');
    [].forEach.call(w.querySelectorAll('[data-c]'), function (b) { b.onclick = function () { openGearPreview(t, cands[+b.getAttribute('data-c')]); }; });
  }

  function openGearPreview(t, c) {
    var target = t.it, mat = c.it, choice = Object.assign({}, c.best.c), base = gs(target);
    var groups = diffGroups(target, mat);
    var w = shell('⚔️ 融合預覽', '素材會被吃掉；主裝備留下。', '<div data-act="body"></div>', '<button class="fz-go" data-act="go">融合</button>');
    function draw() {
      var r = fuseResult(target, mat, choice);
      var te = Number(target.en) || 0, me = Number(mat.en) || 0;
      var html = '<div class="fz-res">主裝備：' + nm(Object.assign({}, target, { cnt: 1 })) + ' <span class="fz-src">（' + SRC[t.src] + '）</span><br>素材：' + nm(Object.assign({}, mat, { cnt: 1 })) + ' <span class="fz-src">（' + SRC[c.src] + '）</span></div>' +
        '<div class="fz-res" style="margin-top:8px">強化：+' + te + ' ／ +' + me + ' → <b class="text-orange-300">+' + (r ? r.en : '?') + '</b>' + (te === me && r && r.en > te ? '（一樣高，再 +1）' : '') + '</div>';
      html += groups.map(function (g) {
        return '<div class="fz-res" style="margin-top:6px">' + g.n + '：' +
          '<label style="margin-left:6px"><input type="radio" name="fz-' + g.k + '" value="me"' + (choice[g.k] !== 'mat' ? ' checked' : '') + '> 留原本（' + esc(affixLabel(target, g.k)) + '）</label>' +
          '<label style="margin-left:8px"><input type="radio" name="fz-' + g.k + '" value="mat"' + (choice[g.k] === 'mat' ? ' checked' : '') + '> 換素材的（' + esc(affixLabel(mat, g.k)) + '）</label></div>';
      }).join('');
      if (r) {
        var v = gs(r), f = fee(r);
        html += '<div class="fz-res" style="margin-top:10px">結果：' + nm(r) + '<br>評分 ⭐ ' + base.toLocaleString() + ' → <b class="' + (v >= base ? 'text-orange-300' : 'text-red-400') + '">' + v.toLocaleString() + '</b>　手續費 ' + f.toLocaleString() + ' 金幣</div>';
      } else html += '<div class="fz-res text-red-400" style="margin-top:10px">這個組合不行：屬性第 4 階要 +10、第 5 階要 +11。</div>';
      w.querySelector('[data-act=body]').innerHTML = html;
      [].forEach.call(w.querySelectorAll('input[type=radio]'), function (x) { x.onchange = function () { choice[x.name.slice(3)] = x.value; draw(); }; });
      var go = w.querySelector('[data-act=go]'); go.disabled = !r || (player.gold || 0) < fee(r);
      go.textContent = !r ? '融合' : ((player.gold || 0) < fee(r) ? '金幣不夠' : '融合');
    }
    var busy = false;
    w.querySelector('[data-act=go]').onclick = function () {
      if (busy) return; busy = true;
      var res = executeGear(t, c, choice); busy = false;
      if (!res) return;
      close();
      shell('⚔️ 融合完成', '', '<div class="fz-res">' + nm(res.item) + '<br>評分 ⭐ ' + res.from.toLocaleString() + ' → ' + res.to.toLocaleString() + '</div>', '<button class="fz-go" data-act="again">繼續融合</button>');
      var again = document.querySelector('#' + BOX + ' [data-act=again]'); if (again) again.onclick = function () { openGearMat(res.t); };
    };
    draw();
  }

  function executeGear(t, c, choice) {
    var useWh = t.src === 'wh' || c.src === 'wh';
    if (useWh && !inTown()) { alert('離開村莊了，倉庫不能用。'); return null; }
    var w = useWh ? loadWarehouse() : null;
    var snap = typeof whTxnSnapshot === 'function' ? whTxnSnapshot() : { inv: JSON.parse(JSON.stringify(player.inv || [])), gold: player.gold };
    var eqBefore = t.src === 'eq' ? JSON.parse(JSON.stringify(t.it)) : null;
    function arrOf(src) { return src === 'wh' ? (w && w.items) : player.inv; }
    function findIdx(arr, uidv) { return (arr || []).findIndex(function (i) { return i && i.uid === uidv; }); }
    // 素材：從現在的背包／倉庫重新找，拿一件
    var marr = arrOf(c.src), mi = findIdx(marr, c.it.uid);
    if (mi < 0 || !gearEdible(marr[mi])) { alert('素材已經不在了（或被上鎖），請重新挑。'); return null; }
    var mat = Object.assign({}, marr[mi], { cnt: 1 });
    var sameStack = c.src === t.src && c.it.uid === t.it.uid;
    if ((marr[mi].cnt || 1) > 1) marr[mi].cnt -= 1; else if (!sameStack) marr.splice(mi, 1); else { alert('素材已經不在了，請重新挑。'); return null; }
    // 主裝備
    var target;
    if (t.src === 'eq') target = t.it;
    else {
      var tarr = arrOf(t.src), ti = findIdx(tarr, t.it.uid);
      if (ti < 0) { if (typeof whTxnRestore === 'function') whTxnRestore(snap); alert('找不到主裝備了，請重新打開融合。'); return null; }
      target = tarr[ti];
      if ((target.cnt || 1) > 1) { target.cnt -= 1; var single = Object.assign({}, target, { cnt: 1, uid: window.uid() }); tarr.push(single); target = single; }
    }
    var r = fuseResult(target, mat, choice);
    if (!r) { if (typeof whTxnRestore === 'function') whTxnRestore(snap); alert('這個組合不行。'); return null; }
    var f = fee(r);
    if ((player.gold || 0) < f) { if (typeof whTxnRestore === 'function') whTxnRestore(snap); alert('金幣不夠。'); return null; }
    var from = gs(target);
    ['en'].concat(GROUPS.reduce(function (a, g) { return a.concat(g.f); }, [])).forEach(function (k) { if (r[k] === undefined) delete target[k]; else target[k] = r[k]; });
    delete target.junk; delete target.junkSince; delete target._ruleJunk; delete target._autoSellQty;
    player.gold -= f;
    var ok;
    if (w) ok = whTxnCommit(w, snap);
    else { ok = typeof saveGame === 'function' && saveGame(); if (!ok && typeof whTxnRestore === 'function') { whTxnRestore(snap); try { saveGame(); } catch (e) {} } }
    if (!ok) {
      if (eqBefore) { Object.keys(target).forEach(function (k) { delete target[k]; }); Object.assign(target, eqBefore); try { saveGame(); } catch (e) {} }
      alert('存檔失敗，融合已取消，東西都還在。'); return null;
    }
    try { if (typeof window.calcStats === 'function') window.calcStats(); } catch (e) {}
    try { if (typeof window.renderTabs === 'function') window.renderTabs(true); } catch (e) {}
    try { if (typeof window.updateUI === 'function') window.updateUI(); } catch (e) {}
    try { var ic = document.getElementById('interaction-content'); if (useWh && ic && ic.querySelector('#wh-store-list') && typeof renderWarehouseNPC === 'function') renderWarehouseNPC(ic); } catch (e) {}
    var to = gs(target);
    try { if (typeof logSys === 'function') logSys('<span class="text-orange-300 font-bold">⚔️ 裝備融合：' + nm(Object.assign({}, target, { cnt: 1 })) + '（評分 ' + from + ' → ' + to + '，手續費 ' + f.toLocaleString() + '）</span>'); } catch (e) {}
    return { item: Object.assign({}, target, { cnt: 1 }), from: from, to: to, t: { it: target, src: t.src, slot: t.slot } };
  }

  // 入口選單：遺物融合／裝備融合
  function openMenu() {
    var w = shell('🔥 融合', '',
      '<button class="fz-row" data-act="relic" style="padding:12px 10px"><b class="text-orange-300">🔥 遺物融合</b><span class="fz-r">遺物吃遺物，升 🔥1～🔥10</span></button>' +
      '<button class="fz-row" data-act="gear" style="padding:12px 10px"><b class="text-orange-300">⚔️ 裝備融合</b><span class="fz-r">搬強化值和詞綴到主裝備</span></button>');
    w.querySelector('[data-act=relic]').onclick = openPicker;
    w.querySelector('[data-act=gear]').onclick = openGearPicker;
    // 💎 精石（afk-jingshi.js）：分解／洗煉／骰武器也從這裡進
    try {
      if (window.afkJingshi && window.afkJingshi.open) {
        var body = w.querySelector('.fz-body'), b = document.createElement('button');
        b.className = 'fz-row'; b.style.padding = '12px 10px';
        b.innerHTML = '<b style="color:#67e8f9">💎 精石</b><span class="fz-r">分解換精石、洗煉、骰武器</span>';
        b.onclick = window.afkJingshi.open; body.appendChild(b);
      }
    } catch (e) {}
  }

  // ===== 入口：右側按鈕區最後一排 =====
  function inject() {
    if (document.getElementById('afk-fz-btn')) return;
    var bar = document.querySelector('.tab-bar'); if (!bar) return;
    css();
    var b = document.createElement('button');
    b.id = 'afk-fz-btn'; b.className = 'btn text-base py-2 font-bold px-0'; b.textContent = '🔥 融合';
    b.onclick = openMenu;
    bar.appendChild(b);
  }
  window.afkFusion.open = openMenu; window.afkFusion.openRelic = openPicker; window.afkFusion.openGear = openGearPicker; window.afkFusion._fuseResult = fuseResult; window.afkFusion._best = bestChoice;
  css();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
  setTimeout(inject, 1500);
})();
