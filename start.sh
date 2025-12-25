#!/bin/bash

# Telegram Bot Startup Script for cPanel
# This script starts the bot with memory-optimized settings

# Set memory limits
export NODE_OPTIONS="--max-old-space-size=512 --optimize-for-size"
export UV_THREADPOOL_SIZE=2

# Start the bot
node bot.js
