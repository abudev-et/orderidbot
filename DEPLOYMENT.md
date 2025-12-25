# Telegram Bot - cPanel Deployment Guide

This guide will help you deploy the Telegram ID Card PDF Generator bot to cPanel shared hosting.

## Prerequisites

- cPanel hosting account with Node.js support (v18 or higher)
- SSH access to your hosting account
- Your Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Your Telegram User ID (get from [@userinfobot](https://t.me/userinfobot))

## Step 1: Prepare Your Files

1. **Upload files to cPanel:**
   - Use File Manager or FTP to upload all files to your hosting directory
   - Recommended path: `/home/yourusername/telegram-bot/`
   - Upload these files:
     - `bot.js`
     - `package.json`
     - `ecosystem.config.cjs`
     - `.env` (create this file)

2. **Create `.env` file:**
   ```env
   BOT_TOKEN=your_bot_token_here
   STAMP_LABELS=false
   ADMIN_ID=your_telegram_user_id
   ```

## Step 2: Setup Node.js Application in cPanel

1. **Login to cPanel**
2. **Find "Setup Node.js App"** (or "Node.js Selector")
3. **Create Application:**
   - Node.js version: 18.x or higher
   - Application mode: Production
   - Application root: `/home/yourusername/telegram-bot`
   - Application URL: Leave blank (not needed for Telegram bot)
   - Application startup file: `bot.js`
   - Click "Create"

## Step 3: Install Dependencies via SSH

1. **Connect via SSH:**
   ```bash
   ssh yourusername@yourdomain.com
   ```

2. **Navigate to bot directory:**
   ```bash
   cd ~/telegram-bot
   ```

3. **Load Node.js environment:**
   ```bash
   source /home/yourusername/nodevenv/telegram-bot/18/bin/activate
   ```
   *(Path may vary - check cPanel Node.js App settings)*

4. **Install dependencies:**
   ```bash
   npm install
   ```

5. **Install PM2 globally (for process management):**
   ```bash
   npm install -g pm2
   ```

## Step 4: Start the Bot

### Option A: Using PM2 (Recommended)

1. **Start with PM2:**
   ```bash
   pm2 start ecosystem.config.cjs
   ```

2. **Save PM2 process list:**
   ```bash
   pm2 save
   ```

3. **Setup PM2 to start on reboot:**
   ```bash
   pm2 startup
   ```
   *(Follow the command it outputs)*

4. **Check status:**
   ```bash
   pm2 status
   pm2 logs telegram-bot
   ```

### Option B: Using Node directly

```bash
nohup node bot.js > bot.log 2>&1 &
```

## Step 5: Verify Bot is Running

1. Open Telegram and find your bot
2. Send `/start` command
3. You should receive the welcome message

## Managing the Bot

### View logs:
```bash
pm2 logs telegram-bot
```

### Restart bot:
```bash
pm2 restart telegram-bot
```

### Stop bot:
```bash
pm2 stop telegram-bot
```

### Delete bot from PM2:
```bash
pm2 delete telegram-bot
```

## Troubleshooting

### Bot not responding:
1. Check if process is running: `pm2 status`
2. Check logs: `pm2 logs telegram-bot`
3. Verify `.env` file has correct BOT_TOKEN
4. Check Node.js version: `node --version` (should be 18+)

### "Module not found" errors:
```bash
cd ~/telegram-bot
source /home/yourusername/nodevenv/telegram-bot/18/bin/activate
npm install
pm2 restart telegram-bot
```

### Permission errors:
```bash
chmod -R 755 ~/telegram-bot
chmod 600 ~/telegram-bot/.env
```

### Out of memory:
- Check PM2 config in `ecosystem.config.cjs`
- Increase `max_memory_restart` if needed
- Contact hosting provider for memory limits

## Auto-restart on Server Reboot

Add to crontab:
```bash
crontab -e
```

Add this line:
```
@reboot cd /home/yourusername/telegram-bot && /usr/bin/pm2 resurrect
```

## Security Notes

1. **Never commit `.env` file to Git** - it contains sensitive tokens
2. **Keep `.env` permissions restricted:** `chmod 600 .env`
3. **Regularly update dependencies:** `npm update`
4. **Monitor logs for suspicious activity**
5. **Only share ADMIN_ID with trusted users**

## File Structure

```
telegram-bot/
├── bot.js                    # Main bot code
├── package.json              # Dependencies
├── ecosystem.config.cjs      # PM2 configuration
├── .env                      # Environment variables (SECRET!)
├── .gitignore               # Git ignore rules
├── data/                    # User uploaded images (auto-created)
│   └── {chatId}/           # Per-user folders
└── logs/                    # PM2 logs (auto-created)
    ├── err.log
    ├── out.log
    └── combined.log
```

## Support

If you encounter issues:
1. Check logs: `pm2 logs telegram-bot`
2. Verify all dependencies are installed: `npm list`
3. Test locally first before deploying
4. Contact your hosting provider for Node.js support

## Updating the Bot

1. Upload new `bot.js` file
2. Restart: `pm2 restart telegram-bot`
3. Check logs: `pm2 logs telegram-bot`

---

**Bot is now deployed and running 24/7 on your cPanel hosting!** 🎉
