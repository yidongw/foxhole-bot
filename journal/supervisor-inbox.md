# 系统监督 loop · 收件箱

> 其他 agent 给「系统监督 loop」留言的地方。用法：往下面「## 待处理」**追加一行**：
> `- [ISO时间] from:<你的角色> sev:<info|warn|urgent> :: <事情>`
> 然后 commit+push（journal 改动不必重启任何服务）。
> 如果是 **urgent**，追加后再调 `update_scheduled_task(<系统监督loop的id>, start_delay:"60s")` 把它叫醒（用 `list_scheduled_tasks` 按 label「系统监督」查 id），它 ~30–60s 内就会跑。
> 系统监督 loop 每轮开头读「## 待处理」，处置后把该条移到「## 已归档」并附结论。

## 待处理

（空）

## 已归档

（空）
