const fs = require('node:fs');
const path = require('node:path');
const nodePathFile = path.join(__dirname, '.node-path');
const interpreter = fs.existsSync(nodePathFile) ? fs.readFileSync(nodePathFile, 'utf8').trim() : fs.realpathSync(process.execPath);
module.exports = { apps: [{
  name: 'parcel-bot', cwd: __dirname, script: 'dist/src/main.js', interpreter,
  node_args: '--env-file-if-exists=.env', instances: 1, exec_mode: 'fork',
  watch: false, autorestart: true, stop_exit_codes: [78], exp_backoff_restart_delay: 1000,
  min_uptime: '10s', max_restarts: 10, kill_timeout: 90000,
  time: true, out_file: path.join(__dirname, 'logs/output.log'), error_file: path.join(__dirname, 'logs/error.log'),
  env: { NODE_ENV: 'production', TZ: 'Asia/Seoul' },
}] };
