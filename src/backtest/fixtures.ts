import { BONER_ADDRESS } from "../signals/config.js";
import type { TokenBacktestFixture } from "./historical-replay.js";

/** Tokens that pumped — must alert (≥ alert) before peak day. */
export const PUMP_FIXTURES: TokenBacktestFixture[] = [
  {
    kind: "pump",
    symbol: "BONER",
    address: BONER_ADDRESS,
    poolId: "0x9c89b04303dfa76f3f6fb02c2b77be0e8a00ab8fa00d507119acd54ab3e8640d",
    quoteSymbol: "HIMS",
    launchAt: "2026-08-20T20:59:46.000Z",
    ohlcvStart: "2026-08-15",
    notes: "Aug 28 volume breakout → Aug 30–31 weekend squeeze",
  },
  {
    kind: "pump",
    symbol: "AI",
    address: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
    poolId: "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27",
    quoteSymbol: "NVDA",
    launchAt: "2026-07-14T00:00:00.000Z",
    ohlcvStart: "2026-07-10",
    notes: "Jul 21–22 first major pump; Aug 26–28 second leg",
  },
  {
    kind: "pump",
    symbol: "SPACEHOOD",
    address: "0xfe7e19cbce2f896c6c528bc355baf5a768291e18",
    poolId: "0x225cc98f7d66b29fef96377becc7bf89582e2ab7b923a09aee9719fd80eb94ca",
    quoteSymbol: "SPCX",
    launchAt: "2026-07-14T00:00:00.000Z",
    ohlcvStart: "2026-07-10",
    notes: "Aug 28 volume acceleration",
  },
];

/** Long.xyz tokens that did NOT pump — must stay below alert. */
export const CONTROL_FIXTURES: TokenBacktestFixture[] = [
  {
    kind: "control",
    symbol: "QQQ-Quack",
    address: "0x64D0E0f3dD5CE1B29105947592a0B50044881e18",
    poolId: "0x5086ed9997ce80011771a01bf1cfb4f283fc095c53abe1c5b5cf9dc8c5196ef5",
    quoteSymbol: "QQQ",
    launchAt: "2026-08-07T01:11:41.000Z",
    ohlcvStart: "2026-08-01",
    notes: "Low volume meme, no squeeze",
  },
  {
    kind: "control",
    symbol: "META-ThisIs",
    address: "0xB1e43259602984AA81B8554FA77425eBEcb31E18",
    poolId: "0xedca18834082bd3c6b6b37aa8437361e05272fa0863c5fe3956f3d11f06a7868",
    quoteSymbol: "META",
    launchAt: "2026-09-01T02:47:18.000Z",
    ohlcvStart: "2026-08-25",
    notes: "Flat launch, minimal volume",
  },
  {
    kind: "control",
    symbol: "TSLA-pair",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    poolId: "0x442d52ecd9f7c69e50ba817c723d1b49a8fd3fd34815b8bfd447f040323633e9",
    quoteSymbol: "SPCX",
    launchAt: "2026-08-04T15:21:31.000Z",
    ohlcvStart: "2026-08-01",
    notes: "Stock wrapper pair, no meme pump",
  },
];

/**
 * Multi-chain fixtures, classified 2026-09-02 by replaying real OHLCV
 * through the engine (not hand-labeled): pumps alerted before their peak,
 * controls never alerted. Fixed ohlcvStart keeps results stable over time.
 */
export const MULTICHAIN_FIXTURES: TokenBacktestFixture[] = [
  {
    kind: "pump",
    symbol: "MIGGLES",
    address: "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d",
    poolId: "0x17a3ad8c74c4947005afeda9965305ae2eb2518a",
    network: "base",
    quoteSymbol: "WETH",
    launchAt: "2024-07-16T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "2.7x run into Jul 17 peak; first alert May 28",
  },
  {
    kind: "pump",
    symbol: "FARTCOIN",
    address: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",
    poolId: "Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw",
    network: "solana",
    quoteSymbol: "SOL",
    launchAt: "2024-10-01T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "SOL: ~12x volume breakout into Aug 22 peak; first alert Jun 15",
  },
  {
    kind: "pump",
    symbol: "POPCAT",
    address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    poolId: "FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxRF2x9RwLLMo",
    network: "solana",
    quoteSymbol: "SOL",
    launchAt: "2024-01-01T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "SOL: ~21x volume spike into Jun 24 peak; first alert Jun 1",
  },
  {
    kind: "control",
    symbol: "SILLY",
    address: "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs",
    poolId: "DsD69qYsFvMX4cBvHbssGneB2aYwECkL3ehYjQ6NH6aq",
    network: "solana",
    quoteSymbol: "SOL",
    launchAt: "2023-12-05T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "Aged SOL meme, quiet volume",
  },
  {
    kind: "pump",
    symbol: "AKE",
    address: "0x2c3a8ee94ddd97244a93bc48298f97d2c412f7db",
    poolId: "0x4d3bf29ba30f8bfe4624e7678709afa195689c5d",
    network: "bsc",
    quoteSymbol: "WBNB",
    launchAt: "2026-06-01T00:00:00.000Z",
    ohlcvStart: "2026-06-05",
    notes: "BSC: ~87x run into Jul 18 peak ($69M peak vol); first alert Jun 14",
  },
  {
    kind: "control",
    symbol: "CAT",
    address: "0x59F4F336Bf3D0C49dBfbA4A74eBD2a6aCE40539A",
    poolId: "0x63230caefc0f8220536db18136b83b5098b5acbc",
    network: "bsc",
    quoteSymbol: "WBNB",
    launchAt: "2023-06-07T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "Aged BSC meme, no breakout",
  },
  {
    kind: "control",
    symbol: "BRETT",
    address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
    poolId: "0xba3f945812a83471d709bce9c3ca699a19fb46f7",
    network: "base",
    quoteSymbol: "WETH",
    launchAt: "2024-02-27T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "Established Base meme, rangebound in window",
  },
  {
    kind: "control",
    symbol: "TURBO",
    address: "0xA35923162C49cF95e6BF26623385eb431ad920D3",
    poolId: "0x7baece5d47f1bc5e1953fbe0e9931d54dab6d810",
    network: "ethereum",
    quoteSymbol: "WETH",
    launchAt: "2023-05-01T00:00:00.000Z",
    ohlcvStart: "2026-05-15",
    notes: "Established ETH meme, rangebound in window",
  },
];

export const ALL_FIXTURES = [
  ...PUMP_FIXTURES,
  ...CONTROL_FIXTURES,
  ...MULTICHAIN_FIXTURES,
];
