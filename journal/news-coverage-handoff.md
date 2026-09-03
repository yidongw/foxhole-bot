# 新闻&覆盖率&安全 审计交接棒(2h 循环)

与代码正确性复查循环(review-handoff.md)分工不同:本循环专注
① 新闻漏分析 ② 暴涨漏报/报了没动静 ③ 代码漏洞/安全。每轮更新本文件,下轮先读。

## 2026-09-03 23:0x UTC 第 10 轮(安静轮:全绿;OpenNews 复活)

四项全稳,无新问题需修;一个正向变化:OpenNews 恢复产出。

- ① 新闻:BlockBeats 35 wake 全 legit,无新噪音/漏。**OpenNews/6551 复活**——日志
  `opennews tick: 30 scored, 2~6 posted`,累计降级仅 13(R7 时是 12,几乎不再降级)→
  说明 OPENNEWS_TOKEN 额度恢复,AI 打分定向搜索重新上线,每 tick 向 #news-radar 发
  2~6 条。它是 informational-only(不唤醒 decider、不自动买),即便略多也无交易风险,
  暂不动;若 #news-radar 觉得吵可在 opennews-poll 收紧 CAP/score 阈值。
- ② 覆盖率:robinhood ≥100% 对照干净(7 mover 全在册,**1047 币**)。哑弹仍无解
  (labeled 15/clean 9,grader 未产新标签)。
- ③ 安全:无新代码可扫;smart-money P2、Solana audit 6 high 仍挂账。
- ④ 健康:tsc 干净、npm test **251 passed**、monitor 稳定运行 ~4h+ 未重启(pid 82431)、
  BN 未复现、0 uncaught。**(复核:一度疑 news lastRunAt 停摆 7h,实为真实 UTC now
  =23:06Z、lastRunAt=23:04Z 仅 2min 前——又是时区错觉,已用 date -u + feed 最新
  flash 时间交叉验证确认无停摆。)**
- 「」junk:交易赚币 02:47Z / 借壳收割 02:50Z 仍冻结,距 09-05 02:47Z TTL 到期约 27h。

**下轮重点:** ① 「」junk 09-05 02:47Z 后复查是否消失。② grader 产新标签后做哑弹分析。
③ OpenNews 复活后如 #news-radar 偏吵,评估 opennews-poll 的 score/CAP 收紧。

---

## 2026-09-04 04:0x UTC 第 9 轮(安静轮:全绿,无新改动)

BlockBeats 隔夜出稿少,feed 与 R8 高度重合;四项全稳。
- ① 新闻:35 wake 全 legit,无新噪音/漏。「」junk(交易赚币 02:47Z/借壳收割 02:50Z)
  仍冻结未刷新,距 09-05 02:47Z TTL 到期约剩 <23h,下轮应见其消失。
- ② 覆盖率:robinhood ≥100% 对照干净(8 mover 全在册,**1003 币**破千,持续增长)。
  哑弹仍无解:labeled 仍 15(clean-data 仅 9),pending 已 187(56 strong)等评分——
  grader 未产新标签,样本不足不做 tuning。
- ③ 安全:无新代码改动可扫;smart-money P2、Solana audit 6 high 仍挂账。
- ④ 健康:tsc 干净、npm test **251 passed**、monitor 稳定运行 2h+ 未重启(pid 82431)、
  BN 未复现、0 uncaught。

**下轮重点:** ① **复查「」junk 09-05 02:47Z 后是否消失**(R3 闭环验证)。
② grader 产新标签后做哑弹分析(现 n=9 clean 太小)。③ OpenNews 若充值复查产出。

---

## 2026-09-04 02:0x UTC 第 8 轮(安静轮:全绿,前修均持,无新改动)

四项全部健康,prior fixes 全在生效,无新问题需修。

### ④ 健康(绿)— R7 测试修复已持
- npx tsc 干净;npm test **251 passed**(review 循环加了很多测试)。R7 修的
  routes.test 未复红。monitor 存活(pid 82431),BN 未复现(计 1),日志无
  uncaught/unhandled/fatal。

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净:5 mover 全在册(958 币,持续增长)。
- **哑弹分析无进展**:labeled.json 仍 15 条(无新评分产出),n 太小不做二次分析。
  下轮样本增长再看。(review 循环 Phase2 已在追 GRASS missed pump,非 robinhood,不撞车。)

### ① 新闻(BlockBeats 稳定)
- 回放(200 条)35 wake 全 legit;drop 侧的"含关键词"项全是宏观正确丢弃
  (BTC破8万/ETH破2500/黄金/原油/加密概念股/特斯拉 Cybercab/HYPE)——无 RB-meme 真漏。
  「加密概念股…Robinhood 涨超10%」是股票新闻,已被 R2 标题匹配+宏观过滤正确 drop。
- **R3「」junk 继续冻结**:交易赚币(02:47Z)、借壳收割(02:50Z)未再刷新,
  距 09-05 02:47Z TTL 到期约剩 <1 天,下轮应见其消失。

