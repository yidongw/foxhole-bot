/**
 * KyberSwap 聚合器(Robinhood Chain)配置。
 *
 * Kyber 在 RB 上有独立公开 API(slug `robinhood`),报价+执行都真金外可验;
 * 覆盖 LI.FI 接不住的买卖盲区(如 UFG 的 v4/native 池买入、ORDO 类只有单聚合器
 * 能卖的币),且**自带配额**——不吃 LI.FI 的免费限流。用作 aggChain 的一条腿。
 */
export const KYBER_BASE =
  "https://aggregator-api.kyberswap.com/robinhood/api/v1";

/** Kyber 用这个哨兵地址表示原生 gas 代币。 */
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** `x-client-id` 头——标识集成方,拿更宽的限额。 */
export function kyberClientId(): string {
  return process.env.KYBER_CLIENT_ID || "foxhole-bot";
}
