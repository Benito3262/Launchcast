import { useCallback, useEffect, useMemo, useState } from "react";
import { createWalletClient, custom, formatUnits, parseAbi, type Address, type Hex, type WalletClient } from "viem";
import V2Markets from "./V2Markets";
import { CurveChart, CurvePanel, fmtNum, readCurves, type CurveState } from "./curve";
import { chain, publicClient, RPC, V2_ADDRESS, STAKE_TOKEN, OWNER, V6_FACTORY, REPO, ETH_FAUCET, VIBEVIBE, addr, short, EXPLORER } from "./config";

type Eip1193 = NonNullable<Window["ethereum"]>;
type Choice = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 };
const tusdAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function faucet()"]);
const factoryAbi = parseAbi(["function launchCount() view returns (uint256)", "function tokenOfLaunch(uint256) view returns (address)", "function curveOf(address) view returns (address)"]);
const SCAN = 60;

type Launch = CurveState & { launchId: number };

async function loadLaunches(): Promise<Launch[]> {
  const n = await publicClient.readContract({ address: V6_FACTORY, abi: factoryAbi, functionName: "launchCount" });
  const ids: bigint[] = [];
  for (let i = n - 1n; i >= 0n && ids.length < SCAN; i--) ids.push(i);
  const tokens = await publicClient.multicall({ allowFailure: true, contracts: ids.map(id => ({ address: V6_FACTORY, abi: factoryAbi, functionName: "tokenOfLaunch" as const, args: [id] as const })) });
  const okTokens = tokens.map((t, i) => ({ t: t.result as Address | undefined, id: Number(ids[i]) })).filter(x => x.t);
  const curves = await publicClient.multicall({ allowFailure: true, contracts: okTokens.map(x => ({ address: V6_FACTORY, abi: factoryAbi, functionName: "curveOf" as const, args: [x.t!] as const })) });
  const pairs = okTokens.map((x, i) => ({ id: x.id, curve: curves[i].result as Address | undefined })).filter(x => x.curve);
  const states = await readCurves(pairs.map(p => p.curve!));
  return states.map((s, i) => (s ? { ...s, launchId: pairs[i].id } : null)).filter(Boolean) as Launch[];
}

function Mark() {
  return <svg viewBox="0 0 32 32" className="mark" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)" /><path d="M7 23 C 13 22, 18 17, 22 9" stroke="#0b0d0f" strokeWidth="2.6" fill="none" strokeLinecap="round" /><circle cx="22.5" cy="8.5" r="3" fill="#0b0d0f" /></svg>;
}

