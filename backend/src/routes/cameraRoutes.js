// ESP32-CAM integration routes (Phase 8).
//
//   GET  /api/iot/cameras                         camera devices + configured snapshot endpoints
//   GET  /api/iot/cameras/snapshots               stored snapshot metadata (filter: deviceId, alertId)
//   GET  /api/iot/cameras/snapshots/:id/image     stored snapshot bytes
//   POST /api/iot/cameras/:deviceId/snapshots     capture now from the configured camera URL
//
// Security model:
//   - Every route requires the same operator bearer token and a live database.
//   - Snapshot URLs come ONLY from CAMERA_SNAPSHOT_URLS_JSON in server config.
//     A request can name a device, never a URL, so this proxy cannot be used
//     to reach arbitrary targets (no client-controlled SSRF).
//   - JPEG (or any image/*) bytes are capped at MAX_CAMERA_SNAPSHOT_BYTES and
//     fetched with a hard timeout. Snapshots never travel over MQTT.
//   - No unsecured camera endpoint is exposed to browsers; the browser talks
//     only to this authenticated API.

import { Router } from 'express';
import { z } from 'zod';
import { CameraSnapshot, Alert, Device, MAX_CAMERA_SNAPSHOT_BYTES } from '../models/index.js';
import { SensorReading } from '../models/index.js';
import { mongoose } from '../config/database.js';
import { readFile } from 'node:fs/promises';
import { DEMO_SCOPE,simulationState,storeSecuritySnapshot,SecurityError } from '../services/securityService.js';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.\\-]+$/);
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const SNAPSHOT_TIMEOUT_MS = 5000;

