'use strict';
const config = require('./src/config/env');
const { createApp } = require('./src/app');
const { db } = require('./src/db');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`University Parking running at http://localhost:${config.port} (${config.env})`);
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) console.log('No users yet. Run `npm run db:seed` for demo data, or register a driver account in the browser.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
