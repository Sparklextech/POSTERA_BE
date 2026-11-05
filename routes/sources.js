const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth');
const Source = require('../models/Source');
const { ingestFile, ingestText, ingestWebsite } = require('../services/sourceService');

const router = express.Router();
const tmpDir = path.join(__dirname, '..', 'uploads', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir, limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/', auth, async (req, res) => {
  const sources = await Source.find({ user: req.userId }).sort({ createdAt: -1 }).select('-text');
  res.json(sources);
});

router.get('/:id', auth, async (req, res) => {
  const s = await Source.findOne({ _id: req.params.id, user: req.userId });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// PDF / PPTX / DOCX / TXT / MD
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await ingestFile(req.user, req.file);
    res.status(201).json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/website', auth, async (req, res) => {
  try {
    if (!req.body.url) return res.status(400).json({ error: 'URL is required' });
    const result = await ingestWebsite(req.user, req.body.url);
    res.status(201).json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/text', auth, async (req, res) => {
  try {
    const result = await ingestText(req.user, req.body.name, req.body.text);
    res.status(201).json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  await Source.findOneAndDelete({ _id: req.params.id, user: req.userId });
  res.json({ message: 'Deleted' });
});

module.exports = router;
