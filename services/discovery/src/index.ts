import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { CHAIN_ID, DEFAULT_RPC, FACTORIES } from "./config.js";

const rpcUrl = process.env.RPC_URL || DEFAULT_RPC;
const confirmations = Math.max(1, Number(process.env.CONFIRMATIONS || 12));
const initialChunk = Math.max(2_000, Number(process.env.LOG_CHUNK_BLOCKS || 20_000));
const outputPath = resolve(process.cwd(), "data/launches.json");
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) });
const launchedEvent = parseAbiItem("event TokenLaunched(uint256 indexed launchId,address indexed token,address indexed curve,address creator,address creatorFeeRecipient,address creatorVault,uint256 initialBuy,uint256 initialTokensBought,uint16 metadataSchemaVersion,bytes32 metadataDigest,string metadataURI)");
const launchedQuotedEvent = parseAbiItem("event TokenLaunchedQuoted(uint256 indexed launchId,address indexed token,address indexed curve,address creator,address creatorFeeRecipient,address creatorVault,address quoteCurrency,uint256 initialBuy,uint256 initialTokensBought,uint16 metadataSchemaVersion,bytes32 metadataDigest,string metadataURI)");

type Launch = { chainId:number; generation:string; factory:Address; launchId:string; token:Address; curve:Address; creator:Address; creatorFeeRecipient:Address; creatorVault:Address; quoteCurrency:Address|null; initialBuy:string; initialTokensBought:string; metadataSchemaVersion:number; metadataDigest:string; metadataURI:string; blockNumber:number; blockHash:string; transactionHash:string; logIndex:number };
type Snapshot = { chainId:number; updatedAt:string; scannedThrough:number; checkpointHash:string; launches:Launch[] };
function safeNumber(value:bigint|null|undefined):number { if(value===null||value===undefined||value>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe block number returned by RPC."); return Number(value); }
function rangeError(error:unknown):boolean { const s=error instanceof Error?error.message.toLowerCase():String(error).toLowerCase(); return ["timeout","timed out","exceeds limit","more than 10000","response size","query returned"].some(x=>s.includes(x)); }
async function readSnapshot():Promise<Snapshot> {
 try { return JSON.parse(await readFile(outputPath,"utf8")) as Snapshot; }
 catch { return {chainId:CHAIN_ID,updatedAt:new Date(0).toISOString(),scannedThrough:Math.min(...FACTORIES.map(f=>f.deploymentBlock))-1,checkpointHash:"",launches:[]}; }
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
  const nextChunk=chunk < BigInt(initialChunk)?(chunk*2n>BigInt(initialChunk)?BigInt(initialChunk):chunk*2n):chunk;
  await scanRange(end+1n,to,nextChunk,found);
 }catch(error){
  if(!rangeError(error)||chunk<=2_000n)throw error;
  const half=chunk/2n;await scanRange(from,end,half,found);await scanRange(end+1n,to,half,found);
 }
}
async function main(){
 const network=await client.getChainId();if(network!==CHAIN_ID)throw new Error("Wrong network: expected Robinhood Chain Testnet (46630), received "+network+".");
 const head=await client.getBlockNumber();const safeHead=head>BigInt(confirmations)?head-BigInt(confirmations):0n;
 const snapshot=await readSnapshot();const earliest=BigInt(Math.min(...FACTORIES.map(f=>f.deploymentBlock)));
 const from=snapshot.scannedThrough<Number(earliest)?earliest:BigInt(Math.max(Number(earliest),snapshot.scannedThrough-63));
 // Re-scan a 64-block overlap so shallow reorgs are reflected in the snapshot.
 const retained=snapshot.launches.filter(item=>item.blockNumber<Number(from));const discovered:Launch[]=[];
 if(from<=safeHead)await scanRange(from,safeHead,BigInt(initialChunk),discovered);
 const unique=new Map<string,Launch>();for(const item of [...retained,...discovered])unique.set(item.transactionHash+":"+item.logIndex,item);
 const launches=[...unique.values()].sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
 const checkpoint=safeHead>0n?await client.getBlock({blockNumber:safeHead}):null;
 const result:Snapshot={chainId:CHAIN_ID,updatedAt:new Date().toISOString(),scannedThrough:safeNumber(safeHead),checkpointHash:checkpoint?.hash||"",launches};
 await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,JSON.stringify(result,null,2)+"\n","utf8");
 const counts=Object.fromEntries(FACTORIES.map(f=>[f.generation,launches.filter(x=>x.generation===f.generation).length]));
 console.log(JSON.stringify({chainId:CHAIN_ID,head:safeNumber(head),safeHead:safeNumber(safeHead),launches:launches.length,byGeneration:counts,output:outputPath},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
