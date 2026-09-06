import { describe, expect, test } from "bun:test";

import { decimal } from "../src/money";
import { ACC_AED, ACC_BHD, STREAM, replay } from "../src/replay";
import { closeOf, eventsOfKind } from "./support";

/**
 * The whole brief, end to end, over the real E1…E10 stream with the genuine
 * REVERSAL event -- not the credit stand-in the interest tests use.
 *
 * The numbers here are the acceptance target from NUMBERS.md; this is where
 * they are pinned against the actual replay rather than a hand-built fixture.
 */
describe("the six-day replay", () => {
  const { ledger, records, closes } = replay();

  test("commits the stream in the literal supplied order", () => {
    // E9 is fed before E10 though it is booked a day later. The feed order
    // survives; the ledger never sorts it. See AMBIGUITIES section 2.
    expect(records.map((record) => record.event.id)).toEqual(STREAM.map((event) => event.id));
    expect(ledger.records.slice(0, STREAM.length).map((record) => record.event.id)).toEqual([
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
      "E8",
      "E9",
      "E10",
    ]);
  });

  test("closes ACC-001 at 250 / 250 / 650 / 465 / -180 / 440", () => {
    expect(closes.map((close) => decimal(closeOf(close, ACC_AED).closingBalance))).toEqual([
      "250.00",
      "250.00",
      "650.00",
      "465.00",
      "-180.00",
      "440.00",
    ]);
  });

  test("assesses exactly one overdraft fee, AED 25.00 on Day 5", () => {
    const fees = eventsOfKind(ledger, "OVERDRAFT_FEE");
    expect(fees).toHaveLength(1);
    expect(fees[0]?.event.accountId).toBe(ACC_AED);
    expect(fees[0]?.event.valueDate).toBe(5);
    expect(decimal(closeOf(closes[4], ACC_AED).fee!)).toBe("25.00");
  });

  test("capitalizes AED 0.83 and closes ACC-001 at 440.83", () => {
    const day6 = closeOf(closes[5], ACC_AED);
    expect(decimal(day6.capitalized!)).toBe("0.83");
    expect(decimal(day6.finalBalance)).toBe("440.83");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 6, 6))).toBe("440.83");
  });

  test("capitalizes BHD 0.008 and closes ACC-002 at 10.008", () => {
    const day6 = closeOf(closes[5], ACC_BHD);
    expect(decimal(day6.capitalized!)).toBe("0.008");
    expect(decimal(day6.finalBalance)).toBe("10.008");
    expect(decimal(ledger.balanceAsOf(ACC_BHD, 6, 6))).toBe("10.008");
  });

  test("records E6, E8 and E9 with the decisions the stream calls for", () => {
    const outcome = (id: string) => records.find((record) => record.event.id === id);

    // E6 settles an authorization that never existed: rejected, zero postings.
    expect(outcome("E6")?.decision).toBe("REJECTED");
    expect(outcome("E6")?.reason).toBe("NO_SUCH_AUTHORIZATION");
    expect(outcome("E6")?.postings).toHaveLength(0);

    // E8 (Auth-B) is declined -- available is already negative on Day 5.
    expect(outcome("E8")?.decision).toBe("REJECTED");
    expect(outcome("E8")?.reason).toBe("INSUFFICIENT_AVAILABLE_BALANCE");

    // E9 reverses E7 and posts the 620.00 back at Day 2.
    expect(outcome("E9")?.decision).toBe("APPLIED");
    expect(outcome("E9")?.postings.map((p) => decimal(p.amount))).toEqual(["620.00"]);
    expect(outcome("E9")?.postings.map((p) => p.valueDate)).toEqual([2]);
  });

  test("posts E10 as three conserving BHD instalments", () => {
    const e10 = records.find((record) => record.event.id === "E10");
    expect(e10?.postings.map((p) => decimal(p.amount))).toEqual(["3.334", "3.333", "3.333"]);
  });

  test("never restates a sealed day's own close", () => {
    // Day 2 closed at +250.00 on Day 2 and stays there, though the restated
    // view -- knowing E7 through Day 5 -- is -370.00. See AMBIGUITIES section 1.
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 2))).toBe("250.00");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 5))).toBe("-370.00");
  });
});
