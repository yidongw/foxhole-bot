# 新闻&覆盖率&安全 审计交接棒(2h 循环)

与代码正确性复查循环(review-handoff.md)分工不同:本循环专注
① 新闻漏分析 ② 暴涨漏报/报了没动静 ③ 代码漏洞/安全。每轮更新本文件,下轮先读。

## 2026-09-05 01:0x UTC 第 23 轮(ultrathink:验证 R22 措辞放开无噪音,全绿)

无新代码改动;R22 的 momentum 措辞放开经验证干净。

- ① 新闻:**R22 放开(暴涨/飙升/N倍)零噪音**——24h 回放里唯一含新措辞且 wake 的是
  「币股Meme项目MEME +800倍」(真 meme,且它靠 CAP_BREAKOUT 市值突破本来也会 wake)。
  无其它非-meme 误触发。无新漏。R20 大币护栏持续生效。
- ① junk:交易赚币(02:47:47Z 09-03)/借壳收割(02:50Z)仍在 hotSymbols,但**未到期**——
  48h TTL 到 **09-05 02:47Z**,现真实 UTC 01:07Z,还剩 ~1.7h,到期后随下一条 flash 清零。
  (提醒下轮:feed 里 create_time 是北京时 UTC+8,lastRunAt/日志是 UTC,用 `date -u` 核实,
  别再时区错觉。)news poll 健康(lastRunAt 01:07Z 实时,lastId 追平)。
- ② 覆盖率:robinhood ≥100% 干净(7 mover 全在册,**1835 币**)。
- ③ 安全:src/news 无泄漏。④ 健康:tsc 干净、npm test **309 passed**、monitor 存活
  (pid 89866)、BN 未复现、0 uncaught。

**下轮重点:** ① 02:47Z 后复查 交易赚币/借壳收割 是否从 hotSymbols 清零(R3+TTL 闭环)。
② labeled 新激进 wake 成熟后胜率(会不会被泛暴涨拉低)。③ 新大币/链名漏进补停用词。④ 守 robinhood 覆盖。

### ① 新闻(**补 hasMomentum 措辞覆盖**,commit 52ff583,已部署)
- **新角度:hasMomentum 措辞完整性**。原只认「涨超N%≥50」「市值突破」「短时暴涨」,漏了
  「暴涨200%」「涨3倍」「翻5倍」「飙升80%」这类新 meme 常见暴涨措辞 —— 非 watched 的新币
  这么写就没 wake(和用户"别漏翻倍币"直接相关)。修:% 触发词扩含 暴涨/飙升(仍 ≥50);
  「涨/翻 N倍」N≥2 也算(要求数字,避开"持有地址翻倍"这类非价格用法)。+1 回归(共 34)。
- **drop-side scan 证实当前无真漏**:全量 drop/note 里含暴涨措辞的仅 4 条,全是非 meme
  (持有地址翻倍=统计非价格、ZEC/HYPE 大币)→ 这次补的是**未来保险**,当前 feed 回放 wake 不变(61)。
- 无新噪音;R20 大币护栏持续生效(HYPE 不 wake);junk 清零中(交易赚币 ~1.7h 到 TTL、HYPE 已 GONE)。

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净(7 mover 全在册,**1780 币**)。哑弹 R21 已做(labeled 22,50% 胜率健康,不 tune)。

### ③ 安全(仅新闻侧,无新)/ ④ 健康(绿)
- src/news 无私钥/webhook 泄漏。tsc 干净、npm test **309 passed**、monitor 存活(pid 83357)、
  BN 未复现、0 uncaught、inbox 不积压。

**下轮重点:** ① 盯新 momentum 措辞上线后有没有带进噪音(暴涨/飙升/N倍 在非 meme 语境误触发)。
② labeled 新激进 wake 成熟后胜率。③ junk TTL 清零复查。④ 守 robinhood 覆盖 + 新大币/链名补停用词。

本轮无新代码改动;重点验证放开策略的**净效果**,结论:策略在赚钱、无新噪音、guards 全稳。

