# Ginni Sales Dashboard

Mobile-first sales dashboard for Integrated Ginni Systems Ltd., powered by Zwing POS data.

## Deploy to Railway (5 steps)

1. Go to https://railway.app and sign up with Google
2. Click "New Project" → "Deploy from GitHub repo"
   - OR click "New Project" → "Empty project" → drag this folder
3. Railway auto-detects Node.js and deploys
4. Click your project → Settings → Generate Domain
5. Share the URL with your team

## First-time setup after deploy

1. Open your Railway URL
2. Login with: **admin / Admin@123** (change this immediately!)
3. Go to ⚙ Settings tab
4. Paste your Zwing cookie string (from browser DevTools)
5. Data loads for all users instantly

## Change admin password

In Settings → Users → Edit the admin user

## Environment Variables (optional, for Railway)

Set these in Railway dashboard → Variables:
- `ADMIN_PASSWORD` — override default admin password
- `SESSION_SECRET` — random string for session security (recommended)

## How Zwing cookies work

The dashboard proxies all Zwing API calls through the server using your session cookie.
Zwing session cookies expire when you log out of Zwing or after ~8 hours.
When expired, go to Settings and paste a fresh cookie.
