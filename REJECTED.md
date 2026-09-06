# Rejected criteria

The brief ships eight acceptance criteria. Four are correct and asserted as stated; **four are wrong**, and this build refutes each with the behaviour that actually occurs. A rejected criterion is not skipped in the suite — it is pinned to the refuting fact, so the disagreement is something the tests *prove*, not an opinion in a document. Every one is in [tests/acceptance.test.ts](tests/acceptance.test.ts).

**Product view:** each rejection protects a property a real ledger must not give up — a charge dated when it was known, a reversal that doesn't silently erase a separate fee, money that is conserved to the last minor unit. Accepting the criterion as written would break one of those.

## At a glance

| # | The criterion claims… | What actually happens | The property it would cost |
|---|---|---|---|
| 2 | E7 causes one fee, on **Day 2** | one fee, value-dated **Day 5** | a charge is dated when it was *known*, not back-dated |
| 6 | after E9, balances **and fees** return to pre-E7 | close is **440.00**, not 465.00; the fee **stands** | a reversal can't silently unwind an unrelated charge |
| 7 | each BHD instalment is **3.334** | **3.334 + 3.333 + 3.333** | the total is conserved to the minor unit |
| 8 | unmatched interest remainder is **discarded** | there is **no remainder** — the sum is exact by construction | interest paid = interest earned, exactly |

*(Accepted, for contrast: #1 the restated Day-2 balance is −370.00; #3 E5 settles Auth-A; #4 E6 settles an unknown auth and is rejected with no postings; #5 the hold rule is correct — though its antecedent, "Auth-B is approved", is false here.)*

---

## 2. "Exactly one fee, on Day 2" — one fee, but **Day 5**

E7 is a Day-5 booking of a Day-2-valued debit. It makes the *restated* Day-2 balance −370.00, which invites a Day-2 fee. But a fee is value-dated **the day it is assessed**, and E7 is not known until the Day-5 close. Dating the fee Day 2 would charge for a fact the bank had not yet learned — and, applied consistently, would yield three fees, not one. So: exactly one fee, correctly, but on Day 5. → [AMBIGUITIES §3](AMBIGUITIES.md), [NUMBERS.md](NUMBERS.md#why-the-fee-is-day-5-not-day-2)

## 6. "After E9 everything returns to pre-E7" — the fee stands

E9 reverses E7's −620.00, so the *debit* is undone. The overdraft fee is not: it was correctly assessed against what was known at the Day-5 close, and reversing a debit is not authority to reverse a separately assessed charge. The pre-E7 close (Day 4) was 465.00; after E9 the Day-6 close is **440.00** — the 25.00 fee is still there. A design where reversing an entry silently unwound every downstream consequence is one where no published figure is ever final. → [AMBIGUITIES §9](AMBIGUITIES.md)

## 7. "Each BHD instalment is 3.334" — conservation beats equality

Three amounts of 3.334 sum to 10.002 — the bank would invent 0.002. BHD stores 3 decimals, and no three *equal* storable amounts sum to 10.000. A ledger that does not conserve is not a ledger, so equality is downgraded to "as equal as BHD permits": **3.334 + 3.333 + 3.333 = 10.000**. → [AMBIGUITIES §8](AMBIGUITIES.md)

## 8. "Discard the interest remainder" — there is none to discard

The claim presumes the daily accruals are rounded, summed, and then reconciled against an independently computed total, leaving a scrap to throw away. This build never creates that scrap: the capitalized credit **is** the sum of the stored rounded daily accruals. "The accruals sum exactly to the capitalized total" therefore holds by construction, not by a discard step. → [AMBIGUITIES §4](AMBIGUITIES.md)

---

## The honest cost

Refusing criterion 2 has a price, and the build states it out loud rather than hiding it: because a fee is decided at knowledge time and a sealed day is never re-opened, **fee history depends on arrival order**. Two ledgers holding identical value-dated entries can carry different fees if the entries arrived on different days. That is a real loss of a property most people assume a ledger has — and it is demonstrated, not glossed, by the one deliberate failing test in [`known-failing/`](known-failing/fee-history-is-arrival-order-dependent.test.ts). Every attempted repair (back-dating, catch-up fees, full recomputation, deferring to window end) costs more than the property is worth; that argument is inline in the test.
