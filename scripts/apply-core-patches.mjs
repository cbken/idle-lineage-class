/**
 * apply-core-patches.mjs — 在「拉進上游原版核心」之後，自動把加掛版必要的核心鉤子補回去。
 *
 * 設計原則（給自動更新流程用，取代舊的整檔合併）：
 *   - 冪等：已補過就跳過（可重複跑）。
 *   - 錨點式：靠「函式/註解特徵字串」定位，不寫死行號 → 上游小改版大多仍插得進去。
 *   - 失敗大聲：錨點找不到就 throw（exit 1）→ CI 紅，讓人知道要修錨點，而不是默默讓離線壞掉。
 *
 * 目前的核心補丁（越少越好）：
 *   1. maybeSpawnMobs — 把 js/03 tick() 內「出怪排程」那一塊 { } 抽成具名函式，讓離線快速結算
 *      能用「與線上同一份」的出怪排程（出怪延遲/BOSS 節流/後排格/席琳日光加速全照原作）。
 *      其餘離線鉤子（saveGame/loadGame/changeMap/killMob/gainItem 包裝、結算期間靜音渲染）
 *      一律由 afk-offline.js 外掛自己 monkey-patch，不動核心。
 *
 * 用法：node scripts/apply-core-patches.mjs        （--check 只驗證是否已全部補上、不寫檔）
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CHECK = process.argv.includes('--check');
let changed = 0, already = 0;

// ── 小工具：從指定 index 的 '{' 找到配對的 '}'（略過字串/註解外的括號；此處程式碼夠單純故用簡易配對）──
function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('matchBrace: 找不到配對的 }（自 index ' + openIdx + '）');
}

// ── 補丁 1：抽出 maybeSpawnMobs ────────────────────────────────
function patchMaybeSpawnMobs() {
  const FILE = 'js/03-combat-core.js';
  let s = readFileSync(FILE, 'utf8');

  if (/function\s+maybeSpawnMobs\s*\(/.test(s)) { already++; return; }   // 冪等

  // 錨點：出怪判定那段的開頭註解（上游原文，穩定）
  const ANCHOR = '// === 出怪判定：以邏輯 tick';
  const aIdx = s.indexOf(ANCHOR);
  if (aIdx < 0) throw new Error(`[${FILE}] 找不到出怪判定錨點「${ANCHOR}」——上游可能改寫了 tick 出怪段，請人工檢查後更新錨點。`);

  // 錨點之後第一個 '{' 就是那塊的開頭；找它的配對 '}'
  const openIdx = s.indexOf('{', aIdx);
  if (openIdx < 0) throw new Error(`[${FILE}] 錨點後找不到出怪塊的 '{'。`);
  const closeIdx = matchBrace(s, openIdx);
  const body = s.slice(openIdx + 1, closeIdx);   // 塊內程式碼（不含外層大括號）

  // 在 function tick() 之前插入具名函式；把原塊替換成呼叫
  const TICK_ANCHOR = 'function tick() {';
  const tIdx = s.indexOf(TICK_ANCHOR);
  if (tIdx < 0) throw new Error(`[${FILE}] 找不到「${TICK_ANCHOR}」錨點。`);

  const fnDef =
    '// 🔌 加掛版補丁(apply-core-patches)：出怪排程抽成具名函式，供 afk-offline 離線快速結算與 tick() 共用同一份排程。\n' +
    'function maybeSpawnMobs() {' + body + '}\n';

  // 先替換塊（用 index 由後往前處理避免位移）
  s = s.slice(0, openIdx) + '{ maybeSpawnMobs(); }' + s.slice(closeIdx + 1);
  // 重新定位 tick 錨點（前面替換過，位置變了，但 tick 在 aIdx 之前，未受影響——保險起見重找）
  const tIdx2 = s.indexOf(TICK_ANCHOR);
  s = s.slice(0, tIdx2) + fnDef + s.slice(tIdx2);

  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] maybeSpawnMobs 抽取完成（${FILE}）`);
}

// ── 補丁 2：gainItem 自帶強化值鉤子（偽傳統／自動衝裝）────────────
//   上游把傳統模式挖掉後 `let _tEn = 0;` 寫死。改成呼叫外掛鉤子 window.__afkTradRollEn(d, forceNormal, _noAffixCtx)：
//   afk-traditional.js 提供它 → 對「該角色有開偽傳統 + 非商店(forceNormal 假) + 裝備」回傳隨機強化值，其餘回 0。
//   未載外掛/未開 → 恆 0，與原版完全一致。詞綴/疊加/簽章全走上游原路（en 在簽章之前就定好，堆疊正確）。
function patchTradEnHook() {
  const FILE = 'js/08-items-equip.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('__afkTradRollEn')) { already++; return; }

  const ANCHOR = 'let _tEn = 0;   // 🏛️ v3.0.83 傳統模式已取消：掉落自帶強化值停用（任何來源恆 +0·手動強化照常）';
  if (s.indexOf(ANCHOR) < 0) throw new Error(`[${FILE}] 找不到 gainItem 的 _tEn 錨點——上游可能改寫了掉落強化段，請人工檢查後更新錨點。`);

  const REPLACE = "let _tEn = (typeof window.__afkTradRollEn === 'function') ? (window.__afkTradRollEn(d, forceNormal, _noAffixCtx) || 0) : 0;   // 🔌 加掛版補丁：偽傳統(自動衝裝)自帶強化值鉤子（外掛 afk-traditional 提供；未載/未開→0）";
  s = s.replace(ANCHOR, REPLACE);

  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] gainItem _tEn 偽傳統鉤子（${FILE}）`);
}

// ── 補丁 3：存檔位 8 → 16（加掛版原有功能，上游只有 8 格）──────────
//   上游把格數硬寫死在多處：js/13 匯入時的「同角色重複」掃描、js/06 allySlotList（招募）與傭兵受僱
//   登記的四處掃描、js/05 安塔瑞斯每日通關遷移、js/25 clanScanRoles（血盟成員/盟主判定）、
//   js/28 PVP 挑戰自己其他角色的清單。
//   改成用 SAVE_SLOT_MAX=16（定義於 js/13，執行期全域，afk-loadslots/afk-wiki/afk-diag 的選角面板也讀它）。
//   選角畫面本身不必改核心：上游是分頁式卡片（每頁 4 格），afk-loadslots 自行擴充頁數。
function patch16Slots() {
  // js/13：定義 SAVE_SLOT_MAX + 匯入重複掃描涵蓋全部格
  const F13 = 'js/13-shop-save.js';
  let s13 = readFileSync(F13, 'utf8');
  if (!s13.includes('SAVE_SLOT_MAX')) {
    const A1 = "function slotSummary(n){ return _summaryFromRaw(_lzGet('lineage_idle_save_' + n)); }";
    if (s13.indexOf(A1) < 0) throw new Error(`[${F13}] 找不到 slotSummary 錨點——上游可能改了存檔位邏輯。`);
    s13 = s13.replace(A1,
      "const SAVE_SLOT_MAX = 16;   // 🔌 加掛版補丁：存檔位 8 → 16（匯入重複掃描/傭兵招募/選角面板共用）\n" + A1);
    // 匯入存檔時掃「同一角色是否已存在別格」——沒放大就掃不到第 9~16 格，會讓同角色重複進來
    const A2 = "for(let slotN = 1; slotN <= 8; slotN++){";
    if (s13.indexOf(A2) < 0) throw new Error(`[${F13}] 找不到匯入重複掃描 8 格迴圈錨點。`);
    s13 = s13.replace(A2, "for(let slotN = 1; slotN <= SAVE_SLOT_MAX; slotN++){");
    if (!CHECK) writeFileSync(F13, s13);
    changed++;
    console.log(`[patch] 存檔位 16 格（${F13}）`);
  } else { already++; }

  // js/06：傭兵招募可選存檔位 + 傭兵受僱登記的存檔位掃描
  const F06 = 'js/06-status-allies.js';
  let s06 = readFileSync(F06, 'utf8');
  let dirty06 = false;
  const A3 = "['1','2','3','4','5','6','7','8'].filter(n => n !== String(currentSlot))";
  if (s06.indexOf(A3) >= 0) {
    s06 = s06.replace(A3, "(function(){ let a=[]; for(let n=1;n<=SAVE_SLOT_MAX;n++){ if(String(n)!==String(currentSlot)) a.push(String(n)); } return a; })()");
    dirty06 = true;
    changed++;
    console.log(`[patch] 傭兵招募 16 格（${F06}）`);
  } else if (!s06.includes('SAVE_SLOT_MAX')) {
    throw new Error(`[${F06}] 找不到 allySlotList 8 格錨點——上游可能改了招募邏輯。`);
  } else { already++; }

  // 傭兵受僱登記（bootstrap 遷移／受僱查詢／選角徽章／獨佔判定）四處各自掃全部存檔位。
  //   漏放大 → 僱主在第 9~16 格時，傭兵不顯示徽章、不受安全區限制、也擋不住被第二位僱主重複招募。
  const A3B_FROM = 'for (let n = 1; n <= 8; n++) {';
  const A3B_TO = 'for (let n = 1; n <= SAVE_SLOT_MAX; n++) {';
  if (s06.indexOf(A3B_FROM) >= 0) {
    s06 = s06.split(A3B_FROM).join(A3B_TO);
    dirty06 = true;
    changed++;
    console.log(`[patch] 傭兵受僱掃描 16 格（${F06}）`);
  } else if (s06.indexOf(A3B_TO) < 0) {
    throw new Error(`[${F06}] 找不到傭兵受僱登記的 8 格迴圈錨點——上游可能改了受僱判定，請確認第 9~16 格仍被掃到。`);
  } else { already++; }
  if (dirty06 && !CHECK) writeFileSync(F06, s06);

  // js/05：不再需要補丁——上游 v3.8.34 把安塔瑞斯每日通關改成「逐參與者（enSeed 身分）各記一把 key」，
  //   原本那個「掃存檔位 1~8 遷移舊資料」的迴圈整段移除，沒有 8 格上限可補。第 9~16 格照樣正常。

  // js/25：血盟成員掃描（成員清單＋貢獻度、clanLeaderRole 找盟主、城鎮 NPC 的「有無君主」判斷都經這裡）
  const F25 = 'js/25-clan-system.js';
  let s25 = readFileSync(F25, 'utf8');
  const A4 = "for (let slot = 1; slot <= 8; slot++) {";
  if (s25.indexOf(A4) >= 0) {
    s25 = s25.replace(A4, "for (let slot = 1; slot <= SAVE_SLOT_MAX; slot++) {");
    if (!CHECK) writeFileSync(F25, s25);
    changed++;
    console.log(`[patch] 血盟成員掃描 16 格（${F25}）`);
  } else if (!s25.includes('SAVE_SLOT_MAX')) {
    throw new Error(`[${F25}] 找不到 clanScanRoles 8 格迴圈錨點——上游可能改了血盟成員掃描。`);
  } else { already++; }

  // js/28：PVP 面板「挑戰自己其他角色」的候選清單
  const F28 = 'js/28-pvp-arena.js';
  let s28 = readFileSync(F28, 'utf8');
  const A5 = "for (let n = 1; n <= 8; n++) {";
  if (s28.indexOf(A5) >= 0) {
    s28 = s28.replace(A5, "for (let n = 1; n <= SAVE_SLOT_MAX; n++) {");
    if (!CHECK) writeFileSync(F28, s28);
    changed++;
    console.log(`[patch] PVP 對手清單 16 格（${F28}）`);
  } else if (!s28.includes('SAVE_SLOT_MAX')) {
    throw new Error(`[${F28}] 找不到 PVP 對手清單 8 格迴圈錨點——上游可能改了 PVP 面板。`);
  } else { already++; }
}

// ── 補丁 4：js/22 寵/召 sprite ticker 改「間接呼叫」──────────────
//   上游 setInterval(_petAnimApply, …) 直接捕捉原函式參照 → afk-powersave 的 wrapper 攔不到
//   (關戰鬥動畫後寵物/召喚照樣動)。改箭頭間接呼叫=每次經全域解析,外掛包得住。
function patchPetAnimTicker() {
  const FILE = 'js/22-pets.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('setInterval(() => { _petAnimApply(); }')) { already++; return; }
  const ANCHOR = 'setInterval(_petAnimApply, 1000 / PET_ANIM_FPS);';
  if (s.indexOf(ANCHOR) < 0) throw new Error(`[${FILE}] 找不到 _petAnimApply ticker 錨點——上游可能改寫了寵物動畫排程。`);
  s = s.replace(ANCHOR, 'setInterval(() => { _petAnimApply(); }, 1000 / PET_ANIM_FPS);   // 🔌 加掛版補丁:間接呼叫讓外掛(省電模式)wrapper 攔得住;直接傳參照會被捕死原函式');
  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] 寵/召 sprite ticker 間接呼叫（${FILE}）`);
}

// ── 補丁 5：js/07 迴避頭目 與 外掛「自動找BOSS」互斥 ─────────────
//   afk-bossring 召來的王若被「迴避頭目(瞬移卷軸)」自動逃離立刻瞬移走=功能互咬。
//   逃離條件加 !_huntBoss(讀外掛暴露的 AFK_BOSSRING.huntActive();外掛未載=false 照常)。
function patchBossHuntEscape() {
  const FILE = 'js/07-skills-cast.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('AFK_BOSSRING')) { already++; return; }
  const A1 = "let tChk = document.getElementById('set-teleport');";
  const A2 = 'if (tChk && tChk.checked && mapState.mobs.some(m => m && m.boss && !m.noAutoTeleport)';
  if (s.indexOf(A1) < 0 || s.indexOf(A2) < 0) throw new Error(`[${FILE}] 找不到迴避頭目錨點——上游可能改寫了自動瞬移段。`);
  s = s.replace(A1, A1 + "\n        let _huntBoss = !!(window.AFK_BOSSRING && window.AFK_BOSSRING.huntActive && window.AFK_BOSSRING.huntActive());   // 🔌 加掛版補丁:外掛「自動找BOSS」進行中→抑制逃離(否則剛召來的王立刻被瞬移走);外掛未載入=false 照常");
  s = s.replace(A2, 'if (tChk && tChk.checked && !_huntBoss && mapState.mobs.some(m => m && m.boss && !m.noAutoTeleport)');
  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] 迴避頭目×自動找BOSS互斥（${FILE}）`);
}

// ── 補丁 6：js/08 useItem 加 keepModal 參數 ─────────────────────
//   外掛自動瞬移(afk-bossring)非 silent 使用卷軸時,上游會 closeModal() 把玩家開著的物品視窗關掉。
//   加第三參數 keepModal 讓自動路徑保留視窗(未傳=false,原行為不變)。
function patchUseItemKeepModal() {
  const FILE = 'js/08-items-equip.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('keepModal')) { already++; return; }
  const A1 = 'function useItem(u, silent = false) {';
  const A2 = "if(!silent && document.getElementById('item-modal').classList.contains('hidden') === false";
  if (s.indexOf(A1) < 0 || s.indexOf(A2) < 0) throw new Error(`[${FILE}] 找不到 useItem 錨點——上游可能改寫了簽名或關窗段。`);
  s = s.replace(A1, 'function useItem(u, silent = false, keepModal = false) {   // 🔌 加掛版補丁 keepModal:自動觸發(如外掛自動瞬移)非 silent 使用時,不關玩家開著的物品視窗');
  s = s.replace(A2, "if(!silent && !keepModal && document.getElementById('item-modal').classList.contains('hidden') === false");
  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] useItem keepModal（${FILE}）`);
}

// ── 補丁 7：js/10 「立即賣出」不再無條件強制套規則 ─────────────────
//   上游 sellAutoSellItemsNow 無條件 applyAutoSellRules(true)(force)→玩家把自動販賣總開關關掉後
//   按「立即賣出」,仍當場依規則把沒標過的裝備標成廢品賣掉(玩家回報:武官護鎧被莫名賣掉;舊 main ab230707dc)。
//   改為只有總開關開著才 force;關閉時只賣玩家已手動標記的廢品(applyAutoSellRules(false) 會清規則舊標記)。
function patchSellNowNoForce() {
  const FILE = 'js/10-ui-tabs.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('applyAutoSellRules(player.autoSellOn!==false)')) { already++; return; }
  const ANCHOR = 'function sellAutoSellItemsNow(){_readAutoSellForm();_asBackup=null;applyAutoSellRules(true);';
  if (s.indexOf(ANCHOR) < 0) throw new Error(`[${FILE}] 找不到 sellAutoSellItemsNow 錨點——上游可能改寫了立即賣出,請人工檢查(此補丁防「關閉自動販賣仍被強制套規則賣裝」)。`);
  s = s.replace(ANCHOR, 'function sellAutoSellItemsNow(){_readAutoSellForm();_asBackup=null;applyAutoSellRules(player.autoSellOn!==false);   /* 🔌 加掛版補丁:總開關關閉→不套規則,只賣手動標記的廢品 */');
  s = s.replace('// 🔧 v2.6.91 force=true：即使開關關閉也強制依規則標記後立即賣', '// 🔌 加掛版補丁:開關開著才 force 套規則;關閉時只賣手動標記(上游原為無條件 force)');
  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] 立即賣出不強制套規則（${FILE}）`);
}


// ── 補丁 8：js/05 每殺一隻怪都掃整個背包找「死亡騎士之印記」→ 先判地區再掃 ──────
//   原式:!_kbNoReward && player.inv.some(...印記...) && mapRegionOf(...) === 'rastabad'
//   `.some()` 是 O(背包長度) 且**每次擊殺都跑**,而後面那個地區判斷極便宜、又幾乎總是 false(只有拉斯塔巴德成立)。
//   純粹把 && 的順序對調(兩者都無副作用,短路結果完全相同):大背包玩家離線補跑省下可觀時間(6x 限速實測)。
function patchInsigniaOrder() {
  const FILE = 'js/05-kill-progression.js';
  let s = readFileSync(FILE, 'utf8');
  const FROM = "if (!_kbNoReward && player.inv.some(i => i.id === 'item_dk_insignia') && typeof mapRegionOf === 'function' && mapRegionOf(mapState.current) === 'rastabad')";
  const TO   = "if (!_kbNoReward && typeof mapRegionOf === 'function' && mapRegionOf(mapState.current) === 'rastabad' && player.inv.some(i => i.id === 'item_dk_insignia'))";
  if (s.indexOf(FROM) >= 0) {
    s = s.replace(FROM, TO);
    if (!CHECK) writeFileSync(FILE, s);
    changed++;
    console.log(`[patch] 聖地遺物判斷改先判地區（${FILE}）`);
  } else if (s.indexOf(TO) < 0) {
    throw new Error(`[${FILE}] 找不到聖地遺物(item_dk_insignia)判斷錨點——上游可能改寫了那段掉落。`);
  } else { already++; }
}

// ── 補丁 9：js/05 吉爾塔斯魔杖不再「每殺一隻怪就整個人重算一次」──────────
//   這把杖的效果＝擊殺後 10 秒內依邪惡值加額外魔法點數(js/02:306 的 d.extraMp)。上游作法是每次擊殺
//   都把持有者丟進 _giltasWandTriggered → 玩家走 calcStats()、傭兵走 _allyLevelRecompute()
//   (而後者結尾又叫一次玩家的 calcStats() → **一個傭兵拿杖＝每殺一隻重算兩次**)。
//   但 buff 本來就還在、加成值又沒變時,重算前後的 d 完全一樣＝白算;而每次重算都會經
//   getClanBuffStats() 把整包血盟資料(壓縮 23KB／解開 242KB)重讀＋JSON.parse＋正規化一次。
//   實測(玩家真實存檔·1 小時離線):沒人拿杖 2.4 秒、一個傭兵拿杖 54 秒、兩個傭兵拿杖 91 秒。
//   改法:只有「buff 原本已過期」或「加成值真的變了」才進重算清單——會改變 d 的情況一次都沒少,
//   純粹拿掉重複。上次的加成值記在 _giltasWandBonus(同 _giltasWandFuryUntil 一樣是存檔內的暫時欄位)。
//   到期那側的重算由 js/03 tick 既有的 _giltasWandExpired 負責,不受影響。
//   ⚠ 判準要比「加成值」不能只比「邪惡值」:普通怪每殺一隻邪惡值就 +1(要一路殺到 ±32767 才停),
//     比邪惡值等於幾乎每次都不同 → 完全省不到。而 pvpEvilBonus(20) 是量化過的(每 ~1638 點才跳一階),
//     真正決定 d 的是它。
//   ⚠ 傭兵那側要先把全域 player 暫時換成該傭兵再算:js/02:306 的 pvpEvilBonus() 讀的是**當下的全域
//     player**,而傭兵重算時 player 正是被換成該傭兵(_allyLevelRecompute 的既有做法)。在 killMob 裡
//     不換就算會拿到隊長的值,兩邊比錯。try/finally 保證任何情況都換得回來。
//   實測同一存檔 1 小時離線 54 秒 → 0.9 秒;擊殺數與掉落一致。
function patchGiltasWandRecompute() {
  const FILE = 'js/05-kill-progression.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('_giltasWandBonus')) { already++; return; }

  const SITES = [
    ["{ player._giltasWandFuryUntil = state.ticks + 100; _giltasWandTriggered.push(player); }",
      "{ let _gwB = (typeof pvpEvilBonus === 'function' ? pvpEvilBonus(20) : 0);" +
      ' let _gwSame = player._giltasWandFuryUntil > state.ticks && player._giltasWandBonus === _gwB;' +
      ' player._giltasWandFuryUntil = state.ticks + 100; player._giltasWandBonus = _gwB;' +
      ' if (!_gwSame) _giltasWandTriggered.push(player); }   // 🔌 加掛版補丁:buff 還在且加成值沒變→這次重算不會改變任何衍生值,略過(離線結算的最大熱點)'],
    ["{ a._giltasWandFuryUntil = state.ticks + 100; _giltasWandTriggered.push(a); }",
      '{ let _gwP = player, _gwB = 0; player = a;' +
      "   try { _gwB = (typeof pvpEvilBonus === 'function' ? pvpEvilBonus(20) : 0); } finally { player = _gwP; }" +
      ' let _gwSame = a._giltasWandFuryUntil > state.ticks && a._giltasWandBonus === _gwB;' +
      ' a._giltasWandFuryUntil = state.ticks + 100; a._giltasWandBonus = _gwB;' +
      // ⚠ 這一處在 forEach 的箭頭函式**中間**,後面還接著 `});`——註解只能用 /* */,
      //   用 // 會把同一行後面的 `});` 一起吃掉(語法壞掉,而且只在執行期才看得出來)。
      ' if (!_gwSame) _giltasWandTriggered.push(a); }/* 🔌 加掛版補丁:同上(傭兵路徑更貴——_allyLevelRecompute 內部還會再叫一次玩家的 calcStats);算加成值前先把 player 換成這名傭兵,因為 pvpEvilBonus 讀的是全域 player */'],
  ];
  for (const [from, to] of SITES) {
    if (s.indexOf(from) < 0) throw new Error(`[${FILE}] 找不到吉爾塔斯魔杖擊殺錨點「${from.slice(0, 46)}…」——上游可能改寫了該段,請人工檢查(此補丁是離線結算效能的關鍵)。`);
    s = s.replace(from, to);
  }
  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] 吉爾塔斯魔杖不再每殺必重算（${FILE}）`);
}

