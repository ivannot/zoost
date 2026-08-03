# Zoost brand marks

Three files, one geometry. The shape never changes between products; only the hue does.

| File | Use |
|---|---|
| `zoost.svg` | the family. Achromatic slate `#47536b` — the suite, not a product |
| `zoost-crm.svg` | Zoost for Zoho CRM — `#2563eb` |
| `zoost-analytics.svg` | Zoost for Zoho Analytics — `#be2a6b` |

**The geometry is measured, not redrawn.** A 52×48 Z at 14px bar weight, centred in a 116px squircle
with a 30px corner radius, in a 128 box — taken off the icon Zoost shipped with, so the family mark
*is* the mark, not a lookalike.

**Why the products differ only by hue.** At 16px in a browser toolbar nothing else survives: a motif
becomes three grey pixels and reads as noise. The Analytics icon carried three small columns for a
while and they did exactly that. Colour is the only channel that still works at that size, so it
carries the whole job and everything else stays identical on purpose.

**Why these hues.** The two products sit **112° apart**, which is what makes them tellable apart at a
glance rather than on inspection — blue and teal were 47° and read as two shades of the same idea.
Both clear 5:1 against white; amber and orange were tried and fall to 3.2:1, where the Z starts to
crumble at small sizes. The family mark is achromatic so it reads as neither product.

**They are deliberately not Zoho's own colours.** `#226DB4` and `#E42527` are Zoho CRM's and Zoho
Analytics' brand blues and reds. Zoost disclaims affiliation on every surface it has; borrowing the
palette would say the opposite, and colour is the fastest way to imply a relationship that does not
exist.

**Rendering the PNGs** (16 / 32 / 48 / 128, what the manifests want):

```bash
python3 -c "
import cairosvg
for s in (16,32,48,128):
    cairosvg.svg2png(url='brand/zoost-crm.svg', write_to='apps/crm/icons/%d.png'%s, output_width=s, output_height=s)
"
```

If you change one, change all three: they are one mark and drift between them is the thing this
folder exists to prevent.
