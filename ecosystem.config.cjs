module.exports = {
  apps: [{
    name: 'telegram-bot',
    script: 'bot.js',
    interpreter: 'node',
    node_args: '--max-old-space-size=512 --optimize-for-size',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '2'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
