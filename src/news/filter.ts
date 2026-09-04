/**
 * 快讯 → 交易信号分层过滤。规则来自 2026-09-02 对 74 条真实快讯的人工分拣：
 * ~70% 是宏观/美股/AI 行业噪音，真正可交易的是三类 ——
 *   1. RB 链 / 币股 meme 动态（JINQIAN/FAMI 当天整轮暴涨崩盘全程有快讯）
 *   2. 上所催化（Binance Alpha 上线 FLORK 后短时 +85%）
 *   3. 关注币的负面（KOL 承认数据编造 → JINQIAN/FAMI 跳水）→ 退出/避险
 */

export type NewsAction = "wake" | "note" | "drop";

export interface NewsClassification {
  action: NewsAction;
  /** true when the wake is a danger signal (exit/avoid, not entry). */
  negative: boolean;
  reasons: string[];
}

// 本 bot 的主战场：Robinhood 链 / Long.xyz 币股 meme
// （快讯正文常写“Robinhood 生态 Meme 币”“Robinhood 市场”，一并覆盖）
const RB_CHAIN = /Robinhood\s*(链|Chain|生态|市场)|Long\.xyz|币股/i;

// 上所/上线催化（现货、Alpha、韩所优先；合约上线也放行，交给下游降权）
const LISTING =
  /(Binance|币安|Coinbase|Upbit|Bithumb|OKX|Bitget|Alpha)[^，。]{0,14}(上线|将上线|上市)|(上线|将上线)[^，。]{0,20}(Binance|币安|Alpha|Coinbase|Upbit|Bithumb)/;

// meme 动能：市值/价格突破式措辞，或大幅拉升。
// “涨超X%”必须 ≥50 — ARB 涨 12% 这种主流币日常波动不算（2026-09-03 教训）
const CAP_BREAKOUT = /(市值|价格)[^，。]{0,10}(突破|速通|创历史新高)|短时暴涨/;

// 交易所储蓄/理财/质押促销措辞 — 非可交易标的的现货/Alpha 上线,也非 meme 暴涨。
// 含 Bitget PoolX「锁仓 X 解锁 Y」这类质押挖矿促销(2026-09-04: BGBTC 曾以 watched 误叫醒)。
const SAVINGS_PROMO =
  /闪赚|活期理财|理财|Simple\s*Earn|余币宝|赚币|奖池|空投活动|返利|PoolX|锁仓[^，。]{0,12}解锁|质押挖矿/i;

function hasMomentum(text: string): boolean {
  if (CAP_BREAKOUT.test(text)) return true;
  for (const m of text.matchAll(/(涨超|涨幅[达超]?)\s*(\d+(?:\.\d+)?)\s*%/g)) {
    if (Number(m[2]) >= 50) return true;
  }
  return false;
}

// 负面：持仓/关注币出现这些词 → 危险信号(退出/避险)。含杠杆清算/爆仓(多单遭清算=看空)
// —— 用"遭/被清算·爆仓·强平"避免撞中性的"清算所/清算网络"(2026-09-04: CASHCAT 多单遭清算)。
const NEGATIVE =
  /跌超|腰斩|崩盘|清仓|归零|编造|夸大|[Rr]ug|被盗|漏洞|蜜罐|黑客|下架|爆仓|强平|遭清算|被清算/;

// 崩盘措辞：市值跌破/腰斩 — 即使币不在关注表也值得留痕（可能是我们漏扫的币）
const CRASH = /市值[^，。]{0,15}(跌破|腰斩)|较高点(跌超|腰斩)/;

// 巨鲸/聪明钱买入 — 建仓类留痕，清仓大币不管
const WHALE_BUY = /(交易者|巨鲸|聪明钱)[^，。]{0,24}(买入|建仓|增持)/;

// 纯噪音：宏观 / 美股大盘个股 / AI 行业 / 政治花边
const MACRO_NOISE =
  /美联储|美债|国债|收益率|央行|CPI|非农|ADP|初请|降息|加息|褐皮书|欧佩克|石油|关税|财报|美股(开盘|盘前|三大)|标普|纳指|道指|IPO|港交所|年薪|薪酬/;
const INDUSTRY_NOISE = /AI模型|大模型|开源.*模型|翻译模型|发布会|访谈|评测|敦促|提议|纪念|硬币|海峡/;

