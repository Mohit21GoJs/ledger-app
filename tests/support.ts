/** Shared fixtures. The two accounts from the brief, and terse event builders. */

import { Ledger } from "../src/ledger";
import type {
  AuthorizationEvent,
  CreditEvent,
  DebitEvent,
  Day,
  ReversalEvent,
  SettlementEvent,
} from "../src/ledger";
import { AED, BHD, parseAmount } from "../src/money";

export const ACC_AED = "ACC-001";
export const ACC_BHD = "ACC-002";

export const aed = (text: string) => parseAmount(AED, text);
export const bhd = (text: string) => parseAmount(BHD, text);

/** Both accounts from the brief, open at zero. */
export function newLedger(): Ledger {
  const ledger = new Ledger();
  ledger.openAccount(ACC_AED, AED);
  ledger.openAccount(ACC_BHD, BHD);
  return ledger;
}

type Days = { on: Day; valued?: Day };

/** `valued` defaults to the booked day: most events are effective when booked. */
const when = (id: string, accountId: string, { on, valued }: Days) => ({
  id,
  accountId,
  bookedDay: on,
  valueDate: valued ?? on,
});

export function credit(
  id: string,
  amount: string,
  days: Days,
  options: { accountId?: string; instalments?: number } = {},
): CreditEvent {
  const accountId = options.accountId ?? ACC_AED;
  return {
    kind: "CREDIT",
    ...when(id, accountId, days),
    amount: accountId === ACC_BHD ? bhd(amount) : aed(amount),
    ...(options.instalments === undefined ? {} : { instalments: options.instalments }),
  };
}

export function debit(
  id: string,
  amount: string,
  days: Days,
  options: { accountId?: string } = {},
): DebitEvent {
  const accountId = options.accountId ?? ACC_AED;
  return {
    kind: "DEBIT",
    ...when(id, accountId, days),
    amount: accountId === ACC_BHD ? bhd(amount) : aed(amount),
  };
}

export function authorize(
  id: string,
  authorizationId: string,
  amount: string,
  days: Days,
): AuthorizationEvent {
  return {
    kind: "AUTHORIZATION",
    ...when(id, ACC_AED, days),
    authorizationId,
    amount: aed(amount),
  };
}

export function settle(
  id: string,
  authorizationId: string,
  amount: string,
  days: Days,
): SettlementEvent {
  return {
    kind: "SETTLEMENT",
    ...when(id, ACC_AED, days),
    authorizationId,
    amount: aed(amount),
  };
}

export function reverse(id: string, reverses: string, days: Days): ReversalEvent {
  return { kind: "REVERSAL", ...when(id, ACC_AED, days), reverses };
}
