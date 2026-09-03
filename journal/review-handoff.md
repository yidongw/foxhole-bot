# 复查交接棒(自进化复查循环的状态文件)

每轮自主复查结束时更新本文件;下一轮开头先读它。格式随需要进化,
但保留三块:上轮动作 / 挂账 / 下轮重点。

## 2026-09-03 02:3x UTC 交接(循环重启,本文件初始化)

**近期已修(全部已部署验证):**
- 无头决策进程 decider(03a9d9a):信号落地秒级 AI 决策,4 次生产运行全部正确
- post_pump(e0fc327)/ falling_knife(e4cc550)/ collapsed_pump(195cb20)三道事后信号防线
- PONS 主池劫持 bug(6016e10):股票配对需 ≥25% 最深池流动性
- 24h 上限改按在险资金计算(becb219),回款可再利用,最坏保护不变
- BLOCKBEATS_API_KEY 已进部署 .env,官方 API 在跑

**挂账(未修,按优先级):**
1. 验证 collapsed_pump 上线后有没有误杀正常回调币(看 monitor 日志 veto 行)
2. 24h 自复盘 13:15 UTC 到期 — 确认它跑了、确认清单发到了 filter-log、
   等用户 /review-confirm
3. 正面新闻也会拉起 decider(浪费一次运行)— 可考虑仅 negative 或带押注
   symbol 的新闻才 spawn(低优先级,成本问题非正确性)
4. collapseRatio 测试放在 review.test.ts,应挪 safety.test.ts(纯整洁)
5. 用户侧待办:钱包充值、切 live 口令、巡检 thread 迁移到 #📈🤖-ai-trading

**下轮重点:** 挂账 1 和 2;另看 decider 有无新运行、判断质量如何。
