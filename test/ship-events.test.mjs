import { test } from 'node:test';
import assert from 'node:assert/strict';

const { trackShipEvents } = await import('../dist/score.js');

const T = { thresholdLines: 50, thresholdFiles: 3 };
const DAY1 = Date.UTC(2026, 8, 1, 10);
const DAY1_LATER = Date.UTC(2026, 8, 1, 20);
const DAY2 = Date.UTC(2026, 8, 2, 10);
const DAY3 = Date.UTC(2026, 8, 3, 10);

function stats(commits, lines, files = 1) {
  return { commits, linesAdded: lines, linesRemoved: 0, filesTouched: files };
}

test('first shipped crossing emits an event and sets the baseline', () => {
  const r = trackShipEvents({}, stats(1, 80), T, DAY1);
  assert.deepEqual(r.shipEvents, ['2026-09-01']);
  assert.deepEqual(r.eventBaseline, stats(1, 80));
});

test('below-threshold work emits nothing', () => {
  assert.equal(trackShipEvents({}, stats(1, 10), T, DAY1), null); // commit, not meaningful
  assert.equal(trackShipEvents({}, stats(0, 200), T, DAY1), null); // meaningful, no commit
});

test('a second crossing the same day does not duplicate', () => {
  const first = trackShipEvents({}, stats(1, 80), T, DAY1);
  const again = trackShipEvents(first, stats(3, 400), T, DAY1_LATER);
  assert.equal(again, null);
});

test('day two earns its event with day two work', () => {
  const first = trackShipEvents({}, stats(1, 80), T, DAY1);
  // only 5 more lines on day 2: no event
  assert.equal(trackShipEvents(first, stats(1, 85), T, DAY2), null);
  // a fresh commit with meaningful new lines: event
  const second = trackShipEvents(first, stats(2, 200), T, DAY2);
  assert.deepEqual(second.shipEvents, ['2026-09-01', '2026-09-02']);
  assert.deepEqual(second.eventBaseline, stats(2, 200));
});

test('carryover: sub-threshold days accumulate until a crossing', () => {
  const first = trackShipEvents({}, stats(1, 80), T, DAY1);
  // day 2: 40 new lines, no commit — nothing
  assert.equal(trackShipEvents(first, stats(1, 120), T, DAY2), null);
  // day 3: one commit, 20 more lines — delta since day 1 is 1 commit / 60 lines
  const third = trackShipEvents(first, stats(2, 140), T, DAY3);
  assert.deepEqual(third.shipEvents, ['2026-09-01', '2026-09-03']);
});

test('shrunken stats re-clamp the baseline instead of wedging detection', () => {
  const first = trackShipEvents({}, stats(2, 300), T, DAY1);
  // rescore/dedupe drops the totals below the baseline
  const clamped = trackShipEvents(first, stats(1, 100), T, DAY2);
  assert.deepEqual(clamped.shipEvents, ['2026-09-01']);
  assert.deepEqual(clamped.eventBaseline, stats(1, 100));
  // new work on top of the clamped baseline can still ship
  const second = trackShipEvents(clamped, stats(2, 180), T, DAY2);
  assert.deepEqual(second.shipEvents, ['2026-09-01', '2026-09-02']);
});

test('the event list is capped', () => {
  let state = {};
  let s = stats(0, 0);
  for (let i = 0; i < 70; i++) {
    s = stats(s.commits + 1, s.linesAdded + 100);
    const r = trackShipEvents(state, s, T, DAY1 + i * 24 * 3600 * 1000);
    if (r) state = r;
  }
  assert.equal(state.shipEvents.length, 62);
});

test('files-only meaningfulness works on the delta', () => {
  const first = trackShipEvents({}, { commits: 1, linesAdded: 10, linesRemoved: 0, filesTouched: 6 }, T, DAY1);
  assert.deepEqual(first.shipEvents, ['2026-09-01']);
});
