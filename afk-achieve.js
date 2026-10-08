/*
 * afk-achieve.js — 🏅 成就＋稱號（站主 2026-10-08「有趣的玩法再做進去」第 2 項）
 *
 * 每個角色自己的成就（存在 player.ach，跟著存檔走）：
 *   { got:{成就id:解鎖時間}, t:'裝上的稱號成就id', bk:打倒頭目數, bn:{頭目名:1}, brk:爆裝次數, die:倒下次數, solo:1, siege:1, champ:1, init:1 }
 * 判斷方式：
 *   ① 看得到的狀態（等級、身上裝備強化值、金幣、圖鑑、天梯最高層…）每 3 秒輪詢一次 → 舊角色一進來就補發。
 *   ② 看不到歷史的（打倒頭目、爆裝、倒下）從這版開始記：包 killMob / enhanceRollOutcome / killPlayer。
 *      本檔排在 afk-ladder.js 後面 → 包到的是「不爆強化卷」處理後的結果（被擋下的不算爆裝）。
 * 第一次載入某角色＝安靜補發（只跳一則「補發了 N 個成就」，自動裝上最稀有的稱號），之後每解一個跳一次通知。
 * 稱號顯示：左欄職業名後面、手機上方狀態列名字前面、天梯排行榜名字後面（Worker 存 e.ti）。點稱號開成就面板。
 * 只有純外觀，不給數值（不動遊戲平衡）。
 */
