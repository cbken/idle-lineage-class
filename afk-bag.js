/* ============================================================================
 * afk-bag.js — 新背包（武器／防具／道具三頁）
 *
 * 站主 2026-10-01：「背包的設計就很爛…排列、點選廢品一堆很不好用，快速強化要點旁邊的下拉選單還要搶快才點得到，
 *   可以設計好一點嗎？還有可以設計多少以前用白、多少以後用祝的嗎？然後批次用紅的」
 *
 * 舊背包的問題（實測）：1,150 件就真的做出 1,150 格（上萬個元素），每撿一樣東西整頁重做，
 *   連操作列（含下拉選單）一起砍掉重做 → 選單打開到一半被關掉（＝要「搶快」）。
 *
 * 新背包：
 *   ① 只畫看得到的格子（虛擬捲動）：畫面上永遠約 30 格，背包再大都一樣快
 *   ② 操作列只建一次、之後只更新數字 → 下拉選單隨時點得到
 *   ③ 排列（分類／品質／強化值／最新取得／名稱，每頁各自記住）
 *   ④ 模式：一般／標廢品（點一下就標、可「同名一起標」、一鍵賣出）／快速強化（+N 以前白卷、+N 以後祝卷）／
 *      批次弱化（紅卷＝詛咒卷軸，勾選多件一次降到指定值）
 * 每一格的外觀沿用核心 invRowSpec（js/10），跟舊背包同一份規則；點擊／雙擊行為同核心。
 * 掛點：核心 renderTabs 在背包頁看得見時呼叫 AFK_BAG.render(vis)，並略過自己的列表建構（js/10，v3.12.0）。
 * 設定可關（關掉＝回到舊背包）。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'bag', name: '新背包', group: '遊戲介面', def: true,
    desc: '武器／防具／道具改用新背包：只畫看得到的格子（不卡）、排列可選、一鍵標廢品、快速強化（白卷→祝卷）、批次弱化（紅卷）。關掉＝舊背包'
  });
  function on() { return !window.AFK_TOGGLES || AFK_TOGGLES.enabled('bag'); }
  if (typeof window.invRowSpec !== 'function') { console.warn('[AFK-bag] 找不到 invRowSpec（核心版本不符），新背包停用。'); return; }

  var ROW = 42, ROW_H = 38, OVERSCAN = 6;
  var TABS = { w: 'tab-weapons', a: 'tab-armors', i: 'tab-items' };
  var TYPE = { w: 'wpn', a: 'arm', i: 'item' };   // 核心 quickJunk / _qeCanSelect 的分頁代號
  var SORTS = [['category', '分類'], ['quality', '品質'], ['en', '強化值'], ['new', '最新取得'], ['name', '名稱']];
  var LS = 'afk_bag_';
  function lsGet(k, def) { try { var v = localStorage.getItem(LS + k); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(LS + k, String(v)); } catch (e) {} }

  var S = {};   // 每頁狀態
  ['w', 'a', 'i'].forEach(function (t) {
    S[t] = { t: t, sort: lsGet('sort_' + t, 'category'), mode: 'normal', sel: {}, sameName: lsGet('same_' + t, '0') === '1', list: [], root: null, vp: null, spacer: null, rows: {} };
  });
  var ENH = { target: Number(lsGet('enh_target', 6)), blessFrom: Number(lsGet('enh_bless', 99)) };
  var CURSE = { target: Number(lsGet('curse_target', 0)) };

  // ── 最新取得：第一次看到某件物品（或數量變多）時記序號 ──
  var seen = new WeakMap(), seq = 0;
  function stampOf(i) { var r = seen.get(i), c = i.cnt || 1; if (!r) { r = { s: seq === 0 ? 0 : ++seq, c: c }; seen.set(i, r); } else if (c > r.c) { r.s = ++seq; r.c = c; } else r.c = c; return r.s; }

  function defOf(i) { return (i && DB.items[i.id]) || null; }
  function dstOf(d) { return d.type === 'wpn' ? 'w' : ((d.type === 'arm' || d.type === 'acc') ? 'a' : 'i'); }
  function nameText(i) { try { return String(getItemFullName(i)).replace(/<[^>]*>/g, ''); } catch (e) { var d = defOf(i); return d ? d.n : ''; } }
  function query() { var el = document.getElementById('afk-isearch-input'); return el ? String(el.value || '').trim().toLowerCase() : ''; }
  function scrollCnt(id) { var n = 0; player.inv.forEach(function (x) { if (x.id === id) n += (x.cnt || 1); }); return n; }

  function cmpFor(mode) {
    if (mode === 'quality') return function (a, b) { return inventoryQualityCmp(a, b); };
    if (mode === 'name') return function (a, b) { return inventoryNameCmp(a, b) || inventoryQualityCmp(a, b); };
    if (mode === 'en') return function (a, b) { return ((b.en || 0) - (a.en || 0)) || inventoryQualityCmp(a, b); };
    if (mode === 'new') return function (a, b) { return (stampOf(b) - stampOf(a)) || inventoryQualityCmp(a, b); };
    return function (a, b) {   // 分類：上鎖在前、廢品在後、再依種類與品質
      if (!!a.lock !== !!b.lock) return a.lock ? -1 : 1; if (!!a.junk !== !!b.junk) return a.junk ? 1 : -1;
      var sa = inventorySubRank(a, defOf(a) || {}), sb = inventorySubRank(b, defOf(b) || {});
      return (sa - sb) || inventoryQualityCmp(a, b);
    };
  }
  function buildList(st) {
    var q = query(), out = [];
    player.inv.forEach(function (i) { var d = defOf(i); if (!d || dstOf(d) !== st.t) return; stampOf(i); if (q && nameText(i).toLowerCase().indexOf(q) < 0) return; out.push(i); });
    out.sort(cmpFor(st.sort));
    return out;
  }

  // ── 資格 ──
  function enhOk(i, d) { return st0(i) && typeof _qeCanSelect === 'function' && _qeCanSelect(d, i, d.type === 'wpn' ? 'wpn' : 'arm'); }
  function st0(i) { return !!i; }
  function curseScroll(d) { return d.type === 'wpn' ? 'scroll_weapon_c' : (d.type === 'arm' ? 'scroll_armor_c' : ''); }
  function curseOk(i, d) { return !!(i && d && !i.lock && (d.type === 'wpn' || d.type === 'arm') && !d.noEnhance && (Number(i.en) || 0) > CURSE.target && curseScroll(d) && DB.items[curseScroll(d)]); }
  function junkOk(i, d) { return !!(i && d && !i.lock && !d.noJunk); }

  // ── UI 骨架（每頁只建一次）──
  function css() {
    if (document.getElementById('afk-bag-css')) return;
    var s = document.createElement('style'); s.id = 'afk-bag-css';
    s.textContent = [
      '.afk-bag{display:flex;flex-direction:column;gap:6px;height:100%;min-height:0}',
      '.afk-bag-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:rgba(15,23,42,.85);border:1px solid #334155;border-radius:8px;padding:6px;font-size:13px}',
      '.afk-bag-bar select{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:3px 6px;font-size:13px}',
      '.afk-bag-modes{display:flex;gap:4px;flex-wrap:wrap}',
      '.afk-bag-modes button{background:#1e293b;color:#cbd5e1;border:1px solid #475569;border-radius:6px;padding:3px 9px;font-size:13px;font-weight:700}',
      '.afk-bag-modes button.on{background:#b45309;color:#fff;border-color:#f59e0b}',
      '.afk-bag-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:#cbd5e1}',
      '.afk-bag-sub .afk-btn{background:#1e3a8a;color:#dbeafe;border:1px solid #3b82f6;border-radius:6px;padding:3px 9px;font-weight:700;font-size:12px}',
      '.afk-bag-sub .afk-btn.red{background:#7f1d1d;border-color:#ef4444;color:#fee2e2}',
      '.afk-bag-sub .afk-btn.gray{background:#334155;border-color:#64748b;color:#e2e8f0}',
      '.afk-bag-sub b{color:#fcd34d}',
      '.afk-bag-sub .g{white-space:nowrap}',
      '.afk-bag-vp{position:relative;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:200px;-webkit-overflow-scrolling:touch}',
      '.afk-bag-vp > .list-item{position:absolute;left:2px;right:2px;height:' + ROW_H + 'px;margin:0!important;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;overflow:hidden}',
      '.afk-bag-vp > .list-item .classic-item-main{display:flex;align-items:center;gap:8px;width:100%;min-width:0}',
      '.afk-bag-vp > .list-item .classic-icon-box{position:relative;flex:0 0 30px;width:30px;height:30px;display:flex;align-items:center;justify-content:center}',
      '.afk-bag-vp > .list-item .classic-name-box{display:flex;flex-direction:column;min-width:0;line-height:1.15}',
      '.afk-bag-vp > .list-item .classic-name-box > span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.afk-bag-vp > .list-item .classic-icon-corner-value{position:absolute;right:-4px;bottom:-4px;font-size:10px;font-weight:800;color:#fde68a;text-shadow:0 0 2px #000}',
      '.afk-bag-vp > .list-item .classic-item-lock-badge{margin-left:auto;font-size:12px}',
      '.afk-bag-vp > .list-item .classic-item-junk-label{margin-left:auto;color:#f87171;font-size:11px;font-weight:800}',
      '.afk-bag-vp > .list-item.afk-sel{outline:2px solid #60a5fa;outline-offset:-2px;background:rgba(30,58,138,.45)!important}',
      '.afk-bag-vp > .list-item.afk-sel-red{outline:2px solid #f87171;outline-offset:-2px;background:rgba(127,29,29,.45)!important}',
      '.afk-bag-vp > .list-item.afk-no{opacity:.35}',
      '.afk-bag-empty{color:#94a3b8;text-align:center;padding:24px;font-size:13px}'
    ].join('\n');
    document.head.appendChild(s);
  }
  function opt(v, label, cur) { return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + label + '</option>'; }
  function enOpts(from, to, cur, fmt) { var h = ''; for (var n = from; n <= to; n++) h += opt(n, fmt ? fmt(n) : ((n < 0 ? '' : '+') + n), cur); return h; }

  function ensureRoot(st) {
    var tab = document.getElementById(TABS[st.t]);
    if (!tab) return null;
    if (st.root && st.root.parentNode === tab) return st.root;
    css();
    tab.innerHTML = '';
    var r = document.createElement('div'); r.className = 'afk-bag'; r.dataset.t = st.t;
    var modes = '<button data-m="normal">一般</button><button data-m="junk">標廢品</button>' + (st.t !== 'i' ? '<button data-m="enh">快速強化</button><button data-m="curse">批次弱化</button>' : '');
    r.innerHTML = '<div class="afk-bag-bar"><select class="afk-bag-sort" title="排列方式">' + SORTS.map(function (x) { return opt(x[0], '排列：' + x[1], st.sort); }).join('') + '</select>' +
      '<div class="afk-bag-modes">' + modes + '</div></div>' +
      '<div class="afk-bag-sub"></div><div class="afk-bag-vp"><div class="afk-bag-spacer"></div></div>';
    tab.appendChild(r);
    st.root = r; st.vp = r.querySelector('.afk-bag-vp'); st.spacer = r.querySelector('.afk-bag-spacer'); st.rows = {}; st.sub = r.querySelector('.afk-bag-sub');
    r.querySelector('.afk-bag-sort').onchange = function () { st.sort = this.value; lsSet('sort_' + st.t, st.sort); refresh(st, true); };
    r.querySelectorAll('.afk-bag-modes button').forEach(function (b) { b.onclick = function () { setMode(st, b.dataset.m); }; });
    st.vp.addEventListener('scroll', function () { paint(st); }, { passive: true });
    buildSub(st);
    return r;
  }
  function setMode(st, m) { st.mode = m; st.sel = {}; buildSub(st); refresh(st, false); }

  // 子列（模式專屬控制）：模式切換時才重建；平常只更新數字
  function buildSub(st) {
    if (!st.sub) return;
    st.root.querySelectorAll('.afk-bag-modes button').forEach(function (b) { b.classList.toggle('on', b.dataset.m === st.mode); });
    var h = '';
    if (st.mode === 'normal') h = '<span class="g">共 <b class="afk-n">0</b> 格</span><span class="g">廢品 <b class="afk-jn">0</b> 件</span><button class="afk-btn red afk-sell">一鍵賣出廢品</button>';
    else if (st.mode === 'junk') h = '<span class="g">點物品＝標／取消廢品</span><label class="g" style="cursor:pointer"><input type="checkbox" class="afk-same"' + (st.sameName ? ' checked' : '') + '> 同名一起標</label><span class="g">廢品 <b class="afk-jn">0</b> 件</span><button class="afk-btn red afk-sell">一鍵賣出廢品</button>';
    else if (st.mode === 'enh') h = '<span class="g">強化到 <select class="afk-tg">' + enOpts(1, 15, ENH.target) + '</select></span>' +
      '<select class="afk-bf">' + opt(99, '全部用白卷', ENH.blessFrom) + enOpts(0, 14, ENH.blessFrom, function (n) { return '+' + n + ' 起改用祝卷'; }) + '</select>' +
      '<span class="g">白卷 <b class="afk-sw">0</b>／祝卷 <b class="afk-sb">0</b></span><span class="g">已選 <b class="afk-k">0</b></span><button class="afk-btn gray afk-all">全選</button><button class="afk-btn gray afk-none">清除</button> <button class="afk-btn afk-go">開始強化</button>';
    else if (st.mode === 'curse') h = '<span class="g">用紅卷（詛咒卷軸）降到 <select class="afk-ct">' + enOpts(-1, 14, CURSE.target) + '</select></span><span class="g">紅卷 <b class="afk-sc">0</b></span><span class="g">已選 <b class="afk-k">0</b></span><button class="afk-btn gray afk-all">全選</button><button class="afk-btn gray afk-none">清除</button> <button class="afk-btn red afk-go">開始弱化</button>';
    st.sub.innerHTML = h;
    var q = function (c) { return st.sub.querySelector(c); };
    if (q('.afk-sell')) q('.afk-sell').onclick = function () { sellJunk(); };
    if (q('.afk-same')) q('.afk-same').onchange = function () { st.sameName = this.checked; lsSet('same_' + st.t, st.sameName ? '1' : '0'); };
    if (q('.afk-tg')) q('.afk-tg').onchange = function () { ENH.target = Number(this.value); lsSet('enh_target', ENH.target); refresh(st, false); };
    if (q('.afk-bf')) q('.afk-bf').onchange = function () { ENH.blessFrom = Number(this.value); lsSet('enh_bless', ENH.blessFrom); };
    if (q('.afk-ct')) q('.afk-ct').onchange = function () { CURSE.target = Number(this.value); lsSet('curse_target', CURSE.target); st.sel = {}; refresh(st, false); };
    if (q('.afk-all')) q('.afk-all').onclick = function () { st.list.forEach(function (i) { var d = defOf(i); if (st.mode === 'enh' ? (enhOk(i, d) && (i.en || 0) < ENH.target) : curseOk(i, d)) st.sel[i.uid] = true; }); refresh(st, false); };
    if (q('.afk-none')) q('.afk-none').onclick = function () { st.sel = {}; refresh(st, false); };
    if (q('.afk-go')) q('.afk-go').onclick = function () { if (st.mode === 'enh') runEnh(st); else runCurse(st); };
  }
  function updateSub(st) {
    var q = function (c) { return st.sub && st.sub.querySelector(c); }, set = function (c, v) { var e = q(c); if (e) e.textContent = v; };
    var jn = 0; player.inv.forEach(function (i) { if (i.junk && !i.lock) jn += (i.cnt || 1); });
    set('.afk-n', st.list.length.toLocaleString()); set('.afk-jn', jn.toLocaleString());
    var k = 0; for (var u in st.sel) if (st.sel[u]) k++; set('.afk-k', k);
    if (st.t !== 'i') {
      set('.afk-sw', scrollCnt(st.t === 'w' ? 'scroll_weapon' : 'scroll_armor').toLocaleString());
      set('.afk-sb', scrollCnt(st.t === 'w' ? 'scroll_weapon_b' : 'scroll_armor_b').toLocaleString());
      set('.afk-sc', scrollCnt(st.t === 'w' ? 'scroll_weapon_c' : 'scroll_armor_c').toLocaleString());
    }
  }

  // ── 繪製看得到的那幾格 ──
  function rowKey(st, i, spec) {
    var extra = st.mode === 'normal' ? '' : (st.mode + (st.sel[i.uid] ? '1' : '0'));
    return spec.cls + '\u0001' + spec.inner + '\u0001' + extra;
  }
  function paint(st) {
    if (!st.vp) return;
    var n = st.list.length, h = n * ROW;
    if (st.spacer.style.height !== h + 'px') st.spacer.style.height = h + 'px';
    var vh = st.vp.clientHeight || 500, top = st.vp.scrollTop;
    var a = Math.max(0, Math.floor(top / ROW) - OVERSCAN), b = Math.min(n, Math.ceil((top + vh) / ROW) + OVERSCAN);
    var keep = {};
    for (var k = a; k < b; k++) {
      var i = st.list[k], d = defOf(i); if (!d) continue;
      var spec = invRowSpec(i, d), key = rowKey(st, i, spec), r = st.rows[i.uid];
      if (!r || r.key !== key || r.item !== i) {
        if (r && r.el.parentNode) r.el.parentNode.removeChild(r.el);
        var el = document.createElement('div');
        var cls = spec.cls;
        if (st.mode === 'enh') { if (st.sel[i.uid]) cls += ' afk-sel'; else if (!enhOk(i, d)) cls += ' afk-no'; }
        if (st.mode === 'curse') { if (st.sel[i.uid]) cls += ' afk-sel-red'; else if (!curseOk(i, d)) cls += ' afk-no'; }
        el.className = cls;
        el.setAttribute('data-tip-uid', i.uid); el.setAttribute('data-tip-src', 'inv');
        el.innerHTML = spec.inner;
        bindRow(st, el, i, d);
        r = st.rows[i.uid] = { key: key, el: el, item: i };
      }
      var y = (k * ROW) + 'px';
      if (r.el.style.top !== y) r.el.style.top = y;
      if (r.el.parentNode !== st.vp) st.vp.appendChild(r.el);
      keep[i.uid] = 1;
    }
    for (var u in st.rows) if (!keep[u]) { var rr = st.rows[u]; if (rr.el.parentNode) rr.el.parentNode.removeChild(rr.el); if (!rr.el.isConnected) delete st.rows[u]; }
    var empty = st.vp.querySelector('.afk-bag-empty');
    if (!n && !empty) { empty = document.createElement('div'); empty.className = 'afk-bag-empty'; empty.textContent = query() ? '找不到符合的物品' : '這一頁沒有物品'; st.vp.appendChild(empty); }
    else if (n && empty) empty.remove();
  }
  function bindRow(st, el, i, d) {
    if (st.mode === 'normal') {
      var dbl = (d.type === 'wpn' || d.type === 'arm' || d.type === 'acc') ? 'equip'
        : ((i.id !== 'candle' && (d.type === 'pot' || d.type === 'skillbk' || d.type === 'scroll' || (d.type === 'misc' && d.eff && !d.noUse))) ? 'use' : null);
      if (dbl) {
        el.onclick = function () { clearTimeout(window._invClickTimer); window._invClickTimer = setTimeout(function () { openModal(i, false); }, 230); };
        el.ondblclick = function (ev) { clearTimeout(window._invClickTimer); ev.preventDefault(); ev.stopPropagation(); if (dbl === 'equip') equipItem(i); else useItem(i.uid); };
      } else el.onclick = function () { openModal(i, false); };
    } else if (st.mode === 'junk') {
      el.onclick = function () { toggleJunkQuiet(st, i); };
    } else {
      el.onclick = function () {
        var ok = st.mode === 'enh' ? enhOk(i, d) : curseOk(i, d);
        if (!ok) { toast(st.mode === 'enh' ? '這件不能快速強化（上鎖／不可強化／已到上限）' : (i.lock ? '上鎖的不能弱化' : '這件不能用紅卷再降（已低於或等於目標值）')); return; }
        if (st.sel[i.uid]) delete st.sel[i.uid]; else st.sel[i.uid] = true;
        refresh(st, false);
      };
    }
  }
  function toast(msg) { try { logSys('<span class="text-amber-300">' + msg + '</span>'); } catch (e) {} }

  // ── 標廢品（不開物品視窗、不整頁重建）──
  function setJunk(i, want) {
    var d = defOf(i); if (!junkOk(i, d)) return false;
    if (!player.junkPrefs) player.junkPrefs = {};
    i.junk = want;
    if (want) { player.junkPrefs[itemSig(i)] = true; delete i._userKeep; if (typeof _bumpJunkSellTimer === 'function') _bumpJunkSellTimer(); }
    else { delete player.junkPrefs[itemSig(i)]; if (i._ruleJunk) { i._userKeep = true; i._ruleJunk = false; delete i.junkSince; delete i._autoSellQty; } }
    return true;
  }
  function toggleJunkQuiet(st, i) {
    var d = defOf(i);
    if (!junkOk(i, d)) { toast(i.lock ? '上鎖的物品不能標廢品' : '這件不能標廢品'); return; }
    var want = !i.junk, n = 0;
    if (st.sameName) player.inv.forEach(function (x) { if (x.id === i.id && setJunk(x, want)) n++; });
    else if (setJunk(i, want)) n = 1;
    if (st.sameName && n > 1) toast((want ? '已標廢品：' : '已取消廢品：') + d.n + ' 共 ' + n + ' 格');
    refresh(st, false);
  }
  function sellJunk() {
    if (typeof autoSellJunk !== 'function') { toast('找不到賣出功能'); return; }
    autoSellJunk(true);
    renderTabs(true);
  }

  // ── 快速強化：+N 以前白卷、+N 以後祝卷 ──
  function runEnh(st) {
    var goal = ENH.target, bf = ENH.blessFrom;
    var entries = player.inv.filter(function (i) { return st.sel[i.uid] && enhOk(i, defOf(i)); });
    if (!entries.length) { toast('還沒勾選要強化的裝備'); return; }
    var ids = ['scroll_weapon', 'scroll_armor', 'scroll_acc', 'scroll_weapon_b', 'scroll_armor_b'];
    var stacks = {}; ids.forEach(function (sid) { stacks[sid] = { cnt: scrollCnt(sid) }; });
    var reached = 0, destroyed = 0, partial = 0, skipped = 0, used = { w: 0, b: 0 }, removeUids = {}, survivors = [];
    entries.forEach(function (entry) {
      var d = defOf(entry), cnt = entry.cnt || 1, cap = enhanceCap(d), g = Math.min(goal, cap);
      removeUids[entry.uid] = 1;
      for (var u = 0; u < cnt; u++) {
        var en = entry.en || 0;
        if (en >= g) { skipped++; survivors.push(Object.assign({}, entry, { cnt: 1, uid: uid() })); continue; }
        var r1 = { en: en, destroyed: false, used: 0 };
        var mid = Math.min(g, bf);
        if (en < mid) { r1 = _quickEnhanceUnit(d, en, mid, stacks, false); used.w += r1.used; }
        var r = r1;
        if (!r1.destroyed && r1.en < g && r1.en >= mid && bf < 99) { r = _quickEnhanceUnit(d, r1.en, g, stacks, true); used.b += r.used; }
        if (r.destroyed) { destroyed++; continue; }
        if (r.en >= g) reached++; else partial++;
        survivors.push(Object.assign({}, entry, { cnt: 1, uid: uid(), en: r.en, lock: false }));
      }
    });
    player.inv = player.inv.filter(function (i) { return !removeUids[i.uid]; });
    ids.forEach(function (sid) { var it = player.inv.find(function (i) { return i.id === sid; }); if (it) { it.cnt = stacks[sid].cnt; if (it.cnt <= 0) player.inv = player.inv.filter(function (x) { return x.uid !== it.uid; }); } });
    survivors.forEach(function (s) { var ex = player.inv.find(function (x) { return sameItemSig(x, s); }); if (ex) ex.cnt = (ex.cnt || 1) + 1; else player.inv.push(s); });
    st.sel = {};
    var parts = ['成功 ' + reached + ' 件']; if (partial) parts.push('卷軸不足停 ' + partial + ' 件'); if (skipped) parts.push('已達標 ' + skipped + ' 件');
    parts.push('<span class="text-red-400">爆裝 ' + destroyed + ' 件</span>');
    logSys('<span class="text-blue-300 font-bold">快速強化完成（目標 +' + goal + (bf < 99 ? '・+' + bf + ' 起用祝卷' : '・全白卷') + '）：</span>' + parts.join('、') + '，用了白卷 ' + used.w + ' 張、祝卷 ' + used.b + ' 張。');
    calcStats(); renderTabs(true); saveGame();
  }

  // ── 批次弱化：紅卷（詛咒卷軸）一次降到指定值（100% 成功、不爆裝，規則同核心 executeCurseDeEnhance）──
  function runCurse(st) {
    var goal = CURSE.target;
    var entries = player.inv.filter(function (i) { return st.sel[i.uid] && curseOk(i, defOf(i)); });
    if (!entries.length) { toast('還沒勾選要弱化的裝備'); return; }
    var have = {}, used = 0, done = 0, short = 0, removeUids = {}, outs = [];
    entries.forEach(function (entry) {
      var d = defOf(entry), sid = curseScroll(d); if (have[sid] == null) have[sid] = scrollCnt(sid);
      var cnt = entry.cnt || 1, en0 = Number(entry.en) || 0; removeUids[entry.uid] = 1;
      for (var u = 0; u < cnt; u++) {
        var need = en0 - goal, take = Math.min(need, have[sid]);
        have[sid] -= take; used += take;
        if (take < need) short++; else done++;
        outs.push(Object.assign({}, entry, { cnt: 1, uid: uid(), en: en0 - take }));
      }
    });
    player.inv = player.inv.filter(function (i) { return !removeUids[i.uid]; });
    Object.keys(have).forEach(function (sid) { var it = player.inv.find(function (i) { return i.id === sid; }); if (it) { it.cnt = have[sid]; if (it.cnt <= 0) player.inv = player.inv.filter(function (x) { return x.uid !== it.uid; }); } });
    outs.forEach(function (s) { var ex = player.inv.find(function (x) { return sameItemSig(x, s); }); if (ex) ex.cnt = (ex.cnt || 1) + 1; else player.inv.push(s); });
    st.sel = {};
    logSys('<span class="c-cursed font-bold">批次弱化完成（降到 ' + (goal < 0 ? goal : '+' + goal) + '）：</span>完成 ' + done + ' 件' + (short ? '、紅卷不足停在中途 ' + short + ' 件' : '') + '，用了紅卷 ' + used + ' 張。');
    calcStats(); renderTabs(true); saveGame();
  }

  // ── 對外：核心 renderTabs 在背包頁看得見時呼叫 ──
  // 捲動區高度：撐到畫面底（手機扣掉底部選單），最少 240px —— 一定要固定高度，虛擬捲動才有意義
  function sizeVp(st) {
    var top = st.vp.getBoundingClientRect().top;
    var navH = parseFloat(getComputedStyle(document.body).getPropertyValue('--m-nav-h')) || 0;
    var panel = document.getElementById('tab-content-panel'), pb = panel ? panel.getBoundingClientRect().bottom : window.innerHeight;
    var h = Math.max(240, Math.min(window.innerHeight - navH, pb) - top - 8);
    // 手機：分頁在長頁面下方，上面還黏著狀態列＋分頁按鈕（sticky）。
    // 高度＝螢幕扣掉底部導覽、黏住的區塊、背包自己的操作列 → 捲到底時操作列＋整個清單剛好一畫面。
    if (navH > 0) {
      var sb = 0, gs = document.getElementById('game-screen');
      if (gs) gs.querySelectorAll('#m-status, .panel').forEach(function (e) {
        var cs = getComputedStyle(e); if (cs.position === 'sticky') sb = Math.max(sb, (parseFloat(cs.top) || 0) + e.offsetHeight);
      });
      var head = top - st.root.getBoundingClientRect().top;
      h = Math.max(180, window.innerHeight - navH - sb - head - 12);
    }
    if (Math.abs((parseFloat(st.vp.style.height) || 0) - h) > 2) st.vp.style.height = h + 'px';
  }
  function refresh(st, resetScroll) {
    if (!ensureRoot(st)) return;
    sizeVp(st);
    st.list = buildList(st);
    if (resetScroll) st.vp.scrollTop = 0;
    updateSub(st); paint(st);
  }
  function render(vis) {
    if (!on()) return false;
    ['w', 'a', 'i'].forEach(function (t) { if (vis[t]) refresh(S[t], false); });
    return true;
  }
  // 搜尋框（afk-itemsearch 的 #afk-isearch-input）輸入時也要重排
  document.addEventListener('input', function (e) { if (e.target && e.target.id === 'afk-isearch-input' && on()) ['w', 'a', 'i'].forEach(function (t) { if (S[t].root && S[t].root.isConnected) refresh(S[t], true); }); }, true);

  window.addEventListener('resize', function () { ['w', 'a', 'i'].forEach(function (t) { if (S[t].vp && S[t].vp.isConnected) { sizeVp(S[t]); paint(S[t]); } }); });
  window.AFK_BAG = { on: on, render: render, state: S, _runEnh: runEnh, _runCurse: runCurse, _setMode: function (t, m) { setMode(S[t], m); } };
  console.log('[AFK-bag] hooks OK');
})();
