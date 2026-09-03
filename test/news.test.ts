import { describe, expect, it } from "vitest";

import { classifyFlash, extractSymbols, usableSymbols } from "../src/news/filter.js";
import { extractTokenRefs } from "../src/news/blockbeats.js";

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

  it("does not treat majors' daily moves as RB-chain momentum (ARB +12%)", () => {
    // 2026-09-03 用户反馈: 这条以 [rb-chain, momentum] 进了频道
    const c = classifyFlash("ARB 24小时涨超12%，Robinhood链上热潮带来新增收入", []);
    expect(c.action).toBe("note");
    expect(c.reasons).not.toContain("momentum");
  });

  it("does not wake on stoplisted tickers even when in the watched set", () => {
    // stale hotSymbols(ARB/HOOD/OKX/SPY)在 Robinhood 语境里曾被当 watched 误叫醒
    // (2026-09-03)。停用词内的主流币/交易所/指数代码即便进了 watched 也不算命中。
    const watched = ["ARB", "HOOD", "OKX", "SPY", "QQQ", "JINQIAN"];
    expect(
      classifyFlash("ARB 24小时涨超12%，Robinhood链上热潮带来新增收入", watched)
        .reasons,
    ).not.toContain("watched:ARB");
    expect(
      classifyFlash("Ansem：Robinhood股价「筑底收敛」，有望在Q4创新高", watched)
        .action,
    ).toBe("drop");
    expect(
      classifyFlash("OKX闪赚上线CP「交易赚币」，总奖池达10,000,000 CP", watched)
        .action,
    ).toBe("drop");
    expect(
      classifyFlash(
        "Predict.fun宣布上线SPY/USDT、QQQ/USDT 15分钟涨跌预测市场",
        watched,
      ).action,
    ).toBe("drop");
    // 真 meme 仍照常叫醒
    expect(
      classifyFlash("Meme币JINQIAN短时较高点跌超70%", watched).action,
    ).toBe("wake");
  });

  it("does not seed exchange/index tickers as hot symbols", () => {
    // extractSymbols 曾把 OKX/SPY/QQQ 抓成 hotSymbols → 后续误叫醒
    for (const junk of ["OKX", "SPY", "QQQ", "BITGET", "UPBIT"]) {
      expect(extractSymbols(`${junk}上线新活动`)).not.toContain(junk);
    }
  });

  it("still counts ≥50% pumps and cap breakouts as momentum", () => {
    expect(
      classifyFlash("受上线Binance Alpha消息影响，FLORK短时涨超85%", []).action,
    ).toBe("wake");
    expect(
      classifyFlash("Robinhood链Meme币JINQIAN市值突破7000万美元，续创历史新高", []).reasons,
    ).toContain("momentum");
  });

  it("notes RB-chain narrative news without a concrete token (no wake)", () => {
    // 2026-09-03 用户反馈: 这条进了 trade-signal 但无从下手
    const c = classifyFlash(
      "Arbitrum DAO上半年收入619万美元，Robinhood Chain成新增收入来源",
      [],
    );
    expect(c.action).toBe("note");
    expect(c.reasons).toContain("rb-chain");
  });

  it("still wakes RB-chain news that names a token or has momentum", () => {
    expect(
      classifyFlash(
        "币股meme或正逼空纳斯达克上市公司？JINQIAN/FAMI暴涨或与KOL Rune收购Farmmi Inc股份关联",
        [],
      ).action,
    ).toBe("wake");
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

describe("extractTokenRefs", () => {
  it("parses GMGN robinhood links with the i_xxx_ prefix", () => {
    // 真实 BlockBeats 正文格式
    const html =
      '据 <a href="https://gmgn.ai/robinhood/token/i_m4TE56o8_0x56910d4409f3a0c78c64dd8d0545ff0705389870">GMGN</a> 显示';
    expect(extractTokenRefs(html)).toEqual([
      { chain: "robinhood", address: "0x56910d4409f3a0c78c64dd8d0545ff0705389870" },
    ]);
  });

  it("parses solana GMGN links and dedupes", () => {
    const html =
      'gmgn.ai/sol/token/i_m4TE56o8_9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM ' +
      'dexscreener.com/solana/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const refs = extractTokenRefs(html);
    expect(refs).toHaveLength(1);
    expect(refs[0].chain).toBe("solana");
  });

  it("returns empty when no chain-carrying link is present", () => {
    expect(extractTokenRefs("市值突破 4000 万美元，无链接")).toEqual([]);
  });
});

describe("usableSymbols", () => {
  it("filters the stock-universe blob and dedupes", () => {
    const syms = usableSymbols(["MU", "BONER", "AAAP,AACG,AACI", undefined, "MU", "X"]);
    expect(syms).toEqual(["MU", "BONER"]);
  });
});
