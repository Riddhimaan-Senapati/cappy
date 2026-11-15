---
name: dark-mode
description: dark or dim themes, too bright, glare, light sensitivity, migraines, night reading
---
Goal: every visible surface dark, every piece of text light, nothing unreadable.

- Never change a background without also setting `color` on the same element. Dark text on a new dark background is the most common failure.
- Cover the hard spots explicitly: cards, tables and cells, list items, inputs, selects, textareas, buttons, code and pre, dialogs, dropdowns, sticky headers, and elements that already had their own dark or colored backgrounds.
- Prefer one consistent palette: background #121214 to #1c1c20, surfaces #222228, text #e6e6ea, muted text #a6a6b0, links a light blue. Keep borders subtle.
- Do not invert images, video, canvas or SVG artwork. If you darken the page with `filter: invert(1)`, re-apply `filter: invert(1)` to img, video, picture, canvas and svg so they look normal. Do not add hue-rotate: a second hue-rotate clamps saturated colors, so a red image turns maroon.
- Colored accents (category colors, status chips) should stay recognisable: darken their backgrounds, keep text light.
- After applying, check `lowContrast` in the apply_change result: each entry has the selector, text color, background and contrast ratio. Fix every listed element with the same change id before finishing. Take a screenshot if the page has custom widgets.
