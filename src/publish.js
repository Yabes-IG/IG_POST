#!/usr/bin/env node
// IG publisher — pre-rendered MP4 (REELS) or static image (IMAGE feed post).
//
// Usage:
//   node src/publish.js --folder=IGPOST/260605            # REEL or IMAGE auto-detect
//   node src/publish.js --folder=IGPOST/260605 --skip-publish
//
// Auto-detection by file in folder:
//   - reel.mp4               -> media_type=REELS, video_url
//   - image.png / image.jpg  -> media_type=IMAGE, image_url
//   (If both exist, REELS wins.)
//
// Required env:
//   IG_USER_ID         — IG Business Account ID (17-digit, starts 17841)
//   IG_ACCESS_TOKEN    — long-lived user access token (60d)
//   GITHUB_TOKEN       — for gh release create (auto in Actions)
//   GITHUB_REPOSITORY  — owner/repo (auto in Actions, e.g. Yabes-IG/IG_POST)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const folderArg = args.find(a => a.startsWith('--folder='))?.split('=')[1];
const skipPublish = args.includes('--skip-publish');
if (!folderArg) {
  console.error('Missing --folder=IGPOST/YYMMDD');
  process.exit(1);
}

const FOLDER = folderArg.replace(/\/+$/, '');
const SPEC_PATH = path.join(FOLDER, 'spec.json');
if (!fs.existsSync(SPEC_PATH)) {
  console.error(`Missing ${SPEC_PATH}`);
  process.exit(1);
}

// ─── Auto-detect content type ───────────────────────────────────────────────
const reelPath = path.join(FOLDER, 'reel.mp4');
const imgPngPath = path.join(FOLDER, 'image.png');
const imgJpgPath = path.join(FOLDER, 'image.jpg');

let mediaPath, mediaType, urlField, fileName;
if (fs.existsSync(reelPath)) {
  mediaPath = reelPath; mediaType = 'REELS'; urlField = 'video_url'; fileName = 'reel.mp4';
} else if (fs.existsSync(imgPngPath)) {
  mediaPath = imgPngPath; mediaType = 'IMAGE'; urlField = 'image_url'; fileName = 'image.png';
} else if (fs.existsSync(imgJpgPath)) {
  mediaPath = imgJpgPath; mediaType = 'IMAGE'; urlField = 'image_url'; fileName = 'image.jpg';
} else {
  console.error(`No reel.mp4 or image.png/jpg in ${FOLDER}`);
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const folderName = path.basename(FOLDER);
const tag = `${mediaType.toLowerCase()}-${folderName}-${Date.now()}`;
const title = spec.title || `${mediaType === 'REELS' ? 'Reel' : 'Post'} ${folderName}`;
const caption = spec.caption || '';
const thumbOffsetMs = spec.thumbOffsetMs ?? 1000;

const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY;
if (!IG_USER_ID || !IG_ACCESS_TOKEN || !GH_REPO) {
  console.error('Missing IG_USER_ID / IG_ACCESS_TOKEN / GITHUB_REPOSITORY env');
  process.exit(1);
}

const log = (...args) => console.log('[publish]', ...args);
const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

log(`folder:     ${FOLDER}`);
log(`media_type: ${mediaType}`);
log(`file:       ${fileName} (${(fs.statSync(mediaPath).size / 1e6).toFixed(2)} MB)`);
log(`tag:        ${tag}`);
log(`title:      ${title}`);
log(`caption:    ${caption.slice(0, 80)}${caption.length > 80 ? '…' : ''}`);

// ─── 1. Upload media as a GitHub Release asset (public URL for Meta) ────────
log('Creating GitHub Release...');
sh(`gh release create "${tag}" "${mediaPath}" --title "${title}" --notes "${folderName}" --repo "${GH_REPO}"`);
const mediaUrl = `https://github.com/${GH_REPO}/releases/download/${tag}/${fileName}`;
log(`${urlField}: ${mediaUrl}`);

if (skipPublish) {
  log('--skip-publish set — stopping after release upload.');
  process.exit(0);
}

// ─── 2. Create media container ──────────────────────────────────────────────
log('POSTing to /media (create container)...');
const params = new URLSearchParams({
  media_type: mediaType,
  [urlField]: mediaUrl,
  caption,
  access_token: IG_ACCESS_TOKEN,
});
if (mediaType === 'REELS') {
  params.append('thumb_offset', String(thumbOffsetMs));
}
const createRes = await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/media`, {
  method: 'POST',
  body: params,
});
const createJson = await createRes.json();
if (!createRes.ok || !createJson.id) {
  console.error('Create media failed:', JSON.stringify(createJson));
  process.exit(1);
}
const creationId = createJson.id;
log(`creation_id: ${creationId}`);

// ─── 3. Poll until FINISHED (images usually within ~5s, reels 30-90s) ───────
log('Polling status...');
const pollMaxMs = mediaType === 'IMAGE' ? 60_000 : 300_000;
const deadline = Date.now() + pollMaxMs;
while (Date.now() < deadline) {
  await sleep(mediaType === 'IMAGE' ? 3000 : 5000);
  const statusRes = await fetch(
    `https://graph.facebook.com/v21.0/${creationId}?fields=status_code,status&access_token=${IG_ACCESS_TOKEN}`,
  );
  const status = await statusRes.json();
  log(`  status: ${status.status_code} ${status.status || ''}`);
  if (status.status_code === 'FINISHED') break;
  if (status.status_code === 'ERROR') {
    console.error('Media processing ERROR:', JSON.stringify(status));
    process.exit(1);
  }
}

// ─── 4. Publish ─────────────────────────────────────────────────────────────
log('POSTing to /media_publish...');
const pubParams = new URLSearchParams({
  creation_id: creationId,
  access_token: IG_ACCESS_TOKEN,
});
const pubRes = await fetch(`https://graph.facebook.com/v21.0/${IG_USER_ID}/media_publish`, {
  method: 'POST',
  body: pubParams,
});
const pubJson = await pubRes.json();
if (!pubRes.ok || !pubJson.id) {
  console.error('Publish failed:', JSON.stringify(pubJson));
  process.exit(1);
}
log(`✅ Published media_id: ${pubJson.id}`);

// Try to resolve permalink
try {
  const permRes = await fetch(`https://graph.facebook.com/v21.0/${pubJson.id}?fields=permalink&access_token=${IG_ACCESS_TOKEN}`);
  const perm = await permRes.json();
  if (perm.permalink) log(`   IG URL: ${perm.permalink}`);
} catch (e) {}
