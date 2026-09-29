# 加掛版版本控制（2026-09-29 起）

站主拍板：原作者已停止開發、**不再同步上游**，版本號由我們自己管理，從 **v3.9.0** 開始。

## 版號規則（沿用 js/00 註解的格式 vA.B.C）
- 修正／小調整：C +1（v3.9.0 → v3.9.1）
- 新功能：B +1、C 歸 0（v3.9.x → v3.10.0）
- 大改版（站主決定）：A +1

## 每次上線（push）前必做
1. `js/00-data.js` 的 `GAME_VERSION` 改成新版號
2. `index.html` 的 `#login-version` 後備文字改成同一個版號（否則開頁會先閃舊版號，window.onload 要等所有資源才會填）
3. `afk-changelog.js` 的 `CHANGELOG` **最上面**加一筆 `{ ver, date, items: [...] }`
   - 只寫玩家有感、玩家看得懂的話；不寫檔名、函式、commit、內部機制
4. 照 /prepush：`node scripts/stamp-code-versions.mjs`、`node scripts/stamp-sw-version.mjs`、smoke、`--check`
5. push 前先打還原點 tag：`pre-<功能>-YYYYMMDD`（= 當時的 origin/main）

## 回滾
- 程式：`git push origin <pre-tag>:main --force-with-lease`（需站主同意）→ 等 Pages 建置 → 各裝置重整
- 角色存檔：`~/Studio/Projects/idle-lineage-cloudsave/tools/restore-save.mjs`（先試跑、`--apply` 才寫；也可用 Worker 小時快照 `--list` / `--bucket`）
- 上線前的存檔備份：`~/Studio/Projects/idle-lineage-cloudsave/backups/<YYYYMMDD-HHMM>/slot{1,2}.json`
