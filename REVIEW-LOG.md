# Review Loop Journal (每日复盘日志)

Append-only log of every self-review run: movers found, human
confirmations/exclusions, filter changes, tuner decisions, backtests.
Written automatically by `src/review/daily.ts`; manual sessions recorded
here too.

## 2026-09-02 — 首次人工复盘(本日志建立前的手动会话)

**发现的真实暴涨币(用户确认 legit,已存为 miss 案例):**
- ORBIO [robinhood] +378% vol $2.7M liq $274K `0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3`
- microduck [robinhood] +163% vol $9.0M liq $574K `0xD5f1afEA47b1A9eab414D2ee740cF1d6d039E725`
- MOO [robinhood] +104% vol $5.8M liq $1.6M `0xD9dB30BB0D2b8d2eae3826A1372117E058791e18`

**用户判定为垃圾并加入永久黑名单:**
- Pumpcat, DEBTCOIN, UBIK(DUzDq…), AAPL(9PGS…) — 全部 solana

**本次会话新增的过滤器(全部来自用户人肉审查发现的坑):**
1. 大户集中度否决 — "TSLA" 案例: 权限全干净但单一未锁仓钱包持有 80%
   (池子只占 1.6%)。规则: top holder ≥60% 且未锁仓 → 拒绝。
2. 刷单画线检测(1h) — "AVANT" 案例: 22 小时 100% 阳线、零回撤、
   直线度 1.00。规则: ≥10根/≥+50%/直线度≤1.25/阳线≥85%/回撤≤8%。
3. 快梯子检测(15m, GeckoTerminal) — "Pumpcat" 案例: 5 分钟蜡烛 3 小时
   画完然后 rug, 1h 粒度只有 3 根看不见。
4. 无K线数据 = 疑似已跑路 → 拒绝(旧代码把"查不到"当"没问题")。
5. 已崩盘判定(现价 < 窗口最高的 40%)— 不再当作可关注对象。

**数据源扩展:** DexPaprika 1页→3页(300池/链) + 新增 GeckoTerminal
trending(有机热度源, 修正按量排序被刷量垃圾霸榜的问题)。

**回测状态:** 11/11 基础 fixtures 通过; 调参器等待案例库 ≥5。

**流程变更(用户要求):** 暴涨候选自动过滤后必须发清单给用户人工确认,
确认后才进案例库/调参; 剔除项进永久黑名单; 每次 loop 写入本日志;
复盘可发到专用 channel (DISCORD_REVIEW_WEBHOOK_URL)。
## 2026-09-02 10:13 UTC — Phase 1 — 扫描
- 警报评分: 0 (赢 0 / 假 0)
- 暴涨扫描: 1 个, 自动过滤 0 个, 待人工确认 1 个
  - 1. ORBIO [robinhood] +439% coverage_miss `0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3`

## 2026-09-02 10:13 UTC — Phase 2 — 确认与调参
- 确认 1: ORBIO[robinhood]
- 剔除进黑名单 0: 无
- 案例库: 3 个案例
- 调参: 无变更 — case library too small (3/5) — collecting evidence
- 回测: 当前配置 赢0 漏3 假0

## 2026-09-02 10:39 UTC — Phase 1 — 扫描
- 警报评分: 0 (赢 0 / 假 0)
- 暴涨扫描: 1 个, 自动过滤 0 个, 待人工确认 1 个
  - 1. ORBIO [robinhood] +471% coverage_miss `0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3`

## 2026-09-02 — Discord 频道分配

- **#trade-signal** ← 信号警报 (DISCORD_WEBHOOK_URL)。用户纠正: 信号必须是
  暴涨**前**的预警, 不是暴涨后的播报 — 复盘循环的优化目标即信号提前量。
- **#filter-log** ← 过滤明细 + 复盘确认清单 (FILTER + REVIEW webhook)
- **#trade-log** ← 交易日志 (TRADE webhook)
- 三个 webhook 已用运行时 bot 令牌创建并写入主 checkout `.env`
  (该文件另已含自动开通的 Alchemy RPC)。各频道已收到接入验证消息。
## 2026-09-02 — 按链频道分配完成

15 个频道(5链×3类)全部命名为 <链色><类型icon>-<链>-<类型>:
链色 🟢rb 🟣sol 🟡bsc 🔵base ⚪eth;类型 🎯trade-signal 💰trade-log 🧹filter-log。
12 个新 webhook 创建并与 rb 三个原 webhook 一起写入 .env 的 per-chain 变量;
rb 频道同时兼任全局兜底(复盘确认清单发 🟢🧹-rb-filter-log)。