(function () {
  'use strict';
  if (window.AFK_TOGGLES && !AFK_TOGGLES.enabled('achieve')) return;
  if (typeof DB === 'undefined' || typeof window.killMob !== 'function') { console.warn('[AFK-achieve] 缺少核心函式，停用'); return; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function P() { return (typeof player !== 'undefined' && player && player.cls) ? player : null; }
  function ff() { return typeof state !== 'undefined' && state && state.ff; }
  function A() {
    var p = P(); if (!p) return null;
    if (!p.ach || typeof p.ach !== 'object') p.ach = {};
    var a = p.ach;
    if (!a.got || typeof a.got !== 'object') a.got = {};
    if (!a.bn || typeof a.bn !== 'object') a.bn = {};
    ['bk', 'brk', 'die'].forEach(function (k) { if (!(a[k] >= 0)) a[k] = 0; });
    return a;
  }
  function maxEn(type) {
    var p = P(), m = 0; if (!p || !p.eq) return 0;
    for (var k in p.eq) { var e = p.eq[k]; if (!e || !e.id || k === 'doll' || k === 'eye') continue; var d = DB.items[e.id]; if (d && d.type === type) m = Math.max(m, Number(e.en) || 0); }
    return m;
  }
  function cnt(o) { return o ? Object.keys(o).length : 0; }
  function card100() { var p = P(), n = 0; if (p && p.cardDex) for (var k in p.cardDex) if (p.cardDex[k] >= 100) n++; return n; }
  function lad() { var p = P(); return (p && p.ladder) || {}; }
  function allyCount() { var p = P(); return p ? (p.allies || []).filter(Boolean).length : 0; }

  // r＝稀有度 1~4（決定稱號顏色、補發時自動裝哪個）；v＝目前進度（給面板顯示），need＝目標
  function lvA(id, lv, t, r) { return { id: id, g: '等級', n: '達到 Lv' + lv, t: t, r: r, v: function () { return P().lv; }, need: lv }; }
  function enA(id, type, en, label, t, r) { return { id: id, g: '強化', n: label + ' +' + en, d: '身上穿著' + label + ' +' + en + ' 以上', t: t, r: r, v: function () { return maxEn(type); }, need: en }; }
  function bossA(id, mobName, t, r) { return { id: id, g: '頭目', n: '打倒' + mobName, d: '打倒「' + mobName + '」（從這版開始記）', t: t, r: r, v: function () { return A().bn[mobName] ? 1 : 0; }, need: 1 }; }
  function ladA(id, f, t, r) { return { id: id, g: '天梯', n: '天梯 ' + f + ' 層', d: '無限天梯最高紀錄達到第 ' + f + ' 層', t: t, r: r, v: function () { return lad().best || 0; }, need: f }; }
  function goldA(id, g, label, t, r) { return { id: id, g: '財富', n: '身上 ' + label + ' 金幣', t: t, r: r, v: function () { return P().gold || 0; }, need: g, fmt: label }; }

  var ACH = [
    lvA('lv50', 50, '見習冒險者', 1), lvA('lv100', 100, '百戰勇士', 2), lvA('lv150', 150, '傳說旅人', 3), lvA('lv200', 200, '登峰造極', 4),
    enA('wpn7', 'wpn', 7, '武器', '打鐵學徒', 1), enA('wpn9', 'wpn', 9, '武器', '衝裝好手', 2), enA('wpn11', 'wpn', 11, '武器', '神之手', 3), enA('wpn13', 'wpn', 13, '武器', '強化之神', 4),
    enA('arm7', 'arm', 7, '防具', '鐵壁', 2), enA('arm9', 'arm', 9, '防具', '不動如山', 3),
    enA('acc3', 'acc', 3, '飾品', '珠光寶氣', 2), enA('acc5', 'acc', 5, '飾品', '寶石大亨', 3),
    { id: 'brk1', g: '強化', n: '心碎', d: '第一次爆裝（從這版開始記）', t: '心碎的人', r: 1, v: function () { return A().brk; }, need: 1 },
    { id: 'brk10', g: '強化', n: '爆裝慣犯', d: '累計爆裝 10 次（從這版開始記）', t: '爆裝慣犯', r: 2, v: function () { return A().brk; }, need: 10 },
    { id: 'boss1', g: '頭目', n: '頭目獵人', d: '打倒 1 隻頭目（從這版開始記）', t: '頭目獵人', r: 1, v: function () { return A().bk; }, need: 1 },
    { id: 'boss100', g: '頭目', n: '頭目剋星', d: '累計打倒 100 隻頭目', t: '頭目剋星', r: 2, v: function () { return A().bk; }, need: 100 },
    { id: 'boss1000', g: '頭目', n: '頭目終結者', d: '累計打倒 1000 隻頭目', t: '頭目終結者', r: 3, v: function () { return A().bk; }, need: 1000 },
    bossA('baph', '巴風特', '驅魔人', 2), bossA('dk', '死亡騎士', '黑騎士剋星', 2),
    bossA('antaras', '安塔瑞斯', '地龍剋星', 3), bossA('fafurion', '法利昂', '水龍剋星', 3), bossA('lind', '林德拜爾', '風龍剋星', 3), bossA('valakas', '巴拉卡斯', '火龍剋星', 3),
    bossA('gasha', '巨大骷髏', '鎮魂者', 4), bossA('dantes', '真‧死亡騎士 冥皇丹特斯', '冥皇殺手', 4),
    { id: 'solo', g: '頭目', n: '孤狼', d: '一個傭兵都不帶，打倒 Lv70 以上的頭目', t: '孤狼', r: 3, v: function () { return A().solo ? 1 : 0; }, need: 1 },
    ladA('lad25', 25, '登塔者', 1), ladA('lad50', 50, '天梯勇者', 2), ladA('lad75', 75, '雲端行者', 3), ladA('lad100', 100, '天梯之王', 4),
    { id: 'wk3', g: '天梯', n: '週週勤勉', d: '同一週拿到 3 個週目標（通過 60 層）', t: '週週勤勉', r: 3, v: function () { var w = lad().wg; return (w && w.got) ? w.got.length : 0; }, need: 3 },
    { id: 'champ', g: '天梯', n: '週冠軍', d: '成為天梯週冠軍（上週最高樓層）', t: '週冠軍', r: 4, v: function () { return A().champ ? 1 : 0; }, need: 1 },
    { id: 'wb1', g: '天梯', n: '世界頭目討伐', d: '參與並討伐世界頭目 1 次', t: '屠神者', r: 3, v: function () { return (lad().wb || {}).kc || 0; }, need: 1 },
    { id: 'wb10', g: '天梯', n: '傳說討伐隊', d: '參與並討伐世界頭目 10 次', t: '傳說討伐隊', r: 4, v: function () { return (lad().wb || {}).kc || 0; }, need: 10 },
    { id: 'tm1', g: '其他', n: '尋寶者', d: '藏寶圖小副本全清 1 次（離線時有機會撿到藏寶圖）', t: '尋寶者', r: 2, v: function () { return (lad().tm || {}).clr || 0; }, need: 1 },
    { id: 'tm10', g: '其他', n: '寶藏獵人', d: '藏寶圖小副本全清 10 次', t: '寶藏獵人', r: 3, v: function () { return (lad().tm || {}).clr || 0; }, need: 10 },
    goldA('g8', 1e8, '1 億', '小富翁', 1), goldA('g9', 1e9, '10 億', '大富豪', 2), goldA('g10', 1e10, '100 億', '富可敵國', 3),
    { id: 'card100', g: '收藏', n: '卡片達人', d: '100 張卡片收集到滿分', t: '卡片達人', r: 1, v: card100, need: 100 },
    { id: 'card400', g: '收藏', n: '卡片大師', d: '400 張卡片收集到滿分', t: '卡片大師', r: 3, v: card100, need: 400 },
    { id: 'eqdex300', g: '收藏', n: '收藏家', d: '裝備圖鑑登錄 300 件', t: '收藏家', r: 2, v: function () { return cnt(P().equipDex); }, need: 300 },
    { id: 'eqdex600', g: '收藏', n: '博物館長', d: '裝備圖鑑登錄 600 件', t: '博物館長', r: 4, v: function () { return cnt(P().equipDex); }, need: 600 },
    { id: 'party', g: '其他', n: '大家長', d: '隊伍帶滿 7 個傭兵', t: '大家長', r: 1, v: allyCount, need: 7 },
    { id: 'siege', g: '其他', n: '攻城英雄', d: '攻城戰獲勝', t: '攻城英雄', r: 3, v: function () { return A().siege ? 1 : 0; }, need: 1 },
    { id: 'die100', g: '其他', n: '打不死的', d: '累計倒下 100 次還在玩（從這版開始記）', t: '打不死的', r: 2, v: function () { return A().die; }, need: 100 }
  ];
  var BY = {}; ACH.forEach(function (a) { BY[a.id] = a; });
  var GROUPS = ['等級', '強化', '頭目', '天梯', '財富', '收藏', '其他'];
  var RCOL = { 1: '#cbd5e1', 2: '#6ee7b7', 3: '#7dd3fc', 4: '#fbbf24' };

  function curTitle() { var a = A(); return a && a.t && a.got[a.t] && BY[a.t] ? BY[a.t] : null; }
  window.afkAchTitle = function () { var t = curTitle(); return t ? t.t : ''; };

  // ===== 事件計數 =====
  var _origKill = window.killMob;
  window.killMob = function (idx) {
    var mob = (typeof mapState !== 'undefined' && mapState.mobs) ? mapState.mobs[idx] : null;
    var wasAlive = mob && !mob._dead;
    var r = _origKill.apply(this, arguments);
    try {
      if (wasAlive && mob._dead && mob.boss && !mob.siegeEnemy && !mob._ladder && !mob.trollPlayer && P() && !P().dead) {
        var a = A(); a.bk++; if (mob.n) a.bn[mob.n] = 1;
        if ((mob.lv || 0) >= 70 && allyCount() === 0) a.solo = 1;
      }
    } catch (e) {}
    return r;
  };
  if (typeof window.enhanceRollOutcome === 'function') {
    var _origERO = window.enhanceRollOutcome;
    window.enhanceRollOutcome = function () {
      var o = _origERO.apply(this, arguments);
      if (o === 'break') { try { A().brk++; } catch (e) {} }
      return o;
    };
  }
  if (typeof window.killPlayer === 'function') {
    var _origKP = window.killPlayer;
    window.killPlayer = function () {
      var p = P(), was = p && !p.dead;
      var r = _origKP.apply(this, arguments);
      try { if (was && P() && P().dead) A().die++; } catch (e) {}
      return r;
    };
  }

  // ===== 檢查解鎖 =====
  var _lastP = null;
  function check() {
    var p = P(); if (!p || ff()) return;
    var a = A();
    try { if (p.siege && p.siege.result === 'win') a.siege = 1; } catch (e) {}
    try { if (window.__afkLadder && __afkLadder.amChampion && __afkLadder.amChampion()) a.champ = 1; } catch (e) {}
    var fresh = [];
    ACH.forEach(function (x) {
      if (a.got[x.id]) return;
      var v = 0; try { v = Number(x.v()) || 0; } catch (e) {}
      if (v >= x.need) { a.got[x.id] = Date.now(); fresh.push(x); }
    });
    var first = !a.init; a.init = 1;
    if (!fresh.length) { if (first) refresh(); return; }
    if (!a.t || !a.got[a.t]) {   // 還沒裝稱號 → 自動裝上最稀有的
      var best = null; ACH.forEach(function (x) { if (a.got[x.id] && (!best || x.r >= best.r)) best = x; });
      if (best) a.t = best.id;
    }
    if (first && fresh.length > 1) {
      toast('🏅 補發了 ' + fresh.length + ' 個成就！', '目前稱號「' + (curTitle() ? curTitle().t : '') + '」，點名字旁的稱號可以換');
      log('<span class="text-amber-300 font-bold">🏅 成就系統上線：' + esc(P().name || '這個角色') + ' 補發了 ' + fresh.length + ' 個成就（點職業名旁的稱號查看、換稱號）。</span>');
    } else {
      fresh.forEach(function (x) {
        toast('🏅 成就解鎖：' + x.n, '獲得稱號「' + x.t + '」');
        log('<span class="font-bold" style="color:' + RCOL[x.r] + '">🏅 成就解鎖：' + esc(x.n) + ' → 稱號「' + esc(x.t) + '」</span>');
      });
    }
    try { if (typeof window.saveGame === 'function') window.saveGame(); } catch (e) {}
    refresh();
  }
  function log(html) { try { if (typeof window.logSys === 'function') window.logSys(html); } catch (e) {} }
  var _toastQ = [], _toastOn = false;
  function toast(t1, t2) { _toastQ.push([t1, t2]); if (!_toastOn) nextToast(); }
  function nextToast() {
    var m = _toastQ.shift(); if (!m) { _toastOn = false; return; }
    _toastOn = true;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:14%;left:50%;transform:translateX(-50%);z-index:99990;background:linear-gradient(180deg,rgba(69,26,3,.95),rgba(30,15,5,.95));border:2px solid #f59e0b;border-radius:12px;padding:10px 22px;color:#fde68a;text-align:center;box-shadow:0 0 24px rgba(245,158,11,.55);pointer-events:none;transition:opacity .4s;font-weight:700';
    el.innerHTML = '<div style="font-size:18px">' + esc(m[0]) + '</div><div style="font-size:13px;color:#fef3c7;margin-top:2px">' + esc(m[1]) + '</div>';
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; }, 2600);
    setTimeout(function () { el.remove(); nextToast(); }, 3000);
  }

  // ===== 稱號顯示 =====
  function tagHtml() {
    var t = curTitle();
    return t ? '「' + esc(t.t) + '」' : '🏅成就';
  }
  function tagColor() { var t = curTitle(); return t ? RCOL[t.r] : '#94a3b8'; }
  function refresh() {
    if (!P()) return;
    var host = document.getElementById('st-classname'), hdr = host && host.closest('.panel-header');
    if (hdr) {   // 掛在左欄標題列正下方（標題列已經塞了職業、經典、城主、名字，橫向放不下會把名字擠成兩行）
      var el = document.getElementById('afk-title-tag');
      if (!el) {
        if (getComputedStyle(hdr).position === 'static') hdr.style.position = 'relative';
        el = document.createElement('span'); el.id = 'afk-title-tag';
        el.title = '成就與稱號（點開查看、換稱號）';
        el.style.cssText = 'position:absolute;right:8px;top:-2px;z-index:2;font-size:.72rem;font-weight:700;cursor:pointer;white-space:nowrap;line-height:1.2;text-shadow:0 0 4px #000,0 0 2px #000';
        el.addEventListener('click', function (e) { e.stopPropagation(); openPanel(); });
        hdr.appendChild(el);
      }
      var h1 = tagHtml(); if (el._h !== h1) { el._h = h1; el.innerHTML = h1; el.style.color = tagColor(); }
    }
    var ms = document.querySelector('#m-status .ms-name');
    if (ms) {
      var m = document.getElementById('ms-title');
      if (!m) {
        m = document.createElement('span'); m.id = 'ms-title';
        m.style.cssText = 'font-size:11px;font-weight:700;margin-right:3px;cursor:pointer;white-space:nowrap';
        m.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); openPanel(); });
        var nm = document.getElementById('ms-name'); ms.insertBefore(m, nm || ms.firstChild);
      }
      var t = curTitle(), h2 = t ? '「' + esc(t.t) + '」' : '🏅'; if (m._h !== h2) { m._h = h2; m.innerHTML = h2; m.style.color = tagColor(); }
    }
  }

  // ===== 成就面板 =====
  var MODAL = 'afk-ach-modal';
  function fmtV(x, v) {
    if (x.fmt) return v >= x.need ? '' : (v / 1e8 >= 1 ? (v / 1e8).toFixed(1) + ' 億' : Math.floor(v / 1e4) + ' 萬') + ' / ' + x.fmt;
    if (x.need <= 1) return '';
    return Math.min(v, x.need) + ' / ' + x.need;
  }
  function openPanel() {
    var a = A(); if (!a) return;
    var old = document.getElementById(MODAL); if (old) old.remove();
    var got = ACH.filter(function (x) { return a.got[x.id]; }).length;
    var html = '<div style="max-width:560px;width:calc(100% - 24px);max-height:86vh;overflow:auto;background:#0f172a;border:2px solid #b45309;border-radius:12px;padding:14px;color:#e2e8f0">' +
      '<div class="flex items-center justify-between mb-2"><div class="text-lg font-bold" style="color:#fbbf24">🏅 成就與稱號 <span class="text-sm text-slate-400">' + got + ' / ' + ACH.length + '</span></div>' +
      '<button data-x="1" class="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm">關閉</button></div>' +
      '<div class="text-sm mb-3">目前稱號：' + (curTitle() ? '<b style="color:' + RCOL[curTitle().r] + '">「' + esc(curTitle().t) + '」</b> <button data-t="" class="ml-2 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs">不顯示稱號</button>' : '<span class="text-slate-400">（沒有）</span>') +
      '<div class="text-xs text-slate-400 mt-1">稱號會顯示在名字旁邊和天梯排行榜上，只是好看，不加能力。</div></div>';
    GROUPS.forEach(function (g) {
      var list = ACH.filter(function (x) { return x.g === g; }); if (!list.length) return;
      html += '<div class="font-bold text-amber-200 mt-2 mb-1">' + g + '</div>';
      list.forEach(function (x) {
        var ok = !!a.got[x.id], v = 0; try { v = Number(x.v()) || 0; } catch (e) {}
        var on = a.t === x.id;
        html += '<div class="flex items-center gap-2 rounded p-2 mb-1" style="background:' + (ok ? 'rgba(30,41,59,.9)' : 'rgba(15,23,42,.6)') + ';border:1px solid ' + (on ? '#f59e0b' : '#334155') + ';opacity:' + (ok ? 1 : 0.7) + '">' +
          '<div style="width:22px;text-align:center">' + (ok ? '✔' : '🔒') + '</div>' +
          '<div class="flex-1"><div class="font-bold">' + esc(x.n) + ' <span style="color:' + RCOL[x.r] + '">「' + esc(x.t) + '」</span></div>' +
          '<div class="text-xs text-slate-400">' + esc(x.d || x.n) + (ok ? '' : (fmtV(x, v) ? '　<span class="text-cyan-300">' + fmtV(x, v) + '</span>' : '')) + '</div></div>' +
          (ok ? (on ? '<span class="text-xs text-amber-300 font-bold">使用中</span>' : '<button data-t="' + x.id + '" class="px-2 py-1 rounded text-xs font-bold" style="background:#92400e;color:#fef3c7">裝上</button>') : '') +
          '</div>';
      });
    });
    html += '</div>';
    var m = document.createElement('div'); m.id = MODAL;
    m.style.cssText = 'position:fixed;inset:0;z-index:99980;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center';
    m.innerHTML = html;
    m.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b && b.hasAttribute('data-t')) { setTitle(b.getAttribute('data-t')); openPanel(); return; }
      if ((b && b.hasAttribute('data-x')) || e.target === m) m.remove();
    });
    document.body.appendChild(m);
  }
  var _pushT = null;
  function setTitle(id) {
    var a = A(); if (!a) return;
    if (id && !a.got[id]) return;
    a.t = id || '';
    refresh();
    try { if (typeof window.saveGame === 'function') window.saveGame(); } catch (e) {}
    clearTimeout(_pushT);   // 天梯排行榜上的稱號：停手 15 秒後才上傳一次（避免連點換稱號狂寫）
    _pushT = setTimeout(function () { try { window.__afkLadder && __afkLadder.pushNow && __afkLadder.pushNow(); } catch (e) {} }, 15000);
  }

  // updateUI 會重畫左欄 → 之後補上稱號
  if (typeof window.updateUI === 'function') {
    var _origUU = window.updateUI;
    window.updateUI = function () { var r = _origUU.apply(this, arguments); try { refresh(); } catch (e) {} return r; };
  }
  setInterval(function () { try { var p = P(); if (p !== _lastP) { _lastP = p; refresh(); } check(); } catch (e) { console.warn('[AFK-achieve]', e); } }, 3000);

  window.afkAchOpen = openPanel;
  window.__afkAch = { ACH: ACH, check: check, data: A, setTitle: setTitle, refresh: refresh };
  console.log('[AFK-achieve] hooks OK');
})();