### ② 覆盖率 + 哑弹(**策略产出验证=抓到翻倍币并盈利** — 本轮头号)
- **暴涨→wake 策略产出真金**:decider log 显示在管一整个组合,其中 **FATCOIN +70%、SHROOM +88%
  (h24 +629%!)** 是策略捞到的新 meme 且在盈利奔跑——正是用户要的"别漏翻倍币"。MarsCoin +7.9% 持有。
  → 放开策略**净正**,不是空转。
- **哑弹刷新**:labeled 22(较 R18 只 +1,聚合慢),11W/5F/6L=50% 胜率,clean 10W/1F/4L,与 R18 持平——
  **激进策略没拉低胜率**(新激进 wake 还没成熟成 label,下轮继续盯)。volume_spike_strong 仍高方差,
  不 tune(会过拟合+丢 SOLCAT 类怪兽)。
- robinhood ≥100% 对照干净(7 mover 全在册,**1710 币**)。

### ① 新闻(无新噪音)
- 回放 61 wake:R20 大币 ATH 护栏生效(HYPE 不再 wake、不在 hotSymbols);唯一"可疑"是
  「18932」——真 robinhood meme,靠 rb-chain+momentum 正确 wake(非噪音)。junk(18932/BSC 冻结、
  GLM/BGBTC/交易赚币)随各自 TTL 清零中。无新大币/链名/数字漏进。

### ③ 安全(仅新闻侧,无新)/ ④ 健康(绿)
- src/news 无私钥/webhook 泄漏。tsc 干净、npm test **308 passed**、monitor 存活(pid 70359)、
  BN 未复现、0 uncaught。AI inbox 不积压(329B,decider 跟得上,lock 空闲)。
- **观察(归交易/复查循环,非我修)**:~16% news-decider 与 ~11% signal-decider `exited 1`(错误),
  但 inbox 每次 spawn 重读、不丢信号(成功的 decider 把活干了,还产出 FATCOIN/SHROOM 盈利),
  故弹性 OK;若 exit-1 率升高影响处理再让交易循环查 claude -p 报错根因。

**下轮重点:** ① 继续盯新激进 wake 成熟后的 labeled 胜率(会不会被泛暴涨拉低)。② 新大币/链名漏进补停用词。
③ junk TTL 清零复查。④ 守 robinhood 覆盖。

### ① 新闻(**决策质量验证 OK + 修大币空跑**,commit 7a88822,已部署)
- **暴涨→wake 后 decider 决策质量验证=好** ✅:生产日志显示 decider/信号在**智能筛选**——
  买早期 RB(FOXHOLE STRONG BUY×2)、跳过 chasing($MEME 1h+1567%、$Howeycoins 1h+423%)、
  post-hoc($CRIME 24h+509%)、低流动性($CONDOM liq<$20k)、派发(BONER falling-knife)。
  策略按预期工作:filter 捞暴涨、decider 智能决定。**一个现实局限**:新闻常在币已大涨后才到,
  很多 pump 到手已是 chasing 被正确跳过——早的(仍有空间的)才买得进,这是新闻延迟的固有限制,非 bug。
- **修:大币 ATH 空跑**。HYPE 突破新高每次经 momentum 叫醒 → decider 必跳(30亿美元大币非标的)。
  加护栏:非 meme 且标题大写 ticker 全是停用词大币(HYPE/BTC/ETH)→ note 不 wake。
  microduck(无大写 ticker)、INDEX(非停用词真 meme)不受影响。回放 wake 62→61。+1 回归(共 33)。
- **纠一个 R19 认知**:「18932」其实是真 robinhood 币股 meme(不是纯垃圾数字),但它靠 rb-chain+
  momentum 路径照常 wake,不依赖纯数字 seeding;纯数字 symbol 碰撞风险大(撞价格/计数),R19 不 seed
  它是对的。种子卫生(18932/BSC 冻结未再种,HYPE 从未种)持续生效。

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净(8 mover 全在册,**1645 币**)。

### ③ 安全(仅新闻侧,无新)/ ④ 健康(绿)
- src/news 无泄漏。tsc 干净、npm test **308 passed**、monitor 重启健康(pid 68499)、BN 未复现、0 uncaught。

