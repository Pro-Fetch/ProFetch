# ProHuman M0 spike — 2026-11-04T09:58:03.964Z
target: https://example.com/ · session bu-ed47db1e
pointer target: 640,756 80x21
sent path: 35 samples, 582 px, bow 95 px
resident loop: 22 event(s) recorded while no call was in flight, 22 fidget(s) sent
after the click the page is www.iana.org — 70 event(s) recorded in the new document

## measured from the page, not from the driver
events recorded: 109 · isTrusted ratio 1.000
document 1 (the path): 39 pointer events · 588 px · mean curvature 42.4 mrad · inter-event CV 0.50
document 2 (after the click): 22 pointer events · 22 keydown · 4 wheel
key holds: n=22 · mean 88.1 ms · CV 0.38
longest pointer stillness, whole session: 4169 ms

HOLDS: trusted events reach the page recorder
HOLDS: the pointer moved while no call was in flight
HOLDS: the path is curved, not a straight interpolation
HOLDS: the timing is not a metronome
VERDICT: all four assumptions hold on a live page. The pack may be built on this design.
NOTE: the pointer sat still for 4169 ms while the keyboard was busy. A fidget loop that only runs between calls is not enough — it has to run concurrently with typing and scrolling.
wrote benchmarks\prohuman\spike-2026-11-04T09-58-13-703Z.json
