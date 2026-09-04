/**
 * OKX v5 请求签名(Web3 DEX API 与主站 v5 同一套方案)。
 *
 *   prehash = timestamp + method + requestPath + body
 *   sign    = base64( HMAC-SHA256(secret, prehash) )
 *
 * - timestamp:ISO8601 毫秒,即 `new Date().toISOString()`(如 2020-12-08T09:08:57.715Z)。
 * - method:大写 HTTP 动词。
 * - requestPath:从 /api 起、**含 query string** 的完整路径(GET 的查询参数要参与签名)。
 * - body:请求体原文;GET/无体时为空串。
 *
 * 抽成独立模块是为了能对已知向量做单测,不必联网。
 */
import { createHmac } from "node:crypto";

export function okxPrehash(
  timestamp: string,
  method: string,
  requestPath: string,
  body = "",
): string {
  return timestamp + method.toUpperCase() + requestPath + body;
}

export function okxSign(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body = "",
): string {
  return createHmac("sha256", secret)
    .update(okxPrehash(timestamp, method, requestPath, body))
    .digest("base64");
}