**下轮重点:** ① 继续盯放开后 wake 质量 + 有无新大币/链名/数字漏进(护栏只挡"大写全大币",
中文大币名如"比特币价格突破"仍会 wake→decider 跳,量小暂不动)。② junk 随 TTL 清零复查。③ 守 robinhood 覆盖。

### ① 新闻(**验证了策略 + 修了放开后的种子污染**,commit f095b54,已部署)
- **暴涨→wake 策略(上轮 f9726a4/49f2b2d)生产验证生效** ✅:日志实证新 meme 现在真 wake 了——
  `BSC链新币股meme币Stonks(上线3h)`、`中文meme币「龙虾」突破1亿`、`FATCOIN单日涨3倍`
  都发了 NEWS SIGNAL(以前只 note)。累计 news-decider spawns 149,decider 在收。
- **但放开后 extractSymbols 种了脏 hotSymbols**:`18932`(引号内数字)、`BSC`(链名)进了热点币,
  会变 `watched:` 噪音;`HYPE`(大币)也会经 momentum 反复叫醒。修:① 引号内纯数字不入
  hotSymbols;② 停用词加 BSC/BASE/SOLANA/ARBITRUM(链名)+ HYPE(大币)。+1 回归(共 32)。
  (现存 18932/BSC 是修前种下的,随 TTL 清零;停用词已挡它们不再命中。)
- 回放:promoted 暴涨里唯一非-meme 是 HYPE(现已停用词挡住 seeding,单次 momentum-wake
  会 decider 跳过,无害)。真 meme 暴涨(Stonks/龙虾)按策略 wake→研究 thread→decider 挖 CA。

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净(8 mover 全在册,**1635 币**)。labeled 哑弹分析上轮已做(健康,不 tune)。

### ③ 安全(仅新闻侧,无新)/ ④ 健康(绿)
- src/news/ 无私钥/webhook 泄漏。npm audit 同旧。**注入面/执行层不审(归他人)。**
- tsc 干净、npm test **307 passed**、monitor 重启健康(pid 64704)、BN 未复现、0 uncaught。

**下轮重点:** ① 盯放开后新 wake 的**质量**:decider 有没有真挖到 CA 并决策(对照律动暴涨 vs
研究 thread 产出),以及有没有新的非-meme 大币/链名漏进 wake 需再加停用词。② junk(18932/BSC/
GLM/BGBTC/交易赚币)随各自 TTL 从 hotSymbols 清零复查。③ 守 robinhood 覆盖 + 碰撞审计。

### ② 覆盖率 + 哑弹(**labeled 解封,做成了真哑弹分析** — 本轮头号)
- **labeled 从卡了 10 轮的 15 涨到 21**(review 循环修了 grading:按收盘评分+账本竞态),grader
  重新产标签。→ 首次做成真哑弹分析(21 条,15 clean):**11 win / 4 flat / 6 loss = 52% 胜率,
  strong 级 9W/3L/1F ≈ 69%**,远超 30% 底线。
- **触发器分析**:momentum_strong 13 条 9W/4L(稳);volume_spike_strong 6 条 2W/3L/1F(高方差)——
  **但它同时抓到了单笔最大赢家 SOLCAT +9.88x**,且亏损样本流动性从 $56k 到 $297k 无干净阈值。
  meme 交易本就靠抓 +10x,砍掉 volume_spike 会连 SOLCAT 类怪兽一起丢。→ **数据不支持收紧,
  强行 tune=对 15 样本过拟合。结论:系统健康,不动阈值**(这正是 ② mandate"反复领先哑弹才收紧"的正确读法)。
- robinhood ≥100% 对照干净(8 mover 全在册,**1504 币**)。

### ① 新闻(**退出信号再补**,commit ad50290,已部署)
- 承 R17 清算:关注币被「大单砸盘/抛售」也是看空退出信号,此前中性 watched 叫醒。NEGATIVE 加
  `砸盘|抛售`。+1 回归(共 31)。
