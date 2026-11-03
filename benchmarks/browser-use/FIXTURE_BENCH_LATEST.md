# Fixture benchmark

Run: `2026-11-03T09:49:12.525Z` · chromium headless · **no network** (fixtures are local `data:` URLs)

- checks passed: **22/22** (100%)

| fixture | checks |
| --- | --- |
| `products.html` | 6/6 |
| `checkout.html` | 5/5 |
| `moving-target.html` | 7/7 |
| `tall.html` | 4/4 |

| fixture | check | result | what it saw |
| --- | --- | --- | --- |
| `products.html` | every named control is perceived | ok | 6/6: Add Keyboard, Add Monitor, Add Webcam, Add Headset, Add Mouse, Checkout |
| `products.html` | button role comes from the AX side, not guessed | ok | 6 buttons reported |
| `products.html` | a five-row list is grouped from shape alone | ok | repeated=5 evidence: ARIA role "list" declares list | 5 structurally identical children |
| `products.html` | the quantity/checkout form is recognised | ok | evidence: ARIA role "form" declares form | a form element is present |
| `products.html` | a clean page earns no blocking findings | ok | blocking: none |
| `products.html` | every image has alt text here, and it noticed | ok | images: 5, without alt: 0 |
| `checkout.html` | the unlabelled field is reported, not skipped | ok | findings: unnamed-controls, unlabelled-fields, tiny-targets, no-viewport-meta |
| `checkout.html` | a 12px target is called out as tiny | ok | 5 interactable element(s) are under 24x24 CSS px; the smallest is 13x13 ("Accept terms") |
| `checkout.html` | a DOM box maps onto its own pixels | ok | 100% of 120x34 at 16,136 is the button blue |
| `checkout.html` | "Pay now" is refused without a human decision | ok | REFUSE: "Pay now" is a verb that changes something outside this page; this engine does not perform it without a human deciding |
| `checkout.html` | typing into the labelled field is allowed | ok | ALLOW: the target resolves, is reachable and takes a type |
| `moving-target.html` | a rename in place is a relabel, not a new element | ok | Add to cart → In cart (2 relabel(s), +0 -0) |
| `moving-target.html` | the pre-rename identity is refused with a replacement | ok | CHANGED → replacement offered |
| `moving-target.html` | a replaced look-alike stops the action | ok | ID_RECYCLED: node id pf-2 now belongs to "button" — the original element is gone and clicking this id w |
| `moving-target.html` | a covered element is not offered as clickable | ok | interactable=false; conflicts: another element is on top of it | hit-test at the centre returns a different element |
| `moving-target.html` | a closed disclosure is offered as reversible | ok | expand/SAFE_REVERSIBLE |
| `moving-target.html` | the reveal reveals: absent, present, absent again | ok | 0 → 1 → 0 |
| `moving-target.html` | a toggle leaves the summary identity intact | ok | 1dbd5e88 vs 1dbd5e88 |
| `tall.html` | the deep control is invisible to the first read | ok | contentHeight=3820, bands=5 |
| `tall.html` | the scan reaches every band | ok | bands visited 5/5 |
| `tall.html` | the deep control is found by scrolling, not by luck | ok | model at v5, identities 5 |
| `tall.html` | no band was revisited uselessly | ok | reads=5 |

Each check is scored against an answer written into the fixture file, so a regression here means the
engine stopped seeing something that is still on the page.
