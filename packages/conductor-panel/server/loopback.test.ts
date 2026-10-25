import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireLoopbackHost } from './loopback.js';

test('allows only explicit loopback bind addresses', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', 'localhost', 'LOCALHOST']) {
    assert.equal(requireLoopbackHost(host), host.toLowerCase() === 'localhost' ? '127.0.0.1' : host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', 'localhost.example.com', '127.0.0.999', '127.1', '127.0.0.1.example.com', '::ffff:192.168.1.10', '']) {
    assert.throws(() => requireLoopbackHost(host), /non-loopback bind needs signed reviewer assertions \(option B\) first/);
  }
});
