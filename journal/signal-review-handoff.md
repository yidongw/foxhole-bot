# signal-review-handoff · loop 交接棒

> 每轮开工先读本文承接上轮；收尾在**最上面**追加一节『本轮做了X / 挂账Y / 下轮重点Z』。
> 提交: `git -C /Users/xinjuan/git/foxhole-bot commit journal/signal-review-handoff.md` 并 push origin main（非 ff 先 pull --rebase）。纯 handoff 改动**不必重启 monitor**。

---

## 2026-09-05 ~15:00 (loop: signal-review)
**本轮做了:** Phase 1 干净(0 候选/0 假警报)。worktree 同步到 cd27277(并发轮做了全量亏损归因)。STONKEX[base] 卖飞(hard stop→现2x,-$9.69)属**出场策略=仓位 loop 地盘**,本 loop 未碰。11 个报了没买全是无警报价噪声。无新工作。
**挂账:** 未变 —— decider MarsCoin 出场规则(`b11f689`)归仓位 loop、需重启生效待确认;SLINK 2 钱包跨1 无 soloTrigger;confirm 写 missed.json 未提交结构性 TODO;pre-pump/社媒大工程 TODO。
**下轮重点:** 只报没警报/没复盘真候选;★C 仅碰入场/风控门槛,出场一律让给仓位 loop。

## 2026-09-05 ~14:00 (loop: signal-review)
**本轮做了:** Phase 1 干净(0 候选/0 假警报/0 报了没买;15 刷单无数据 + 10 低市值已自动过滤)。worktree 同步到 118b158(并发 R30 修了 deploy.sh flock→mkdir、救回 2 个 RB winner)。无新工作。
**挂账:** 同上轮未变 —— decider MarsCoin 出场规则(`b11f689`)属仓位 loop 地盘、需重启生效(R30 动过 deploy.sh 可能已部署重启,待确认是否 live);SLINK 2 钱包跨1 无 soloTrigger;confirm 写 missed.json 未提交的结构性 TODO;pre-pump/社媒大工程 TODO。
**下轮重点:** 只报没警报/没复盘的真候选;★C 仅碰入场/风控门槛。

## 2026-09-05 ~13:00 (loop: signal-review)
**本轮做了:** Phase 1 干净(0 候选/0 假警报,报了没买全是无警报价噪声)。承接前几轮的大清账:修了 5 个 loop 质量 bug 全在 main —— ①gmgn 链名别名(solana/eth find2 曾 100% 死,normChain)②pending-movers 跨轮合并 ③已复盘的币(missed.json)不再当候选 ④已交易的币(positions.json)不再误标漏币 ⑤saveMissedCases 加 withFileLock+原子写(防并发丢更新)。ZCAT/FATCOIN/SHROOM 已**提交**进 missed.json(之前只写工作区被并发 reset --hard 还原,反复复活)。用户给的 SLINK(robinhood 0xfa89ed…)挖出 2 个盈利钱包已入追踪(S:0x1d4f6f…realized$366k / A:0x750e8f…$40k)。

**挂账:**
- ⚠️ **decider MarsCoin 出场教训**已固化上 main(`b11f689`,持仓复查段:量能衰减+横盘≠砍仓,留小额 runner 长拿)——**但这属『仓位复盘』loop 的地盘(出场/持仓策略)**,本 loop 以后别再动 decider 出场档,避免双写互覆。且**需重启 monitor 才生效**(BASE_PROMPT 常驻内存),用户定重启时机,未重启。
- SLINK 两钱包都是**跨1**,soloTrigger 未设(设计:跨币复现才升级)。用户若要强制 solo 需手动改记录。
- 结构性 TODO:Phase2 confirm 写 missed.json 仍是**未提交工作区改动**,理论上仍可能被并发 reset 还原(彻底解法:confirm 自动 commit 案例库 或 data/outcomes gitignore,需与并发会话协调)。
- 大工程 TODO:②链上 pre-pump 触发(fresh-pool+聪明钱买入+持币爬升)、④推特/社媒监控(纯 meme 唯一非链上前兆,缺口)。

**下轮重点:** 继续只报没警报的/没复盘的真候选;★C 只碰**入场判断/风控门槛**(出场归仓位 loop);盯 monitor 是否已重启(决定 decider 出场新规是否 live)。
