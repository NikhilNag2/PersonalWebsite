#!/usr/bin/env node
/**
 * update-stats.js
 *
 * Scrapes Beacons media kit for live Instagram stats and updates
 * the stat numbers in partnerships.html and about.html.
 *
 * Run manually:  node update-stats.js
 * GitHub Action: runs daily via .github/workflows/update-stats.yml
 *
 * Required env vars:
 *   FIRECRAWL_API_KEY — your Firecrawl API key
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
if (!FIRECRAWL_API_KEY) {
  console.error('Error: FIRECRAWL_API_KEY environment variable is not set.');
  process.exit(1);
}

const ROOT           = __dirname;
const PARTNERSHIPS   = path.join(ROOT, 'partnerships.html');
const ABOUT          = path.join(ROOT, 'about.html');
const BEACONS_URL    = 'https://beacons.ai/nikhiln/mediakit?platform=instagram&platform_username=niknaglapur';

// Newsletter subs are not on Beacons — update this manually when needed
const NEWSLETTER_SUBS = '5,000+';

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse response: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Number formatters ────────────────────────────────────────────────────────

function formatFollowers(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M+`;
  if (n >= 1_000)     return `${Math.floor(n / 1_000)}K+`;
  return `${n}+`;
}

function formatImpressions(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M+`;
  if (n >= 1_000)     return `${Math.floor(n / 1_000)}K+`;
  return `${n}+`;
}

function formatEngagement(rate) {
  return `${parseFloat(rate).toFixed(1)}%`;
}

// ─── HTML updater ─────────────────────────────────────────────────────────────

function updateStat(html, oldText, newText) {
  if (html.includes(oldText)) return html;  // already up to date
  return html; // fallback — caller handles replacement via regex
}

function replaceStatInHtml(html, label, newValue) {
  // Matches: <p ...>SOME_VALUE</p>\n          <p ...>LABEL</p>
  // Works for both partnerships.html (text-3xl) and about.html (text-4xl)
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(<p class="[^"]*(?:text-3xl|text-4xl)[^"]*"[^>]*>)[^<]*(</p>\\s*<p [^>]*>[^<]*${escaped}[^<]*</p>)`,
    'g'
  );
  return html.replace(re, `$1${newValue}$2`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Scraping Beacons media kit...');

  const result = await post('https://api.firecrawl.dev/v1/scrape', {
    url: BEACONS_URL,
    formats: ['json'],
    waitFor: 8000,
    jsonOptions: {
      prompt: 'Extract the total followers count, monthly impressions count, and engagement rate percentage as numbers',
      schema: {
        type: 'object',
        properties: {
          followers:      { type: 'number' },
          impressions:    { type: 'number' },
          engagementRate: { type: 'number' },
        },
      },
    },
  });

  const data = result?.data?.json || result?.json;
  if (!data || !data.followers) {
    console.error('Failed to extract stats from Beacons:', JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const followers   = formatFollowers(data.followers);
  const impressions = formatImpressions(data.impressions);
  const engagement  = formatEngagement(data.engagementRate);

  console.log(`Stats: ${followers} followers | ${impressions} impressions | ${engagement} engagement`);

  // Update both HTML files
  for (const filePath of [PARTNERSHIPS, ABOUT]) {
    let html = fs.readFileSync(filePath, 'utf8');
    const before = html;

    html = replaceStatInHtml(html, 'Total Followers', followers);
    html = replaceStatInHtml(html, 'Followers',       followers);
    html = replaceStatInHtml(html, 'Monthly Impressions', impressions);
    html = replaceStatInHtml(html, 'Monthly impressions', impressions);
    html = replaceStatInHtml(html, 'Engagement Rate', engagement);
    html = replaceStatInHtml(html, 'Engagement rate', engagement);
    html = replaceStatInHtml(html, 'Newsletter Subscribers', NEWSLETTER_SUBS);
    html = replaceStatInHtml(html, 'Newsletter subscribers', NEWSLETTER_SUBS);

    if (html !== before) {
      fs.writeFileSync(filePath, html, 'utf8');
      console.log(`Updated: ${path.basename(filePath)}`);
    } else {
      console.log(`No changes: ${path.basename(filePath)}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
