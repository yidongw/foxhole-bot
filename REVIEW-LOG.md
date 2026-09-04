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
## 2026-09-02 13:16 UTC — Phase 1 — 扫描
- 警报评分: 0 (赢 0 / 假 0)
- 暴涨扫描: 8 个, 自动过滤 2 个, 待人工确认 2 个
  - 1. microduck [robinhood] +134% coverage_miss `0xD5f1afEA47b1A9eab414D2ee740cF1d6d039E725`
  - 2. UBIK [robinhood] +132% coverage_miss `0x812486EAea648819853F8E372dc9f1516C7868Bd`


## 2026-09-02 — BlockBeats（区块律动）新闻信号接入

**调研结论(读了当天 74 条真实快讯人工分拣):**
- ~70% 是噪音(宏观/美股个股/AI 行业/政治花边),对 RB meme 短线无用。
- 可交易的三类: ① RB链/币股 meme 动态(JINQIAN/FAMI 当天从速通 1800万
  → 破 7000万 → 跌超70% 全程逐条有快讯,含"KOL 承认数据编造"这种
  顶级退出信号); ② 上所催化(Binance Alpha 上线 FLORK 后短时 +85%);
  ③ 巨鲸买入/崩盘留痕。
- 对照当日 coverage_miss: ORBIO/microduck/MOO 律动**没有**报道过(太小),
  新闻救不了这类 miss,链上扫描仍是主力; 但 JINQIAN(不在 launches 里,
  纯 RB meme)律动实时报了整轮 — 新闻通道恰好补上这类盲区。
- 官方 API 已改版: 免费 API Key 制(申请即用),订阅只是提高额度。
  旧免钥接口/RSS 全部返回空。**先申请免费 Key,不用买 Pro**。

**新增 src/news/ (scrape-based,拿到 Key 后切官方接口):**
- blockbeats.ts — 快讯 ID 严格递增,列表页定位最新 ID + 详情页 SSR 抓取;
  全部归档到 data/news/YYYY-MM.jsonl(本地可搜: npm run news:search)。
- filter.ts — 三层分类 wake/note/drop; 规则含 RB链、上所、崩盘、巨鲸买入、
  短 ticker 大小写敏感词边界(MU 不撞 Multicoin)。
- 热点币记忆: wake 快讯里的 symbol 存 48h,后续暴跌类新闻直接负面叫醒
  (JINQIAN 暴涨 wake → "跌超70%+编造" 自动变 ⚠️ 退出信号,已验证)。
- judge.ts — wake 候选过 Claude(claude-opus-5, effort low)判定,
  否决的降级进 filter-log; 无 ANTHROPIC_API_KEY 时 fail-open 直接推。
- monitor 内新增 newsLoop(默认开,NEWS_POLL_MS=3min,BLOCKBEATS_NEWS=0 关)。
- 测试: test/news.test.ts 用当天真实标题做回归,87/87 全绿。

## 2026-09-03 — 修正昨日结论 + 官方 API Key 到手

**昨日"新闻救不了 coverage miss"的结论是错的**(采样只看了最近 ~80 条 ID):
- microduck: 律动 10+ 条报道,最早 09-02 08:23(bot 18:12 才发现 miss,晚 10 小时)
- MOO: 09-01 就有「单日涨超330%」报道,早了一整天
- ORBIO: 确实没报道(唯一真·盲区)
教训已固化成代码: ① 复盘时每个 miss 自动搜律动(daily.ts newsNote);
② 标题不带链名的「X市值突破…」快讯从 drop 改为 note; ③ 标题+正文一起
匹配(正文里的「Robinhood 生态 Meme 币」能救标题); ④ 小写/引号 token
也进热点币记忆; ⑤ 歧义符号(AI/MU)要求 meme 语境才算命中,GMGN 进停用词。

