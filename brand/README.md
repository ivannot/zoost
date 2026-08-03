# Zoost brand marks

Three files, one geometry. The shape never changes between products; only the hue does.

| File | Use |
|---|---|
| `zoost.svg` | the family. Neutral slate — the suite, not a product. Site header, GitHub, anywhere Zoost is spoken of as a whole |
| `zoost-crm.svg` | Zoost for Zoho CRM |
| `zoost-analytics.svg` | Zoost for Zoho Analytics |

**The geometry is measured, not redrawn.** A 52×48 Z at 14px bar weight, centred in a 116px squircle
with a 30px corner radius, in a 128 box — taken off the icon Zoost shipped with, so the family mark
*is* the mark, not a lookalike.

**Why the products differ only by hue.** At 16px in a browser toolbar nothing else survives: a motif
becomes three grey pixels and reads as noise. The Analytics icon carried three small columns for a
while and they did exactly that. Colour is the only channel that still works at that size, so it
carries the whole job and everything else stays identical on purpose.

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
