const path = require("node:path");

const projectRoot = path.resolve(__dirname, "../..");

module.exports = {
  apps: [
    {
      name: "mail-intake",
      script: "artifacts/full-stack/server/index.js",
      cwd: projectRoot,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
  ],
};
