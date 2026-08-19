require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')));

app.use('/api/tables', require('./tables'));
app.use('/api/posts', require('./posts'));
app.use('/api/upload', require('./upload'));

app.get('/', (req, res) => res.send('Friends Fried API running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
