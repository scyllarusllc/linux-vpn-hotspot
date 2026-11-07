import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BYPASS, parseBypass } from '../src/bypass.js';

test('parseBypass reads names one per line, cleans and de-duplicates them', () => {
  assert.deepEqual(parseBypass('3gppnetwork.org\n*.Example.COM, .example.com\n  foo.bar.net.  \n'), ['3gppnetwork.org', 'example.com', 'foo.bar.net']);
  assert.deepEqual(parseBypass(''), []);
  assert.deepEqual(DEFAULT_BYPASS, ['3gppnetwork.org']);
});

test('parseBypass rejects things that are not domain names', () => {
  for (const bad of ['localhost', 'http://example.com', 'a b.com/x', '-bad.com', 'exa_mple.com', '1.2.3.']) {
    assert.throws(() => parseBypass(bad), { status: 400 }, bad);
  }
});
