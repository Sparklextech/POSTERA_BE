// LinkedIn OAuth config. Client ID / secret come from the admin panel (database); read them at call time so an admin
// change applies without a restart. The callback registered in the LinkedIn app must equal redirectUri().
const { get } = require('../services/settingsService');

const backendUrl = () => (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
module.exports = {
  clientId: () => get('LINKEDIN_CLIENT_ID'),
  clientSecret: () => get('LINKEDIN_CLIENT_SECRET'),
  backendUrl,
  redirectUri: () => process.env.LINKEDIN_REDIRECT_URI || `${backendUrl()}/api/linkedin/callback`,
  frontendFallback: () => (process.env.FRONTEND_URL || backendUrl()).split(',')[0].trim(),
  isConfigured: () => !!(get('LINKEDIN_CLIENT_ID') && get('LINKEDIN_CLIENT_SECRET')),
};
