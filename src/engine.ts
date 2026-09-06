/**
 * The decision rules.
 *
 * The ledger records; the engine decides. Everything here answers one of two
 * questions: may this event be applied, and what does it post?
 *
 * Holds are not stored anywhere. An active hold is a fact about the record log
 * -- an approved authorization with no settlement against it -- so it is
 * derived on demand rather than kept in a second register that could drift out
 * of step with the log it is supposed to describe.
 */

import { add, isNegative, isPositive, subtract } from "dinero.js/bigint";

import type {
  Accrual,
  AuthorizationEvent,
  CreditEvent,
  Day,
  DebitEvent,
  Ledger,
  LedgerEvent,
  LedgerRecord,
  Posting,
  SettlementEvent,
} from "./ledger";
import { type LedgerCurrency, type Money, type Rate, accrue, parseAmount, split, zero } from "./money";

export type RejectionReason = "INSUFFICIENT_AVAILABLE_BALANCE" | "NO_SUCH_AUTHORIZATION";

function negated(currency: LedgerCurrency, amount: Money): Money {
  return subtract(zero(currency), amount);
}

function postingFor(event: LedgerEvent, amount: Money): Posting {
  return {
    eventId: event.id,
    accountId: event.accountId,
    bookedDay: event.bookedDay,
    valueDate: event.valueDate,
    amount,
  };
}

/** Applied events of one kind on one account, as known by `knownOn`. */
function appliedEvents<K extends LedgerEvent["kind"]>(
  ledger: Ledger,
  kind: K,
  accountId: string,
  knownOn: Day,
): Extract<LedgerEvent, { kind: K }>[] {
  return ledger.records
    .filter(
      (record) =>
        record.decision === "APPLIED" &&
        record.event.accountId === accountId &&
        record.event.bookedDay <= knownOn,
    )
    .map((record) => record.event)
    .filter((event): event is Extract<LedgerEvent, { kind: K }> => event.kind === kind);
}

/**
 * The sum of authorizations that are approved, known by `knownOn`, and not yet
 * settled.
 *
 * A settlement releases its authorization in full, whatever it settled for --
 * see AMBIGUITIES section 5.
 */
export function holdsOn(ledger: Ledger, accountId: string, knownOn: Day): Money {
  const settled = new Set(
    appliedEvents(ledger, "SETTLEMENT", accountId, knownOn).map((event) => event.authorizationId),
  );

  return appliedEvents(ledger, "AUTHORIZATION", accountId, knownOn)
    .filter((event) => !settled.has(event.authorizationId))
    .reduce((total, event) => add(total, event.amount), zero(ledger.currencyOf(accountId)));
}

/** Ledger balance minus active holds, as at the close of `on`. */
export function availableBalance(ledger: Ledger, accountId: string, on: Day): Money {
  return subtract(ledger.balanceAsOf(accountId, on, on), holdsOn(ledger, accountId, on));
}

/** The approved, still-unsettled authorization this settlement names, if any. */
function outstandingAuthorization(
  ledger: Ledger,
  event: SettlementEvent,
): AuthorizationEvent | undefined {
  const settled = new Set(
    appliedEvents(ledger, "SETTLEMENT", event.accountId, event.bookedDay).map(
      (settlement) => settlement.authorizationId,
    ),
  );
  if (settled.has(event.authorizationId)) return undefined;

  return appliedEvents(ledger, "AUTHORIZATION", event.accountId, event.bookedDay).find(
    (authorization) => authorization.authorizationId === event.authorizationId,
  );
}

function applyCredit(ledger: Ledger, event: CreditEvent): LedgerRecord {
  // "Posted as N instalments" means N postings under one event, summing to the
  // face amount exactly -- see AMBIGUITIES section 8.
  const amounts =
    event.instalments === undefined ? [event.amount] : split(event.amount, event.instalments);

  return ledger.append({
    event,
    decision: "APPLIED",
    postings: amounts.map((amount) => postingFor(event, amount)),
  });
}

function applyDebit(ledger: Ledger, event: DebitEvent): LedgerRecord {
  // A debit may overdraw. Whether that costs a fee is settled at the day close,
  // not here: the fee is a property of a closing balance, not of one entry.
  return ledger.append({
    event,
    decision: "APPLIED",
    postings: [postingFor(event, negated(ledger.currencyOf(event.accountId), event.amount))],
  });
}