**账号+Key**: 用 agent@foxhole.bot 邮箱验证码注册了律动账号,免费 Key
(bbp_34d980…,额度 10000 次)在 apiDoc 页可查。官方接口已接入并实测:
- GET api-pro.theblockbeats.info/v1/newsflash (header api-key; page/size/type/lang)
- GET /v1/search?name=<kw> (type: 0文章 1快讯)
无 Key 或接口失败时自动退回页面抓取。站内搜索网页版其实免登录可用
(昨日误判),但接口带签名,程序化走官方 API。
## 2026-09-02 — JINQIAN 漏报反思(用户指出)

**事实**: JINQIAN (0xe81880c1…) 13:32 UTC 发射 JINQIAN/FAMI 主池, +700%,
量 $92M, FDV 峰值 ~$70M — 当日 RB 链最大暴涨。监控 13:12 起在跑, 但该币
从未进入扫描 (monitor-state 无记录), 纯 coverage miss。

**根因链(五连环)**:
1. launches 发现依赖硬编码股票词表搜索, FAMI 不在 SEARCH_QUERIES;
2. 不走 Long factory (纯 RB meme), factory watcher 天然看不见;
3. **RB 链实时扫描没接 trending/movers 动态发现源** — P0 给其余四链都
   接了, robinhoodAdapter.trendingCandidates 已实现却从未被调用(主根因);
4. BlockBeats 全程报道, 但新闻 watcher 16:53 才上线, 晚于发射 3.5h;
5. 9 小时前的调研已明确诊断"JINQIAN 类纯 RB meme 是盲区", 只补了新闻
   一条腿, 没补链上扫描 — **诊断了 ≠ 修了**。

**修复(即时部署)**:
- scanLaunches: robinhood 也跑 scanChainTrending (boosts + top movers);
- RB trending 币不再强制 isStockPaired=false — JINQIAN/FAMI 类配股 meme
  的锁仓/新盘信号照常工作;
- JINQIAN 入 missed 案例库 (第4条) 供调参学习。

**教训**: 每条"盲区诊断"必须当场转化为修复项或显式挂账, 不能只留在文档里。

**追加(同日深挖)**: 首次修复验证时 JINQIAN 仍未出现在发现列表, 继续深挖出三层:
1. DexPaprika 分页参数 (page/offset) 全部无效 — 一直只有 100 池, "3页"是假设未验证;
2. DexPaprika 的 chg24h 是回看视角 (JINQIAN 回落中显示 -37%), liquidity 严重失真
   ($10.7K vs 实际 $5.7M) → movers 精筛改用 DexScreener 实时数据;
3. **治本: RB v4 通用新池 watcher** — 从 JINQIAN 池的 Initialize 日志反查出
   RB PoolManager `0x8366a39c…40951`, 监控全部 v4 Initialize 事件
   (过滤 Long 1e18 系), probation 批量验证 (DexScreener 30地址/批,
   liq≥$30K 转正), verified 每 tick 深度分析 12h。
   历史回放验证: 发射时段窗口 102 个候选, JINQIAN ✅ 被捕获。
## 2026-09-03 — 自主复查:事后警报降级 + 律动 Key 落地
- **post_pump 降级**(前日挂账兑现): 24h 涨幅 ≥500% 的 strong 信号一律降为
  alert(仍计入调参捕获),并带 post_pump 触发器被交易引擎硬性拒绝入场。
  依据: DIDDY(+3136%)/NUDES(+281638%)是事后回声; "I" 在 +932% 时被
  引擎买入亏 $14.33。LIGMA(+32% 触发)类真早期信号不受影响。测试 95/95。
- **BLOCKBEATS_API_KEY 终于进了部署 .env**(此前只在已删除的 worktree 里,
  新闻轮询一直默默走页面抓取回退;f29de49 的"Key 死亡告警"守着一个从未安装
  的 Key)。已从 MCP 配置找回并实测官方接口 200。
