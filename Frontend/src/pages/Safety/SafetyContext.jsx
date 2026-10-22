import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
const Context = createContext(null);
const BASE = import.meta.env.VITE_API_URL || '/api';
// Bounded live buffers: latest per device for readings/risks/device states,
// capped recent lists for alerts and SOS events.
const MAX_LIVE_LIST = 20;
const emptyLive = () => ({ status: 'idle', readings: {}, risks: {}, devices: {}, alerts: [], sos: [] });
export async function safetyRequest(token, path, options = {}) {
  return apiRequest(token,`/iot${path}`,options);
}
export async function apiRequest(token,path,options={}) {
  const response = await fetch(`${BASE}${path}`, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Safety API returned an invalid response. Check the configured API server.'); }
  if (!response.ok) throw new Error(data.message || `Safety API unavailable (${response.status})`);
  return data;
}
export function SafetyProvider({ children }) {
  const [token, setToken] = useState('');
  const [range, setRange] = useState('24');
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [live, setLive] = useState(emptyLive);
  const requestId = useRef(0);
  const currentController = useRef(null);
  const socketLiveRef = useRef(false);
  const refreshRef = useRef(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async () => {
    if (!token) return;
    const id = ++requestId.current;
    currentController.current?.abort();
    const controller = new AbortController(); currentController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setLoading(true); setError('');
    try {
      const status = await safetyRequest(token, '/status', { signal: controller.signal });
      if (id !== requestId.current) return;
      setMeta(status);
      if (status.database !== 'connected') throw new Error('Database unavailable. Stored data cannot be loaded; check the backend connection.');
      const from = new Date(Date.now() - Number(range) * 3600000).toISOString();
      const paths = { summary: '/summary', readings: `/readings?limit=100&from=${from}`,
        devices: '/devices?limit=100', alerts: '/alerts?limit=100', tasks: '/tasks?limit=100',
        history: `/history?limit=100&from=${from}`, analytics: `/analytics?from=${from}` };
      const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await safetyRequest(token, path, { signal: controller.signal })]));
      if (id === requestId.current) { setData(Object.fromEntries(entries)); setUpdatedAt(new Date()); }
    } catch (e) {
      if (id === requestId.current) setError(e.name === 'AbortError' ? 'Refresh timed out. Check API connectivity and retry.' : e.message);
    } finally { clearTimeout(timeout); if (id === requestId.current) setLoading(false); }
  }, [token, range]);
  refreshRef.current = refresh;
  // Polling fallback: every 10s without a live socket, every 60s as a
  // reconciliation pass while live updates are flowing.
  useEffect(() => {
    refresh();
    let timer;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (!document.hidden) await refresh();
        schedule();
      }, socketLiveRef.current ? 60000 : 10000);
    };
    schedule();
    return () => { clearTimeout(timer); currentController.current?.abort(); requestId.current++; };
  }, [refresh]);
  // Socket.IO live layer. Same-origin /socket.io is proxied by the Vite dev
  // server and by nginx in Docker, so no extra host configuration is needed.
  // The operator token is sent in the handshake auth payload, never stored.
  useEffect(() => {
    if (!token) { socketLiveRef.current = false; setLive(emptyLive()); return; }
    const origin = new URL(BASE, window.location.href).origin;
    const socket = io(origin, { path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'] });
    let everConnected = false;
    socket.on('connect', () => {
      socketLiveRef.current = true;
      setLive({ ...emptyLive(), status: 'live' });
      // Refetch authoritative state after every (re)connection so nothing
      // published while disconnected is missed.
      if (everConnected) refreshRef.current();
      everConnected = true;
    });
    socket.on('disconnect', () => {
      socketLiveRef.current = false;
      setLive(prev => ({ ...prev, status: 'offline' }));
    });
    socket.on('connect_error', () => {
      socketLiveRef.current = false;
      setLive(prev => ({ ...prev, status: 'offline' }));
    });
    socket.on('system_status', () => setLive(prev => ({ ...prev, status: 'live' })));
    socket.on('sensor_update', msg => {
      if (!msg?.deviceId) return;
      setLive(prev => {
        const risks = { ...prev.risks };
        if (risks[msg.deviceId]?.messageId !== msg.messageId || msg.analysisStatus === 'unavailable') delete risks[msg.deviceId];
        const readings = { ...prev.readings, [msg.deviceId]: { ...msg, receivedAt: msg.receivedAt || new Date().toISOString() } };
        const ids = Object.keys(readings);
        if (ids.length > 100) delete readings[ids[0]];
        return { ...prev, risks, readings,
          devices: { ...prev.devices, [msg.deviceId]: { ...(prev.devices[msg.deviceId] || {}), state: 'online', online: true, at: Date.now() } } };
      });
    });
    socket.on('risk_update', msg => {
      if (!msg?.deviceId) return;
      setLive(prev => ({ ...prev, risks: { ...prev.risks, [msg.deviceId]: msg } }));
    });
    socket.on('new_alert', msg => {
      if (!msg) return;
      setLive(prev => ({ ...prev, alerts: [msg, ...prev.alerts.filter(a => a.id !== msg.id)].slice(0, MAX_LIVE_LIST) }));
      // Persisted incident: refresh lists so filters/pages stay authoritative.
      refreshRef.current();
    });
    socket.on('sos_event', msg => {
      if (!msg) return;
      setLive(prev => ({ ...prev, sos: [msg, ...prev.sos.filter(a => a.id !== msg.id)].slice(0, 5) }));
    });
    socket.on('device_status', msg => {
      if (!msg?.deviceId) return;
      if (msg.channel === 'camera/status') {
        setLive(prev => ({ ...prev,
          devices: { ...prev.devices, [msg.deviceId]: { ...(prev.devices[msg.deviceId] || {}), cameraState: msg.state, cameraAt: Date.now(), at: Date.now() } } }));
        return;
      }
      setLive(prev => ({ ...prev,
        devices: { ...prev.devices, [msg.deviceId]: { ...(prev.devices[msg.deviceId] || {}), state: msg.state, online: msg.state !== 'offline', at: Date.now() } } }));
    });
    return () => { socketLiveRef.current = false; socket.disconnect(); };
  }, [token]);
  const connect = value => { requestId.current++; currentController.current?.abort(); setData(null); setMeta(null); setError(''); setUpdatedAt(null); setLive(emptyLive()); setToken(value); };
  const disconnect = () => { connect(''); setLoading(false); };
  const dismissSos = id => setLive(prev => ({ ...prev, sos: prev.sos.filter(a => a.id !== id) }));
  const clearLiveAlerts = () => setLive(prev => ({ ...prev, alerts: [] }));
  const mutate = async (path, method, body) => {
    await safetyRequest(token, path, { method, body });
    await refresh();
  };
  return <Context.Provider value={{ token, connect, disconnect, range, setRange, meta, data, error, loading, updatedAt, refresh, mutate, live, now, dismissSos, clearLiveAlerts }}>{children}</Context.Provider>;
}
export const useSafety = () => useContext(Context);
