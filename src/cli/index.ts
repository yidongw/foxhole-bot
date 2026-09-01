#!/usr/bin/env node
console.log(`foxhole-bot — Robinhood Chain / Long.xyz intelligence

Commands:
  npm run fetch:long          Refresh launch list → web/data/launches.json
  npm run analyze -- <addr>   Analyze token (lock ratio, premium, signals)
  npm run deploy              Publish https://long.foxhole.bot

Stack: TypeScript + viem + hoodchain + DexScreener
`);
