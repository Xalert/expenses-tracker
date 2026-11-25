// The wallet page's "Reconcile balance" panel, rendered to static markup in its states: fresh (the tracked balance as
// of today), after a failed save (errors on the fields, values echoed), and after a save (the confirmation, a link to
// the entry's month when it is not the month shown).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReconcileForm, type ReconcileFormProps } from "@/components/wallets/reconcile-form";
import { nextMenuIndex, WalletMenu } from "@/components/wallets/wallet-menu";
import type { FormState } from "@/lib/form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back() {}, refresh() {}, push() {}, replace() {} }) }));
vi.mock("@/app/(app)/wallets/actions", () => {
  const noop = async () => ({});
  return {
    archiveWalletAction: noop,
    unarchiveWalletAction: noop,
    deleteWalletAction: noop,
  };
});

const base: ReconcileFormProps = {
  action: async () => ({}),
  walletId: 7,
  walletName: "Bank",
  currency: "EUR",
  today: "2026-11-25",
  initialBalanceMinor: 100_000,
  closings: [["2026-11-20", 98_000]],
  closeHref: "/wallets/7",
  month: "2026-11",
  walletHref: "/wallets/7",
};

const render = (state?: FormState, props: Partial<ReconcileFormProps> = {}) =>
  renderToStaticMarkup(<ReconcileForm {...base} {...props} initialState={state} />);

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("ReconcileForm", () => {
  it("fresh: labelled fields, today's date, the tracked balance and a Close link back to the page", () => {
    const html = render();
    expect(html).toContain('aria-labelledby="reconcile-heading"');
    expect(html).toMatch(/<label[^>]*for="actualBalance"[^>]*>Actual balance<\/label>/);
    expect(html).toMatch(/<input[^>]*name="actualBalance"[^>]*value=""/);
    expect(html).toContain('<input type="hidden" name="date" value="2026-11-25"/>');
    expect(text(html)).toContain("Tracked balance at the end of today: €980.00.");
    expect(text(html)).not.toContain("This adds");
    expect(html).toMatch(/<a[^>]*href="\/wallets\/7"[^>]*>Close<\/a>/);
    expect(text(html)).toContain("Record adjustment");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });

  it("after a failed save: the errors on their fields and the typed values back, with the preview", () => {
    const html = render({
      fieldErrors: { date: "Choose today or an earlier date." },
      values: { actualBalance: "975.50", date: "2026-11-10" },
    });
    expect(html).toMatch(/<button[^>]*id="reconcile-date"[^>]*aria-invalid="true"[^>]*aria-describedby="reconcile-date-error"/);
    expect(html).not.toMatch(/<input[^>]*id="actualBalance"[^>]*aria-invalid/);
    expect(html).toContain('id="reconcile-date-error"');
    expect(html).toMatch(/<input[^>]*name="actualBalance"[^>]*value="975.50"/);
    // The echoed date: the tracked balance on 10 Nov is still the initial one.
    expect(html).toContain('name="date" value="2026-11-10"');
    expect(text(html)).toContain("Tracked balance at the end of 10 Nov 2026: €1,000.00. This adds an expense of €24.50.");
  });

  it("an amount error marks the balance input and a form message shows as an alert", () => {
    const html = render({ message: "This wallet is archived.", fieldErrors: { actualBalance: "Enter a valid amount in EUR (up to 2 decimals)." }, values: { actualBalance: "x" } });
    expect(html).toMatch(/role="alert"[^>]*>This wallet is archived\./);
    expect(html).toMatch(/<input[^>]*id="actualBalance"[^>]*aria-invalid="true"/);
    expect(html).toContain('id="actualBalance-error"');
  });

  it("previews income and a match", () => {
    expect(text(render({ values: { actualBalance: "980.01" } }))).toContain("This adds income of €0.01.");
    expect(text(render({ values: { actualBalance: "980" } }))).toContain("The balance already matches. Nothing will be added.");
  });

  it("after a save: the confirmation, the fields cleared, and a link to another month", () => {
    const ok = render({ ok: true, message: "Added an expense of €12.40 on 25 Nov 2026.", values: { date: "2026-11-25" } });
    expect(ok).toMatch(/role="status"[^>]*>Added an expense of €12\.40 on 25 Nov 2026\./);
    expect(ok).toMatch(/<input[^>]*name="actualBalance"[^>]*value=""/);
    expect(ok).not.toContain("Show ");
    const past = render({ ok: true, message: "Added income of €1.00 on 3 Oct 2026.", values: { date: "2026-10-03" } });
    expect(past).toMatch(/<a[^>]*href="\/wallets\/7\?month=2026-10&amp;reconcile=1"[^>]*>Show October 2026<\/a>/);
  });
});

describe("WalletMenu", () => {
  it("names its trigger so the reconcile panel can return focus to it", () => {
    const html = renderToStaticMarkup(
      <WalletMenu walletId={7} walletName="Bank" archived={false} canDelete={false} reconcileHref="/wallets/7?reconcile=1" />,
    );
    expect(html).toContain('id="wallet-menu-7"');
    expect(nextMenuIndex("ArrowDown", -1, 3)).toBe(0);
  });
});
