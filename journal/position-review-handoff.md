# position-review-handoff · loop 交接棒

> 每轮开工先读本文承接上轮；收尾在**最上面**追加一节『本轮做了X / 挂账Y / 下轮重点Z』。
> 提交: `git -C /Users/xinjuan/git/foxhole-bot commit journal/position-review-handoff.md` 并 push origin main（非 ff 先 pull --rebase）。纯 handoff 改动**不必重启 monitor**。

---

## 2026-09-05 ~13:50 UTC · 补充轮（用户指出流程盲区：亏损归因）

**本轮做了**：
- 全量亏损归因回补（69 笔平仓）→ 建 `journal/loss-ledger.md`。**重大发现：动量 probe 类净 -$196.69（27笔），此前"probe +EV"判断被全量数据推翻**（只数了近期 2 小亏 vs 3 赢家 = 采样偏差）；新闻叙事 +$51 / smartmoney +$29 为正预算类别
- sizing 纪律漂移点名：Max $222/-$32、Stonks $145/-$29 违背"小额试探"设计
- **G 节【亏损归因】已固化进任务 prompt**（每轮增量归因+类别净值+双侧同口径）
- 动量 probe 证据包经 loss-ledger 移交 1h 信号 loop（入场分工）；出场侧确认无档位问题

**挂账**：承接上轮（ASS 薄池 / WALLET 36h 时限检查）+ 观察 1h loop 是否消费 probe 证据包

**下轮重点**：G 节首次例行执行（增量模式）；probe 类净值是否继续恶化
---

## 2026-09-05 ~13:15 UTC · 2h 仓位复盘轮

**本轮做了**：
- 全仓校准 9/9（批量行情+RAWR 单查补漏），**零调仓**——小时循环逐仓笔记质量高（MarsCoin 用自己的出场端教训改判 max-hold、WALLET 第九轮微调有算账、PONS 识别 HL feed 背离只做现货），无 churn 必要
- B 扫描 0 可疑（双源护栏后累计零幻影）；18932 收口验证：-22% 硬止损 tx✓（-$4.29，垂直段试探的设计内成本）
- E 节：RAWR 的 GOOGLc 计价池经 credible-quote(registry 传递信任) 正常定价 ✓；无新资产类别

**挂账**：
- ASS[live,剩40%]：全池流动性已跌到 $90k（低于纯动量 $100k 门槛，但它是 smart-money 入场），-24% 止损已收紧，薄池滑点风险留意
- ORDO 顶部新 USDG 池"卖方布局"风险（decider 入场笔记已自知）
- 垂直段追入 probe 系列累计：ORDO#1 -$4.56 + 18932 -$4.29 ≈ -$9 vs 同策略赢家(FATCOIN/SHROOM/GRASS live) ≈ +$28，仍显著 +EV，继续观察不收紧

**下轮重点**：
- probe 系列若累计亏损扩至 -$20，把"加速段入场时机"证据打包给 1h 信号复盘 loop（入场判断归他们，勿直接改）
- WALLET 36h 时限（~09-06 04:00Z 到期）前检查 +33% 浮盈是否该在时限前主动兑现而非让时间闸执行

(还没有轮次记录)
