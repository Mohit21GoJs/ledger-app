import { describe, expect, test } from "bun:test";

import { ingest } from "../src/engine";
import type { Ledger } from "../src/ledger";
import { credit, debit, closeThrough, newLedger } from "../tests/support";

/**
 * THE ONE DELIBERATE FAILURE. Run it with `bun run test:known-failing`; it is
 * kept out of the green suite on purpose and MUST NOT be added to it.
 *
 * ── The property being asserted ─────────────────────────────────────────────
 * Two ledgers holding IDENTICAL value-dated entries should assess IDENTICAL
 * fees, whatever order the entries happened to arrive in. Most people assume a
 * ledger has this property. This design does not, and cannot, and the failure
 * is the honest way to show it rather than hide it.
 *
 * ── Why it fails ────────────────────────────────────────────────────────────
 * The overdraft fee is decided at knowledge time (AMBIGUITIES section 3): each
 * day's fee is settled once, at that day's close, from what was known then, and
 * a closed day is never re-opened. So the fee history is a function of
 * (ledger content, ARRIVAL ORDER), not of ledger content alone.
 *
 * Both ledgers below hold the same three value-dated entries:
 *   +1000 valued Day 1,  -1200 valued Day 2,  +1500 valued Day 3.
 * The value-time balance dips to -200 on Day 2 and recovers on Day 3 in BOTH.
 * The only difference is when the -1200 debit ARRIVES:
 *
 *   Ledger A — it arrives on Day 2 (booked in order). The Day-2 close sees the
 *              dip and charges one fee, value-dated Day 2.
 *   Ledger B — it arrives on Day 5 (booked late, still valued Day 2). By the
 *              time the bank learns of it, the Day-3 credit is also known, so
 *              no close ever observed a negative balance. No fee is charged.
 *
 * Same entries, same value dates, different fees: {Day 2} vs {}. The assertion
 * that they are equal therefore fails — by construction, not by defect.
 *
 * ── Why every "fix" is worse ────────────────────────────────────────────────
 *   • Back-date the fee to the value date it belongs to. Breaks the brief's
 *     non-negotiable rule that a fee is value-dated the day ASSESSED, and dates
 *     a customer charge before the bank knew the fact that caused it.
 *   • Issue catch-up fees, dated today, for every value-day that was retroactively
 *     overdrawn. On the real E7 stream that charges three AED 25.00 in a single
 *     day for one back-valued debit.
 *   • Recompute the whole window from scratch on each arrival. Breaks
 *     append-only: published closes get silently rewritten, so no figure is
 *     ever final.
 *   • Defer all assessment to the end of the window, once the feed is complete.
 *     That is no longer a DAILY overdraft fee; it is a different product.
 *
 * Each repair costs more than the property is worth. The property is genuinely
 * lost, and this test is where that loss is admitted out loud.
 */

/** The value dates of the overdraft fees a ledger assessed, in order. */
function feeValueDates(ledger: Ledger): number[] {
  return ledger.records
    .filter((record) => record.event.kind === "OVERDRAFT_FEE")
    .map((record) => record.event.valueDate);
}

/** Ingest a stream, then close Days 1–5. Two passes, no interleaving. */
function run(build: (ledger: Ledger) => void): Ledger {
  const ledger = newLedger();
  build(ledger);
  closeThrough(ledger, 5);
  return ledger;
}

describe("fee history should be independent of arrival order (it is not)", () => {
  test("identical value-dated entries assess identical fees", () => {
    // Arrives in booking order: the Day-2 dip is seen, and charged.
    const inOrder = run((ledger) => {
      ingest(ledger, credit("C1", "1000.00", { on: 1 }));
      ingest(ledger, debit("D", "1200.00", { on: 2 }));
      ingest(ledger, credit("C2", "1500.00", { on: 3 }));
    });

    // Same entries, but the debit arrives on Day 5: the dip is never observed.
    const lateArrival = run((ledger) => {
      ingest(ledger, credit("C1", "1000.00", { on: 1 }));
      ingest(ledger, credit("C2", "1500.00", { on: 3 }));
      ingest(ledger, debit("D", "1200.00", { on: 5, valued: 2 }));
    });

    // The design charges {Day 2} in one and {} in the other. This is the
    // arrival-order dependence, stated as the failure it is.
    expect(feeValueDates(lateArrival)).toEqual(feeValueDates(inOrder));
  });
});
