# 新闻&覆盖率&安全 审计交接棒(2h 循环)

与代码正确性复查循环(review-handoff.md)分工不同:本循环专注
① 新闻漏分析 ② 暴涨漏报/报了没动静 ③ 代码漏洞/安全。每轮更新本文件,下轮先读。

## 2026-09-03 03:1x UTC 初始化

**当前系统状态(背景):**
- 信号四道事后/劣质过滤器已上线:post_pump(>500%)、falling_knife(24h≤-10%放量)、
  collapsed_pump(现价<窗口高40%)、micro_cap(FDV<$1M)。
- AI 决策进程(decider)是唯一买家,TRADE_AUTO_ENTRY 默认关;引擎只管出场。
- 新闻:BlockBeats 官方 API 在跑,分类 wake/note/drop,热点币 48h 记忆,
  news 决策可用 `npm run ai -- note-news` 留痕到 #news-radar。
- paper 账户 $1000 起,当前约 $977。

**本循环挂账(空,首轮建立基线):**
- 首轮请建立"最近 24h 暴涨榜 vs 我方是否扫描/报警"的基线对照。

**下轮重点:** 首次全量跑四项审计,建立基线。
