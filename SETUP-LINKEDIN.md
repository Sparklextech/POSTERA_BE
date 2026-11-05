# LinkedIn setup — once, about 10 minutes

No approval needed. No server env vars: keys go in Admin → Integrations.

End users never touch this — they just click "Sign in with LinkedIn" on Postera and it works.

---

## 1. Create the LinkedIn App (3 min)

1. Go to https://www.linkedin.com/developers/apps
2. Click **Create app**
3. Fill in:
   - **App name:** `Postera`
   - **LinkedIn Page:** Pick your Sparklex Technologies company page
   - **Privacy policy URL:** your Postera privacy URL
   - **App logo:** Upload Postera logo
   - **Legal agreement:** check
4. Click **Create app**

---

## 2. Add the two products (instant, no approval) (2 min)

In your new app, go to the **Products** tab and request:

1. **Sign In with LinkedIn using OpenID Connect** — click Request access → instant
2. **Share on LinkedIn** — click Request access → instant

Both are self-serve. No business review. No waiting.

> Do **NOT** request "Marketing Developer Platform" or "Community Management API". They require LinkedIn approval and Postera doesn't need them.

---

## 3. Add the redirect URL (1 min)

Go to the **Auth** tab → **OAuth 2.0 settings** → **Authorized redirect URLs for your app** → **Add redirect URL**:

```
https://<your-domain>/api/linkedin/callback   (copy the exact URL from Admin → Integrations)
```

Click **Update**.

---

## 4. Paste the keys in the admin panel (1 min)

Sign in as a superadmin → **Admin → Integrations & keys → LinkedIn**. Paste the Client ID and Client secret from the LinkedIn app's **Auth** tab and click **Save changes**, then **Test**. Keys are stored encrypted in the database and apply immediately; no redeploy.

The same page lists the exact callback URL to register in step 3.

---

## 5. Test it

1. Open Postera, log in
2. Dashboard shows a blue "Connect LinkedIn" banner
3. Click **Sign in with LinkedIn** → LinkedIn permission screen → Allow
4. You're back on Postera with "LinkedIn connected"
5. Click **Send test post** — a Postera test appears on your LinkedIn feed

After this:
- Every Postera user signs in, clicks Connect, OAuths their own LinkedIn against your one Sparklex app
- Scheduled posts auto-publish to each user's feed via `services/schedulerService.js` cron
- Tokens last 60 days per user; UI prompts re-connect when expired
- The OAuth callback automatically redirects back to whichever frontend domain started the flow — works for Vercel preview, production, custom domain, and localhost without any extra config

---

## What you get

- `w_member_social` — post on behalf of authenticated users
- `openid profile` — get user's LinkedIn name + ID
- ~100 posts per user per day (LinkedIn default rate limit)

## What this does NOT give

- Posting to other people's company pages (needs MDP approval — weeks)
- Reading post analytics / comments (needs Community Management API approval)
- Posting without each user OAuth (every user must click Connect once)

For Postera's case (each user wants to auto-post to their own feed), this is exactly enough.
