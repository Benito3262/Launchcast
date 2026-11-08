import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { CHAIN_ID, DEFAULT_RPC, FACTORIES } from "./config.js";

const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
const confirmations = Math.max(1, Number(process.env.CONFIRMATIONS || 32));
const initialChunk = Math.max(1_000, Number(process.env.LOG_CHUNK_BLOCKS || 25_000));
const recentWindow = BigInt(process.env.RECENT_WINDOW_BLOCKS || 100_000);
const requestFullHistory = process.argv.includes("--full-history");
const latestPerFactory = Math.max(1, Number(process.env.LATEST_PER_FACTORY || 12));
const cachePath = resolve(process.cwd(), "data/checkpoint.json");
const outputPath = resolve(process.cwd(), "../../web/public/data/vibevibe-tokens.json");
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }) });

const launchedEvent = parseAbiItem("event TokenLaunched(uint256 indexed launchId,address indexed token,address indexed curve,address creator,address creatorFeeRecipient,address creatorVault,uint256 initialBuy,uint256 initialTokensBought,uint16 metadataSchemaVersion,bytes32 metadataDigest,string metadataURI)");
const launchedQuotedEvent = parseAbiItem("event TokenLaunchedQuoted(uint256 indexed launchId,address indexed token,address indexed curve,address creator,address creatorFeeRecipient,address creatorVault,address quoteCurrency,uint256 initialBuy,uint256 initialTokensBought,uint16 metadataSchemaVersion,bytes32 metadataDigest,string metadataURI)");
const factoryReads = parseAbi(["function launchCount() view returns (uint256)", "function curveAt(uint256 launchId) view returns (address)"]);
const tokenReads = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfersUnlocked() view returns (bool)",
  "function curve() view returns (address)",
]);
const curveReads = parseAbi([
  "function graduated() view returns (bool)",
  "function complete() view returns (bool)",
  "function token() view returns (address)",
  "function launchTimestamp() view returns (uint256)",
]);

