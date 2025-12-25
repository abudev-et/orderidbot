# Telegram Bot - Back4App Containers Deployment Guide

This guide will help you deploy the Telegram ID Card PDF Generator bot to Back4App Containers.

## Why Back4App Containers?

✅ **No memory limits** like cPanel shared hosting  
✅ **Free tier available** with generous resources  
✅ **Automatic scaling** and load balancing  
✅ **GitHub integration** for easy deployment  
✅ **Built-in logging** and monitoring  
✅ **Global CDN** for fast performance  

## Prerequisites

1. **GitHub Account** - Your code must be in a GitHub repository
2. **Back4App Account** - Sign up at [https://www.back4app.com](https://www.back4app.com)
3. **Telegram Bot Token** - Get from [@BotFather](https://t.me/BotFather)
4. **Admin Telegram ID** - Get from [@userinfobot](https://t.me/userinfobot)

## Step 1: Prepare Your Repository

### 1.1 Push Code to GitHub

If you haven't already, push your code to GitHub:

```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - Telegram bot for Back4App"

# Add remote repository
git remote add origin https://github.com/yourusername/telegram-bot.git

# Push to GitHub
git push -u origin main
```

### 1.2 Verify Required Files

Make sure these files are in your repository:
- ✅ `bot.js` - Main bot code
- ✅ `package.json` - Dependencies
- ✅ `Dockerfile` - Container configuration
- ✅ `.dockerignore` - Files to exclude from container

**Note:** Do NOT commit `.env` file (it's in `.gitignore`)

## Step 2: Create Back4App Application

### 2.1 Sign Up / Login

1. Go to [https://www.back4app.com](https://www.back4app.com)
2. Click **Sign Up** (or **Login** if you have an account)
3. Complete registration

### 2.2 Create New App

1. Click **NEW APP** button (top-right corner)
2. Select **Containers as a Service**
3. Click **Continue**

### 2.3 Connect GitHub

1. Click **Connect GitHub Account**
2. Authorize Back4App to access your repositories
3. Choose:
   - **All repositories**, or
   - **Only select repositories** (select your bot repo)
4. Click **Install & Authorize**

### 2.4 Select Repository

1. Find your bot repository in the list
2. Click **Select** button

### 2.5 Configure Application

Fill in the following details:

**App Name:**
```
telegram-bot
```
(or any name you prefer)

**Branch:**
```
main
```
(or your default branch name)

**Root Directory:**
```
/
```
(leave as root unless bot is in a subdirectory)

**Environment Variables:**

Click **+ Add Variable** for each:

| Variable Name | Value | Description |
|--------------|-------|-------------|
| `BOT_TOKEN` | `your_bot_token_here` | From @BotFather |
| `ADMIN_ID` | `your_telegram_user_id` | From @userinfobot |
| `STAMP_LABELS` | `false` | Enable/disable image labels |
| `NODE_ENV` | `production` | Production mode |

**Important:** Replace `your_bot_token_here` and `your_telegram_user_id` with actual values!

### 2.6 Deploy

1. Review all settings
2. Click **Create App** button
3. Wait for deployment (usually 2-5 minutes)

## Step 3: Monitor Deployment

### 3.1 Check Deployment Status

You'll see:
- **Building** - Docker image is being built
- **Deploying** - Container is being deployed
- **Running** - Bot is live! ✅

### 3.2 View Logs

1. Click **Logs** tab
2. You should see:
   ```
   ✅ Bot is running...
   ```

### 3.3 Check for Errors

If deployment fails:
1. Check **Logs** for error messages
2. Verify environment variables are set correctly
3. Check Dockerfile syntax
4. See **Troubleshooting** section below

## Step 4: Test Your Bot

1. Open Telegram
2. Find your bot
3. Send `/start` command
4. You should receive the welcome message!

### Test Commands

```
/start   - Start the bot
/reset   - Clear your data
/status  - Check current status
/pdf     - Generate PDF (after sending images)
```

### Test Image Upload

1. Send an image with caption: `front`
2. Bot replies: `✅ FRONT #1 received!`
3. Send another image with caption: `back`
4. Bot replies: `✅ BACK #1 received!`
5. Send `/pdf` command
6. Choose **Normal** or **Flip** orientation
7. Receive your PDF! 📄

## Step 5: Manage Your App

### View App Dashboard

1. Go to Back4App dashboard
2. Click on your app name
3. You'll see:
   - **Overview** - App status and metrics
   - **Deployments** - Deployment history
   - **Logs** - Real-time logs
   - **Settings** - Configuration

### Update Environment Variables

1. Go to **Settings** tab
2. Scroll to **Environment Variables**
3. Click **Edit** to modify
4. Click **Save**
5. App will automatically redeploy

### Redeploy After Code Changes

**Automatic Deployment:**
- Push changes to GitHub
- Back4App automatically detects and redeploys

**Manual Deployment:**
1. Go to **Deployments** tab
2. Click **Deploy** button
3. Select branch
4. Click **Deploy**

### View Logs

```bash
# Real-time logs in dashboard
Go to Logs tab → See live output
```

### Restart App

1. Go to **Settings** tab
2. Scroll to **Danger Zone**
3. Click **Restart App**

### Delete App

1. Go to **Settings** tab
2. Scroll to **Danger Zone**
3. Click **Delete App**
4. Confirm deletion

## Troubleshooting

### Bot Not Responding

**Check logs:**
1. Go to **Logs** tab
2. Look for errors

**Common issues:**
- ❌ Wrong `BOT_TOKEN` → Update in Settings
- ❌ Network issues → Check Back4App status
- ❌ Code errors → Check logs for stack traces

### Deployment Failed

**Build errors:**
```
Error: Cannot find module 'xyz'
```
**Solution:** Add missing dependency to `package.json`

**Docker errors:**
```
Error: COPY failed
```
**Solution:** Check `Dockerfile` syntax

### Out of Memory

Back4App Containers have generous memory limits. If you still hit limits:

1. Check logs for memory usage
2. Optimize image processing
3. Upgrade to paid plan for more resources

### Environment Variables Not Working

1. Verify variable names match exactly (case-sensitive)
2. No quotes needed in Back4App dashboard
3. Redeploy after changing variables

### Images Not Saving

The bot saves images to `/app/data/` inside the container. This is ephemeral storage that resets on redeploy.

**For persistent storage:**
- Consider using cloud storage (AWS S3, Cloudinary, etc.)
- Or accept that data is temporary (users can regenerate PDFs)

## Monitoring & Maintenance

### Check Bot Health

Send `/status` command to your bot regularly to ensure it's responding.

### Monitor Logs

Check logs weekly for:
- Error patterns
- Memory usage
- User activity

### Update Dependencies

```bash
# Update packages locally
npm update

# Test locally
npm start

# Commit and push
git add package.json package-lock.json
git commit -m "Update dependencies"
git push
```

Back4App will automatically redeploy with updated dependencies.

## Scaling

### Free Tier Limits

- **Memory:** 256MB
- **CPU:** Shared
- **Requests:** Unlimited
- **Bandwidth:** 1GB/month

### Upgrade for More Resources

If you need more:
1. Go to **Settings** → **Plan**
2. Choose a paid plan
3. Get more memory, CPU, and bandwidth

## Security Best Practices

1. ✅ **Never commit `.env` file** - Use Back4App environment variables
2. ✅ **Keep dependencies updated** - Run `npm update` regularly
3. ✅ **Monitor logs** - Watch for suspicious activity
4. ✅ **Restrict admin access** - Only share `ADMIN_ID` with trusted users
5. ✅ **Use strong bot token** - Never share your `BOT_TOKEN`

## Cost Estimate

### Free Tier (Recommended for Testing)
- **Cost:** $0/month
- **Memory:** 256MB
- **Good for:** Testing, low-traffic bots

### Starter Plan
- **Cost:** $5/month
- **Memory:** 512MB
- **Good for:** Production bots with moderate traffic

### Pro Plan
- **Cost:** $25/month
- **Memory:** 2GB
- **Good for:** High-traffic bots, multiple instances

## Comparison: Back4App vs cPanel

| Feature | Back4App Containers | cPanel Shared |
|---------|-------------------|---------------|
| Memory Limits | ✅ Generous (256MB+) | ❌ Strict (4GB shared) |
| Deployment | ✅ Git push | ❌ Manual upload |
| Scaling | ✅ Automatic | ❌ Manual |
| Logs | ✅ Built-in | ❌ Limited |
| Cost | ✅ Free tier | 💰 Paid only |
| Setup | ✅ Easy | ❌ Complex |

**Verdict:** Back4App is much better for Telegram bots! 🎉

## Support

### Back4App Resources
- **Documentation:** [https://www.back4app.com/docs-containers](https://www.back4app.com/docs-containers)
- **Community:** [Slack Community](https://join.slack.com/t/back4appcommunity/shared_invite/zt-mul3jkwn-ny7E_6yLIocOmVUjR3mFHQ)
- **Support:** support@back4app.com

### Common Questions

**Q: Can I use a custom domain?**  
A: Yes, in paid plans you can configure custom domains.

**Q: How do I backup my data?**  
A: User data is in `/app/data/` which is ephemeral. Consider cloud storage for persistence.

**Q: Can I run multiple bots?**  
A: Yes, create separate apps for each bot.

**Q: Is my bot always running?**  
A: Yes, containers run 24/7 on Back4App.

## Next Steps

1. ✅ Deploy your bot to Back4App
2. ✅ Test all commands
3. ✅ Share bot with users
4. ✅ Monitor logs regularly
5. ✅ Update code as needed

---

**Your Telegram bot is now running on Back4App Containers! 🚀**

Enjoy hassle-free deployment with automatic scaling and no memory issues!