## 2026-09-03 — PONS 主池选择 bug(自主复查发现)
律动报 PONS 市值破 5 亿创新高,查我方状态:已发现但分析数据全错
(vol $31K vs 实际 ~$95M)。根因: selectPrimaryPair 无条件偏好"股票配对"
(quote 不在 ETH/WETH/USDG/USDC/USDT 即算),PONS/AI 这类 $189K 的小 meme
互配池劫持了主池判定,$5.1M 的 WETH 主池被无视 → 永远 0 分。
修复: 股票配对需流动性 ≥ 最深池的 25% 才可当主池(BONER/HIMS 场景保留,
PONS 类成熟币回归真实主池)。实测 PONS 现读 PONS/WETH vol $6.8M。96/96。
## 2026-09-03 — 下跌放量降级(决策进程首次实战反哺)
00:50 首个信号触发的无头决策进程正确否决了 BONER 再入场(score 160,但
24h -24%、1h 量仅均时 13%、卖方主导 — volume_accel 3.8× 是陈旧基数假信号),
并指出引擎层缺陷: spike/accel 触发器分不清突破放量和派发放量。
已按其建议固化: 24h ≤ -10% 时 strong 一律降 alert + falling_knife 触发器,
checkEntry 硬性拒绝(与 post_pump 同族)。测试 99/99。
## 2026-09-03 — 崩盘态进安全门(NUDES 教训)
NUDES 派发期反复触发 trade 级信号,决策进程每次都要人肉否决。
把 mover 扫描已有的"现价 < 窗口最高 40% = 已崩盘"规则搬进实时安全门
checkChart(collapsed_pump veto):信号在投递与入场之前就被拦截。102/102。
## 2026-09-03 — 24h 资金占用上限取代毛入场上限
决策进程 01:58 想小仓买 BONER($40,判断合理)被"日上限"拦住 —— 但昨日
4 笔已全部平仓回款,真实敞口 ~$0,是毛周转 $200 触顶,不是风险触顶。
改为按"仍在风险中的资金"计算: 每笔入场净掉已实现回款(全 rug 时回款为 0,
最坏情况仍被 $200 硬顶住,保护不变)。学习循环不再被回收资金饿死。104/104。
## 2026-09-03 — 微盘 dust 降级(用户指出 token "I")
用户问"I"(0xe9ae…1E18)为什么会来信号。查明: 单字母 meme, FDV $28.8万,
主池 $13.7万碎在 14 池,已 +450%,却因 momentum+volume+stock-pair(NU 被当股票)
触发全套 trade 级信号并被引擎 02:49 自动买入。根因: 信号引擎对市值无下限,
$28.8万 dust 与 $7000万 JINQIAN 同套阈值。修复: FDV < $1M 的 strong 降为
alert + micro_cap 触发器, checkEntry 拒绝入场(FDV 缺失则 fail-open)。
实测 I→alert/micro_cap, PONS($340M)不受影响。112/112。
## 2026-09-03 — 引擎机械入场 vs AI 决策的冲突(用户指出)
用户看 "I" thread 问为什么 AI 分析没起作用。真相: thread 里 02:48 决策进程
明确"跳过"(事后警报+微盘),02:49 引擎却自动买入 $50 —— 两条路径互不通气,
AI 的判断对执行毫无约束力。根因: processSignals 机械自动入场,与 AI 决策进程
并行运行且优先。修复: 新增 TRADE_AUTO_ENTRY(默认关),AI 决策进程成为唯一买家,
其 buy/skip 判断即最终执行; 引擎仍机械管理出场(快速止损保留)。113/113。

## 2026-09-03 — BSC four.meme 补齐: 从 digest 升级为 probation→verify→analyze→分级警报
BSC 之前只有 generic 发现 + four.meme launch 的 digest 流水,新铸代币发完就
不管了。对齐 RB v4-watcher 模式: 新增 data/fourmeme-watch.json 观察名单,每次
tick 把新 TokenCreate 挂到 probation; 用 DexScreener 批量查询(chainId=bsc,
流动性≥$15K)筛选毕业到真实 PancakeSwap 池的代币 → verified 后每 tick 走
adapter.analyze + evaluateSignal + maybeAlert,得到与 RB 同级的分级警报(含
量能加速)。12h 窗口、40 verified 上限、按新鲜度截断。新增 addFourmemeProbation
的去重测试。134/134,typecheck 绿。下次: four.meme 债券曲线毕业进度接入
analysis(类比 pump.fun curveProgress),或 BSC live 交易路径实测/GoPlus 安全门。

