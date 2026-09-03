import {
  Connection,
  PublicKey,
  type ParsedAccountData,
} from "@solana/web3.js";
import { OnlinePumpSdk, bondingCurvePda, type Global } from "@pump-fun/pump-sdk";

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
}

let connection: Connection | undefined;
export function getSolanaConnection(): Connection {
  if (!connection) connection = new Connection(getSolanaRpcUrl(), "confirmed");
  return connection;
}

const decimalsCache = new Map<string, number>();

/**
 * SPL mint decimals, cached per-mint. pump.fun mints are 6, but graduated /
 * non-pump SPL tokens are commonly 9 (or other) — assuming 6 corrupts token
 * amount accounting (position size, P&L) on any non-6-decimal mint. Falls back
 * to 6 only when the account can't be read (a wrong guess is bounded by the
 * risk caps; the fallback is logged upstream via the throw path when critical).
 */
export async function getMintDecimals(mint: string): Promise<number> {
  const cached = decimalsCache.get(mint);
  if (cached != null) return cached;
  const info = await getSolanaConnection().getParsedAccountInfo(
    new PublicKey(mint),
  );
  const data = info.value?.data;
  let decimals = 6;
  if (data && typeof data === "object" && "parsed" in data) {
    const parsed = (data as ParsedAccountData).parsed;
    const d = parsed?.info?.decimals;
    if (typeof d === "number") decimals = d;
  }
  decimalsCache.set(mint, decimals);
  return decimals;
}

let sdk: OnlinePumpSdk | undefined;
function getPumpSdk(): OnlinePumpSdk {
  if (!sdk) sdk = new OnlinePumpSdk(getSolanaConnection());
  return sdk;
}

let cachedGlobal: Global | undefined;

export interface PumpCurveState {
  isPumpToken: boolean;
  graduated?: boolean;
  /** 0..1 fraction of curve tokens sold (graduation at 1). */
  progress?: number;
}

/**
 * Fetch pump.fun bonding-curve state for a mint. Cheap: one getAccountInfo
 * (plus a cached Global fetch). Non-pump mints return isPumpToken=false.
 */
export async function getPumpCurveState(mint: string): Promise<PumpCurveState> {
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return { isPumpToken: false };
  }

  try {
    const info = await getSolanaConnection().getAccountInfo(
      bondingCurvePda(mintKey),
    );
    if (!info) return { isPumpToken: false };

    const curve = await getPumpSdk().fetchBondingCurve(mintKey);
    if (!cachedGlobal) cachedGlobal = await getPumpSdk().fetchGlobal();

    const initial = Number(cachedGlobal.initialRealTokenReserves.toString());
    const real = Number(curve.realTokenReserves.toString());
    const progress =
      initial > 0 ? Math.min(Math.max(1 - real / initial, 0), 1) : undefined;

    return { isPumpToken: true, graduated: curve.complete, progress };
  } catch (err) {
    // The SDK checks a second PDA variant internally; a plain "does not
    // exist" just means this isn't a pump token.
    if (!(err as Error).message?.includes("does not exist")) {
      console.error(`pump curve read failed ${mint}:`, (err as Error).message);
    }
    return { isPumpToken: false };
  }
}