// ── 補丁 10：js/10 裝備分頁的部位條列補上「魔眼」欄 ──────────────────
//   上游把魔眼欄(slot:'eye'·地龍之魔眼)只加進 js/19 的圖形裝備視窗第 2 頁,js/10 renderTabs 裡
//   那份寫死的部位清單 _baseSlots 沒跟上 → 條列式看不到這個欄位。
//   上游看不出問題(圖形視窗蓋在條列上面),但加掛版的 afk-eqlist 預設就是走條列 → 玩家裝上魔眼後
//   整個介面都找不到它,只能從背包點回去才知道有沒有裝上(玩家回報 2026-08-09)。
//   清單是 renderTabs 內的區域 const,外掛包不住;自己在 DOM 補一列則要複製整段列渲染(套裝發光/
//   角標/點擊開視窗),故走錨點補丁改那個字面值——同一個 forEach 畫出來,行為與其他欄位完全一致。
//   ⚠ 第一頁是 4×6=24 格,補進去後一般裝備欄 21(戰士雙斧 22)格,仍在 24 內 → 遺骸 8 格照樣落在第 25 格起。
function patchEyeSlotInEquipList() {
  const FILE = 'js/10-ui-tabs.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes("{k:'eye',n:'魔眼'}")) { already++; return; }

  const FROM = "{k:'doll',n:'魔法娃娃'},{k:'arrow',n:'箭矢'}]";
  const TO = "{k:'doll',n:'魔法娃娃'},{k:'arrow',n:'箭矢'},{k:'eye',n:'魔眼'}]";
  if (s.indexOf(FROM) < 0) throw new Error(`[${FILE}] 找不到裝備分頁部位清單(_baseSlots)的錨點——上游可能改寫了該清單,請人工檢查魔眼欄是否已由上游補上。`);
  s = s.replace(FROM, TO);

  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] 裝備條列補上魔眼欄（${FILE}）`);
}

// ── 補丁 11：gainItem 遺物詞綴鉤子 ──────────────────────────────────
//   上游把遺物寫死排除在詞綴分支外（`!isRelic(d)`），而那是全遊戲產生詞綴的唯一入口。
//   外掛從外面包 gainItem 攔不到：等它跑完，物品已依「白板簽章」併進既有那一疊、掉落訊息
//   也印完了 → 事後改會改到整疊，要正確就得自己重寫核心的堆疊/日誌邏輯。
//   故比照補丁 2（__afkTradRollEn）加一個問外掛的鉤子：afk-relicaffix.js 提供 __afkRelicAffix，
//   決定這件遺物要不要帶祝福/遠古系/屬性。未載外掛/未開 → 回 null（或函式不存在）＝與原版一致。
//   forceNormal（潘朵拉遺物布告欄）與 _noAffixCtx（寵物白板）沿用核心語意：兩者一律不問鉤子。
function patchRelicAffixHook() {
  const FILE = 'js/08-items-equip.js';
  let s = readFileSync(FILE, 'utf8');
  if (s.includes('__afkRelicAffix')) { already++; return; }

  const ANCHOR = '    // 🔮 席琳套裝詞綴：';   // 席琳那段註解＋`let seteff = false;` 是一體的，插在它前面才不會把註解跟它解釋的那行拆開
  if (s.indexOf(ANCHOR) < 0) throw new Error(`[${FILE}] 找不到 gainItem 的席琳套裝詞綴錨點——上游可能改寫了詞綴段，請人工檢查後更新錨點。`);

  const EOL = s.includes('\r\n') ? '\r\n' : '\n';   // 核心是上游原檔鏡像（CRLF），插入行要跟著，否則整檔混行尾
  const INSERT = [
    "    // 🔌 加掛版補丁：遺物詞綴鉤子（外掛 afk-relicaffix 提供；未載/未開→null＝完全同原版）",
    "    if (!forceNormal && !_noAffixCtx && typeof window.__afkRelicAffix === 'function') {",
    "        let _ra = window.__afkRelicAffix(d, id);",
    "        if (_ra) { bless = _ra.bless || false; anc = _ra.anc || false; attr = _ra.attr || false; }",
    "    }",
    "",
  ].join(EOL) + EOL;
  s = s.replace(ANCHOR, INSERT + ANCHOR);

  if (!CHECK) writeFileSync(FILE, s);
  changed++;
  console.log(`[patch] gainItem 遺物詞綴鉤子（${FILE}）`);
}

// ── 補丁 12：武器內建魔法補上幻覺套裝鉤子（js/03＋js/04＋js/06，共 4 處）─────────
//   幻覺套裝的說明（js/01 `SHERINE_SET_TEXT`，資訊欄顯示給玩家看的那份）白紙黑字寫著
//   「魔爆及**武器內建**／免費觸發魔法…」，上游也確實把 spellProc／procSkill／立方／魔爆／
//   紅惡靈逆襲全接上了 `illusionMagicDmg()`。只有兩種武器內建魔法沒接上（玩家與傭兵各一處）：
//     ・`qiguProc` — 共鳴奇古獸「幻影衝擊」／寒冰奇古獸「心靈破壞」
//     ・`procDualSkill` — 解除封印的巴風特魔杖「熾焰地裂術」
//   兩者都走 magicBaseDamage × weaponMagicDamageCoef × 魔抗，正是說明講的那一類。判斷是「漏接」
//   而非「刻意排除」的依據：上游刻意不給的三種（一般傷害法術／共鳴／反射）都是**有呼叫、但傳
//   canTrigger=false** 並附註解說明理由；這兩處是連呼叫都沒有。
//   外掛包不住——傷害在函式內部算完就直接扣血，中間值攔不到（wrapper 只能事後比 HP 差，遇到
//   這一擊擊殺就整個錯）。故走錨點補丁，但行為仍問外掛 `__afkIlluWpnFix()`（afk-wpnfix 提供，
//   受它的 wpnfix 開關管）；未載外掛／關掉＝與原版位元組等價。
//   ⚠ 插在最後一個乘數之後、扣血與 logCombat 之前 → 戰鬥訊息印的數字跟實際扣的血一致。
function patchIllusionSetWpnProc() {
  const ON = "(typeof window.__afkIlluWpnFix === 'function' && window.__afkIlluWpnFix())";
  // [檔, 錨點(插在它前面), 要插入的敘述, 說明]
  const SITES = [
    ['js/03-combat-core.js',
      "target.curHp -= dmg; if (typeof terrorVisageOnDamage === 'function') terrorVisageOnDamage(target, dmg, 'magic');",
      `dmg = ${ON} ? illusionMagicDmg(dmg, true) : dmg;   /* 🔌 加掛版補丁:奇古獸內建魔法(幻影衝擊/心靈破壞)補上幻覺套裝 2/5 件 */ `,
      '奇古獸特效·玩家'],
    ['js/06-status-allies.js',
      "t.curHp -= pd; if (typeof terrorVisageOnDamage === 'function') terrorVisageOnDamage(t, pd, 'magic');",
      `pd = ${ON} ? _allyIllusionMagicDmg(ally, pd) : pd;   /* 🔌 加掛版補丁:同上(傭兵) */ `,
      '奇古獸特效·傭兵'],
    ['js/04-combat-attack.js',
      "_dt.curHp -= _tot; _dt.justHit = 'fire'; mobWake(_dt);",
      `_tot = ${ON} ? illusionMagicDmg(_tot, true) : _tot;   /* 🔌 加掛版補丁:解除封印的巴風特魔杖(熾焰地裂術)補上幻覺套裝 2/5 件 */ `,
      '熾焰地裂術·玩家'],
    ['js/06-status-allies.js',
      // 傭兵這側扣血在 _allyDamageMob，錨在它前面的特效行 → 插入點仍落在 logCombat 之前
      "if (typeof playSpellFx === 'function') { try { playSpellFx(_pd.skn || '熾焰地裂術', _dt, ally); } catch (e) {} }",
      `_tot = ${ON} ? _allyIllusionMagicDmg(ally, _tot) : _tot;   /* 🔌 加掛版補丁:同上(傭兵) */ `,
      '熾焰地裂術·傭兵'],
  ];
  for (const [FILE, anchor, stmt, label] of SITES) {
    let s = readFileSync(FILE, 'utf8');
    if (s.includes(stmt.trim())) { already++; continue; }   // 冪等（每處的敘述各自不同，可逐處判斷）
    if (s.indexOf(anchor) < 0) throw new Error(`[${FILE}] 找不到「${label}」的錨點「${anchor.slice(0, 46)}…」——上游可能改寫了該段，請人工確認幻覺套裝是否已由上游自己接上。`);
    s = s.replace(anchor, stmt + anchor);
    if (!CHECK) writeFileSync(FILE, s);
    changed++;
    console.log(`[patch] 武器內建魔法吃幻覺套裝 — ${label}（${FILE}）`);
  }
}

const PATCHES = [patchMaybeSpawnMobs, patchTradEnHook, patch16Slots, patchPetAnimTicker, patchBossHuntEscape, patchUseItemKeepModal, patchSellNowNoForce, patchInsigniaOrder, patchGiltasWandRecompute, patchEyeSlotInEquipList, patchRelicAffixHook, patchIllusionSetWpnProc];

try {
  for (const p of PATCHES) p();
} catch (e) {
  console.error('❌ apply-core-patches 失敗：' + e.message);
  process.exit(1);
}

if (CHECK) {
  if (changed > 0) { console.error(`❌ --check：有 ${changed} 個核心補丁尚未套用（請跑 node scripts/apply-core-patches.mjs）`); process.exit(1); }
  console.log(`✅ --check：全部 ${already} 個核心補丁均已就位。`);
} else {
  console.log(`✅ apply-core-patches 完成：新套用 ${changed}、已存在 ${already}。`);
}
