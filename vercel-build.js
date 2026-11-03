// Vercel build: the dashboard alone as a static site (public/index.html). Vercel can't run the server
// (ffmpeg, yt-dlp, long jobs, big uploads) — that runs on Railway etc. (Dockerfile), at VIDEO_CLIP_API_URL.
const fs = require('fs');

const api = (process.env.VIDEO_CLIP_API_URL || '').trim().replace(/\/+$/, '');
let html = fs.readFileSync('dashboard.html', 'utf8');
if (api) {
  if (!/^https:\/\//i.test(api)) throw new Error(`VIDEO_CLIP_API_URL must be an https:// URL, got "${api}"`);
  const tag = `<script>window.VIDEO_CLIP_API = ${JSON.stringify(api).replace(/</g, '\\u003c')};</script>`;
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${tag}`);
  console.log(`Dashboard → server at ${api}`);
} else {
  console.warn('VIDEO_CLIP_API_URL is not set — the dashboard will run in demo mode (simulated jobs).');
}
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/index.html', html);
