/* ============================================================================
 * afk-leveldrop.js — 玩家 NPC（敵對血盟成員／白目／PvP 玩家）身上噴的裝「依等級挑貨」
 *
 * 站主 2026-09-24 拍板（方案 C）：「都掉一些爛貨新手裝根本就沒有意義」。
 *
 * 上游規則（js/04 pledgeBonusDrop → js/14 getWeightedGachaResult(true)）：
 *   從潘朵拉黑市整個物品池（約 608 種）依 gachaWeight 抽，且「權重 1 以外 ×2」。
 *   跟玩家等級、敵人強度完全無關 → 實測 54% 是匕首/木棒這類新手裝、單件頂級稀有約 0.003%。
 *
 * 本外掛只換「掉什麼」，不動「掉不掉」（掉率 1%／性向 3~10%／組隊倍率全照上游）：
 *   ・裝備等級 itemLv ＝ max(掉落等級, 身價等級)
 *       掉落等級：全遊戲掉落表（MOB_DROPS 等 6 張）裡會掉它的怪，取等級中位數
 *       身價等級：售價 ≥20萬→90、≥5萬→70、≥1萬→50、≥2千→30，其餘 1
 *     （上游沒有「裝備等級」欄位；單用掉落等級會把雷神之鎚這類「低等怪也會極低率噴」的好貨算成低等，
 *       單用售價又抓不到「高等圖才出、但售價普通」的裝備，所以兩個取高。）
 *   ・只從 itemLv ≥ min(玩家等級, 99) − 20 的物品裡抽（怪最高 Lv99，Lv100+ 一律當 99）
 *   ・取消上游「權重 1 以外 ×2」（那條會讓普通貨更常出）
 *   ・篩完是空的（理論上不會）→ 退回上游原函式
 *   ・抽籤沿用 lootRng('gacha')（committed RNG，SL 重讀同結果，與上游一致）
 *
 * 只攔 doubleNonRare === true 的呼叫＝全專案只有 pledgeBonusDrop 一處。實際會觸發的是 js/05 的
 * trollPlayer（白目／PVP 玩家 NPC，NPC 血盟群戰的敵盟成員也是這類）與 js/26 私訊送禮；
 * 攻城敵人那條在攻城區內本來就不掉（pledgeBonusDrop 第一行擋掉），野外 esti_enemy 這類血盟怪不走這條。潘朵拉黑市本身（js/14 呼叫 false）完全不受影響。
 * 關掉開關＝與上游位元組等價。
 *
 * ⚠️ 同步上游時要看一眼：getWeightedGachaResult 的篩選條件（卡片排除、gachaWeight 正規化）若改了，
 *    這裡的池子要跟著對齊；掉落表常數若改名，掉落等級會全部退回身價等級（console 會 warn）。
 * ========================================================================== */
