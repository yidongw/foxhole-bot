import { describe, expect, it } from "vitest";

import {
  addFourmemeProbation,
  decodeTokenCreate,
  fourmemeCurveProgress,
  nearGradFourmemeCandidates,
  FOURMEME_NEAR_GRAD_MIN_VOLUME_USD,
  FOURMEME_NEAR_GRAD_MAX_CANDIDATES,
  type FourmemeLaunch,
  type FourmemeWatchEntry,
} from "../src/chains/bsc/fourmeme.js";

/** Real TokenCreate log captured from BSC block 119483869. */
const CREATE_LOG = {
  data: ("0x000000000000000000000000fd6a82b417e0ced80d5086830a37f6374e27ec4a" +
    "0000000000000000000000002f0a0f50c71a605704fb729d5fd448789284ffff" +
    "00000000000000000000000000000000000000000000000000000000061c9fd6" +
    "0000000000000000000000000000000000000000000000000000000000000100" +
    "0000000000000000000000000000000000000000000000000000000000000140" +
    "0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000009" +
    "5055535359425554540000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000009" +
    "5055535359425554540000000000000000000000000000000000000000000000") as `0x${string}`,
  topics: ["0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20"],
  blockNumber: 119483869n,
  transactionHash:
    "0x5c0196eda275b5df822578fee5c7bff84ffdbae2c349cbd1c79efc420af89edc" as `0x${string}`,
};

describe("decodeTokenCreate", () => {
  it("decodes a real Four.meme TokenCreate event", () => {
    const launch = decodeTokenCreate(CREATE_LOG);
    expect(launch.creator).toBe("0xfd6a82b417e0ced80D5086830a37F6374e27Ec4a");
    expect(launch.token).toBe("0x2f0A0f50C71A605704FB729d5Fd448789284FfFF");
    expect(launch.name).toBe("PUSSYBUTT");
    expect(launch.symbol).toBe("PUSSYBUTT");
    expect(launch.totalSupply).toBe(10n ** 27n); // 1B tokens × 1e18
    expect(launch.blockNumber).toBe(119483869n);
  });
});

function launch(token: string, symbol: string): FourmemeLaunch {
  return {
    creator: "0x0000000000000000000000000000000000000001",
    token: token as `0x${string}`,
    name: symbol,
    symbol,
    totalSupply: 10n ** 27n,
    blockNumber: 1n,
    txHash: "0x0" as `0x${string}`,
  };
}

describe("addFourmemeProbation", () => {
  it("adds new mints as unverified probation entries", async () => {
    const entries: FourmemeWatchEntry[] = [];
    const added = await addFourmemeProbation(
      [
        launch("0x1111111111111111111111111111111111111111", "AAA"),
        launch("0x2222222222222222222222222222222222222222", "BBB"),
      ],
      entries,
    );
    expect(added).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0].verified).toBe(false);
    expect(entries[0].symbol).toBe("AAA");
  });

  it("dedupes against existing entries case-insensitively", async () => {
    const entries: FourmemeWatchEntry[] = [
      {
        address: "0x1111111111111111111111111111111111111111",
        firstSeen: new Date().toISOString(),
        verified: true,
        attempts: 0,
      },
    ];
    const added = await addFourmemeProbation(
      [
        launch("0X1111111111111111111111111111111111111111", "AAA"),
        launch("0x3333333333333333333333333333333333333333", "CCC"),
      ],
      entries,
    );
    expect(added).toBe(1);
    expect(entries).toHaveLength(2);
  });
});

describe("fourmemeCurveProgress", () => {
  it("is BNB raised over the graduation target", () => {
    // real on-chain sample: funds 0.49 BNB of an 18 BNB target ≈ 2.7%
    expect(fourmemeCurveProgress(490196078431372545n, 18n * 10n ** 18n)).toBeCloseTo(
      0.0272,
      3,
    );
  });

  it("returns undefined when the target is unknown (non-four.meme)", () => {
    expect(fourmemeCurveProgress(0n, 0n)).toBeUndefined();
  });

  it("clamps to 1 at/after graduation", () => {
    expect(fourmemeCurveProgress(20n, 18n)).toBe(1);
  });
});

describe("nearGradFourmemeCandidates", () => {
  const entry = (
    address: string,
    verified: boolean,
    lastVol24hUsd?: number,
  ): FourmemeWatchEntry => ({
    address,
    firstSeen: new Date().toISOString(),
    verified,
    attempts: 0,
    lastVol24hUsd,
  });

  it("picks only unverified (on-curve) tokens with real pre-grad volume", () => {
    const min = FOURMEME_NEAR_GRAD_MIN_VOLUME_USD;
    const picked = nearGradFourmemeCandidates([
      entry("0xVerified", true, min * 10), // graduated → excluded
      entry("0xQuiet", false, min - 1), // below threshold → excluded
      entry("0xHot", false, min + 1), // qualifies
      entry("0xNoVol", false, undefined), // no volume seen → excluded
    ]);
    expect(picked.map((e) => e.address)).toEqual(["0xHot"]);
  });

  it("ranks by volume and caps at the max", () => {
    const min = FOURMEME_NEAR_GRAD_MIN_VOLUME_USD;
    const many = Array.from({ length: FOURMEME_NEAR_GRAD_MAX_CANDIDATES + 3 }, (_, i) =>
      entry(`0x${i}`, false, min + i),
    );
    const picked = nearGradFourmemeCandidates(many);
    expect(picked).toHaveLength(FOURMEME_NEAR_GRAD_MAX_CANDIDATES);
    // highest volume first
    expect(picked[0].lastVol24hUsd).toBeGreaterThan(picked[1].lastVol24hUsd!);
  });
});
