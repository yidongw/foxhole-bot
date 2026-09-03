# 新闻&覆盖率&安全 审计交接棒(2h 循环)

与代码正确性复查循环(review-handoff.md)分工不同:本循环专注
① 新闻漏分析 ② 暴涨漏报/报了没动静 ③ 代码漏洞/安全。每轮更新本文件,下轮先读。

## 2026-09-03 04:2x UTC 第 1 轮(建立基线)

### ① 新闻(archive 回放 82 条快讯,已修)
- **误叫醒(noise-wake)17→14**,commit 70f5046:
  - 根因:extractSymbols 把交易所名(OKX)、指数ETF(SPY/QQQ)抓进 hotSymbols,之后
    在 Robinhood 语境里被当 watched 命中 → ARB涨12%、HOOD股价、OKX闪赚、SPY/QQQ
    预测市场全被叫醒。
  - 修复三处(src/news/filter.ts):① hitSymbols 显式排除 SYMBOL_STOPLIST(主流币/
    交易所/指数永远不是我们的 meme,即便 memeContext 也不算命中,顺带治好 ARB/HOOD);
    ② 交易所名+指数ETF 加进停用词,不再被种成热点币;③ LISTING 增 SAVINGS_PROMO
    排除(闪赚/理财/奖池 ≠ 现货上所)。test/news.test.ts +2 回归。
- **漏分析(miss)**:drop 侧健康(宏观/BTC/ETH/AI/政治正确丢弃)。唯一候选
  "KOL Rune 编造 数据"独立快讯被 drop,但其姊妹快讯(点名 JINQIAN/FAMI)已叫醒 →
  退出信号未真漏。无需改。
- **挂账**:「」引号名提取仍会把 promo/叙事短语(「交易赚币」「借壳收割」)种成
  junk hotSymbol(48h 自动过期)。想按 MEME_CONTEXT 收紧,但会误伤真名如「牛来」
  (其崩盘快讯标题不带 Meme/RB 字样)→ 暂留观察,下轮如复发再想更细的启发式。

### ② 覆盖率 / 哑弹
- **robinhood 实时对照干净**:DexPaprika 榜 ≥100%(vol≥100k,liq≥30k)当前仅 2 个,
  均已在 monitor-state(565 币在册)。无新覆盖盲区。
- coverage 流水(review/daily.ts fetchTopMovers→missed.json)按 24h cadence 跑,
  lastReviewAt=09-02T13:15,下次 ~09-03T13:15 到期,属正常。missed.json 现 4 条
  (全 robinhood,昨日:ORBIO/microduck/MOO/JINQIAN),分类正确。
- solana/bsc 的裸榜有 ≥100% 但未过 ladder/collapse/safety 门,且系统覆盖模型是
  launch-detection+robinhood 为主,未逐一验证=不算实锤漏报(别当漏报硬报)。
- **哑弹分析暂无数据**:data/outcomes/labeled.json 尚不存在(grading 还没产出标签,
  系统年轻)→ 无法评"报了走平"的假警报。下轮 labeled.json 出现后再做。

### ③ 安全(扫描完成,均为挂账,无当场高危)
- ✅ 私钥/webhook:无日志/Discord/git 泄漏;.env gitignored,仅 .env.example 在册;
  git grep 无 committed secret。私钥仅经 env→viem privateKeyToAccount。
- ✅ 注入面:decider spawn 用数组参数+静态 PROMPT,新闻标题不进 argv,无 shell 注入。
- ✅ 原子写(temp+PID.tmp+rename)、各 loop try/catch+退避+3连败告警,健壮。
- **挂账-P2 提示注入**:新闻标题(不可信)经 ai-inbox 进 decider 的 `claude -p`
  上下文且 --allowedTools Bash。已被 paper+ai-trade CLI+$50 夹死,但恶意标题理论上
  可试图操纵 AI。建议后续:把不可信内容包裹/收紧工具白名单。未改(改动需慎)。
- **挂账-P3 npm audit**:13 漏洞(6 high)全在 Solana 依赖树(bigint-buffer 缓冲区
  溢出 ← @solana/web3.js/jayson)。利用需解析恶意链上数据+paper 模式,修复要
  @solana/web3.js 大版本(破坏性)→ 不 force,留观。
- **挂账-P3 pump-sdk 启动崩溃**:日志顶部一次 `@coral-xyz/anchor 不导出 BN`
  SyntaxError,来自 @pump-fun/pump-sdk 打包体在 Node 26 下 ESM 具名导出探测失败。
  当前进程 solana 扫描正常(非持续故障),但重启偶发命中会丢 solana 覆盖。
  建议:钉 Node 版本或升级/替换该 sdk。未改。

### ④ 系统健康
- ✅ npx tsc --noEmit 干净;npm test 124 passed(+2)。
- ✅ monitor 日志:最新 tick(04:22)正常扫 robinhood/solana/bsc/base/ethereum,
  告警在流。除 ②③ 提到的 pump RPC 瞬时 `fetch failed`(已 catch)外无未捕获异常。

### 下轮重点
1. labeled.json 一旦产出 → 做哑弹/假警报分析(哪些触发器组合领先于走平)。
2. 若 junk hotSymbol(「」引号名)复发误叫醒,细化 extractSymbols 引号名启发式。
3. pump-sdk BN 崩溃如再现(grep 日志 "export named 'BN'"),动手钉 Node/换 sdk。
4. 继续每轮 robinhood ≥100% 实时对照,守覆盖基线。
