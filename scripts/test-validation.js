#!/usr/bin/env node
'use strict';
/**
 * Offline checks for the address gates every scraped contact must pass.
 * No network, no API keys.
 *
 *   npm test
 */
const assert = require('assert');
const { isValidEmailAddress, isSuppressed } = require('../src/email-validation');

// Real-looking addresses pass
assert.strictEqual(isValidEmailAddress('editor@food-weekly.example'), true);
assert.strictEqual(isValidEmailAddress('Hello@Roasters-Guild.Example'), true);

// Asset filenames and version strings scraped from HTML do not
assert.strictEqual(isValidEmailAddress('bottom-device@2x.png'), false);
assert.strictEqual(isValidEmailAddress('sprite@3x.webp'), false);
assert.strictEqual(isValidEmailAddress('icon@2x.cdn.example'), false);
assert.strictEqual(isValidEmailAddress('1.2.3@cdn.site.example'), false);
assert.strictEqual(isValidEmailAddress('bundle@1.4.2.min'), false);

// Malformed input
assert.strictEqual(isValidEmailAddress('no-at-sign.example'), false);
assert.strictEqual(isValidEmailAddress('two@@signs.example'), false);
assert.strictEqual(isValidEmailAddress(''), false);
assert.strictEqual(isValidEmailAddress(null), false);

// Suppression is case-insensitive and tolerant of whitespace
const suppression = { emails: { 'gone@old-site.example': { reason: 'bounce' } } };
assert.strictEqual(isSuppressed(suppression, ' Gone@Old-Site.example '), true);
assert.strictEqual(isSuppressed(suppression, 'fine@old-site.example'), false);

console.log('ok: 13 address validation checks passed');
