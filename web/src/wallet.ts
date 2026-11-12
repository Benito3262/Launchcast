import { chain, EXPLORER } from "./config";

export type Eip1193 = NonNullable<Window["ethereum"]>;
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Choice = { info: WalletInfo; provider: Eip1193 };

export const CHAIN_HEX = "0x" + chain.id.toString(16);
/** Always hand wallets the public RPC, never a private env override. */
export const PUBLIC_RPC = "https://rpc.testnet.chain.robinhood.com";
export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_HEX,
  chainName: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [PUBLIC_RPC],
  blockExplorerUrls: [EXPLORER],
};

const STORE = "launchcast.wallet";
export const remember = (id: string | null) => { try { id ? localStorage.setItem(STORE, id) : localStorage.removeItem(STORE); } catch { /* private mode */ } };
export const remembered = () => { try { return localStorage.getItem(STORE); } catch { return null; } };

/** Wallets bury the real EIP-1193 code in different places (MetaMask mobile: data.originalError.code). */
export function errCode(e: unknown): number | undefined {
  const seen = new Set<unknown>();
  let cur: any = e;
  for (let i = 0; cur && i < 6 && !seen.has(cur); i++) {
    seen.add(cur);
    if (typeof cur.code === "number" && cur.code !== -32603 && cur.code !== -32000) return cur.code;
    cur = cur.data?.originalError ?? cur.originalError ?? cur.cause ?? cur.error ?? (typeof cur.data === "object" ? cur.data : undefined);
  }
  return typeof (e as any)?.code === "number" ? (e as any).code : undefined;
}
const msgOf = (e: unknown) => String((e as any)?.message ?? (e as any)?.data?.message ?? "");
export const isRejected = (e: unknown) => errCode(e) === 4001 || /reject|denied|cancel/i.test(msgOf(e));
const isUnknownChain = (e: unknown) => errCode(e) === 4902 || /unrecognized chain|unknown chain|not been added|chain.*not (found|supported|configured)|wallet_addEthereumChain/i.test(msgOf(e));

export function parseChainId(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const s = String(v ?? "");
  return s.startsWith("0x") ? Number.parseInt(s, 16) : Number.parseInt(s, 10);
}

export async function readChain(p: Eip1193) { return parseChainId(await p.request({ method: "eth_chainId" })); }

/** Switch to Robinhood Chain Testnet, adding it first if the wallet doesn't know it. Returns true when on 46630. */
export async function ensureChain(p: Eip1193): Promise<boolean> {
  if ((await readChain(p)) === chain.id) return true;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (err) {
    if (isRejected(err) && !isUnknownChain(err)) throw new Error("Network switch was cancelled. Tap “Switch network” when you're ready.");
    try {
      await p.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS] });
    } catch (addErr) {
      if (isRejected(addErr)) throw new Error("Adding Robinhood Chain Testnet was cancelled. Tap “Switch network” to try again.");
      throw new Error(`Your wallet couldn't add Robinhood Chain Testnet. Add it manually: chain ID ${chain.id}, RPC ${PUBLIC_RPC}.`);
    }
    // Some wallets add without switching.
    if ((await readChain(p).catch(() => 0)) !== chain.id) {
      try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
      catch (e2) { if (isRejected(e2)) throw new Error("Network switch was cancelled. Tap “Switch network” when you're ready."); }
    }
  }
  return (await readChain(p).catch(() => 0)) === chain.id;
}

export function friendly(e: unknown, fallback = "Connection failed.") {
  if (e instanceof Error && errCode(e) === undefined && e.message) return e.message.split("\n")[0];
  if (isRejected(e)) return "Request cancelled in your wallet.";
  if (errCode(e) === -32002) return "Your wallet already has a pending request. Open the wallet and approve or reject it.";
  const m = msgOf(e).split("\n")[0];
  return m || fallback;
}

export const isMobile = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

export function deepLinks(href = typeof location !== "undefined" ? location.href : "https://launchcast-zeta.vercel.app/") {
  const url = href.split("#")[0];
  const bare = url.replace(/^https?:\/\//, "");
  const enc = encodeURIComponent(url);
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "OKX Wallet", href: `https://www.okx.com/download?deeplink=${encodeURIComponent("okx://wallet/dapp/url?dappUrl=" + enc)}` },
  ];
}