- 回放:59 wake 无碰撞噪音;drop 侧含 RB 语境的 6 条里 4 条是 HOOD 股票新闻(正确 drop),
  2 条 RB-meme 泛情绪(「MEME叙事暂告段落」「联创表态 MEME+30%」)—— 无具体 token、<50% 动能,
  drop 可辩护(叫它们=加噪),**非明确漏**。挂账观察。
- 「」junk/GLM/BGBTC 仍在 hotSymbols(各自 TTL 未到:交易赚币~09-05 02:47Z、GLM/BGBTC~09-06),
  已被停用词/promo-veto 中和,harmless。

### ③ 新闻侧安全 / ④ 健康
- src/news/ 无泄漏。**OKX/执行层不审(归他人;新 commit b16416f 等是他们的)。**
- tsc 干净、npm test **299 passed**、monitor 重启健康(pid 41846)、BN 未复现、0 uncaught。

**下轮重点:** ① labeled 继续增长后复看 volume_spike_strong 是否稳定领先哑弹(现 n 太小)。
② RB-meme 泛情绪 drop(MEME叙事/联创表态)若反复出现且事后证明是催化,再考虑加轻量 sentiment note。
③ junk TTL 到期后复查 hotSymbols 清零。④ 守 robinhood 覆盖 + 碰撞审计。

### ① 新闻(**补了退出信号漏**,commit 767ab75,已部署)
- **新角度:退出信号完整性**。关注币「James Wynn 的 CASHCAT 多单遭清算」以**中性 watched 叫醒**,
  但持仓币爆仓/清算是看空退出信号(filter 设计:关注币负面→退出/避险)。→ NEGATIVE 加
  `爆仓|强平|遭清算|被清算`(用"遭/被"前缀避开中性的"清算所/结算网络")。+1 回归(共 30)。
- **drop 侧 miss-hunt(严格版)**:全量 drop 里含 Robinhood/Meme 语境的 5 条**全部正确丢弃**——
  都是 Robinhood **股票/公司/CEO/KOL 叙事**(HOOD 收涨/投行评级/CEO 访谈),非 RB-chain meme。
  filter 正确区分"Robinhood 股票新闻"vs"Robinhood 链 meme"。**无漏 catalyst**。
- wake 侧无符号碰撞噪音(R15/R16 修复持续生效)。GLM/BGBTC/交易赚币 已被中和,随 TTL 清零。

### ② 覆盖率 + 哑弹(**绕过卡住的 grader 直接做了哑弹分析**)
- robinhood ≥100% 对照干净(9 mover 全在册,**1466 币**)。
- **直接哑弹分析**(不等 labeled):取 pending 里 robinhood 告警,curl DexScreener 现价算真实收益。
  但 pending 只剩 **1.7h 窗口**(review 循环刚修的账本跨进程竞态 bc0ae91 重写了 pending),样本太窄太新。
  可算的 9 个:1~1.7h 后 **2 WIN/7 FLAT/0 LOSS**,最差 HOOKR -12%(高流动性)——**健康快照,无灾难哑弹**;
  falling_knife 告警(LULU/CLAN)走平属预期(是风险信号非入场)。窗口太窄不足以 tune,别过拟合。

### ③ 新闻侧安全(无新)/ ④ 健康(绿)
- src/news/ 无泄漏。OKX/执行层不审。tsc 干净、npm test **292 passed**、monitor 重启健康
  (pid 27790)、BN 未复现、0 uncaught。

**下轮重点:** ① pending 窗口恢复(>6h 样本)后重做哑弹分析,看 trigger 组合真实胜率。
② 「」junk/GLM/BGBTC 随 TTL 从 hotSymbols 清零复查。③ 继续 drop-side miss-hunt + 碰撞审计守新闻质量。

---

## 2026-09-04 11:0x UTC 第 16 轮(ultrathink:收尾 GLM-listing 残留 + 主动碰撞审计)

