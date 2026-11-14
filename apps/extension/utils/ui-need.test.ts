import { expect, test } from "bun:test";
import { guessNeedKind } from "./ui-need";

test("guesses the need kind from keywords in the typed line", () => {
  expect(guessNeedKind("I'm red-green colorblind")).toBe("color_vision");
  expect(guessNeedKind("Colour contrast is hard")).toBe("color_vision");
  expect(guessNeedKind("Invert this page, it's too bright")).toBe("light_sensitivity");
  expect(guessNeedKind("Flashing content")).toBe("light_sensitivity");
  expect(guessNeedKind("Make the text bigger")).toBe("text_size");
  expect(guessNeedKind("My wrist is in a cast")).toBe("motor");
  expect(guessNeedKind("Hide distractions")).toBe("focus");
});

test("falls back to focus when no keyword matches", () => {
  expect(guessNeedKind("something else entirely")).toBe("focus");
});
