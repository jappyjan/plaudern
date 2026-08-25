const { randomBytes } = require('node:crypto');

process.env.APP_ENCRYPTION_SECRET = randomBytes(32).toString('base64');