type Launch = {
  chainId:number; generation:string; factory:Address; launchId:string; token:Address; curve:Address;
  creator:Address; creatorFeeRecipient:Address; creatorVault:Address; quoteCurrency:Address|null;
  initialBuy:string; initialTokensBought:string; metadataSchemaVersion:number; metadataDigest:string;
  metadataURI:string; blockNumber:number; blockHash:string; transactionHash:string; logIndex:number;
};
type Snapshot = { chainId:number; updatedAt:string; scannedThrough:number; checkpointHash:string; fullHistoryCompleted?:boolean; launches:Launch[] };
type RegistryToken = {
  chainId:number; generation:string; factory:Address; launchId:string; token:Address; curve:Address;
  creator:Address|null; creatorFeeRecipient:Address|null; creatorVault:Address|null; quoteCurrency:Address|null;
  initialBuy:string|null; initialTokensBought:string|null; metadataSchemaVersion:number|null; metadataDigest:string|null;
  metadataURI:string|null; blockNumber:number|null; blockHash:string|null; transactionHash:string|null; logIndex:number|null;
  launchTimestamp:string|null; name:string|null; symbol:string|null; decimals:number|null; transfersUnlocked:boolean|null;
  graduated:boolean|null; complete:boolean|null; stateReadAtBlock:string;
};
function safeNumber(value:bigint|null|undefined):number {
  if(value===null||value===undefined||value>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe block number returned by RPC.");
  return Number(value);
}
function rangeError(error:unknown):boolean {
  const s=error instanceof Error?error.message.toLowerCase():String(error).toLowerCase();
  return ["timeout","timed out","too many","exceeds limit","limit exceeded","range too large","maximum block range","more than 10000","response size","response body exceeded","query returned"].some(x=>s.includes(x));
}
async function readSnapshot():Promise<Snapshot> {
  try { return JSON.parse(await readFile(cachePath,"utf8")) as Snapshot; }
  catch {
    return {chainId:CHAIN_ID,updatedAt:new Date(0).toISOString(),scannedThrough:0,checkpointHash:"",launches:[]};
  }
}
async function scanRange(from:bigint,to:bigint,chunk:bigint,found:Launch[]):Promise<void> {
  if(from>to)return;
  const end=from+chunk-1n>to?to:from+chunk-1n;
  try {
    const [plain,quoted]=await Promise.all([
      client.getLogs({address:FACTORIES.map(f=>f.address),event:launchedEvent,fromBlock:from,toBlock:end}),
      client.getLogs({address:FACTORIES.map(f=>f.address),event:launchedQuotedEvent,fromBlock:from,toBlock:end}),
    ]);
    for(const log of plain){
      if(!log.args.token||!log.args.curve||!log.args.creator||!log.args.creatorFeeRecipient||!log.args.creatorVault||!log.args.metadataDigest||log.args.metadataURI===undefined||log.blockNumber===null||!log.blockHash||!log.transactionHash||log.logIndex===null)continue;
      const factory=FACTORIES.find(f=>f.address.toLowerCase()===log.address.toLowerCase());if(!factory)continue;
      found.push({chainId:CHAIN_ID,generation:factory.generation,factory:factory.address,launchId:String(log.args.launchId),token:log.args.token,curve:log.args.curve,creator:log.args.creator,creatorFeeRecipient:log.args.creatorFeeRecipient,creatorVault:log.args.creatorVault,quoteCurrency:null,initialBuy:String(log.args.initialBuy),initialTokensBought:String(log.args.initialTokensBought),metadataSchemaVersion:Number(log.args.metadataSchemaVersion),metadataDigest:log.args.metadataDigest,metadataURI:log.args.metadataURI,blockNumber:safeNumber(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,logIndex:log.logIndex});
    }
    for(const log of quoted){
      if(!log.args.token||!log.args.curve||!log.args.creator||!log.args.creatorFeeRecipient||!log.args.creatorVault||!log.args.quoteCurrency||!log.args.metadataDigest||log.args.metadataURI===undefined||log.blockNumber===null||!log.blockHash||!log.transactionHash||log.logIndex===null)continue;
      const factory=FACTORIES.find(f=>f.address.toLowerCase()===log.address.toLowerCase());if(!factory)continue;
      found.push({chainId:CHAIN_ID,generation:factory.generation,factory:factory.address,launchId:String(log.args.launchId),token:log.args.token,curve:log.args.curve,creator:log.args.creator,creatorFeeRecipient:log.args.creatorFeeRecipient,creatorVault:log.args.creatorVault,quoteCurrency:log.args.quoteCurrency,initialBuy:String(log.args.initialBuy),initialTokensBought:String(log.args.initialTokensBought),metadataSchemaVersion:Number(log.args.metadataSchemaVersion),metadataDigest:log.args.metadataDigest,metadataURI:log.args.metadataURI,blockNumber:safeNumber(log.blockNumber),blockHash:log.blockHash,transactionHash:log.transactionHash,logIndex:log.logIndex});
    }
    const nextChunk=chunk<BigInt(initialChunk)?(chunk*2n>BigInt(initialChunk)?BigInt(initialChunk):chunk*2n):chunk;
    await scanRange(end+1n,to,nextChunk,found);
  } catch(error) {
    if(!rangeError(error)||chunk<=1_000n)throw error;
    const half=chunk/2n;
    await scanRange(from,end,half,found);
    await scanRange(end+1n,to,half,found);
  }
}
async function main(){
  const network=await client.getChainId();
  if(network!==CHAIN_ID)throw new Error("Wrong network: expected Robinhood Chain Testnet (46630), received "+network+".");
  const head=await client.getBlockNumber();
  const safeHead=head>BigInt(confirmations)?head-BigInt(confirmations):0n;
  const snapshot=await readSnapshot();
  const earliest=BigInt(Math.min(...FACTORIES.map(f=>f.deploymentBlock)));
  const isFirstRun=snapshot.updatedAt===new Date(0).toISOString();
  const fullHistory=requestFullHistory && snapshot.fullHistoryCompleted !== true;
  const from=fullHistory?earliest:isFirstRun?(safeHead>recentWindow?safeHead-recentWindow:earliest):BigInt(Math.max(Number(earliest),snapshot.scannedThrough-63));
  const factoryChecks:Array<{generation:string;address:Address;bytecodePresent:boolean;onChainLaunchCount:string;deploymentBlock:string;observedLaunchEvents:number|null;launchCountMatchesEventCount:boolean|null;eventAuditStatus:string|null}>=[];
  for(const factory of FACTORIES){
    const code=await client.getCode({address:factory.address});
    if(!code||code==="0x")throw new Error("No bytecode found at configured factory "+factory.address+". Re-check the registry before indexing.");
    const launchCount=await client.readContract({address:factory.address,abi:factoryReads,functionName:"launchCount",blockNumber:safeHead});
    factoryChecks.push({generation:factory.generation,address:factory.address,bytecodePresent:true,onChainLaunchCount:launchCount.toString(),deploymentBlock:factory.deploymentBlock.toString(),observedLaunchEvents:null as number|null,launchCountMatchesEventCount:null as boolean|null,eventAuditStatus:null as string|null});
  }
  const retained=snapshot.launches.filter(item=>item.blockNumber<Number(from));
  const discovered:Launch[]=[];
  if(from<=safeHead)await scanRange(from,safeHead,BigInt(initialChunk),discovered);
  const unique=new Map<string,Launch>();
  for(const item of [...retained,...discovered])unique.set(item.transactionHash+":"+item.logIndex,item);
  const launches=[...unique.values()].sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex);
  for(const check of factoryChecks){
    const observed=launches.filter(item=>item.factory.toLowerCase()===check.address.toLowerCase()).length;
    check.observedLaunchEvents=observed;
    check.launchCountMatchesEventCount=fullHistory?BigInt(check.onChainLaunchCount)===BigInt(observed):null;
  }
  if(fullHistory){
    for(const factory of factoryChecks){
      const expected=BigInt(factory.onChainLaunchCount);
      const observed=BigInt(factory.observedLaunchEvents ?? 0);
      factory.launchCountMatchesEventCount=observed===expected;
      factory.eventAuditStatus=observed===expected?"passed":"event_count_mismatch";
      if(observed!==expected)console.warn("Factory event audit mismatch for",factory.generation,": decoded",observed.toString(),"launch events; launchCount() reports",expected.toString(),". CurveAt discovery remains available, but event metadata coverage is incomplete.");
    }
  }
  const checkpoint=safeHead>0n?await client.getBlock({blockNumber:safeHead}):null;
  const cache:Snapshot={chainId:CHAIN_ID,updatedAt:new Date().toISOString(),scannedThrough:safeNumber(safeHead),checkpointHash:checkpoint?.hash||"",fullHistoryCompleted:snapshot.fullHistoryCompleted===true||fullHistory,launches};
  await mkdir(dirname(cachePath),{recursive:true});
  await writeFile(cachePath,JSON.stringify(cache,null,2)+"\n","utf8");

  const tokenRecords=new Map<string,RegistryToken>();
  const eventByToken=new Map(launches.map(item=>[item.token.toLowerCase(),item]));
  for(const factory of factoryChecks){
    const count=BigInt(factory.onChainLaunchCount);
    const first=count>BigInt(latestPerFactory)?count-BigInt(latestPerFactory):0n;
    for(let launchId=first;launchId<count;launchId++){
      try{
        const curve=await client.readContract({address:factory.address,abi:factoryReads,functionName:"curveAt",args:[launchId],blockNumber:safeHead});
        if(curve.toLowerCase()==="0x0000000000000000000000000000000000000000")continue;
        const [token,launchTimestamp]=await Promise.all([
          client.readContract({address:curve,abi:curveReads,functionName:"token",blockNumber:safeHead}),
          client.readContract({address:curve,abi:curveReads,functionName:"launchTimestamp",blockNumber:safeHead}).catch(()=>null),
        ]);
        if(token.toLowerCase()==="0x0000000000000000000000000000000000000000")continue;
        const tokenCurve=await client.readContract({address:token,abi:tokenReads,functionName:"curve",blockNumber:safeHead}).catch(()=>null);
        if(!tokenCurve||tokenCurve.toLowerCase()!==curve.toLowerCase()){
          console.warn("Skipped mismatched factory/curve/token linkage:",factory.generation,launchId.toString());
          continue;
        }
        const [name,symbol,decimals,transfersUnlocked,graduated,complete]=await Promise.all([
          client.readContract({address:token,abi:tokenReads,functionName:"name",blockNumber:safeHead}).catch(()=>null),
          client.readContract({address:token,abi:tokenReads,functionName:"symbol",blockNumber:safeHead}).catch(()=>null),
          client.readContract({address:token,abi:tokenReads,functionName:"decimals",blockNumber:safeHead}).catch(()=>null),
          client.readContract({address:token,abi:tokenReads,functionName:"transfersUnlocked",blockNumber:safeHead}).catch(()=>null),
          client.readContract({address:curve,abi:curveReads,functionName:"graduated",blockNumber:safeHead}).catch(()=>null),
          client.readContract({address:curve,abi:curveReads,functionName:"complete",blockNumber:safeHead}).catch(()=>null),
        ]);
        const event=eventByToken.get(token.toLowerCase());
        tokenRecords.set(token.toLowerCase(),{
          chainId:CHAIN_ID,generation:factory.generation,factory:factory.address,launchId:launchId.toString(),
          token,curve,creator:event?.creator??null,creatorFeeRecipient:event?.creatorFeeRecipient??null,
          creatorVault:event?.creatorVault??null,quoteCurrency:event?.quoteCurrency??null,
          initialBuy:event?.initialBuy??null,initialTokensBought:event?.initialTokensBought??null,
          metadataSchemaVersion:event?.metadataSchemaVersion??null,metadataDigest:event?.metadataDigest??null,
          metadataURI:event?.metadataURI??null,blockNumber:event?.blockNumber??null,blockHash:event?.blockHash??null,
          transactionHash:event?.transactionHash??null,logIndex:event?.logIndex??null,
          launchTimestamp:launchTimestamp===null?null:launchTimestamp.toString(),
          name,symbol,decimals:decimals===null?null:Number(decimals),transfersUnlocked,graduated,complete,
          stateReadAtBlock:safeHead.toString(),
        });
      }catch(error){
        console.warn("Could not inspect latest launch",factory.generation,launchId.toString(),String(error));
      }
      await new Promise(resolve=>setTimeout(resolve,75));
    }
  }
  const tokens=[...tokenRecords.values()].sort((a,b)=>{
    if(a.launchTimestamp&&b.launchTimestamp)return Number(BigInt(b.launchTimestamp)-BigInt(a.launchTimestamp));
    if(a.blockNumber!==null&&b.blockNumber!==null)return b.blockNumber-a.blockNumber;
    return 0;
  });
  const registry={
    schemaVersion:1,chainId:CHAIN_ID,source:"Robinhood Chain Testnet factory curveAt reads cross-checked against token/curve getters and launch event logs",
    generatedAt:new Date().toISOString(),headBlock:head.toString(),safeHeadBlock:safeHead.toString(),
    coverage:fullHistory?"configured_factories_full_history":isFirstRun?"configured_factories_recent_window_plus_latest_launches":"configured_factories_incremental_plus_latest_launches",
    warning:"Only three configured factory generations are scanned; unknown/new factories may be missing. Current token/curve getter reads are snapshots at stateReadAtBlock, not historical facts. This file is discovery data only and is never settlement authority.",
    factories:factoryChecks,totalTokens:tokens.length,totalLaunches:factoryChecks.reduce((sum,item)=>sum+Number(item.onChainLaunchCount),0),tokens,
  };
  await mkdir(dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(registry,null,2)+"\n","utf8");
  const counts=Object.fromEntries(FACTORIES.map(f=>[f.generation,launches.filter(x=>x.generation===f.generation).length]));
  console.log(JSON.stringify({chainId:CHAIN_ID,head:safeNumber(head),safeHead:safeNumber(safeHead),from:safeNumber(from),launchEventsInWindow:launches.length,latestTokens:tokens.length,totalFactoryLaunches:registry.totalLaunches,factoryLaunchCounts:factoryChecks.map(item=>({generation:item.generation,count:item.onChainLaunchCount})),byGeneration:counts,factoryChecks,output:outputPath,coverage:registry.coverage},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
