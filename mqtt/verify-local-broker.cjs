// Isolated native Windows broker/CLI regression check. Run from repository root.
// Requires Initialize-MqttAuth.ps1; never logs or passes passwords in argv.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = 18886;
const directory = path.resolve('.docker-validation/mqtt-phase2');
const bin = process.env.MOSQUITTO_DIRECTORY || 'C:/Program Files/mosquitto';
const children = [];
const slash = name => name.replaceAll('\\', '/');

function portOpen() {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
function start(executable, args) {
  const child = spawn(path.join(bin, executable + '.exe'), args, { windowsHide: true });
  children.push(child);
  return child;
}
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = start(executable, args);
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timeout')); }, 12000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

async function verify() {
  if (await portOpen()) throw new Error('Test port 18886 already in use; refusing to touch that broker.');
  fs.mkdirSync(directory, { recursive: true });
  const credentials = Object.fromEntries(fs.readFileSync('mqtt/.secrets/device-credentials.txt', 'utf8')
    .trim().split(/\r?\n/).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  for (const user of ['backend', 'esp32_main_01']) {
    assert(credentials[user], 'Required local test account missing');
    fs.writeFileSync(path.join(directory, user + '.opts'), `-u ${user}\n-P ${credentials[user]}\n`);
  }
  fs.writeFileSync(path.join(directory, 'invalid.opts'), '-u esp32_main_01\n-P intentionally-invalid-test-password\n');
  const config = path.join(directory, 'mosquitto.conf');
  fs.writeFileSync(config, `listener ${port} 127.0.0.1\nallow_anonymous false\npassword_file ${slash(path.resolve('mqtt/.secrets/password_file'))}\nacl_file ${slash(path.resolve('mqtt/acl.example'))}\npersistence true\npersistence_location ${slash(directory)}/\nlog_dest stdout\nlog_type all\n`);
  const broker = start('mosquitto', ['-c', config]);
  let brokerError;
  broker.once('error', error => { brokerError = error; });
  broker.stdout.resume(); broker.stderr.resume();
  for (let attempt = 0; ; ++attempt) {
    if (brokerError) throw brokerError;
    if (broker.exitCode !== null || attempt >= 50) throw new Error('Test broker failed to start');
    if (await portOpen()) break;
    await pause(100);
  }
  const options = user => ['-o', path.join(directory, user + '.opts'), '-h', '127.0.0.1', '-p', String(port)];
  const topic = 'building/zone01/esp32_main_01/telemetry';
  const subscribe = run('mosquitto_sub', [...options('backend'), '-t', topic, '-q', '1', '-C', '1', '-W', '5']);
  await pause(500);
  const published = await run('mosquitto_pub', [...options('esp32_main_01'), '-t', topic, '-m', '{"source":"simulation","phase":2}', '-q', '1']);
  assert.equal(published.code, 0, published.output);
  const received = await subscribe;
  assert.equal(received.code, 0, received.output);
  assert.equal(JSON.parse(received.output).source, 'simulation');
  console.log('PASS authenticated Mosquitto CLI QoS 1 publish/subscribe');
  const invalid = await run('mosquitto_pub', [...options('invalid'), '-t', topic, '-m', 'test']);
  assert.notEqual(invalid.code, 0);
  const anonymous = await run('mosquitto_pub', ['-h', '127.0.0.1', '-p', String(port), '-t', topic, '-m', 'test']);
  assert.notEqual(anonymous.code, 0);
  console.log('PASS invalid and anonymous credentials rejected');
  for (const deniedTopic of ['building/zone01/other-device/telemetry', 'building/building01/esp32_main_01/other-device/telemetry']) {
    const denied = await run('mosquitto_pub', [...options('esp32_main_01'), '-V', 'mqttv5', '-t', deniedTopic, '-m', 'test', '-q', '1']);
    assert.match(denied.output, /Not authorized/i);
  }
  console.log('PASS cross-device ACL denial at both topic depths');
  const availability = 'building/zone01/esp32_main_01/availability';
  const cleared = await run('mosquitto_pub', [...options('esp32_main_01'), '-t', availability, '-n', '-r', '-q', '1']);
  assert.equal(cleared.code, 0, cleared.output);
  const willSubscription = run('mosquitto_sub', [...options('backend'), '-t', availability, '-C', '1', '-W', '8']);
  await pause(500);
  const device = start('mosquitto_pub', [...options('esp32_main_01'), '-i', 'phase2-will-device', '-t', topic, '-l', '-q', '1',
    '--will-topic', availability, '--will-payload', 'offline', '--will-qos', '1', '--will-retain']);
  device.once('error', error => { brokerError = error; });
  device.stdout.resume(); device.stderr.resume();
  await pause(500);
  if (brokerError) throw brokerError;
  assert.equal(device.exitCode, null, 'Last Will test client exited early');
  device.kill('SIGKILL');
  const will = await willSubscription;
  assert.equal(will.code, 0, will.output);
  assert.equal(will.output.trim(), 'offline');
  const retained = await run('mosquitto_sub', [...options('backend'), '-t', availability, '-C', '1', '-W', '3']);
  assert.equal(retained.code, 0, retained.output);
  assert.equal(retained.output.trim(), 'offline');
  console.log('PASS unclean disconnect and retained offline Last Will');
}

verify().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
