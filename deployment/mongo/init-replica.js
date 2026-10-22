// Invoked inside the Mongo container by its healthcheck. Credentials stay in
// files, not command arguments. Idempotent initialization handles ordinary restarts.
const fs = require('fs');
const connection = new Mongo('mongodb://127.0.0.1:27017/?directConnection=true');
const admin = connection.getDB('admin');
const authenticated = admin.auth({user:fs.readFileSync('/run/secrets/mongo_root_username','utf8').trim(),
  pwd:fs.readFileSync('/run/secrets/mongo_root_password','utf8').trim()});
if (!authenticated) quit(1);
const status=admin.runCommand({replSetGetStatus:1});
if(status.ok!==1) {
  if(status.code!==94 && status.codeName!=='NotYetInitialized') quit(1);
  const initialized=admin.runCommand({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}});
  if(initialized.ok!==1 && initialized.codeName!=='AlreadyInitialized')quit(1);
}
const hello = admin.runCommand({hello:1});
quit(hello.isWritablePrimary ? 0 : 1);
