// Runs only on a fresh official Mongo image data volume during initialization.
const fs = require('fs');
const name = process.env.MONGO_APP_DATABASE || 'building_safety';
if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) throw new Error('Invalid application database name');
db.getSiblingDB(name).createUser({user:'resilliox_app',
  pwd:fs.readFileSync('/run/secrets/mongo_app_password','utf8').trim(),
  roles:[{role:'readWrite',db:name}]});
