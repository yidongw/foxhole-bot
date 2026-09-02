import { createPublicClient, http, keccak256, toHex } from "viem";
const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 5, retryDelay: 2000 }) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const V2 = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const V1 = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const latest = await client.getBlockNumber();
for (const [name, addr] of [["ponsV2", V2], ["ponsV1", V1], ["memeHook", HOOK]]) {
  const topics = new Map();
  let sample;
  for (let end = latest; end > latest - 300_000n && topics.size < 10; end -= 20_000n) {
    try {
      const logs = await client.getLogs({ address: addr, fromBlock: end - 19_999n, toBlock: end });
      for (const l of logs) {
        topics.set(l.topics[0], (topics.get(l.topics[0]) ?? 0) + 1);
        if (!sample) sample = l;
      }
    } catch (e) { await sleep(3000); end += 20_000n; continue; }
    await sleep(600);
  }
  console.log(name, addr, JSON.stringify(Object.fromEntries(topics)));
  if (sample) console.log("  sample topics:", sample.topics.length, "data words:", (sample.data.length-2)/64);
}
const sigs = ["TokenLaunched(address,address,string,string)","TokenLaunched(address,address,uint256)","TokenCreated(address,address,string,string,uint256)","Launched(address,address)","TokenLaunched(address,string,string,address,uint256)"];
for (const s of sigs) console.log(keccak256(toHex(s)).slice(0,20), s);
