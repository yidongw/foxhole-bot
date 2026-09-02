import { describe, expect, it } from "vitest";
import type { Log } from "viem";

import { decodeCreatedLog } from "../src/long/factory-watcher.js";
import { LONG_CREATED_TOPIC0 } from "../src/long/constants.js";

/** Real BONER creation log captured from Robinhood Chain mainnet block 41726520. */
const BONER_LOG = {
  topics: [
    LONG_CREATED_TOPIC0,
    "0x00000000000000000000000098096d17e191b3da1d5f99a6d7b3584351b11e18",
    "0x00000000000000000000000098096d17e191b3da1d5f99a6d7b3584351b11e18",
    "0x000000000000000000000000ccee82fe024c36fa15e1005ede3e9e4787e23d09",
  ],
  data: ("0x0000000000000000000000004e3468951d49f2eea976ed0d6e75ffcb44a9a544" +
    "00000000000000000000000079aeae6a47ff2e551f60bd87dbd6358efeaf4dc8" +
    "d321da7ae027786dedf71065fafc43e44a817d7bc73cd61793fee648c084d077" +
    "000000000000000000000000000000000000000000000000000000006aa649e2" +
    "000000000000000000000000000000000000000000000000000000006aa79b62" +
    "00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "424f4e4552000000000000000000000000000000000000000000000000000000") as `0x${string}`,
  blockNumber: 41726520n,
  transactionHash:
    "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`,
} as unknown as Log;

describe("decodeCreatedLog", () => {
  it("decodes the real BONER creation event", () => {
    const launch = decodeCreatedLog(BONER_LOG);
    expect(launch.token).toBe("0x98096d17e191B3dA1d5f99a6D7b3584351b11E18");
    expect(launch.pairToken).toBe("0xCceE82fE024c36fA15E1005edE3E9e4787e23D09"); // HIMS
    expect(launch.symbol).toBe("BONER");
    expect(launch.auctionPoolId).toBe(
      "0xd321da7ae027786dedf71065fafc43e44a817d7bc73cd61793fee648c084d077",
    );
    expect(launch.epochStart).toBe("2026-08-20T20:59:46.000Z");
    expect(launch.epochEnd).toBe("2026-08-21T20:59:46.000Z");
    expect(launch.blockNumber).toBe(41726520n);
  });

  it("throws on logs missing indexed topics", () => {
    const bad = { ...BONER_LOG, topics: [LONG_CREATED_TOPIC0] } as unknown as Log;
    expect(() => decodeCreatedLog(bad)).toThrow(/missing topics/);
  });
});