/**
 * Approve only if available balance -- ledger balance minus active holds --
 * remains at or above zero once this hold is applied. The floor is zero and it
 * is inclusive.
 *
 * An approved authorization posts NOTHING. A hold is a claim against
 * availability, not a movement of money, which is the rule acceptance
 * criterion 5 states correctly.
 */
function decideAuthorization(ledger: Ledger, event: AuthorizationEvent): LedgerRecord {
  const remaining = subtract(
    availableBalance(ledger, event.accountId, event.bookedDay),
    event.amount,
  );

  if (isNegative(remaining)) {
    return ledger.append({
      event,
      decision: "REJECTED",
      reason: "INSUFFICIENT_AVAILABLE_BALANCE" satisfies RejectionReason,
      postings: [],
    });
  }
  return ledger.append({ event, decision: "APPLIED", postings: [] });
}

/**
 * A settlement must name an authorization that exists, was approved, and has
 * not already been settled. Otherwise it is rejected with no postings: the
 * attempt stays in the record log, but no money moves.
 */
function decideSettlement(ledger: Ledger, event: SettlementEvent): LedgerRecord {
  if (!outstandingAuthorization(ledger, event)) {
    return ledger.append({
      event,
      decision: "REJECTED",
      reason: "NO_SUCH_AUTHORIZATION" satisfies RejectionReason,
      postings: [],
    });
  }

  return ledger.append({
    event,
    decision: "APPLIED",
    postings: [postingFor(event, negated(ledger.currencyOf(event.accountId), event.amount))],
  });
}

/**
 * The overdraft fee, keyed by CURRENCY CODE rather than by account.
 *
 * There is no BHD entry, deliberately. The brief names AED 25.00 and is silent
 * on BHD; converting it would need an FX rate this ledger does not have and
 * must not invent. An overdrawn BHD account therefore fails loudly instead of
 * being charged a guess. See NUMBERS.md.
 */
const OVERDRAFT_FEE: Readonly<Record<string, string>> = Object.freeze({ AED: "25.00" });

/**
 * 0.04% per day, as an exact scaled integer: 4 / 10^4.
 *
 * Held exactly rather than as 0.0004 so that rounding happens once, inside
 * `accrue`, where it is chosen. See NUMBERS.md.
 */
const DAILY_INTEREST_RATE: Rate = Object.freeze({ amount: 4n, scale: 4n });

/** The day accrued interest becomes a single credit. */
const CAPITALIZE_ON: Day = 6;

export type AccountClose = {
  readonly accountId: string;
  /** The balance the fee decision was made on. */
  readonly preFeeBalance: Money;
  /** The fee assessed, when one was. */
  readonly fee?: Money;
  /** What the day closed at, fee included. This is what interest accrued on. */
  readonly closingBalance: Money;
  /** This day's accrual. Zero unless the closing balance was positive. */
  readonly interest: Money;
  /** On the capitalization day: the single credit, being the sum of the accruals. */
  readonly capitalized?: Money;
  /** The ledger balance once the day is finished, capitalization included. */
  readonly finalBalance: Money;
};

export type DayClose = {
  readonly day: Day;
  readonly accounts: readonly AccountClose[];
};

function feeFor(currency: LedgerCurrency, accountId: string, day: Day): Money {
  const scheduled = OVERDRAFT_FEE[currency.code];
  if (scheduled === undefined) {
    throw new Error(
      `NO_FEE_SCHEDULE: account ${accountId} is overdrawn on day ${day} in ` +
        `${currency.code}, and no overdraft fee is defined for that currency. ` +
        `Converting the AED fee would need an FX rate this ledger does not have.`,
    );
  }
  return parseAmount(currency, scheduled);
}

function assessOverdraftFee(ledger: Ledger, accountId: string, day: Day): Money {
  const currency = ledger.currencyOf(accountId);
  const fee = feeFor(currency, accountId, day);
  const id = `FEE-${accountId}-D${day}`;

  ledger.append({
    event: { kind: "OVERDRAFT_FEE", id, accountId, bookedDay: day, valueDate: day, amount: fee },
    decision: "APPLIED",
    postings: [
      { eventId: id, accountId, bookedDay: day, valueDate: day, amount: negated(currency, fee) },
    ],
  });
  return fee;
}

