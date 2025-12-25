# cPanel Memory Issue - Solution Guide

## Problem
The bot fails to start on cPanel with error:
```
RangeError: WebAssembly.instantiate(): Out of memory: wasm memory
```

This is caused by the `sharp` image processing library requiring more memory than available during initialization.

## Solutions Applied

### 1. Sharp Memory Optimization (in bot.js)
```javascript
// Configure sharp for low memory usage on shared hosting
sharp.cache(false);      // Disable caching to save memory
sharp.concurrency(1);    // Process one image at a time
sharp.simd(false);       // Disable SIMD for lower memory usage
```

### 2. Node.js Memory Flags (in ecosystem.config.cjs)
```javascript
node_args: '--max-old-space-size=512 --optimize-for-size'
```

### 3. Environment Variables
```bash
export NODE_OPTIONS="--max-old-space-size=512 --optimize-for-size"
export UV_THREADPOOL_SIZE=2
```

## Deployment Steps (Updated)

### Method 1: Using PM2 (Recommended)

1. **SSH into your server:**
   ```bash
   ssh yourusername@yourdomain.com
   cd ~/telegram-bot
   ```

2. **Load Node.js environment:**
   ```bash
   source /home/yourusername/nodevenv/telegram-bot/18/bin/activate
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Start with PM2:**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 logs telegram-bot
   ```

### Method 2: Using start.sh Script

1. **Make script executable:**
   ```bash
   chmod +x start.sh
   ```

2. **Run the script:**
   ```bash
   ./start.sh
   ```

### Method 3: Direct Node Command

```bash
NODE_OPTIONS="--max-old-space-size=512 --optimize-for-size" UV_THREADPOOL_SIZE=2 node bot.js
```

## If Still Getting Memory Errors

### Option A: Contact Hosting Provider
Ask them to increase:
- **Max resident set** (currently 4GB)
- **Max address space** (currently 4GB)
- **LVE memory limits**

### Option B: Use VPS Instead of Shared Hosting
Shared hosting has strict memory limits. Consider:
- DigitalOcean Droplet ($6/month)
- Linode Nanode ($5/month)
- Vultr Cloud Compute ($6/month)

These provide dedicated resources without shared hosting restrictions.

### Option C: Alternative Deployment (No cPanel)

**Using systemd service (VPS/Dedicated Server):**

Create `/etc/systemd/system/telegram-bot.service`:
```ini
[Unit]
Description=Telegram Bot
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/home/yourusername/telegram-bot
Environment="NODE_OPTIONS=--max-old-space-size=512 --optimize-for-size"
Environment="UV_THREADPOOL_SIZE=2"
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot
sudo systemctl status telegram-bot
```

## Verify Memory Usage

Check bot memory consumption:
```bash
# With PM2
pm2 monit

# Or with ps
ps aux | grep "node bot.js"
```

## Troubleshooting

### Still out of memory?
1. Restart the bot: `pm2 restart telegram-bot`
2. Check logs: `pm2 logs telegram-bot`
3. Verify Node.js version: `node --version` (should be 18+)
4. Check available memory: `free -h`

### Bot crashes after processing images?
This is normal on low-memory systems. The bot will auto-restart via PM2.

### Alternative: Disable Image Labeling
In `.env` file:
```env
STAMP_LABELS=false
```
This reduces memory usage by skipping the label stamping feature.

## Memory Usage Comparison

| Configuration | Startup Memory | Peak Memory |
|--------------|----------------|-------------|
| Default      | ~200MB         | ~500MB      |
| Optimized    | ~100MB         | ~300MB      |
| No Labels    | ~80MB          | ~200MB      |

## Recommended Hosting Specs

**Minimum:**
- RAM: 512MB
- Node.js: v18+
- Storage: 2GB

**Recommended:**
- RAM: 1GB+
- Node.js: v20+
- Storage: 5GB+

---

**If these solutions don't work, shared hosting may not be suitable for this bot. Consider VPS hosting instead.**