### ① 新闻(**修了 R15 挂账的 listing 残留**,commit 07f5050,已部署)
- R15 留的挂账复发:智谱 GLM-5.3-Flash 快讯**标题 drop 正确,但正文含"…Alpha…上线"以 listing
  误叫醒**。核实 24h 回放:listing-wake 里 3 条真上所(标题都含"X 上线 Y")+ 1 条 AI 模型伪 listing
  (仅正文触发)。→ **LISTING 改为只匹配 rawTitle**(与 R2 watched-only-title 同款),真上所全留、
  伪 listing 修掉。回归 +1(共 29)。
- **主动碰撞审计(新角度,提前找下一个 GLM/BGBTC)**:全量 watched+hot 符号(≤6 长)逐个在
  24h feed 里查是否撞"非wake标题"——仅 AI/OKX/BGBTC 命中,**且三者都已在停用词**。→ 当前符号集
  **无潜伏碰撞**,反应式 R1/R15 修复已覆盖实际碰撞面。
- GLM/BGBTC 仍在 hotSymbols(R15 前种下,时间戳冻结),但**停用词已让它们不命中不再种**,
  ~09-06 随 TTL 清零。「交易赚币」同理(促销 veto + 停用词双保险),harmless。

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净(10 mover 全在册,**1417 币**,稳步增长)。labeled 仍 15(设计如此)。

### ③ 新闻侧安全(无新)
- src/news/ 无泄漏。**OKX/执行层不审(归他人)。** P2 注入面挂账。

### ④ 健康(绿)
- tsc 干净、npm test **287 passed**、monitor 重启健康(pid 93509)、BN 未复现、0 uncaught。

**下轮重点:** ① 「」junk + GLM/BGBTC 应在各自 TTL 后从 hotSymbols 清零,复查。② 继续每轮回放看
新 noise-wake(listing 现已 title-only,盯有无别的正文误触发类)。③ labeled 够纯 meme 样本再做哑弹。④ 守 robinhood 覆盖。

---

## 2026-09-04 09:0x UTC 第 15 轮(ultrathink 抓到并修了两类新噪音 + 新闻×覆盖交叉核对)

### ① 新闻(**修了 2 类新误叫醒**,commit f57ec26,已部署)
- 24h 回放抓到两类新 noise-wake,均为非 meme 符号漏进 hotSymbols 后 watched 误命中:
  - **GLM**(智谱 GLM-5.3-Flash 大模型)在 AI 行业新闻里误叫醒;
  - **BGBTC**(Bitget 包装 BTC)在「Bitget PoolX 锁仓 BGBTC 解锁 UNI」质押促销里误叫醒。
  - 两道修:① SYMBOL_STOPLIST += GLM/BGBTC/GPT/QWEN/KIMI/GROK/LLAMA/GEMINI(AI 模型名+
    交易所包装币,永不当 meme,也不再被 extractSymbols 种进 hotSymbols);② SAVINGS_PROMO
    扩含质押促销(PoolX/锁仓…解锁/质押挖矿),关注币在纯促销新闻里被点名(无动能/负面)
    降级 note —— **顺带止住残留的「交易赚币」误叫醒**(不用再等 TTL)。回放:噪音 55→53,+2 回归(共 28)。
  - **小挂账**:GLM 模型快讯标题 drop 正确,但其正文含"Alpha…上线"字样会以 listing 叫醒
    (title-only 判定为 drop)。无害(decider 查无地址即跳过)。若复发再考虑 LISTING 也改 title-only。
- **新闻×覆盖交叉核对(filter 里 crash/whale/momentum note 的设计用途,首次做)**:
  把 note/drop 里点名了 pump/crash 的 token 名对照 watched+alerted(206 符号)——4 个未覆盖的
  全是**正确出圈**(ZEC/HYPE 主流大币、MINIMAX 港股 AI、BTC 巨鲸叙事短语)。**无新闻暴露的覆盖漏。**

### ② 覆盖率(健康)
- robinhood ≥100% 对照干净(9 mover 全在册,**1363 币**)。
- labeled 仍 15(R14 已定性:24h 成熟窗+代币化股票正确排除)。review 循环本轮改"按收盘评分不按插针"
  (63473cd)——修了我 R6 提的 wick 数据质量问题。