## 2026-09-03 (续) — BSC 分析能力补齐: 多链 analyze CLI + four.meme 毕业标记
用户要求"这次全做完"。盘点确认: BSC 安全门早已就位(GoPlus chain 56,honeypot/
税/mintable 等全套 veto + chart ladder/collapse + 缓存),live 交易 PancakeSwap v2
路径完整(仅未用真金实测)。剩余真缺口是"手动分析": `npm run analyze` 只认
Robinhood。改造 cli/analyze.ts 支持 `--chain <id>` 路由到 getAdapter(chain).analyze
(默认 robinhood 向后兼容),BSC/solana/base/ethereum 均可手动分析;实测
`analyze --chain bsc <CAKE>` 返回真实 DexScreener 数据,RB 专属字段优雅降级为"—"。
另: scanFourmemeWatch 里 verified 代币标记 curveGraduated=true + "four.meme:
graduated to PancakeSwap" 信号(事实——有真实 PancakeSwap 池即已脱离债券曲线)。
README 加多链 analyze 示例。134/134,typecheck 绿。未做(需真实资金/未验证常量):
live 交易实测、four.meme 债券曲线进度链上读取(合约 view 函数未核实,不臆造)。

## 2026-09-03 (续2) — v2 成交记账修正 + BSC 端到端实跑验证
发现真实 bug: v2Buy/v2Sell 用 getAmountsOut(pre-trade 模拟报价)当实际成交量,
但故意调的是 SupportingFeeOnTransferTokens 变体——收税代币实收 < 报价,导致仓位
被高估、P&L 和卖出数量全错。修正: 买入读 balanceOf 前后差值取真实到账;卖出读
native 余额差 + 回执 gasUsed*effectiveGasPrice 还原真实收入。对齐 RB execute.ts
用 SDK 实际成交额的做法。bsc/base/ethereum 三条 v2 路径同时受益。
端到端实跑 `CHAINS=bsc monitor:once --dry-run`: four.meme watcher 抓到 59 个新盘
全部入 probation;BSC 发现→分析→分级警报(STRONG/ALERT)全部正常触发,含事后
信号降级、量能倍数、FDV 微盘下限——BSC 已达 RB 同级发现/分析/警报能力。134/134。
## 2026-09-03 09:18 UTC — Phase 1 — 扫描
- 警报评分: 0 (赢 0 / 假 0)
- 暴涨扫描: 9 个, 自动过滤 0 个, 待人工确认 0 个


## 2026-09-03 (循环) — four.meme 债券曲线进度接入 = BSC 首个 pre-pump 信号源
诊断确认: BSC 一直出不了 #trade-signal 是因为 isTradeGrade 要求 strong + 入场
触发器(lock_*/boner/curve_near_grad_strong/ai_decision),而 BSC 只能产 momentum/
volume(事后回声,故意排除)。缺的是 pre-pump 信号源。修法: 接入 four.meme 曲线。
先从 BscScan/文档拿到 TokenManagerHelper3(0xF251F83e...E46034)的 getTokenInfo,
再链上实测核实(不臆造): on-curve 返回 version=2/liquidityAdded=false/funds→maxFunds,
非 four.meme 返回 version=0/maxFunds=0(不 revert)。新增 getFourmemeCurveState +
纯函数 fourmemeCurveProgress(funds/maxFunds)。bscAdapter.analyze 接入(对称 Solana
pumpfun): 设 curveProgress/curveGraduated,并用 funds(BNB 深度)覆盖 DexScreener
对 curve token 报 null 的 liquidity,让临近毕业的 token 过流动性门。曲线≥92%+有量
即触发 curve_near_grad_strong → BSC 终于能出 pre-pump 交易信号。实测 analyze 一个
on-curve token 显示"four.meme curve X% to graduation",CAKE 不误报。143/143。
下次: BSC-specific 曲线量能阈值(curve trigger 的 vol 门 $50K 对 curve token 偏高),
或 live 交易实测。

