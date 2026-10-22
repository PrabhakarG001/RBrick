// Socket.IO realtime layer.
//
// Broadcasts live sensor/risk/alert/device-status updates to dashboard
// clients. Auth: clients must present the same operator bearer token in the
// Socket.IO handshake auth payload ({ auth: { token } }). CORS is restricted
// to configured origins (same-origin by default; SOCKET_CORS_ORIGIN for dev).

import { Server } from 'socket.io';
import { timingSafeEqual } from 'node:crypto';

const EVENTS = ['sensor_update', 'risk_update', 'new_alert', 'device_status', 'sos_event'];

export function attachRealtime(httpServer, config, status) {
  const allowedOrigins = (config.socketCorsOrigin || '').split(',').map(s => s.trim()).filter(Boolean);
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: allowedOrigins.length
      ? { origin: allowedOrigins, methods: ['GET', 'POST'] }
      : { origin: false }, // same-origin only
    serveClient: false,
    maxHttpBufferSize: 1e4,
  });

  // Fail-closed auth: same operator token as the REST API.
  io.use((socket, next) => {
    const supplied = String(socket.handshake.auth?.token ?? '');
    if (config.apiToken.length < 32) return next(new Error('Authentication not configured'));
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(config.apiToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return next(new Error('Invalid token'));
    }
    next();
  });

  io.on('connection', socket => {
    status.socketClients = (status.socketClients ?? 0) + 1;
    socket.on('disconnect', () => { status.socketClients -= 1; });
    // Snapshot so a newly connected client renders immediately.
    socket.emit('system_status', {
      database: status.database ? 'connected' : 'unavailable',
      mqtt: config.mqttEnabled ? (status.mqtt ? 'subscribed' : 'unavailable') : 'disabled',
      persisted: status.persisted ?? 0, rejected: status.rejected ?? 0,
    });
  });

  function broadcast(event, payload) {
    if (!EVENTS.includes(event)) return;
    io.emit(event, payload);
  }

  return { io, broadcast };
}
