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
    squeezeWindow: {
      warmupStart: "2026-08-27T00:00:00Z",
      start: "2026-08-28T00:00:00Z",
      end: "2026-08-30T00:00:00Z",
    },
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
    squeezeWindow: {
      warmupStart: "2026-07-20T00:00:00Z",
      start: "2026-07-21T00:00:00Z",
      end: "2026-07-24T00:00:00Z",
    },
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
    squeezeWindow: {
      warmupStart: "2026-08-27T00:00:00Z",
      start: "2026-08-28T00:00:00Z",
      end: "2026-08-30T00:00:00Z",
    },
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

export const ALL_FIXTURES = [...PUMP_FIXTURES, ...CONTROL_FIXTURES];
