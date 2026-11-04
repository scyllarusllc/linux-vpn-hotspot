import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERVAL_MS, bucketFor, rates } from '../src/history.js';

test('rates converts byte deltas to bits per second', () => {
  const prev = { t: 0, txBytes: 1000, rxBytes: 500 };
  const cur = { t: 5000, txBytes: 1000 + 625_000, rxBytes: 500 + 6250 };
  assert.deepEqual(rates(prev, cur), { down: 1_000_000, up: 10_000 });
});

test('rates returns a gap with no previous reading or after a reconnect', () => {
  const cur = { t: 5000, txBytes: 10, rxBytes: 10 };
  assert.deepEqual(rates(null, cur), { down: null, up: null });
  assert.deepEqual(rates({ t: 0, txBytes: 999, rxBytes: 0 }, cur), { down: null, up: null });
  assert.deepEqual(rates({ t: 5000, txBytes: 0, rxBytes: 0 }, cur), { down: null, up: null });
});

test('bucketFor keeps ranges to about 720 points in whole ticks', () => {
  assert.equal(bucketFor(60 * 60_000), INTERVAL_MS);
  assert.equal(bucketFor(24 * 3600_000), 120_000);
  assert.equal(bucketFor(7 * 24 * 3600_000) % INTERVAL_MS, 0);
  assert.ok((7 * 24 * 3600_000) / bucketFor(7 * 24 * 3600_000) <= 720);
});
