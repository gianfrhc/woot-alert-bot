module.exports = {
  apps: [{
    name: 'woot-alert-bot',
    script: 'server.js',
    cwd: __dirname,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production'
    },
    // Log configuration
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  }]
};
