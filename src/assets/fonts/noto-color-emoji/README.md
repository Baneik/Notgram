# Noto Color Emoji

Copyright 2022 Google Inc. Licensed under the SIL Open Font License 1.1 in [OFL.txt](OFL.txt).

The bundled font is Google's Noto Color Emoji **2.057**, using COLRv1 color outlines. It comes from `2D/fonts/Noto-COLRv1.ttf` in [googlefonts/noto-emoji](https://github.com/googlefonts/noto-emoji/tree/e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e), pinned to commit `e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e`.

`NotoColorEmoji.woff2` is a lossless WOFF2 conversion of the complete upstream font, without subsetting or changing glyphs, names, or metrics. This preserves flags, skin tones, keycaps, and ZWJ sequences. SHA-256: `4186644d00db696585c26f909823eecdb4dadc13799222ffc23fdb4b3addf68e`.

To reproduce the conversion with FontTools and Brotli installed:

```python
from fontTools.ttLib import TTFont

font = TTFont("Noto-COLRv1.ttf")
font.flavor = "woff2"
font.save("NotoColorEmoji.woff2")
```

Vite bundles the font from `global.css` and the license from `mountWindow.tsx`. Every application window exposes the license through a `link[rel="license"]`. Text fonts precede Noto in mixed text so ordinary digits and symbols retain their existing typography. The shared window mount waits for the local font before rendering, preventing fallback-font measurements from entering conversation geometry caches.
