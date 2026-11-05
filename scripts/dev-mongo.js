// Local dev MongoDB (no Docker needed). Data persists in .localdata/mongo. Usage: node scripts/dev-mongo.js
const { MongoMemoryServer } = require('mongodb-memory-server');
const path = require('path');
const fs = require('fs');
const dbPath = path.join(__dirname, '..', '.localdata', 'mongo');
fs.mkdirSync(dbPath, { recursive: true });
MongoMemoryServer.create({ instance: { port: 27017, dbPath, storageEngine: 'wiredTiger' } })
  .then((m) => { console.log('Local MongoDB running at', m.getUri(), '(data in', dbPath + ')'); })
  .catch((e) => { console.error(e); process.exit(1); });
