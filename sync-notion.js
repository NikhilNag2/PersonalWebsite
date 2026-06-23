#!/usr/bin/env node
/**
 * sync-notion.js
 *
 * Checks the Notion Prompt Database for new pages and:
 *   1. Generates an HTML resource page from the Notion content
 *   2. Inserts an entry at the top of resources.html
 *   3. Saves the page ID to synced.json so it's never processed twice
 *
 * Run manually:  node sync-notion.js
 * GitHub Action: runs hourly via .github/workflows/sync-notion.yml
 *
 * Required env vars:
 *   NOTION_API_KEY  — your Notion internal integration token
 */

'use strict';

const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const NOTION_API_KEY = process.env.NOTION_API_KEY;
if (!NOTION_API_KEY) {
  console.error('Error: NOTION_API_KEY environment variable is not set.');
  process.exit(1);
}

// Notion Prompt Database UUID — taken from the database page URL:
// https://www.notion.so/3482539e36298078bcebc8be87a06b8a
const DB_ID = process.env.NOTION_DB_ID || '3482539e-3629-8078-bceb-c8be87a06b8a';

const ROOT         = __dirname;
const SYNCED_FILE  = path.join(ROOT, 'synced.json');
const RESOURCES_HTML = path.join(ROOT, 'resources.html');

const notion = new Client({ auth: NOTION_API_KEY });

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(title) {
  return title
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')   // strip emoji
    .replace(/[\u2000-\u2BFF]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/[-]+$/, '');
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ─── Rich Text → HTML ────────────────────────────────────────────────────────

function rtToHtml(richTexts) {
  if (!richTexts || richTexts.length === 0) return '';
  return richTexts.map(rt => {
    let text = escHtml(rt.plain_text);
    const a = rt.annotations || {};
    if (rt.href)          text = `<a href="${rt.href}" target="_blank" rel="noopener">${text}</a>`;
    if (a.code)           text = `<code>${text}</code>`;
    if (a.bold)           text = `<strong>${text}</strong>`;
    if (a.italic)         text = `<em>${text}</em>`;
    if (a.strikethrough)  text = `<del>${text}</del>`;
    if (a.underline)      text = `<u>${text}</u>`;
    return text;
  }).join('');
}

// ─── Fetch all blocks (handles pagination) ───────────────────────────────────

async function fetchBlocks(blockId) {
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return blocks;
}

// ─── Blocks → HTML ───────────────────────────────────────────────────────────

async function blocksToHtml(blocks) {
  let html = '';
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    const type  = block.type;
    const data  = block[type];

    // Collect consecutive bullet list items
    if (type === 'bulleted_list_item') {
      let items = '';
      while (i < blocks.length && blocks[i].type === 'bulleted_list_item') {
        items += `<li>${rtToHtml(blocks[i].bulleted_list_item.rich_text)}</li>`;
        i++;
      }
      html += `<ul>${items}</ul>`;
      continue;
    }

    // Collect consecutive numbered list items
    if (type === 'numbered_list_item') {
      let items = '';
      while (i < blocks.length && blocks[i].type === 'numbered_list_item') {
        items += `<li>${rtToHtml(blocks[i].numbered_list_item.rich_text)}</li>`;
        i++;
      }
      html += `<ol>${items}</ol>`;
      continue;
    }

    switch (type) {
      case 'paragraph': {
        const text = rtToHtml(data.rich_text);
        if (text.trim()) html += `<p>${text}</p>\n`;
        break;
      }
      case 'heading_1':
        html += `<h2>${rtToHtml(data.rich_text)}</h2>\n`;
        break;
      case 'heading_2':
        html += `<h2>${rtToHtml(data.rich_text)}</h2>\n`;
        break;
      case 'heading_3':
        html += `<h3>${rtToHtml(data.rich_text)}</h3>\n`;
        break;
      case 'code': {
        const lang = data.language || '';
        const code = data.rich_text.map(rt => rt.plain_text).join('');
        html += `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escHtml(code)}</code></pre>\n`;
        break;
      }
      case 'quote':
        html += `<blockquote>${rtToHtml(data.rich_text)}</blockquote>\n`;
        break;
      case 'callout': {
        const emoji = data.icon?.emoji || '';
        html += `<blockquote>${emoji ? `${emoji} ` : ''}${rtToHtml(data.rich_text)}</blockquote>\n`;
        break;
      }
      case 'divider':
        html += `<hr>\n`;
        break;
      case 'toggle': {
        const summary = rtToHtml(data.rich_text);
        let body = '';
        if (block.has_children) {
          const children = await fetchBlocks(block.id);
          body = await blocksToHtml(children);
        }
        html += `<details><summary>${summary}</summary><div class="details-body">${body}</div></details>\n`;
        break;
      }
      case 'table': {
        const rows = await fetchBlocks(block.id);
        let tbl = '<table>\n';
        for (const row of rows) {
          if (row.type !== 'table_row') continue;
          tbl += '<tr>';
          for (const cell of row.table_row.cells) {
            tbl += `<td>${rtToHtml(cell)}</td>`;
          }
          tbl += '</tr>\n';
        }
        tbl += '</table>\n';
        html += tbl;
        break;
      }
      case 'image': {
        const url = data.type === 'external' ? data.external?.url : data.file?.url;
        const caption = data.caption?.map(rt => rt.plain_text).join('') || '';
        if (url) html += `<img src="${url}" alt="${escHtml(caption)}" style="max-width:100%;border-radius:8px;margin:1rem 0;">\n`;
        break;
      }
      default:
        // skip unsupported block types
        break;
    }

    i++;
  }

  return html;
}

