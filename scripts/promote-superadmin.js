// Usage: node scripts/promote-superadmin.js <email>
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

(async () => {
  const [email] = process.argv.slice(2);
  if (!email) { console.error('Usage: node scripts/promote-superadmin.js <email>'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  const result = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { role: 'superadmin' },
    { new: true }
  );
  if (!result) { console.error(`No user found: ${email}`); process.exit(1); }
  console.log(`✓ ${result.email} is now: ${result.role}`);
  process.exit(0);
})();
