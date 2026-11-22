# Account wallet

Open **Player → Overview** from the dock for Dracs, Arcs, and remaining
trades. Values come directly from `RegularCredits`, `PremiumCredits`, and
`TradesRemaining` in the normal inventory response. Unknown values display a
dash, while a genuine zero remains zero. No daily trade maximum is inferred.

`PremiumCreditsFree` is not added to the Arcs balance: the widget does not assume
that it is an additional spendable balance. Saved data is labelled with its
inventory timestamp. The widget performs no transactions.