/**
 * A day's accrual: 0.04% of what that day closed at, positive balances only.
 *
 * `balanceAsOf(account, d, d)` is stable once day `d` is sealed -- nothing can
 * be booked into a closed day -- so a past day's accrual is a fact that can be
 * recomputed rather than a number that has to be stored and kept in step.
 */
function accrualOn(ledger: Ledger, accountId: string, day: Day): Money {
  const currency = ledger.currencyOf(accountId);
  const base = ledger.balanceAsOf(accountId, day, day);
  return isPositive(base) ? accrue(base, DAILY_INTEREST_RATE) : zero(currency);
}

/**
 * Capitalize the window's accruals as one credit.
 *
 * The credit IS the sum of the stored daily amounts, so "the rounded daily
 * accruals must sum exactly to the capitalized total" holds by construction and
 * no remainder can exist to discard. That is what makes acceptance criterion 8
 * refusable rather than merely unimplemented.
 *
 * Called after this day's own accrual, so capitalization never compounds inside
 * the window.
 */
function capitalizeInterest(ledger: Ledger, accountId: string, day: Day): Money | undefined {
  const currency = ledger.currencyOf(accountId);
  const accruals: Accrual[] = Array.from({ length: day }, (_, index) => ({
    day: index + 1,
    amount: accrualOn(ledger, accountId, index + 1),
  }));

  const total = accruals.reduce((sum, accrual) => add(sum, accrual.amount), zero(currency));
  // An account that never held a positive balance has no credit to make, and a
  // zero-amount event would be a record that states nothing.
  if (!isPositive(total)) return undefined;

  const id = `INT-${accountId}-D${day}`;
  ledger.append({
    event: {
      kind: "INTEREST_CAPITALIZATION",
      id,
      accountId,
      bookedDay: day,
      valueDate: day,
      amount: total,
      accruals,
    },
    decision: "APPLIED",
    postings: [{ eventId: id, accountId, bookedDay: day, valueDate: day, amount: total }],
  });
  return total;
}

/**
 * Close one day for every account, then seal it.
 *
 * The order matters and is argued in AMBIGUITIES section 4:
 *
 *   1. read the pre-fee close, so a fee can never count toward its own trigger;
 *   2. assess at most one fee, value-dated today, so it belongs to this close;
 *   3. accrue on the post-fee close;
 *   4. on the last day only, capitalize -- after step 3, so nothing compounds.
 *
 * Only what was known at this close is used, and the day is sealed afterwards.
 * A later back-valued arrival therefore restates the past without any published
 * figure ever being rewritten.
 */
export function closeDay(ledger: Ledger, day: Day): DayClose {
  const accounts = ledger.accountIds.map((accountId): AccountClose => {
    const preFeeBalance = ledger.balanceAsOf(accountId, day, day);
    const fee = isNegative(preFeeBalance)
      ? assessOverdraftFee(ledger, accountId, day)
      : undefined;

    const closingBalance = ledger.balanceAsOf(accountId, day, day);
    const interest = accrualOn(ledger, accountId, day);
    const capitalized = day === CAPITALIZE_ON ? capitalizeInterest(ledger, accountId, day) : undefined;

    return {
      accountId,
      preFeeBalance,
      ...(fee === undefined ? {} : { fee }),
      closingBalance,
      interest,
      ...(capitalized === undefined ? {} : { capitalized }),
      finalBalance: ledger.balanceAsOf(accountId, day, day),
    };
  });

  ledger.sealDay(day);
  return { day, accounts };
}

/** Decide one incoming event and commit the outcome. */
export function ingest(ledger: Ledger, event: LedgerEvent): LedgerRecord {
  switch (event.kind) {
    case "CREDIT":
      return applyCredit(ledger, event);
    case "DEBIT":
      return applyDebit(ledger, event);
    case "AUTHORIZATION":
      return decideAuthorization(ledger, event);
    case "SETTLEMENT":
      return decideSettlement(ledger, event);
    default:
      // OVERDRAFT_FEE and INTEREST_CAPITALIZATION are generated by the day
      // close, never received from a feed.
      throw new Error(`${event.kind} is not an event this ledger accepts from a feed`);
  }
}
