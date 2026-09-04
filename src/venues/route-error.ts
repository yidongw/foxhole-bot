/**
 * 路由/构建/模拟阶段(swap 广播前)的失败基类。
 *
 * 各聚合器路由(OKX、LI.FI…)在**广播 swap 前**的任何失败(API 挂、无路由、
 * 授权失败、eth_call 模拟 revert)都抛本类的子类。`runWithFallback` 只对
 * RouteError 回退兜底路由——因为此时链上还没成交,换条路重试是安全的;
 * 广播之后的失败抛普通 Error,绝不回退,避免重复下单。
 */
export class RouteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RouteError";
  }
}
