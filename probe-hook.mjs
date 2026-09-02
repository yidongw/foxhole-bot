import { createPublicClient, http } from "viem";
const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 6, retryDelay: 3000 }) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const latest = await client.getBlockNumber();
const topics = new Map();
const samples = new Map();
for (let end = latest; end > latest - 200_000n; end -= 20_000n) {
  let logs;
  try { logs = await client.getLogs({ address: HOOK, fromBlock: end - 19_999n, toBlock: end }); }
  catch { await sleep(4000); end += 20_000n; continue; }
  for (const l of logs) {
    topics.set(l.topics[0], (topics.get(l.topics[0]) ?? 0) + 1);
    if (!samples.has(l.topics[0])) samples.set(l.topics[0], l);
  }
  await sleep(700);
}
console.log("memeHook topic0 counts:", Object.fromEntries(topics));
for (const [t, l] of samples) {
  const words = l.data.slice(2).match(/.{64}/g) ?? [];
  const strings = [];
  for (const w of words) {
    const ascii = Buffer.from(w, "hex").toString("utf8").replace(/\0/g, "");
    if (/^[\x20-\x7e]{2,}$/.test(ascii)) strings.push(ascii);
  }
  console.log(t.slice(0,12), "topics:", l.topics.length, "words:", words.length, strings.length ? "strings: " + JSON.stringify(strings) : "");
}