### ③ 新闻侧安全(无新高危)
- src/news/ 新代码无私钥/webhook 泄漏。P2 注入面挂账。**OKX/执行层不审(归他人)。**

### ④ 健康(绿)
- tsc 干净、npm test **282 passed**、monitor 重启健康(pid 63413)、BN 未复现、0 uncaught。

**下轮重点:** ① 「」junk(借壳收割 靠 rb-chain/negative 合法叫醒非 junk 驱动;交易赚币 已被促销 veto)
应随 09-05 02:47Z TTL 从 hotSymbols 清零,复查。② 若 GLM-listing 经正文复发,评估 LISTING title-only。
③ labeled 够纯 meme 样本再做哑弹。④ 守 robinhood 覆盖。

---

## 2026-09-04 07:0x UTC 第 14 轮(专注新闻本行;OKX/执行层归他人不审)

**分工纠偏(用户指示):OKX、下单执行是别人的活,本循环别越界审,专注新闻/覆盖率/新闻侧安全。**

### ① 新闻(BlockBeats 稳定,无新噪音/漏)
- 51 wake 全 legit;**新捕获 AMC 代币化股票法律战**(AMC CEO 要 Robinhood 停止 AMC 股票代币
  交易、AMC 夜盘 +20% —— 真催化,filter 正确叫醒)+ USELESS/PONS/CASHCAT/MARSCOIN 群。
- drop 侧无 RB-meme 真漏;NOTE 桶(R13 审过)无藏漏。
- 「」junk 仍冻结(交易赚币 02:47Z/借壳收割 02:50Z,距 09-05 02:47Z TTL ~19.7h,应随之清零)。

### ② 覆盖率 + 哑弹
- robinhood ≥100% 对照干净(8 mover 全在册,**1285 币**)。
- **labeled 仍 15(自 R6 卡住)根因**:非 bug,是设计——GRADE_AFTER_MS=24h 且 pending 全<24h
  未到期;到期后 grader 的 drop 回调正确排除代币化股票(GME/AMC/STONKEX 占近期告警大头,锚定
  真股价不适合 meme tuning)。纯 meme labeled 增长慢是正常,dud 分析继续等样本。(grader 归 review 循环。)

### ③ 新闻侧安全(无新高危)
- 私钥/webhook 无泄漏(日志/git 净)。新闻→decider 注入面 P2(cap 拆除后爆炸半径放大、
  paper 钱包仍受 mode-gating 保护)仍挂账。**执行层/OKX 安全归交易循环,不再跟进。**

### ④ 健康(绿)
- tsc 干净、npm test **269 passed**、monitor 存活、BN 未复现、0 uncaught。

**下轮重点:** ① 「」junk 09-05 02:47Z 后复查消失(R3 闭环)。② labeled 纯 meme 样本够再做哑弹分析。
③ 继续 robinhood 实时对照守覆盖。**④ 不碰 OKX/执行层。**

---

## 2026-09-04 05:0x UTC 第 13 轮(ultrathink:纠正判定层认知 + 覆盖假阳性核查,无代码改动)

本轮两个深挖都收敛到"按设计工作",但纠正了我自己 6 轮的错误认知。

### ① 新闻(**纠正:判定层 judge 从来没在跑,且是设计如此**)
- **我 R6–R12 一直说"judge 在跑、0 拒绝=都合规"——错了**。实测:`ANTHROPIC_API_KEY`
  **不在 .env、也不在 monitor 进程环境里**(R7 我误判它在)。judgeFlash 首行
  `if(!ANTHROPIC_API_KEY) return undefined` → **judge 永远 fail-open,从未真正判定过**。
- **但这是设计内、不是 bug**:poll.ts 现逻辑注释明说"judge 不可用(部署机没
  ANTHROPIC_API_KEY 是常态)绝不能吞掉信号",**只有 judge 明确判否才降级**;judge 缺席时
  所有 wake 照常进 decider(真正深度判断由 decider 的 `claude -p` 子进程做,它用 CLI 自身
  鉴权,不依赖 ANTHROPIC_API_KEY)。生产实测:49 NEWS SIGNAL、0 降级、0 📰🚫 —— 全部
  正常送达 decider,没有信号被误埋。→ **净行为正确,只是"judge 层"名存实亡,decider 是真门。**