## 2026-09-03 (循环) — 解锁 curve_near_grad_strong: 分析临近毕业的 on-curve four.meme
上次接了曲线进度但触发不了——scanFourmemeWatch 只分析 verified(=已毕业)token,
而 curve_near_grad_strong 要求 !curveGraduated,所以那个 pre-pump 触发器从没真正
触发过(和 SOL 循环 51c58db 发现的同一根因)。镜像 SOL 的解法到 four.meme:
screenFourmemeProbation 现在同时记录每个 probation token 的 pre-grad 24h 量
(lastVol24hUsd);新增 nearGradFourmemeCandidates 按量取 top-N(≥
FOURMEME_NEAR_GRAD_MIN_VOLUME_USD 默认$20K,capped FOURMEME_NEAR_GRAD_MAX_CANDIDATES
默认6)。scanFourmemeWatch 现在分析 verified + 这批 on-curve 临近毕业候选(按地址去重),
它们带 curveProgress+curveGraduated=false → 曲线≥92%+量≥$50K 即触发 curve_near_grad
_strong,BSC 终于有可发的 pre-pump 交易触发器。RPC 成本限定在真正在冲刺毕业的少数几个。
实测 dry-run 无错。155/155。下次: live 交易实测,或 BSC safety 门在 curve token 上的表现。

## 2026-09-03 (循环) — 修复安全门误杀 on-curve 曲线代币 (no_chart_history)
上轮解锁的 curve_near_grad_strong 实际被安全门静默拦掉: 实测一个 75% 进度、有量、
GoPlus 判定干净的 on-curve four.meme,被 no_chart_history 否决——债券曲线池在
dexpaprika/geckoterminal 无 AMM K线,安全门把"无K线"当"池子抽干"veto。同 bug 影响
SOL pump.fun on-curve。修法(链无关): checkTokenSafety 加 opts.onBondingCurve,曲线
代币毕业前跳过"无K线否决"(GoPlus 貔貅/税/增发照常跑),curve 标记进缓存 key 防止
毕业后仍用曲线期判定。maybeAlert 按 curveProgress!=null && !curveGraduated 传入。
实测: onBondingCurve=false→veto(不变), true→ok=true。174/174。下次: live 交易实测。

## 2026-09-03 (循环) — 关键 bug: BSC 用了错的 WBNB 地址,live 交易从来跑不通
用户要求"能做的这轮做完,别推给下轮"。于是这轮实做 live 路径验证(不花钱): 用
eth_call + stateOverride 给合成账户虚拟充 BNB,把 PancakeSwap v2 买入交易模拟执行
在真实链上状态。控制组 WBNB->USDT 竟然 revert → 深挖发现 router.WETH() 返回的
WBNB 与代码里的不一致。经 BscScan/CoinGecko/BNB Chain 权威确认: 正确 WBNB 是
0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,而代码里(v2-swap.ts + registry.ts)写的是
0xbb4CdB9CBd36B01bD1cBaEF60aF814a3f6F0Ee75(错的,该地址无合约)。后果: 每笔 BSC
v2 买/卖的 path=[错WBNB,token] 必 revert → BSC live 交易从 P1 起就完全跑不通(且从未
实测过)。修复两处地址 + 加 V2_ROUTERS wrapped-native 守卫测试。修复后实测: 控制组
1 BNB->700 USDT ✅;对真实 $5.1M 池代币模拟买入 quote+swap 均不 revert,0 花费。
175/175。下次: 只剩真金广播实测(需 funded 钱包 + TRADE_CHAINS=bsc);可加 preflight
模拟门作为广播前保护(honeypot/无路由/池干直接拦)。

