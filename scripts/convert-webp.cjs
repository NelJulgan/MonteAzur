/**
 * ============================================================================
 * MONTE AZUR — WEBP IMAGE & TOUR SEQUENCE CONVERSION PIPELINE
 * (scripts/convert-webp.cjs)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Directory Discovery & Sharp Pipeline Setup)
 * - STAGE 2: CORE FUNCTIONALITY (Batch WebP Compression for Editorial & Tour Frames)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Concurrent Worker Pool & Size Telemetry)
 *
 * WHY THIS SCRIPT EXISTS:
 * Converts all high-resolution JPG/PNG editorial photographs and all 240
 * residence tour sequence frames into high-efficiency WebP format across both
 * `assets/` and `public/assets/`.
 *
 * TRICKY LOGIC:
 * - Editorial photos use quality 84 (visually lossless architectural detail).
 * - 240 tour sequence frames use quality 78 + effort 4 for rapid 60fps canvas
 *   decoding and minimal memory footprint.
 *
 * TODO: None - Production WebP asset pipeline complete.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT_DIR = path.join(__dirname, '..');

const TARGET_DIRS = [
  { dir: path.join(ROOT_DIR, 'assets', 'images'), quality: 84 },
  { dir: path.join(ROOT_DIR, 'public', 'assets', 'images'), quality: 84 },
  { dir: path.join(ROOT_DIR, 'assets', 'tour-sequence'), quality: 78 },
  { dir: path.join(ROOT_DIR, 'public', 'assets', 'tour-sequence'), quality: 78 },
];

async function convertDirectory(dirPath, quality) {
  if (!fs.existsSync(dirPath)) return { count: 0, savedBytes: 0 };

  const files = fs.readdirSync(dirPath).filter((f) => /\.(jpe?g|png)$/i.test(f));
  let count = 0;
  let originalBytes = 0;
  let webpBytes = 0;

  const CONCURRENCY = 12;
  let index = 0;

  async function worker() {
    while (index < files.length) {
      const file = files[index++];
      const srcPath = path.join(dirPath, file);
      const outName = file.replace(/\.(jpe?g|png)$/i, '.webp');
      const outPath = path.join(dirPath, outName);

      try {
        const srcStat = fs.statSync(srcPath);
        originalBytes += srcStat.size;

        await sharp(srcPath)
          .webp({ quality, effort: 4 })
          .toFile(outPath);

        const outStat = fs.statSync(outPath);
        webpBytes += outStat.size;
        count++;
      } catch (err) {
        console.error(`Failed converting ${srcPath}:`, err.message);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { count, originalBytes, webpBytes };
}

async function main() {
  console.log('🚀 Starting WebP conversion across all asset directories...');
  let totalConverted = 0;
  let totalOrig = 0;
  let totalWebp = 0;

  for (const target of TARGET_DIRS) {
    const rel = path.relative(ROOT_DIR, target.dir);
    const { count, originalBytes, webpBytes } = await convertDirectory(target.dir, target.quality);
    totalConverted += count;
    totalOrig += originalBytes;
    totalWebp += webpBytes;
    if (count > 0) {
      const origMB = (originalBytes / (1024 * 1024)).toFixed(2);
      const webpMB = (webpBytes / (1024 * 1024)).toFixed(2);
      const pct = (((originalBytes - webpBytes) / originalBytes) * 100).toFixed(1);
      console.log(`✅ ${rel}: Converted ${count} files (${origMB} MB -> ${webpMB} MB, saved ${pct}%)`);
    }
  }

  const totalOrigMB = (totalOrig / (1024 * 1024)).toFixed(2);
  const totalWebpMB = (totalWebp / (1024 * 1024)).toFixed(2);
  const totalPct = totalOrig > 0 ? (((totalOrig - totalWebp) / totalOrig) * 100).toFixed(1) : '0';
  console.log(`\n🎉 Total: ${totalConverted} WebP images generated (${totalOrigMB} MB -> ${totalWebpMB} MB, ${totalPct}% reduction)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
