#!/usr/bin/env node
// IG Reels publisher — pre-rendered MP4 path.
//
// Usage:
//   node src/publish.js --folder=IGPOST/260605
//   node src/publish.js --folder=IGPOST/260605 --skip-publish
//
// Required env:
//   IG_USER_ID         — IG Business Account ID (17-digit, starts 17841)
//   IG_ACCESS_TOKEN    — long-lived user access token (60d)
//   GITHUB_TOKEN       — for gh release create (auto-provisioned in Actions)
//   GITHUB_REPOSITORY  — owner/repo (auto in Actions, e.g. Yabes-IG/IG_POST)
//
// What it does:
//   1. Read {folder}/spec.json for caption + optional thumbOffsetMs
//   2. Verify {folder}/reel.mp4 exists
//   3. gh release create with a tag based on the folder name + upload reel.mp4
//   4. POST to Graph API /{IG_USER_ID}/media with the public release-asset URL
//   5. Poll the creation_id until FINISHED (~30-90s)
//   6. POST to /{IG_USER_ID}/media_publish — done

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
const REEL_PATH = path.join(FOLDER, 'reel.mp4');

if (!fs.existsSync(SPEC_PATH)) {
  console.error(`Missing ${SPEC_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(REEL_PATH)) {
  console.error(`Missing ${REEL_PATH}`);
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const folderName = path.basename(FOLDER); // "260605"
const tag = `reel-${folderName}-${Date.now()}`;
const title = spec.title || `Reel ${folderName}`;
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
const shCapture = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

log(`folder: ${FOLDER}`);
log(`tag:    ${tag}`);
log(`title:  ${title}`);
log(`caption: ${caption.slice(0, 80)}${caption.length > 80 ? '…' : ''}`);
log(`reel:   ${REEL_PATH} (${(fs.statSync(REEL_PATH).size / 1e6).toFixed(2)} MB)`);

// ─── 1. Upload reel.mp4 as a GitHub Release asset (public URL for Meta) ─────
log('Creating GitHub Release + uploading reel.mp4...');
sh(`gh release create "${tag}" "${REEL_PATH}" --title "${title}" --notes "${folderName}" --repo "${GH_REPO}"`);
const videoUrl = `https://github.com/${GH_REPO}/releases/download/${tag}/reel.mp4`;
log(`video_url: ${videoUrl}`);

if (skipPublish) {
  log('--skip-publish set — stopping after release upload. Release URL above.');
  process.exit(0);
}

// ─── 2. Create media container ──────────────────────────────────────────────
log('POSTing to /media (create container)...');
const params = new URLSearchParams({
  media_type: 'REELS',
  video_url: videoUrl,
  caption,
  thumb_offset: String(thumbOffsetMs),
  access_token: IG_ACCESS_TOKEN,
});
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

// ─── 3. Poll until FINISHED ─────────────────────────────────────────────────
log('Polling status...');
const deadline = Date.now() + 300_000; // 5 min hard cap
while (Date.now() < deadline) {
  await sleep(5000);
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
log(`   IG URL probably: https://www.instagram.com/reel/<shortcode>/  (use Graph API permalink endpoint to resolve)`);
