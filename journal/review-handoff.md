# 复查交接棒(自进化复查循环的状态文件)

每轮自主复查结束时更新本文件;下一轮开头先读它。保留三块:上轮动作 / 挂账 / 下轮重点。

## 2026-09-05 06:27 UTC 交接(来自 diagnose-failed-rhivian 诊断会话 → 执行/复查循环)

**我(诊断会话)捅的娄子 + 已回滚(说明因果,便于你复核):**
- 我给生产 `.env` 加了 `LIFI_API_KEY=5718c395-…-d5d04301bd08` 并重启过 bot。这把 key 对 li.quest `/v1/quote` 恒返回 **401 code 1010**(portal.li.fi 里它确是真 key,但集成状态 "Needs setup" 未激活 → 网关不认;换 integrator=foxhole/foxhole-bot/无、换链 RB/ETH、隔时重试,全 401)。
- 后果:bot 每次 LI.FI 报价都 401 → 代码判 `RouteError` → 一律回退 hoodchain(v3)。这就是 **ROBINCAT/GRASS 等出场 STF** 的直接成因(卖单被逼到 hood,而 meme 币对 hood 路由 `0xcaf681a66d…` allowance 常年为 0 → transferFrom 失败 → STF)。
- 已由另一会话把该 key 注释禁用(`.env` L102)并重启 bot(现 pid 22337,已确认进程 env 无 key = keyless)。keyless LI.FI 正常。CUCK/SHROOM/WALLET 旧仓均已出场(manual / trail-stop / dust-write-off),STF 已止。

**交回给执行循环的两个 execution-layer bug(我不越界改 execute.ts,交给你):**
1. **STF on hood 回退 = 缺授权**:LI.FI 主路由失败回退 `sellViaHood` 时,meme 币对 hood 路由 allowance=0。`executeSwap` 内虽有 `ensureApproval`,但实测 CUCK/SHROOM/WALLET 对 hood(`0xcaf681a66d…`)allowance 仍为 0 且出场 STF。**建议:live 买入成交后(或首次纳管 live 仓)即对两个 spender 预授权 MAX —— LI.FI approvalAddress `0xB477751B76CF82d00a686A1232f5fCD772414Af3` + hood router `0xcaf681a66d…`,别等卖时懒授权。** `liveSellAmount` 的余额 clamp 已在,保留。
2. **decider 路由探测量不缩放**:UFG(`0xEfAb538Cf3C29237A47c6aFB145D50Ddf204A0A3`)决策日志显示 $200 与 $30 探测 `amountIn` 恒为 `16883069`(≈$16.88 USDG,6dp),两档完全相同 → 探测量卡死、没随下单额缩放。这让"结构性无路由"判断不可靠。**建议核对 decider 里 LI.FI 探测 amountIn 的计算。**

**已验证客观事实(2026-09-05 ~06:20Z,keyless 直连 li.quest):**
- UFG **卖得出**(UFG→USDG via nordstern,5000 UFG→$16.3)但 **买不进**(USDG→UFG $200/$30 三试全 "No available quotes")→ UFG 是**买卖不对称路由**,decider 判"UFG 不能进场"在**买方向是对的**(不是 key 假阴性)。
- 但 ROBINCAT 那类**出场 STF 确实是 key 假阴性**(卖方向本有 LI.FI 路由,却被 401 逼去 hood)。两类要分开,别一锅端。

**未决 / 用户侧:** LI.FI key 需在 portal 走完 "Needs setup" 或重生成才能激活;用户暂决定不管(keyless 够用)。紧急预授权 + 手动出场测试:诊断会话**未执行**(因与你并发驱动同一热钱包有 nonce 竞争风险),且现已无必要(旧仓均已正常出场)。

**追加 06:5x UTC(用户明确授权诊断会话接手改 execute.ts):**
- 上面 bug#2 的后续:实测 UFG(`0xEfAb…A0A3`)**买不进不是探测量 bug、也不是蜜罐** —— 是 **LI.FI 对它的 v4/native 池只报卖、不报买**(SHROOM/WALLET/CUCK 等其它 v4 币买卖都能路由,唯独 UFG 买方向 LI.FI 404)。**OKX 聚合器能报价 + 能执行**该买入(eth_call 干验通过;round-trip 打平,非税/蜜罐)。
- **诊断会话已实现并部署**:新增路由模式 `lifi_okx_hood`(三级兜底 LI.FI→OKX→hood),`config.ts`/`execute.ts` 改动;`.env` 切 `TRADE_ROUTER=lifi_okx_hood`。OKX 兜底腿用 `TRADE_AGG_FALLBACK_SLIPPAGE_BPS`(默认 800=8%,因暴涨 v4 用 1% 主滑点会 "Min return not reached")。tsc 通过、trade/live-sell-clamp 测试 30/30 通过、UFG 买单 eth_call 干验通过。
- **bug#1(hood 回退缺授权 → STF)仍归你** —— 我没动那块;不过 OKX 兜底腿会自处理授权(okxSwap 内含 getApproveTransaction),这条链现在 LI.FI→OKX 两级都在 hood 之前,STF 触发面已收窄。

## 2026-09-03 03:05 UTC 交接

**近期已修(全部已部署验证):**
- 无头决策进程 decider(03a9d9a):信号落地秒级 AI 决策,判断质量高
- post_pump / falling_knife / collapsed_pump / micro_cap 四道事后&劣质信号防线
- PONS 主池劫持 bug(6016e10)
- 24h 上限改按在险资金计算(becb219)+ 用户取消当日上限(TRADE_MAX_DAILY_USD=0)
- paper 账户余额追踪($1000 起,formatPortfolioReport 显示)
- **AI 决策进程成为唯一买家**(d4ca87d,TRADE_AUTO_ENTRY 默认关)—— 引擎机械入场
  曾在 AI 说"跳过"后 1 分钟照买
- **note-news 命令**(本轮):news 决策留痕到 #news-radar

**本轮验证结论:**
- 挂账1 collapsed_pump 误杀:✅ 清白 —— 监控日志零 collapsed veto,只有正确的
  falling_knife(BONER)/ micro_cap(I)。关闭此挂账。
- decider 判断质量:✅ 高 —— 抽查 6 次运行,理由充分、诚实标注不确定性、
  news 无关正面消息正确不动作。

**挂账(未修,按优先级):**
1. 24h 自复盘:lastReviewAt=09-02T13:15,预计 09-03 ~13:15 到期。下轮若已过点,
   确认它跑了、确认清单发到 filter-log、提醒用户 /review-confirm。(现在 03:05 未到)
2. 当前 "I" 仓位($50,机械路径遗留,autoEntry 已关)—— 已问用户是否手动平,待答复。
3. 正面新闻仍会拉起 decider(浪费运行)—— 成本非正确性,低优先级。可考虑 poll.ts
   只对 negative 或带持仓 symbol 的 news spawn。
4. collapseRatio 测试挪 safety.test.ts(纯整洁)。
5. 用户侧:钱包充值、切 live 口令。

**下轮重点:** 挂账1(日复盘 13:15 是否触发,若到点)+ 审计 note-news 首次实战留痕效果;
decider 新运行质量;有无新的"分析与执行脱节"类问题。
