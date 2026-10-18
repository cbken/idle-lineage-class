/**
 * afk-gearscore.js — ⭐ 裝備評分（Ken 2026-10-18：「物品上面打上分數，穿在身上的裝備也給一個總分」）
 *
 *   評分＝把一件裝備「實際給的數值」換算成同一把尺：
 *     ① 基底數值：武器平均傷害／命中／額外傷害、AC、MR、六圍、HP/MP、回復、減傷、迴避、抗性…（權重見 W）
 *     ② 強化：直接呼叫核心 enhanceWpnBonus／enhanceArmAc 與飾品強化規則（跟實際算能力同一套）
 *     ③ 詞綴：祝福／遠古／屬性 直接呼叫核心 applyBlessStats／applyAncStats／getAttrAffix 算出加成再換分
 *     ④ 特殊效果（穿透、吸血、免疫、施法…上百種，各自無法一一換算）：每一項 +SPECIAL 分
 *   同一件東西永遠同一個分數（不看是誰穿），所以倉庫裡、背包裡、身上都能比。
 *
 *   顯示：背包／裝備欄／倉庫每一列右邊一個小分數；左欄（手機頂部狀態列）＋裝備分頁顯示「裝備總分」。
 *   作法：render 後掃有 data-tip-uid 的列補徽章（不動核心 HTML），分數依 itemSig 快取。
 */
