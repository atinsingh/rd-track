import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domainOf } from '../src/domain.js';

test('keeps the hostname of web pages only', () => {
  assert.equal(domainOf('https://www.GitHub.com/rounddigital/track/pull/1?tab=files#diff'), 'github.com');
  assert.equal(domainOf('http://docs.rs:8080/serde'), 'docs.rs');
  assert.equal(domainOf('https://user:secret@intranet.example/payroll'), 'intranet.example');
  assert.equal(domainOf('http://localhost:3100/my-day'), 'localhost');
  assert.equal(domainOf('https://münchen.example/'), 'xn--mnchen-3ya.example');
  for (const url of ['chrome://settings', 'about:blank', 'file:///home/a/notes.txt', 'data:text/html,hi', 'moz-extension://x/popup.html', 'chrome-extension://x/y', 'https://[::1]/', 'not a url', '', undefined]) {
    assert.equal(domainOf(url), null, String(url));
  }
});
