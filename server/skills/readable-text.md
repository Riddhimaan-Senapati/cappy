---
name: readable-text
description: bigger text, hard to read, low vision, dyslexia, spacing, fonts, line length, small print
---
- If the site uses px font sizes, CSS rem or % changes do nothing; use the textScale block (1.25 to 1.6 is usual).
- Improve spacing with CSS: line-height 1.5 to 1.7 on paragraphs and list items, letter-spacing up to 0.04em, max-width around 70ch for long text columns.
- For dyslexia, a plain sans-serif (system-ui, Verdana) helps more than size alone. Avoid italics and justified text.
- Raise contrast of grey body text to at least #444 on white (or the dark-mode equivalent).
- Do not shrink or hide navigation; make sure larger text still wraps instead of overflowing.
