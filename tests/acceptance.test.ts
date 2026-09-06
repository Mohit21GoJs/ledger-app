import { describe, expect, test } from "bun:test";
import { add } from "dinero.js/bigint";

import { availableBalance, holdsOn, ingest } from "../src/engine";
import { AED, BHD, decimal, zero } from "../src/money";
import { ACC_AED, ACC_BHD, replay } from "../src/replay";
import { authorize, closeOf, credit, eventsOfKind, newLedger } from "./support";

/**
 * The brief's eight acceptance criteria, one test each.
 *
 * Four are accepted and asserted as stated. Four are rejected -- and a rejected
 * criterion is not skipped: each is pinned to the ACTUAL behaviour that refutes
 * it, so the disagreement is a fact the suite proves, not an opinion in a doc.
 * The reasoning for every verdict is in AMBIGUITIES.md and NUMBERS.md.
 *
 * Everything below reads the single real replay, so these are assertions about
 * the exact stream the brief supplies, not about a convenient fixture.
 */
const { ledger, records, closes } = replay();

const recordOf = (id: string) => records.find((record) => record.event.id === id);
const fees = eventsOfKind(ledger, "OVERDRAFT_FEE");

describe("accepted criteria", () => {
  /** 1. The restated Day-2 balance, known through Day 5, pre-fee, is -370.00. */
  test("criterion 1: Day-2 value balance known through Day 5 is -370.00", () => {
    // The fee is value-dated Day 5, so a value-date-2 balance is pre-fee by
    // construction: 1200 - 950 - 620 = -370.00.
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 5))).toBe("-370.00");
  });

  /** 3. The Day-4 settlement of Auth-A is accepted. */
  test("criterion 3: E5 settles Auth-A and is applied", () => {
    expect(recordOf("E5")?.decision).toBe("APPLIED");
    expect(recordOf("E5")?.postings.map((p) => decimal(p.amount))).toEqual(["-185.00"]);
  });

  /** 4. A settlement of an unknown authorization is rejected; funds stay. */
  test("criterion 4: E6 settles an unknown auth, rejected with no postings", () => {
    expect(recordOf("E6")?.decision).toBe("REJECTED");
    expect(recordOf("E6")?.reason).toBe("NO_SUCH_AUTHORIZATION");
    expect(recordOf("E6")?.postings).toHaveLength(0);
    // The Day-4 close is unmoved by the rejected attempt.
    expect(decimal(closeOf(closes[3], ACC_AED).closingBalance)).toBe("465.00");
  });

  /**
   * 5. An approved hold reduces available balance but not ledger balance.
   *
   * The rule is right and is implemented. But its antecedent is false on this
   * stream: Auth-B (E8) is DECLINED, because available is already -155.00 on
   * Day 5. So the criterion is a true conditional that this stream never fires;
   * both halves are pinned. See AMBIGUITIES section 7.
   */
  test("criterion 5: the hold rule holds, but Auth-B's antecedent is false here", () => {
    // The rule, on an approved hold.
    const fixture = newLedger();
    ingest(fixture, credit("C1", "1200.00", { on: 1 }));
    ingest(fixture, authorize("A1", "Auth-X", "200.00", { on: 1 }));
    expect(decimal(fixture.balanceAsOf(ACC_AED, 1, 1))).toBe("1200.00");
    expect(decimal(availableBalance(fixture, ACC_AED, 1))).toBe("1000.00");

    // This stream: Auth-B is declined, so no such hold ever exists.
    expect(recordOf("E8")?.decision).toBe("REJECTED");
    expect(recordOf("E8")?.reason).toBe("INSUFFICIENT_AVAILABLE_BALANCE");
    expect(decimal(holdsOn(ledger, ACC_AED, 5))).toBe("0.00");
  });
});

describe("rejected criteria, pinned to the behaviour that refutes them", () => {
  /**
   * 2. "E7 causes exactly one fee, on Day 2." REJECTED.
   *
   * There is exactly one fee, but it is value-dated Day 5 -- the day E7 became
   * known -- not Day 2. A fee is booked with value date equal to the day
   * assessed, and a closed day is never re-opened. See AMBIGUITIES section 3.
   */
  test("criterion 2: the one fee is dated Day 5, not Day 2", () => {
    expect(fees).toHaveLength(1);
    expect(fees[0]?.event.valueDate).toBe(5);
    expect(fees[0]?.event.valueDate).not.toBe(2);
  });

  /**
   * 6. "After E9 all balances and fees return to pre-E7 values." REJECTED.
   *
   * The pre-E7 close (Day 4) was 465.00. After E9 the Day-6 close is 440.00:
   * the 620.00 comes back, the 25.00 fee stands. Reversing a debit is not
   * authority to reverse a separately assessed charge. See AMBIGUITIES 9.
   */
  test("criterion 6: after E9 the close is 440.00, not the pre-E7 465.00", () => {
    expect(decimal(closeOf(closes[3], ACC_AED).closingBalance)).toBe("465.00");
    expect(recordOf("E9")?.decision).toBe("APPLIED");
    expect(decimal(closeOf(closes[5], ACC_AED).closingBalance)).toBe("440.00");
    expect(decimal(closeOf(closes[5], ACC_AED).closingBalance)).not.toBe("465.00");
    // The fee was not unwound: still exactly one, still standing.
    expect(fees).toHaveLength(1);
  });

  /**
   * 7. "Each BHD instalment is 3.334." REJECTED.
   *
   * Three of 3.334 sum to 10.002, inventing 0.002. Conservation wins over
   * equality: the instalments are 3.334 + 3.333 + 3.333 = 10.000. See
   * AMBIGUITIES section 8.
   */
  test("criterion 7: the instalments conserve the total instead of being equal", () => {
    expect(recordOf("E10")?.postings.map((p) => decimal(p.amount))).toEqual([
      "3.334",
      "3.333",
      "3.333",
    ]);
    expect(decimal(ledger.balanceAsOf(ACC_BHD, 5, 5))).toBe("10.000");
  });

  /**
   * 8. "Any unmatched interest remainder is discarded." REJECTED.
   *
   * There is no remainder to discard: the capitalized credit IS the sum of the
   * stored rounded daily accruals, so the exact-sum rule holds by construction.
   * See AMBIGUITIES section 4 and the interest suite.
   */
  test("criterion 8: capitalization is the exact sum of the stored accruals", () => {
    const aedDaily = closes.map((close) => closeOf(close, ACC_AED).interest);
    const aedCapitalized = closeOf(closes[5], ACC_AED).capitalized!;
    expect(decimal(aedDaily.reduce(add, zero(AED)))).toBe(decimal(aedCapitalized));
    expect(decimal(aedCapitalized)).toBe("0.83");

    const bhdDaily = closes.map((close) => closeOf(close, ACC_BHD).interest);
    const bhdCapitalized = closeOf(closes[5], ACC_BHD).capitalized!;
    expect(decimal(bhdDaily.reduce(add, zero(BHD)))).toBe(decimal(bhdCapitalized));
    expect(decimal(bhdCapitalized)).toBe("0.008");
  });
});
