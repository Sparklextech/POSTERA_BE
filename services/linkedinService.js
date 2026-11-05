const axios = require('axios');
const li = require('../config/linkedin');

const LINKEDIN_API = 'https://api.linkedin.com/v2';
const LINKEDIN_OAUTH = 'https://www.linkedin.com/oauth/v2';

function getAuthorizationUrl(state, scope = 'openid profile email w_member_social') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: li.clientId(),
    redirect_uri: li.redirectUri(),
    scope,
    state: state || Math.random().toString(36).substring(7),
  });
  return `${LINKEDIN_OAUTH}/authorization?${params.toString()}`;
}

async function getAccessToken(code) {
  const response = await axios.post(`${LINKEDIN_OAUTH}/accessToken`, null, {
    params: {
      grant_type: 'authorization_code',
      code,
      client_id: li.clientId(),
      client_secret: li.clientSecret(),
      redirect_uri: li.redirectUri(),
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data;
}

async function getProfile(accessToken) {
  const response = await axios.get(`${LINKEDIN_API}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data;
}

async function createTextPost(accessToken, linkedinId, text) {
  const response = await axios.post(
    `${LINKEDIN_API}/ugcPosts`,
    {
      author: `urn:li:person:${linkedinId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }
  );
  // the share URN may come only in a header; never store an empty id (a retry would post it again)
  return { ...response.data, id: response.data?.id || response.headers?.['x-restli-id'] || 'posted' };
}

async function uploadImage(accessToken, linkedinId, imageBuffer) {
  // Step 1: Register upload
  const registerResponse = await axios.post(
    `${LINKEDIN_API}/assets?action=registerUpload`,
    {
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: `urn:li:person:${linkedinId}`,
        serviceRelationships: [{
          relationshipType: 'OWNER',
          identifier: 'urn:li:userGeneratedContent',
        }],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const uploadUrl = registerResponse.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  const asset = registerResponse.data.value.asset;

  // Step 2: Upload image binary
  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'image/png',
    },
  });

  return asset;
}

async function createImagePost(accessToken, linkedinId, text, imageAsset) {
  const response = await axios.post(
    `${LINKEDIN_API}/ugcPosts`,
    {
      author: `urn:li:person:${linkedinId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'IMAGE',
          media: [{
            status: 'READY',
            media: imageAsset,
          }],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }
  );
  // the share URN may come only in a header; never store an empty id (a retry would post it again)
  return { ...response.data, id: response.data?.id || response.headers?.['x-restli-id'] || 'posted' };
}

// Native video: register a feedshare-video upload, PUT the MP4, then share it. LinkedIn processes the asset
// asynchronously; the post appears once processing finishes.
async function uploadVideo(accessToken, linkedinId, videoBuffer) {
  const reg = await axios.post(`${LINKEDIN_API}/assets?action=registerUpload`, {
    registerUploadRequest: {
      recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
      owner: `urn:li:person:${linkedinId}`,
      serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
    },
  }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
  const uploadUrl = reg.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
  await axios.put(uploadUrl, videoBuffer, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' }, maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 300000 });
  return reg.data.value.asset;
}

async function createVideoPost(accessToken, linkedinId, text, videoAsset, title = '') {
  const response = await axios.post(`${LINKEDIN_API}/ugcPosts`, {
    author: `urn:li:person:${linkedinId}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'VIDEO',
        media: [{ status: 'READY', media: videoAsset, ...(title ? { title: { text: title.slice(0, 200) } } : {}) }],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' } });
  // the share URN may come only in a header; never store an empty id (a retry would post it again)
  return { ...response.data, id: response.data?.id || response.headers?.['x-restli-id'] || 'posted' };
}

module.exports = {
  getAuthorizationUrl,
  getAccessToken,
  getProfile,
  createTextPost,
  uploadImage,
  createImagePost,
  uploadVideo,
  createVideoPost,
};
