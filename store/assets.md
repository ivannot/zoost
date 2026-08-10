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

## What gets published, and under what name

The dashboard takes **five screenshots**, shows them in the order they were uploaded, and names them
nothing. So the files carry the order and nothing else: a folder per product, and inside it
`1.png` .. `5.png`. A descriptive name is one more thing to keep in step with a slot number, and the
slot number is all the Store knows - and one folder per product means uploading is opening a folder
and taking what is in it, rather than picking five files out of ten that differ by a prefix.

**The first is the interface**: the panel with a workspace open, which is what somebody sees the
moment the product works, and which the Store uses as the thumbnail. Then the rest of the interface,
then the diagrams - the least self-explanatory and the most convincing once the rest is understood.
Five slots against eighteen renders means choosing, and what is left out is the settings page, the
exports, the search and the assistant: useful, none of them what the product *is*.

| | Zoost CRM | Zoost Analytics |
|---|---|---|
| 1 | the panel, a function open | the panel, the view census |
| 2 | a module: fields, types, layouts | a table's columns and its foreign keys |
| 3 | the workspace health audit | what a view is built on |
| 4 | the ER diagram | the ER diagram |
| 5 | the call graph | the health audit |

`python3 tools/shots.py` writes them to `dist/store/<app>/` and prints a digest of each set. It
**renders only what has moved**: the set is compared against the digest of what it was drawn from
last time - the app's shipped files, its fixture, the click script and the renderers - and an app
whose sources have not changed keeps the images already on disk. A run that changes nothing takes
a fifth of a second instead of three minutes; `--force` draws them anyway.
`store/<app>/screenshots.json` records the set that is **on the Store**, written by hand at
submission like the `RELEASES.md` row, because the upload is manual and nothing here can observe it.
When the digests differ the tool says so, in those words.

**Every release re-uploads the screenshots if they have changed** - both products, every time. This
is not tidiness: the Zoost Analytics listing carried a single image from its first submission for months
because nothing was measuring, and a listing that shows a product two versions old is an argument
against it.

## Where ours come from

Generated, never captured from a real org. `python3 tools/shots.py` renders the panel and the diagram
window against the fixture in `fixtures/`, at exactly 1280 x 800, as 24-bit PNGs. With no argument it
draws **what the Store takes** - the ten images above - and publishes them; with a shot's name it
draws that one into `dist/shots/` and leaves it there, which is how a new shot gets looked at before
it is trusted. Eleven today, both panels and both
diagram windows: the panel with a function open, the modules list, the sample workspace just after
it is written, the graph, the custom buttons isolated, the Relations table, the ER diagram - and on
the other side the view census, a table's columns with its foreign keys, and its ER diagram. **Re-render them whenever there is something new to show** - they are a build output,
not an asset anyone should be editing.

That is not only convenience. Screenshots taken against the org this is developed on had to be
blurred before they could be published, and a blurred screenshot is a poor advertisement for a tool
whose whole subject is reading clearly. The fixture carries neutral names, so nothing needs hiding
and the same image can be regenerated after any UI change instead of being re-captured and re-blurred.
