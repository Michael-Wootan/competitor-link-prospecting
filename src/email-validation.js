/**
 * email-validation.js: shared safeguards for all outreach senders
 *
 * Bug history: the raw email regex used to match retina image filenames like
 * "bottom-device@2x.png" scraped from HTML, which then got pitched and
 * followed up, causing mass bounces. Every sender must run candidate
 * addresses through these three gates:
 *   1. isValidEmailAddress()  rejects filename-shaped and malformed strings
 *   2. hasMx()                domain must actually accept mail (MX or A record)
 *   3. suppression list       never email an address that previously bounced
 *      (suppression-list.json, maintained by the reply-triage job)
 */

const dns = require('dns');
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..', 'state');
const SUPPRESSION_FILE = process.env.SUPPRESSION_FILE || path.join(STATE_DIR, 'suppression-list.json');

// Filename-like "addresses" (images, fonts, scripts, archives)
const FILE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|css|js|mjs|json|xml|woff2?|ttf|eot|otf|mp[34]|webm|wav|pdf|zip|gz|rar|min)$/i;

function isValidEmailAddress(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.toLowerCase().trim();
  if (e.length > 254) return false;
  if (FILE_EXT_RE.test(e)) return false;             // logo@2x.png, sprite@3x.webp
  if (/@\d+(\.\d+)?x\./.test(e)) return false;       // any @2x. / @3x. retina pattern
  const parts = e.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) return false;
  if (/^\d+(\.\d+)+$/.test(local)) return false;     // version numbers from asset paths
  return true;
}

// Live MX check: don't pitch domains that can't receive mail
const mxCache = new Map();
async function hasMx(email) {
  const domain = email.split('@')[1].toLowerCase();
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const mx = await dns.promises.resolveMx(domain);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch { ok = false; }
  if (!ok) {
    // Some small sites receive mail on an A record with no MX
    try { await dns.promises.resolve4(domain); ok = true; } catch { ok = false; }
  }
  mxCache.set(domain, ok);
  return ok;
}

function loadSuppression() {
  try { return JSON.parse(fs.readFileSync(SUPPRESSION_FILE, 'utf8')); }
  catch { return { emails: {} }; }
}

function isSuppressed(suppression, email) {
  return !!(email && suppression.emails && suppression.emails[email.toLowerCase().trim()]);
}

module.exports = { isValidEmailAddress, hasMx, loadSuppression, isSuppressed };
