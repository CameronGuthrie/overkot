# Daily vendor information

The Daily Brief uses a public, localized vendor catalogue for faction favor
names, standing costs, rank requirements, and weapon Temper candidates. Faction
weapons show Officer craftwork and the calculated Temper selection for the
current UTC day. Duplicate Tempers are grouped with their count. The selection
uses the audited game seed and generator; it does not guess Temper magnitudes,
combat stats, or purchase affordability. Unknown ranks remain unknown.

Avakot's Gots uses the account's actual vendor manifest while a live game
session is available. The catalogue's possible stock is never presented as the
current shelf. The shelf includes currency, price, purchase limit, weekly
markers, and per-item expiry when reported. **Avakot rotates during the day**;
its timing is independent of the daily reset. The next fetch follows the
manifest's earliest rotation expiry with a short grace period, or the next
three-hour UTC boundary when no usable expiry is reported.

Public catalogues are validated and cached for offline use. Live shelf data
stays in memory and clears on account, session, or language changes. Saved shelf
data is labelled when a refresh fails; expired offers disappear. Missing stock
shows unavailable rather than fabricating an empty shop.

Vendor requests run only in the main process with bounded responses, a timeout,
and redirects disabled. Account/session credentials never enter the renderer,
cache, or diagnostic output. No purchase endpoint is used.

Run `node --test test/dailyVendors.test.js` for golden selection vectors,
catalogue/stock validation, request timing, stale responses, account separation,
cache handling, and credential-safe projection.

Artwork paths come from the [public vendor catalogue](https://api.avakot.org/v1/vendors?lang=en)
or the bundled collection catalogue. The vendor image mirror's exact
`https://img.s3.avkt.org/Graphics/` prefix is normalized to the equivalent
`/SF/Interface/Graphics/` path on the existing game artwork CDN; arbitrary
origins, traversal, credentials and URL parameters are rejected. This includes
Duelo's blueprint and all three Lampyrite bundle artworks.

Temper names and logos use canonical Name keys from the localized Temper
catalogue in the [v2 overlay data manifest](https://d2855gck1tg5bh.cloudfront.net/overlay/v2/manifest.json).
Compatibility entries for Severed Root, Arcane Barrage, Conjuration, Grounding
Spell and Well Woven preserve those verified names and content-addressed logos
before a newer catalogue arrives. The public catalogues checked on
20 November 2026 resolve artwork for all 40 possible Avakot items and canonical
names/logos for all 205 faction weapon aspect entries.
