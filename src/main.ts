/**
 * The replay report.
 *
 * `bun run replay` prints, per day and per account: the events booked that day
 * with their decisions, the closing ledger balance, any overdraft fee, the
 * day's interest, and -- on the capitalization day -- the credited total and
 * the final balance.
 *
 * This module only formats. Every number it prints comes from `replay()`; it
 * decides nothing, so the report can never disagree with the ledger it reads.
 */

import { add } from "dinero.js/bigint";

import type { AccountClose, DayClose } from "./engine";
import type { Ledger, LedgerRecord } from "./ledger";
import { formatWithCode, zero } from "./money";
import { WINDOW, replay } from "./replay";

/** Applied → what a reader calls that outcome; authorizations read differently. */
function outcomeLabel(record: LedgerRecord): string {
  const applied = record.event.kind === "AUTHORIZATION" ? "approved" : "applied";
  const rejected = record.event.kind === "AUTHORIZATION" ? "declined" : "rejected";
  if (record.decision === "APPLIED") return applied;
  return record.reason ? `${rejected}: ${record.reason}` : rejected;
}

/** The signed amount a record moved: its net posting, or its face if it posted nothing. */
function amountLabel(ledger: Ledger, record: LedgerRecord): string {
  if (record.postings.length > 0) {
    const currency = ledger.currencyOf(record.event.accountId);
    const net = record.postings.reduce((sum, posting) => add(sum, posting.amount), zero(currency));
    return formatWithCode(net);
  }
  return "amount" in record.event ? formatWithCode(record.event.amount) : "";
}

/** The identifier a record hangs off: the authorization it names, or the event it reverses. */
function referenceLabel(record: LedgerRecord): string {
  const event = record.event;
  if (event.kind === "AUTHORIZATION" || event.kind === "SETTLEMENT") return event.authorizationId;
  if (event.kind === "REVERSAL") return `reverses ${event.reverses}`;
  if (event.kind === "CREDIT" && event.instalments !== undefined) {
    return `${event.instalments} instalments`;
  }
  return "";
}

function describeEvent(ledger: Ledger, record: LedgerRecord): string {
  const event = record.event;
  const parts = [
    event.id.padEnd(3),
    event.kind.padEnd(14),
    amountLabel(ledger, record).padEnd(14),
    referenceLabel(record).padEnd(20),
    outcomeLabel(record),
  ];
  // The bitemporal bit worth surfacing: an entry effective before it was booked.
  const backValued = event.valueDate < event.bookedDay ? `  (value date ${event.valueDate})` : "";
  return `    ${parts.join(" ")}${backValued}`.trimEnd();
}

function describeClose(account: AccountClose): string {
  const parts = [`  ${account.accountId}`];
  if (account.fee !== undefined) {
    parts.push(`pre-fee ${formatWithCode(account.preFeeBalance)}`, `fee ${formatWithCode(account.fee)}`);
  }
  parts.push(`close ${formatWithCode(account.closingBalance)}`);
  parts.push(`interest ${formatWithCode(account.interest)}`);
  if (account.capitalized !== undefined) {
    parts.push(
      `capitalized ${formatWithCode(account.capitalized)}`,
      `→ final ${formatWithCode(account.finalBalance)}`,
    );
  }
  return parts.join("   ");
}

function describeDay(ledger: Ledger, day: DayClose, feed: readonly LedgerRecord[]): string[] {
  const booked = feed.filter((record) => record.event.bookedDay === day.day);
  const lines = [`Day ${day.day}`];
  if (booked.length > 0) {
    lines.push("  Events", ...booked.map((record) => describeEvent(ledger, record)));
  }
  lines.push(...day.accounts.map(describeClose));
  return lines;
}

/** The full report as one string, so it can be printed or asserted against. */
export function renderReport(): string {
  const { ledger, records, closes } = replay();
  const body = closes.flatMap((day) => ["", ...describeDay(ledger, day, records)]);
  return [`Ledger replay — ${WINDOW} days, ${ledger.accountIds.length} accounts`, ...body].join("\n");
}

if (import.meta.main) {
  console.log(renderReport());
}