## 2026-09-03 (循环) — v2 广播前 preflight 模拟门 + preflight CLI
把上轮验证 WBNB 用的 stateOverride 只读模拟手法固化成生产代码。新增 preflightV2Buy
(v2-swap.ts): 无需私钥/不广播/0 花费——getAmountsOut 报价 + simulateContract 用
stateOverride 给合成账户虚拟充 native 币,在真实链上状态模拟买入,返回 {ok,reason,
quotedOut,amountTokens,priceUsd}。捕获: 无路由/池干/滑点过大/貔貅买入 revert。
v2Buy 广播前先跑 preflight,!ok 直接抛错——doomed 交易不再白烧 gas。另加
`npm run preflight <chain> <token> [usd] [bps]` CLI 供人工核。实测: CAKE/真实 v2 代币
✅ OK(WBNB 修复后 CAKE 也有 v2 路由了), dead 地址 ⛔ BLOCKED(no v2 route)。
178/178。下次: v2Sell 的 preflight(需持仓模拟,可用 stateOverride 伪造余额+allowance);
或 four.meme 非 WBNB 计价代币多跳路由。

## 2026-09-03 (循环) — v2 多跳路由: 补齐非 WBNB 计价(USDT/BTCB)代币的可交易性
发现真实覆盖缺口: v2Buy/Sell 硬编码 path=[WBNB,token],而 four.meme 的 BEP20-计价
代币(债券曲线 quote != BNB)毕业后对 USDT/BTCB 成对、无 WBNB 直连池 → 直接路径
getAmountsOut revert → preflight 直接拦死 → 根本没法买卖。实测确认: GOLD/USDT($361K)
direct=REVERT 但 [WBNB,USDT,GOLD]=OK。新增 bestRoute(chainId,from,to,amountIn): 试
direct + 经各配置 base(BSC=USDT/BTCB, Base=USDC, ETH=USDT/USDC,均链上 symbol() 核实)
单跳,取报价最高路径。preflightV2Buy 返回选中 path;v2Buy/v2Sell 都改用 bestRoute。
实测: GOLD 现在 preflight ✅ OK,买 WBNB→USDT→GOLD、卖 GOLD→USDT→WBNB 均报价+模拟通过;
WBNB 直连代币仍走 direct(不回归)。加 bases 守卫测试。179/179。下次: v2Sell 广播前
preflight(stateOverride 伪造余额+allowance 做完整往返貔貅检测);或 BSC 曲线量能阈值。

## 2026-09-03 (循环) — v2Sell 往返貔貅检测 preflight (能买不能卖直接拦)
补上买入 preflight 抓不到、GoPlus fail-open 时无防护的盲区: 貔貅(能买不能卖)。
新增 preflightV2Sell: 用 stateOverride 的 stateDiff 伪造合成账户的 token 余额+对
router 的 allowance(余额/allowance 存储槽用探测法自动定位 keccak256(abi.encode(holder,
i)),i=0..24,不臆造),再模拟 swapExactTokensForETH 卖出——真实链上状态、0 花费。
存储非标准(Vyper/proxy/packed)探不到时跳过(simulated=false, ok=true, 不误杀,GoPlus 仍兜)。
v2Buy 广播前跑它(TRADE_SELL_PREFLIGHT!=0),卖出会 revert 直接 abort 买入。preflight
CLI 升级为完整往返(BUY/SELL 双行)。实测: GOLD/USDT 买(经USDT跳)+卖均 ✅; CAKE 直连
买卖均 ✅。180/180。下次: BSC 曲线量能阈值,或槽探测结果按 token 缓存降延迟。

