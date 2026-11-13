import { CurvePanel } from "./curve";
import { CAST_CURVE, CAST_LAUNCH_TX, CAST_TOKEN, CAST_VIBEVIBE, EXPLORER, OWNER, addr, short } from "./config";

/** The LaunchCast project token. The curve panel reads the live V6 curve every 20s. */
export function ProjectToken() {
  return <section id="cast" className="section">
    <div className="section-head"><span className="kicker">Project token</span><h2>$CAST</h2>
      <p className="muted">LaunchCast has its own token on vibe/vibe. It launched on the same V6 bonding curve as every launch on this site and graduated on 13 November 2026, so it now trades freely in its Uniswap v4 pool. You can stake $CAST on the markets marked “Stake $CAST”, which settle from on-chain FDV just like the tUSD markets.</p></div>
    <div className="cast-card">
      <div className="cast-id">
        <img src="/cast-logo.png" alt="LaunchCast logo" width={64} height={64} />
        <div><b>LaunchCast <small>$CAST</small></b><span className="muted">VibeVibe launch #3277 · ETH pair · created by the LaunchCast owner wallet <a href={addr(OWNER)} target="_blank" rel="noreferrer">{short(OWNER)}</a></span></div>
      </div>
      <CurvePanel curve={CAST_CURVE} title="$CAST bonding curve · graduated" />
      <div className="cast-links">
        <a className="btn btn-primary sm" href={CAST_VIBEVIBE} target="_blank" rel="noreferrer">Trade on vibe/vibe ↗</a>
        <a className="btn sm" href="#markets">Stake $CAST on markets</a>
        <a className="btn sm" href={addr(CAST_TOKEN)} target="_blank" rel="noreferrer">Token {short(CAST_TOKEN)} ↗</a>
        <a className="btn sm" href={`${EXPLORER}/tx/${CAST_LAUNCH_TX}`} target="_blank" rel="noreferrer">Launch transaction ↗</a>
      </div>
    </div>
  </section>;
}

export function CastBadge() {
  return <a className="cast-badge" href="#cast"><img src="/cast-logo.png" alt="" width={18} height={18} />$CAST <span>project token</span></a>;
}
