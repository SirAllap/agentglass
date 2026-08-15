/**
 * A page, drawn rather than embedded — the demo build's stand-in for a guest.
 *
 * See `lib/demoBrowser.ts` for why the demo has a browser view at all. This
 * component only has to be a convincing PAGE: everything that makes it a
 * browser — the strip, the address bar, find, the profile menu — is the real
 * panel around it.
 *
 * It carries its own light palette on purpose and does NOT follow the app's
 * theme. A page does not: a real browser showing a real site inside this panel
 * is a bright rectangle in a dark window, and that contrast is most of what
 * makes the view read as a browser rather than as another panel.
 */
import { DEMO_BASKET, DEMO_DISCOUNT, DEMO_HEALTH, DEMO_SHIPPING, money, subtotal, total } from "../../lib/demoBrowser.ts";

const PAPER = "#fbfaf7";
const INK = "#1f2328";
const MUTED = "#6b7280";
const LINE = "#e6e2da";
const BRAND = "#1c5b4a";

function Storefront({ checkout }: { checkout: boolean }) {
  return (
    <div style={{ minHeight: "100%", background: PAPER, color: INK, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 28px", borderBottom: `1px solid ${LINE}` }}>
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: BRAND }}>Harbour Goods</span>
        <nav style={{ display: "flex", gap: 18, fontSize: 13, color: MUTED }}>
          <span>Rope</span><span>Brass</span><span>Deck</span><span>Charts</span>
        </nav>
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: MUTED }}>
          Basket · {DEMO_BASKET.reduce((n, l) => n + l.qty, 0)} items
        </span>
      </header>

      <div style={{ padding: "26px 28px", maxWidth: 760 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: "-0.01em" }}>
          {checkout ? "Checkout" : "Your basket"}
        </h1>
        <p style={{ fontSize: 13, color: MUTED, margin: "0 0 22px" }}>
          {checkout ? "Two of the same line, one discount." : "Nothing here has shipped yet — this is the dev server on :5173."}
        </p>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: MUTED, fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <th style={{ padding: "0 0 8px" }}>Item</th>
              <th style={{ padding: "0 0 8px", width: 60, textAlign: "right" }}>Qty</th>
              <th style={{ padding: "0 0 8px", width: 90, textAlign: "right" }}>Each</th>
              <th style={{ padding: "0 0 8px", width: 90, textAlign: "right" }}>Line</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_BASKET.map((l) => (
              <tr key={l.name} style={{ borderTop: `1px solid ${LINE}` }}>
                <td style={{ padding: "8px 0" }}>{l.name}</td>
                <td style={{ padding: "8px 0", textAlign: "right" }}>{l.qty}</td>
                <td style={{ padding: "8px 0", textAlign: "right", color: MUTED }}>{money(l.each)}</td>
                <td style={{ padding: "8px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(l.qty * l.each)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 18, marginLeft: "auto", width: 260, fontSize: 13.5 }}>
          {[["Subtotal", money(subtotal())], ["Discount HARBOUR5", `−${money(DEMO_DISCOUNT)}`], ["Shipping", money(DEMO_SHIPPING)]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", color: MUTED }}>
              <span>{k}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 0", marginTop: 6, borderTop: `1px solid ${LINE}`, fontWeight: 600 }}>
            <span>Total</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{money(total())}</span>
          </div>
          <button style={{ marginTop: 14, width: "100%", padding: "8px 0", border: "none", borderRadius: 6, background: BRAND, color: "#fff", fontSize: 13.5, fontWeight: 500 }}>
            {checkout ? "Pay " + money(total()) : "Checkout"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Json() {
  return (
    <div style={{ minHeight: "100%", background: "#fff", color: INK, padding: "18px 22px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, lineHeight: 1.65 }}>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(DEMO_HEALTH, null, 2)}</pre>
    </div>
  );
}

/** An address the demo has no page for. Chromium's own wording, because a
 *  visitor who types something into the bar should get the answer a browser
 *  gives rather than one this app invented. */
function NotReached({ url }: { url: string }) {
  let host = url;
  try { host = new URL(url).host || url; } catch { /* whatever was typed */ }
  return (
    <div style={{ minHeight: "100%", background: "#fff", color: INK, padding: "56px 60px", fontFamily: "ui-sans-serif, system-ui, sans-serif", maxWidth: 620 }}>
      <div style={{ fontSize: 44, lineHeight: 1, color: "#c9ccd1", marginBottom: 22 }}>⚠</div>
      <h1 style={{ fontSize: 19, fontWeight: 500, margin: "0 0 10px" }}>This page isn’t in the demo</h1>
      <p style={{ fontSize: 13.5, color: MUTED, margin: "0 0 6px", lineHeight: 1.6 }}>
        <b style={{ color: INK, fontWeight: 500 }}>{host}</b> was not fetched. The demo runs entirely in this
        tab and reaches nothing, so its browser shows pages that were written into it.
      </p>
      <p style={{ fontSize: 13.5, color: MUTED, margin: 0, lineHeight: 1.6 }}>
        Run agentglass locally and this view is a real browser — logged into what you are
        logged into, and drivable by an agent.
      </p>
    </div>
  );
}

export function DemoPage({ url }: { url: string }) {
  const page = url.startsWith("http://localhost:3000")
    ? <Json />
    : url.startsWith("http://localhost:5173")
      ? <Storefront checkout={url.includes("/checkout")} />
      : <NotReached url={url} />;
  // Scrolls on its own, like a page. The panel gives it a fixed box and the
  // real guest scrolls inside one too.
  return <div style={{ width: "100%", height: "100%", overflow: "auto", background: "#fff" }}>{page}</div>;
}