## 2026-09-03 (循环) — 貔貅 preflight 存储槽索引缓存(降 live 买入延迟)
上轮的 v2Sell 往返貔貅检测每次买入要探测最多 50 次 eth_call 定位余额/allowance
存储槽(公共 RPC 上 5-15s,live 抢跑致命)。改为缓存 mapping 声明索引(token 属性,
与 holder 无关): resolveSlotIndices 按 chain:token 缓存 {balance,allowance} 索引,
null 也缓存(非标准存储不再每次重探)。索引→槽 hash 每地址现算,holder 无关可复用。
新增 clearSlotIndexCache()。probe 用 Promise.all 并发。实测: GOLD 冷 1286ms→暖 653ms
(2x,暖调跳过探测),verdict 不变(ok=true simulated=true)。180/180,typecheck 绿。
另: 本轮曾尝试补 BSC pump 回测夹具(RB/SOL 有 pump 夹具,BSC 只有 control),但
DexScreener search 候选太少 + 成熟 meme 已过 pump 期,未找到 ≥3x 且能 replay 判为
pump 的干净样本——不硬凑低质夹具。下次: 用更好数据源(GeckoTerminal/四meme 近期毕业
且暴涨的池)找 BSC pump 夹具;或槽缓存加 TTL。

## 2026-09-03 (循环) — 补齐 BSC pump 回测夹具 (AKE, engine-classified)
上轮识别的缺口: BSC 只有 control(CAT)无 pump 夹具,backtest-gated 自调无法验证阈值
改动是否仍抓得住 BSC pump。改用更广数据源(GeckoTerminal top pools 分页,80 池 vs
DexScreener search 的 8)扫出真实 pump: AKE(0x2c3a8ee9...,WBNB 对)~87x 大涨(min
1.88e-4→max 1.65e-2,$69M 峰量,现仍 78% 非 rug)。链上核实 symbol=AKE;用真 runner
replayTokenHistory(实拉 DexPaprika OHLCV)判定 passed=pump,firstAlert 06-14 早于
07-18 峰值,20 次警报——非手标。加入 MULTICHAIN_FIXTURES,BSC 现有 pump+control
双夹具。180/180,typecheck 绿。下次: 槽缓存 TTL(防 proxy 升级),或 four.meme quote
字段直读做精准多跳(非 WBNB 计价代币用曲线 quote 而非猜 base)。

## 2026-09-04 — NUDES/FATCOIN 复盘: 移动止盈武装门槛 + decider 判断校准(用户两次纠正)
用户骂: NUDES 涨一点就被清仓、FATCOIN 为什么不买——两个后来都飞了。
**首轮误诊(记录在案)**: 我先把 NUDES 归因为止盈阶梯(2x卖50%太早)、把 FATCOIN
说成 post_pump 合理避开+用户幸存者偏差。用户甩出真数据打脸: NUDES 根本没到过
2x,"只涨1%就清仓"; FATCOIN 决策时 24h 仅 +54%,是 decider 裁量跳过,用户自己
判断买入并赚了。两处归因全错,以下为核实后的真相与修复:
- **NUDES 真凶 = 移动止盈武装过早**(positions.json 实录): #1 仓 $0.01346 进,
  高点仅 +21%($0.01627),25% 回落触发全清于 $0.01147(-14.8% 亏损离场);
  #2 仓 manual exit 半仓(-7%)+trail 半仓(+14%)。两仓 $60 净 -$4.29,随后起飞。
  根因 exits.ts `highWater > entry` 即武装——没有利润垫时把日常律动变成必然
  甩下车。修复: 新增 trailArmMultiple(默认 1.5,TRADE_TRAIL_ARM_MULT),
  高水位 ≥ entry×1.5 才武装 trail,之前只有 -35% 硬止损兜底。回归测试:
  +21% 高点回踩 25% 不再触发。
- **止盈阶梯同步改肥尾态**(用户选温和折中): x2→33% / x4→22%,剩 45% moonbag
  骑 trail(旧 2x→50%/4x→25% 把 20x 压成 ≈5.75x)。
- **FATCOIN = decider 判断错误,非门控拦截**: 0x12D5…8a01 [robinhood],决策时
  FDV $2.56M、24h +54%,全部硬门通过。decider 以"从ATH回落33%=事后警报"
  "6h+961%=接盘位""买卖单1339:1357=转向"跳过——回落是回调不是派发,1:1 盘口
  是噪音。已在 decider PROMPT 加校准: 24h 未超 500% 不套事后警报逻辑;新币
  回落 30-40% 且量能仍在不构成跳过理由;转向要看持续卖压/量价背离。
