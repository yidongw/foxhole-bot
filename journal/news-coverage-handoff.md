# 新闻&覆盖率&安全 审计交接棒(2h 循环)

与代码正确性复查循环(review-handoff.md)分工不同:本循环专注
① 新闻漏分析 ② 暴涨漏报/报了没动静 ③ 代码漏洞/安全。每轮更新本文件,下轮先读。

## 2026-09-03 11:0x UTC 第 4 轮(验证前修 + 新面扫描,无新代码改动)

本轮无新增修复——三处旧修均在生效,新代码面无高危。

### ① 新闻(24h 192 条回放,健康)
- 无新噪音模式:32 wake 全是 legit RB/BNB meme(PONS/CASHCAT/JINQIAN/FLORK/
  MARSCOIN/NUDES/INDEX/USELESS)。R2「watched 只看标题」再次验证有效。
- 「交易赚币」「借壳收割」仍出现在 wake,但**来自 R3 修复前种下的 hotSymbols**
  (时间戳冻在 02:47/02:50,未再刷新)→ 确认 R3 的 pure-CJK 守卫已部署且停止再种,
  48h 后自然过期。无需再动。
- drop 侧无真漏(Fomo平台收入/HYPE增持/ETH建仓/「牛来」转 Binance 均正确丢弃)。

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净:2 mover 全在册(738 币,持续增长)。
- 哑弹分析仍无数据(labeled.json 未产出)。

### ③ 安全(1 条新观察,扩充 P2)
- 部署库已追平 origin(R3 的 deploy-lag 已由 smart-money 部署对账化解)。
- **smart-money 新模块扩大了 decider 注入面**:engine.ts 把 GMGN 来的 symbol/CA
  (如「刘大根」「云九」,攻击者可任意命名)写进 ai-inbox 并 maybeSpawnDecider("signal")
  → 同 news 一类的 prompt-injection 通道(P2)。另 RB 币被 smart-money 信号自动加进
  v4 watchlist 且 verified:true(信任 GMGN 数据)。缓解仍在:decider 自查
  DexScreener+safety 门 + $50 paper 夹死,非自动买。**建议**:symbol/address 进
  inbox 前做校验/转义(需与 smart-money owner 协调)。无 .buy/execute 绕过 CLI。
- 新代码无私钥/webhook 日志泄漏。npm audit 同旧。

### ④ 健康(绿)
- npx tsc 干净;npm test **177 passed**(smart-money 加了测试)。
- monitor 存活,3 分钟前(11:05Z=本地18:05)刚被 smart-money 部署重启,news lastRunAt
  与 lastId 均实时(**注意:ps/stat 打本地时区 UTC+7,log/state 是 UTC——别把
  18:05 本地 误当 7h 前**)。无 stall,无未捕获异常。

**下轮重点:** ① 继续盯「」junk 是否随过期消失(约 09-05 02:47Z 后应清零)。
② labeled.json 一出现即做哑弹分析。③ 若 smart-money owner 未处理,注入面校验可自己补。

---

## 2026-09-03 16:0x UTC 第 3 轮(自迭代循环首触发)

### ① 新闻(24h 191 条回放,已修)
- **修 junk hotSymbol 自我循环**,commit 72eefdc:「交易赚币」「借壳收割」这类
  促销/叙事短语被 extractSymbols 的「」引号规则当 token 种进 hotSymbols,又命中
  自己的来源快讯(OKX闪赚 / Meme信息汇总)→ **永不过期的自我循环误叫醒**(每轮 1-2
  条浪费 judge)。修:引号内 ≥4 的纯中文不再入 hotSymbols(真名如「牛来」≤3 汉字
  或含拉丁/数字仍保留)。test +1(news.test 共 26)。
- R2 的 watched-只看标题 修复本轮验证有效:24h 回放已无 NVDA/SPCX 正文噪音叫醒。
- 漏分析:drop 侧仍无真漏(HYPE 增持/ETH 建仓/BTC 巨鲸/「牛来」转 Binance 均正确丢弃;
  「牛来」非我方持仓,dump 不追)。

