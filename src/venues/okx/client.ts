/**
 * OKX Web3 API 底层 HTTP 客户端。
 *
 * 两个环境特殊点决定了这里不用 fetch:
 *
 * 1) **本机/生产 DNS 把 OKX 域名黑洞了**——`web3.okx.com` 在本地解析器返回
 *    NXDOMAIN(公共 DNS 却能解析)。所以我们先用 Cloudflare DoH(向 IP
 *    1.1.1.1 发 application/dns-json 查询,IP 本身无需 DNS)拿到 A 记录,
 *    再用 node:https 按 IP 直连、把 SNI/Host 设成真实域名。证书校验走 SNI,
 *    因此仍是对 web3.okx.com 的正常 TLS 校验,只是绕过了被污染的解析器。
 *
 * 2) 需要按 IP 连接 + 自定义 SNI,node:https 比 fetch 直接,且零额外依赖。
 *
 * 若某天本机 DNS 不再屏蔽 OKX,`resolveHost` 会优先用系统解析,DoH 仅兜底。
 */
import { request as httpsRequest } from "node:https";
import { resolve4 } from "node:dns/promises";

import { OKX_BASE_HOST, loadOkxCreds } from "./config.js";
import { okxSign } from "./sign.js";

const DOH_URL = "https://1.1.1.1/dns-query";
/** 解析结果缓存 5 分钟,避免每次下单都打 DoH。 */
const RESOLVE_TTL_MS = 5 * 60 * 1000;
const resolveCache = new Map<string, { ip: string; at: number }>();

async function dohResolve(host: string): Promise<string> {
  const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: "application/dns-json" },
  });
  if (!res.ok) throw new Error(`DoH 查询失败 HTTP ${res.status}`);
  const json = (await res.json()) as {
    Answer?: Array<{ type: number; data: string }>;
  };
  const a = json.Answer?.find((r) => r.type === 1 /* A */)?.data;
  if (!a) throw new Error(`DoH 未返回 ${host} 的 A 记录`);
  return a;
}

/** 先试系统解析,失败(域名被屏蔽)再走 DoH。带 TTL 缓存。 */
export async function resolveHost(host: string): Promise<string> {
  const hit = resolveCache.get(host);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.ip;

  let ip: string;
  try {
    const addrs = await resolve4(host);
    if (!addrs.length) throw new Error("no A record");
    ip = addrs[0];
  } catch {
    ip = await dohResolve(host);
  }
  resolveCache.set(host, { ip, at: Date.now() });
  return ip;
}

export interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T;
}

interface OkxRequestOptions {
  method?: "GET" | "POST";
  /** 查询参数(GET);会参与签名。 */
  query?: Record<string, string | number | undefined>;
  /** 请求体对象(POST);会 JSON 序列化并参与签名。 */
  body?: unknown;
  timeoutMs?: number;
}

function buildRequestPath(
  base: string,
  query?: OkxRequestOptions["query"],
): string {
  if (!query) return base;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

/**
 * 发一个已签名的 OKX Web3 API 请求。成功返回 data 字段;OKX 业务码非 "0"
 * 或 HTTP 非 2xx 一律抛错(错误绝不吞掉——和仓库其它 live 路径同纪律)。
 */
export async function okxRequest<T>(
  apiPath: string,
  opts: OkxRequestOptions = {},
): Promise<T> {
  const { method = "GET", query, body, timeoutMs = 15_000 } = opts;
  const creds = loadOkxCreds();

  const requestPath = buildRequestPath(apiPath, query);
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const sign = okxSign(
    creds.apiSecret,
    timestamp,
    method,
    requestPath,
    bodyStr,
  );

  const ip = await resolveHost(OKX_BASE_HOST);

  const raw = await new Promise<string>((resolvePromise, reject) => {
    const req = httpsRequest(
      {
        host: ip,
        servername: OKX_BASE_HOST, // SNI + 证书校验对齐真实域名
        port: 443,
        method,
        path: requestPath,
        headers: {
          Host: OKX_BASE_HOST,
          "Content-Type": "application/json",
          "OK-ACCESS-KEY": creds.apiKey,
          "OK-ACCESS-SIGN": sign,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": creds.passphrase,
          "OK-ACCESS-PROJECT": creds.projectId,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
            resolvePromise(text);
          } else {
            reject(
              new Error(`OKX HTTP ${res.statusCode} @ ${apiPath}: ${text}`),
            );
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`OKX 请求超时 @ ${apiPath}`)));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });

  let parsed: OkxResponse<T>;
  try {
    parsed = JSON.parse(raw) as OkxResponse<T>;
  } catch {
    throw new Error(`OKX 返回非 JSON @ ${apiPath}: ${raw.slice(0, 200)}`);
  }
  if (parsed.code !== "0") {
    throw new Error(`OKX 业务错误 ${parsed.code} @ ${apiPath}: ${parsed.msg}`);
  }
  return parsed.data;
}
