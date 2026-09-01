export const ROBINHOOD_CHAIN_ID = 4663;

export const LONG_FACTORY =
  "0x22e99278308b393ea1260859b181ad7e78f5eeed" as const;

export const LONG_AIRLOCK =
  "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862" as const;

export const LONG_CREATED_EVENT =
  "Created(address,address,address,bytes32,uint256,uint256,string)" as const;

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
