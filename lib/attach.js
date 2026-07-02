'use strict';
// Pure attachment classification — decides which ingestion path a dropped/attached file takes, so the
// decision is unit-testable without spawning sips/ffmpeg or touching the filesystem. main.js's
// mediaFileToBlocks switches on classifyExt(), so behavior and tests can't drift.
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff'];
const VID_EXT = ['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm'];
// Text-ish files inlined into the prompt so the model works on the ACTUAL content (CSV/code/config/…).
const TEXT_EXT = ['.csv', '.tsv', '.txt', '.md', '.markdown', '.json', '.jsonl', '.ndjson', '.yml', '.yaml',
  '.toml', '.ini', '.env', '.xml', '.html', '.htm', '.css', '.scss', '.sql', '.log', '.rtf',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.sh', '.bash', '.zsh', '.r', '.jl', '.swift', '.kt', '.php', '.pl', '.lua', '.vue', '.svelte', '.tex'];

// → 'image' | 'video' | 'pdf' | 'text' | 'file'
function classifyExt(ext) {
  ext = String(ext || '').toLowerCase();
  if (IMG_EXT.includes(ext)) return 'image';
  if (VID_EXT.includes(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.includes(ext)) return 'text';
  return 'file';
}

module.exports = { IMG_EXT, VID_EXT, TEXT_EXT, classifyExt };
