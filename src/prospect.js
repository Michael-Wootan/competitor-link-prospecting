#!/usr/bin/env node
/**
 * prospect.js: find sites that link to competitors, and pitch them
 *
 * Strategy: a site that links to a competitor is a warm lead. It has already
 * shown it links to companies like this one.
 *
 * How it works:
 *  1. Pull referring domains for each competitor via the Ahrefs API
 *  2. Pull our own referring domains to exclude sites already linking to us
 *  3. Filter to quality sites (DR >= 10, dofollow, not social or directories)
 *  4. Deduplicate across competitors and check the cooldown log
 *  5. Find a contact email by scraping contact and about pages.
 *     VALIDATED via email-validation.js: no filename-shaped addresses, the
 *     domain must accept mail, bounced addresses (suppression list) skipped
 *  6. Use Claude Haiku to write a personalized pitch per site
 *  7. Save pitches to state/pending-pitches.json for review
 *  8. Email a summary report with pitch previews
 *  9. --send mode: send the pending pitches from the outreach mailbox
 *
 * Usage:
 *   node src/prospect.js            # discover + draft pitches
 *   node src/prospect.js --send     # send all pending pitches
 *   node src/prospect.js --dry-run  # preview, don't save
 *   node src/prospect.js --limit 5  # cap at 5 pitches
 *   node src/prospect.js --initial  # first-time full sweep
 *
 * Discovery and sending are separate modes on separate schedules.
 */

const { STATE_DIR, campaign } = require('./config');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const { isValidEmailAddress, hasMx, loadSuppression, isSuppressed } = require('./email-validation');

// ── CLI flags ────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const SEND_MODE = process.argv.includes('--send');
const INITIAL = process.argv.includes('--initial'); // first-time full sweep
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1]) : 10; })();

// ── Config ───────────────────────────────────────────────────────────────────
const DIR = STATE_DIR;
const LOG_FILE = path.join(DIR, 'prospect-log.json');
const PENDING_FILE = path.join(DIR, 'pending-pitches.json');
const STATE_FILE = path.join(DIR, 'prospect-state.json'); // tracks last-run date per competitor
const COOLDOWN_DAYS = 90;

const AHREFS_TOKEN = process.env.AHREFS_API_TOKEN;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Outreach mailbox: every pitch goes out from here
const PR_SMTP_HOST = process.env.OUTREACH_SMTP_HOST;
const PR_SMTP_PORT = parseInt(process.env.OUTREACH_SMTP_PORT || '587', 10);
const PR_SMTP_USER = process.env.OUTREACH_SMTP_USER;
const PR_SMTP_PASS = process.env.OUTREACH_SMTP_PASS;
const PR_FROM_EMAIL = process.env.OUTREACH_FROM_EMAIL || PR_SMTP_USER;
const PR_FROM_NAME = process.env.SENDER_NAME || campaign.senderName;
const TARGET = process.env.SITE_DOMAIN || (campaign.ownDomains || [])[0];

// Competitors to monitor (config/campaign.json)
const COMPETITORS = campaign.competitors;

