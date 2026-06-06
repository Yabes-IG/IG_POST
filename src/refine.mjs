#!/usr/bin/env node
// Refine an image via fal-ai/nano-banana/edit at highest quality.
//
// Usage:
//   node src/refine.mjs --folder=IGPOST/260606
//   node src/refine.mjs --folder=IGPOST/260606 --branch=staging
//
// Reads IGPOST/{date}/image.png, sends to nano-banana for highest-quality
// refinement (sharpen, color, detail — composition + face + text preserved),
// saves the result back to IGPOST/{date}/image.png. Keeps the original at
// image_original.png as backup if it doesn't already exist.
//
// Required env:
//   FAL_KEY
//   GITHUB_REPOSITORY  (defaults to Yabes-IG/IG_POST if unset)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env if present
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error('Missing FAL_KEY in env or .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const folderArg = args.find(a => a.startsWith('--folder='))?.split('=')[1];
const branchArg = args.find(a => a.startsWith('--branch='))?.split('=')[1] || 'staging';
if (!folderArg) {
  console.error('Missing --folder=IGPOST/YYMMDD');
  process.exit(1);
}

const FOLDER = folderArg.replace(/\/+$/, '');
const IMG = path.join(ROOT, FOLDER, 'image.png');
const BACKUP = path.join(ROOT, FOLDER, 'image_original.png');
if (!fs.existsSync(IMG)) {
  console.error(`Missing ${IMG}`);
  process.exit(1);
}

const REPO = process.env.GITHUB_REPOSITORY || 'Yabes-IG/IG_POST';
const rawUrl = `https://raw.githubusercontent.com/${REPO}/${branchArg}/${FOLDER}/image.png`;

const PROMPT = [
  'Enhance this image to professional commercial photography quality.',
  'Keep the EXACT same composition, layout, person identity, text, branding, logo, and colors.',
  'Improve only: sharpness, micro-detail, lighting balance, color depth, edge clarity, gradient smoothness.',
  'Preserve the Indonesian woman face features and expression identically.',
  'Preserve all five feature bullet checkmarks and their text legibility exactly:',
  '"Property Management System / Residential Management", "Facility Management System",',
  '"Automated Utility Billing System", "Integrated Accounting & Financial Software", "Mobile Apps".',
  'Preserve the "vp+" logo and the title "Mau dapat semua ceklist dalam 1 Sistem?" exactly.',
  'Output: high resolution PNG, 4K-equivalent quality, no composition changes.',
].join(' ');

const log = (...a) => console.log('[refine]', ...a);
log(`folder:  ${FOLDER}`);
log(`source:  ${rawUrl}`);
log(`prompt:  ${PROMPT.slice(0, 120)}...`);

// ─── Fal queue submit + poll ────────────────────────────────────────────────
async function falQueue(modelPath, body) {
  const submit = await fetch(`https://queue.fal.run/${modelPath}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${await submit.text()}`);
  const { request_id, status_url, response_url } = await submit.json();
  log(`request_id: ${request_id}`);
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 6000));
    const sRes = await fetch(status_url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    if (!sRes.ok) { log(`status fetch ${sRes.status}`); continue; }
    const s = await sRes.json();
    log(`status: ${s.status}`);
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED') throw new Error(`FAILED: ${JSON.stringify(s)}`);
  }
  const r = await fetch(response_url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
  if (!r.ok) throw new Error(`response ${r.status}: ${await r.text()}`);
  return r.json();
}

const result = await falQueue('fal-ai/nano-banana/edit', {
  prompt: PROMPT,
  image_urls: [rawUrl],
  num_images: 1,
  output_format: 'png',
});

const outputUrl = result.images?.[0]?.url || result.image?.url || result.url;
if (!outputUrl) {
  console.error('No output URL in result:', JSON.stringify(result).slice(0, 400));
  process.exit(1);
}
log(`refined URL: ${outputUrl}`);

// Backup the original if no backup yet
if (!fs.existsSync(BACKUP)) {
  fs.copyFileSync(IMG, BACKUP);
  log(`backup saved: ${path.basename(BACKUP)}`);
}

// Download refined image to replace image.png
const dlRes = await fetch(outputUrl);
if (!dlRes.ok) throw new Error(`download ${dlRes.status}`);
const buf = Buffer.from(await dlRes.arrayBuffer());
fs.writeFileSync(IMG, buf);
log(`saved refined: ${IMG} (${(buf.length / 1024).toFixed(1)} KB)`);
log('Done.');