function symbolPattern(sym: string): RegExp {
  const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 短 ticker（如 MU、MOO）大小写敏感 + 词边界，避免撞普通英文单词
  return sym.length <= 4
    ? new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`)
    : new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
}

/** launches.json 里混着一条数千个股票代码拼接的记录 — 过滤掉这种脏 symbol */
export function usableSymbols(symbols: Array<string | undefined>): string[] {
  return [...new Set(symbols.filter((s): s is string => Boolean(s)))].filter(
    (s) => !s.includes(",") && s.length >= 2 && s.length <= 12,
  );
}

// 有 meme/RB 语境才允许歧义符号（AI、MU 这类会撞普通词的）算命中
const MEME_CONTEXT = /[Mm]eme|Robinhood|Long\.xyz|币股/;

function isAmbiguous(sym: string): boolean {
  return sym.length <= 2 || SYMBOL_STOPLIST.has(sym.toUpperCase());
}

/**
 * @param title 快讯标题（“具体点名了哪个币”只看标题 — 正文会引用 ARB/ETH 等无关 ticker）
 * @param watched 关注表（launches + 热点币记忆）
 * @param content 可选正文纯文本 — 参与链名/涨跌措辞匹配（标题常不带“Robinhood 生态”字样）
 */
export function classifyFlash(
  rawTitle: string,
  watched: string[] = [],
  content?: string,
): NewsClassification {
  const title = content ? `${rawTitle} ${content}` : rawTitle;
  const reasons: string[] = [];
  const memeContext = MEME_CONTEXT.test(title);
  // “具体点名了哪个币”只看标题：正文常引用 NVDA/TSLA/AAPL/SPCX 等无关 ticker
  // (美股宏观快讯正文提一句 NVIDIA → 撞股票同名 meme 误叫醒 — 2026-09-03 教训)。
  // rb-chain/动能/负面 仍看标题+正文(正文才有“Robinhood 生态”字样)。
  // 停用词里的主流币/交易所/指数代码永远不是我们盯的 meme,即便 memeContext 也不命中。
  const hitSymbols = watched.filter(
    (s) =>
      symbolPattern(s).test(rawTitle) &&
      !SYMBOL_STOPLIST.has(s.toUpperCase()) &&
      (memeContext || !isAmbiguous(s)),
  );
  const rbChain = RB_CHAIN.test(title);
  const negative = NEGATIVE.test(title);

  if (hitSymbols.length) reasons.push(`watched:${hitSymbols.join("+")}`);
  if (rbChain) reasons.push("rb-chain");

  // 关注币命中：正面负面都叫醒（负面 = 退出/避险信号）
  if (hitSymbols.length) {
    if (negative) reasons.push("negative");
    else if (hasMomentum(title)) reasons.push("momentum");
    // 纯促销/质押活动里"点名"某关注币(如「锁仓 BGBTC 解锁 UNI」「OKX闪赚上线 CP 交易赚币」)
    // 不是可交易事件 —— 无动能/无负面时降级留痕,别叫醒(2026-09-04)。
    else if (SAVINGS_PROMO.test(title)) {
      return { action: "note", negative: false, reasons };
    }
    return { action: "wake", negative, reasons };
  }

  // 主战场链：必须有具体的事才叫醒 — 暴跌/动能/上所/点名了某个 token；
  // 纯叙事（“Robinhood Chain 成新增收入来源”这类）降级留痕，不打扰
  if (rbChain) {
    const specific =
      negative || hasMomentum(title) || LISTING.test(title) || extractSymbols(rawTitle).length > 0;
    if (specific) {
      if (negative) reasons.push("negative");
      else if (hasMomentum(title)) reasons.push("momentum");
      return { action: "wake", negative, reasons };
    }
    return { action: "note", negative: false, reasons };
  }

  // 上所催化只看标题:真上所快讯标题必写"X 交易所上线 Y";AI 行业/模型快讯正文里
  // 偶带"…Alpha…上线"会误触发(2026-09-04: 智谱 GLM-5.3-Flash 正文含 Alpha 上线)。
  // “闪赚/理财/奖池”类是交易所储蓄·活动促销,不是可交易标的的上所(2026-09-03)。
  if (LISTING.test(rawTitle) && !SAVINGS_PROMO.test(title)) {
    reasons.push("listing");
    return { action: "wake", negative: false, reasons };
  }

  // 噪音优先于泛 meme 动能：宏观/行业新闻里也常出现“涨超 X%”
  if (MACRO_NOISE.test(title) || INDUSTRY_NOISE.test(title)) {
    return { action: "drop", negative: false, reasons: ["noise"] };
  }

  // 其它链的 meme 动能 → 记到 filter-log 供复盘，不叫醒
  if (/[Mm]eme/.test(title) && (hasMomentum(title) || negative)) {
    return { action: "note", negative, reasons: ["meme-momentum"] };
  }

  // 动能措辞但标题没带 Meme/链名（如「microduck市值突破3200万美元」）——
  // 2026-09-02 复盘教训: 这类标题正是漏扫币的第一信号，至少留痕
  if (hasMomentum(title)) {
    return { action: "note", negative: false, reasons: ["momentum"] };
  }

  // 崩盘 / 巨鲸建仓：不认识的币也留痕 — 复盘时对照 coverage_miss
  if (CRASH.test(title)) {
    return { action: "note", negative: true, reasons: ["crash"] };
  }
  if (WHALE_BUY.test(title)) {
    return { action: "note", negative: false, reasons: ["whale-buy"] };
  }

  return { action: "drop", negative: false, reasons: [] };
}

// 常见非 token 大写缩写，热点币提取时排除
const SYMBOL_STOPLIST = new Set([
  "BTC", "ETH", "SOL", "BNB", "USDT", "USDC", "USD", "WETH", "WBTC",
  "AI", "API", "APP", "APR", "APY", "ATH", "CEO", "CTO", "CPI", "DAO",
  "DEX", "CEX", "ETF", "FDV", "IPO", "KOL", "LP", "NFT", "NYSE", "OG",
  "OTC", "PVP", "RWA", "TGE", "TVL", "WTI", "ADP", "GDP", "FOMC", "SEC",
  "HOOD", "MEME", "GMGN", "FOMO",
  // 交易所名 / 指数·ETF 代码 — 常出现在“上线/预测市场”类快讯里，
  // 会被 extractSymbols 当 token 抓进 hotSymbols → 后续误叫醒(2026-09-03)
  "OKX", "BINANCE", "COINBASE", "UPBIT", "BITHUMB", "BITGET", "BYBIT", "KRAKEN",
  "SPY", "QQQ", "DIA", "IWM", "VIX", "NDX",
  // AI 大模型名 / 交易所包装币 — 撞 token 代码,出现在行业/质押新闻里(2026-09-04):
  // GLM=智谱模型(GLM-5.3-Flash),BGBTC=Bitget 包装 BTC(PoolX 质押)
  "GLM", "BGBTC", "GPT", "QWEN", "KIMI", "GROK", "LLAMA", "GEMINI",
  // 主流币 — 不是我们交易的 meme，点名它们不构成“具体标的”
  "ARB", "OP", "SUI", "APT", "TON", "TRX", "XRP", "ADA", "AVAX", "DOT",
  "LINK", "UNI", "AAVE", "LDO", "CRV",
]);

/**
 * 从叫醒过的快讯标题里提取候选 token symbol（热点币记忆的输入）：
 * 一个币第一次上新闻后，48h 内它的后续快讯（尤其暴跌）都应命中关注表。
 * 除全大写 ticker 外，还提取「Meme币microduck」式小写名和「牛来」式引号名。
 */
export function extractSymbols(title: string): string[] {
  const out: string[] = [];
  out.push(...(title.match(/[A-Z][A-Z0-9]{2,9}/g) ?? []));
  for (const m of title.matchAll(/[Mm]eme\s*币\s*([A-Za-z][A-Za-z0-9_-]{2,14})/g)) {
    out.push(m[1]);
  }
  for (const m of title.matchAll(/「([^」\s]{1,12})」/g)) {
    const name = m[1];
    // 真 meme 名(「牛来」)一般 ≤3 个汉字或含拉丁/数字;≥4 的纯中文引号内容多是
    // 促销/叙事短语(「交易赚币」「借壳收割」),别当 token 种进 hotSymbols 自我循环叫醒。
    const pureCjk = /^[一-鿿]+$/.test(name);
    if (pureCjk && name.length >= 4) continue;
    out.push(name);
  }
  return [
    ...new Set(out.filter((s) => !SYMBOL_STOPLIST.has(s.toUpperCase()))),
  ];
}