// Domains to always skip
const SKIP_DOMAINS = [
  'reddit.com', 'twitter.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'tiktok.com', 'quora.com', 'pinterest.com', 'linkedin.com', 'medium.com',
  'substack.com', 'yelp.com', 'trustpilot.com', 'google.com', 'bing.com',
  'businesswire.com', 'prnewswire.com', 'yellowpages.com', 'crunchbase.com',
  'bloomberg.com', 'forbes.com', 'techcrunch.com', 'wikipedia.org',
  'amazon.com', 'ebay.com', 'etsy.com', 'shopify.com', 'wordpress.org',
  'wix.com', 'squarespace.com', 'godaddy.com', 'namecheap.com',
  'web.archive.org', 'archive.org',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function today() { return new Date().toLocaleDateString('en-CA'); }

// ── Ahrefs REST API v3 (with retry for transient errors) ─────────────────
async function ahrefsCall(endpoint, params, retries = 3) {
  if (!AHREFS_TOKEN) throw new Error('AHREFS_API_TOKEN not set');

  const url = new URL(`https://api.ahrefs.com/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${AHREFS_TOKEN}`,
        'Accept': 'application/json',
      },
    });

    if (resp.ok) return resp.json();

    const body = await resp.text().catch(() => '');

    // Retry on 500/502/503/429 (transient errors)
    if ([500, 502, 503, 429].includes(resp.status) && attempt < retries) {
      const wait = attempt * 5; // 5s, 10s, 15s backoff
      console.log(`   Ahrefs ${resp.status}: retrying in ${wait}s (attempt ${attempt}/${retries})...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    throw new Error(`Ahrefs ${endpoint} HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Get referring domains for a competitor.
 * --initial mode: pull ALL quality referring domains (big first sweep)
 * Normal mode: only pull domains first seen AFTER the last run date
 * Returns domains with DR >= 10 and at least 1 dofollow link.
 */
async function getCompetitorRefDomains(competitor, lastRunDate) {
  const isInitial = INITIAL || !lastRunDate;
  console.log(`   Fetching referring domains for ${competitor.name}${isInitial ? ' (full sweep)' : ` (new since ${lastRunDate})`}...`);

  const filters = [
    { field: 'domain_rating', is: ['gte', 10] },
    { field: 'dofollow_links', is: ['gte', 1] },
  ];

  // After initial sweep, only get NEW backlinks (first_seen after last run)
  if (!isInitial && lastRunDate) {
    filters.push({ field: 'first_seen', is: ['gte', lastRunDate] });
  }

  const data = await ahrefsCall('site-explorer/refdomains', {
    target: competitor.domain,
    mode: 'subdomains',
    select: 'domain,domain_rating,links_to_target,dofollow_links,traffic_domain,first_seen',
    where: { and: filters },
    order_by: 'domain_rating:desc',
    limit: isInitial ? 100 : 50, // bigger limit for initial sweep
  });
  const domains = data.refdomains || [];
  console.log(`   ${domains.length} ${isInitial ? 'total' : 'new'} quality referring domains (DR >= 10, dofollow)`);
  return domains;
}

/**
 * Get all domains already linking to us, so we skip them.
 */
async function getOwnRefDomains() {
  console.log(`   Fetching our existing referring domains...`);
  const data = await ahrefsCall('site-explorer/refdomains', {
    target: TARGET,
    mode: 'subdomains',
    select: 'domain',
    limit: 1000,
  });
  const domains = new Set((data.refdomains || []).map(r => r.domain.toLowerCase()));
  console.log(`   ${domains.size} domains already link to us`);
  return domains;
}

// ── Contact email finder ─────────────────────────────────────────────────────
function fetchUrl(url, maxRedirects = 3, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkProspector/1.0)',
        'Accept': 'text/html',
      },
      timeout,
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(fetchUrl(loc, maxRedirects - 1, timeout));
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractEmails(html, domain) {
  const all = [...new Set((html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []))];
  const filtered = all.filter(e =>
    isValidEmailAddress(e) &&
    !e.match(/noreply|no-reply|support@shopify|sentry|example\.com|w3\.org|notification|donotreply|unsubscribe|bounce/i)
  );
  const scored = filtered.map(e => {
    let score = 0;
    if (e.toLowerCase().includes(domain.toLowerCase())) score += 10;
    if (e.match(/contact|hello|hi@|team@|press|pr@|editorial|editor|write|guest|contribut|pitch|blog|media|partner/i)) score += 5;
    if (e.match(/info@|business|sales/i)) score += 2;
    // Penalize support/billing
    if (e.match(/support@|billing|ticket|help@|admin@/i)) score -= 3;
    return { email: e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score >= 0).map(s => s.email);
}

async function findContactEmail(domain, suppression) {
  const baseUrl = `https://${domain}`;
  const paths = ['', '/contact', '/about', '/write-for-us', '/contribute', '/contact-us', '/advertise'];

  for (const p of paths) {
    try {
      const { body } = await fetchUrl(`${baseUrl}${p}`);
      const emails = extractEmails(body, domain);
      for (const candidate of emails) {
        if (isSuppressed(suppression, candidate)) {
          console.log(`     Suppressed (previous bounce): ${candidate}`);
          continue;
        }
        if (await hasMx(candidate)) return candidate;
        console.log(`     No MX/A record for ${candidate.split('@')[1]}: skipping ${candidate}`);
      }
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// ── Domain filtering ─────────────────────────────────────────────────────────
function shouldSkip(domain) {
  const d = domain.toLowerCase();
  // Skip our own competitors (we don't pitch them)
  for (const c of COMPETITORS) {
    if (d === c.domain || d.endsWith('.' + c.domain)) return true;
  }
  // Skip known bad domains
  for (const skip of SKIP_DOMAINS) {
    if (d === skip || d.endsWith('.' + skip)) return true;
  }
  // Skip .edu, .gov (not relevant for outreach)
  if (d.match(/\.(edu|gov|mil)$/)) return true;
  return false;
}

// ── Pitch drafter ────────────────────────────────────────────────────────────
async function draftPitch(opportunity) {
  const fallbackSubject = `Content idea from ${campaign.company}`;
  if (!ANTHROPIC_KEY) {
    return { subject: fallbackSubject, body: '(No API key)' };
  }

  const { domain, competitors, domainRating, trafficDomain } = opportunity;
  const competitorNames = competitors.map(c => c.name).join(', ');
  const rules = (campaign.contentRules || []).map(r => `- ${r}`).join('\n');

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const prompt = `You are writing a personalized cold outreach email from ${PR_FROM_NAME} at ${campaign.company}.

This site (${domain}, DR ${domainRating}, ~${trafficDomain} monthly traffic) already links to: ${competitorNames}.

${campaign.company} context:
${campaign.context.map(c => `- ${c}`).join('\n')}

IMPORTANT: only use these REAL URLs in the pitch:
${campaign.allowedLinks.map(u => `- ${u}`).join('\n')}
Do NOT make up URLs. Only reference the pages listed above.
${rules}

Write a SHORT, natural cold email pitch (100-130 words):
- Subject line: specific, under 60 chars, no emojis
- Body:
* Reference that they already link to ${competitorNames}
* Position ${campaign.company} as a complementary resource (${campaign.positioning})
* Suggest 1-2 specific content ideas relevant to THEIR site and audience
* Include 1-2 of the real URLs listed above
* Conversational, casual tone, like a real person wrote it, not a template
* Close with something natural like "Happy to explore this further" or "Let me know if that sounds interesting"

Sign off exactly as:
${campaign.signature}

Return valid JSON: {"subject": "...", "body": "..."}`;

  const msg = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const jsonMatch = msg.content[0].text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* fallback */ }

  return { subject: fallbackSubject, body: msg.content[0].text };
}

// ── SEND MODE (staggered, human-like timing) ────────────────────────────────
const DAILY_SEND_LIMIT = 8; // max pitches per run (keep low to avoid spam flags)

function humanDelay() {
  // Random delay between 60-180 seconds to mimic human sending patterns
  const ms = (60 + Math.floor(Math.random() * 120)) * 1000;
  console.log(`   Waiting ${Math.round(ms / 1000)}s before next send...`);
  return new Promise(r => setTimeout(r, ms));
}

async function sendPendingPitches() {
  const pending = loadJson(PENDING_FILE);
  if (!pending || pending.length === 0) {
    console.log('No pending pitches to send.');
    return;
  }

  if (!PR_SMTP_PASS) {
    console.error('OUTREACH_SMTP_PASS not set: cannot send');
    process.exit(1);
  }

  // SAFEGUARD: drop pitches whose address is invalid, bounced, or undeliverable.
  // pending-pitches.json may contain entries drafted before validation existed.
  const suppression = loadSuppression();
  const sendable = [];
  let dropped = 0;
  for (const pitch of pending) {
    if (!isValidEmailAddress(pitch.contactEmail)) {
      console.log(`   Dropped (invalid address): ${pitch.contactEmail} (${pitch.domain})`);
      dropped++;
      continue;
    }
    if (isSuppressed(suppression, pitch.contactEmail)) {
      console.log(`   Dropped (previously bounced): ${pitch.contactEmail} (${pitch.domain})`);
      dropped++;
      continue;
    }
    if (!(await hasMx(pitch.contactEmail))) {
      console.log(`   Dropped (no mail server): ${pitch.contactEmail} (${pitch.domain})`);
      dropped++;
      continue;
    }
    sendable.push(pitch);
  }
  if (dropped > 0) console.log(`   ${dropped} pending pitch(es) dropped by validation.`);

  const transporter = nodemailer.createTransport({
    host: PR_SMTP_HOST,
    port: PR_SMTP_PORT,
    secure: false,
    auth: { user: PR_SMTP_USER, pass: PR_SMTP_PASS },
  });

  const log = loadJson(LOG_FILE) || {};
  let sent = 0;

  // Only send up to DAILY_SEND_LIMIT per run
  const batch = sendable.slice(0, DAILY_SEND_LIMIT);
  const remaining = sendable.slice(DAILY_SEND_LIMIT);

  console.log(`   ${sendable.length} sendable pitches. Sending batch of ${batch.length} (limit ${DAILY_SEND_LIMIT}/run).`);
  if (remaining.length > 0) {
    console.log(`   ${remaining.length} will be sent in the next run(s).`);
  }

  for (const pitch of batch) {
    try {
      await transporter.sendMail({
        from: `"${PR_FROM_NAME}" <${PR_FROM_EMAIL}>`,
        to: pitch.contactEmail,
        bcc: GMAIL_USER,
        replyTo: PR_FROM_EMAIL,
        subject: pitch.subject,
        text: pitch.body,
      });

      console.log(`   Sent to ${pitch.contactEmail} (${pitch.domain})`);
      log[pitch.domain] = {
        competitors: pitch.competitors,
        email: pitch.contactEmail,
        subject: pitch.subject,
        lastSent: new Date().toISOString(),
        status: 'sent',
      };
      sent++;

      // Human-like delay between sends (skip after last one)
      if (sent < batch.length) await humanDelay();
    } catch (err) {
      console.error(`   Failed: ${pitch.domain}: ${err.message}`);
    }
  }

  saveJson(LOG_FILE, log);
  saveJson(PENDING_FILE, remaining); // keep unsent pitches for next run

  // Notify the owner
  if (sent > 0 && GMAIL_PASS) {
    const gmailTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });
    await gmailTransport.sendMail({
      from: `"${campaign.company} Link Prospecting" <${GMAIL_USER}>`,
      to: GMAIL_USER,
      subject: `[${campaign.company} | Outreach] ${sent} Backlink Pitches Sent: ${today()}`,
      html: `<p>${sent} pitches sent from ${PR_FROM_EMAIL}${dropped > 0 ? ` (${dropped} dropped by address validation)` : ''}. Replies will be forwarded to Gmail under the <strong>Backlink Outreach</strong> label.</p>`,
    });
  }

  console.log(`\nDone. ${sent} pitches sent from ${PR_FROM_EMAIL}.`);
}

// ── DISCOVER MODE (default) ──────────────────────────────────────────────────
async function discoverOpportunities() {
  const mode = INITIAL ? 'INITIAL SWEEP' : 'NEW BACKLINKS';
  console.log(`\nCompetitor Link Prospecting [${new Date().toISOString()}] MODE=${mode} DRY=${DRY_RUN} LIMIT=${LIMIT}\n`);

  if (!AHREFS_TOKEN) {
    console.error('AHREFS_API_TOKEN not set');
    process.exit(1);
  }

  const log = loadJson(LOG_FILE) || {};
  const state = loadJson(STATE_FILE) || {};
  const suppression = loadSuppression();
  const now = Date.now();
  const coolMs = COOLDOWN_DAYS * 86400 * 1000;

  // Cross-check the partner outreach log so two senders sharing a mailbox never
  // pitch the same site independently.
  const guestLog = loadJson(path.join(DIR, 'outreach-log.json')) || {};

  // Step 1: Get our existing referring domains (non-fatal if it fails)
  let ownRefDomains;
  try {
    ownRefDomains = await getOwnRefDomains();
  } catch (err) {
    console.log(`   Warning: Could not fetch our referring domains (${err.message}). Continuing without exclusion filter.`);
    ownRefDomains = new Set();
  }

  // Step 2: Get referring domains for each competitor
  // On initial run: pull ALL. On subsequent runs: only NEW since last check.
  const opportunityMap = new Map(); // domain → { competitors, DR, traffic, etc. }

  for (const competitor of COMPETITORS) {
    try {
      const lastRunDate = state[competitor.domain]?.lastChecked;
      const refDomains = await getCompetitorRefDomains(competitor, lastRunDate);

      for (const rd of refDomains) {
        const d = rd.domain.toLowerCase();

        // Skip if it already links to us
        if (ownRefDomains.has(d)) continue;
        // Skip bad domains
        if (shouldSkip(d)) continue;
        // Skip if contacted recently by THIS bot
        if (log[d]?.lastSent && now - new Date(log[d].lastSent).getTime() < coolMs) continue;
        // Skip if the partner outreach job contacted them recently (same sender)
        if (guestLog[d]?.lastSent && now - new Date(guestLog[d].lastSent).getTime() < coolMs) continue;

        if (opportunityMap.has(d)) {
          // Already found via another competitor: add this competitor
          opportunityMap.get(d).competitors.push({ name: competitor.name, domain: competitor.domain });
        } else {
          opportunityMap.set(d, {
            domain: d,
            domainRating: rd.domain_rating,
            linksToTarget: rd.links_to_target,
            dofollow: rd.dofollow_links,
            trafficDomain: rd.traffic_domain,
            firstSeen: rd.first_seen,
            competitors: [{ name: competitor.name, domain: competitor.domain }],
          });
        }
      }
    } catch (err) {
      console.error(`   Error fetching ${competitor.name}: ${err.message}`);
    }

    // Update state: mark this competitor as checked now
    state[competitor.domain] = { lastChecked: new Date().toISOString().split('T')[0] };
    await new Promise(r => setTimeout(r, 500)); // rate limit
  }

  // Save state so next run only gets new backlinks
  if (!DRY_RUN) saveJson(STATE_FILE, state);

  // Step 3: Score and rank opportunities
  // Higher score = better opportunity. Favors: high DR, high traffic, multiple competitors
  const opportunities = Array.from(opportunityMap.values())
    .map(o => ({
      ...o,
      score: (o.domainRating * 2) + Math.log10(Math.max(o.trafficDomain, 1)) * 10 + (o.competitors.length * 15),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);

  console.log(`\n${opportunityMap.size} unique opportunities found. Top ${opportunities.length} selected.\n`);

  if (opportunities.length === 0) {
    console.log('No new opportunities this round.');
    // Send empty report
    if (GMAIL_PASS && !DRY_RUN) {
      const t = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: GMAIL_USER, pass: GMAIL_PASS },
      });
      await t.sendMail({
        from: `"${campaign.company} Link Prospecting" <${GMAIL_USER}>`,
        to: GMAIL_USER,
        subject: `[${campaign.company} | Outreach] No New Backlink Opportunities: ${today()}`,
        html: `<p>Scanned ${COMPETITORS.length} competitors. All quality referring domains either already link to us or were contacted within the last ${COOLDOWN_DAYS} days.</p>`,
      });
    }
    return;
  }

  // Step 4: Find contacts + draft pitches
  const pitches = [];

  for (const opp of opportunities) {
    console.log(`   [DR ${opp.domainRating}] ${opp.domain}: links to ${opp.competitors.map(c => c.name).join(', ')}`);

    // Find contact email (validated: format + MX + suppression list)
    const email = await findContactEmail(opp.domain, suppression);
    if (!email) {
      console.log(`     No valid, deliverable email found: skipping`);
      log[opp.domain] = { ...log[opp.domain], noEmail: true, checkedAt: new Date().toISOString() };
      continue;
    }
    console.log(`     Contact: ${email} (validated + MX OK)`);

    // Draft pitch
    console.log(`     Drafting pitch...`);
    const pitch = await draftPitch(opp);
    await new Promise(r => setTimeout(r, 800));

    pitches.push({
      domain: opp.domain,
      domainRating: opp.domainRating,
      trafficDomain: opp.trafficDomain,
      competitors: opp.competitors.map(c => c.name),
      contactEmail: email,
      subject: pitch.subject,
      body: pitch.body,
      score: opp.score,
      draftedAt: new Date().toISOString(),
    });

    console.log(`     Subject: ${pitch.subject}`);
    console.log(`     To: ${email}\n`);
  }

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] ${pitches.length} pitches drafted. Not saved.\n`);
    for (const p of pitches) {
      console.log(`--- ${p.domain} (DR ${p.domainRating}) → ${p.contactEmail} ---`);
      console.log(`Subject: ${p.subject}`);
      console.log(p.body);
      console.log();
    }
    return;
  }

  // Step 5: Save pending pitches + update log
  const existing = loadJson(PENDING_FILE) || [];
  const merged = [...existing, ...pitches];
  saveJson(PENDING_FILE, merged);
  saveJson(LOG_FILE, log);

  console.log(`\n${pitches.length} pitches saved to pending-pitches.json (${merged.length} total pending)`);

  // Step 6: Email summary to the owner
  if (GMAIL_PASS) {
    const gmailTransport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    const pitchRows = pitches.map(p => `
<tr>
<td style="padding:8px;border-bottom:1px solid #eee;">
<strong>${p.domain}</strong><br>
<span style="color:#666;font-size:12px;">DR ${p.domainRating} | ${p.trafficDomain.toLocaleString()} traffic</span>
</td>
<td style="padding:8px;border-bottom:1px solid #eee;">${p.competitors.join(', ')}</td>
<td style="padding:8px;border-bottom:1px solid #eee;">${p.contactEmail}</td>
<td style="padding:8px;border-bottom:1px solid #eee;font-size:13px;">${p.subject}</td>
</tr>`).join('');

    const pitchPreviews = pitches.map(p => `
<div style="background:#f9f9f9;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #27ae60;">
<p style="margin:0 0 4px 0;"><strong>To:</strong> ${p.contactEmail} | <strong>Site:</strong> ${p.domain} (DR ${p.domainRating})</p>
<p style="margin:0 0 4px 0;"><strong>Links to:</strong> ${p.competitors.join(', ')}</p>
<p style="margin:0 0 8px 0;"><strong>Subject:</strong> ${p.subject}</p>
<pre style="background:#fff;padding:12px;border-radius:4px;font-family:Georgia,serif;font-size:13px;line-height:1.5;white-space:pre-wrap;">${p.body}</pre>
</div>`).join('');

    const emailHtml = `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333;">
<h2 style="color:#1a1a2e;border-bottom:2px solid #27ae60;padding-bottom:10px;">
Competitor Backlink Pitches: ${today()}
</h2>

<div style="background:#f0f8f5;padding:16px;border-radius:8px;margin:20px 0;">
<p style="margin:0;font-size:16px;">
<strong>${pitches.length}</strong> new pitches drafted |
<strong>${COMPETITORS.length}</strong> competitors scanned |
<strong>${opportunityMap.size}</strong> total opportunities found
</p>
</div>

<div style="background:#fff3cd;padding:16px;border-left:4px solid #f39c12;border-radius:4px;margin:20px 0;">
<p style="margin:0;"><strong>Action needed:</strong></p>
<ol style="margin:8px 0 0 0;padding-left:20px;">
<li>Review the pitches below</li>
<li>Edit <code>pending-pitches.json</code> if you want to remove any</li>
<li>Go to <strong>Actions > Competitor Link Prospecting > Run workflow</strong> and select <strong>"send"</strong> mode</li>
</ol>
<p style="margin:8px 0 0 0;font-size:13px;color:#666;">Pitches will send from <strong>${PR_FROM_EMAIL}</strong>. Replies forwarded to Gmail under the <strong>Backlink Outreach</strong> label.</p>
</div>

<h3>Pitch Previews</h3>
${pitchPreviews}

<h3>Summary Table</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead>
<tr style="background:#f5f5f5;">
<th style="padding:8px;text-align:left;">Site</th>
<th style="padding:8px;text-align:left;">Links To</th>
<th style="padding:8px;text-align:left;">Contact</th>
<th style="padding:8px;text-align:left;">Subject</th>
</tr>
</thead>
<tbody>${pitchRows}</tbody>
</table>

<hr style="margin:30px 0;border:none;border-top:1px solid #ddd;">
<p style="font-size:12px;color:#999;">
Powered by Ahrefs referring-domains data. Sites shown link to your competitors with dofollow links (DR >= 10) but don't link to us yet.
</p>
</body>
</html>`;

    await gmailTransport.sendMail({
      from: `"${campaign.company} Link Prospecting" <${GMAIL_USER}>`,
      // "[<company> | Action]" deliberately does NOT match any auto-archive
      // filter: this email needs the owner's review + a manual "send" trigger.
      to: GMAIL_USER,
      subject: `[${campaign.company} | Action] ${pitches.length} Backlink Pitches Ready for Review: ${today()}`,
      html: emailHtml,
    });

    console.log(`Summary email sent to ${GMAIL_USER}`);
  }

  console.log(`\nDone. ${pitches.length} pitches pending review.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (SEND_MODE) {
    await sendPendingPitches();
  } else {
    await discoverOpportunities();
  }
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
