import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { settings } from '../src/config/settings.js';
import { connectDatabase,mongoose } from '../src/config/database.js';

test('local database TLS is explicit and Atlas TLS cannot be disabled',()=>{
  assert.equal(settings({}).databaseTls,true);
  assert.equal(settings({MONGODB_TLS:'false'}).databaseTls,false);
  assert.throws(()=>settings({MONGODB_TLS:'false',MONGODB_URI:'mongodb+srv://example.invalid/'}));
});
test('Mongo bootstrap handles command error documents, auth failure and idempotent restarts',async()=>{
  const script=await readFile(new URL('../../deployment/mongo/init-replica.js',import.meta.url),'utf8');
  for(const scenario of ['fresh','existing','unauthorized','other-error']){
    const calls=[];let exit;
    const admin={auth:()=>scenario!=='unauthorized',runCommand:command=>{
      calls.push(Object.keys(command)[0]);
      if(command.replSetGetStatus)return scenario==='fresh'?{ok:0,code:94}:{ok:scenario==='other-error'?0:1,code:76};
      return {ok:1,isWritablePrimary:true};
    }};
    try {runInNewContext(script,{require:()=>({readFileSync:()=> 'test-only-secret'}),
      Mongo:class {getDB(){return admin;}},quit:code=>{exit=code;throw Error('quit');}});}catch(error){assert.equal(error.message,'quit');}
    assert.equal(exit,['unauthorized','other-error'].includes(scenario)?1:0);
    assert.equal(calls.includes('replSetInitiate'),scenario==='fresh');
  }
});
test('production database connector accepts explicit local replica-set transport',{
  skip:!process.env.DASHBOARD_TEST_URI,
},async()=>{
  const name=`rbrick_transport_test_${randomUUID().replaceAll('-','')}`;
  const config=settings({MONGODB_URI:process.env.DASHBOARD_TEST_URI,DB_NAME:name,MONGODB_TLS:'false'});
  try {
    assert.equal(await connectDatabase(config),true);
    await mongoose.connection.collection('verification').insertOne({source:'simulation'});
    assert.equal((await mongoose.connection.collection('verification').findOne()).source,'simulation');
  }finally{
    if(mongoose.connection.readyState===1){assert.equal(mongoose.connection.name,name);await mongoose.connection.dropDatabase();await mongoose.disconnect();}
  }
});
