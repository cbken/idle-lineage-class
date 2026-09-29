/* ============================================================================
 * afk-perfdiag.js — 🩺 效能檢測（站主 2026-09-29：「開動畫很不順，我哥頂規電腦就很順」）
 *
 * 目的：卡頓只在站主那台（i5-6500＋RTX 3050）重現，開發機模擬不出來 → 讓玩家在自己電腦上
 *       按一下、錄 30 秒，當場列出「幀數／卡頓／每一塊各吃多少時間」，截圖回報就能對症修。
 *
 * 量什麼（全部只讀、量完自動還原，不動存檔、不改遊戲結果）：
 *   ① 幀數：requestAnimationFrame 間隔 → 平均 fps、>50ms / >100ms 卡頓次數、最長一幀
 *   ② 長動畫幀（Chrome 的 long-animation-frame）：每個卡頓幀裡「程式／排版樣式／繪製」各花多久，
 *      以及是哪支程式檔觸發的（不支援的瀏覽器改用 longtask，只有總長）
 *   ③ 各區塊耗時：暫時包住遊戲的畫面函式（戰鬥主迴圈、怪物動畫、寵物動畫、傭兵面板、背包分頁、
 *      狀態列、戰鬥日誌、特效…）量「含內部呼叫」的累計毫秒，30 秒後原樣換回
 *   ④ 環境：瀏覽器、CPU 執行緒數、螢幕與視窗大小、縮放比例(devicePixelRatio)、畫面元素數、顯示模式、特效開關
 *
 * 入口：遊戲畫面左下角小按鈕「🩺」（設定可關）；也可在 console 呼叫 AFK_PERFDIAG.run()。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.AFK_TOGGLES) AFK_TOGGLES.register({
    id: 'perfdiag', name: '效能檢測按鈕', group: '系統與其他', def: true,
    desc: '遊戲畫面左下角的 🩺：按下錄 30 秒，列出幀數、卡頓與各區塊耗時，方便回報「哪裡卡」'
  });
  function enabled() { return !window.AFK_TOGGLES || AFK_TOGGLES.enabled('perfdiag'); }

  var SECS = 30;
  // [顯示名稱, 全域函式名]；缺的會自動略過
  var TARGETS = [
    ['戰鬥主迴圈（含全部）', 'tick'],
    ['畫面更新（每跳）', 'flushTickRender'],
    ['介面數值更新', 'updateUI'],
    ['怪物畫面重繪', '_renderMobsImpl'],
    ['怪物動畫幀', '_mobAnimApply'],
    ['寵物動畫幀', '_petAnimApply'],
    ['召喚物面板', 'renderSummonPanel'],
    ['傭兵隊伍面板', 'renderSquadPanel'],
    ['傭兵行動', 'alliesTick'],
    ['背包/裝備分頁', 'renderTabs'],
    ['狀態列/狀態圖示', 'renderStatusEffects'],
    ['戰鬥日誌', 'logCombat'],
    ['系統日誌', 'logSys'],
    ['傷害數字/特效', '_vfxFlush'],
    ['擊殺結算', 'killMob'],
    ['取得物品', 'gainItem']
  ];
  var running = false;

  function envInfo() {
    var tm = null, vfx = null; try { tm = localStorage.getItem('afk_tm_mode'); vfx = localStorage.getItem('lineage_vfx_off'); } catch (e) {}
    var ua = navigator.userAgent, m = ua.match(/(Edg|Chrome|Firefox|Version)\/([\d.]+)/);
    return {
      browser: (m ? m[1].replace('Version', 'Safari') + ' ' + m[2].split('.')[0] : ua.slice(0, 40)) + (/Windows/.test(ua) ? '／Windows' : /Mac/.test(ua) ? '／Mac' : /Android/.test(ua) ? '／Android' : /iPhone|iPad/.test(ua) ? '／iOS' : ''),
      cores: navigator.hardwareConcurrency || '?',
      screen: screen.width + '×' + screen.height,
      win: window.innerWidth + '×' + window.innerHeight,
      dpr: window.devicePixelRatio,
      nodes: document.getElementsByTagName('*').length,
      anims: document.getAnimations ? document.getAnimations().length : '?',
      mode: tm === 'text' ? '文字版' : tm === 'log' ? '只留日誌' : '完整版',
      vfx: vfx === '1' ? '關' : '開',
      map: (typeof mapState !== 'undefined' && mapState) ? mapState.current : '?',
      allies: (typeof player !== 'undefined' && player && player.allies) ? player.allies.filter(Boolean).length : '?'
    };
  }

  function run(onDone) {
    if (running) return; running = true;
    var t0 = performance.now(), frames = 0, last = t0, gaps = [], maxGap = 0, stopRaf = false;
    function raf(t) { if (stopRaf) return; frames++; var g = t - last; if (g > 50) gaps.push(g); if (g > maxGap) maxGap = g; last = t; requestAnimationFrame(raf); }
    requestAnimationFrame(raf);

    // ② 長動畫幀
    var loaf = { n: 0, total: 0, script: 0, layout: 0, render: 0, bySrc: {} }, lt = { n: 0, total: 0 }, obs = [];
    try {
      var o1 = new PerformanceObserver(function (l) {
        l.getEntries().forEach(function (e) {
          loaf.n++; loaf.total += e.duration;
          var sl = e.styleAndLayoutStart ? (e.startTime + e.duration - e.styleAndLayoutStart) : 0;
          var rs = e.renderStart ? (e.startTime + e.duration - e.renderStart) : 0;
          loaf.layout += sl; loaf.render += Math.max(0, rs - sl);
          (e.scripts || []).forEach(function (s) {
            loaf.script += s.duration;
            var src = (s.sourceURL || '').split('/').pop().split('?')[0] || '(inline)';
            var k = src + (s.sourceFunctionName ? ' ' + s.sourceFunctionName : '') + (s.invokerType ? ' [' + s.invokerType + ']' : '');
            loaf.bySrc[k] = (loaf.bySrc[k] || 0) + s.duration;
          });
        });
      });
      o1.observe({ type: 'long-animation-frame', buffered: false }); obs.push(o1); loaf.ok = true;
    } catch (e) { loaf.ok = false; }
    try { var o2 = new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { lt.n++; lt.total += e.duration; }); }); o2.observe({ type: 'longtask', buffered: false }); obs.push(o2); } catch (e) {}

    // ③ 包住畫面函式（量完原樣換回）
    var acc = {}, wrapped = [];
    TARGETS.forEach(function (tg) {
      var name = tg[1], f = window[name];
      if (typeof f !== 'function') return;
      acc[name] = { label: tg[0], ms: 0, n: 0 };
      var a = acc[name];
      var w = function () { var s = performance.now(); try { return f.apply(this, arguments); } finally { a.ms += performance.now() - s; a.n++; } };
      for (var k in f) { try { w[k] = f[k]; } catch (e) {} }   // 保留掛在函式上的屬性（例如 renderTabs._sig）
      try { window[name] = w; wrapped.push([name, f, w]); } catch (e) {}
    });

    showProgress();
    setTimeout(function () {
      stopRaf = true;
      obs.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
      wrapped.forEach(function (x) {
        // 期間若有其他外掛又包了一層，就不要硬換回（避免把別人的包裝拆掉），只停止累計
        if (window[x[0]] === x[2]) { for (var k in x[2]) { try { x[1][k] = x[2][k]; } catch (e) {} } window[x[0]] = x[1]; }
      });
      running = false;
      var el = (performance.now() - t0) / 1000;
      var res = {
        env: envInfo(), secs: el,
        fps: frames / el, stutter50: gaps.length, stutter100: gaps.filter(function (g) { return g > 100; }).length, maxGap: maxGap,
        loaf: loaf, lt: lt,
        parts: Object.keys(acc).map(function (k) { return acc[k]; }).filter(function (a) { return a.n > 0; }).sort(function (x, y) { return y.ms - x.ms; })
      };
      hideProgress(); showResult(res);
      if (onDone) try { onDone(res); } catch (e) {}
    }, SECS * 1000);
  }

  // ── UI ──
  function box(html, id) {
    var old = document.getElementById(id); if (old) old.remove();
    var w = document.createElement('div'); w.id = id;
    w.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:14px';
    w.innerHTML = '<div style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:12px;max-width:620px;width:100%;max-height:86vh;overflow:auto;padding:14px 16px;font-size:13px;line-height:1.5">' + html + '</div>';
    document.body.appendChild(w); return w;
  }
  var progTimer = null;
  function showProgress() {
    var left = SECS;
    var p = document.createElement('div'); p.id = 'afk-pd-prog';
    p.style.cssText = 'position:fixed;left:8px;bottom:44px;z-index:100002;background:#0f172a;color:#fcd34d;border:1px solid #334155;border-radius:8px;padding:6px 10px;font-size:13px;pointer-events:none';
    document.body.appendChild(p);
    var upd = function () { p.textContent = '🩺 效能檢測中… 請照平常玩法操作（剩 ' + left + ' 秒）'; left--; };
    upd(); progTimer = setInterval(upd, 1000);
  }
  function hideProgress() { clearInterval(progTimer); var p = document.getElementById('afk-pd-prog'); if (p) p.remove(); }
  function f0(x) { return Math.round(x).toLocaleString(); }
  function textReport(r) {
    var e = r.env, L = [];
    L.push('🩺 效能檢測 ' + new Date().toLocaleString('zh-TW', { hour12: false }) + '（' + r.secs.toFixed(0) + ' 秒）');
    L.push('環境：' + e.browser + '｜CPU 執行緒 ' + e.cores + '｜螢幕 ' + e.screen + '｜視窗 ' + e.win + '｜縮放 ' + e.dpr + '｜元素 ' + e.nodes + '｜動畫 ' + e.anims);
    L.push('設定：' + e.mode + '｜戰鬥特效 ' + e.vfx + '｜地圖 ' + e.map + '｜傭兵 ' + e.allies);
    L.push('幀數 ' + r.fps.toFixed(1) + ' fps｜卡頓 >50ms ' + r.stutter50 + ' 次、>100ms ' + r.stutter100 + ' 次｜最長一幀 ' + f0(r.maxGap) + 'ms');
    if (r.loaf.ok) L.push('卡頓幀合計 ' + f0(r.loaf.total) + 'ms（程式 ' + f0(r.loaf.script) + '／排版樣式 ' + f0(r.loaf.layout) + '／繪製 ' + f0(r.loaf.render) + '），共 ' + r.loaf.n + ' 幀');
    else L.push('長任務 ' + r.lt.n + ' 次、共 ' + f0(r.lt.total) + 'ms（此瀏覽器不支援細分）');
    L.push('各區塊耗時（毫秒／次數，含內部呼叫）：');
    r.parts.forEach(function (p) { L.push('  ' + p.label + '：' + f0(p.ms) + 'ms／' + p.n + ' 次'); });
    if (r.loaf.ok) {
      var top = Object.keys(r.loaf.bySrc).map(function (k) { return [k, r.loaf.bySrc[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
      if (top.length) { L.push('卡頓幀裡最花時間的程式：'); top.forEach(function (t) { L.push('  ' + f0(t[1]) + 'ms  ' + t[0]); }); }
    }
    return L.join('\n');
  }
  function showResult(r) {
    var txt = textReport(r);
    var verdict = r.fps >= 50 && r.stutter100 <= 3 ? '✅ 這 30 秒算順' : (r.fps >= 30 ? '⚠️ 有明顯卡頓' : '🔴 很卡');
    var w = box('<div style="font-size:16px;font-weight:800;margin-bottom:6px">🩺 效能檢測結果　' + verdict + '</div>' +
      '<pre id="afk-pd-txt" style="white-space:pre-wrap;word-break:break-all;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;font-size:12px;margin:0"></pre>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button id="afk-pd-copy" class="btn" style="padding:4px 10px">複製文字</button><button id="afk-pd-close" class="btn" style="padding:4px 12px">關閉</button></div>' +
      '<div style="color:#94a3b8;font-size:12px;margin-top:6px">截圖或按「複製文字」貼給開發者即可。</div>', 'afk-pd-result');
    document.getElementById('afk-pd-txt').textContent = txt;
    document.getElementById('afk-pd-close').onclick = function () { w.remove(); };
    document.getElementById('afk-pd-copy').onclick = function () { try { navigator.clipboard.writeText(txt); this.textContent = '已複製 ✅'; } catch (e) { this.textContent = '請手動截圖'; } };
    w.addEventListener('click', function (ev) { if (ev.target === w) w.remove(); });
  }
  function addButton() {
    if (!enabled() || document.getElementById('afk-pd-btn')) return;
    var b = document.createElement('button');
    b.id = 'afk-pd-btn'; b.type = 'button'; b.textContent = '🩺'; b.title = '效能檢測（錄 30 秒，列出哪裡卡）';
    b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;width:30px;height:30px;border-radius:50%;border:1px solid #475569;background:rgba(15,23,42,.85);color:#fff;font-size:15px;line-height:1;cursor:pointer;opacity:.75';
    b.onclick = function () {
      if (running) return;
      if (!confirm('開始效能檢測？\n接下來 30 秒請照平常的玩法（動畫全開、正在打怪），檢測完會跳出結果。')) return;
      run();
    };
    document.body.appendChild(b);
  }
  window.AFK_PERFDIAG = { run: run, report: textReport };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton); else addButton();
  console.log('[AFK-perfdiag] hooks OK');
})();