### ② 覆盖率(健康)
- robinhood ≥100% 实时对照干净:3 个 mover 全在 monitor-state(673 币在册,较 R1 的
  565 增长,发现源在扩)。
- 哑弹分析**仍无数据**:data/outcomes/labeled.json 依旧不存在(grading 未产出标签)。

### ③ 安全(无新增)
- review 循环新代码(SOL pump.fun watcher / BSC v2 fills / stock-watch)扫过,
  无私钥/webhook 日志泄漏。npm audit 同旧(Solana 依赖树 6 high,破坏性,留观)。

### ④ 健康(⚠️ 部署滞后 — 本轮头号发现)
- tsc 干净;npm test **144 passed**(review 循环加了测试)。monitor 存活(pid 99107)。
- **部署库落后 origin/main 6 个 commit 且卡住**:data/outcomes/pending.json、
  data/launches.json、journal/trades/*.md 等 **live runtime JSON 被 git 跟踪但由
  运行中的 bot 持续改写** → `git pull --ff-only` 一直被 dirty working tree 挡下。
  monitor-state.json 等已在 .gitignore,但上述账本类没有。结果:我的 R3 + review 的
  SOL watcher/BSC fills 都没进部署库工作树(monitor 仍跑 R1+R2 代码,R3 未生效)。
  - 未强推:活写者在改这些文件,手动 checkout/stash 会竞态并可能丢 outcomes 账本。
  - **建议(需 owner 协调,跨两循环)**:把 bot 自写的账本(pending/launches/missed/
    trades)加进 .gitignore(像 monitor-state.json 那样),或加一个"部署侧先 commit
    数据再 pull"的 deploy 脚本。当前 deploy-local.sh 只发 web 面板,不管 git 同步。

---

## 2026-09-03 07:xx UTC 第 2 轮(扩样本 + 深挖)

### ① 新闻(拉 24h 全量 193 条回放,已修)
- **误叫醒 36→30**,commit 7fcc547:24h 大样本暴露 R1 没看到的第二类噪音——
  **股票同名 meme(NVDA/SPCX/TSLA/AAPL)在美股宏观快讯正文里被顺带提及 → watched
  命中误叫醒**(「美股三大股指收涨」「奥本海默上调 SpaceX 目标价」「合约巨鲸做空美股」)。
  根因:hitSymbols 匹配 title+content 组合串,与文档注释「点名哪个币只看标题」矛盾。
  修:watched 只匹配 rawTitle;rb-chain/动能/负面 仍看 title+content。去掉 3×NVDA
  宏观 + 3×SPCX 股票新闻,无 legit 信号丢失。test +1(共 25)。
- 漏分析:193 条 drop 侧仍健康,无真漏(核对了所有含 Robinhood/Meme/巨鲸/上线
  关键词的 drop:HYPE 清仓/BTC 巨鲸/Predict.fun 预测市场 等均正确丢弃)。
  小瑕疵:WHALE_BUY 只认「巨鲸/交易者/聪明钱」不认「鲸鱼」,漏了「某鲸鱼建仓 HYPE」
  ——但 HYPE 是大币非我方标的,不值当放宽。
- 挂账仍在:「」引号名 junk hotSymbol(交易赚币/借壳收割)未动,48h 自过期。

### ② 覆盖率(复核,健康)
- monitor 重启后 solana/bsc/base 全在扫(SOLCAT +504%、four.meme BSC 都在流)。
- **重要发现-已澄清**:registry.ts 顶层静态 import pumpfun→@pump-fun/pump-sdk,
  若该 sdk 加载失败会拖垮**整个 monitor**(非仅 solana)。但两次 kickstart 重启
  在 Node 26 下都加载成功,BN 崩溃未复现 → 判定为**潜在脆弱性而非活跃故障**,
  不动(改一个正常工作的 import 风险更大)。若日后重启频繁命中再考虑懒加载兜底。

### ③ 安全 / ④ 健康
- 无新增。tsc 干净,npm test 125 passed。monitor 重启健康。

---

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