(function () {
    'use strict';
    if (window.AFK_TOGGLES && !AFK_TOGGLES.enabled('gearscore')) return;
    if (typeof DB === 'undefined' || !DB.items || typeof window.renderTabs !== 'function') { try { console.warn('[AFK-gearscore] 缺核心函式，停用。'); } catch (e) {} return; }

    // 每 1 點數值值幾分（以「近距離傷害 +1 ＝ 10 分」為基準）
    var W = {
        dmg: 10, hit: 3, mdmg: 10, ac: 8, mr: 3, str: 12, dex: 12, con: 12, int: 12, wis: 12, cha: 4,
        mhp: 0.25, mmp: 0.25, hpR: 2, mpR: 3, dr: 12, er: 6, extraMp: 3, magicHit: 3,
        res: 0.5, resNone: 1, atkSpdPct: 4, crit: 5, critDmg: 1, moveSpeedPct: 2, weightCap: 0.05
    };
    var SPECIAL = 15;
    var EYE_SP = { afk_eye_unyield: 40, afk_eye_devour: 40, afk_eye_king: 60 };   // 不屈（保命）／吞噬（吸血）／天梯王（打頭目 +15%）
    // 這些欄位已經換算，或只是資料標記（名稱/圖/價格/分類…），不算「特殊效果」
    var KNOWN = {};
    ('n,type,slot,req,p,gachaWeight,d,c,img,safe,maxEn,noEnhance,relic,relicRole,legend,set,noSell,noJunk,doll,dollTier,' +
     'w2h,oneHand,spd,_spdFam,animFam,isBow,isWand,isArrow,classicOk,reqAvatar,strictAvatar,remains,hardWear,' +
     'dmgS,dmgL,hit,dmgBonus,mdmg,ac,mr,mrPerEn,str,dex,con,int,wis,cha,mhp,mmp,hpR,mpR,dr,er,extraMp,magicHit,' +
     'resFire,resWater,resWind,resEarth,resNone,atkSpdPct,mcrit,rcrit,mcritDmg,moveSpeedPct,weightCap,' +
     'meleeHit,rangedHit,extraHit,meleeDmg,rangedDmg,extraDmg,ranged,ele,procRateBase,procRatePerEn,pierceChance,' +
     'comboRate,extraMpPerEn,meleeHitPerEn,mpRPerEn,mpROverSafe,mdmgEnFrom7Max3,mdmgEnFrom4,drEnFrom7Max3,eff,' +
     'petDmg,petHit,petAc,petMr,petInt,petWis,armguard,noConsume').split(',').forEach(function (k) { KNOWN[k] = 1; });

    function isGear(d) { return !!d && (d.type === 'wpn' || d.type === 'arm' || d.type === 'acc') && d.slot !== 'petwpn' && d.slot !== 'petarm' && !d.isArrow; }
    function en0(it, d) { try { return typeof capEn === 'function' ? capEn(it.en || 0, d) : (it.en || 0); } catch (e) { return it.en || 0; } }
    function n(v) { v = Number(v); return isFinite(v) ? v : 0; }

    // 把「能力加成物件」換成分數（詞綴、強化共用）
    function accScore(a) {
        return n(a.extraDmg) * W.dmg + n(a.meleeDmg) * W.dmg + n(a.rangedDmg) * W.dmg + n(a.magicDmg) * W.mdmg +
            (n(a.extraHit) + n(a.meleeHit) + n(a.rangedHit)) * W.hit + (-n(a.ac)) * W.ac + n(a.mr) * W.mr +
            n(a.dr) * W.dr + n(a.er) * W.er + n(a.extraMp) * W.extraMp;
    }
    function zeroAcc() { return { extraDmg: 0, extraHit: 0, extraMp: 0, magicDmg: 0, ac: 0, dr: 0, mr: 0, er: 0, meleeDmg: 0, rangedDmg: 0, meleeHit: 0, rangedHit: 0 }; }

    function calc(it) {
        var d = it && DB.items[it.id];
        if (!isGear(d)) return null;
        var s = 0, e = en0(it, d), slot = d.type;
        // ① 基底
        if (slot === 'wpn') s += ((n(d.dmgS) + n(d.dmgL)) / 2) * W.dmg + n(d.dmgBonus) * W.dmg;
        else s += (n(d.meleeDmg) + n(d.rangedDmg)) * W.dmg;
        s += (n(d.hit) + n(d.meleeHit) + n(d.rangedHit) + n(d.extraHit)) * W.hit + n(d.extraDmg) * W.dmg;
        s += n(d.mdmg) * W.mdmg + n(d.ac) * W.ac + (n(d.mr) + n(d.mrPerEn) * e) * W.mr;
        ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(function (k) { s += n(d[k]) * W[k]; });
        s += n(d.mhp) * W.mhp + n(d.mmp) * W.mmp + n(d.hpR) * W.hpR + n(d.mpR) * W.mpR + n(d.dr) * W.dr + n(d.er) * W.er;
        s += n(d.extraMp) * W.extraMp + n(d.magicHit) * W.magicHit + n(d.atkSpdPct) * W.atkSpdPct;
        s += (n(d.resFire) + n(d.resWater) + n(d.resWind) + n(d.resEarth)) * W.res + n(d.resNone) * W.resNone;
        s += (n(d.mcrit) + n(d.rcrit)) * W.crit + n(d.mcritDmg) * W.critDmg + n(d.moveSpeedPct) * W.moveSpeedPct + n(d.weightCap) * W.weightCap;
        // ② 強化（跟核心算能力同一套）
        try {
            if (slot === 'wpn') {
                if (e > 0 && typeof enhanceWpnBonus === 'function') { var b = enhanceWpnBonus(it.en || 0); s += n(b.dmg) * W.dmg + n(b.hit) * W.hit; }
                s += (n(d.extraMpPerEn) * e) * W.extraMp + (n(d.meleeHitPerEn) * e) * W.hit + (n(d.mpRPerEn) * e) * W.mpR;
                if (d.mpROverSafe && e > n(d.safe)) s += (e - n(d.safe)) * n(d.mpROverSafe) * W.mpR;
                if (d.mdmgEnFrom7Max3) s += Math.min(3, Math.max(0, e - 6)) * W.mdmg;
            } else if (slot === 'arm') {
                if (d.armguard) s += e * 10 * W.mhp;
                else if (e > 0 && typeof enhanceArmAc === 'function') s += n(enhanceArmAc(it.en || 0)) * W.ac;
                if (d.mdmgEnFrom4) s += Math.min(6, Math.max(0, e - 3)) * W.mdmg;
                if (d.drEnFrom7Max3) s += Math.min(3, Math.max(0, e - 6)) * W.dr;
            } else {
                var ae = Math.min(it.en || 0, 5);
                if (d.slot === 'ring') s += ae * W.ac; else if (d.slot === 'amulet') s += ae * 3 * W.mr; else if (d.slot === 'ear') s += ae * 2 * W.mr;
            }
        } catch (er) {}
        // ③ 詞綴（核心函式算加成）
        try {
            var a = zeroAcc();
            if (it.bless && typeof applyBlessStats === 'function') applyBlessStats(a, it.bless, slot);
            if (it.anc && typeof applyAncStats === 'function') applyAncStats(a, it.anc, slot);
            s += accScore(a);
            var at = (typeof getAttrAffix === 'function') ? getAttrAffix(it.attr) : null;
            if (at) s += n(at.dmg) * W.dmg + n(at.mp) * W.extraMp;
        } catch (er) {}
        // ④' 效果寫在外掛程式裡、資料欄位看不到的：天梯魔眼（數值照 afk-ladder 的說明）、席琳遺骸的套裝詞綴
        if (/^afk_eye_/.test(it.id)) s += e * W.ac;   // 魔眼每 +1 → AC −1
        if (it.id === 'afk_eye_hawk') s += (3 + e) * W.hit + (2 + 0.5 * e) * W.crit;
        else if (EYE_SP[it.id]) s += EYE_SP[it.id] + e * 8;
        if (it.seteff) s += SPECIAL * 2;
        // ④ 特殊效果
        var sp = 0;
        for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k) && !KNOWN[k] && d[k]) sp++;
        if (d.eff) sp++;
        if (d.armguard) sp++;
        s += sp * SPECIAL;
        return Math.max(0, Math.round(s));
    }

    var _cache = {};
    function score(it) {
        if (!it || !it.id) return null;
        var key = (typeof itemSig === 'function' ? itemSig(it) : it.id + '|' + (it.en || 0)) + (it.gw ? '|gw' : '');
        if (key in _cache) return _cache[key];
        return (_cache[key] = calc(it));
    }
    function total(p) {
        p = p || (typeof player !== 'undefined' ? player : null);
        if (!p || !p.eq) return 0;
        var t = 0;
        for (var k in p.eq) { var it = p.eq[k]; if (it) t += score(it) || 0; }
        return t;
    }
    window.afkGearScore = score;
    window.afkGearTotal = total;

    // ── 顯示 ───────────────────────────────────────────────────
    function css() {
        if (document.getElementById('afk-gs-style')) return;
        var s = document.createElement('style'); s.id = 'afk-gs-style';
        s.textContent = [
            '.afk-gs{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;font-weight:bold;color:#fde68a;background:rgba(120,53,15,.55);border:1px solid rgba(217,119,6,.6);white-space:nowrap;vertical-align:middle;}',
            '.afk-gs::before{content:"⭐";font-size:9px;margin-right:2px;}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    var _whPass = null;   // 一次掃描只讀一次倉庫（loadWarehouse 要解壓）
    function findItem(src, uidv) {
        try {
            if (src === 'eq') { for (var k in player.eq) { var e = player.eq[k]; if (e && String(e.uid) === uidv) return e; } return null; }
            if (src === 'wh') { var w = _whPass || (_whPass = loadWarehouse()); return ((w && w.items) || []).find(function (x) { return x && String(x.uid) === uidv; }) || null; }
            return (player.inv || []).find(function (x) { return x && String(x.uid) === uidv; }) || null;
        } catch (e) { return null; }
    }
    function badge(root) {
        root = root || document; _whPass = null;
        var els = root.querySelectorAll('[data-tip-uid]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var uidv = String(el.getAttribute('data-tip-uid'));
            if (el.getAttribute('data-gs-uid') === uidv && el.querySelector('.afk-gs')) continue;   // 已標過（快取列重用）
            var old = el.querySelector('.afk-gs'); if (old) old.remove();
            el.setAttribute('data-gs-uid', uidv);
            var it = findItem(el.getAttribute('data-tip-src') || 'inv', uidv);
            var v = it ? score(it) : null;
            if (v == null) continue;
            var b = document.createElement('span'); b.className = 'afk-gs'; b.textContent = v.toLocaleString(); b.title = '裝備評分';
            var host = el.querySelector('.classic-name-box') || el;
            host.appendChild(b);
        }
    }
    // 左欄（金幣／天梯幣下面）＋手機頂部狀態列
    var _shownTotal = null;
    function paintTotal() {
        var t = total();
        var g = document.getElementById('st-gold');
        if (g) {
            var row = document.getElementById('afk-st-gs');
            if (!row) {
                var anchor = document.getElementById('afk-st-lcoin-row') || g.closest('.status-gold-row');
                if (anchor) {
                    var r = document.createElement('div'); r.className = 'status-gold-row'; r.id = 'afk-st-gs-row';
                    r.innerHTML = '<span>裝備評分</span><span class="font-bold" style="color:#fde68a" id="afk-st-gs">0</span>';
                    anchor.parentNode.insertBefore(r, anchor.nextSibling);
                    row = document.getElementById('afk-st-gs'); _shownTotal = null;
                }
            }
            if (row && t !== _shownTotal) { _shownTotal = t; row.textContent = t.toLocaleString(); }
        }
        var ms = document.getElementById('m-status');
        if (ms) {
            var seg = document.getElementById('ms-gs');
            if (!seg) {
                var after = ms.querySelector('.ms-lcoin') || ms.querySelector('.ms-gold');
                if (after) { var sp = document.createElement('span'); sp.className = 'ms-seg ms-gs'; sp.title = '裝備評分'; sp.style.cssText = 'color:#fde68a;font-weight:bold'; sp.innerHTML = '⭐ <span id="ms-gs">0</span>'; after.parentNode.insertBefore(sp, after.nextSibling); seg = document.getElementById('ms-gs'); }
            }
            if (seg) { var tv = t.toLocaleString(); if (seg.textContent !== tv) seg.textContent = tv; }
        }
    }
    // 物品說明（滑鼠移上去／手機長按的資料框）最上面加一行評分
    if (typeof window.buildItemDescHTML === 'function') {
        var _bd = window.buildItemDescHTML;
        window.buildItemDescHTML = function (item) {
            var h = _bd.apply(this, arguments);
            try { var v = score(item); if (v != null) h = '<span style="color:#fde68a;font-weight:bold">⭐ 裝備評分 ' + v.toLocaleString() + '</span><br>' + h; } catch (e) {}
            return h;
        };
    }
    function after() { try { css(); badge(); paintTotal(); } catch (e) {} }

    var _rt = window.renderTabs;
    window.renderTabs = function () { var r = _rt.apply(this, arguments); after(); return r; };
    if (typeof window.renderWarehouseNPC === 'function') {
        var _rw = window.renderWarehouseNPC;
        window.renderWarehouseNPC = function () { var r = _rw.apply(this, arguments); try { css(); badge(document.getElementById('warehouse-window-content') || document.getElementById('interaction-content')); } catch (e) {} return r; };
    }
    if (typeof window.updateUI === 'function') {
        var _uu = window.updateUI;
        window.updateUI = function () { var r = _uu.apply(this, arguments); try { paintTotal(); } catch (e) {} return r; };
    }
    // 其他會畫物品列的視窗（裝備視窗、比較卡…）沒經過 renderTabs → 每 1.5 秒補標一次新出現的列（只處理還沒標過的）
    setInterval(function () { try { if (!document.hidden) { css(); badge(); } } catch (e) {} }, 1500);
    try { after(); } catch (e) {}

    try { console.log('[AFK-gearscore] hooks OK — 裝備評分已啟用。'); } catch (e) {}
})();
