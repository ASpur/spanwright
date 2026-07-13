import test from "node:test";
import assert from "node:assert/strict";

import {
  bridgeSampleT,
  bridgeWorldPosition,
  deckHeights,
  rawCurve,
  spanDistance,
  state,
} from "../app.js";

const defaultPoints = [
  { t: 0, h: 0 },
  { t: .25, h: .62 },
  { t: .5, h: 1 },
  { t: .75, h: .62 },
  { t: 1, h: 0 },
];

test.beforeEach(() => {
  state.curve = "custom";
  state.span = 32;
  state.rise = 10;
  state.rotation = 0;
  state.customPoints = structuredClone(defaultPoints);
});

test("span length is the number of generated deck stations", () => {
  const heights = deckHeights();

  assert.equal(heights.length, 32);
  assert.equal(spanDistance(), 31);
  assert.equal(bridgeSampleT(0), 0);
  assert.equal(bridgeSampleT(31), 1);
  assert.equal(heights[0], 0);
  assert.equal(heights[31], 0);
});

test("unrotated endpoints occupy exactly the requested span", () => {
  const start = bridgeWorldPosition(0, 0);
  const end = bridgeWorldPosition(1, 0);

  assert.equal(start.x, -15);
  assert.equal(end.x, 16);
  assert.equal(end.x - start.x + 1, 32);
});

test("a one-block bridge produces one valid sample", () => {
  state.span = 1;

  assert.equal(spanDistance(), 0);
  assert.equal(bridgeSampleT(0), 0);
  assert.deepEqual(deckHeights(), [0]);
  assert.equal(bridgeWorldPosition(0, 0).x, 0);
});

test("custom interpolation clamps to the correct endpoint", () => {
  state.customPoints[0].h = .2;
  state.customPoints[state.customPoints.length - 1].h = .8;

  assert.equal(rawCurve(-.01), 2);
  assert.equal(rawCurve(1.01), 8);
});
