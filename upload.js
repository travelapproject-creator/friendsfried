const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
// True when UPLOAD_DIR points outside the app directory, i.e. at a mounted volume. Anything inside the
// app directory is wiped on every redeploy.
const isPersistent = !!process.env.UPLOAD_DIR && !path.resolve(uploadDir).startsWith(path.resolve(__dirname));
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// Diagnostic: open /api/upload/status to see where photos are being written and whether that survives
// a redeploy. The failure mode is silent otherwise — uploads succeed, then vanish on the next deploy.
router.get('/status', (req, res) => {
  let files = [];
  try { files = fs.readdirSync(uploadDir); } catch (e) {}
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(uploadDir, f)).size; } catch (e) {}
  }
  res.json({
    upload_dir: uploadDir,
    upload_dir_env_set: !!process.env.UPLOAD_DIR,
    persistent: isPersistent,
    verdict: isPersistent
      ? 'Photos are written outside the app directory and should survive redeploys.'
      : 'EPHEMERAL — every redeploy deletes these files. Mount a volume and set UPLOAD_DIR to its mount path.',
    photo_count: files.length,
    total_mb: +(bytes / 1048576).toFixed(2),
    public_url: process.env.PUBLIC_URL || '(not set — falls back to the request host)'
  });
});

router.post('/', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Must be absolute: the AI rater fetches this URL server-side, and Node's fetch rejects relative paths.
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ url: `${base}/uploads/${req.file.filename}` });
});

// Deletes the files behind a list of stored image URLs. Row deletion cascades in Postgres, but the
// JPEGs would otherwise sit on the volume forever. Best-effort per file: a missing file is not an error.
function deleteUploadsByUrl(urls) {
  let removed = 0;
  for (const url of urls || []) {
    if (!url) continue;
    const name = path.basename(String(url).split('?')[0]);
    // Never let a stored value escape the upload directory.
    if (!name || name.includes('..') || name.includes('/')) continue;
    try {
      fs.unlinkSync(path.join(uploadDir, name));
      removed++;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[upload] could not delete ' + name + ': ' + e.message);
    }
  }
  return removed;
}

module.exports = router;
module.exports.deleteUploadsByUrl = deleteUploadsByUrl;
