export const ROBINHOOD_CHAIN_ID = 4663;

export const LONG_FACTORY =
  "0x22e99278308b393ea1260859b181ad7e78f5eeed" as const;

export const LONG_AIRLOCK =
  "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862" as const;

/**
 * topic0 of the Long Factory launch event, verified on-chain 2026-09-02
 * (1000+ matching logs; BONER/AI decode correctly). Canonical signature name
 * unknown — logs are fetched by raw topic and decoded manually:
 *   topics[1] = token, topics[2] = token (dup), topics[3] = pair target
 *   data = (address auctionNumeraire, address hook, bytes32 auctionPoolId,
 *           uint256 epochStart, uint256 epochEnd, string symbol)
 */
export const LONG_CREATED_TOPIC0 =
  "0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b" as const;

export const DEFAULT_PUBLIC_RPC =
  "https://rpc.mainnet.chain.robinhood.com";

export const STOCK_QUOTES = new Set([
  "NVDA",
  "TSLA",
  "SPCX",
  "AAPL",
  "MSFT",
  "MU",
  "HOOD",
  "SPCXX",
  "NVDAx3L",
  "HIMS",
  "MSFTX",
  "GOOGLX",
  "AMZNX",
  "METAX",
  "AAPLX",
  "SPYX",
  "QQQX",
  "AI",
]);

export const SEARCH_QUERIES = [
  "NVDA",
  "TSLA",
  "SPCX",
  "AAPL",
  "MSFT",
  "MU",
  "HOOD",
  "HIMS",
  "BONER",
  "AI",
  "SPACEHOOD",
  "GOOGL",
  "AMZN",
  "META",
  "SPY",
  "QQQ",
] as const;

export const STABLE_QUOTES = new Set(["ETH", "WETH", "USDG", "USDC", "USDT"]);