### ③ 安全(无新高危)
- R7-R8 间新代码(smart-money revet disable/enable、review Phase2 GRASS case)无
  私钥/webhook 泄漏。smart-money P2 注入面、npm audit Solana 6 high 仍挂账留观。

**下轮重点:** ① **复查「」junk 是否已从 hotSymbols 消失**(应在 09-05 02:47Z 后)——
若仍在则说明有再种入,需查。② labeled 变多再做哑弹分析。③ OpenNews 若充值复查产出。
④ 继续 robinhood 实时对照。

---

## 2026-09-04 00:3x UTC 第 7 轮(修了 main 上的红测试;SHRUB 真相澄清)

### ④ 健康(**修了 main 上一个常红测试** — 本轮重点)
- **test/routes.test.ts 在 main 上 1 红**,commit bc44a33:review 循环把 review 输出
  改成 thread-only(commit「thread-only output」),resolveWebhook('review') 不再回退
  filter 频道,但测试未同步 → `resolveWebhook('review')` 期望 'filter' 实得 undefined。
  改测试断言匹配现有契约(review→REVIEW webhook 或 undefined,无 filter fallback),
  **纯测试改动、不碰任何行为**。全套恢复 185 绿。(已知会与 review 循环沾边,但红测
  卡健康门,且是无歧义的 stale-test,低撞车风险;已在此留档告知对方。)
- tsc 干净;monitor 存活(pid 75365),BN 崩溃未复现(仍计 1)。

### ② 覆盖率(健康;SHRUB 真相)
- **SHRUB 是骗局**:review 循环/用户已把它加进 denylist(commit「restore user denylist
  entries (SHRUB scam…)」)。→ 我 R5 的 movers 发现修复**技术上正确**(它确实曾被发现源
  漏掉),而 denylist/safety 层正确地把这个 scam 挡在入场外 —— 分层设计按预期工作:
  发现层找到、denylist 层拒绝。发现修复保留(对合法有机暴涨仍有效)。
- robinhood ≥100% 对照干净:4 mover 全在册(919 币,持续增长)。
- review 循环还落地了我 R6 flag 的数据质量修复(commit 含「stock/data-quality exclusion」)。

### ① 新闻(BlockBeats 稳定)
- 回放(200 条)35 wake 全 legit;「GoPro 永续」listing 放行属设计。无新噪音/漏。
- **R3「」junk 修复继续冻结**:交易赚币(02:47Z)、借壳收割(02:50Z)时间戳未再刷新,
  约 09-05 02:47Z 后随 TTL 清零。

### ③ 安全(无新高危)
- R6-R7 间新代码(smart-money 钱包增删、review fdv-gate/data-quality 修复)无私钥/webhook 泄漏。
- smart-money P2 注入面、npm audit Solana 6 high 仍挂账留观。

### 📊 附:本轮前用户手动要求的「新闻源+警报复盘」要点(留档)
- BlockBeats:主力健康,29 wake+1 exit,噪音经 R1-R6 治理已清零。
- **OpenNews/6551:实质休眠**——累计仅 1 post,12 次免费降级(OPENNEWS_TOKEN 402
  额度耗尽 → 回退 free_hot web3 泛热榜,非 meme 定向,几乎 0 产出)。降级属设计内。
  待用户决定是否给 6551 token 充额度重启 AI 打分定向搜索。
- 判定层 judgeFlash:key 在、在跑、0 拒绝(候选皆真信号);opus-5 每 wake 一调,成本可优化。
- 警报:~8/轮,pending 63,labeled 15(53% 胜率>30% 底线),数据质量已转 review 修。
- 交易质量观察(归 engine):多笔被 25%-off-high trail stop 在 -15~-29% 割掉,止损偏紧。

**下轮重点:** ① 「」junk 约 09-05 02:47Z 后应从 hotSymbols 消失,复查确认。
② labeled 样本变多变干净后重做哑弹分析。③ OpenNews 若充值则复查其定向产出质量。
④ 继续 robinhood 实时对照。

---

## 2026-09-03 15:0x UTC 第 6 轮(前修全部验证 + 首次哑弹分析,无新代码改动)

前几轮的修复本轮全部实测生效;哑弹数据首现但太少/太脏,不足以动阈值。

### ② 覆盖率 + 哑弹(**首次哑弹分析** — 本轮重点)
- **R5 SHRUB 修复实测生效**:SHRUB(0x5d9144d2…)现已在 monitor-state → robinhood
  movers feed 实时发现盲区已闭合。robinhood ≥100% 对照干净(849 币,较 R5 799 增长)。