export function cameraRoutes(config, status) {
  const router = Router();

  // Camera inventory: devices that reported camera/status heartbeats plus
  // devices with a configured snapshot endpoint. "Unknown" state is honest —
  // we never claim a camera is online without a heartbeat.
  router.get('/', async (req, res) => {
    const [devices, recent] = await Promise.all([
      Device.find({ $or: [{ cameraOnline: mongoose.trusted({ $exists: true }) }, { cameraStatusAt: mongoose.trusted({ $exists: true }) }] })
        .sort({ cameraStatusAt: -1, _id: -1 }).limit(100).lean(),
      CameraSnapshot.find({}).sort({ capturedAt: -1 }).limit(100)
        .select({ image: 0 }).lean(),
    ]);
    const configured = Object.keys(config.cameraSnapshotUrls);
    const seen = new Map(devices.map(d => [d.deviceId, d]));
    const cameraState = device => device.online === false || (device.cameraStatusAt && Date.now()-new Date(device.cameraStatusAt).getTime()>config.offlineAfterSeconds*1000)
      ? false : device.cameraOnline ?? null;
    const items = configured.map(deviceId => {
      const device = seen.get(deviceId) || {};
      return {
        deviceId,
        registered: Boolean(device._id),
        cameraOnline: cameraState(device),
        buildingId: device.buildingId, floorId: device.floorId, zoneId: device.zoneId,
        source: config.cameraSources?.[deviceId] || device.cameraSource,
        cameraStatusAt: device.cameraStatusAt ?? null,
        lastSeenAt: device.lastSeenAt ?? null,
        snapshotConfigured: true,
      };
    });
    for (const device of devices) {
      if (Object.hasOwn(config.cameraSnapshotUrls, device.deviceId)) continue;
      items.push({
        deviceId: device.deviceId, registered: Boolean(device._id),
        cameraOnline: cameraState(device), cameraStatusAt: device.cameraStatusAt ?? null,
        buildingId: device.buildingId, floorId: device.floorId, zoneId: device.zoneId,
        source: config.cameraSources?.[device.deviceId] || device.cameraSource,
        lastSeenAt: device.lastSeenAt ?? null, snapshotConfigured: device.securityDemoScope===DEMO_SCOPE&&config.securitySimulationEnabled,
      });
    }
    res.json({ success: true, items, snapshots: recent, maxSnapshotBytes: MAX_CAMERA_SNAPSHOT_BYTES,
      note: 'Snapshots are fetched server-side from configured camera URLs; no camera endpoint is exposed to the browser.' });
  });

  // Snapshot metadata list (image bytes excluded).
  router.get('/snapshots', async (req, res) => {
    const q = z.object({ deviceId: id.optional(), alertId: objectId.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(req.query);
    const filter = {};
    if (q.deviceId) filter.deviceId = q.deviceId;
    if (q.alertId) filter.alertIds = q.alertId;
    const [items, total] = await Promise.all([
      CameraSnapshot.find(filter).sort({ capturedAt: -1, _id: -1 }).limit(q.limit)
        .select({ image: 0 }).lean(),
      CameraSnapshot.countDocuments(filter),
    ]);
    res.json({ success: true, items, total, limit: q.limit });
  });

  // Snapshot bytes for <img src> style retrieval (still token-authenticated).
  router.get('/snapshots/:id/image', async (req, res) => {
    const _id = objectId.parse(req.params.id);
    // Hydrate the Buffer field; lean() leaves a BSON Binary that Buffer.from
    // does not decode into the stored bytes.
    const snapshot = await CameraSnapshot.findById(_id).select({ image: 1, contentType: 1, capturedAt: 1 });
    if (!snapshot?.image) return res.status(404).json({ success: false, message: 'Snapshot not found' });
    res.set('Content-Type', snapshot.contentType);
    res.set('Cache-Control', 'private, max-age=300');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:");
    res.send(Buffer.from(snapshot.image));
  });

  // Capture a snapshot now. Body may reference the incident it documents.
  router.post('/:deviceId/snapshots', async (req, res) => {
    const deviceId = id.parse(req.params.deviceId);
    const input = z.object({ alertId: objectId.optional() }).strict().parse(req.body ?? {});
    const url = config.cameraSnapshotUrls[deviceId];
    const device = await Device.findOne({deviceId}).lean();
    const simulated=device?.securityDemoScope===DEMO_SCOPE;
    if(simulated&&(!config.securitySimulationEnabled||!(await simulationState()).running))throw new SecurityError(409,'Start security simulation to request a sample snapshot');
    if(simulated&&device.cameraOnline!==true)throw new SecurityError(409,'Demo camera is offline');
    if (!url&&!simulated) {
      return res.status(404).json({ success: false,
        message: 'No snapshot endpoint is configured for this device (CAMERA_SNAPSHOT_URLS_JSON).' });
    }
    const alert = input.alertId ? await Alert.findById(input.alertId).lean() : null;
    if (input.alertId && !alert) {
      return res.status(404).json({ success: false, message: 'Referenced incident not found' });
    }
    const reading = alert ? await SensorReading.findById(alert.readingId).lean() : null;
    if (alert && ((device?.zoneId && alert.zoneId && device.zoneId !== alert.zoneId) ||
        (device?.buildingId && reading?.buildingId && device.buildingId !== reading.buildingId))) {
      return res.status(409).json({success:false,message:'Camera and incident locations do not match'});
    }
    let upstream;
    if(simulated){
      const image=await readFile(new URL('../assets/security-demo.png',import.meta.url));
      upstream=new Response(image,{headers:{'Content-Type':'image/png'}});
    }else{
    try {
      upstream = await fetch(url, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS), redirect: 'error',
        headers: config.cameraTokens?.[deviceId] ? {Authorization:`Bearer ${config.cameraTokens[deviceId]}`} : {} });
    } catch {
      return res.status(502).json({ success: false, message: 'Camera did not respond within the timeout' });
    }
    }
    if (!upstream.ok) { await upstream.body?.cancel(); return res.status(502).json({ success: false, message: `Camera responded ${upstream.status}` }); }
    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim();
    if (!['image/jpeg','image/png','image/webp'].includes(contentType)) {
      await upstream.body?.cancel();
      return res.status(502).json({ success: false, message: 'Camera response is not an image' });
    }
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_CAMERA_SNAPSHOT_BYTES) {
      await upstream.body?.cancel();
      return res.status(502).json({ success: false, message: 'Snapshot exceeds the size limit' });
    }
    let bytes;
    try {
      const chunks=[];let size=0;
      for await(const chunk of upstream.body) {
        size+=chunk.length;
        if(size>MAX_CAMERA_SNAPSHOT_BYTES)throw new Error('limit');
        chunks.push(Buffer.from(chunk));
      }
      bytes=Buffer.concat(chunks);
    } catch { return res.status(502).json({success:false,message:'Snapshot read failed or exceeded the size limit'}); }
    if (!bytes.length) return res.status(502).json({ success: false, message: 'Camera returned an empty image' });
    if (bytes.length > MAX_CAMERA_SNAPSHOT_BYTES) {
      return res.status(502).json({ success: false, message: 'Snapshot exceeds the size limit' });
    }
    const signature = contentType==='image/jpeg' ? bytes[0]===255 && bytes[1]===216 && bytes[2]===255
      : contentType==='image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP';
    if(!signature)return res.status(502).json({success:false,message:'Snapshot image signature is invalid'});
    const snapshotData = {
      deviceId, contentType, byteSize: bytes.length, capturedAt: new Date(),
      // Without a hardware contract we cannot prove a camera is physical; the
      // source of the *device's own* telemetry decides the label.
      source: simulated?'simulation':config.cameraSources?.[deviceId] || device?.cameraSource,
      demoScope:simulated?DEMO_SCOPE:undefined,
      buildingId:device?.buildingId || reading?.buildingId,floorId:device?.floorId,
      zoneId:device?.zoneId || alert?.zoneId,
      alertIds: input.alertId ? [input.alertId] : [],
      image: bytes,
    };
    const snapshot=device?.securityType==='camera'?await storeSecuritySnapshot(snapshotData,device):await CameraSnapshot.create(snapshotData);
    res.status(201).json({ success: true, item: {
      _id: snapshot._id, deviceId, contentType, byteSize: snapshot.byteSize,
      capturedAt: snapshot.capturedAt, source: snapshot.source, alertIds: snapshot.alertIds,
      buildingId:snapshot.buildingId,floorId:snapshot.floorId,zoneId:snapshot.zoneId,
    } });
  });

  return router;
}
