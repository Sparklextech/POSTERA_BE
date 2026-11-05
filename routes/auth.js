const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `logo_${req.userId || 'unknown'}_${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, f, cb) => cb(null, /^image\//.test(f.mimetype)) });

const sign = (user) => jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, company, timezone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: 'Email already registered' });
    const user = new User({ name, email, password, company, timezone: timezone || 'UTC' });
    await user.save();
    res.status(201).json({ token: sign(user), user: user.toPublic() });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user || !(await user.comparePassword(password || ''))) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: sign(user), user: user.toPublic() });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/me', auth, (req, res) => res.json(req.user.toPublic()));

// Profile + brand profile + autopilot-independent prefs
router.put('/profile', auth, async (req, res) => {
  try {
    const { name, company, brandColor, imageMode, timezone, platforms, brandProfile } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (company !== undefined) updates.company = company;
    if (brandColor) updates.brandColor = brandColor;
    if (imageMode) updates.imageMode = imageMode;
    if (timezone) updates.timezone = timezone;
    if (Array.isArray(platforms)) updates.platforms = platforms;
    if (brandProfile && typeof brandProfile === 'object') {
      const keys = ['businessType', 'description', 'audience', 'services', 'usp', 'location', 'tone', 'language', 'website', 'hashtags', 'pillars', 'voice'];
      for (const k of keys) if (brandProfile[k] !== undefined) updates[`brandProfile.${k}`] = brandProfile[k];
    }
    const user = await User.findByIdAndUpdate(req.userId, updates, { new: true });
    res.json(user.toPublic());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/logo', auth, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const logoUrl = `/uploads/${req.file.filename}`;
    await User.findByIdAndUpdate(req.userId, { logo: logoUrl });
    res.json({ logo: logoUrl });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// First user to call this becomes superadmin (only while none exists)
// Bootstrap the first superadmin. Needs the server's ADMIN_BOOTSTRAP_TOKEN (set by the deploy script) and only works
// while no superadmin exists, so a regular sign-up can never claim it.
router.post('/promote-admin', auth, async (req, res) => {
  try {
    const expected = process.env.ADMIN_BOOTSTRAP_TOKEN || '';
    const given = String(req.body?.bootstrapToken || '');
    const match = expected && given.length === expected.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!match) return res.status(403).json({ error: 'Not allowed' });
    if (await User.exists({ role: 'superadmin' })) return res.status(403).json({ error: 'A superadmin already exists' });
    await User.findByIdAndUpdate(req.userId, { role: 'superadmin' });
    // two simultaneous calls: keep only the earliest superadmin
    const supers = await User.find({ role: 'superadmin' }).sort({ updatedAt: 1, _id: 1 }).select('_id');
    if (supers.length > 1) await User.updateMany({ _id: { $in: supers.slice(1).map((s) => s._id) } }, { role: 'user' });
    const won = supers[0]._id.toString() === req.userId.toString();
    res.status(won ? 200 : 409).json({ message: won ? 'You are now the superadmin' : 'Another account became superadmin first' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