- 教训(对我自己): 复盘先拉决策时点数据再归因,不许拿当前快照倒推;别再把
  自主加的保守门说成"用户骂出来的"。186/186,typecheck 绿。
- **反思交给复盘循环(用户指示)**: 新增 src/review/exits-review.ts,Phase 1
  每轮自动做"自我出场复盘": 🏃卖飞(72h 内平仓、现价 ≥ 出场均价 2x,点名出场
  机制+实现盈亏)和 🚫报了没买(报过警报、+100%、从未开仓——此前 alerted 被
  过滤出候选,decider 跳过后起飞完全不可见)。state 文件去重,每单只报一次。
  189/189,typecheck 绿。改动自主提交合并(用户授权,无需确认)。
- **追加(用户指出 thread 认错)**: 1544893137246490664 是 AI组合巡检 thread,
  我误说成复盘 thread。补真正的缺口: 巡检管仓位但看不到自我教训——现在
  exits-review 把发现持久化进 state(lessons 滚动 30 条),`ai-trade status`
  尾部自动带"🪞 近期教训(7d)",巡检第一步跑 status 即自动看到,无需改任何
  定时任务 prompt。189/189 绿。

## 2026-09-04 — trade-log 加 FDV + 现货/永续消息格式拉齐(用户要求)
现货 trade-log 还是英文老格式(AI ENTRY/EXIT/Open positions),永续是中文新格式,
且两边都不带市值——看警报没法直观判断盘子大小。统一:
- 新增 src/lib/format.ts fdvTag(): " · FDV $7.8M" 紧凑标签,两引擎共用。
- 现货: 开仓(AI/机械)、平仓、Daily P&L 全部中文化对齐永续措辞(买入/平/剩/开/现/
  盈亏/已平/现货账户),并带当前 FDV(开仓用 analysis/signal 自带,出场复用
  managePositions 已拉的 primary pair,报表与价格同一次 fetchTokenPairs)。
- 永续: 开仓/手动平仓/自动止盈止损/Daily P&L 持仓行带 FDV。新 fetchPerpFdvUsd:
  kilo 前缀剥掉(kPEPE→PEPE)后全链搜 DexScreener 取最深池 fdv;HIP-3 股票
  (XYZ-CL)无现货搜不到 → 省略;纯展示,失败吞掉不影响下单风控。
- 实测: PONS $486M / kPEPE→PEPE $1.5B / XYZ-CL 省略。251/251,typecheck 绿。

## 2026-09-04 — 取消持仓数量上限(用户指示"不要有任何仓位数")
NUDES/BONER/PONS 占满 3 槽后新信号全被 `max open positions (3)` 挡掉。
现货 TRADE_MAX_OPEN_POSITIONS 与永续 HL_MAX_OPEN_PERPS 均改为 <=0=不限,
默认 0。风险边界不变:现货仍有 24h $200 资金占用上限+账户现金,永续仍有
24h $600 名义敞口上限,单笔 $50/$25 clamp、止损、安全门全保留——限的是钱,
不再限槽位。251/251,typecheck 绿。

## 2026-09-04 — 拆除全部预算类买入限制,AI 自主定仓(用户指示)
继槽位上限后,资金类限制也全拆:现货单笔 $50/momentum $25 夹子删除,
TRADE_MAX_DAILY_USD 默认 0;永续 HL_USD_PER_TRADE、HL_MAX_DAILY_NOTIONAL_USD
默认 0(<=0=不限)。decider prompt 同步:金额/数量由 AI 按信心与流动性判断,
"最多买1-2个"改为自主决定。唯一保留的边界是**账本现金**(paper 不许透支:
现货买入夹到可用现金,永续保证金>现金拒绝)——记账完整性,非策略限制。
止损/移动止盈/安全门/杠杆硬顶/momentum 流动性门原样(是质量与出场,不是预算)。
usdPerTrade 保留为机械 autoEntry 的固定仓位。252/252,typecheck 绿。
