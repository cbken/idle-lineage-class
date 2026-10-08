/*
 * afk-ladder.js — 🗼 無限天梯（站主 2026-10-04 拍板，設計稿見 cloudsave repo docs/天梯設計-v1.md）
 *
 * 入口：傲慢之塔入口浮動視窗底部加「🗼 無限天梯」鈕 → 天梯面板（紀錄／開始／商店／排行榜）。
 * 玩法：帶整隊進專屬地圖 afk_ladder，一層一場、600 tick（60 秒）內清光就上樓（間隔 3 秒、回 20% 血魔），
 *       時間到／本人倒下／撤退＝結束，記最高樓層＋該層用時；死亡零損失。
 * 地圖 id 刻意不放進 DB.maps：核心 spawnMob 找不到怪池直接 return（不自然生怪）、afk-offline 也不做離線結算
 *   （只在線上爬，掛機不能刷榜）；loadGame 一律回村，存到 afk_ladder 也無害（同木人場）。
 * 樓層怪：沿用遊戲現有的怪（照樓層等級挑、同樓層兩個玩家永遠同一批＝排行公平），HP 由本檔公式覆寫；
 *   怪物傷害走核心單一入口 riftDamageMult()（物理/魔法/打傭兵/寵物/召喚全吃）。
 * 特殊層（每 25 層）：免疫物理／免疫魔法／反傷 20%，用核心 _reflectWall＋包 reflectWallOnDamage 實作。
 * 獎勵（全部綁定：不能賣、不能進倉庫、黑市不收）：
 *   ① 天梯魔眼 4 款（25/50/75/100 樓首通）＋魔眼強化石（+1 必成、上限 +10；en 欄位核心對 eye 不用，拿來當魔眼等級）
 *   ② 不爆強化卷（強化武器/防具時勾選；失敗改成「沒反應」，見 enhanceRollOutcome 包裝）
 *   ③ 遺物詞綴重抽石（抄 afk-relicaffix 的骰法，祝福 50%、遠古系 50%）
 *   ④ 天梯幣＋商店
 *   ⑤ 週冠軍（上週最高樓層的玩家）：該玩家所有角色經驗 +10%、掉寶 ×1.1
 * 排行榜：Worker /ladder（同雲端存檔的家族金鑰），只在破紀錄時寫一筆；讀取快取 60 秒。
 * 🗓️ 每週詞綴（站主 2026-10-08「有趣的玩法再做進去」）：每週一（台灣時間 ISO 週）依週次決定論抽 2 個刁難＋1 個好處，
 *   兩個玩家同一組；週榜＝本週最高樓層（Worker 早就按週存 wks，不用改 Worker）。
 *   週目標：本週通過 20/40/60/80 層各領一次（WK_GOALS），每週重置。
 */