// ─── Page template ───────────────────────────────────────────────────────────

function generatePage({ title, categoryLabel, contentHtml }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="icon" type="image/png" href="favicon.png"><title>${escHtml(title)} — Nikhil Naglapur</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"><script src="https://cdn.tailwindcss.com"></script><script>tailwind.config={theme:{extend:{fontFamily:{serif:['Outfit','system-ui','sans-serif'],sans:['Outfit','system-ui','sans-serif']}}}}</script><style>body{background:#131C2B;color:#F2F2F2}nav{backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);background-color:rgba(19,28,43,.92)!important}.nav-link{position:relative;color:#777;transition:color .18s ease}.nav-link:hover,.nav-link.active{color:#F2F2F2}.nav-link::after{content:'';position:absolute;bottom:-3px;left:0;width:0;height:1px;background:#00B4FF;transition:width .22s ease}.nav-link:hover::after{width:100%}.btn-blue{background:#00B4FF;color:#fff;transition:all .18s ease}.btn-blue:hover{background:#0090CC;box-shadow:0 0 24px rgba(0,180,255,.4);transform:translateY(-1px)}.content h1{font-size:2.1rem;line-height:1.1;font-weight:800;color:#fff;margin:2.5rem 0 1rem}.content h2{font-size:1.55rem;line-height:1.2;font-weight:750;color:#fff;margin:2.35rem 0 .85rem}.content h3{font-size:1.15rem;font-weight:700;color:#E8E8E8;margin:1.65rem 0 .6rem}.content p,.content li{color:#9A9A9A;line-height:1.78;font-size:15px}.content p{margin-bottom:1rem}.content strong{color:#DCDCDC;font-weight:700}.content em{color:#C8C8C8}.content ul,.content ol{margin:0 0 1.2rem 1.35rem}.content ul{list-style:disc}.content ol{list-style:decimal}.content li{margin:.35rem 0}.content hr{border:0;border-top:1px solid #1E2D42;margin:2rem 0}.content blockquote{border-left:3px solid #00B4FF;background:rgba(0,180,255,.06);border-radius:0 8px 8px 0;padding:1rem 1.15rem;margin:1.4rem 0;color:#CFCFCF;line-height:1.7}.content pre{background:#142540;border:1px solid #2E4060;border-radius:8px;padding:1rem;overflow:auto;margin:1.25rem 0;color:#D6D6D6;font-size:14px;line-height:1.65}.content code{background:#162A45;border:1px solid #2E4060;border-radius:5px;padding:.1rem .28rem;color:#E6E6E6;font-size:.92em}.content pre code{background:transparent;border:0;padding:0;color:inherit}.content table{width:100%;border-collapse:collapse;margin:1.4rem 0;border:1px solid #2A3A52;border-radius:8px;overflow:hidden;display:table}.content tr{border-bottom:1px solid #2A3A52}.content tr:last-child{border-bottom:0}.content td{border-right:1px solid #2A3A52;padding:.8rem;vertical-align:top;color:#999;font-size:14px;line-height:1.55}.content td:last-child{border-right:0}.content tr:first-child td{color:#F2F2F2;font-weight:700;background:#142540}.content details{border:1px solid #2A3A52;border-radius:8px;margin:1rem 0;background:#122238}.content summary{cursor:pointer;padding:1rem;color:#F2F2F2;font-weight:650;list-style:none}.content summary::-webkit-details-marker{display:none}.content summary::before{content:"+ ";color:#00B4FF}.content details[open] summary::before{content:"− ";color:#00B4FF}.content .details-body{padding:0 1rem 1rem}@media(max-width:640px){.content table{display:block;overflow-x:auto}.content h1{font-size:1.7rem}}</style></head>
<body class="font-sans">
  <nav class="sticky top-0 z-50 border-b border-[#1E2D42]">
    <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
      <a href="index.html" class="flex items-center gap-2.5">
        <img src="nikhil2.png" alt="Nikhil" class="w-8 h-8 rounded-full object-cover border border-[#2E4060]" style="object-position:center 35%;">
        <span class="font-semibold text-sm text-white">Nikhil</span>
      </a>
      <div class="hidden md:flex items-center gap-7 text-sm">
        <a href="index.html" class="nav-link">Home</a>
        <a href="resources.html" class="nav-link active">Resources</a>
        <a href="ai-solutions.html" class="nav-link">Consulting</a>
        <a href="partnerships.html" class="nav-link">Partnerships</a>
        <a href="newsletter.html" class="nav-link">Newsletter</a>
      </div>
      <a href="newsletter.html#newsletter-signup" class="btn-blue text-sm font-semibold px-5 py-2.5 rounded-full">Sign up to newsletter</a>
    </div>
  </nav>

  <main class="max-w-3xl mx-auto px-6 py-14">
    <a href="resources.html" class="inline-flex items-center gap-1.5 text-[#00B4FF] text-sm font-medium mb-10 hover:underline">← Back to Resources</a>
    <div class="flex items-center gap-2.5 mb-4">
      <span class="w-2 h-2 rounded-full bg-[#00B4FF]" style="box-shadow:0 0 8px rgba(0,180,255,.8);"></span>
      <p class="text-[#00B4FF] text-xs font-semibold uppercase tracking-[0.18em]">${escHtml(categoryLabel)}</p>
    </div>
    <h1 class="font-serif text-4xl md:text-5xl font-bold leading-[1.08] mb-10 text-white">${escHtml(title)}</h1>

    <article class="content">
      ${contentHtml}
    </article>
  </main>

  <footer class="border-t border-[#1E2D42]" style="background:#131C2B;">
    <div class="max-w-6xl mx-auto px-6 pt-8 pb-4 flex flex-col md:flex-row items-center justify-between gap-5">
      <div class="flex items-center gap-2.5">
        <img src="nikhil2.png" alt="Nikhil" class="w-6 h-6 rounded-full object-cover border border-[#2E4060]" style="object-position:center 35%;">
        <span class="text-sm font-semibold text-white">Nikhil</span>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-6 text-sm text-[#8A9AB0]">
        <a href="index.html" class="hover:text-white transition-colors">Home</a>
        <a href="resources.html" class="hover:text-white transition-colors">Resources</a>
        <a href="ai-solutions.html" class="hover:text-white transition-colors">Consulting</a>
        <a href="partnerships.html" class="hover:text-white transition-colors">Partnerships</a>
        <a href="newsletter.html" class="hover:text-white transition-colors">Newsletter</a>
      </div>
    </div>
    <div class="max-w-6xl mx-auto px-6 pb-6 mt-2 flex items-center justify-between">
      <p class="text-[#6F8298] text-xs">© 2026 Nikhil Naglapur</p>
      <p class="text-[#6F8298] text-xs">Email: <a href="mailto:niknaglapur@gmail.com" class="text-[#00B4FF] hover:underline">niknaglapur@gmail.com</a></p>
    </div>
  </footer>
</body>
</html>`;
}

// ─── resources.html entry ─────────────────────────────────────────────────────

function makeEntry({ dateStr, category, categoryLabel, title, shortDesc, longDesc, href }) {
  return `
    <!-- ${dateStr} (auto-synced) -->
    <div class="resource-item py-5 cursor-pointer select-none" data-category="${category}" onclick="toggleResource(this)">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          <p class="text-[#00B4FF] text-[10px] font-semibold uppercase tracking-wider mb-1.5">${escHtml(categoryLabel)}</p>
          <h3 class="font-semibold text-base leading-snug mb-1 text-white">${escHtml(title)}</h3>
          <p class="text-[#555] text-sm leading-relaxed">${escHtml(shortDesc)}</p>
          <div class="resource-detail mt-3">
            <p class="text-[#555] text-sm leading-relaxed mb-3">${escHtml(longDesc)}</p>
            <a href="${href}" onclick="event.stopPropagation()" class="inline-flex items-center gap-1 text-[#00B4FF] text-sm font-medium hover:underline">Access Resource →</a>
          </div>
        </div>
        <span class="expand-icon flex-shrink-0 mt-0.5 font-light">+</span>
      </div>
    </div>`;
}

function prependToResourceList(entry) {
  let html = fs.readFileSync(RESOURCES_HTML, 'utf8');
  // Insert right after the opening tag of the resource list container
  const MARKER = 'id="resource-list">';
  const idx = html.indexOf(MARKER);
  if (idx === -1) throw new Error('Cannot find resource list insertion point in resources.html');
  const insertAt = idx + MARKER.length;
  html = html.slice(0, insertAt) + entry + html.slice(insertAt);
  fs.writeFileSync(RESOURCES_HTML, html, 'utf8');
}

// ─── Description extraction ───────────────────────────────────────────────────

function extractDescriptions(commentsText, blocks) {
  let shortDesc = '';
  let longDesc  = '';

  // Strip [Category: X] prefix from comments if present
  const cleaned = commentsText.replace(/^\[Category:\s*\w+\]\s*/i, '').trim();

  if (cleaned) {
    // Use the comments field — split on ". " to get sentences
    const sentences = cleaned.match(/[^.!?]+[.!?]*/g) || [cleaned];
    shortDesc = sentences.slice(0, 2).join(' ').trim();
    longDesc  = sentences.slice(2).join(' ').trim() || shortDesc;
  } else {
    // Fall back to first paragraphs from the page content
    const paras = blocks
      .filter(b => b.type === 'paragraph')
      .map(b => b.paragraph.rich_text.map(rt => rt.plain_text).join('').trim())
      .filter(Boolean);
    shortDesc = paras[0] || '';
    longDesc  = paras[1] || shortDesc;
  }

  if (shortDesc.length > 130) shortDesc = shortDesc.slice(0, 127) + '…';
  if (longDesc.length  > 220) longDesc  = longDesc.slice(0, 217) + '…';
  return { shortDesc, longDesc };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load already-synced state
  let synced = {};
  if (fs.existsSync(SYNCED_FILE)) {
    synced = JSON.parse(fs.readFileSync(SYNCED_FILE, 'utf8'));
  }

  // Query Notion Prompt Database
  let pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      filter: { property: 'Add to website', checkbox: { equals: true } },
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  console.log(`Found ${pages.length} pages in Notion, ${Object.keys(synced).length} already synced.`);

  let addedCount = 0;

  for (const page of pages) {
    const pageId = page.id;

    if (synced[pageId]) {
      continue;  // already processed
    }

    // ── Extract title ──────────────────────────────────────────────────────
    const titleArr = page.properties?.Prompts?.title || [];
    const title = titleArr.map(t => t.plain_text).join('').trim();
    if (!title) {
      console.log(`Skipping ${pageId}: no title`);
      synced[pageId] = { skipped: true };
      continue;
    }

    console.log(`Processing: "${title}"`);

    // ── Extract comments ───────────────────────────────────────────────────
    const commentsArr  = page.properties?.Comments?.rich_text || [];
    const commentsText = commentsArr.map(t => t.plain_text).join('').trim();

    // ── Determine category ─────────────────────────────────────────────────
    // Default: "prompts". Override by adding [Category: skills] in Comments.
    const catMatch = commentsText.match(/^\[Category:\s*(\w+)\]/i);
    const category      = catMatch ? catMatch[1].toLowerCase() : 'prompts';
    const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

    // ── Fetch page blocks ──────────────────────────────────────────────────
    let blocks = [];
    try {
      blocks = await fetchBlocks(pageId);
    } catch (err) {
      console.error(`Failed to fetch blocks for "${title}":`, err.message);
      continue;
    }

    // ── Generate descriptions ──────────────────────────────────────────────
    const { shortDesc, longDesc } = extractDescriptions(commentsText, blocks);

    // ── Convert blocks to HTML ─────────────────────────────────────────────
    const contentHtml = await blocksToHtml(blocks);

    // ── Determine filename ─────────────────────────────────────────────────
    const slug     = slugify(title);
    const filename = `${slug}.html`;
    const filePath = path.join(ROOT, filename);

    if (fs.existsSync(filePath)) {
      console.log(`  File already exists: ${filename} — skipping page generation`);
    } else {
      const pageHtml = generatePage({ title, categoryLabel, contentHtml });
      fs.writeFileSync(filePath, pageHtml, 'utf8');
      console.log(`  Generated: ${filename}`);
    }

    // ── Add entry to resources.html ────────────────────────────────────────
    const dateStr = formatDate(page.created_time);
    const entry = makeEntry({ dateStr, category, categoryLabel, title, shortDesc, longDesc, href: filename });
    prependToResourceList(entry);
    console.log(`  Added to resources.html`);

    // ── Mark as synced ─────────────────────────────────────────────────────
    synced[pageId] = {
      title,
      filename,
      category,
      syncedAt:  new Date().toISOString(),
      createdAt: page.created_time,
    };
    addedCount++;
  }

  // Persist synced state
  fs.writeFileSync(SYNCED_FILE, JSON.stringify(synced, null, 2), 'utf8');
  console.log(`\nDone. Added ${addedCount} new resource(s).`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
