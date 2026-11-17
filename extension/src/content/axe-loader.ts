import axe from "axe-core";

// Built as its own script (dist/axe.js) and injected on demand; the content script reads the global it sets.
(globalThis as unknown as { __cappyAxe?: typeof axe }).__cappyAxe = axe;
