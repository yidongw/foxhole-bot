# smartmoney-handoff · loop 交接棒

> 每轮开工先读本文承接上轮；收尾在**最上面**追加一节『本轮做了X / 挂账Y / 下轮重点Z』。
> 提交: `git -C /Users/xinjuan/git/foxhole-bot commit journal/smartmoney-handoff.md` 并 push origin main（非 ff 先 pull --rebase）。纯 handoff 改动**不必重启 monitor**。

---

## R30 · 2026-09-05

**本轮做了 X:**
- 同步 worktree→origin/main;确认**单实例锁生效**(0 重复,lock 由 leaf node 持有)。
- 信号质量(触发时刻口径):2 个 RB 触发 ASS/PILL(同一 S 钱包 0x63A7f9FF)均**走平**(ASS +2.2%峰值、PILL +14%后回落=事实上平)——正常 memecoin 方差,非误杀非追顶。AI 买入 ASS(超跌反转小仓)无追顶。PILL 已确认没丢(inbox 韧性,已 processed)。
- revet:**禁用退化 BSC 钱包 0x1228803A**(ROI 0.20x/胜率 18%,双双跌破宽松线)。
- **修复 deploy.sh 两个致命 bug**:(1) macOS 无 `flock`→部署脚本一直挂在 `flock: command not found`,所有 loop 的部署静默失败;改成 mkdir 可移植锁(含 stale 回收)。(2) 单实例被误计成 2(npm exec + tsx wrapper 都匹配旧 MON_MATCH)→每次部署多余 kill-all 重启,且 kill 匹配漏掉 node leaf 会 orphan;改 MON_MATCH='cli/monitor.ts'(杀全树)+ COUNT_MATCH='npm exec tsx …'(按逻辑实例计数)。
- **抢救 2 个 live-only RB 赢家**(0x1d4f6f17 S $366k、0x750e8fce A $40k):只存在于 live 未提交,deploy 的 `reset --hard` 会抹掉;已用 live 作 base 合并进提交,现进了 origin/main。

**挂账 Y(都需你拍板/花钱):**
- RB 钱包近乎空(链上 RB 0.036),所有 RB 买入缩成 $5–15 dust;用户说今晚充值。
- decider spend 限额本轮 18 次(历史最高)。
- BSC 只有报警、0 交易信号:唯一活跃的 0xb0f8 是低 ROI(1.7x)高频撒网号,不宜 soloTrigger;缺高质量 BSC 钱包。

**下轮重点 Z:**
- 验证 RB 充值是否到账→仓位恢复正常 size→那时信号质量才真正可评(现在全是 dust,PnL 不可读)。
- 部署前必查 `git -C /Users/xinjuan/git/foxhole-bot status --short data/smart-money.json`:live 常有未提交钱包(别的 loop/进程直接加的),`reset --hard` 会抹掉——用 live 作 base 合并(本轮已这么做,防丢)。
- 想补 BSC 交易信号→跑 BSC 好币 find2 找高质量钱包(非撒网号),或提额后再议 soloTrigger。
- 每轮部署后仍验单实例(锁 + deploy.sh 计数已双保险)。