(function () {
  'use strict';
  if (window.AFK_TOGGLES && !AFK_TOGGLES.enabled('ladder')) return;

  function ready() {
    return typeof mapState !== 'undefined' && typeof DB !== 'undefined' && DB.mobs && DB.items &&
      typeof window.tick === 'function' && typeof window.killMob === 'function' &&
      typeof window.killPlayer === 'function' && typeof window.uid === 'function' &&
      typeof window.newMobStatus === 'function' && typeof window.gainItem === 'function';
  }
  if (!ready()) { console.warn('[AFK-ladder] 缺少核心函式，停用'); return; }

  // ===== 常數 =====
  var LADDER_MAP = 'afk_ladder';
  var LADDER_BG = 'assets/area/1920x1080/新兵修練場.jpg';
  var FLOOR_TICKS = 600;            // 每層時限 60 秒
  var GAP_TICKS = 30;               // 上樓前喘息 3 秒
  var GAP_HEAL = 0.2;               // 喘息回 20% 血魔
  var START_BACK = 9;               // 「從高樓層開始」＝最高紀錄 −9（例如最高 37 → 從 28 開始）
  var SPECIAL_EVERY = 25;
  var BOARD_EP = 'https://idle-lineage-cloudsave.cbken.workers.dev/ladder';
  var BOARD_CACHE_KEY = 'afk_ladder_board';
  var BOARD_TTL = 60000;
  var WRITE_CAP_KEY = 'afk_ladder_wq';
  var WRITE_CAP = 20;
  var COIN_DAY_CAP = 60;            // 每個角色每天最多拿的天梯幣（Ken 10/4：不設上限一小時可刷 10 張不爆卷，強化就沒意義了）
  // 難度曲線（平衡用，集中在這裡調）
  var BOSS_HP_AT_50 = 1700000;      // 第 50 層頭目血量（10/4 實測：玩家1 王族＋7 傭兵 約每分鐘 325 萬傷害 → 卡在 60 層左右）
  var HP_GROWTH_LOW = 1.147;        // 1~50 層每層血量 ×1.147
  var HP_GROWTH = 1.08;             // 50 層以後每層血量 ×1.08
  var DMG_GROWTH = 1.05;            // 第 40 層以後怪物傷害每層 ×1.05
  var NORMAL_HP_SHARE = 1 / 6;      // 一般層每隻怪＝同層頭目血量 1/6（共 3 隻）

  // ===== 🗓️ 每週詞綴 =====
  var AFFIXES = {
    fury:     { k: 'hard',  n: '狂暴',   d: '怪物傷害 ×1.3' },
    bulk:     { k: 'hard',  n: '肉盾',   d: '怪物血量 ×1.6，每層時限 +20 秒' },
    rush:     { k: 'hard',  n: '急行',   d: '每層時限只有 40 秒' },
    nobreath: { k: 'hard',  n: '連戰',   d: '上樓時不回血魔' },
    regen:    { k: 'hard',  n: '再生',   d: '怪物每秒回復 0.5% 血量' },
    hide:     { k: 'hard',  n: '硬皮',   d: '所有怪物 物理／魔法 抗性 40%' },
    thorns:   { k: 'hard',  n: '荊棘',   d: '所有怪物反彈 10% 傷害給你（每秒最多扣 1.5% 血）' },
    bossrush: { k: 'hard',  n: '頭目潮', d: '每 5 層就是一隻頭目（原本每 10 層）' },
    valor:    { k: 'bonus', n: '鬥志',   d: '隊伍對天梯怪的傷害 +20%' },
    breath:   { k: 'bonus', n: '喘息',   d: '上樓時回 50% 血魔（原本 20%）' },
    calm:     { k: 'bonus', n: '從容',   d: '每層時限 +20 秒' }
  };
  var WK_GOALS = [   // 本週通過這些樓層各領一次（每週重置）
    { f: 20, id: 'afk_ladder_protect', n: 1 },
    { f: 40, id: 'afk_ladder_reroll', n: 1 },
    { f: 60, id: 'afk_ladder_eyestone', n: 2 },
    { f: 80, id: 'afk_ladder_protect', n: 2 }
  ];
  var HIDE_PCT = 0.4, THORNS_PCT = 0.1, THORNS_CAP_PER_TICK = 0.0015, REGEN_PER_TICK = 0.0005;   // 再生每秒 0.5%（1% 時 50 層頭目永遠打不死，10/8 實測）
  var _forceAffix = null;   // 測試用：__afkLadder.forceAffixes([...])
  function strHash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function weekAffixes(wk) {
    if (_forceAffix) return _forceAffix.slice();
    var r = rng(strHash('afk-ladder-affix|' + (wk || weekId())));
    var hard = Object.keys(AFFIXES).filter(function (k) { return AFFIXES[k].k === 'hard'; });
    var bonus = Object.keys(AFFIXES).filter(function (k) { return AFFIXES[k].k === 'bonus'; });
    var a = hard.splice(Math.floor(r() * hard.length), 1)[0];
    if (a === 'rush') hard = hard.filter(function (k) { return k !== 'bulk'; });   // 急行＋肉盾 時限互相抵消，不同週出
    if (a === 'bulk') hard = hard.filter(function (k) { return k !== 'rush'; });
    var b = hard[Math.floor(r() * hard.length)];
    var c = bonus[Math.floor(r() * bonus.length)];
    return [a, b, c];
  }
  var _affixCache = { wk: '', list: [] };
  function curAffixes() {   // 一輪開始時鎖定（跨週一凌晨爬到一半不會突然換規則）
    if (run && run.affix) return run.affix;
    var wk = weekId();
    if (_affixCache.wk !== wk || _forceAffix) _affixCache = { wk: wk, list: weekAffixes(wk) };
    return _affixCache.list;
  }
  function wkHas(id) { return curAffixes().indexOf(id) >= 0; }
  function floorTicks() { return FLOOR_TICKS + (wkHas('bulk') ? 200 : 0) + (wkHas('calm') ? 200 : 0) - (wkHas('rush') ? 200 : 0); }
  function affixLine(ids, html) {
    return ids.filter(function (k) { return AFFIXES[k]; }).map(function (k) { var a = AFFIXES[k]; return html ? '<span style="color:' + (a.k === 'bonus' ? '#86efac' : '#fca5a5') + '">' + (a.k === 'bonus' ? '✚' : '✖') + esc(a.n) + '</span>' : a.n; }).join(html ? ' ' : '、');
  }

  var CLS_NAME = { knight: '騎士', royal: '王族', warrior: '戰士', elf: '妖精', mage: '法師', dark: '黑暗妖精', illusion: '幻術士', dragon: '龍騎士' };

  // ===== 物品 =====
  var EYE_IDS = ['afk_eye_hawk', 'afk_eye_unyield', 'afk_eye_devour', 'afk_eye_king'];
  var EYE_AT = { 25: 'afk_eye_hawk', 50: 'afk_eye_unyield', 75: 'afk_eye_devour', 100: 'afk_eye_king' };
  var NEW_ITEMS = {
    afk_ladder_protect: { n: '天梯．不爆強化卷', type: 'etc', p: 0, c: 'text-cyan-300', noSell: true, noJunk: true, gachaWeight: 0,
      d: '強化武器或防具時勾選「使用不爆強化卷」：失敗時裝備不會消失（每次失敗消耗 1 張）。' },
    afk_ladder_reroll: { n: '天梯．遺物詞綴重抽石', type: 'etc', eff: 'afk_ladder_reroll', p: 0, c: 'text-cyan-300', noSell: true, noJunk: true, gachaWeight: 0,
      d: '選一件遺物，重新抽祝福與遠古系詞綴（各 50%，原本的會被取代）。' },
    afk_ladder_eyestone: { n: '天梯．魔眼強化石', type: 'etc', eff: 'afk_ladder_eyestone', p: 0, c: 'text-cyan-300', noSell: true, noJunk: true, gachaWeight: 0,
      d: '讓一顆天梯魔眼 +1（必定成功，最高 +10）。' },
    afk_eye_hawk: { n: '鷹之魔眼', type: 'acc', slot: 'eye', req: 'all', safe: 0, noEnhance: true, maxEn: 10, legend: true, p: 0, noSell: true, noJunk: true, gachaWeight: 0,
      d: '命中 +3、暴擊率 +2%（每 +1：命中 +1、暴擊率 +0.5%）。無限天梯 25 層首通獎勵。' },
    afk_eye_unyield: { n: '不屈魔眼', type: 'acc', slot: 'eye', req: 'all', safe: 0, noEnhance: true, maxEn: 10, legend: true, p: 0, noSell: true, noJunk: true, gachaWeight: 0,
      d: '受到致命傷害時留下 1 HP，冷卻 300 秒（每 +1 冷卻 −15 秒）。無限天梯 50 層首通獎勵。' },
    afk_eye_devour: { n: '吞噬魔眼', type: 'acc', slot: 'eye', req: 'all', safe: 0, noEnhance: true, maxEn: 10, legend: true, p: 0, noSell: true, noJunk: true, gachaWeight: 0,
      d: '隊伍對頭目造成傷害的 1% 回復你的 HP（每 +1 再 +0.2%）。無限天梯 75 層首通獎勵。' },
    afk_eye_king: { n: '天梯王魔眼', type: 'acc', slot: 'eye', req: 'all', safe: 0, noEnhance: true, maxEn: 10, legend: true, p: 0, noSell: true, noJunk: true, gachaWeight: 0,
      d: '隊伍對頭目的傷害 +15%（每 +1 再 +1%）。無限天梯 100 層首通獎勵。' }
  };
  Object.keys(NEW_ITEMS).forEach(function (id) { if (!DB.items[id]) DB.items[id] = NEW_ITEMS[id]; });
  try { if (typeof WH_NO_STORE !== 'undefined' && WH_NO_STORE.push) Object.keys(NEW_ITEMS).forEach(function (id) { if (WH_NO_STORE.indexOf(id) < 0) WH_NO_STORE.push(id); }); } catch (e) {}

  var SHOP = [
    { id: 'afk_ladder_protect', cost: 60 },
    { id: 'afk_ladder_reroll', cost: 80 },
    { id: 'afk_ladder_eyestone', cost: 50 }
  ];

  // ===== 小工具 =====
  function inLadder() { return typeof mapState !== 'undefined' && mapState && mapState.current === LADDER_MAP; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function log(html) { try { if (typeof window.logSys === 'function') window.logSys(html); } catch (e) {} }
  function ff() { return typeof state !== 'undefined' && state && state.ff; }
  function rng(seed) {   // mulberry32：同樓層永遠同一批怪
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function weekId(ms) {   // ISO 週（台灣時間）：'2026-W40'
    var d = new Date((ms || Date.now()) + 8 * 3600000);
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    var w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
    return t.getUTCFullYear() + '-W' + (w < 10 ? '0' : '') + w;
  }
  function prevWeekId() { return weekId(Date.now() - 7 * 86400000); }
  function data() {   // 每個角色自己的天梯資料（跟著存檔走）
    if (typeof player === 'undefined' || !player || !player.cls) return null;
    var L = player.ladder;
    if (!L || typeof L !== 'object') L = player.ladder = {};
    if (!(L.best >= 0)) L.best = 0;
    if (!(L.bestT >= 0)) L.bestT = 0;
    if (!(L.first >= 0)) L.first = 0;     // 已領過首通獎勵的最高樓層
    if (!(L.coins >= 0)) L.coins = 0;
    if (!(L.runs >= 0)) L.runs = 0;
    if (!L.wk || typeof L.wk !== 'object') L.wk = { id: '', f: 0 };
    var today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    if (L.coinDay !== today) { L.coinDay = today; L.coinToday = 0; }
    return L;
  }
  function cloudKey() { try { return localStorage.getItem('afk_cs_key') || ''; } catch (e) { return ''; } }
  function cloudSlot() { try { return localStorage.getItem('afk_cs_slot') || ''; } catch (e) { return ''; } }
  function itemCount(id) { var n = 0; ((player && player.inv) || []).forEach(function (i) { if (i && i.id === id) n += (i.cnt || 1); }); return n; }
  function takeItem(id, n) {
    n = n || 1;
    for (var k = 0; k < player.inv.length && n > 0; k++) {
      var it = player.inv[k]; if (!it || it.id !== id) continue;
      var use = Math.min(n, it.cnt || 1); it.cnt = (it.cnt || 1) - use; n -= use;
    }
    player.inv = player.inv.filter(function (i) { return i && !(i.cnt <= 0); });
    return n === 0;
  }
  function refreshUi() { try { if (typeof window.calcStats === 'function') window.calcStats(); } catch (e) {} try { if (typeof window.renderTabs === 'function') window.renderTabs(true); } catch (e) {} try { if (typeof window.updateUI === 'function') window.updateUI(); } catch (e) {} }
  function save() { try { if (player && player.cls && typeof window.saveGame === 'function') window.saveGame(); } catch (e) {} }

  // ===== 樓層怪池 =====
  var POOLS = null;
  function buildPools() {
    var inMaps = {};
    Object.keys(DB.maps || {}).forEach(function (k) { (DB.maps[k] || []).forEach(function (id) { inMaps[id] = 1; }); });
    var normals = [], bosses = [];
    Object.keys(inMaps).sort().forEach(function (id) {
      var m = DB.mobs[id];
      if (!m || !m.lv || !m.hp) return;
      if (m.transformTo || m.siegeEnemy || m.race === '血盟' || m.race === '建築' || /^ant_antharas/.test(id)) return;
      (m.boss ? bosses : normals).push(id);
    });
    POOLS = { normals: normals, bosses: bosses };
  }
  function pickFrom(list, lv, r, win) {
    var c = [];
    for (var w = win; c.length === 0 && w <= 60; w += 5) c = list.filter(function (id) { var l = DB.mobs[id].lv; return l <= lv && l >= lv - w; });
    if (!c.length) c = list.slice();
    return c[Math.floor(r() * c.length)];
  }
  function floorLv(f) { return Math.min(99, 30 + f); }
  // 50 層前陡（每層 ×1.147：第 1 層一般怪只有幾百血，單人也打得動）、50 層後緩（×1.08）
  function bossHp(f) { return Math.max(300, Math.round(BOSS_HP_AT_50 * Math.pow(f <= 50 ? HP_GROWTH_LOW : HP_GROWTH, f - 50))); }
  function dmgMult(f) { return f <= 40 ? 1 : Math.pow(DMG_GROWTH, f - 40); }
  function specialOf(f) { return (f % SPECIAL_EVERY === 0) ? ['phys', 'magic', 'reflect'][((f / SPECIAL_EVERY) - 1) % 3] : null; }
  var SPECIAL_NAME = { phys: '物理抗性 80%', magic: '魔法抗性 80%', reflect: '反傷' };
  var RESIST_PCT = 0.8;   // 全免疫的話單人物理職業永遠過不了 25 層（10/4 實測 5 個物理職業全卡 24），改成擋 80%
  var REFLECT_PCT = 0.2, REFLECT_CAP_PER_TICK = 0.003;   // 反傷：每下反彈 20%，但每拍最多扣本人最大 HP 的 0.3%（每秒 3%；不設上限的話全隊打下去本人瞬間蒸發，換誰都過不了）
  var reflectTick = -1, reflectUsed = 0;
  function floorSpec(f) {
    if (!POOLS) buildPools();
    var r = rng(f * 7919 + 13), lv = floorLv(f), boss = (f % 10 === 0) || (wkHas('bossrush') && f % 5 === 0);
    var ids = boss ? [pickFrom(POOLS.bosses, lv, r, 8)] : [pickFrom(POOLS.normals, lv, r, 6), pickFrom(POOLS.normals, lv, r, 6), pickFrom(POOLS.normals, lv, r, 6)];
    return { f: f, boss: boss, ids: ids, hp: boss ? bossHp(f) : Math.max(100, Math.round(bossHp(f) * NORMAL_HP_SHARE)), sp: specialOf(f) };
  }

  // ===== 一輪的狀態（不存檔；重新整理＝這輪作廢，紀錄已即時寫進 player.ladder） =====
  var run = null;   // { start, floor, floorAt, nextAt, cleared, backup, startMs }
  var SAFE_MS = { current: 'town_pride', mobs: [null, null, null, null, null], targetIdx: -1, spawnAt: [null, null, null, null, null], forceBoss: false, suppressSiegeBoss: false };
  function swapAllKeys(target, src) { var k; for (k in target) { if (!(k in src)) delete target[k]; } for (k in src) target[k] = src[k]; }

  function spawnFloor(f) {
    var spec = floorSpec(f);
    if (wkHas('bulk')) spec.hp = Math.round(spec.hp * 1.6);
    mapState.mobs = [null, null, null, null, null];
    mapState.spawnAt = [null, null, null, null, null];
    var slotsIdx = spec.boss ? [1] : [1, 0, 2];
    spec.ids.forEach(function (id, i) {
      var base = DB.mobs[id]; if (!base) return;
      var inst = Object.assign({}, base, {
        hp: spec.hp, curHp: spec.hp, uid: window.uid(),
        _born: (typeof _mobBornSeq !== 'undefined') ? ++_mobBornSeq : Date.now(), _bornMs: Date.now(),
        _magCd: {}, justHit: false, st: window.newMobStatus(),
        exp: 0, goldMin: 0, goldMax: 0, _ladder: true
      });
      if (spec.f > 70) { inst.ac = (inst.ac || 0) - Math.floor((spec.f - 70) / 2); inst.mr = (inst.mr || 0) + (spec.f - 70); }
      if (spec.sp) { inst._ladderSp = spec.sp; inst._reflectWall = { kind: 'ladder', until: 1e15, block: true }; }
      if (wkHas('hide') || wkHas('thorns')) { inst._ladderWk = true; if (!inst._reflectWall) inst._reflectWall = { kind: 'ladder', until: 1e15, block: true }; }
      if (base.hard && typeof window.initHardSkin === 'function') window.initHardSkin(inst);
      mapState.mobs[slotsIdx[i]] = inst;
    });
    mapState.targetIdx = -1;
    run.floor = f; run.floorAt = state.ticks; run.nextAt = 0; run.floorTicks = floorTicks();
    if (!ff()) {
      log('<span class="text-cyan-300 font-bold">🗼 無限天梯 第 ' + f + ' 層' + (spec.boss ? '（頭目）' : '') + (spec.sp ? '｜<span class="text-red-300">' + SPECIAL_NAME[spec.sp] + '</span>' : '') + '</span>');
      try { window.renderMobs(); } catch (e) {}
    }
  }

  function ladderMobsAlive() {
    var any = false;
    (mapState.mobs || []).forEach(function (m) { if (m && m._ladder && !m._dead && m.curHp > 0) any = true; });
    return any;
  }

  function startRun(fromFloor) {
    if (!player || !player.cls) return;
    if (inLadder() || run) return;
    if (player.dead) { alert('你已倒下，先復活再來。'); return; }
    var msSnap = {}; for (var k in mapState) msSnap[k] = mapState[k];
    run = { affix: weekAffixes(weekId()), wkId: weekId(), seed: String(player.enSeed || '') + '|' + player.name, start: fromFloor, floor: fromFloor, floorAt: 0, nextAt: 0, cleared: 0, clearedT: 0, backup: msSnap, gained: {}, coins: 0 };
    mapState.current = LADDER_MAP;
    mapState.forceBoss = false;
    mapState.suppressSiegeBoss = true;
    refillTeam(1);
    try { window.calcStats(); } catch (e) {}
    showBattleView();
    data().runs++;
    spawnFloor(fromFloor);
    openHud();
  }

  function refillTeam(pct) {
    if (!player) return;
    player.hp = Math.min(player.mhp, player.hp + Math.ceil(player.mhp * pct));
    player.mp = Math.min(player.mmp, player.mp + Math.ceil(player.mmp * pct));
    (player.allies || []).forEach(function (a) { if (!a || a._downed) return; a.curHp = Math.min(a.mhp, (a.curHp || 0) + Math.ceil(a.mhp * pct)); if (a.mmp) a.mp = Math.min(a.mmp, (a.mp || 0) + Math.ceil(a.mmp * pct)); });
  }

  function showBattleView() {
    var tv = document.getElementById('town-view'), bv = document.getElementById('battle-view');
    if (tv && bv) {
      var mapPanel = tv.parentElement;
      bv.classList.remove('hidden');
      var clp = document.getElementById('combat-log-panel'); if (clp) clp.classList.remove('hidden');
      tv.classList.add('hidden'); tv.classList.remove('flex');
      if (mapPanel) mapPanel.classList.remove('flex-1', 'overflow-hidden');
    }
    var tic = document.getElementById('town-interaction-container'); if (tic) { tic.classList.add('hidden'); tic.classList.remove('flex'); }
    try { window.applyAreaBackground(); } catch (e) {}
    try { window.renderMobs(); } catch (e) {}
    try { window.updateUI(); } catch (e) {}
    var mbtn = document.querySelector('#m-nav [data-view="center"]'); if (mbtn) mbtn.click();
  }

  // 結束一輪：reason = 'time' | 'dead' | 'retreat' | 'left'
  function endRun(reason) {
    if (!run) return;
    var r = run; run = null;
    closeHud();
    var sameChar = player && (String(player.enSeed || '') + '|' + player.name) === r.seed;
    var L = sameChar ? data() : null;   // 中途換角色＝這輪作廢，不能把紀錄記到新角色身上
    var result = { wkGoal: r.wkGoal, capped: !!r.capped, reason: reason, start: r.start, reached: r.floor, cleared: r.cleared, clearedT: r.clearedT, newBest: false, gained: r.gained, coins: r.coins };
    if (L && r.cleared > 0) {
      if (r.cleared > L.best || (r.cleared === L.best && r.clearedT < L.bestT)) { result.newBest = r.cleared > L.best; L.best = r.cleared; L.bestT = r.clearedT; }
      var wk = weekId();
      if (L.wk.id !== wk) L.wk = { id: wk, f: 0 };
      var wkImproved = r.cleared > L.wk.f;
      if (wkImproved) L.wk.f = r.cleared;
      if (result.newBest || wkImproved) pushRecord(r);
    }
    // 離開地圖
    if (inLadder()) {
      swapAllKeys(mapState, r.backup || SAFE_MS);
      (mapState.mobs || []).forEach(function (m, i) { if (m && m._ladder) mapState.mobs[i] = null; });
      player.dead = false;
      try { document.getElementById('btn-revive').classList.add('hidden'); } catch (e) {}
      try { var ip = document.getElementById('btn-revive-inplace'); if (ip) ip.classList.add('hidden'); } catch (e) {}
      try { window.setMapSelectors('town_pride'); window.changeMap(true); } catch (e) { try { window.returnToTown(); } catch (e2) {} }
    }
    refreshUi();
    save();
    if (reason !== 'left') showResult(result);
  }

  function clearFloor() {
    var f = run.floor, used = state.ticks - run.floorAt;
    run.cleared = f; run.clearedT = used;
    var L = data();
    var coins = Math.min(1 + Math.floor(f / 10), Math.max(0, COIN_DAY_CAP - L.coinToday));
    L.coins += coins; L.coinToday += coins; run.coins += coins;
    if (coins === 0) run.capped = true;
    if (f > L.first) { grantFirstClear(f); L.first = f; }
    if (!ff()) log('<span class="text-cyan-200">🗼 第 ' + f + ' 層通過（' + (used / 10).toFixed(1) + ' 秒）' + (coins ? '＋天梯幣 ' + coins : '（今天的天梯幣已拿滿）') + '</span>');
    grantWeekGoals(L, f);
    run.nextAt = state.ticks + GAP_TICKS;
    refillTeam(wkHas('nobreath') ? 0 : (wkHas('breath') ? 0.5 : GAP_HEAL));
  }

  function grantWeekGoals(L, f) {
    var wk = run.wkId || weekId();
    if (!L.wg || L.wg.id !== wk) L.wg = { id: wk, got: [] };
    WK_GOALS.forEach(function (g) {
      if (f < g.f || L.wg.got.indexOf(g.f) >= 0) return;
      L.wg.got.push(g.f);
      window.gainItem(g.id, g.n, true, true); addGain(g.id, g.n);
      run.wkGoal = (run.wkGoal || []).concat([g.f]);
      if (!ff()) log('<span class="text-emerald-300 font-bold">🗓️ 週目標達成：本週通過 ' + g.f + ' 層 → ' + esc(DB.items[g.id].n) + ' ×' + g.n + '</span>');
    });
  }
  function addGain(id, n) { run.gained[id] = (run.gained[id] || 0) + n; }
  function grantFirstClear(f) {
    if (f % 10 === 0) { var n = 1 + Math.floor(f / 50); window.gainItem('afk_ladder_protect', n, true, true); addGain('afk_ladder_protect', n); }
    if (f % 20 === 0) { window.gainItem('afk_ladder_reroll', 1, true, true); addGain('afk_ladder_reroll', 1); }
    if (EYE_AT[f]) { window.gainItem(EYE_AT[f], 1, true, true); addGain(EYE_AT[f], 1); }
    else if (f > 100 && f % 25 === 0) { window.gainItem('afk_ladder_eyestone', 3, true, true); addGain('afk_ladder_eyestone', 3); }
  }

  // ===== 核心包裝 =====
  // tick：天梯流程＋魔眼（吞噬/天梯王）＋天梯怪不回血
  var _origTick = window.tick;
  window.tick = function () {
    if (run && !inLadder()) { endRun('left'); }   // 玩家用遊戲自己的 UI 離開地圖
    var mobs = mapState.mobs || [], before = [];
    for (var i = 0; i < mobs.length; i++) { var m = mobs[i]; before[i] = (m && !m._dead) ? { uid: m.uid, hp: m.curHp, boss: !!m.boss, ladder: !!m._ladder } : null; }
    var ret = _origTick.apply(this, arguments);
    try { afterTick(before); } catch (e) { console.warn('[AFK-ladder] tick', e); }
    return ret;
  };
  function afterTick(before) {
    if (typeof player === 'undefined' || !player || player.dead) return;
    var mobs = mapState.mobs || [];
    var eye = player.eq && player.eq.eye, eid = eye && eye.id, elv = eye ? Math.min(10, Math.max(0, eye.en || 0)) : 0;
    var bossDmg = 0;
    for (var i = 0; i < mobs.length; i++) {
      var m = mobs[i], b = before[i];
      if (!m || !b || m.uid !== b.uid) continue;
      if (b.ladder && m.curHp > b.hp) m.curHp = b.hp;                 // 天梯怪不自然回血（頭目回血會讓高樓層變成打不動的牆）
      if (b.ladder && run && !m._dead && m.curHp > 0) {
        if (wkHas('valor') && m.curHp < b.hp) {                        // 🗓️ 鬥志：補打 20%
          var vx = Math.floor((b.hp - m.curHp) * 0.2);
          if (vx > 0) { m.curHp -= vx; if (m.curHp <= 0) { m.curHp = 0; try { window.killMob(i); if (!state.inTick && typeof window.settleDeadMobs === 'function') window.settleDeadMobs(); } catch (e) {} continue; } }
        }
        if (wkHas('regen') && m.curHp < m.hp) m.curHp = Math.min(m.hp, m.curHp + Math.max(1, Math.floor(m.hp * REGEN_PER_TICK)));   // 🗓️ 再生
      }
      if (b.boss && !m._dead && m.curHp < b.hp) {
        var dealt = b.hp - m.curHp; bossDmg += dealt;
        if (eid === 'afk_eye_king') {                                  // 天梯王魔眼：補打 15%+1%/級
          var extra = Math.floor(dealt * (0.15 + 0.01 * elv));
          if (extra > 0) { m.curHp -= extra; bossDmg += extra; if (m.curHp <= 0) { m.curHp = 0; try { window.killMob(i); if (!state.inTick && typeof window.settleDeadMobs === 'function') window.settleDeadMobs(); } catch (e) {} } }
        }
      }
    }
    if (eid === 'afk_eye_devour' && bossDmg > 0 && player.hp < player.mhp) {
      player.hp = Math.min(player.mhp, player.hp + Math.floor(bossDmg * (0.01 + 0.002 * elv)));
    }
    if (!run || !inLadder()) return;
    // 天梯流程
    if (run.nextAt) {
      if (state.ticks >= run.nextAt) spawnFloor(run.floor + 1);
    } else if (!ladderMobsAlive()) {
      clearFloor();
    } else if (state.ticks - run.floorAt >= (run.floorTicks || FLOOR_TICKS)) {
      if (!ff()) log('<span class="text-amber-300 font-bold">🗼 時間到！停在第 ' + run.floor + ' 層。</span>');
      endRun('time'); return;
    }
    if (!ff() && state.ticks % 5 === 0) updateHud();
  }

  // 天梯怪：不給經驗/金幣/掉落（只記擊殺），走 pvp 那套「直接收屍」
  var _origKillMob = window.killMob;
  window.killMob = function (idx) {
    var mob = mapState.mobs ? mapState.mobs[idx] : null;
    if (!mob || !mob._ladder || mob._dead) return _origKillMob.apply(this, arguments);
    mob._dead = true;
    if (mob.curHp > 0) mob.curHp = 0;
    if (!ff()) { try { window.vfxKill(mob); } catch (e) {} try { window.playMobKill(mob); } catch (e) {} try { window.renderMobs(); } catch (e) {} }
    if (!state.inTick && typeof window.settleDeadMobs === 'function') { try { window.settleDeadMobs(); } catch (e) {} }
  };

  // 特殊層：免疫物理／免疫魔法／反傷（只處理天梯怪，其他交回原函式）
  if (typeof window.reflectWallOnDamage === 'function') {
    var _origRW = window.reflectWallOnDamage, _spLogAt = 0;
    window.reflectWallOnDamage = function (mob, dmg, kind, ally) {
      if (!mob || !(mob._ladderSp || mob._ladderWk)) return _origRW.apply(this, arguments);
      if (!(dmg > 0) || mob._dead) return;
      var sp = mob._ladderSp;
      if (mob._ladderWk && run) {
        if (wkHas('hide') && (kind === 'melee' || kind === 'ranged' || kind === 'magic') && !((sp === 'phys' && kind !== 'magic') || (sp === 'magic' && kind === 'magic'))) {
          mob.curHp = Math.min(mob.hp, mob.curHp + Math.floor(dmg * HIDE_PCT));
        }
        if (wkHas('thorns') && sp !== 'reflect') {
          if (reflectTick !== state.ticks) { reflectTick = state.ticks; reflectUsed = 0; }
          var tc = Math.floor((player.mhp || 0) * THORNS_CAP_PER_TICK);
          var tr = Math.min(Math.max(1, Math.floor(dmg * THORNS_PCT)), Math.max(0, tc - reflectUsed));
          if (tr > 0) { reflectUsed += tr; player.hp -= tr; if (player.hp <= 0) { window.killPlayer(); return; } }
        }
        if (!sp) return;
      }
      if ((sp === 'phys' && (kind === 'melee' || kind === 'ranged')) || (sp === 'magic' && kind === 'magic')) {
        mob.curHp = Math.min(mob.hp, mob.curHp + Math.floor(dmg * RESIST_PCT));
        var now = Date.now();
        if (!ff() && now - _spLogAt > 2000) { _spLogAt = now; try { window.logCombat('<span class="text-violet-300 font-bold">【' + SPECIAL_NAME[sp] + '】</span>' + esc(mob.n) + ' 擋下了大部分傷害！', 'enemy'); } catch (e) {} }
        return;
      }
      if (sp === 'reflect') {
        if (reflectTick !== state.ticks) { reflectTick = state.ticks; reflectUsed = 0; }
        var cap = Math.floor((player.mhp || 0) * REFLECT_CAP_PER_TICK);
        var r = Math.min(Math.max(1, Math.floor(dmg * REFLECT_PCT)), Math.max(0, cap - reflectUsed));
        if (r <= 0) return;
        reflectUsed += r;
        player.hp -= r; if (player.hp <= 0) window.killPlayer();
      }
    };
  }

  // 傷害倍率：天梯中依樓層
  if (typeof window.riftDamageMult === 'function') {
    var _origRDM = window.riftDamageMult;
    window.riftDamageMult = function () { if (run && inLadder()) return dmgMult(run.floor) * (wkHas('fury') ? 1.3 : 1); return _origRDM.apply(this, arguments); };
  }

  // 天梯中不出一般怪、不能瞬移/迷魅（會把天梯怪清掉）
  if (typeof window.spawnMob === 'function') { var _origSpawn = window.spawnMob; window.spawnMob = function () { if (inLadder()) return; return _origSpawn.apply(this, arguments); }; }
  if (typeof window.doTeleport === 'function') { var _origTp = window.doTeleport; window.doTeleport = function () { if (inLadder()) return; return _origTp.apply(this, arguments); }; }
  if (typeof window.manualCast === 'function') {
    var _origMC = window.manualCast;
    window.manualCast = function (skId) { var sk = DB.skills && DB.skills[skId]; if (inLadder() && sk && (sk.mEff === 'charm' || sk.mEff === 'teleport')) return; return _origMC.apply(this, arguments); };
  }
  if (typeof window.applyAreaBackground === 'function') {
    var _origBg = window.applyAreaBackground;
    window.applyAreaBackground = function () {
      if (inLadder()) { var bv = document.getElementById('battle-view'); if (bv) { bv.style.backgroundImage = 'url("' + LADDER_BG + '")'; bv.style.backgroundSize = 'contain'; bv.classList.add('area-fit'); bv.classList.add('has-bg'); } return; }
      return _origBg.apply(this, arguments);
    };
  }
  // 回村鈕＝撤退
  if (typeof window.returnToTown === 'function') {
    var _origRTT = window.returnToTown;
    window.returnToTown = function () { if (run && inLadder()) { endRun('retreat'); return; } return _origRTT.apply(this, arguments); };
  }

  // 死亡：天梯中＝結束這輪、零損失（先過不屈魔眼，見下方外層包裝）
  var _origKP = window.killPlayer;
  window.killPlayer = function () {
    if (run && inLadder()) {
      player.hp = 0;
      if (!ff()) log('<span class="text-red-400 font-bold">🗼 你在第 ' + run.floor + ' 層倒下了（無限天梯：死亡沒有任何損失）。</span>');
      player.statuses = { stun: 0, freeze: 0, stone: 0, poison: 0, poisonDmg: 0, poisonTick: 0, burn: 0, burnDmg: 0, burnTick: 0, scald: 0, scaldDmg: 0, scaldTick: 0, bleed: 0, bleedDmg: 0, bleedTick: 0, sleep: 0, silence: 0, paralyze: 0, magicseal: 0, armorBreak: 0, slowAtk: 0, cleave: 0, evilAura: 0 };
      endRun('dead');
      return;
    }
    return _origKP.apply(this, arguments);
  };
  // 不屈魔眼（全地圖有效）：外層包裝，先於天梯/核心死亡處理
  var _kp2 = window.killPlayer;
  window.killPlayer = function () {
    try {
      var eye = player && player.eq && player.eq.eye;
      if (eye && eye.id === 'afk_eye_unyield' && !player.dead) {
        var cd = (300 - 15 * Math.min(10, Math.max(0, eye.en || 0))) * 10;
        if (!(player._unyieldReadyAt > state.ticks)) {
          player._unyieldReadyAt = state.ticks + cd;
          player.hp = 1; player.dead = false;
          if (!ff()) log('<span class="text-yellow-300 font-bold">👁️ 不屈魔眼發動！你撐住了最後一口氣（' + (cd / 10) + ' 秒後可再發動）。</span>');
          return;
        }
      }
    } catch (e) {}
    return _kp2.apply(this, arguments);
  };

  // 天梯魔眼：全職業都能戴（核心各職業白名單不認得這些新物品）
  if (typeof window.checkCanEquip === 'function') {
    var _origCCE = window.checkCanEquip;
    window.checkCanEquip = function (item) { if (item && EYE_IDS.indexOf(item.id) >= 0) return true; return _origCCE.apply(this, arguments); };
  }

  // 鷹之魔眼：命中＋暴擊（核心飾品沒有暴擊欄位，重算後補上）
  if (typeof window.recomputeStats === 'function') {
    var _origRS = window.recomputeStats;
    window.recomputeStats = function () {
      var r = _origRS.apply(this, arguments);
      try {
        var eye = player && player.eq && player.eq.eye, d = player && player.d;
        if (eye && eye.id === 'afk_eye_hawk' && d) {
          var lv = Math.min(10, Math.max(0, eye.en || 0)), hit = 3 + lv, crit = 2 + 0.5 * lv;
          d.meleeHit = (d.meleeHit || 0) + hit; d.rangedHit = (d.rangedHit || 0) + hit; d.magicHit = (d.magicHit || 0) + hit;
          d.meleeCrit = (d.meleeCrit || 0) + crit; d.rangedCrit = (d.rangedCrit || 0) + crit; d.magicCrit = (d.magicCrit || 0) + crit;
        }
      } catch (e) {}
      return r;
    };
  }

  // 週冠軍：經驗 +10（組隊加成百分點）、掉寶 ×1.1
  function amChampion() {
    var me = cloudSlot(); if (!me) return false;
    var c = championOf(boardCache()); return !!(c && c.players.indexOf(me) >= 0);
  }
  if (typeof window.partyExpBonusPct === 'function') { var _origPEB = window.partyExpBonusPct; window.partyExpBonusPct = function () { var v = _origPEB.apply(this, arguments); return amChampion() ? v + 10 : v; }; }
  if (typeof window.partyDropRate === 'function') { var _origPDR = window.partyDropRate; window.partyDropRate = function () { var v = _origPDR.apply(this, arguments); return amChampion() ? Math.min(1, v * 1.1) : v; }; }

  // ===== 不爆強化卷 =====
  var protectOn = false, protectActive = false;
  if (typeof window.enhanceRollOutcome === 'function') {
    var _origERO = window.enhanceRollOutcome;
    window.enhanceRollOutcome = function () {
      var o = _origERO.apply(this, arguments);
      if (o === 'break' && protectActive && itemCount('afk_ladder_protect') > 0) {
        takeItem('afk_ladder_protect', 1);
        log('<span class="text-cyan-300 font-bold">🛡️ 不爆強化卷發出光芒，裝備沒有消失（剩 ' + itemCount('afk_ladder_protect') + ' 張）。</span>');
        return 'none';
      }
      return o;
    };
  }
  ['executeEnhance', 'executeAutoSafeEnhance'].forEach(function (fn) {
    if (typeof window[fn] !== 'function') return;
    var orig = window[fn];
    window[fn] = function () {
      protectActive = protectOn && itemCount('afk_ladder_protect') > 0;
      try { return orig.apply(this, arguments); } finally { protectActive = false; }
    };
  });
  if (typeof window.showEnhanceOptions === 'function') {
    var _origSEO = window.showEnhanceOptions;
    window.showEnhanceOptions = function () {
      var r = _origSEO.apply(this, arguments);
      try {
        var n = itemCount('afk_ladder_protect'), act = document.getElementById('modal-actions');
        if (n > 0 && act && act.querySelector('button')) {
          var lab = document.createElement('label');
          lab.className = 'col-span-2 flex items-center gap-2 text-cyan-300 font-bold py-2 cursor-pointer';
          lab.innerHTML = '<input type="checkbox" id="afk-ladder-protect"' + (protectOn ? ' checked' : '') + '> 使用不爆強化卷（剩 ' + n + ' 張；失敗不會爆）';
          act.insertBefore(lab, act.firstChild);
          lab.querySelector('input').onchange = function () { protectOn = this.checked; };
        }
      } catch (e) {}
      return r;
    };
  }

  // ===== 重抽石／魔眼強化石：使用時開選擇清單 =====
  if (typeof window.useItem === 'function') {
    var _origUse = window.useItem;
    window.useItem = function (uidv) {
      var it = player && player.inv && player.inv.find(function (i) { return i && i.uid === uidv; });
      var d = it && DB.items[it.id];
      if (inLadder() && it && it.id === 'scroll_teleport') return;
      if (d && (d.eff === 'afk_ladder_reroll' || d.eff === 'afk_ladder_eyestone')) { openPicker(d.eff); return; }
      return _origUse.apply(this, arguments);
    };
  }
  function allOwned() {   // [{it, where}]
    var out = [];
    Object.keys(player.eq || {}).forEach(function (k) { var e = player.eq[k]; if (e) out.push({ it: e, eq: true }); });
    (player.inv || []).forEach(function (i) { if (i) out.push({ it: i, eq: false }); });
    return out;
  }
  function itemLabel(it) { try { return window.getItemFullName(it); } catch (e) { return (DB.items[it.id] || {}).n || it.id; } }
  function openPicker(eff) {
    var isRe = eff === 'afk_ladder_reroll';
    var list = allOwned().filter(function (o) {
      var d = DB.items[o.it.id]; if (!d) return false;
      return isRe ? !!d.relic : (EYE_IDS.indexOf(o.it.id) >= 0 && (o.it.en || 0) < 10);
    });
    var body = list.length ? list.map(function (o, i) {
      return '<button class="w-full text-left btn border-slate-600 bg-slate-800 hover:bg-slate-700 py-2 px-3 mb-1" data-i="' + i + '">' + (o.eq ? '【裝備中】' : '') + itemLabel(o.it) + '</button>';
    }).join('') : '<div class="text-slate-400 py-2">' + (isRe ? '身上和背包沒有遺物。' : '身上和背包沒有可以強化的天梯魔眼。') + '</div>';
    var box = modal(isRe ? '選擇要重抽詞綴的遺物' : '選擇要強化的魔眼', body);
    [].forEach.call(box.querySelectorAll('[data-i]'), function (b) {
      b.onclick = function () { var o = list[+b.getAttribute('data-i')]; closeModalBox(); if (isRe) doReroll(o); else doEyeUp(o); };
    });
  }
  function splitOne(o) {   // 背包疊加的先拆一件出來（詞綴是疊加簽章的一部分）
    if (!o.eq && (o.it.cnt || 1) > 1) { o.it.cnt -= 1; var single = Object.assign({}, o.it, { cnt: 1, uid: window.uid() }); player.inv.push(single); return single; }
    return o.it;
  }
  var ANC_TIERS = [true, 'eternal', 'immortal', 'primordial'];
  function doReroll(o) {
    if (!takeItem('afk_ladder_reroll', 1)) return;
    var t = splitOne(o);
    t.bless = Math.random() < 0.5 ? true : false;
    t.anc = Math.random() < 0.5 ? ANC_TIERS[Math.floor(Math.random() * 4)] : false;
    log('<span class="text-cyan-300 font-bold">💎 重抽完成：' + itemLabel(t) + '</span>');
    refreshUi(); save();
  }
  function doEyeUp(o) {
    if (!takeItem('afk_ladder_eyestone', 1)) return;
    var t = splitOne(o);
    t.en = Math.min(10, (t.en || 0) + 1);
    log('<span class="text-cyan-300 font-bold">👁️ ' + itemLabel(t) + ' 強化成功！</span>');
    refreshUi(); save();
  }

  // ===== 排行榜（Worker /ladder） =====
  function boardCache() { try { var c = JSON.parse(localStorage.getItem(BOARD_CACHE_KEY) || 'null'); return c && c.data ? c.data : null; } catch (e) { return null; } }
  function boardCacheAt() { try { var c = JSON.parse(localStorage.getItem(BOARD_CACHE_KEY) || 'null'); return c ? c.at || 0 : 0; } catch (e) { return 0; } }
  function setBoardCache(d) { try { localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify({ at: Date.now(), data: d })); } catch (e) {} }
  function fetchT(url, opt, ms) {
    var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null, t = setTimeout(function () { if (ac) ac.abort(); }, ms || 15000);
    opt = opt || {}; if (ac) opt.signal = ac.signal;
    return fetch(url, opt).finally(function () { clearTimeout(t); });
  }
  function loadBoard(force) {
    var key = cloudKey();
    if (!key || location.protocol === 'file:') return Promise.resolve(boardCache());
    if (!force && Date.now() - boardCacheAt() < BOARD_TTL) return Promise.resolve(boardCache());
    return fetchT(BOARD_EP + '?key=' + encodeURIComponent(key) + '&_=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.entries) setBoardCache(d); return d || boardCache(); })
      .catch(function () { return boardCache(); });
  }
  function writeAllowed() {
    var day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), q;
    try { q = JSON.parse(localStorage.getItem(WRITE_CAP_KEY) || 'null'); } catch (e) { q = null; }
    if (!q || q.day !== day) q = { day: day, n: 0 };
    if (q.n >= WRITE_CAP) return false;
    q.n++; try { localStorage.setItem(WRITE_CAP_KEY, JSON.stringify(q)); } catch (e) {}
    return true;
  }
  function pushRecord(r) {
    var key = cloudKey(), slot = cloudSlot(), L = data();
    if (!key || !slot || !L || location.protocol === 'file:') return;
    if (!writeAllowed()) return;
    var body = {
      p: slot, s: String(player.enSeed || ''), n: String(player.name || ''), c: player.cls, lv: player.lv,
      f: L.best, t: L.bestT, wk: L.wk.id, wf: L.wk.f,
      party: (player.allies || []).filter(Boolean).map(function (a) { return a.cls; })
    };
    fetchT(BOARD_EP + '?key=' + encodeURIComponent(key), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.entries) setBoardCache(d); })
      .catch(function (e) { console.warn('[AFK-ladder] 上傳排行失敗', e); });
  }
  function championOf(b) {   // 上週最高樓層的玩家（同分都算）
    if (!b || !b.entries) return null;
    var pw = prevWeekId(), best = 0, players = [];
    b.entries.forEach(function (e) { var f = (e.wks && e.wks[pw]) || 0; if (f > best) { best = f; players = [e.p]; } else if (f === best && f > 0 && players.indexOf(e.p) < 0) players.push(e.p); });
    return best > 0 ? { week: pw, floor: best, players: players } : null;
  }

  // ===== 介面 =====
  var HUD_ID = 'afk-ladder-hud';
  function openHud() {
    var bv = document.getElementById('battle-view'); if (!bv) return;
    var h = document.getElementById(HUD_ID);
    if (!h) {
      h = document.createElement('div'); h.id = HUD_ID;
      h.style.cssText = 'position:absolute;top:48px;left:50%;transform:translateX(-50%);z-index:30;background:rgba(15,23,42,.85);border:1px solid #22d3ee;border-radius:10px;padding:4px 12px;color:#e0f2fe;font-weight:700;font-size:14px;display:flex;gap:10px;align-items:center;white-space:nowrap';
      bv.appendChild(h);
    }
    h.style.display = 'flex'; updateHud();
  }
  function updateHud() {
    var h = document.getElementById(HUD_ID); if (!h || !run) return;
    var left = run.nextAt ? 0 : Math.max(0, (run.floorTicks || FLOOR_TICKS) - (state.ticks - run.floorAt));
    var sp = specialOf(run.floor);
    h.innerHTML = '🗼 第 ' + run.floor + ' 層' + (run.floor % 10 !== 0 && run.floor % 5 === 0 && wkHas('bossrush') ? '（頭目）' : '') + '<span style="font-size:12px">' + affixLine(run.affix || [], true) + '</span>' + (sp ? '<span style="color:#fca5a5">' + SPECIAL_NAME[sp] + '</span>' : '') +
      '<span style="color:' + (left < 150 ? '#f87171' : '#fde68a') + '">⏱ ' + (run.nextAt ? '上樓中…' : Math.ceil(left / 10) + ' 秒') + '</span>' +
      '<button id="afk-ladder-retreat" style="border:1px solid #64748b;border-radius:6px;padding:0 8px;background:#1e293b;color:#cbd5e1;font-size:12px">撤退</button>';
    var b = document.getElementById('afk-ladder-retreat'); if (b) b.onclick = function () { endRun('retreat'); };
  }
  function closeHud() { var h = document.getElementById(HUD_ID); if (h) h.remove(); }

  var MODAL_ID = 'afk-ladder-modal';
  function modal(title, html) {
    closeModalBox();
    var w = document.createElement('div'); w.id = MODAL_ID;
    w.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
    w.innerHTML = '<div style="background:#0f172a;border:1px solid #22d3ee;border-radius:12px;max-width:420px;width:100%;max-height:85vh;overflow:auto;padding:14px;color:#e2e8f0">' +
      '<div style="font-weight:800;font-size:17px;color:#67e8f9;margin-bottom:8px">' + title + '</div><div class="afk-ladder-body">' + html + '</div>' +
      '<button class="w-full btn py-2 mt-3 bg-slate-700 font-bold" id="afk-ladder-close">關閉</button></div>';
    document.body.appendChild(w);
    w.querySelector('#afk-ladder-close').onclick = closeModalBox;
    w.onclick = function (e) { if (e.target === w) closeModalBox(); };
    return w;
  }
  function closeModalBox() { var w = document.getElementById(MODAL_ID); if (w) w.remove(); }

  function gainedText(g) {
    var parts = Object.keys(g || {}).map(function (id) { return (DB.items[id] ? DB.items[id].n : id) + (g[id] > 1 ? ' ×' + g[id] : ''); });
    return parts.join('、');
  }
  function showResult(r) {
    var why = { time: '時間到', dead: '倒下', retreat: '撤退' }[r.reason] || '';
    var html = '<div style="font-size:15px;line-height:1.8">' +
      (r.cleared > 0 ? '通過第 <b style="color:#fde68a;font-size:20px">' + r.cleared + '</b> 層' + (r.newBest ? ' <b style="color:#f472b6">新紀錄！</b>' : '') : '這次沒有通過任何一層') +
      '<br><span style="color:#94a3b8">停在第 ' + r.reached + ' 層（' + why + '）</span>' +
      (r.coins ? '<br>天梯幣 +' + r.coins : '') + (r.capped ? '<br><span style="color:#94a3b8">今天的天梯幣已拿滿（每天 ' + COIN_DAY_CAP + '），明天再來</span>' : '') +
      (r.wkGoal && r.wkGoal.length ? '<br><span style="color:#6ee7b7">🗓️ 週目標達成：' + r.wkGoal.join('、') + ' 層</span>' : '') +
      (gainedText(r.gained) ? '<br><span style="color:#67e8f9">獲得：' + esc(gainedText(r.gained)) + '</span>' : '') + '</div>';
    modal('🗼 無限天梯', html);
  }

  function nextMilestone(first) {
    for (var f = first + 1; f < first + 30; f++) {
      if (EYE_AT[f]) return '第 ' + f + ' 層：' + DB.items[EYE_AT[f]].n;
      if (f > 100 && f % 25 === 0) return '第 ' + f + ' 層：魔眼強化石 ×3';
      if (f % 20 === 0) return '第 ' + f + ' 層：遺物詞綴重抽石';
      if (f % 10 === 0) return '第 ' + f + ' 層：不爆強化卷 ×' + (1 + Math.floor(f / 50));
    }
    return '';
  }

  var tab = 'me';
  function renderPanel(container) {
    var L = data();
    if (!L) { container.innerHTML = '<div class="p-3 text-slate-300">請先載入角色。</div>'; return; }
    var startHi = Math.max(1, L.best - START_BACK);
    var champ = championOf(boardCache()), me = cloudSlot();
    var h = '<div class="p-2 text-sm" style="line-height:1.7">';
    h += '<div class="bg-slate-900/70 border border-cyan-700/60 rounded-lg p-3 mb-2">' +
      '<div class="text-cyan-300 font-bold">我的紀錄</div>' +
      '<div>最高 <b class="text-yellow-300">' + L.best + '</b> 層' + (L.best ? '（' + (L.bestT / 10).toFixed(1) + ' 秒）' : '') + '　天梯幣 <b class="text-yellow-300">' + L.coins + '</b> <span class="text-slate-400">（今天 ' + L.coinToday + '/' + COIN_DAY_CAP + '）</span></div>' +
      (nextMilestone(L.first) ? '<div class="text-slate-400">下個首通獎勵：' + esc(nextMilestone(L.first)) + '</div>' : '') +
      (champ ? '<div class="text-amber-300">👑 本週天梯之王：玩家' + champ.players.join('、玩家') + '（上週 ' + champ.floor + ' 層）' + (champ.players.indexOf(me) >= 0 ? '— 你這週經驗 +10%、掉寶 +10%' : '') + '</div>' : '') +
      '</div>';
    var wkA = curAffixes(), wg = (L.wg && L.wg.id === weekId()) ? L.wg.got : [];
    var wkMine = (L.wk && L.wk.id === weekId()) ? L.wk.f : 0;
    h += '<div class="bg-slate-900/70 border border-emerald-700/60 rounded-lg p-3 mb-2">' +
      '<div class="text-emerald-300 font-bold">🗓️ 本週詞綴（' + esc(weekId()) + '，每週一換）</div>' +
      wkA.filter(function (k) { return AFFIXES[k]; }).map(function (k) { var a = AFFIXES[k]; return '<div><b style="color:' + (a.k === 'bonus' ? '#86efac' : '#fca5a5') + '">' + (a.k === 'bonus' ? '✚ ' : '✖ ') + esc(a.n) + '</b> <span class="text-slate-300">' + esc(a.d) + '</span></div>'; }).join('') +
      '<div class="mt-1">本週最高 <b class="text-yellow-300">' + wkMine + '</b> 層　週目標：' + WK_GOALS.map(function (g) {
        var ok = wg.indexOf(g.f) >= 0;
        return '<span title="' + esc(DB.items[g.id].n + ' ×' + g.n) + '" style="color:' + (ok ? '#6ee7b7' : '#94a3b8') + '">' + (ok ? '✔' : '○') + g.f + '</span>';
      }).join(' ') + '</div>' +
      '<div class="text-xs text-slate-400">20 層不爆卷、40 層重抽石、60 層魔眼強化石×2、80 層不爆卷×2（每週可再領）</div>' +
      '</div>';
    h += '<div class="grid grid-cols-2 gap-2 mb-2">' +
      '<button class="btn border-cyan-600 bg-cyan-900 hover:bg-cyan-800 py-3 font-bold text-cyan-100" data-act="start1">從第 1 層開始</button>' +
      '<button class="btn border-cyan-600 bg-cyan-900 hover:bg-cyan-800 py-3 font-bold text-cyan-100" data-act="startHi"' + (startHi <= 1 ? ' disabled style="opacity:.5"' : '') + '>從第 ' + startHi + ' 層開始</button></div>';
    h += '<div class="flex gap-1 mb-2">' + [['me', '商店'], ['w', '週榜'], ['p', '總榜'], ['c', '職業榜'], ['t', '隊伍榜']].map(function (x) {
      return '<button class="btn flex-1 py-1 ' + (tab === x[0] ? 'border-cyan-400 text-cyan-300' : 'border-slate-600 text-slate-300') + ' bg-slate-800" data-tab="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</div><div id="afk-ladder-tab">' + renderTab(L) + '</div></div>';
    container.innerHTML = h;
    container.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () { var a = b.getAttribute('data-act'); if (a === 'start1') startRun(1); else if (a === 'startHi' && startHi > 1) startRun(startHi); };
    });
    container.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { tab = b.getAttribute('data-tab'); renderPanel(container); }; });
    container.querySelectorAll('[data-buy]').forEach(function (b) { b.onclick = function () { buy(b.getAttribute('data-buy')); renderPanel(container); }; });
    if (tab !== 'me' && Date.now() - boardCacheAt() > BOARD_TTL) loadBoard(true).then(function () { if (container.isConnected) renderPanel(container); });
  }
  function renderTab(L) {
    if (tab === 'me') {
      return SHOP.map(function (s) {
        var d = DB.items[s.id], can = L.coins >= s.cost;
        return '<div class="flex items-center gap-2 bg-slate-900/60 border border-slate-700 rounded p-2 mb-1"><div class="flex-1"><div class="font-bold text-cyan-200">' + esc(d.n) + '</div><div class="text-xs text-slate-400">' + esc(d.d) + '</div></div>' +
          '<button class="btn px-3 py-2 font-bold ' + (can ? 'bg-yellow-800 border-yellow-600 text-yellow-200' : 'bg-slate-800 border-slate-700 text-slate-500') + '" data-buy="' + s.id + '"' + (can ? '' : ' disabled') + '>' + s.cost + ' 幣</button></div>';
      }).join('');
    }
    var b = boardCache();
    if (!cloudKey() || location.protocol === 'file:') return '<div class="text-slate-400 p-2">要開雲端存檔才看得到排行榜。</div>';
    if (!b || !b.entries || !b.entries.length) return '<div class="text-slate-400 p-2">還沒有人上榜。</div>';
    var rows = b.entries.slice().sort(function (x, y) { return (y.f - x.f) || (x.t - y.t); });
    var line = function (e, i) {
      return '<div class="flex gap-2 py-1 border-b border-slate-800"><span class="w-6 text-right font-bold text-yellow-300">' + (i + 1) + '</span><span class="flex-1">' +
        '玩家' + esc(e.p) + (e.n ? '・' + esc(e.n) : '') + ' <span class="text-slate-400">' + (CLS_NAME[e.c] || e.c) + ' Lv' + esc(e.lv) + '</span></span><span class="text-cyan-300 font-bold">' + e.f + ' 層</span></div>';
    };
    if (tab === 'w') {
      var cw = weekId();
      var wr = b.entries.filter(function (e) { return e.wks && e.wks[cw] > 0; }).sort(function (x, y) { return y.wks[cw] - x.wks[cw]; });
      if (!wr.length) return '<div class="text-slate-400 p-2">本週還沒有人上榜（本週詞綴：' + esc(affixLine(curAffixes())) + '）。</div>';
      return '<div class="text-xs text-slate-400 mb-1">本週詞綴：' + esc(affixLine(curAffixes())) + '｜週一結算，第一名下週經驗與掉寶 +10%</div>' + wr.slice(0, 50).map(function (e, i) {
        return '<div class="flex gap-2 py-1 border-b border-slate-800"><span class="w-6 text-right font-bold text-yellow-300">' + (i + 1) + '</span><span class="flex-1">' +
          '玩家' + esc(e.p) + (e.n ? '・' + esc(e.n) : '') + ' <span class="text-slate-400">' + (CLS_NAME[e.c] || e.c) + ' Lv' + esc(e.lv) + '</span></span><span class="text-emerald-300 font-bold">' + e.wks[cw] + ' 層</span></div>';
      }).join('');
    }
    if (tab === 'p') return rows.slice(0, 50).map(line).join('');
    if (tab === 'c') {
      return Object.keys(CLS_NAME).map(function (c) {
        var r = rows.filter(function (e) { return e.c === c; });
        if (!r.length) return '';
        return '<div class="mt-2 text-amber-300 font-bold">' + CLS_NAME[c] + '</div>' + r.slice(0, 5).map(line).join('');
      }).join('') || '<div class="text-slate-400 p-2">還沒有人上榜。</div>';
    }
    return rows.slice(0, 30).map(function (e, i) {
      var party = (e.party || []).reduce(function (m, c) { m[c] = (m[c] || 0) + 1; return m; }, {});
      var ps = Object.keys(party).map(function (c) { return (CLS_NAME[c] || c) + (party[c] > 1 ? '×' + party[c] : ''); }).join('、') || '單人';
      return line(e, i) + '<div class="text-xs text-slate-400 pl-8 pb-1">隊伍：' + esc(ps) + '</div>';
    }).join('');
  }
  function buy(id) {
    var L = data(), s = SHOP.filter(function (x) { return x.id === id; })[0];
    if (!L || !s || L.coins < s.cost) return;
    L.coins -= s.cost;
    window.gainItem(id, 1, true, true);
    log('<span class="text-cyan-300">🗼 用 ' + s.cost + ' 天梯幣換了 ' + esc(DB.items[id].n) + '。</span>');
    refreshUi(); save();
  }
  function openPanel() {
    if (typeof window.openTownFloatWindow === 'function') window.openTownFloatWindow('天梯守門人', '無限天梯', renderPanel);
    else { var w = modal('🗼 無限天梯', ''); renderPanel(w.querySelector('.afk-ladder-body')); }
    loadBoard(false);
  }
  window.afkLadderOpen = openPanel;

  // 入口：傲慢之塔入口視窗底部加一顆鈕
  if (typeof window.renderPrideEntrance === 'function') {
    var _origRPE = window.renderPrideEntrance;
    window.renderPrideEntrance = function (container) {
      var r = _origRPE.apply(this, arguments);
      try {
        var b = document.createElement('button');
        b.className = 'w-full btn border-cyan-600 bg-cyan-950 hover:bg-cyan-900 py-3 mt-3 font-bold text-cyan-200';
        b.textContent = '🗼 無限天梯（排行榜挑戰）';
        b.onclick = openPanel;
        (container || document.getElementById('interaction-content')).appendChild(b);
      } catch (e) {}
      return r;
    };
  }

  // 測試／平衡用（不在介面上）
  window.__afkLadder = { floorSpec: floorSpec, bossHp: bossHp, dmgMult: dmgMult, startRun: startRun, endRun: endRun, run: function () { return run; }, data: data, championOf: championOf, weekId: weekId, weekAffixes: weekAffixes, curAffixes: curAffixes, floorTicks: floorTicks, AFFIXES: AFFIXES, forceAffixes: function (a) { _forceAffix = a; _affixCache = { wk: '', list: [] }; } };

  console.log('[AFK-ladder] hooks OK');
})();
