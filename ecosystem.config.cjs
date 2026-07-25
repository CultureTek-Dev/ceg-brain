// pm2 process config.  Start:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "ceg-brain",
      script: "dist/server.js",
      instances: 1, // single instance: one subscription, one token manager
      exec_mode: "fork",
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      time: true,
    },
  ],
};
