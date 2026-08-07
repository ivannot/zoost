# Chrome Web Store - image and video slots

What the dashboard accepts, written down because it is restrictive, it is easy to get wrong, and a
submission that stops at the form costs a round trip of two to three days. It applies to both
listings; nothing here is per product.

Every image must be **JPEG or 24-bit PNG with no alpha channel**. A PNG with an alpha channel is
rejected even when it is fully opaque, so the exact bit depth is worth checking rather than assuming
- `file x.png` should say `8-bit/color RGB`, never `RGBA`.

| Slot | Required | Size | Notes |
|---|---|---|---|
| **Screenshots** | **yes** | 1280 x 800 or 640 x 400 | At least one, at most five. 1280 x 800 is the one to use - the smaller size exists for old listings |
| Small promo tile | no | 440 x 280 | |
| Marquee promo tile | no | 1400 x 560 | |
| Promotional video | no | - | A YouTube link. **We do not have one**, and this row exists so that nobody spends an afternoon looking for where to upload a file: there is nowhere, it is a link to a video hosted on YouTube |

## Where ours come from

Generated, never captured from a real org. `python3 tools/shots.py` renders the panel and the diagram
window against the fixture in `fixtures/`, at exactly 1280 x 800, and writes 24-bit PNGs to
`dist/shots/` (git-ignored, like every other build output). Seven today: the panel with a function
open, the call graph, the custom buttons isolated, the Relations table, and an ER diagram from each
of the two panels. **Re-render them whenever there is something new to show** - they are a build output,
not an asset anyone should be editing.

That is not only convenience. Screenshots taken against the org this is developed on had to be
blurred before they could be published, and a blurred screenshot is a poor advertisement for a tool
whose whole subject is reading clearly. The fixture carries neutral names, so nothing needs hiding
and the same image can be regenerated after any UI change instead of being re-captured and re-blurred.