- 回放 43 wake 全 legit(USELESS/PONS/CASHCAT/MARSCOIN + 股票永续 listing 放行);无新噪音/漏。
- 「」junk 仍冻结(02:47Z/02:50Z,距 TTL ~21h)。

### ② 覆盖率(**新角度:骗子/dust 有没有漏进告警**)
- **denylist 工作正常**:7 条(Pumpcat/DEBTCOIN/UBIK/AAPL/SHRUB…,reason=user garbage/scam);
  **全 200 条 pending 里 0 条命中 denylist** → 无骗子漏进告警。近 25 告警 **0 条 liq<$20k**
  → 无微盘 dust 漏进(smart_money $15k 门也没带脏货)。
- **小挂账(归 review/scan)**:SHRUB(已 denylist 的 scam)仍在 monitor-state 被每 tick
  扫描(R5 movers feed 会发现它,denylist 在告警门正确拦下)—— 无假告警,只是白扫,
  可考虑发现层跳过/清除 denylist 币省算力。非我域不改。
- robinhood ≥100% 对照干净(6 mover 全在册,**1207 币**)。

### ③ 安全(承接 R12)
- R12 的预算拆除注入面重估仍成立:paper 姿态钱包受保护。本轮补充:decider 用 claude CLI
  鉴权(非 ANTHROPIC_API_KEY),judge 用 SDK key(缺席)——两条鉴权链独立。无新私钥/webhook 泄漏。
- P2(注入面爆炸半径随 cap 拆除放大)、TRADE_MODE 翻 live 风险仍挂账。

### ④ 健康(绿)
- tsc 干净、npm test **261 passed**、monitor 存活(pid 14036,随 glitch-guard 部署重启)、
  BN 未复现、0 uncaught、无停摆。review 循环已修 trail-stop 假止损(我 R6 复盘提的)。

**下轮重点:** ① 别再说"judge 在跑"——它名存实亡,decider 才是真门。② TRADE_MODE 翻 live 立即评估注入面。
③ 「」junk 09-05 02:47Z 后复查消失。④ grader 产新标签做哑弹分析。

---

## 2026-09-04 03:0x UTC 第 12 轮(ultrathink 深挖:预算上限拆除的安全重估 + 从未查过的角度)

用户要求 ultrathink,本轮不走例行三查,专挖盲区。无代码改动,但产出一份实质安全重估。

### ③ 安全(**头号:预算上限拆除后的注入面重估**)
- **背景变更**:commit 4e405b5「drop all budget caps on buys — AI 自主定仓(用户指示)」
  删了 $50/$25 单笔夹子,TRADE_MAX_DAILY_USD / HL_USD_PER_TRADE / HL_MAX_DAILY_NOTIONAL
  默认 0(关)。**唯一剩的预算边界=账本现金**(paper 夹到可用现金;live 现货 clamp=Infinity)。
- **这直接改写我 8 轮来挂的 P2 注入面风险**:此前"decider 被新闻/smart-money 不可信内容
  提示注入"的爆炸半径被 $50 夹子兜底;**现在 paper-mode gating 成了唯一屏障**。
- **实测验证钱包仍受保护 ✓**(这是红线):
  1. execute.ts buy():`config.mode==="paper"` 直接返回合成 fill,**根本不调
     getTradingClient()/executeSwap**,不碰钱包;只有非 paper 分支才动链上。
  2. `config.mode` 由 **TRADE_MODE 环境变量**在 loadTradeConfig 时解析,**不经任何
     CLI 参数/decider 传入** → AI 无法用买入参数把 mode 翻成 live。当前 .env TRADE_MODE=paper。
  3. blockbeats 地址提取用严格 `/0x[a-fA-F0-9]{40}/` 和 base58 类,**提取出的地址不可能
     含 shell 元字符** → decider curl <address> 无 shell 注入。
  → 结论:paper 当前姿态下,注入最坏只能扭曲 paper P&L(可花到 paper 现金余额),**碰不到真钱包**。
