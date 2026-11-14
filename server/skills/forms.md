---
name: forms
description: forms, inputs, sign up, checkout, hard to click, motor limits, tremor, injury, keyboard use, unlabeled fields
---
- Add visible labels to unlabeled inputs with addLabel; derive the text from the placeholder, name or nearby text.
- Make targets at least 44px tall with CSS (min-height, padding), and give checkboxes and radios at least 24px.
- Add a strong focus ring: `:focus-visible { outline: 3px solid #4c6fff; outline-offset: 2px; }`.
- Fix missing accessible names with setAttribute aria-label. Remove tabindex values above 0 that break keyboard order.
- You adapt forms; you never fill them in or submit them.
