import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { readBrandStorage } from '../../services/brandStorage';

const Context = createContext(null);
const RAW_BASE = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:5000';
export const getApiBaseUrl = () => RAW_BASE.replace(/\/+$/, '');
const BASE = RAW_BASE.replace(/\/+$/, '').endsWith('/api') ? RAW_BASE.replace(/\/+$/, '') : `${RAW_BASE.replace(/\/+$/, '')}/api`;

// Bounded live buffers: latest per device for readings/risks/device states,
// capped recent lists for alerts and SOS events.
const MAX_LIVE_LIST = 20;
const emptyLive = () => ({ status: 'idle', readings: {}, risks: {}, devices: {}, alerts: [], sos: [] });

export async function safetyRequest(token, path, options = {}) {
  return apiRequest(token, `/iot${path}`, options);
}

export async function apiRequest(token, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Safety API returned an invalid response. Check the configured API server.');
  }
  if (!response.ok) throw new Error(data.message || `Safety API unavailable (${response.status})`);
  return data;
}

export function SafetyProvider({ children }) {
  const [token, setToken] = useState(() => readBrandStorage('token') || '');
  const [range, setRange] = useState('24');
  const [meta, setMeta] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [live, setLive] = useState(emptyLive);
  const [latestSensorReading, setLatestSensorReading] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);
  const [sensorHistory, setSensorHistory] = useState([]);
  const [mlLatest, setMlLatest] = useState([]);
  const [sensorError, setSensorError] = useState('');
  const [sensorLoading, setSensorLoading] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const requestId = useRef(0);
  const currentController = useRef(null);
  const socketLiveRef = useRef(false);
  const refreshRef = useRef(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    currentController.current?.abort();
    const controller = new AbortController();
    currentController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);

    // 1. Fetch public sensor readings, history, and model info
    setSensorLoading(true);
    setSensorError('');
    try {
      const [latestRes, infoRes, historyRes] = await Promise.allSettled([
        fetch(`${getApiBaseUrl()}/sensor/latest`, { signal: controller.signal }).then(r => r.json()),
        fetch(`${getApiBaseUrl()}/sensor/info`, { signal: controller.signal }).then(r => r.json()),
        fetch(`${getApiBaseUrl()}/sensor/history?limit=30`, { signal: controller.signal }).then(r => r.json()),
      ]);

      if (id === requestId.current) {
        if (latestRes.status === 'fulfilled') {
          if (latestRes.value?.success) {
            const res = latestRes.value;
            setLatestSensorReading(res.reading || null);
            if (res.reading?.deviceId) {
              setLive(prev => ({
                ...prev,
                readings: {
                  ...prev.readings,
                  [res.reading.deviceId]: {
                    ...res.reading,
                    receivedAt: res.reading.receivedAt || new Date().toISOString(),
                  },
                },
                risks: (res.risk || res.ml) ? {
                  ...prev.risks,
                  [res.reading.deviceId]: {
                    ...(res.risk || {}),
                    ml: res.ml || res.risk?.ml,
                    analyzedAt: res.risk?.analyzedAt || new Date().toISOString(),
                    score: res.risk?.score ?? (res.ml?.activeEvents?.length ? 75 : 10),
                    classification: res.risk?.classification ?? (res.ml?.emergencyOverride ? 'CRITICAL' : res.ml?.activeEvents?.length ? 'HIGH' : 'NORMAL'),
                  },
                } : prev.risks,
                devices: {
                  ...prev.devices,
                  [res.reading.deviceId]: {
                    state: 'online',
                    online: true,
                    at: Date.now(),
                  },
                },
              }));
            }
          } else {
            setSensorError(latestRes.value?.message || 'Failed to fetch latest sensor readings');
          }
        } else if (latestRes.status === 'rejected') {
          setSensorError(latestRes.reason?.message || 'Failed to fetch latest sensor readings');
        }

        if (infoRes.status === 'fulfilled' && infoRes.value?.success) {
          setModelInfo(infoRes.value.info || null);
        }

        if (historyRes.status === 'fulfilled' && historyRes.value?.success) {
          setSensorHistory(historyRes.value.items || []);
        }
      }
    } catch (sErr) {
      if (id === requestId.current) {
        setSensorError(sErr.name === 'AbortError' ? 'Sensor request timed out' : sErr.message);
      }
    } finally {
      if (id === requestId.current) setSensorLoading(false);
    }

    // 2. Fetch authenticated IoT database data if token is available
    if (!token) {
      clearTimeout(timeout);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const status = await safetyRequest(token, '/status', { signal: controller.signal });
      if (id !== requestId.current) return;
      setMeta(status);
      if (status.database !== 'connected') {
        // MongoDB unavailable in local demo mode. Do not throw a blocking error that masks the sensor dashboard.
        clearTimeout(timeout);
        if (id === requestId.current) setLoading(false);
        return;
      }
      const from = new Date(Date.now() - Number(range) * 3600000).toISOString();
      const paths = {
        summary: '/summary',
        readings: `/readings?limit=100&from=${from}`,
        devices: '/devices?limit=100',
        alerts: '/alerts?limit=100',
        tasks: '/tasks?limit=100',
        history: `/history?limit=100&from=${from}`,
        analytics: `/analytics?from=${from}`,
        mlLatest: `/ml/latest?limit=30`,
      };
      const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await safetyRequest(token, path, { signal: controller.signal })]));
      if (id === requestId.current) {
        const obj = Object.fromEntries(entries);
        setData(obj);
        if (obj.mlLatest?.items) {
          setMlLatest(obj.mlLatest.items);
        }
        setUpdatedAt(new Date());
      }
    } catch (e) {
      if (id === requestId.current) setError(e.name === 'AbortError' ? 'Refresh timed out. Check API connectivity and retry.' : e.message);
    } finally {
      clearTimeout(timeout);
      if (id === requestId.current) setLoading(false);
    }
  }, [token, range]);
  refreshRef.current = refresh;

  // Polling fallback: every 10s without a live socket, every 60s as reconciliation
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
  // server and by nginx in Docker. If token is available, passes it in auth handshake.
  useEffect(() => {
    if (!token) {
      socketLiveRef.current = false;
      setSocketConnected(false);
      return;
    }
    const origin = new URL(BASE, window.location.href).origin;
    const socket = io(origin, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
    });
    let everConnected = false;

    socket.on('connect', () => {
      socketLiveRef.current = true;
      setSocketConnected(true);
      setLive(prev => ({ ...prev, status: 'live' }));
      if (everConnected) refreshRef.current();
      everConnected = true;
    });

    socket.on('disconnect', () => {
      socketLiveRef.current = false;
      setSocketConnected(false);
      setLive(prev => ({ ...prev, status: 'offline' }));
    });

    socket.on('connect_error', () => {
      socketLiveRef.current = false;
      setSocketConnected(false);
      setLive(prev => ({ ...prev, status: 'offline' }));
    });

    socket.on('system_status', () => {
      socketLiveRef.current = true;
      setSocketConnected(true);
      setLive(prev => ({ ...prev, status: 'live' }));
    });

    socket.on('sensor_update', msg => {
      if (!msg?.deviceId) return;
      const readingRecord = { ...msg, receivedAt: msg.receivedAt || new Date().toISOString() };
      setLatestSensorReading(readingRecord);
      setSensorHistory(prev => [readingRecord, ...prev.filter(r => r.messageId !== msg.messageId)].slice(0, 50));
      setLive(prev => {
        const risks = { ...prev.risks };
        if (risks[msg.deviceId]?.messageId !== msg.messageId || msg.analysisStatus === 'unavailable') delete risks[msg.deviceId];
        const readings = { ...prev.readings, [msg.deviceId]: readingRecord };
        const ids = Object.keys(readings);
        if (ids.length > 100) delete readings[ids[0]];
        return {
          ...prev,
          risks,
          readings,
          devices: {
            ...prev.devices,
            [msg.deviceId]: {
              ...(prev.devices[msg.deviceId] || {}),
              state: 'online',
              online: true,
              at: Date.now()
            }
          }
        };
      });
    });

    socket.on('risk_update', msg => {
      if (!msg?.deviceId) return;
      setLive(prev => ({ ...prev, risks: { ...prev.risks, [msg.deviceId]: msg } }));
      setMlLatest(prev => [msg, ...prev.filter(r => r.messageId !== msg.messageId)].slice(0, 30));
    });

    socket.on('new_alert', msg => {
      if (!msg) return;
      setLive(prev => ({ ...prev, alerts: [msg, ...prev.alerts.filter(a => a.id !== msg.id)].slice(0, MAX_LIVE_LIST) }));
      refreshRef.current();
    });

    socket.on('sos_event', msg => {
      if (!msg) return;
      setLive(prev => ({ ...prev, sos: [msg, ...prev.sos.filter(a => a.id !== msg.id)].slice(0, 5) }));
    });

    socket.on('device_status', msg => {
      if (!msg?.deviceId) return;
      if (msg.channel === 'camera/status') {
        setLive(prev => ({
          ...prev,
          devices: {
            ...prev.devices,
            [msg.deviceId]: {
              ...(prev.devices[msg.deviceId] || {}),
              cameraState: msg.state,
              cameraAt: Date.now(),
              at: Date.now()
            }
          }
        }));
        return;
      }
      setLive(prev => ({
        ...prev,
        devices: {
          ...prev.devices,
          [msg.deviceId]: {
            ...(prev.devices[msg.deviceId] || {}),
            state: msg.state,
            online: msg.state !== 'offline',
            at: Date.now()
          }
        }
      }));
    });

    return () => {
      socketLiveRef.current = false;
      setSocketConnected(false);
      socket.disconnect();
    };
  }, [token]);

  const connect = value => {
    requestId.current++;
    currentController.current?.abort();
    setData(null);
    setMeta(null);
    setError('');
    setUpdatedAt(null);
    setLive(emptyLive());
    setToken(value);
  };

  const disconnect = () => {
    connect('');
    setLoading(false);
  };

  const dismissSos = id => setLive(prev => ({ ...prev, sos: prev.sos.filter(a => a.id !== id) }));
  const clearLiveAlerts = () => setLive(prev => ({ ...prev, alerts: [] }));

  const mutate = async (path, method, body) => {
    await safetyRequest(token, path, { method, body });
    await refresh();
  };

  const ingestTelemetry = async (payload) => {
    const response = await fetch(`${getApiBaseUrl()}/sensor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.message || `Sensor ingestion failed (${response.status})`);
    }
    if (result.sensors && result.deviceId) {
      const readingRecord = {
        deviceId: result.deviceId,
        eventId: result.eventId,
        observedAt: result.observedAt || result.receivedAt || new Date().toISOString(),
        receivedAt: result.receivedAt || new Date().toISOString(),
        sensors: result.sensors,
        source: payload.source || 'simulation',
        ml: result.ml,
        risk: result.risk,
      };
      setLatestSensorReading(readingRecord);
      setLive(prev => ({
        ...prev,
        readings: { ...prev.readings, [result.deviceId]: readingRecord },
        risks: (result.risk || result.ml) ? {
          ...prev.risks,
          [result.deviceId]: {
            ...(result.risk || {}),
            ml: result.ml || result.risk?.ml,
            analyzedAt: result.risk?.analyzedAt || new Date().toISOString(),
            score: result.risk?.score ?? (result.ml?.activeEvents?.length ? 75 : 10),
            classification: result.risk?.classification ?? (result.ml?.emergencyOverride ? 'CRITICAL' : result.ml?.activeEvents?.length ? 'HIGH' : 'NORMAL'),
          },
        } : prev.risks,
        devices: {
          ...prev.devices,
          [result.deviceId]: { state: 'online', online: true, at: Date.now() },
        },
      }));
    }
    await refresh();
    return result;
  };

  const realtimeMode = socketConnected ? 'websocket' : 'polling';

  return (
    <Context.Provider value={{
      token, connect, disconnect, range, setRange, meta, data, error, loading,
      updatedAt, refresh, mutate, live, now, dismissSos, clearLiveAlerts,
      latestSensorReading, modelInfo, sensorHistory, mlLatest, sensorError, sensorLoading,
      realtimeMode, ingestTelemetry
    }}>
      {children}
    </Context.Provider>
  );
}

export const useSafety = () => useContext(Context);
