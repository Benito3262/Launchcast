import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, getAddress, http, parseUnits, type Address, type Hex, type WalletClient } from "viem";

const chain = defineChain({
  id: 46630, name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Robinhood Testnet ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://explorer.testnet.chain.robinhood.com" } }, testnet: true,
});
const address = (import.meta.env.VITE_LAUNCHCAST_ADDRESS || "") as Address;
const abi = [
 {type:"function",name:"owner",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
 {type:"function",name:"stakeToken",stateMutability:"view",inputs:[],outputs:[{type:"address"}]},
 {type:"function",name:"marketCount",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},
 {type:"function",name:"getMarket",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"}],outputs:[{name:"market",type:"tuple",components:[{name:"curve",type:"address"},{name:"resolveAfter",type:"uint64"},{name:"yesPool",type:"uint128"},{name:"noPool",type:"uint128"},{name:"outcomeYes",type:"bool"},{name:"resolved",type:"bool"}]}]},
 {type:"function",name:"getPosition",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"},{name:"user",type:"address"}],outputs:[{name:"yesAmount",type:"uint256"},{name:"noAmount",type:"uint256"},{name:"claimed",type:"bool"}]},
 {type:"function",name:"placeBet",stateMutability:"nonpayable",inputs:[{name:"marketId",type:"uint256"},{name:"sideYes",type:"bool"},{name:"amount",type:"uint256"}],outputs:[]},
 {type:"function",name:"settleMarket",stateMutability:"nonpayable",inputs:[{name:"marketId",type:"uint256"}],outputs:[]},
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
type Market = {id:bigint;curve:Address;resolveAfter:bigint;yesPool:bigint;noPool:bigint;outcomeYes:boolean;resolved:boolean};
type Position = {yes:bigint;no:bigint;claimed:boolean};
type DiscoveredLaunch = {
 token:string; curve:string; generation:string; launchId:string; creator:string;
 blockNumber:number; name:string|null; symbol:string|null; decimals:number|null;
 graduated:boolean|null; complete:boolean|null; transfersUnlocked:boolean|null;
};
type DiscoveryFile = { generatedAt:string; totalTokens:number; coverage:string; warning:string; tokens:DiscoveredLaunch[] };
const rpc = import.meta.env.VITE_ROBINHOOD_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com";
const publicClient = createPublicClient({chain,transport:http(rpc)});
const short = (s:string) => s ? s.slice(0,6)+"…"+s.slice(-4) : "—";
const date = (t:bigint) => new Date(Number(t)*1000).toLocaleString();
const units = (v:bigint,d:number) => Number(formatUnits(v,d)).toLocaleString(undefined,{maximumFractionDigits:2});

export default function App() {
 const [account,setAccount]=useState<Address>();
 const [wallet,setWallet]=useState<WalletClient>();
 const [markets,setMarkets]=useState<Market[]>([]);
 const [positions,setPositions]=useState<Record<string,Position>>({});
 const [owner,setOwner]=useState<Address>();
 const [token,setToken]=useState<Address>();
 const [symbol,setSymbol]=useState("tUSD");
 const [decimals,setDecimals]=useState(6);
 const [balance,setBalance]=useState(0n);
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const [curve,setCurve]=useState("");
 const [deadline,setDeadline]=useState("");
 const [busy,setBusy]=useState("");
 const [notice,setNotice]=useState("");
 const [error,setError]=useState("");
 const [tab,setTab]=useState<"markets"|"portfolio">("markets");
 const [discovery,setDiscovery]=useState<DiscoveryFile|null>(null);
 const configured=Boolean(address && /^0x[a-fA-F0-9]{40}$/.test(address));
 const isOwner=Boolean(account && owner && account.toLowerCase()===owner.toLowerCase());

 const refresh=useCallback(async()=>{
  if(!configured)return;
  try{
   const [count,admin,stake]=await Promise.all([
    publicClient.readContract({address,abi,functionName:"marketCount"}),
    publicClient.readContract({address,abi,functionName:"owner"}),
    publicClient.readContract({address,abi,functionName:"stakeToken"}),
   ]);
   setOwner(admin);setToken(stake);
   const [sym,dec]=await Promise.all([
    publicClient.readContract({address:stake,abi:tokenAbi,functionName:"symbol"}).catch(()=>"tUSD"),
    publicClient.readContract({address:stake,abi:tokenAbi,functionName:"decimals"}).catch(()=>6),
   ]);
   setSymbol(sym as string);setDecimals(Number(dec));
   const ids=Array.from({length:Number(count)},(_,i)=>BigInt(i+1));
   const rows=await Promise.all(ids.map(async id=>{
    const m=await publicClient.readContract({address,abi,functionName:"getMarket",args:[id]});
    return {id,curve:m.curve,resolveAfter:m.resolveAfter,yesPool:m.yesPool,noPool:m.noPool,outcomeYes:m.outcomeYes,resolved:m.resolved} satisfies Market;
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
   }else{setBalance(0n);setPositions({});}
   setError("");
  }catch(e){setError(e instanceof Error?e.message:"Unable to read Launchcast contracts.");}
 },[account,configured]);

 useEffect(()=>{void refresh();},[refresh]);
 useEffect(()=>{
  let active=true;
  fetch("/data/vibevibe-tokens.json").then(r=>{if(!r.ok)throw new Error("Discovery file not generated");return r.json();})
   .then((data:DiscoveryFile)=>{if(active)setDiscovery(data);})
   .catch(()=>{if(active)setDiscovery(null);});
  return()=>{active=false;};
 },[]);
 useEffect(()=>{
  const p=window.ethereum;if(!p?.on)return;
  const changed=(...args:unknown[])=>{const a=args[0] as string[]|undefined;setAccount(a?.[0]?getAddress(a[0]):undefined);};
  p.on("accountsChanged",changed);return()=>p.removeListener?.("accountsChanged",changed);
 },[]);

 const portfolio=useMemo(()=>markets.filter(m=>{const p=positions[m.id.toString()];return p&&(p.yes>0n||p.no>0n);}),[markets,positions]);
 const launchForCurve=(curveAddress:string)=>discovery?.tokens.find(item=>item.curve.toLowerCase()===curveAddress.toLowerCase());

 async function connect(){
  setError("");if(!window.ethereum){setError("No wallet found. Open this site in MetaMask or another EVM wallet browser.");return;}
  try{
   const client=createWalletClient({chain,transport:custom(window.ethereum as never)});
   const [user]=await client.requestAddresses();
   await client.switchChain({id:46630}).catch(async()=>{
    await window.ethereum!.request({method:"wallet_addEthereumChain",params:[{chainId:"0xb626",chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:[rpc],blockExplorerUrls:[chain.blockExplorers.default.url]}]});
    await client.switchChain({id:46630});
   });
   setWallet(client);setAccount(user);setNotice("Wallet connected to Robinhood Chain Testnet.");
  }catch(e){setError(e instanceof Error?e.message:"Wallet connection failed.");}
 }

 async function transact(label:string,action:(client:WalletClient,user:Address)=>Promise<Hex>){
  if(!wallet||!account){setError("Connect your wallet first.");return;}
  setBusy(label);setError("");setNotice("");
  try{
   const hash=await action(wallet,account);setNotice(label+": transaction sent. Waiting for confirmation…");
   await publicClient.waitForTransactionReceipt({hash});setNotice(label+": confirmed on Robinhood Chain Testnet.");await refresh();
  }catch(e){setError(e instanceof Error?e.message:label+" failed.");}
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
  await transact("Create market",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"createMarket",args:[getAddress(curve),BigInt(ts)]}));
  setCurve("");setDeadline("");
 }

 return <div className="app-shell">
  <header className="topbar"><a className="brand" href="#"><span className="brand-mark">L</span><span>launchcast<span className="brand-dot">.</span><small>VIBEVIBE MARKETS</small></span></a><div className="top-actions"><span className="network-pill"><i/> Robinhood Testnet</span><button className="wallet-button" onClick={connect}>{account?short(account):"Connect wallet"}</button></div></header>
  <main>
   <section className="hero"><div className="eyebrow"><span className="pulse"/> LIVE ON TESTNET</div><h1>Trade your conviction.<br/><em>Verify it on-chain.</em></h1><p>Prediction markets for VibeVibe token launches. Outcomes are resolved from the curve contract itself.</p><div className="hero-stats"><div><strong>{markets.length}</strong><span>Markets created</span></div><div><strong>{portfolio.length}</strong><span>Your positions</span></div><div><strong>{symbol}</strong><span>Test stake asset</span></div></div></section>
   {!configured&&<div className="notice warning"><strong>Contracts not connected yet.</strong> Add the deployed Launchcast address to <code>web/.env</code> as <code>VITE_LAUNCHCAST_ADDRESS</code>. No deployment is assumed.</div>}
   {notice&&<div className="notice success">{notice}</div>}{error&&<div className="notice danger">{error}<button className="dismiss" onClick={()=>setError("")}>Dismiss</button></div>}
   <section className="discovery-panel">
    <div className="discovery-heading"><div><div className="eyebrow">VIBEVIBE TOKEN DISCOVERY</div><h2>Recent launches</h2><p>Launch events indexed directly from configured factory contracts.</p></div><span className="discovery-count">{discovery?discovery.totalTokens+" indexed":"INDEX NOT RUN"}</span></div>
    {!discovery||discovery.tokens.length===0?<div className="discovery-empty">The registry has not been generated yet. Use GitHub Actions → Refresh VibeVibe token registry to index verified launch events. No API-sourced or guessed token list is shown.</div>:<>
     <div className="discovery-list">{discovery.tokens.slice(0,8).map(item=><article className="discovery-item" key={item.token}><div className="discovery-token"><strong>{item.name||"Unnamed token"} {item.symbol?"("+item.symbol+")":""}</strong><span>{item.generation.toUpperCase()} · launch #{item.launchId} · block {item.blockNumber.toLocaleString()}</span></div><div className="discovery-state"><span>{item.graduated===null?"Graduation unknown":item.graduated?"Graduated":"Not graduated"}</span><a href={"https://explorer.testnet.chain.robinhood.com/address/"+item.token} target="_blank" rel="noreferrer">Token ↗</a><a href={"https://explorer.testnet.chain.robinhood.com/address/"+item.curve} target="_blank" rel="noreferrer">Curve ↗</a>{isOwner&&<button className="select-curve" onClick={()=>setCurve(item.curve)}>Use curve</button>}</div></article>)}</div>
     <p className="discovery-footnote">{discovery.coverage.replaceAll("_"," ")} · State reads are snapshots, not historical facts. This registry is not used to settle markets.</p>
    </>}
   </section>
   <section className="toolbar"><div className="tabs"><button className={tab==="markets"?"active":""} onClick={()=>setTab("markets")}>All markets <span>{markets.length}</span></button><button className={tab==="portfolio"?"active":""} onClick={()=>setTab("portfolio")}>Portfolio <span>{portfolio.length}</span></button></div><div className="toolbar-right">{account&&<span className="balance">Balance <b>{units(balance,decimals)} {symbol}</b></span>}<button className="refresh" onClick={()=>void refresh()}>↻ Refresh</button></div></section>
   {tab==="markets"?<section className="market-list">
    {markets.length===0?<div className="empty"><div className="empty-icon">◎</div><h3>No markets yet</h3><p>Markets appear after Launchcast is deployed and the first verified VibeVibe curve market is created.</p></div>:markets.map(m=>{
     const id=m.id.toString(),p=positions[id],launch=launchForCurve(m.curve),total=m.yesPool+m.noPool,closed=BigInt(Math.floor(Date.now()/1000))>=m.resolveAfter;
     return <article className="market-card" key={id}><div className="market-head"><span className={m.resolved?"status resolved":closed?"status closed":"status live"}>{m.resolved?"RESOLVED":closed?"AWAITING SETTLEMENT":"OPEN"}</span><span className="market-id">MARKET #{id}</span></div><h3>Will {launch?.name||short(m.curve)}{launch?.symbol?" ("+launch.symbol+")":""} be graduated at settlement?</h3><div className="curve-line"><span>CURVE</span><code>{short(m.curve)}</code><a href={"https://explorer.testnet.chain.robinhood.com/address/"+m.curve} target="_blank" rel="noreferrer">View ↗</a></div><div className="pool-grid"><div><span>YES pool</span><b>{units(m.yesPool,decimals)} {symbol}</b></div><div><span>NO pool</span><b>{units(m.noPool,decimals)} {symbol}</b></div><div><span>Total pool</span><b>{units(total,decimals)} {symbol}</b></div></div><div className="pool-bar"><i style={{width:total===0n?"50%":(Number(m.yesPool*10000n/total)/100)+"%"}}/></div><div className="market-foot"><span>Resolution after {date(m.resolveAfter)}</span>{m.resolved&&<b className="outcome">{m.outcomeYes?"YES won":"NO won"}</b>}</div>{p&&<div className="your-position">Your position: YES {units(p.yes,decimals)} · NO {units(p.no,decimals)} {p.claimed?"· Claimed":""}</div>}
      {!m.resolved&&!closed&&account&&<div className="bet-controls"><input inputMode="decimal" placeholder={"Amount in "+symbol} value={amounts[id]||""} onChange={e=>setAmounts(old=>({...old,[id]:e.target.value}))}/><button className="yes-button" disabled={Boolean(busy)} onClick={()=>void bet(m,true)}>Bet YES</button><button className="no-button" disabled={Boolean(busy)} onClick={()=>void bet(m,false)}>Bet NO</button></div>}
      {closed&&!m.resolved&&<button className="settle-button" disabled={!account||Boolean(busy)} onClick={()=>void transact("Settle market",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"settleMarket",args:[m.id]}))}>Settle market</button>}
      {m.resolved&&p&&!p.claimed&&<button className="claim-button" disabled={!account||Boolean(busy)} onClick={()=>void transact("Claim position",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"claim",args:[m.id]}))}>Claim payout</button>}
     </article>;
    })}
   </section>:<section className="market-list">{!account?<div className="empty"><h3>Connect your wallet</h3><p>Your positions will appear here.</p></div>:portfolio.length===0?<div className="empty"><h3>No positions yet</h3><p>Your bets and claim status will appear here.</p></div>:portfolio.map(m=><article className="market-card" key={m.id.toString()}><div className="market-head"><span className="market-id">MARKET #{m.id.toString()}</span><span className={m.resolved?"status resolved":"status live"}>{m.resolved?"RESOLVED":"OPEN"}</span></div><h3>Will {launchForCurve(m.curve)?.name||short(m.curve)}{launchForCurve(m.curve)?.symbol?" ("+launchForCurve(m.curve)?.symbol+")":""} be graduated at settlement?</h3><p className="your-position">YES {units(positions[m.id.toString()].yes,decimals)} · NO {units(positions[m.id.toString()].no,decimals)} {symbol}</p>{m.resolved&&!positions[m.id.toString()].claimed&&<button className="claim-button" onClick={()=>void transact("Claim position",(c,u)=>c.writeContract({account:u,chain,address,abi,functionName:"claim",args:[m.id]}))}>Claim payout</button>}</article>)}</section>}
   {account&&token&&<section className="wallet-tools"><div><span className="eyebrow">TESTNET ONLY</span><h3>Need test tokens?</h3><p>Request free tUSD from the faucet contract. Test tokens have no monetary value.</p></div><button className="outline-button" disabled={Boolean(busy)} onClick={()=>void faucet()}>Get test {symbol}</button></section>}
   {isOwner&&<section className="admin-panel"><div className="eyebrow">ADMIN TOOLS</div><h2>Create a VibeVibe market</h2><p>Create markets only for curves whose <code>graduated()</code> getter has been verified. YES means the getter returns true when settlement is executed after the deadline.</p><label>Curve contract address<input value={curve} onChange={e=>setCurve(e.target.value)} placeholder="0x…"/></label><label>Resolve after<input type="datetime-local" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label><button className="primary-button" disabled={Boolean(busy)} onClick={()=>void create()}>Create market</button></section>}
   <footer><span>LAUNCHCAST © 2026</span><span>Testnet prototype · No real funds · Outcomes read from on-chain state</span></footer>
  </main>
 </div>;
}