(function () {
    'use strict';

    if (window.AFK_TOGGLES) AFK_TOGGLES.register({
        id: 'leveldrop', name: '玩家 NPC 噴裝依等級', group: '遊戲玩法', def: true,
        desc: '敵對血盟成員、白目／PvP 玩家等「玩家 NPC」身上噴的東西（含私訊送禮），只會是接近你等級的（不再大半是新手裝）；掉率不變'
    });

    var orig = window.getWeightedGachaResult;
    if (typeof orig !== 'function') { console.warn('[AFK-leveldrop] 找不到 getWeightedGachaResult，停用（遊戲照常運作）。'); return; }
    if (orig.__afkLevelDrop) { console.log('[AFK-leveldrop] hooks OK'); return; }   // 冪等

    function enabled() { return !window.AFK_TOGGLES || AFK_TOGGLES.enabled('leveldrop'); }

    var WINDOW = 20;        // 往下容許幾級
    var MOB_LV_CAP = 99;    // 全遊戲最高怪等級；Lv100+ 玩家以此計

    function priceLv(p) { p = Number(p) || 0; return p >= 200000 ? 90 : p >= 50000 ? 70 : p >= 10000 ? 50 : p >= 2000 ? 30 : 1; }

    // 裝備等級表：第一次用到才建（DB 與掉落表都是靜態字面量，建一次即可）
    var _itemLv = null;
    function itemLvTable() {
        if (_itemLv) return _itemLv;
        var nameLv = {};
        try { for (var k in DB.mobs) { var m = DB.mobs[k]; if (m && m.n && m.lv) nameLv[m.n] = Math.min(nameLv[m.n] || 999, m.lv); } } catch (e) {}
        var tables = [];
        try { if (typeof MOB_DROPS !== 'undefined') tables.push(MOB_DROPS); } catch (e) {}
        try { if (typeof DARK_WEAPON_DROPS !== 'undefined') tables.push(DARK_WEAPON_DROPS); } catch (e) {}
        try { if (typeof DRAGON_DROPS !== 'undefined') tables.push(DRAGON_DROPS); } catch (e) {}
        try { if (typeof WARRIOR_DROPS !== 'undefined') tables.push(WARRIOR_DROPS); } catch (e) {}
        try { if (typeof MEM_DROPS !== 'undefined') tables.push(MEM_DROPS); } catch (e) {}
        try { if (typeof DARK_CRYSTAL_DROPS !== 'undefined') tables.push(DARK_CRYSTAL_DROPS); } catch (e) {}
        if (!tables.length) console.warn('[AFK-leveldrop] 讀不到掉落表常數，裝備等級只用售價推估。');
        var lvs = {};
        tables.forEach(function (T) {
            for (var mn in T) {
                var lv = nameLv[mn]; if (!lv || lv === 999) continue;
                var arr = Array.isArray(T[mn]) ? T[mn] : [];
                arr.forEach(function (e) { var id = Array.isArray(e) ? e[0] : (e && e.id); if (id) (lvs[id] = lvs[id] || []).push(lv); });
            }
        });
        var built = {};   // 先建完整的區域表、全部成功才指定（中途出錯不會把殘缺表永久快取住）
        for (var id in DB.items) {
            if (!DB.items[id]) continue;
            var a = lvs[id], med = 1;
            if (a && a.length) { a.sort(function (x, y) { return x - y; }); med = a[Math.floor((a.length - 1) / 2)]; }
            built[id] = Math.max(med, priceLv(DB.items[id].p));
        }
        _itemLv = built;
        return _itemLv;
    }

    // 與上游 getWeightedGachaResult 同一套池子條件（卡片排除、gachaWeight>0），差在：依等級篩、不做 ×2
    function levelPick() {
        // ⚠️ player 是核心的全域 let，不在 window 上（window.player 恆 undefined → 會誤判成 Lv1），只能直接用名字取
        var lv = Math.max(1, Math.floor(Number((typeof player !== 'undefined' && player) ? player.lv : 1) || 1));
        var floor = Math.min(lv, MOB_LV_CAP) - WINDOW;
        var tbl = itemLvTable(), pool = [], total = 0;
        for (var id in DB.items) {
            var it = DB.items[id];
            if (!it || it.eff === 'card') continue;
            var w = it.gachaWeight !== undefined ? it.gachaWeight : 0;
            if (!(w > 0)) continue;
            if ((tbl[id] || 1) < floor) continue;
            total += w; pool.push([id, w]);
        }
        if (!pool.length || !(total > 0)) return null;
        var r = (typeof lootRng === 'function' ? lootRng('gacha') : Math.random()) * total, cur = 0;
        for (var i = 0; i < pool.length; i++) { cur += pool[i][1]; if (r <= cur) return pool[i][0]; }
        return pool[pool.length - 1][0];
    }

    var wrapped = function (doubleNonRare, excludeCards) {
        if (doubleNonRare === true && enabled()) {
            var id = null;
            try { id = levelPick(); } catch (e) { console.warn('[AFK-leveldrop] 篩選失敗，改用原版：', e); }
            if (id) return id;
        }
        return orig.apply(this, arguments);
    };
    wrapped.__afkLevelDrop = true;
    wrapped.__afkOrig = orig;
    window.getWeightedGachaResult = wrapped;
    window.AFK_LEVELDROP = { itemLv: function (id) { return itemLvTable()[id]; }, pick: levelPick, WINDOW: WINDOW };
    console.log('[AFK-leveldrop] hooks OK');
})();