export default function App() {
  const [account, setAccount] = useState<Address>();
  const [wallet, setWallet] = useState<WalletClient>();
  const [provider, setProvider] = useState<Eip1193>();
  const [chainOk, setChainOk] = useState(false);
  const [eth, setEth] = useState<bigint>();
  const [tusd, setTusd] = useState<bigint>();
  const [choices, setChoices] = useState<Choice[]>([]);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [launches, setLaunches] = useState<Launch[] | null>(null);
  const [launchErr, setLaunchErr] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"progress" | "newest">("progress");
  const [open, setOpen] = useState<Launch | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Choice>).detail;
      if (d?.info?.uuid) setChoices(old => (old.some(c => c.info.uuid === d.info.uuid) ? old : [...old, d]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  const refreshLaunches = useCallback(() => {
    loadLaunches().then(l => { setLaunches(l); setLaunchErr(""); }).catch(e => setLaunchErr(e?.shortMessage || e?.message || "Could not read VibeVibe launches."));
  }, []);
  useEffect(() => { refreshLaunches(); const t = window.setInterval(refreshLaunches, 45_000); return () => window.clearInterval(t); }, [refreshLaunches]);

  const refreshBalances = useCallback(async () => {
    if (!account) return;
    const [e, t] = await Promise.all([
      publicClient.getBalance({ address: account }).catch(() => undefined),
      publicClient.readContract({ address: STAKE_TOKEN, abi: tusdAbi, functionName: "balanceOf", args: [account] }).catch(() => undefined),
    ]);
    setEth(e); setTusd(t);
  }, [account]);
  useEffect(() => { void refreshBalances(); const t = window.setInterval(() => void refreshBalances(), 20_000); return () => window.clearInterval(t); }, [refreshBalances]);

  useEffect(() => {
    if (!provider?.on) return;
    const onAcc = (...a: unknown[]) => { const list = a[0] as Address[]; setAccount(list?.[0]); };
    const onChain = (...a: unknown[]) => setChainOk(Number.parseInt(String(a[0]), 16) === chain.id);
    provider.on("accountsChanged", onAcc); provider.on("chainChanged", onChain);
    return () => { provider.removeListener?.("accountsChanged", onAcc); provider.removeListener?.("chainChanged", onChain); };
  }, [provider]);

  const say = (kind: "ok" | "err", text: string) => { setToast({ kind, text }); window.setTimeout(() => setToast(t => (t?.text === text ? null : t)), 7000); };

  async function ensureChain(p: Eip1193) {
    const current = Number.parseInt(String(await p.request({ method: "eth_chainId" })), 16);
    if (current === chain.id) { setChainOk(true); return; }
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xb626" }] }); }
    catch (err) {
      if ((err as { code?: number })?.code !== 4902) throw err;
      await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xb626", chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }] });
    }
    setChainOk(true);
  }

  async function connectWith(p: Eip1193, label: string, ask = true) {
    setBusy("Connecting"); setPicker(false);
    try {
      const accounts = (await p.request({ method: ask ? "eth_requestAccounts" : "eth_accounts" })) as Address[];
      if (!accounts?.[0]) throw new Error("No account returned. Approve the connection in your wallet.");
      await ensureChain(p);
      setWallet(createWalletClient({ chain, transport: custom(p as never) })); setProvider(p); setAccount(accounts[0]);
      say("ok", `Connected with ${label} on Robinhood Chain Testnet.`);
    } catch (e) { say("err", (e as Error)?.message?.split("\n")[0] || "Connection failed."); }
    finally { setBusy(""); }
  }

  async function connectWC() {
    const projectId = import.meta.env.VITE_REOWN_PROJECT_ID;
    if (!projectId) { say("err", "No browser wallet found. Open this page in a wallet browser (MetaMask, Rabby, Coinbase Wallet)."); return; }
    setBusy("Connecting");
    try {
      const { default: EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const p = await EthereumProvider.init({ projectId, chains: [chain.id], showQrModal: true, rpcMap: { [chain.id]: RPC }, methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4", "eth_accounts", "eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain"], events: ["chainChanged", "accountsChanged"] });
      await p.connect();
      await connectWith(p as unknown as Eip1193, "WalletConnect", false);
    } catch (e) { say("err", (e as Error)?.message || "WalletConnect failed."); }
    finally { setBusy(""); }
  }

  function connect() {
    if (choices.length > 1) { setPicker(true); return; }
    if (choices.length === 1) { void connectWith(choices[0].provider, choices[0].info.name); return; }
    if (window.ethereum) { void connectWith(window.ethereum, "Browser wallet"); return; }
    void connectWC();
  }

  async function faucet() {
    if (!wallet || !account) return connect();
    setBusy("Minting tUSD");
    try {
      const hash: Hex = await wallet.writeContract({ account, chain, address: STAKE_TOKEN, abi: tusdAbi, functionName: "faucet" });
      await publicClient.waitForTransactionReceipt({ hash });
      say("ok", "10,000 tUSD added to your wallet. It has no real value.");
      void refreshBalances();
    } catch (e) { say("err", ((e as { shortMessage?: string })?.shortMessage || (e as Error)?.message || "Faucet failed").split("\n")[0]); }
    finally { setBusy(""); }
  }

  const featured = useMemo(() => launches?.filter(l => !l.complete).sort((a, b) => b.progress - a.progress)[0], [launches]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (launches || []).filter(l => !q || [l.name, l.symbol, l.token, String(l.launchId)].some(v => v?.toLowerCase().includes(q)));
    return list.sort((a, b) => (sort === "progress" ? b.progress - a.progress : b.launchId - a.launchId));
  }, [launches, query, sort]);

  const ethOk = eth !== undefined && eth > 0n;
  const tusdOk = tusd !== undefined && tusd > 0n;
  const steps = [
    { done: Boolean(account), title: "Connect a wallet", body: "MetaMask, Rabby or any EVM wallet.", action: !account ? <button className="btn btn-primary sm" onClick={connect} disabled={!!busy}>Connect</button> : <span className="ok">{short(account)}</span> },
    { done: Boolean(account) && chainOk, title: "Robinhood Chain Testnet", body: "Chain ID 46630. We add it for you.", action: account && !chainOk ? <button className="btn sm" onClick={() => provider && ensureChain(provider).catch(e => say("err", e.message))}>Switch network</button> : chainOk ? <span className="ok">Ready</span> : null },
    { done: ethOk, title: "Test ETH for gas", body: "Free from the official Robinhood faucet.", action: ethOk ? <span className="ok">{fmtNum(Number(formatUnits(eth!, 18)), 3)} ETH</span> : <a className="btn sm" href={ETH_FAUCET} target="_blank" rel="noreferrer">Open faucet ↗</a> },
    { done: tusdOk, title: "Free tUSD to stake", body: "10,000 test dollars per claim. No value.", action: tusdOk ? <span className="ok">{fmtNum(Number(formatUnits(tusd!, 6)), 6)} tUSD</span> : <button className="btn sm" onClick={faucet} disabled={!!busy || !account}>Get tUSD</button> },
  ];

  return <div className="app">
    <div className="testnet-bar">Testnet only · Robinhood Chain Testnet · tUSD and test ETH have no real value</div>
    <header className="top">
      <a className="brand" href="#top"><Mark /><span>LaunchCast</span></a>
      <nav className={menu ? "nav open" : "nav"} onClick={() => setMenu(false)}>
        <a href="#markets">Markets</a><a href="#launches">Launches</a><a href="#how">How it works</a><a href={REPO} target="_blank" rel="noreferrer">GitHub ↗</a>
      </nav>
      <div className="top-right">
        {account ? <span className="acct"><i className={chainOk ? "dot ok" : "dot warn"} />{short(account)}</span>
          : <button className="btn btn-primary" onClick={connect} disabled={!!busy}>{busy === "Connecting" ? "Connecting…" : "Connect wallet"}</button>}
        <button className="menu-btn" aria-label="Menu" onClick={() => setMenu(m => !m)}>☰</button>
      </div>
    </header>

    <main id="top">
      <section className="hero">
        <div className="hero-copy">
          <span className="kicker">Prediction markets for vibe/vibe launches</span>
          <h1>Call the curve.</h1>
          <p>Every VibeVibe launch climbs a bonding curve toward graduation. LaunchCast lets you take a free YES or NO position on where it lands, with every curve read live from Robinhood Chain Testnet.</p>
          <div className="hero-cta"><a className="btn btn-primary lg" href="#start">Get started</a><a className="btn lg" href="#launches">Watch live curves</a></div>
          <ul className="hero-facts"><li><b>On-chain</b> curve reads</li><li><b>Free</b> test tokens</li><li><b>0%</b> fees</li></ul>
        </div>
        <div className="hero-card">
          {featured ? <>
            <div className="hc-top"><span className="label">Closest to graduating</span><span className="pill pill-live">live</span></div>
            <h3>{featured.name || short(featured.token)} <small>${featured.symbol}</small></h3>
            <CurveChart s={featured} height={170} />
            <div className="hc-stats"><div><span>Progress</span><b>{(featured.progress * 100).toFixed(1)}%</b></div><div><span>Raised</span><b>{fmtNum(featured.principal, 3)} {featured.pairSymbol}</b></div><div><span>To go</span><b>{fmtNum(featured.toGraduate, 3)} {featured.pairSymbol}</b></div></div>
          </> : launchErr ? <p className="muted">Couldn't reach the Robinhood testnet RPC. <button className="link" onClick={refreshLaunches}>Retry</button></p>
            : <div className="skeleton"><div className="sk-line" /><div className="sk-block tall" /><div className="sk-line" /></div>}
        </div>
      </section>

      <section id="start" className="section">
        <div className="section-head"><span className="kicker">Start in a minute</span><h2>Four steps, all free</h2></div>
        <ol className="steps">{steps.map((s, i) => <li key={s.title} className={s.done ? "step done" : "step"}><span className="step-n">{s.done ? "✓" : i + 1}</span><div><b>{s.title}</b><p>{s.body}</p></div><div className="step-act">{s.action}</div></li>)}</ol>
      </section>

      <section id="markets" className="section">
        <V2Markets v2Address={V2_ADDRESS} account={account} wallet={wallet} />
      </section>

      <section id="launches" className="section">
        <div className="section-head row"><div><span className="kicker">Live from the V6 factory</span><h2>VibeVibe launches</h2><p className="muted">The {SCAN} newest launches, read directly from the VibeVibe V6 factory and each bonding curve. Tap one for its full curve.</p></div>
          <div className="filters"><input placeholder="Search name, ticker, address" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search launches" />
            <div className="seg"><button className={sort === "progress" ? "on" : ""} onClick={() => setSort("progress")}>Progress</button><button className={sort === "newest" ? "on" : ""} onClick={() => setSort("newest")}>Newest</button></div></div></div>
        {launchErr && !launches && <div className="empty"><b>Couldn't load launches</b><p>{launchErr}</p><button className="btn" onClick={refreshLaunches}>Try again</button></div>}
        {!launches && !launchErr && <div className="grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="card skeleton"><div className="sk-line" /><div className="sk-block" /></div>)}</div>}
        {launches && shown.length === 0 && <div className="empty"><b>No launches match “{query}”</b><p>Try a ticker or paste a token address.</p></div>}
        {launches && shown.length > 0 && <div className="grid">{shown.map(l => <button key={l.curve} className="card launch" onClick={() => setOpen(l)}>
          <div className="launch-top"><div><b>{l.name || "Unnamed"}</b><span>${l.symbol || "?"} · #{l.launchId}</span></div><span className={"pill " + (l.complete ? "pill-done" : "pill-live")}>{l.complete ? "Graduated" : `${(l.progress * 100).toFixed(1)}%`}</span></div>
          <CurveChart s={l} height={90} compact />
          <div className="launch-foot"><span>{fmtNum(l.principal, 3)} / {fmtNum(l.target, 3)} {l.pairSymbol}</span><span>{ago(l.createdAt)}</span></div>
        </button>)}</div>}
      </section>

      <section id="how" className="section">
        <div className="section-head"><span className="kicker">How it works</span><h2>Simple pools, honest settlement</h2></div>
        <div className="how">
          <div><span className="how-n">01</span><b>A market asks one question</b><p>“Will this launch graduate its bonding curve by the observation time?” or “Will its FDV clear a target 12 or 24 hours after launch?”</p></div>
          <div><span className="how-n">02</span><b>Stake YES or NO in tUSD</b><p>Both sides pool their stakes. Betting closes before the observation time, and early when a curve graduates.</p></div>
          <div><span className="how-n">03</span><b>Settled from chain evidence</b><p>The resolver signs the observed on-chain result (block, block hash, evidence hash). Anyone can challenge it for 30 minutes before it becomes final.</p></div>
          <div><span className="how-n">04</span><b>Winners split the pool</b><p>Winners share the losing pool pro rata. Fees are 0%. If nobody backed the winning side, or nothing is attested within 24h, everyone gets a refund.</p></div>
        </div>
        <details className="faq"><summary>What is the bonding curve chart?</summary><p>VibeVibe V6 curves sell 800M of 1B tokens on a constant-product curve with virtual reserves. From on-chain reads, <code>(target/3 + raised) × (1,066,666,667 − sold) = constant</code>. That's why the price rises 16× from the first token to graduation, when the curve hits its target (about 4 ETH on ETH pairs) and liquidity moves to a locked Uniswap v4 pool.</p></details>
        <details className="faq"><summary>Who resolves markets?</summary><p>The LaunchCast V2 contract uses one disclosed resolver wallet (<a href={addr(OWNER)} target="_blank" rel="noreferrer">{short(OWNER)}</a>), which is also the contract owner. That's a trust assumption, not a trustless oracle. That's fine for a testnet MVP, and it's stated here so nobody has to guess.</p></details>
        <details className="faq"><summary>Is any of this real money?</summary><p>No. Everything runs on Robinhood Chain Testnet. tUSD comes from a public faucet and test ETH from the Robinhood faucet. Neither has any value.</p></details>
      </section>
    </main>

    <footer className="foot">
      <div className="foot-brand"><Mark /><div><b>LaunchCast</b><p>An independent builder project for the vibe/vibe ecosystem. Not affiliated with or endorsed by vibe/vibe or Robinhood.</p></div></div>
      <div className="foot-links">
        <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a>
        <a href={addr(V2_ADDRESS)} target="_blank" rel="noreferrer">V2 contract</a>
        <a href={addr(STAKE_TOKEN)} target="_blank" rel="noreferrer">tUSD token</a>
        <a href={VIBEVIBE} target="_blank" rel="noreferrer">vibe/vibe testnet ↗</a>
      </div>
      <p className="foot-note">Testnet only. No real value. Unaudited. Don't send mainnet funds to these contracts.</p>
    </footer>

    {open && <div className="modal" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-head"><div><span className="kicker">Launch #{open.launchId}</span><h3>{open.name || "Unnamed"} <small>${open.symbol}</small></h3></div><button className="x" aria-label="Close" onClick={() => setOpen(null)}>×</button></div>
        <CurvePanel curve={open.curve} />
        <div className="sheet-links"><a href={addr(open.token)} target="_blank" rel="noreferrer">Token {short(open.token)} ↗</a><a href={addr(open.curve)} target="_blank" rel="noreferrer">Curve {short(open.curve)} ↗</a><a href={VIBEVIBE} target="_blank" rel="noreferrer">Trade on vibe/vibe ↗</a></div>
      </div>
    </div>}

    {picker && <div className="modal" onClick={() => setPicker(false)}><div className="sheet narrow" onClick={e => e.stopPropagation()}>
      <div className="sheet-head"><h3>Choose a wallet</h3><button className="x" onClick={() => setPicker(false)}>×</button></div>
      <div className="wallets">{choices.map(c => <button key={c.info.uuid} className="wallet" onClick={() => void connectWith(c.provider, c.info.name)}><img src={c.info.icon} alt="" />{c.info.name}</button>)}
        {import.meta.env.VITE_REOWN_PROJECT_ID && <button className="wallet" onClick={() => void connectWC()}>WalletConnect (mobile)</button>}</div>
    </div></div>}

    {busy && busy !== "Connecting" && <div className="toast">{busy}…</div>}
    {toast && <div className={"toast " + toast.kind} role="status">{toast.text}</div>}
  </div>;
}

function ago(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
