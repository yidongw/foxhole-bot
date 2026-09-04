import { describe, expect, it } from "vitest";

import { okxPrehash, okxSign } from "../src/venues/okx/sign.js";

describe("okxPrehash", () => {
  it("concatenates timestamp+METHOD+path+body and uppercases the method", () => {
    expect(
      okxPrehash("2020-12-08T09:08:57.715Z", "get", "/api/v5/x", "{\"a\":1}"),
    ).toBe("2020-12-08T09:08:57.715ZGET/api/v5/x{\"a\":1}");
  });

  it("treats an omitted body as empty string", () => {
    expect(okxPrehash("T", "GET", "/p")).toBe("TGET/p");
  });
});

describe("okxSign", () => {
  // 固定向量:secret=test-secret,GET,含 query 的完整 requestPath,空 body。
  // query 必须参与签名——顺序错/漏 query 会导致 OKX 50113 签名错误。
  it("matches the known HMAC-SHA256 base64 vector", () => {
    expect(
      okxSign(
        "test-secret",
        "2020-12-08T09:08:57.715Z",
        "GET",
        "/api/v5/dex/aggregator/quote?amount=1000000&chainIndex=4663",
      ),
    ).toBe("7xeYA1tN6yB1v83+FLHYcd9KGLD+q1EFrYxcjkhZpRs=");
  });
});
