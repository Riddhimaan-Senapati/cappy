---
name: declutter
description: distractions, ads, popups, sidebars, recommendations, focus, ADHD, autoplay, animation, flashing
---
- Hide with `display: none !important`, targeting ads, sponsored blocks, newsletter and cookie popups, recommendation rails and comment sections only when asked.
- Never hide the main content the user came for, navigation they need, or site controls like search and video players.
- Prefer specific selectors from the outline over broad patterns like `[class*=ad]`, which can match words such as "header" or "shadow". Inspect first.
- For flashing or motion, use the stopMotion block; it also pauses autoplaying media.
