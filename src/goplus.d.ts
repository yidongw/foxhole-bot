// @goplus/sdk-node ships a declaration file its package.json "exports" does
// not expose (and it only types GoPlus as `object` anyway). Local typing for
// the two methods we call.
declare module "@goplus/sdk-node" {
  export const GoPlus: {
    tokenSecurity(
      chainId: string,
      addresses: string[],
      timeoutSecs?: number,
    ): Promise<{ code: number; message?: string; result?: Record<string, unknown> }>;
    solanaTokenSecurity(
      addresses: string[],
      timeoutSecs?: number,
    ): Promise<{ code: number; message?: string; result?: Record<string, unknown> }>;
  };
  export const ErrorCode: Record<string, number>;
}
