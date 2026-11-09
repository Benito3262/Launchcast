import { useCallback, useEffect, useMemo, useState } from "react";
import V2Markets from "./V2Markets";
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, getAddress, http, parseUnits, type Address, type Hex, type WalletClient } from "viem";

type Eip1193Provider = NonNullable<Window["ethereum"]>;
type WalletChoice = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193Provider };
function estimatePayout(market: Market, sideYes: boolean, stake: bigint, feeBps: number) {
 const winningPool=(sideYes?market.yesPool:market.noPool)+stake;
 const losingPool=sideYes?market.noPool:market.yesPool;
 const fee=(winningPool>0n&&losingPool>0n)?(losingPool*BigInt(feeBps))/10000n:0n;
 const payout=stake+((losingPool-fee)*stake)/winningPool;
 return {payout,profit:payout-stake,multiplier:Number(payout)/Number(stake)};
}

const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Robinhood Testnet ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://explorer.testnet.chain.robinhood.com" } }, testnet: true,
});
const configuredEnvAddress = import.meta.env.VITE_LAUNCHCAST_ADDRESS || "";
const abi = [
 {type:"function",name:"owner",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
 {type:"function",name:"stakeToken",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
 {type:"function",name:"marketCount",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},
 {type:"function",name:"feeBps",stateMutability:"view",inputs:[],outputs:[{type:"uint16"}]},
 {type:"function",name:"feeRecipient",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
 {type:"function",name:"accruedFeesByRecipient",stateMutability:"view",inputs:[{name:"recipient",type:"address"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"getMarket",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"}],outputs:[{name:"market",type:"tuple",components:[{name:"curve",type:"address"},{name:"resolveAfter",type:"uint64"},{name:"yesPool",type:"uint128"},{name:"noPool",type:"uint128"},{name:"outcomeYes",type:"bool"},{name:"resolved",type:"bool"}]}]},
 {type:"function",name:"getPosition",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"},{name:"user",type:"address"}],outputs:[{name:"yesAmount",type:"uint256"},{name:"noAmount",type:"uint256"},{name:"claimed",type:"bool"}]},
 {type:"function",name:"placeBet",stateMutability:"nonpayable",inputs:[{name:"marketId",type:"uint256"},{name:"sideYes",type:"bool"},{name:"amount",type:"uint256"}],outputs:[]},
 {type:"function",name:"settleMarket",stateMutability:"nonpayable",inputs:[{name:"marketId",type:"uint256"}],outputs:[]},
 {type:"function",name:"settleMarkets",stateMutability:"nonpayable",inputs:[{name:"marketIds",type:"uint256[]"}],outputs:[]},
 {type:"function",name:"setFeeConfig",stateMutability:"nonpayable",inputs:[{name:"newFeeBps",type:"uint16"},{name:"newFeeRecipient",type:"address"}],outputs:[]},
 {type:"function",name:"withdrawFees",stateMutability:"nonpayable",inputs:[],outputs:[]},
 {type:"function",name:"claim",stateMutability:"nonpayable",inputs:[{name:"marketId",type:"uint256"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"createMarket",stateMutability:"nonpayable",inputs:[{name:"curve",type:"address"},{name:"resolveAfter",type:"uint64"}],outputs:[{type:"uint256"}]},
] as const;
const vibeCurveAbi = [
 {type:"function",name:"token",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
 {type:"function",name:"graduated",stateMutability:"view",inputs:[],outputs:[{type:"bool"}]},
] as const;
const vibeTokenAbi = [
 {type:"function",name:"curve",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
] as const;
const tokenAbi = [
 {type:"function",name:"symbol",stateMutability:"view",inputs:[],outputs:[{type:"string"}]},
 {type:"function",name:"decimals",stateMutability:"view",inputs:[],outputs:[{type:"uint8"}]},
 {type:"function",name:"balanceOf",stateMutability:"view",inputs:[{name:"account",type:"address"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"allowance",stateMutability:"view",inputs:[{name:"owner",type:"address"},{name:"spender",type:"address"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"approve",stateMutability:"nonpayable",inputs:[{name:"spender",type:"address"},{name:"amount",type:"uint256"}],outputs:[{type:"bool"}]},
 {type:"function",name:"faucet",stateMutability:"nonpayable",inputs:[],outputs:[]},
] as const;
type Market = {id:bigint;curve:Address;resolveAfter:bigint;yesPool:bigint;noPool:bigint;outcomeYes:boolean;resolved:boolean;graduated:boolean|null};
type Position = {yes:bigint;no:bigint;claimed:boolean};
type DiscoveredLaunch = {
 token:string; curve:string; generation:string; launchId:string; creator:string;
 blockNumber:number|null; launchTimestamp:string|null; name:string|null; symbol:string|null; decimals:number|null;
 graduated:boolean|null; complete:boolean|null; transfersUnlocked:boolean|null;
};
type DiscoveryFile = { generatedAt:string; headBlock?:string; safeHeadBlock?:string; totalTokens:number; totalLaunches?:number; coverage:string; warning:string; tokens:DiscoveredLaunch[] };
type V6Pricing = { status:string; method:string|null; pairSymbol:string; pairDecimals:number; pricePairPerTokenScaled1e18:string|null; fdvPairScaled1e18:string|null };
type V6Launch = { token:string; curve:string; launchId:string; name:string; symbol:string; complete:boolean; pairCurrency:string; pairSymbol:string; pairDecimals:number; pricing:V6Pricing };
type V6DiscoveryFile = { generatedAt:string; factory:string; factoryLaunchCount:string; readAtBlock:string; status:string; totalTokens:number; tokens:V6Launch[]; warning:string };
type DeploymentConfig = { chainId:number; launchcastAddress:string; launchcastV2Address?:string; stakeTokenAddress?:string; deployedAt?:string };
const rpc = import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
const publicClient = createPublicClient({chain,transport:http(rpc)});
const short = (s:string) => s ? s.slice(0,6)+"…"+s.slice(-4) : "—";
const date = (t:bigint) => new Date(Number(t)*1000).toLocaleString();
const units = (v:bigint,d:number) => Number(formatUnits(v,d)).toLocaleString(undefined,{maximumFractionDigits:2});
const scaledUnits = (value:string|null|undefined) => {
 try { return value===null||value===undefined?"—":Number(formatUnits(BigInt(value),18)).toLocaleString(undefined,{maximumSignificantDigits:8,maximumFractionDigits:6}); }
 catch { return "—"; }
};

export default function App() {
 const [address,setAddress]=useState<Address>((configuredEnvAddress || "") as Address);
 const [v2Address,setV2Address]=useState("");
 const [account,setAccount]=useState<Address>();
 const [wallet,setWallet]=useState<WalletClient>();
 const [activeProvider,setActiveProvider]=useState<Eip1193Provider>();
 const [walletChoices,setWalletChoices]=useState<WalletChoice[]>([]);
 const [walletModal,setWalletModal]=useState(false);
 const [walletLabel,setWalletLabel]=useState("");
 const [markets,setMarkets]=useState<Market[]>([]);
 const [positions,setPositions]=useState<Record<string,Position>>({});
 const [owner,setOwner]=useState<Address>();
 const [token,setToken]=useState<Address>();
 const [symbol,setSymbol]=useState("tUSD");
 const [decimals,setDecimals]=useState(6);
 const [balance,setBalance]=useState(0n);
 const [feeBps,setFeeBps]=useState(0);
 const [feeRecipient,setFeeRecipient]=useState<Address>();
 const [feeBalance,setFeeBalance]=useState(0n);
 const [newFeeBps,setNewFeeBps]=useState("0");
 const [newFeeRecipient,setNewFeeRecipient]=useState("");
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const [curve,setCurve]=useState("");
 const [deadline,setDeadline]=useState("");
 const [busy,setBusy]=useState("");
 const [notice,setNotice]=useState("");
 const [error,setError]=useState("");
 const [tab,setTab]=useState<"markets"|"portfolio"|"launches"|"home"|"admin"|"v2">("home");
 const [discovery,setDiscovery]=useState<DiscoveryFile|null>(null);
 const [v6Discovery,setV6Discovery]=useState<V6DiscoveryFile|null>(null);
 const [discoveryQuery,setDiscoveryQuery]=useState("");
 const configured=Boolean(address && /^0x[a-fA-F0-9]{40}$/.test(address));
 const isOwner=Boolean(account && owner && account.toLowerCase()===owner.toLowerCase());

 const refresh=useCallback(async()=>{
  if(!configured)return;
  try{
   const [count,admin,stake,fee,recipient]=await Promise.all([
    publicClient.readContract({address,abi,functionName:"marketCount"}),
    publicClient.readContract({address,abi,functionName:"owner"}),
    publicClient.readContract({address,abi,functionName:"stakeToken"}),
    publicClient.readContract({address,abi,functionName:"feeBps"}),
    publicClient.readContract({address,abi,functionName:"feeRecipient"}),
   ]);
   setOwner(admin);setToken(stake);setFeeBps(Number(fee));setFeeRecipient(recipient);setNewFeeBps(String(Number(fee)));setNewFeeRecipient(recipient);
   const [sym,dec]=await Promise.all([
    publicClient.readContract({address:stake,abi:tokenAbi,functionName:"symbol"}).catch(()=>"tUSD"),
    publicClient.readContract({address:stake,abi:tokenAbi,functionName:"decimals"}).catch(()=>6),
   ]);
   setSymbol(sym as string);setDecimals(Number(dec));
   const ids=Array.from({length:Number(count)},(_,i)=>BigInt(i+1));
   const rows=await Promise.all(ids.map(async id=>{
    const m=await publicClient.readContract({address,abi,functionName:"getMarket",args:[id]});
    let graduated:boolean|null=null;
    try{graduated=await publicClient.readContract({address:m.curve,abi:vibeCurveAbi,functionName:"graduated"});}catch{/* Fail closed: unknown graduation must never be presented as an open market. */}
    return {id,curve:m.curve,resolveAfter:m.resolveAfter,yesPool:m.yesPool,noPool:m.noPool,outcomeYes:m.outcomeYes,resolved:m.resolved,graduated} satisfies Market;
   }));
   setMarkets(rows.reverse());
   if(account){
    const [bal,pos]=await Promise.all([
     publicClient.readContract({address:stake,abi:tokenAbi,functionName:"balanceOf",args:[account]}),
     Promise.all(rows.map(async m=>{
      const p=await publicClient.readContract({address,abi,functionName:"getPosition",args:[m.id,account]});
      return [m.id.toString(),{yes:p[0],no:p[1],claimed:p[2]}] as const;
     })),
    ]);
    setBalance(bal);setPositions(Object.fromEntries(pos));
    const availableFees=await publicClient.readContract({address,abi,functionName:"accruedFeesByRecipient",args:[account]}).catch(()=>0n);
    setFeeBalance(availableFees);
   }else{setBalance(0n);setPositions({});setFeeBalance(0n);}
   setError("");
  }catch(e){setError(e instanceof Error?e.message:"Unable to read Launchcast contracts.");}
 },[account,configured]);

 useEffect(()=>{
  void refresh();
  // Re-check on-chain graduation and expiry so the board does not rely on a stale page load.
  const interval=window.setInterval(()=>{void refresh();},60_000);
  return()=>window.clearInterval(interval);
 },[refresh]);
 useEffect(()=>{
  let active=true;
  fetch("/data/deployment.json").then(r=>{if(!r.ok)throw new Error("No Launchcast deployment config");return r.json();})
   .then((data:DeploymentConfig)=>{
    if(active&&!/^0x[a-fA-F0-9]{40}$/.test(configuredEnvAddress)&&data.chainId===46630&&/^0x[a-fA-F0-9]{40}$/.test(data.launchcastAddress))setAddress(getAddress(data.launchcastAddress));
    if(active&&data.chainId===46630&&/^0x[a-fA-F0-9]{40}$/.test(data.launchcastV2Address||""))setV2Address(getAddress(data.launchcastV2Address!));
   }).catch(()=>{});
  return()=>{active=false;};
 },[]);
 useEffect(()=>{
  let active=true;
  fetch("/data/vibevibe-tokens.json").then(r=>{if(!r.ok)throw new Error("Discovery file not generated");return r.json();})
   .then((data:DiscoveryFile)=>{if(active)setDiscovery(data);})
   .catch(()=>{if(active)setDiscovery(null);});
  return()=>{active=false;};
 },[]);
 useEffect(()=>{
  let active=true;
  fetch("/data/vibevibe-v6-tokens.json").then(r=>{if(!r.ok)throw new Error("V6 discovery file not generated");return r.json();})
   .then((data:V6DiscoveryFile)=>{if(active)setV6Discovery(data);})
   .catch(()=>{if(active)setV6Discovery(null);});
  return()=>{active=false;};
 },[]);
 useEffect(()=>{
  const announce=(event:Event)=>{const choice=(event as CustomEvent<WalletChoice>).detail;if(!choice?.provider||!choice.info?.uuid)return;setWalletChoices(current=>current.some(item=>item.info.uuid===choice.info.uuid)?current:[...current,choice]);};
  window.addEventListener("eip6963:announceProvider",announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return()=>window.removeEventListener("eip6963:announceProvider",announce);
 },[]);
 useEffect(()=>{
  const p=activeProvider;if(!p?.on)return;
  const changed=(...args:unknown[])=>{const a=args[0] as string[]|undefined;setAccount(a?.[0]?getAddress(a[0]):undefined);if(!a?.[0]){setWallet(undefined);setWalletLabel("");}};
  p.on("accountsChanged",changed);return()=>p.removeListener?.("accountsChanged",changed);
 },[activeProvider]);

 const portfolio=useMemo(()=>markets.filter(m=>{const p=positions[m.id.toString()];return p&&(p.yes>0n||p.no>0n);}),[markets,positions]);
 const canClaimPosition=(m:Market,p:Position)=>{if(!m.resolved||p.claimed||(p.yes===0n&&p.no===0n))return false;const winningPool=m.outcomeYes?m.yesPool:m.noPool;const winningStake=m.outcomeYes?p.yes:p.no;return winningPool===0n||winningStake>0n;};
 const nowSeconds=BigInt(Math.floor(Date.now()/1000));
  // Only verified, ungraduated markets whose betting window is still open belong on the public board.
  // A failed graduation read is deliberately excluded rather than guessed to be eligible.
  const activeMarkets=markets.filter(m=>!m.resolved&&m.resolveAfter>nowSeconds&&m.graduated===false);
  const settlementQueue=markets.filter(m=>!m.resolved&&m.resolveAfter<=nowSeconds);
 const settledPositions=portfolio.filter(m=>m.resolved);
 const winsCount=settledPositions.filter(m=>{const p=positions[m.id.toString()];return (m.outcomeYes?p.yes:p.no)>0n&&(m.outcomeYes?m.yesPool:m.noPool)>0n;}).length;
 const lossesCount=settledPositions.filter(m=>{const p=positions[m.id.toString()];return (m.outcomeYes?p.no:p.yes)>0n&&(m.outcomeYes?m.yesPool:m.noPool)>0n;}).length;
 const pageMarkets=tab==="home"?activeMarkets.slice(0,3):activeMarkets;
 const launchForCurve=(curveAddress:string)=>discovery?.tokens.find(item=>item.curve.toLowerCase()===curveAddress.toLowerCase());
 const visibleLaunches=useMemo(()=>discovery?.tokens.filter(item=>[item.name,item.symbol,item.token,item.curve,item.generation,item.launchId].some(value=>value?.toLowerCase().includes(discoveryQuery.toLowerCase())))||[],[discovery,discoveryQuery]);
 const visibleV6Launches=useMemo(()=>v6Discovery?.tokens.filter(item=>[item.name,item.symbol,item.token,item.curve,item.launchId,item.pairSymbol].some(value=>value?.toLowerCase().includes(discoveryQuery.toLowerCase())))||[],[v6Discovery,discoveryQuery]);

 function connect(){
  setError("");
  const injected=window.ethereum;
  const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if(injected){
   void connectWithProvider(injected,"Browser wallet");
   return;
  }
  if(mobile){
   void connectWalletConnect();
   return;
  }
  setWalletModal(true);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
 }
 async function connectWithProvider(provider:Eip1193Provider,label:string,requestPermission=true){
  setError("");
  setBusy("Connecting wallet");
  try{
   const client=createWalletClient({chain,transport:custom(provider as never)});
   const accounts=requestPermission
    ? await client.requestAddresses()
    : await provider.request({method:"eth_accounts"}) as Address[];
   const user=accounts[0];
   if(!user)throw new Error("The wallet did not return an account. Approve the connection in your wallet and try again.");
   const currentChain=await provider.request({method:"eth_chainId"}) as string;
   if(Number.parseInt(currentChain,16)!==46630){
    try{
     await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:"0xb626"}]});
    }catch(switchError){
     const code=(switchError as {code?:number})?.code;
     if(code!==4902)throw switchError;
     await provider.request({method:"wallet_addEthereumChain",params:[{chainId:"0xb626",chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:[rpc],blockExplorerUrls:[chain.blockExplorers.default.url]}]});
     await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:"0xb626"}]});
    }
   }
   setWallet(client);setActiveProvider(provider);setAccount(user);setWalletLabel(label);setWalletModal(false);setNotice("Connected with "+label+" on Robinhood Chain Testnet.");
  }catch(e){setError(e instanceof Error?e.message:"Wallet connection failed.");}
  finally{setBusy("");}
 }
 async function connectWalletConnect(){
  const projectId=import.meta.env.VITE_REOWN_PROJECT_ID;
  if(!projectId){setError("WalletConnect is not configured. Add the Reown project ID in the deployment environment.");return;}
  setBusy("Connecting WalletConnect");
  try{
   const {default: EthereumProvider}=await import("@walletconnect/ethereum-provider");
   const provider=await EthereumProvider.init({projectId,chains:[46630],showQrModal:true,rpcMap:{46630:rpc},methods:["eth_sendTransaction","personal_sign","eth_signTypedData","eth_signTypedData_v4","eth_accounts","eth_requestAccounts","wallet_switchEthereumChain","wallet_addEthereumChain"],events:["chainChanged","accountsChanged"]});
   await provider.connect();
   // WalletConnect's connect() already asks the wallet to authorize this site.
   // Read the approved session accounts without issuing a second eth_requestAccounts prompt.
   await connectWithProvider(provider as unknown as Eip1193Provider,"WalletConnect",false);
  }catch(e){setError(e instanceof Error?e.message:"WalletConnect connection failed.");}
  finally{setBusy("");}
 }

 async function transact(label:string,action:(client:WalletClient,user:Address)=>Promise<Hex>):Promise<boolean>{
  if(!wallet||!account){setError("Connect your wallet first.");return false;}
  setBusy(label);setError("");setNotice("");
  try{
   const hash=await action(wallet,account);setNotice(label+": transaction sent. Waiting for confirmation…");
   await publicClient.waitForTransactionReceipt({hash});setNotice(label+": confirmed on Robinhood Chain Testnet.");await refresh();return true;
  }catch(e){setError(e instanceof Error?e.message:label+" failed.");return false;}
  finally{setBusy("");}
 }

 async function bet(m:Market,yes:boolean){
  if(!token)return;
  let amount:bigint;
  try{amount=parseUnits(amounts[m.id.toString()]||"",decimals);if(amount<=0n)throw new Error("Enter an amount greater than zero.");}
  catch(e){setError(e instanceof Error?e.message:"Invalid amount.");return;}
  await transact("Place "+(yes?"YES":"NO")+" bet",async(client,user)=>{
   const allowed=await publicClient.readContract({address:token,abi:tokenAbi,functionName:"allowance",args:[user,address]});
   if(allowed<amount){const approval=await client.writeContract({account:user,chain,address:token,abi:tokenAbi,functionName:"approve",args:[address,amount]});await publicClient.waitForTransactionReceipt({hash:approval});}
   return client.writeContract({account:user,chain,address,abi,functionName:"placeBet",args:[m.id,yes,amount]});
  });
 }
 async function faucet(){if(token)await transact("Request test tokens",(c,u)=>c.writeContract({account:u,chain,address:token,abi:tokenAbi,functionName:"faucet"}));}
 async function settleReadyMarkets(){
  const now=BigInt(Math.floor(Date.now()/1000));
  const ready=markets.filter(m=>!m.resolved&&m.resolveAfter<=now).map(m=>m.id).slice(0,25);
  if(!ready.length){setNotice("There are no markets ready for settlement.");return;}
  await transact("Settle "+ready.length+" ready markets",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"settleMarkets",args:[ready]}));
 }
 async function updateFees(){
  const bps=Number(newFeeBps);
  if(!Number.isInteger(bps)||bps<0||bps>1000){setError("Fee must be a whole number between 0 and 1000 basis points (0–10%).");return;}
  if(!/^0x[a-fA-F0-9]{40}$/.test(newFeeRecipient)){setError("Enter a valid fee recipient address.");return;}
  await transact("Update fee settings",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"setFeeConfig",args:[bps,getAddress(newFeeRecipient)]}));
 }
 async function create(){
  if(!/^0x[a-fA-F0-9]{40}$/.test(curve)){setError("Choose a valid VibeVibe curve from the indexed launch list.");return;}
  const launch=discovery?.tokens.find(item=>item.curve.toLowerCase()===curve.toLowerCase());
  if(!launch){setError("This curve is not in the current on-chain discovery registry. Refresh the registry before creating a market.");return;}
  const ts=Math.floor(new Date(deadline).getTime()/1000);
  if(!Number.isFinite(ts)||ts<=Date.now()/1000){setError("Choose a future resolution date and time.");return;}
  try{
   const curveAddress=getAddress(curve),tokenAddress=getAddress(launch.token);
   const [curveToken,tokenCurve,graduated]=await Promise.all([
    publicClient.readContract({address:curveAddress,abi:vibeCurveAbi,functionName:"token"}),
    publicClient.readContract({address:tokenAddress,abi:vibeTokenAbi,functionName:"curve"}),
    publicClient.readContract({address:curveAddress,abi:vibeCurveAbi,functionName:"graduated"}),
   ]);
   if(curveToken.toLowerCase()!==tokenAddress.toLowerCase()||tokenCurve.toLowerCase()!==curveAddress.toLowerCase())throw new Error("The token and curve contracts do not point to each other. Market creation blocked.");
   if(graduated)throw new Error("This curve is already graduated. Choose an ungraduated VibeVibe launch.");
  }catch(e){setError(e instanceof Error?e.message:"Could not verify this VibeVibe curve on-chain.");return;}
  const created=await transact("Create market",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"createMarket",args:[getAddress(curve),BigInt(ts)]}));
  if(created){setCurve("");setDeadline("");}
 }

 return <div className="app-shell">
  <header className="topbar"><a className="brand" href="#" onClick={e=>{e.preventDefault();setTab("home");}}><img className="brand-mark" src="/launchcast-mark.svg" alt="" /><span>launchcast<span className="brand-dot">.</span><small>BUILT FOR THE VIBEVIBE ECOSYSTEM</small></span></a><nav className="main-nav" aria-label="Main navigation"><button className={tab==="home"?"active":""} onClick={()=>setTab("home")}>Home</button><button className={tab==="markets"?"active":""} onClick={()=>setTab("markets")}>Markets <span>{activeMarkets.length}</span></button><button className={tab==="v2"?"active":""} onClick={()=>setTab("v2")}>V2 Markets</button><button className={tab==="launches"?"active":""} onClick={()=>setTab("launches")}>Launches</button><button className={tab==="portfolio"?"active":""} onClick={()=>setTab("portfolio")}>Portfolio</button>{isOwner&&<button className={tab==="admin"?"active":""} onClick={()=>setTab("admin")}>Admin</button>}</nav><div className="top-actions"><span className="network-pill"><i/> Robinhood Testnet</span><button className="wallet-button" onClick={connect} title={walletLabel || "Connect wallet"}>{account?short(account):"Connect wallet"}</button></div></header>
  <main>
   {tab==="home"&&<section className="hero"><div className="hero-copy"><div className="eyebrow"><span className="pulse"/> LIVE ON ROBINHOOD TESTNET <span className="hero-tag">VIBE / VIBE LAUNCHES</span></div><h1>Every launch has a moment.<br/><em>Call it before it happens.</em></h1><p>Pick a side on VibeVibe token graduations. Follow the pools, back your read and verify every outcome on-chain.</p><div className="hero-cta"><a href="#markets" className="hero-link">Explore markets <span>↘</span></a><span className="hero-note">No real funds · Testnet only</span></div><div className="hero-stats"><div><strong>{activeMarkets.length.toString().padStart(2,"0")}</strong><span>Markets live</span></div><div><strong>{portfolio.length.toString().padStart(2,"0")}</strong><span>Your positions</span></div><div><strong>{symbol}</strong><span>Test currency</span></div></div></div><div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><div className="art-core"><span className="art-spark">✳</span><b>VIBE</b><small>CALL THE CURVE</small></div><div className="float-chip chip-top">YES <b>↑</b></div><div className="float-chip chip-bottom">NO <b>↓</b></div><div className="art-caption">THE NEXT MOVE<br/><strong>IS YOUR CALL.</strong></div></div></section>}
   {!configured&&<div className="notice warning"><strong>Contracts not connected yet.</strong> The public deployment config has not loaded. Refresh the page or check the deployment record before connecting a wallet.</div>}
   {notice&&<div className="notice success">{notice}</div>}{error&&<div className="notice danger">{error}<button className="dismiss" onClick={()=>setError("")}>Dismiss</button></div>}
   {walletModal&&<div className="wallet-modal-backdrop" onClick={()=>setWalletModal(false)}><section className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title" onClick={e=>e.stopPropagation()}><button className="wallet-modal-close" onClick={()=>setWalletModal(false)} aria-label="Close wallet selector">×</button><span className="eyebrow">CONNECT A WALLET</span><h2 id="wallet-modal-title">Choose your wallet</h2><p>Connect an EVM wallet to Robinhood Chain Testnet. Your wallet will ask you to approve the connection.</p><div className="wallet-choice-list">{walletChoices.map(choice=><button className="wallet-choice" key={choice.info.uuid} onClick={()=>void connectWithProvider(choice.provider,choice.info.name)}>{choice.info.icon?<img src={choice.info.icon} alt=""/>:<span className="wallet-choice-mark">W</span>}<span>{choice.info.name}</span><b>↗</b></button>)}</div><button className="walletconnect-choice" disabled={Boolean(busy)} onClick={()=>void connectWalletConnect()}>{busy==="Connecting WalletConnect"?"Opening WalletConnect…":"WalletConnect · Mobile & QR"}</button><small>Supports compatible EVM wallets. Network: Robinhood Chain Testnet (46630).</small></section></div>}
   {tab==="v2"&&<V2Markets v2Address={v2Address} account={account} wallet={wallet}/>}
   {tab==="launches"&&<section className="discovery-panel">
    <div className="discovery-heading"><div><div className="eyebrow">VIBEVIBE TOKEN DISCOVERY</div><h2>Recent launches</h2><p>On-chain factory records checked against token, curve and pricing contracts.</p></div><span className="discovery-count">{v6Discovery?v6Discovery.totalTokens+" V6 verified":discovery?discovery.totalTokens+" earlier verified":"INDEX NOT RUN"}</span></div>
    {!v6Discovery&&!discovery?<div className="discovery-empty">The launch registries have not been generated yet. The GitHub Actions discovery workflow refreshes the earlier factory records and the active V6 launch feed.</div>:<>
     <label className="discovery-search">Search launches<input value={discoveryQuery} onChange={e=>setDiscoveryQuery(e.target.value)} placeholder="Name, symbol, address, pair or launch ID"/></label>
     {v6Discovery&&<div className="v6-section">
      <div className="v6-section-heading"><div><span className="eyebrow">ACTIVE V6 FACTORY</span><h3>Current VibeVibe launches</h3><p>On-chain curve quote and graduated Uniswap V4 price snapshots.</p></div><span className="discovery-count">{v6Discovery.factoryLaunchCount} launches · block {Number(v6Discovery.readAtBlock).toLocaleString()}</span></div>
      {visibleV6Launches.length===0?<div className="discovery-empty">No V6 launches match that search.</div>:<div className="discovery-list">{visibleV6Launches.map(item=><article className="discovery-item v6-discovery-item" key={item.token}>
       <div className="discovery-token"><strong>{item.name||"Unnamed token"} {item.symbol?"("+item.symbol+")":""}</strong><span>V6 · launch #{item.launchId} · {item.complete?"Graduated · V4 pool":"Curve trading"}</span></div>
       <div className="discovery-state v6-discovery-state"><div className="v6-metric"><span>{item.pricing.status!=="available"?"PRICE UNAVAILABLE":item.pricing.method==="uniswap_v4_pool_state"?"V4 SPOT":"CURVE QUOTE"}</span><b>{scaledUnits(item.pricing.pricePairPerTokenScaled1e18)} {item.pairSymbol}</b></div><div className="v6-metric"><span>FDV · PAIR DENOMINATED</span><b>{scaledUnits(item.pricing.fdvPairScaled1e18)} {item.pairSymbol}</b></div><a href={"https://explorer.testnet.chain.robinhood.com/address/"+item.token} target="_blank" rel="noreferrer">Token ↗</a><a href={"https://explorer.testnet.chain.robinhood.com/address/"+item.curve} target="_blank" rel="noreferrer">Curve ↗</a></div>
      </article>)}</div>}
      <p className="discovery-footnote">Active factory: {short(v6Discovery.factory)} · {v6Discovery.tokens.length} latest launches indexed. FDV uses total supply and is not circulating market cap. Values are denominated in each token's pair currency; no USD conversion is applied. V6 contract source is not verified on the explorer. Snapshot only, not settlement data.</p>
     </div>}
     {discovery&&discovery.tokens.length>0&&<div className="v6-section">
      <div className="v6-section-heading"><div><span className="eyebrow">EARLIER FACTORY GENERATIONS</span><h3>Earlier launches</h3><p>Legacy factory records kept separate from the active V6 feed.</p></div><span className="discovery-count">{discovery.totalTokens} indexed</span></div>
      <div className="discovery-list">{visibleLaunches.map(item=><article className="discovery-item" key={item.token}><div className="discovery-token"><strong>{item.name||"Unnamed token"} {item.symbol?"("+item.symbol+")":""}</strong><span>{item.generation.toUpperCase()} · launch #{item.launchId} · {item.blockNumber!==null?"block "+item.blockNumber.toLocaleString():item.launchTimestamp?"launched "+new Date(Number(item.launchTimestamp)*1000).toLocaleDateString():"date unavailable"}</span></div><div className="discovery-state"><span>{item.graduated===null?"Graduation unknown":item.graduated?"Graduated":"Not graduated"}</span><a href={"https://explorer.testnet.chain.robinhood.com/address/"+item.token} target="_blank" rel="noreferrer">Token ↗</a><a href={"https://explorer.testnet.chain.robinhood.com/address/"+item.curve} target="_blank" rel="noreferrer">Curve ↗</a>{isOwner&&<button className="select-curve" onClick={()=>setCurve(item.curve)}>Use curve</button>}</div></article>)}</div>
      <p className="discovery-footnote">{discovery.coverage.replaceAll("_"," ")} · {discovery.totalLaunches?.toLocaleString()||"Unknown"} launches reported across configured earlier factories. State reads are snapshots, not historical facts; this registry never settles markets.</p>
     </div>}
    </>}
   </section>}
   {tab==="markets"&&<section className="toolbar" id="markets"><div className="page-heading"><span className="eyebrow">VIBEVIBE PREDICTION MARKETS</span><h1>Explore markets</h1><p>Take a position on the next VibeVibe graduation.</p></div><div className="toolbar-right">{account&&<span className="balance">Balance <b>{units(balance,decimals)} {symbol}</b></span>}<button className="refresh" onClick={()=>void refresh()}>↻ Refresh</button></div></section>}
   {(tab==="markets"||tab==="home")?<>{tab==="home"&&<div className="section-heading"><div><span className="eyebrow">THE MARKET BOARD</span><h2>Active markets</h2></div><button className="text-link" onClick={()=>setTab("markets")}>View all markets ↗</button></div>}<section className="market-list">
    {pageMarkets.length===0?<div className="empty"><div className="empty-icon">✳</div><h3>The board is clear</h3><p>New markets appear here when a verified VibeVibe launch is listed.</p></div>:pageMarkets.map(m=>{
     const id=m.id.toString(),p=positions[id],launch=launchForCurve(m.curve),total=m.yesPool+m.noPool,closed=BigInt(Math.floor(Date.now()/1000))>=m.resolveAfter,yesShare=total===0n?50:Number(m.yesPool*10000n/total)/100,stakeText=amounts[id]||"",stakeValue=(()=>{try{return stakeText?parseUnits(stakeText,decimals):0n;}catch{return 0n;}})(),yesEstimate=stakeValue>0n?estimatePayout(m,true,stakeValue,feeBps):null,noEstimate=stakeValue>0n?estimatePayout(m,false,stakeValue,feeBps):null;
     return <article className="market-card market-card-rich" key={id}><div className="market-head"><span className={m.resolved?"status resolved":closed?"status closed":"status live"}>{m.resolved?"RESOLVED":closed?"AWAITING SETTLEMENT":"OPEN FOR CALLS"}</span><span className="market-id">#{id} · VIBE CURVE</span></div><div className="market-token-row"><div className="token-orb">{(launch?.symbol||launch?.name||"V").slice(0,1).toUpperCase()}</div><div className="market-title-wrap"><span className="market-kicker">{launch?.generation||"VIBEVIBE LAUNCH"}</span><h3>Will {launch?.name||short(m.curve)}{launch?.symbol?" ("+launch.symbol+")":""} graduate before settlement?</h3></div></div><div className="market-meta"><span>RESOLUTION</span><b>{closed?"Deadline passed":date(m.resolveAfter)}</b><a href={"https://explorer.testnet.chain.robinhood.com/address/"+m.curve} target="_blank" rel="noreferrer">Curve explorer ↗</a></div><div className="market-sentiment"><div className="sentiment-head"><span>POOL SENTIMENT</span><span>{units(total,decimals)} {symbol} staked</span></div><div className="sentiment-bar"><i style={{width:yesShare+"%"}}/></div><div className="sentiment-labels"><span><b>YES {yesShare.toFixed(1)}%</b><small>{units(m.yesPool,decimals)} {symbol}</small></span><span><b>NO {(100-yesShare).toFixed(1)}%</b><small>{units(m.noPool,decimals)} {symbol}</small></span></div></div><div className="market-foot"><span>Market #{id}</span>{m.resolved&&<b className="outcome">{m.outcomeYes?"YES WON":"NO WON"}</b>}</div>{p&&(p.yes>0n||p.no>0n)&&<div className="your-position"><span>YOUR POSITION</span><b>YES {units(p.yes,decimals)} · NO {units(p.no,decimals)} {symbol}</b>{p.claimed&&<small>CLAIMED</small>}</div>}
     {!m.resolved&&!closed&&account&&<div className="bet-panel"><label>Enter your stake<input inputMode="decimal" placeholder={"Amount in "+symbol} value={stakeText} onChange={e=>setAmounts(old=>({...old,[id]:e.target.value}))}/></label><div className="odds-grid"><div><span>YES EST. RETURN</span><b>{yesEstimate?yesEstimate.multiplier.toFixed(2)+"×":"—"}</b><small>{yesEstimate?units(yesEstimate.payout,decimals)+" "+symbol+" payout · +"+units(yesEstimate.profit,decimals)+" profit":"Enter a stake to calculate"}</small></div><div><span>NO EST. RETURN</span><b>{noEstimate?noEstimate.multiplier.toFixed(2)+"×":"—"}</b><small>{noEstimate?units(noEstimate.payout,decimals)+" "+symbol+" payout · +"+units(noEstimate.profit,decimals)+" profit":"Enter a stake to calculate"}</small></div></div><div className="bet-actions"><button className="yes-button" disabled={Boolean(busy)} onClick={()=>void bet(m,true)}>Back YES ↗</button><button className="no-button" disabled={Boolean(busy)} onClick={()=>void bet(m,false)}>Back NO ↘</button></div><p className="odds-note">Indicative pooled odds after your stake, using the current pools and {(feeBps/100).toFixed(2)}% fee. Other bets can change the final payout before settlement.</p></div>}
     {!account&&!m.resolved&&!closed&&<button className="connect-hint" onClick={connect}>Connect wallet to take a position ↗</button>}
     {closed&&!m.resolved&&<button className="settle-button" disabled={!account||Boolean(busy)} onClick={()=>void transact("Settle market",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"settleMarket",args:[m.id]}))}>Settle market ↗</button>}
     {p&&canClaimPosition(m,p)&&<button className="claim-button" disabled={!account||Boolean(busy)} onClick={()=>void transact("Claim winnings",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"claim",args:[m.id]}))}>Claim winnings ↗</button>}</article>;
    })}
   </section></>:tab==="portfolio"?<><div className="page-heading standalone-heading"><span className="eyebrow">YOUR ACCOUNT</span><h1>Portfolio</h1><p>Track your positions, claims and testnet activity.</p></div><section className="portfolio-overview"><div><span className="eyebrow">YOUR LAUNCHCAST ACTIVITY</span><h2>Position overview</h2><p>Your positions are linked to your wallet and recorded on Robinhood Chain Testnet.</p></div><div className="portfolio-metrics"><div><b>{portfolio.length}</b><span>Markets joined</span></div><div><b>{units(portfolio.reduce((sum,m)=>sum+positions[m.id.toString()].yes+positions[m.id.toString()].no,0n),decimals)} {symbol}</b><span>Total staked</span></div><div><b>{winsCount}</b><span>Wins</span></div><div><b>{lossesCount}</b><span>Losses</span></div><div><b>{portfolio.filter(m=>canClaimPosition(m,positions[m.id.toString()])).length}</b><span>Claimable</span></div></div></section><section className="market-list">{!account?<div className="empty"><h3>Connect your wallet</h3><p>Your positions will appear here.</p></div>:portfolio.length===0?<div className="empty"><h3>No positions yet</h3><p>Your calls appear here after you back a YES or NO side on a live market.</p></div>:portfolio.map(m=>{const p=positions[m.id.toString()],launch=launchForCurve(m.curve);return <article className="market-card market-card-rich" key={m.id.toString()}><div className="market-head"><span className={m.resolved?"status resolved":"status live"}>{m.resolved?"RESOLVED":"POSITION OPEN"}</span><span className="market-id">MARKET #{m.id.toString()}</span></div><div className="market-title-wrap"><span className="market-kicker">VIBEVIBE LAUNCH</span><h3>{launch?.name||short(m.curve)}{launch?.symbol?" ("+launch.symbol+")":""}</h3></div><div className="position-split"><div><span>YES STAKE</span><b>{units(p.yes,decimals)} {symbol}</b></div><div><span>NO STAKE</span><b>{units(p.no,decimals)} {symbol}</b></div></div><p className="portfolio-result">{m.resolved?((m.outcomeYes?m.yesPool:m.noPool)===0n?"REFUNDED · No winning pool; your stake is returned.":(m.outcomeYes?p.yes:p.no)>0n?(p.claimed?"WON · Winnings claimed.":"WON · Your position won; winnings are ready."):(p.claimed?"LOST · No payout.":"LOST · Your selected outcome did not win.")):"OPEN · Market resolves "+date(m.resolveAfter)}</p>{canClaimPosition(m,p)&&<button className="claim-button" disabled={!account||Boolean(busy)} onClick={()=>void transact("Claim winnings",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"claim",args:[m.id]}))}>Claim winnings ↗</button>}</article>})}</section></>:null}{tab==="portfolio"&&account&&feeBalance>0n&&<section className="wallet-tools"><div><span className="eyebrow">FEE RECIPIENT</span><h3>{units(feeBalance,decimals)} {symbol} available</h3><p>Fees allocated to the connected wallet can be withdrawn from the protocol contract.</p></div><button className="outline-button" disabled={Boolean(busy)} onClick={()=>void transact("Withdraw protocol fees",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"withdrawFees"}))}>Withdraw fees</button></section>}
   {tab==="portfolio"&&account&&token&&<section className="wallet-tools"><div><span className="eyebrow">TESTNET ONLY</span><h3>Need test tokens?</h3><p>Request free tUSD from the faucet contract. Test tokens have no monetary value.</p></div><button className="outline-button" disabled={Boolean(busy)} onClick={()=>void faucet()}>Get test {symbol}</button></section>}
   {isOwner&&tab==="admin"&&<><div className="page-heading standalone-heading"><span className="eyebrow">PROTOCOL MANAGEMENT</span><h1>Admin</h1><p>Create markets, settle eligible markets and manage protocol fees.</p></div><section className="admin-panel"><div className="eyebrow">ADMIN TOOLS</div><h2>Create a VibeVibe market</h2><p>Create markets only for curves whose <code>graduated()</code> getter has been verified. YES means the getter returns true when settlement is executed after the deadline.</p><label>Curve contract address<input value={curve} onChange={e=>setCurve(e.target.value)} placeholder="0x…"/></label><label>Resolve after<input type="datetime-local" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label><button className="primary-button" disabled={Boolean(busy)} onClick={()=>void create()}>Create market</button><div className="admin-divider"/><div className="admin-subhead"><span className="eyebrow">SETTLEMENT QUEUE</span><b>{settlementQueue.length} ready</b></div><p>Settlement reads the curve’s current <code>graduated()</code> state. Anyone can settle an eligible market; this button batches up to 25.</p><button className="outline-button" disabled={Boolean(busy)||!settlementQueue.length} onClick={()=>void settleReadyMarkets()}>Settle ready markets</button><div className="admin-divider"/><span className="eyebrow">PROTOCOL FEES</span><p>Current fee: <strong>{(feeBps/100).toFixed(2)}%</strong> · Recipient: <code>{feeRecipient?short(feeRecipient):"—"}</code></p><label>Fee in basis points (0–1000)<input inputMode="numeric" value={newFeeBps} onChange={e=>setNewFeeBps(e.target.value)}/></label><label>Fee recipient<input value={newFeeRecipient} onChange={e=>setNewFeeRecipient(e.target.value)} placeholder="0x…"/></label><button className="primary-button" disabled={Boolean(busy)} onClick={()=>void updateFees()}>Save fee settings</button></section></>}
   {tab==="home"&&<section className="home-bottom"><div><span className="eyebrow">TRACK EVERY LAUNCH</span><h2>Find the next curve worth calling.</h2><p>Browse newly indexed VibeVibe launches and see which ones have a market.</p></div><button className="primary-button" onClick={()=>setTab("launches")}>Explore launches ↗</button></section>}
   <footer><div className="footer-brand"><img src="/launchcast-mark.svg" alt="" /><span>launchcast.</span></div><span>Independent app for the VibeVibe ecosystem · Robinhood Chain Testnet</span><span>No real funds · Verify every transaction</span></footer>
  </main>
 </div>;
}
