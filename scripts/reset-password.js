// Usage:
//   node scripts/reset-password.js <email> <newPassword>
// Example:
//   node scripts/reset-password.js admin@sparklextechnologies.com Sparklex@2026
//
// Runs from posterabackend/postera-backend/. Uses MONGODB_URI from .env.
// The User pre-save hook hashes the password automatically.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

(async () => {
  const [email, newPassword] = process.argv.slice(2);

  if (!email || !newPassword) {
    console.error('Usage: node scripts/reset-password.js <email> <newPassword>');
    process.exit(1);
  }
  if (newPassword.length < 6) {
    console.error('Password must be at least 6 characters');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing in .env');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      console.error(`No user found with email: ${email}`);
      process.exit(1);
    }

    user.password = newPassword;
    await user.save();

    console.log(`✓ Password reset for ${user.email} (role: ${user.role})`);
    console.log('You can now log in with the new password.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
