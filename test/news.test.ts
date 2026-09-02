import { describe, expect, it } from "vitest";

import { classifyFlash, extractSymbols, usableSymbols } from "../src/news/filter.js";

// 2026-09-02 真实快讯标题回归测试
const WATCHED = ["FAMI", "BONER", "MU", "JINQIAN"];

describe("classifyFlash", () => {
  it("wakes on RB-chain meme momentum", () => {
    const c = classifyFlash(
      "Robinhood链Meme币JINQIAN市值突破7000万美元，续创历史新高",
      WATCHED,
    );
    expect(c.action).toBe("wake");
    expect(c.negative).toBe(false);
    expect(c.reasons).toContain("rb-chain");
  });

  it("wakes negatively on watched-token dump news", () => {
    const c = classifyFlash(
      "Meme币JINQIAN短时一度较高点跌超70%，现回升至4200万美元",
      WATCHED,
    );
    expect(c.action).toBe("wake");
    expect(c.negative).toBe(true);
  });

  it("wakes negatively on fraud-admission news for watched tokens", () => {
    const c = classifyFlash(
      "加密KOL Rune：收购纳斯达克公司构想由Claude生成，相关数据系编造及夸大",
      // 标题没有 symbol，但 FAMI 版本有
      ["FAMI"],
    );
    // 该标题无 watched/RB 命中 → 不叫醒；带 symbol 的姊妹快讯才叫醒
    expect(c.action).toBe("drop");
    const c2 = classifyFlash(
      "JINQIAN/FAMI市值较高点均跌超70%，加密KOL Rune称收购纳斯达克公司构想由Claude生成",
      ["FAMI"],
    );
    expect(c2.action).toBe("wake");
    expect(c2.negative).toBe(true);
  });

  it("wakes on exchange listing catalysts", () => {
    expect(classifyFlash("Binance Alpha上线FLORK、PONS").action).toBe("wake");
    expect(
      classifyFlash("受上线Binance Alpha消息影响，FLORK短时涨超85%").action,
    ).toBe("wake");
  });

  it("drops macro and industry noise", () => {
    for (const title of [
      "美国8月ADP就业人数3.8万人，预期4.8万人",
      "美联储公布经济状况褐皮书",
      "英伟达涨近5%，市值现报5.49万亿美元",
      "Gemini3.8 Flash正式上线：价格不变，多项评测胜过Opus5",
      "特朗普提议将霍尔木兹海峡更名为「特朗普海峡」",
      "月之暗面（Kimi）向港交所秘密交表，正式启动IPO",
      "30年期美债连续41个交易日站上5%，高利率正常态化",
    ]) {
      expect(classifyFlash(title, WATCHED).action).toBe("drop");
    }
  });

  it("does not match short tickers inside ordinary words", () => {
    // MU 不应命中 "Multicoin"
    const c = classifyFlash("Multicoin联创Kyle Samani加入Backpack US董事会", WATCHED);
    expect(c.action).toBe("drop");
  });

  it("notes non-RB meme momentum instead of waking", () => {
    const c = classifyFlash("某Solana Meme币市值短时突破5000万美元", []);
    expect(c.action).toBe("note");
  });

  it("notes crashes of unknown tokens (coverage-miss cross-check)", () => {
    const c = classifyFlash("「牛来」 市值短时跌破7000万美元，较高点腰斩", []);
    expect(c.action).toBe("note");
    expect(c.negative).toBe(true);
  });

  it("notes whale accumulation, drops whale exits of majors", () => {
    expect(
      classifyFlash("某交易者花费1.9万美元买入JINQIAN，获利约10倍", []).action,
    ).toBe("note");
    expect(
      classifyFlash("某交易者清仓7201枚ETH，约合1720万美元", []).action,
    ).toBe("drop");
  });

  it("wakes on hot-symbol follow-up dumps once the symbol is remembered", () => {
    // 第一条 wake 后 JINQIAN 进入热点币 → 后续暴跌快讯负面叫醒
    const c = classifyFlash(
      "Meme币JINQIAN短时一度较高点跌超70%，现回升至4200万美元",
      ["JINQIAN"],
    );
    expect(c.action).toBe("wake");
    expect(c.negative).toBe(true);
  });
});

describe("extractSymbols", () => {
  it("extracts token symbols and skips common abbreviations", () => {
    expect(
      extractSymbols("Robinhood链Meme币JINQIAN市值突破7000万美元，续创历史新高"),
    ).toEqual(["JINQIAN"]);
    expect(extractSymbols("Binance Alpha上线FLORK、PONS")).toEqual(["FLORK", "PONS"]);
    expect(extractSymbols("BTC巨鲸用1.58亿大单看涨至10万美元")).toEqual([]);
  });

  it("extracts lowercase Meme币 names and quoted names (microduck 复盘教训)", () => {
    expect(
      extractSymbols("Meme币microduck市值短时突破4000万美元，再创历史新高"),
    ).toContain("microduck");
    expect(extractSymbols("「牛来」 市值短时跌破7000万美元，较高点腰斩")).toContain(
      "牛来",
    );
  });
});

describe("classifyFlash momentum without meme keyword", () => {
  it("notes bare market-cap-breakout titles instead of dropping", () => {
    // 2026-09-02: 这条被旧规则 drop，导致 microduck 暴涨漏报
    const c = classifyFlash("microduck市值突破3200万美元，现报0.0322美元", []);
    expect(c.action).toBe("note");
    expect(c.reasons).toContain("momentum");
  });

  it("wakes when content mentions the RB chain even if title does not", () => {
    const c = classifyFlash(
      "microduck市值突破3200万美元，现报0.0322美元 Robinhood 生态 Meme 币 microduck 市值现报约 3221 万美元",
      [],
    );
    expect(c.action).toBe("wake");
  });
});

describe("usableSymbols", () => {
  it("filters the stock-universe blob and dedupes", () => {
    const syms = usableSymbols(["MU", "BONER", "AAAP,AACG,AACI", undefined, "MU", "X"]);
    expect(syms).toEqual(["MU", "BONER"]);
  });
});
