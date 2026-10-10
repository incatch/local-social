const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../lib/screening");

// Rekognition-style labels: [name, parent, confidence].
const verdict = (...labels) => decide(labels.map(([name, parent, confidence]) => ({ name, parent, confidence })));

test("photo screening rules", () => {
  // Fine: swimwear (thongs included), a bare back, a beer.
  assert.equal(verdict(["Female Swimwear Or Underwear", "Swimwear or Underwear", 97]), "allow");
  assert.equal(verdict(["Partially Exposed Buttocks", "Non-Explicit Nudity", 95], ["Non-Explicit Nudity", "Non-Explicit Nudity of Intimate parts and Kissing", 95]), "allow");
  assert.equal(verdict(["Bare Back", "Non-Explicit Nudity", 98]), "allow");
  assert.equal(verdict(["Alcoholic Beverages", "Alcohol", 99]), "allow");
  // A fully bare bottom is never refused, only held for a look.
  assert.equal(verdict(["Exposed Buttocks or Anus", "Explicit Nudity", 96]), "hold");
  // Held: partial nudity of the chest, violence.
  assert.equal(verdict(["Partially Exposed Female Breast", "Non-Explicit Nudity", 85]), "hold");
  assert.equal(verdict(["Graphic Violence", "Violence", 90]), "hold");
  // Refused: explicit nudity and sexual activity.
  assert.equal(verdict(["Exposed Female Genitalia", "Explicit Nudity", 95]), "refuse");
  assert.equal(verdict(["Exposed Buttocks or Anus", "Explicit Nudity", 96], ["Exposed Male Genitalia", "Explicit Nudity", 92]), "refuse");
  // Low confidence doesn't count.
  assert.equal(verdict(["Exposed Female Genitalia", "Explicit Nudity", 62]), "allow");
});
