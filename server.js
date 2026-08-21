require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Plate photos live here. On Railway the app filesystem is EPHEMERAL — anything written inside the
// project directory is destroyed on every redeploy, so UPLOAD_DIR must point at a mounted volume
// (e.g. /data) for photos to survive. Uploading and serving both read this same value.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const UPLOAD_DIR_IS_PERSISTENT = !!process.env.UPLOAD_DIR && !path.resolve(UPLOAD_DIR).startsWith(path.resolve(__dirname));

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

app.use('/api/tables', require('./tables'));
app.use('/api/posts', require('./posts'));
app.use('/api/upload', require('./upload'));

app.get('/', (req, res) => res.send('Friends Fried API running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log('[uploads] directory:', UPLOAD_DIR);
  if (UPLOAD_DIR_IS_PERSISTENT) {
    console.log('[uploads] looks persistent — photos should survive redeploys.');
  } else {
    console.warn('[uploads] WARNING: this path is inside the app directory, so it is EPHEMERAL.');
    console.warn('[uploads] Every redeploy will delete all plate photos. Mount a volume and set UPLOAD_DIR to it.');
  }
});
