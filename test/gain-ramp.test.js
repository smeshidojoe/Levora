// Why the chain has exactly one gain node.
//
// The blast on every slider move came from a static makeup node and a
// correction node arranged to cancel: +25 dB against -25 dB is unity, and the
// arithmetic is right. What is wrong is that AudioParam.setTargetAtTime moves
// on an exponential in *linear* gain, and the product of a rising and a falling
// exponential is not constant. The rising one arrives long before the falling
// one leaves.
//
// This is arithmetic, not a Web Audio quirk, so it can be pinned here.

import test from "node:test";
import assert from "node:assert/strict";

const TAU = 0.05; // the ramp constant the engine uses for gain changes
const db = (amp) => 20 * Math.log10(amp);
const amp = (value) => 10 ** (value / 20);

/** AudioParam.setTargetAtTime, evaluated at time t. */
const setTargetAtTime = (start, target, t, tau = TAU) =>
  target + (start - target) * Math.exp(-t / tau);

/** Worst gain seen while a ramp is in flight, in dB. */
function peakDuring(gainAt) {
  let peak = -Infinity;
  for (let t = 0; t <= 1; t += 0.001) peak = Math.max(peak, db(gainAt(t)));
  return peak;
}

test("two cancelling ramps do not cancel while they ramp", () => {
  // The shape of the bug, kept so nobody reintroduces the "just cancel it"
  // arrangement believing the endpoints are what matters.
  for (const makeupDb of [25, 38.5]) {
    const peak = peakDuring(
      (t) =>
        setTargetAtTime(1, amp(makeupDb), t) * setTargetAtTime(1, amp(-makeupDb), t),
    );
    assert.ok(
      peak > 10,
      `expected the two-node arrangement to overshoot; saw only ${peak.toFixed(1)} dB`,
    );
  }
});

test("one ramp never leaves the interval between its endpoints", () => {
  // The fix, stated as a property: a single node moving from A to B passes
  // through nothing louder than the louder of A and B, whatever A and B are.
  for (const [fromDb, toDb] of [
    [0, 25],
    [25, 0],
    [0, -25],
    [-24, 30],
    [30, -24],
  ]) {
    const peak = peakDuring((t) => setTargetAtTime(amp(fromDb), amp(toDb), t));
    assert.ok(
      peak <= Math.max(fromDb, toDb) + 1e-6,
      `ramp ${fromDb} -> ${toDb} dB peaked at ${peak.toFixed(1)} dB`,
    );
  }
});