- **labeled.json 首次出现(15 条,全 strong 级)**,做了哑弹分析:8 win / 4 flat / 3 loss。
  但数据太少且被污染,**不足以据此收紧阈值**(强行改=对噪音过拟合):
  - 3 个 loss 里有 2 个(AMZN、BITCAT)candleCount=0 / maxReturn=None ——
    **无数据被误判成 loss**(grader 应记 nodata/unknown,不是 loss)。
  - SPACEHOOD maxReturn=+12522、FLORK=+5,276,950 —— **OHLCV 数据损坏**(不可能的收益),
    污染任何统计。
  - 干净的只剩 1 个真 loss(CARE,liq $56k 砸 -63%)+ 2 个 flat(AI 高流动性走平、
    MACRODUCK candles=1)。趋势暗示 high_volume(2/2 flat)、volume_spike_strong
    (50% 走平/亏)偏弱,但 n 太小+数据脏,留待样本增长再判。
  - **跨循环挂账(归 review 循环 grader/tuner)**:① candles=0 不该判 loss;
    ② 损坏 OHLCV(百万%收益)需 sanity-cap。二者会误导 tuner,建议 review 循环处理。

### ① 新闻(BlockBeats 稳定;R3 junk 修复实测冻结)
- 回放(199 条)34 wake 全 legit(PONS/CASHCAT/JINQIAN/USELESS/MARSCOIN/HOOKR/BUN…);
  「GoPro 永续」listing 放行属既有设计。无新噪音/漏。
- **R3「」junk 修复生产实测生效**:交易赚币(02:47Z)、借壳收割(02:50Z)时间戳**冻结未再刷新**,
  无新纯中文长引号名被种入 → 确认停止自我循环,约 09-05 02:47Z 后随 48h TTL 清零。

### ③ 安全(无新高危)
- R5-R6 间新代码(winner-finder v2 / review 重标定)无私钥/webhook 泄漏。
- smart-money P2 注入面(R4)、npm audit Solana 6 high(破坏性)仍挂账留观。

### ④ 健康(绿)
- tsc 干净;npm test **185 passed**。monitor 存活(pid 61940),BN 崩溃未复现(仍计 1)。

**下轮重点:** ① labeled.json 样本变多且数据变干净后再做哑弹分析(现 n=15 太脏)。
② 「」junk 约 09-05 02:47Z 后应从 hotSymbols 消失,复查确认。③ 继续 robinhood 实时对照
守 SHRUB 类不再漏。④ smart-money 注入面校验若 owner 未处理可自补。

---

## 2026-09-03 13:0x UTC 第 5 轮(抓到并修了一个真覆盖盲区)

### ② 覆盖率(**修了 1 个真漏报盲区** — 本轮重点)
- **robinhood 实时发现独缺 movers feed**,commit 8c799fe(已部署):主战场
  robinhoodAdapter.trendingCandidates 此前只用 DexScreener 推广位,唯独没接
  其它链都在用的 fetchMoverCandidates(DexPaprika 有机暴涨榜)。后果:非 Long.xyz
  股票对上线、又不在推广位的**有机暴涨会实时漏扫**,只能等日更 review 兜底。
  - 实证:**SHRUB**(robinhood,0x5d9144d2…)+235%/6h、$4.2M vol、$329k liq、
    $37M FDV —— 非 dust 非崩盘,却从未被扫也不在任何 outcomes。
  - 修:改为与 generic 链同款双发现源(boosts + movers,去重)。SHRUB 类今后实时入扫。
- 其余 robinhood ≥100% mover 均在册(799 币)。哑弹分析仍无数据(labeled.json 未产出)。

### ① 新闻(BlockBeats 稳定 + 审计了新源 OpenNews)
- BlockBeats 回放(195 条)无新噪音/漏:38 wake 全 legit(新增 HOOKR/USELESS/BUN
  等真 RB meme)。「GoPro 永续合约」以 listing 叫醒属"合约上线放行交下游"既有设计。
  「交易赚币」「借壳收割」仍在 wake 但是 R3 前种的 hotSymbol,时间戳冻结,继续过期中。
- **新源 6551/OpenNews 审计**:informational-only —— 拉 AI 打分的 news+twitter,
  去重后只发 #news-radar,**不唤醒 decider、不自动买、不进 ai-inbox、无 shell 用外部数据**。
  有 CAP_PER_TICK+600s 限流。token 从 env 取(Bearer),不落日志/git(.env、.signup/
  已 ignore)。安全面很小。

### ③ 安全(无新高危)
- OpenNews token/钱包无泄漏(见上)。smart-money 的 P2 注入面观察(R4)仍挂账。
- npm audit 同旧(Solana 依赖树 6 high 留观)。

### ④ 健康(绿)
- tsc 干净;npm test **180 passed**。monitor 重启健康(pid 38567,BN 未复现)。
- **OpenNews 402 降级已生效**:日志 `opennews: authed search unavailable
  (news_search HTTP 402) → free feed` —— OPENNEWS_TOKEN 免费额度用尽,authed 搜索
  停用但自动回退免票热榜,功能不断。想要 AI 打分全量搜索需给 6551 token 充额度(可选)。

**下轮重点:** ① 复查 8c799fe 是否让 SHRUB 类 robinhood 有机暴涨实时进扫(看
monitor-state 是否新增此类)。② 「」junk 约 09-05 02:47Z 后应清零。③ labeled.json
出现即做哑弹分析。④ smart-money 注入面校验若 owner 未处理可自补。

---

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
