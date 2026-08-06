module.exports = {
  apps: [{
    name: "whatsapp-bot",
    script: "./index.js",
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: "production"
    }
  }]
};
