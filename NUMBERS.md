# Numbers

Every figure the replay prints, derived by hand. If the code and this document ever disagree, one of them is a bug — they are checked against each other in [tests/replay.test.ts](tests/replay.test.ts).

**Product view:** two accounts over six days. The AED account dips overdrawn once (a back-dated debit the bank learns of late), earns one AED 25.00 fee, then the debit is reversed — but the fee stands. The BHD account receives one instalment payment. Both earn a sliver of interest, paid as a single credit on the last day.

## The golden table

| Account | D1 | D2 | D3 | D4 | D5 | D6 close | + interest | Final |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| ACC-001 (AED) | 250.00 | 250.00 | 650.00 | 465.00 | −180.00 | 440.00 | 0.83 | **440.83** |
| ACC-002 (BHD) | 0.000 | 0.000 | 0.000 | 0.000 | 10.000 | 10.000 | 0.008 | **10.008** |

All balances are *operational closes*: `balanceAsOf(account, day, day)` — value date ≤ day **and** booked day ≤ day.

## ACC-001, day by day

The account holds these postings (value date / booked day in parentheses):

| Event | Posting | value / booked | Note |
|---|--:|:--:|---|
| E1 CREDIT | +1200.00 | 1 / 1 | |
| E2 DEBIT | −950.00 | 1 / 1 | |
| E3 AUTH Auth-A 200.00 | *no posting* | 2 / 2 | a hold, not a movement |
| E4 CREDIT | +400.00 | 3 / 3 | |
| E5 SETTLE Auth-A | −185.00 | 4 / 4 | releases the 200 hold **in full** |
| E6 SETTLE Auth-Z | *no posting* | 4 / 4 | rejected — no such authorization |
| E7 DEBIT | −620.00 | **2 / 5** | back-valued: effective Day 2, known Day 5 |
| FEE Day 5 | −25.00 | 5 / 5 | assessed at the Day-5 close |
| E8 AUTH Auth-B 90.00 | *no posting* | 5 / 5 | declined — available already −155.00 |
| E9 REVERSAL of E7 | +620.00 | **2 / 6** | negates E7 at E7's value date |

Closing each day sums only the postings visible *that day* (booked ≤ day):

```
D1  +1200 −950                                  =  250.00
D2  (E7 not yet known; auth posts nothing)      =  250.00
D3  +400                                         =  650.00
D4  −185 (E6 rejected, posts nothing)            =  465.00
D5  −620 (E7) → −155.00 pre-fee  → −25 fee       = −180.00
D6  +620 (E9)                                    =  440.00
```

### Why the fee is Day 5, not Day 2

E7 makes the *restated* Day-2 balance `balanceAsOf(2, 5) = 1200 − 950 − 620 = −370.00`. It is tempting to charge the fee on Day 2. We do not: a fee is value-dated **the day it is assessed**, and E7 only becomes known at the Day-5 close. Charging it on Day 2 would date a customer charge before the bank knew the fact that caused it, and — applied consistently — would produce *three* fees, not one. See [AMBIGUITIES §3](AMBIGUITIES.md). This is the single most load-bearing decision in the build.

### Why Day 6 is 440.00, not the pre-E7 465.00

E9 reverses E7's −620.00, restoring it. It does **not** reverse the fee: reversing a debit is not authority to reverse a separately assessed charge. So `465.00 (D4) − 25.00 (fee) = 440.00`. Acceptance criterion 6 claims "all balances and fees return to pre-E7 values"; they do not. See [REJECTED.md](REJECTED.md).

## Interest

0.04% per day (`{amount: 4n, scale: 4n}` = 4/10⁴), on **positive** closing balances only, rounded to the currency's precision **half-away-from-zero**, in one step ([`accrue`, money.ts:97](src/money.ts:97)). Rounding once, never twice, is how the engine avoids drifting from its own statement.

| Day | ACC-001 close | ×0.0004 | rounded | ACC-002 close | rounded |
|---|--:|--:|--:|--:|--:|
| 1 | 250.00 | 0.1000 | 0.10 | 0.000 | 0.000 |
| 2 | 250.00 | 0.1000 | 0.10 | 0.000 | 0.000 |
| 3 | 650.00 | 0.2600 | 0.26 | 0.000 | 0.000 |
| 4 | 465.00 | 0.1860 | 0.19 | 0.000 | 0.000 |
| 5 | −180.00 | — | 0.00 | 10.000 | 0.004 |
| 6 | 440.00 | 0.1760 | 0.18 | 10.000 | 0.004 |
| **Σ** | | | **0.83** | | **0.008** |

Interest does **not** compound inside the window: accruals are held aside and capitalized as one credit at the end of Day 6, so they never form part of a later day's base. The capitalized credit *is* the sum of the stored daily amounts ([`capitalizeInterest`, engine.ts:271](src/engine.ts:271)), so the "accruals sum exactly to the capitalized total" rule holds by construction — there is no remainder to discard (refuting criterion 8).

- ACC-001: `440.00 + 0.83 = 440.83`
- ACC-002: `10.000 + 0.008 = 10.008`

## ACC-002 instalments

E10 credits BHD 10.000 "as three equal instalments". BHD stores 3 decimals, and no three equal storable amounts sum to 10.000. Conservation wins over equality ([`split`, money.ts:112](src/money.ts:112)): largest-remainder, leftover minor unit handed out from the front.

```
10.000 / 3  →  3.334 + 3.333 + 3.333  =  10.000  ✓
```

Not `3.334 × 3 = 10.002` (invents 0.002) and not `3.333…` (not a BHD amount). Criterion 7 asks for 3.334 each; that does not conserve, so it is refused. See [AMBIGUITIES §8](AMBIGUITIES.md).

## Rounding rules, in one place

| Operation | Rule | Why |
|---|---|---|
| Parse input | exact precision or reject | rounding at the boundary is a silent decision about someone's money |
| Interest | multiply then round once, half-away-from-zero | no double rounding; sign never decides magnitude |
| Split | largest-remainder, front-loaded | conserve the total; never under-credit a partial split |
