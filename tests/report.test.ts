import { describe, expect, test } from "bun:test";

import { renderReport } from "../src/main";

/**
 * The report only formats numbers the replay already produces, so it is not
 * re-tested here -- the six-day arithmetic is pinned in replay.test.ts. What
 * this guards is that each required section actually reaches the page: closing
 * balances, the fee, the authorization outcomes, and the errors.
 */
describe("replay report", () => {
  const report = renderReport();

  test("prints every day and both accounts", () => {
    for (const day of [1, 2, 3, 4, 5, 6]) expect(report).toContain(`Day ${day}`);
    expect(report).toContain("ACC-001");
    expect(report).toContain("ACC-002");
  });

  test("prints the closing balances and the capitalized finals", () => {
    expect(report).toContain("close AED -180.00");
    expect(report).toContain("final AED 440.83");
    expect(report).toContain("final BHD 10.008");
  });

  test("prints the one fee, value-dated the day assessed", () => {
    expect(report).toContain("fee AED 25.00");
    // One fee only: the string appears exactly once.
    expect(report.match(/fee AED 25\.00/g)).toHaveLength(1);
  });

  test("prints the authorization outcomes and the errors", () => {
    expect(report).toContain("Auth-A               approved");
    expect(report).toContain("declined: INSUFFICIENT_AVAILABLE_BALANCE");
    expect(report).toContain("rejected: NO_SUCH_AUTHORIZATION");
  });

  test("flags the back-valued entries", () => {
    // E7 and E9 are both effective on Day 2 though booked later.
    expect(report.match(/\(value date 2\)/g)).toHaveLength(2);
  });
});