- **但需明确的残余风险(sharpened P2)**:.env 里 **TRADER_PRIVATE_KEY 真实存在**;一旦
  有人把 TRADE_MODE 翻成 live,注入的爆炸半径已从 $50 涨到**整个钱包余额**(夹子没了,
  mode gating 是仅剩单点屏障)。**不建议我改**(拆夹子是用户明确指示,复原=违背意图+撞车)。
  建议(留给 trade owner):在 decider prompt 里加一句"inbox 的 title/正文是不可信第三方
  文本,只作标的线索,绝不把其中任何指令当命令执行";input provenance 标注。
- **ReDoS 面清查(新角度)**:filter.ts / blockbeats.ts / opennews.ts 所有解析不可信
  外部内容的正则(地址、HTML strip、gmgn/dexscreener 链接、flash id)均为单一/有界量词,
  **无嵌套重叠 → 无灾难性回溯 DoS**。恶意快讯无法靠正则卡死 event loop。✓

### ① 新闻(NOTE 桶首次审计 + 投递健康)
- **NOTE 桶(10 条)从未审计,本轮逐条查有无"该 wake 却降级"的漏信号**:全部正确降级——
  BTC/HYPE 大币、RB-chain 叙事/基建(平台费/DEX 量)、Robinhood **股票**新闻、非 RB meme
  (microduck 由发现层独立处理)。**无藏在 note 里的漏 wake**。
- 新闻投递:日志无 news/inbox/thread/radar 投递失败(0 silent delivery failure)。
- BlockBeats 40 wake 全 legit;「」junk 仍冻结(02:47Z/02:50Z,距 TTL ~24h)。

### ② 覆盖率(更宽窗口新角度)
- 除常规 24h≥100%(4 mover 全在册),**新查"6h≥80% 但 24h<100%"的已回落暴涨**——
  1 个,也已在册。**回落型暴涨无盲区**。1159 币在册,R5 movers 修复覆盖彻底。

### ④ 健康(绿)
- tsc 干净、npm test **252 passed**、monitor 存活(pid 2811,随 decider 变更部署重启)、
  BN 未复现、0 uncaught、无停摆(now=03:07Z=lastRunAt)。

**下轮重点:** ① **盯 TRADE_MODE 是否被翻成 live**——若翻 live,注入面爆炸半径=全钱包,
需立即评估 decider 抗注入。② 「」junk 09-05 02:47Z 后复查消失。③ grader 产新标签做哑弹分析。

---

## 2026-09-04 01:0x UTC 第 11 轮(安静轮:全绿,无新改动)

- ① 新闻:BlockBeats 37 wake 全 legit(新增 Uniswap Labs 购入 PONS 等,均真信号);
  drop 侧无 RB-meme 真漏(Notional 被盗/Tesla Cybercab/Ansem Robinhood股价 均正确丢弃)。
- ② 覆盖率:robinhood ≥100% 对照干净(6 mover 全在册,**1105 币**,稳步增长)。
  哑弹仍无解(labeled 15,grader 未产新标签)。
- ③ 安全:review/smart-money 新 commit「smart_money 流动性下限降至 $15k」——属对方
  风控口径调整(更宽松→放行更低流动性币),归其域不撞车;无私钥/webhook 泄漏。
  smart-money P2 注入面、Solana audit 6 high 仍挂账。
- ④ 健康:tsc 干净、npm test **251 passed**、monitor 存活(pid 90498,随 5f88ff9 部署重启)、
  BN 未复现、0 uncaught。now=01:06Z=lastRunAt 无停摆。
- 「」junk:仍冻结(02:47Z/02:50Z),距 09-05 02:47Z TTL 约 25.7h。

**下轮重点:** ① 「」junk 09-05 02:47Z 后复查消失。② grader 产新标签后做哑弹分析。
③ smart_money liq 降到 $15k 后留意其信号是否带进更多低流动性哑弹(和 labeled 一起看)。

---

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
