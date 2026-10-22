import React, { useEffect, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { motion } from 'framer-motion';
import { 
  Cpu, Radio, ShieldAlert, Wrench, Thermometer, Flame, Activity, Siren, Wifi, WifiOff,
  AlertTriangle, CheckCircle, Clock, Volume2, VolumeX, UserCheck, Plus, Camera, Search, FileText
} from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import './Safety.css';
import '../Dashboard/Dashboard.css';
import { useSafety, safetyRequest } from './SafetyContext';
import { useAuth } from '../../context/AuthContext';
import { SecurityPanel } from './SecurityPanel';
import { 
  triggerEmergencyApi, getActiveEmergenciesApi, getEmergenciesApi, getEmergencyByIdApi,
  acknowledgeEmergencyApi, respondEmergencyApi, setBuzzerApi, resolveEmergencyApi, createEmergencyMaintenanceApi,
  getMaintenanceTicketsApi, createMaintenanceTicketApi, getMaintenanceTicketByIdApi,
  assignTechnicianApi, updateTicketStatusApi, addTicketNoteApi, uploadTicketPhotoApi, verifyMaintenanceTicketApi,
  getHistoricalTrendsApi, getAnomaliesApi, getRiskRankingsApi, getPerformanceMetricsApi, getModelStatusApi, getUsersApi,
  runHistoricalAnalysisApi, getDashboardSummaryApi, getDashboardActivityApi
} from '../../services/api';
import { 
  sensorLabels, v1SensorLabels, v1SensorNotes, v1SensorValue, riskClassLabel, sourceLabel, 
  mergeReading, latestReadings, currentRisk, freshReading, when, severity, incidentStatus, 
  incidentType, deviceState, sensorValue, downloadReport 
} from './safetyData';

const inputClass = 'safety-input';
const localDate = value => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
function Empty({ children = 'No stored records match this view.' }) { return <p className="db-subtitle safety-empty">{children}</p>; }
function Badge({ children, critical = false }) { return <span className={`db-badge ${critical ? 'db-badge--fraud' : 'db-badge--review'}`}>{children}</span>; }

function useAction() {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const run = async action => { 
    setBusy(true); setMessage(''); setError(''); 
    try { 
      await action(); 
      setMessage('Saved to backend.'); 
      return true; 
    } catch (e) { 
      setError(e.message); 
      return false; 
    } finally { 
      setBusy(false); 
    } 
  };
  return { busy, run, notice: <>{message && <p role="status" style={{color:'#16a34a',fontWeight:500}}>{message}</p>}{error && <p role="alert" style={{color:'#dc2626',fontWeight:500}}>{error}</p>}</> };
}

function Connection() {
  const s = useSafety(), [input, setInput] = useState('');
  const live = s.live?.status === 'live';
  return <section className="db-chart-card safety-connection" aria-label="Backend connection">
    <div className="safety-controls"><p className="db-subtitle">Database: {s.meta?.database || 'Not connected'} - MQTT: {s.meta?.mqtt || 'Unknown'} - Live updates: {s.token ? (live ? 'connected (Socket.IO)' : s.live?.status === 'offline' ? 'reconnecting, polling fallback active' : 'connecting...') : 'not connected'} - {s.updatedAt ? `Last refresh: ${when(s.updatedAt)}` : 'No data loaded'}</p>
      <button className="db-tab" type="button" disabled={!s.token || s.loading} onClick={s.refresh}>{s.loading ? 'Refreshing...' : 'Refresh'}</button>
      {s.token && <button className="db-tab" onClick={s.disconnect}>Disconnect</button>}</div>
    <details open={!s.token || Boolean(s.error)}><summary>IoT API connection</summary><form className="safety-controls" onSubmit={e => { e.preventDefault(); s.connect(input); setInput(''); }}>
      <label>IoT access token<input className={inputClass} type="password" autoComplete="off" required minLength={32} value={input} onChange={e => setInput(e.target.value)} /></label><button className="db-tab" type="submit">Connect</button>
    </form><p className="db-subtitle">The operator token stays in memory for this session. Stored backend records refresh every 10 seconds. Device freshness uses the configured {s.meta?.offlineAfterSeconds || 120}-second window.</p></details>
    {!s.token && <p role="status">Connect to load your building data.</p>}
    {s.loading && <p role="status">Loading stored readings and events...</p>}
    {s.error && <p role="alert">{s.error}{s.data && ' Showing a stored snapshot; readings are not live.'}</p>}
  </section>;
}

function Page({ title, subtitle, children }) { 
  return (
    <div className="dashboard-container">
      <div className="db-header">
        <div>
          <h1 className="db-title">{title}</h1>
          <p className="db-subtitle">{subtitle}</p>
        </div>
      </div>
      <Connection />
      <LiveSosBanner />
      {children}
    </div>
  ); 
}

function Stat({ label, value, icon: Icon = Radio, detail }) { 
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ duration: .2 }} className="db-stat-card" style={{ borderTopColor: '#6366f1' }}>
      <div className="db-stat-top">
        <div className="db-stat-icon-wrap" style={{ background: '#eef2ff' }}>
          <Icon className="db-stat-icon" style={{ color: '#6366f1' }} />
        </div>
        <span className="db-stat-label">{label}</span>
      </div>
      <div className="db-stat-bottom">
        <span className="db-stat-value">{value ?? '-'}</span>
      </div>
      {detail && <p className="db-subtitle safety-note">{detail}</p>}
    </motion.div>
  ); 
}

function useList(resource, filters = {}) {
  const s = useSafety(), [page, setPage] = useState(1), [result, setResult] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined)).toString();
  useEffect(() => { setPage(1); setResult(null); }, [resource, query, s.token]);
  useEffect(() => {
    if (!s.token || s.meta?.database !== 'connected') { setResult(null); return; }
    const controller = new AbortController(); let active = true;
    setLoading(true); setError('');
    safetyRequest(s.token, `/${resource}?${query}&page=${page}&limit=20`, { signal: controller.signal })
      .then(data => { if (active) setResult(data); })
      .catch(e => { if (active && e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [resource, query, page, s.token, s.meta?.database, s.updatedAt]);
  return { 
    items: result?.items || [], 
    total: result?.total, 
    error, 
    loading, 
    result,
    footer: (
      <div className="safety-controls safety-pagination">
        <button className="db-tab" disabled={page <= 1 || loading} onClick={() => setPage(v => v - 1)}>Previous</button>
        <span className="db-subtitle">Page {page} - {result?.total ?? '-'} records</span>
        <button className="db-tab" disabled={!result || page * 20 >= result.total || loading} onClick={() => setPage(v => v + 1)}>Next</button>
        {loading && <span role="status">Loading...</span>}
        {error && <span role="alert">{error}</span>}
      </div>
    ) 
  };
}

function Range() { 
  const s = useSafety(); 
  return (
    <label>Time range
      <select className={inputClass} value={s.range} onChange={e => s.setRange(e.target.value)}>
        <option value="24">24 hours</option>
        <option value="168">7 days</option>
        <option value="720">30 days</option>
      </select>
    </label>
  ); 
}

function DeviceFilter({ value, onChange }) { 
  return (
    <label>Device ID
      <input className={inputClass} placeholder="All devices" value={value} onChange={e => onChange(e.target.value)} pattern="[A-Za-z0-9_:.\-]+" />
    </label>
  ); 
}

function Trend({ analytics, fields }) {
  const [selected, setSelected] = useState('');
  const options = fields || [];
  const field = options.includes(selected) ? selected : options[0];
  const values = (analytics?.trends || []).filter(row => row._id?.field === field || row.field === field).map(row => ({ 
    time: row._id?.bucket || row.time, 
    value: row.avgValue ?? row.value ?? row.avg, 
    samples: row.samples 
  }));

  return (
    <section className="db-chart-card">
      <div className="db-card-header safety-controls">
        <h2 className="db-card-title">Sensor trends</h2>
        <label>Sensor field
          <select aria-label="Trend sensor field" className={inputClass} value={field || ''} onChange={e => setSelected(e.target.value)}>
            {options.length ? options.map(key => <option key={key} value={key}>{key}</option>) : <option value="">No numeric fields</option>}
          </select>
        </label>
      </div>
      <p className="db-subtitle">Stored numeric readings, averaged per {analytics?.bucketMs === 86400000 ? 'day' : 'hour'} in original sensor units.</p>
      {values.length < 2 ? (
        <Empty>At least two time buckets with numeric readings are needed to plot a trend.</Empty>
      ) : (
        <div className="db-chart-area">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={values} margin={{ top: 20, right: 15, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="time" tickFormatter={t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })} fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip labelFormatter={when} />
              <Line type="monotone" dataKey="value" name={field} stroke="#6366f1" strokeWidth={2.5} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function SensorCards({ reading }) {
  const s = useSafety();
  const isV1 = s.meta?.payloadFormat === 'resilliox-v1';
  const stored = reading;
  const live = stored ? s.live?.readings?.[stored.deviceId] : null;
  const merged = isV1 ? mergeReading(stored, live) : stored;
  const device = merged ? { ...(s.data?.devices?.items || []).find(d => d.deviceId === merged.deviceId), ...s.live?.devices?.[merged.deviceId] } : {};
  const isFresh = merged && s.meta?.mqtt === 'subscribed' && s.live?.status !== 'offline' && !s.error && device.online !== false && freshReading(merged, s.meta.offlineAfterSeconds, s.now);
  const operators = { gt: (a,b) => a>b, gte:(a,b)=>a>=b, lt:(a,b)=>a<b, lte:(a,b)=>a<=b, eq:(a,b)=>a===b };
  const header = merged ? `Device ${merged.deviceId} - Building ${merged.buildingId || device.buildingId || 'not configured'} - Floor ${device.floorId || 'not configured'} - Zone ${merged.zoneId || device.zoneId || 'not configured'} - Received ${when(merged.receivedAt)} - ${device.online === false ? 'Device offline - ' : ''}${isFresh ? 'Fresh telemetry' : 'Stored / stale telemetry'} - ${sourceLabel(merged.source)}` : 'No sensor readings available.';

  if (isV1) {
    const kinds = Object.fromEntries((s.meta?.v1Sensors || []).map(item => [item.name, item.kind]));
    return (
      <>
        <p className="db-subtitle safety-note">{header}{live ? ' - includes live socket updates' : ''}</p>
        <div className="db-stats-grid">
          {(s.meta?.v1Sensors || []).map(({ name, kind }) => {
            const value = merged?.sensors?.[name];
            const health = merged?.health?.[name];
            const healthBad = health && health !== 'ok';
            const rules = (s.meta?.rules || []).filter(r => r.field === name);
            const triggered = rules.filter(r => value !== undefined && operators[r.operator]?.(value, r.value));
            const detailParts = [];
            if (value === undefined || value === null) detailParts.push('Awaiting a valid reading for this field');
            else if (!isFresh) detailParts.push('Stored status; not live');
            if (healthBad) detailParts.push(`Sensor health: ${health} (risk engine distrusts this value)`);
            if (triggered.length) detailParts.push(triggered.map(r => r.message).join('; '));
            else if (rules.length && !healthBad) detailParts.push('Normal for configured rules');
            if (v1SensorNotes[name]) detailParts.push(v1SensorNotes[name]);
            const Icon = name === 'temperature' || name === 'humidity' ? Thermometer : name === 'flame' ? Flame : name === 'vibration_rms' || name === 'sw420' ? Activity : name === 'sos' ? Siren : Radio;
            return <Stat key={name} label={v1SensorLabels[name] || name} value={v1SensorValue(name, value, kind || kinds[name])} icon={Icon} detail={detailParts.join(' - ') || undefined} />;
          })}
        </div>
      </>
    );
  }

  return (
    <>
      <p className="db-subtitle safety-note">{header}</p>
      <div className="db-stats-grid">
        {Object.entries(sensorLabels).map(([key, label]) => {
          const field = s.meta?.display?.[key], value = field ? stored?.sensors?.[field] : undefined;
          const rules = (s.meta?.rules || []).filter(r => r.field === field);
          const triggered = rules.filter(r => value !== undefined && operators[r.operator]?.(value, r.value));
          const detail = !field ? 'Display mapping not configured' : value === undefined ? 'Awaiting this field' : !isFresh ? 'Stored status; not live' : triggered.length ? triggered.map(r => r.message).join('; ') : rules.length ? 'Normal for configured rules' : 'No alert rule configured';
          return <Stat key={key} label={label} value={!field ? '-' : sensorValue(key, value)} icon={key === 'temperature' || key === 'humidity' ? Thermometer : Radio} detail={detail} />;
        })}
      </div>
    </>
  );
}

const riskTone = value => ({ NORMAL: '#16a34a', LOW: '#65a30d', MODERATE: '#d97706', HIGH: '#ea580c', CRITICAL: '#dc2626' }[value] || '#64748b');

function RiskPanel({ deviceId }) {
  const s = useSafety();
  if (s.meta?.payloadFormat !== 'resilliox-v1') return null;
  const liveRisk = deviceId ? s.live?.risks?.[deviceId] : null;
  const storedRisk = (s.data?.summary?.risk || []).find(r => r.deviceId === deviceId) || null;
  const reading = latestReadings(s.data?.summary?.latest, s.live?.readings).find(r => r.deviceId === deviceId);
  const risk = currentRisk(reading, liveRisk, storedRisk);
  const stale = risk?.stale || !freshReading(reading, s.meta?.offlineAfterSeconds, s.now) || s.live?.devices?.[deviceId]?.online === false;
  if (!deviceId) return <section className="db-chart-card safety-section"><h2 className="db-card-title">AI/ML risk analysis</h2><p className="db-subtitle">No device telemetry has been analyzed yet.</p></section>;
  const cls = risk?.classification || 'UNKNOWN';

  return (
    <section className="db-chart-card safety-section" aria-label="Risk analysis">
      <div className="db-card-header">
        <h2 className="db-card-title">AI/ML risk analysis - {deviceId}</h2>
        {risk && <span className="db-badge" style={{ background: riskTone(cls), color: '#fff' }}>{riskClassLabel(cls)}</span>}
      </div>
      {risk ? (
        <>
          <p className="db-subtitle">Score {risk.score}/100 - Analyzed {when(risk.analyzedAt)} - {sourceLabel(risk.source)} - {risk.modelVersion || 'Stored engine version unavailable'}{stale ? ' - Based on stale data, not current conditions' : ''}</p>
          <div className="db-stats-grid"><Stat label="Risk score" value={`${risk.score}/100`} icon={ShieldAlert} detail={riskClassLabel(cls)} /></div>
          {(risk.factors || []).length ? <Table headers={['Factor','Value','Contribution','Explanation']} rows={risk.factors.map(f => [f.factor, String(f.value ?? '-'), `${f.contribution ?? 0} pts`, f.message])} /> : <p className="db-subtitle">No risk factors in this analysis.</p>}
        </>
      ) : (
        <p className="db-subtitle">{reading?.analysisStatus === 'unavailable' ? 'Python risk analysis unavailable for the latest reading. No risk score was generated.' : 'Waiting for Python analysis of the latest reading.'}</p>
      )}
    </section>
  );
}

// ── Module 3: Live SOS Banner & Quick Trigger Modal ──
function LiveSosBanner() {
  const s = useSafety();
  const { user } = useAuth();
  const [activeEmergencies, setActiveEmergencies] = useState([]);
  const [sosModalOpen, setSosModalOpen] = useState(false);
  const [buildingId, setBuildingId] = useState('Building-1');
  const [floorId, setFloorId] = useState('Floor-1');
  const [room, setRoom] = useState('');
  const [sosMessage, setSosMessage] = useState('Immediate Assistance Needed');
  const [submittingSos, setSubmittingSos] = useState(false);
  const [actionNotice, setActionNotice] = useState('');

  const canManageEmergencies = ['security_guard', 'facility_manager', 'admin'].includes(user?.role);

  const fetchActive = async () => {
    try {
      const res = await getActiveEmergenciesApi();
      if (res.success) {
        setActiveEmergencies(res.items || []);
      }
    } catch {}
  };

  useEffect(() => {
    fetchActive();
    const interval = setInterval(fetchActive, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleTriggerSos = async (e) => {
    e.preventDefault();
    setSubmittingSos(true);
    setActionNotice('');
    try {
      const res = await triggerEmergencyApi({
        buildingId,
        floorId,
        room,
        message: sosMessage,
        severity: 'critical',
      });
      if (res.success) {
        setSosModalOpen(false);
        setActionNotice('Emergency SOS broadcasted! Responders notified.');
        fetchActive();
      }
    } catch (err) {
      alert(`Emergency trigger failed: ${err.message}`);
    } finally {
      setSubmittingSos(false);
    }
  };

  const handleAcknowledge = async (id) => {
    try {
      await acknowledgeEmergencyApi(id);
      fetchActive();
    } catch (err) { alert(err.message); }
  };

  const handleToggleBuzzer = async (id, currentState) => {
    try {
      await setBuzzerApi(id, currentState === 'active' ? 'silenced' : 'active');
      fetchActive();
    } catch (err) { alert(err.message); }
  };

  const handleResolve = async (id) => {
    const notes = prompt('Enter all-clear resolution notes:');
    if (!notes) return;
    try {
      await resolveEmergencyApi(id, notes);
      fetchActive();
    } catch (err) { alert(err.message); }
  };

  const events = activeEmergencies;

  return (
    <>
      {/* Global Quick Action Bar */}
      <div className="safety-controls safety-section" style={{ justifyContent: 'space-between', background: '#f8fafc', padding: '.75rem 1rem', borderRadius: '.75rem', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
          <span className="db-badge" style={{ background: '#6366f1', color: '#fff' }}>
            Logged in as: {(user?.role || 'student').toUpperCase().replace('_', ' ')}
          </span>
          <span className="db-subtitle">
            {user?.name ? `${user.name} (${user.email || 'operator'})` : 'Building Occupant'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button 
            type="button" 
            className="db-tab" 
            style={{ background: '#dc2626', color: '#ffffff', borderColor: '#b91c1c', fontWeight: 600 }}
            onClick={() => setSosModalOpen(true)}
          >
            <Siren size={16} style={{ display: 'inline', marginRight: '6px', verticalAlign: '-2px' }} />
            Raise Emergency SOS
          </button>
        </div>
      </div>

      {actionNotice && <p role="status" style={{ color: '#16a34a', fontWeight: 600, marginBottom: '1rem' }}>{actionNotice}</p>}

      {/* Active Emergency Banner */}
      {events.length > 0 && (
        <section className="safety-sos-banner" role="alert" aria-label="Active SOS emergencies">
          {events.map(event => (
            <div key={event._id || event.emergencyId} className="safety-sos-row" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
              <Siren size={28} aria-hidden="true" style={{ color: '#dc2626', flexShrink: 0, animation: 'pulse 1.5s infinite' }} />
              <div style={{ flex: 1, minWidth: '220px' }}>
                <strong style={{ fontSize: '15px' }}>
                  EMERGENCY SOS: {event.buildingId} {event.floorId ? `| ${event.floorId}` : ''} {event.room ? `| Room ${event.room}` : ''}
                </strong>
                <p className="db-subtitle" style={{ color: '#7f1d1d', margin: '4px 0 0' }}>
                  {event.message} - Reported by {event.reportedBy?.name || 'Occupant'} ({event.reportedBy?.role || 'student'}) at {when(event.createdAt)}
                </p>
                <div style={{ display: 'flex', gap: '.5rem', marginTop: '6px', alignItems: 'center' }}>
                  <span className="db-badge db-badge--fraud">Status: {event.status.toUpperCase()}</span>
                  <span className="db-badge" style={{ background: event.buzzerState === 'active' ? '#dc2626' : '#64748b', color: '#fff' }}>
                    Buzzer: {event.buzzerState.toUpperCase()}
                  </span>
                </div>
              </div>

              {canManageEmergencies && (
                <div className="safety-controls" style={{ marginLeft: 'auto' }}>
                  {event.status === 'active' && (
                    <button className="db-tab" onClick={() => handleAcknowledge(event._id || event.emergencyId)}>
                      Acknowledge
                    </button>
                  )}
                  <button 
                    className="db-tab"
                    title={event.buzzerState === 'active' ? 'Silence Buzzer' : 'Activate Buzzer'}
                    onClick={() => handleToggleBuzzer(event._id || event.emergencyId, event.buzzerState)}
                  >
                    {event.buzzerState === 'active' ? <VolumeX size={15} style={{ verticalAlign: '-2px' }} /> : <Volume2 size={15} style={{ verticalAlign: '-2px' }} />}
                    {event.buzzerState === 'active' ? ' Silence Alarm' : ' Sound Alarm'}
                  </button>
                  <button 
                    className="db-tab db-tab--active" 
                    onClick={() => handleResolve(event._id || event.emergencyId)}
                  >
                    Resolve All-Clear
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* SOS Modal Dialog */}
      {sosModalOpen && (
        <div className="safety-modal-overlay" onClick={() => setSosModalOpen(false)}>
          <div className="safety-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '.75rem', marginBottom: '1rem' }}>
              <Siren size={24} style={{ color: '#dc2626' }} />
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: '#0f172a' }}>Raise Emergency SOS Alert</h2>
            </div>
            <p className="db-subtitle" style={{ marginBottom: '1rem' }}>
              This broadcasts an immediate critical alert to campus security, facility operators, and actuates physical building alarm buzzers.
            </p>
            <form onSubmit={handleTriggerSos} className="safety-form" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label>Building
                <input className={inputClass} required value={buildingId} onChange={e => setBuildingId(e.target.value)} />
              </label>
              <label>Floor / Wing
                <input className={inputClass} required value={floorId} onChange={e => setFloorId(e.target.value)} />
              </label>
              <label style={{ gridColumn: 'span 2' }}>Room / Exact Location
                <input className={inputClass} required placeholder="e.g. Lab 302, Library East Wing" value={room} onChange={e => setRoom(e.target.value)} />
              </label>
              <label style={{ gridColumn: 'span 2' }}>Emergency Details / Hazard
                <textarea className={inputClass} required value={sosMessage} onChange={e => setSosMessage(e.target.value)} placeholder="Describe the emergency (fire, medical, structural, intruder)..." />
              </label>
              <div className="safety-controls" style={{ gridColumn: 'span 2', marginTop: '.5rem' }}>
                <button 
                  type="submit" 
                  disabled={submittingSos} 
                  className="db-tab"
                  style={{ background: '#dc2626', color: '#fff', borderColor: '#b91c1c', fontWeight: 600 }}
                >
                  {submittingSos ? 'Broadcasting Emergency...' : 'Confirm & Broadcast SOS'}
                </button>
                <button type="button" className="db-tab" onClick={() => setSosModalOpen(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function CameraPanel({ deviceId, alertId }) {
  const s = useSafety();
  const [cameras, setCameras] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [captureError, setCaptureError] = useState('');

  useEffect(() => {
    if (!s.token || s.meta?.database !== 'connected') { setCameras(null); return; }
    let active = true;
    setError('');
    safetyRequest(s.token, '/cameras').then(data => { if (active) setCameras(data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [s.token, s.meta?.database, s.updatedAt]);

  if (!s.token) return null;
  const items = cameras?.items || [];
  const selected = (s.data?.devices?.items || []).find(d => d.deviceId === deviceId);
  const shown = items.some(c => c.deviceId === deviceId) ? items.filter(c => c.deviceId === deviceId)
    : items.filter(c => !selected?.zoneId || !c.zoneId || c.zoneId === selected.zoneId);

  const capture = async camera => {
    setBusy(camera.deviceId); setCaptureError('');
    try {
      const created = await safetyRequest(s.token, `/cameras/${camera.deviceId}/snapshots`, { method: 'POST', body: alertId ? { alertId } : {} });
      setCameras(prev => prev ? { ...prev, snapshots: [created.item, ...(prev.snapshots || [])] } : prev);
      await s.refresh();
    } catch (e) { setCaptureError(`${camera.deviceId}: ${e.message}`); }
    finally { setBusy(''); }
  };

  const stateOf = camera => {
    const live = s.live?.devices?.[camera.deviceId];
    const state = live?.cameraState;
    if (live?.online === false || ((live?.cameraAt || Date.parse(camera.cameraStatusAt)) && s.now - (live?.cameraAt || Date.parse(camera.cameraStatusAt)) > (s.meta?.offlineAfterSeconds || 120) * 1000)) return { label: 'Offline / camera heartbeat stale', cls: 'offline' };
    if (state) return { label: state === 'online' ? 'Online (live)' : 'Offline (live)', cls: state === 'online' ? 'online' : 'offline' };
    if (camera.cameraOnline === true) return { label: `Online, status ${when(camera.cameraStatusAt)}`, cls: 'online' };
    if (camera.cameraOnline === false) return { label: `Offline since ${when(camera.cameraStatusAt)}`, cls: 'offline' };
    return { label: 'Status unknown (no camera heartbeat)', cls: 'unknown' };
  };

  const latestFor = id => (cameras?.snapshots || []).find(sn => sn.deviceId === id);

  return (
    <section className="db-chart-card safety-section" aria-label="ESP32-CAM cameras">
      <div className="db-card-header"><h2 className="db-card-title">Cameras (ESP32-CAM)</h2>{cameras && <span className="db-subtitle">{items.length} camera device{items.length === 1 ? '' : 's'}</span>}</div>
      {error && <p role="alert">{error}</p>}
      {!items.length && <p className="db-subtitle">{cameras ? 'No camera devices have reported status and no snapshot endpoints are configured (CAMERA_SNAPSHOT_URLS_JSON).' : 'Loading camera inventory...'}</p>}
      {captureError && <p role="alert">Snapshot failed: {captureError}</p>}
      <div className="safety-camera-grid">
        {shown.map(camera => {
          const state = stateOf(camera);
          const snapshot = latestFor(camera.deviceId);
          return (
            <div className="safety-camera-card" key={camera.deviceId}>
              <span className={`safety-camera-state safety-camera-state--${state.cls}`}>{state.label}</span>
              <strong>{camera.deviceId}</strong>
              <p className="db-subtitle">{sourceLabel(camera.source)} - Building {camera.buildingId || 'not configured'} - Zone {camera.zoneId || 'not configured'}</p>
              <p className="db-subtitle">{snapshot ? `Last snapshot ${when(snapshot.capturedAt)} - ${Math.round((snapshot.byteSize || 0) / 1024)} KiB` : 'No snapshots captured yet.'}</p>
              {snapshot && <SnapshotImage snapshot={snapshot} token={s.token} />}
              <button className="db-tab" disabled={!camera.snapshotConfigured || busy === camera.deviceId} onClick={() => capture(camera)}>
                {busy === camera.deviceId ? 'Capturing...' : camera.snapshotConfigured ? 'Capture snapshot' : 'No snapshot endpoint configured'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

function SnapshotImage({ snapshot, token }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let active = true, objectUrl;
    const controller = new AbortController(); setUrl(''); setError('');
    fetch(`${BASE_URL}/iot/cameras/snapshots/${snapshot._id}/image`, { 
      headers: { Authorization: `Bearer ${token}` }, 
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) 
    })
      .then(async response => { if (!response.ok) throw Error(`Snapshot unavailable (${response.status})`); return response.blob(); })
      .then(blob => { if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [snapshot._id, token]);

  return error ? <p role="alert">{error}</p> : url ? <img src={url} alt={`${sourceLabel(snapshot.source)} snapshot from ${snapshot.deviceId}`} onError={() => setError('Snapshot could not be decoded')} /> : <p role="status">Loading authorized snapshot...</p>;
}

function LiveAlerts() {
  const s = useSafety();
  const alerts = s.live?.alerts || [];
  if (!s.token || !alerts.length) return null;
  return (
    <section className="db-chart-card safety-section" aria-label="Live alerts">
      <div className="db-card-header"><h2 className="db-card-title">Live alerts</h2><button className="db-tab" onClick={s.clearLiveAlerts}>Clear</button></div>
      {alerts.map(alert => (
        <div className="db-activity-row" key={alert.id}>
          <div>
            <p className="db-activity-id">{alert.message}</p>
            <p className="db-activity-user">{alert.deviceId} - {alert.kind} - {when(alert.observedAt)}</p>
          </div>
          <Badge critical={alert.severity === 'critical'}>{alert.severity || 'warning'}</Badge>
        </div>
      ))}
    </section>
  );
}

// ── Module 6: Central Overview Dashboard ──
export function OverviewPage() {
  const s = useSafety(), summary = s.data?.summary;
  const { user } = useAuth();
  const [dashSummary, setDashSummary] = useState(null);
  const [dashboardActivity, setDashboardActivity] = useState([]);

  useEffect(() => {
    getDashboardSummaryApi().then(res => { if (res.success) setDashSummary(res); }).catch(() => {});
    getDashboardActivityApi({ limit: 10 }).then(res => { if (res.success) setDashboardActivity(res.items || []); }).catch(() => {});
  }, [s.updatedAt]);

  const fresh = summary?.latest?.some(r => Date.now() - new Date(r.receivedAt) < (s.meta?.offlineAfterSeconds || 120) * 1000);
  const safety = dashSummary?.building?.status === 'CRITICAL' ? 'Critical hazards detected'
    : dashSummary?.building?.status === 'WARNING' ? 'Warning / Review needed'
    : !summary || s.error || s.meta?.mqtt !== 'subscribed' || !fresh || !s.meta?.rules?.length ? 'Unknown'
    : summary.active ? 'Review alerts' : 'Normal / Verified Safe';
  const latestReading = latestReadings(summary?.latest, s.live?.readings)[0];
  const liveReading = latestReading ? s.live?.readings?.[latestReading.deviceId] : null;
  const heroDevice = latestReading ? mergeReading(latestReading, liveReading) : null;
  const simulated = heroReadingIsSimulated(heroDevice) || (s.data?.summary?.latest || []).some(r => r.source === 'simulation');

  return (
    <Page title="Building Safety Overview" subtitle={`Welcome back, ${user?.name || 'Operator'} — here's your central building safety, security, and maintenance status.`}>
      {simulated && <p className="safety-sim-badge" role="note">Some readings on this page are simulated test data (source=simulation), not physical hardware measurements.</p>}
      
      <div className="dashboard-hero">
        <img src="/assets/dashboard_hero.jpg" alt="ResillioX dashboard background" className="dashboard-cls-3" />
        <div className="dashboard-cls-4" />
        <div className="dashboard-hero-content">
          <h2 className="dashboard-hero-title">Smarter Building Safety Starts Here</h2>
          <p className="dashboard-hero-text">
            Monitor building conditions in real time, detect potential safety hazards, and track security incidents with ResillioX. Stay informed about sensor activity, emergency alerts, and maintenance needs from one centralized dashboard.
          </p>
          <div className="dashboard-cls-5">
            <Link to="/monitoring" className="db-hero-btn">View Telemetry</Link>
            <Link to="/maintenance" className="db-hero-btn" style={{ marginLeft: '.75rem', background: 'rgba(255,255,255,0.15)', borderColor: '#fff' }}>Maintenance Work</Link>
          </div>
        </div>
      </div>

      <h2 className="db-section-label">Central System Overview</h2>
      <div className="db-stats-grid">
        <Stat 
          label="Registered devices" 
          value={dashSummary?.building?.registeredDevices ?? summary?.devices} 
          icon={Cpu} 
          detail={dashSummary?.building?.healthSummary || `Online: ${summary?.online ?? 'Unknown'} - Offline: ${summary?.offline ?? 'Unknown'}`} 
        />
        <Stat 
          label="Active safety alerts" 
          value={dashSummary?.safety?.activeAlerts ?? summary?.active} 
          icon={ShieldAlert} 
          detail="Includes acknowledged, unresolved incidents" 
        />
        <Stat 
          label="Active SOS Emergencies" 
          value={dashSummary?.emergency?.activeCount ?? 0} 
          icon={Siren} 
          detail={`Unacknowledged: ${dashSummary?.emergency?.unacknowledgedCount ?? 0}`} 
        />
        <Stat 
          label="Maintenance Overdue" 
          value={dashSummary?.maintenance?.overdueTickets ?? summary?.due} 
          icon={Wrench} 
          detail={`Open tickets: ${dashSummary?.maintenance?.openTickets ?? '-'}`} 
        />
      </div>

      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">Building status: {safety}</h2>
        <p className="db-subtitle">Status reflects configured rules, fresh telemetry, and verified device heartbeats.</p>
      </section>

      <SensorCards reading={latestReading} />
      <RiskPanel deviceId={heroDevice?.deviceId} />
      <LiveAlerts />

      <div className="safety-controls safety-section"><Range /></div>
      <div className="db-lower-grid">
        <Trend analytics={s.data?.analytics} fields={trendFields(s)} />
        <section className="db-activity-card">
          <div className="db-card-header"><h2 className="db-card-title">Unified Multi-Module Activity Feed</h2><Link className="db-view-all" to="/incidents">View all</Link></div>
          {dashboardActivity.length > 0 ? dashboardActivity.slice(0, 6).map(act => (
            <div className="db-activity-row" key={act.id}>
              <div>
                <p className="db-activity-id">
                  <span className="db-badge" style={{ marginRight: '6px', fontSize: '10px' }}>{act.module.toUpperCase()}</span>
                  {act.title}
                </p>
                <p className="db-activity-user">{act.description} — {when(act.timestamp)}</p>
              </div>
              <Badge critical={act.severity === 'critical'}>{act.severity.toUpperCase()}</Badge>
            </div>
          )) : s.data?.alerts?.items?.length ? s.data.alerts.items.slice(0, 5).map(a => (
            <div className="db-activity-row" key={a._id}>
              <div>
                <p className="db-activity-id">{a.message}</p>
                <p className="db-activity-user">{a.deviceId} - {when(a.observedAt)}{a.source ? ` - ${sourceLabel(a.source)}` : ''}</p>
              </div>
              <Badge critical={severity(a) === 'critical'}>{incidentStatus(a)}</Badge>
            </div>
          )) : <Empty>No recorded incidents available.</Empty>}
        </section>
      </div>

      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">Latest device telemetry</h2>
        <p className="db-subtitle">Showing updates from the most recently reporting devices.</p>
        {summary?.latest?.length ? summary.latest.slice(0, 5).map(r => (
          <p key={r.deviceId} style={{ margin: '6px 0' }}>{r.deviceId} - {when(r.receivedAt)}{r.source ? ` - ${sourceLabel(r.source)}` : ''}</p>
        )) : <Empty>No telemetry has been recorded.</Empty>}
        <Link to="/monitoring" className="db-view-all" style={{ marginTop: '10px', display: 'inline-block' }}>Inspect readings and device status</Link>
      </section>
    </Page>
  );
}

function heroReadingIsSimulated(reading) { return reading?.source === 'simulation'; }

function trendFields(s) {
  if (s.meta?.payloadFormat === 'resilliox-v1') return (s.meta?.v1Sensors || []).filter(item => item.kind === 'number').map(item => item.name);
  return Object.keys(s.meta?.fields || {}).filter(k => s.meta.fields[k] === 'number');
}

function Devices() {
  const s = useSafety(), list = useList('devices'), action = useAction();
  const blank = { deviceId: '', name: '', area: '', buildingId: '', floorId: '', zoneId: '' };
  const [form, setForm] = useState(blank), [editing, setEditing] = useState(null);
  const ready = !!s.data && !s.error;

  return (
    <>
      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">{editing ? 'Edit device details' : 'Register sensor device'}</h2>
        <p className="db-subtitle">Registration records metadata. It does not connect or provision firmware.</p>
        <form className="safety-form" onSubmit={async e => {
          e.preventDefault();
          const details = Object.fromEntries(Object.entries(form).filter(([key, value]) => !['buildingId', 'floorId', 'zoneId'].includes(key) || value));
          const body = editing ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'deviceId')) : details;
          if (await action.run(() => s.mutate(editing ? `/devices/${editing}` : '/devices', editing ? 'PATCH' : 'POST', body))) {
            setForm(blank); setEditing(null);
          }
        }}>
          <label>Device ID<input className={inputClass} required maxLength={128} pattern="[A-Za-z0-9_:.\-]+" disabled={!!editing} value={form.deviceId} onChange={e => setForm({ ...form, deviceId: e.target.value })} /></label>
          <label>Device name<input className={inputClass} maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Building area<input className={inputClass} maxLength={100} value={form.area} onChange={e => setForm({ ...form, area: e.target.value })} /></label>
          {['buildingId', 'floorId', 'zoneId'].map(key => (
            <label key={key}>{({ buildingId: 'Building ID', floorId: 'Floor ID', zoneId: 'Zone ID' })[key]}
              <input className={inputClass} maxLength={128} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
            </label>
          ))}
          <div className="safety-controls">
            <button className="db-tab db-tab--active" disabled={!ready || action.busy}>{editing ? 'Save device' : 'Register device'}</button>
            {editing && <button type="button" className="db-tab" onClick={() => { setEditing(null); setForm(blank); }}>Cancel</button>}
          </div>
        </form>
        {action.notice}
      </section>

      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">Registered devices</h2>
        <Table headers={['Device', 'Area', 'Connectivity', 'Last seen', 'Last maintenance', 'Actions']} rows={list.items.map(d => [
          <span key={d._id}>{d.name || d.deviceId}<small className="safety-small">{d.deviceId}</small></span>,
          d.area || 'Not set',
          deviceState(d, s.meta),
          when(d.lastSeenAt),
          when(d.lastMaintenanceAt),
          <button className="db-tab" onClick={() => { setEditing(d._id); setForm({ deviceId: d.deviceId, name: d.name || '', area: d.area || '', buildingId: d.buildingId || '', floorId: d.floorId || '', zoneId: d.zoneId || '' }); }}>Edit</button>
        ])} />
        {list.footer}
      </section>
    </>
  );
}

function Table({ headers, rows }) { 
  return (
    <div className="safety-table-wrap">
      {rows.length ? (
        <table className="safety-table">
          <thead><tr>{headers.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      ) : <Empty />}
    </div>
  ); 
}

// ── Module 1 & 2: Monitoring Page ──
export function MonitoringPage() {
  const s = useSafety(), [params, setParams] = useSearchParams(), [device, setDevice] = useState('');
  const view = ['devices', 'security'].includes(params.get('view')) ? params.get('view') : 'readings';
  const from = new Date(Date.now() - Number(s.range) * 3600000).toISOString().slice(0, 16) + ':00.000Z';
  const readings = useList('readings', { deviceId: device, from });
  const filteredAnalytics = useRangeAnalytics(device);
  const stored = latestReadings(s.data?.summary?.latest, s.live?.readings).find(r => !device || r.deviceId === device);
  const selected = stored ? mergeReading(stored, s.live?.readings?.[stored.deviceId]) : null;
  const liveRisk = selected ? currentRisk(selected, s.live?.risks?.[selected.deviceId], (s.data?.summary?.risk || []).find(r => r.deviceId === selected.deviceId)) : null;

  return (
    <Page title="Safety Monitoring" subtitle="ESP32 connectivity, sensor readings, device registration, and recorded telemetry.">
      <div className="safety-controls safety-section">
        {['readings', 'devices', 'security'].map(t => (
          <button key={t} className={`db-tab${view === t ? ' db-tab--active' : ''}`} onClick={() => setParams(t === 'readings' ? {} : { view: t })}>
            {t === 'devices' ? 'Sensor Devices' : t === 'security' ? 'Security & Surveillance' : 'Live Sensor Readings'}
          </button>
        ))}
      </div>
      {view === 'security' ? (
        <SecurityPanel CameraPanel={CameraPanel} Table={Table} Stat={Stat} />
      ) : view === 'devices' ? (
        <Devices />
      ) : (
        <>
          <div className="safety-controls"><DeviceFilter value={device} onChange={setDevice} /><Range /></div>
          <p className="db-subtitle safety-note">MQTT: {s.meta?.mqtt || 'Unknown'}. Online/offline uses time since the last received message. Raw fields retain firmware units.</p>
          <SensorCards reading={stored} />
          {liveRisk && <p className="db-subtitle safety-note">Live risk: {riskClassLabel(liveRisk.classification)} ({liveRisk.score}/100) at {when(liveRisk.analyzedAt)}.</p>}
          <div className="safety-controls safety-section"><CameraPanel deviceId={selected?.deviceId} /></div>
          {filteredAnalytics.error && <p role="alert">{filteredAnalytics.error}</p>}
          <Trend analytics={filteredAnalytics.analytics} fields={trendFields(s)} />
          <section className="db-chart-card safety-section">
            <h2 className="db-card-title">Stored sensor history</h2>
            <Table headers={['Device', 'Observed', 'Received', 'Source', 'Sensor values']} rows={readings.items.map(r => [
              r.deviceId, when(r.observedAt), when(r.receivedAt), sourceLabel(r.source),
              Object.entries(r.sensors || {}).map(([k, v]) => `${k}: ${v}`).join(' - ')
            ])} />
            {readings.footer}
          </section>
        </>
      )}
    </Page>
  );
}

// ── Module 3: Incidents & Emergency Response Page ──
export function IncidentsPage() {
  const s = useSafety(), [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState({ status: '', severity: '', field: '', kind: '' });
  const [selected, setSelected] = useState(params.get('alertId'));
  const [resolution, setResolution] = useState('');
  const action = useAction();
  const subView = params.get('view') || 'incidents';

  // Incident list
  const incidents = useList('alerts', { ...filter, ...(params.get('alertId') ? { alertId: params.get('alertId') } : {}) });
  const events = useList('history');
  const ready = !!s.data && !s.error;
  const chosen = incidents.items.find(a => a._id === selected);

  // Dedicated Emergency incidents state
  const [emergencies, setEmergencies] = useState([]);
  const [selectedEmergency, setSelectedEmergency] = useState(null);
  const [emergencyDetails, setEmergencyDetails] = useState(null);

  const fetchEmergencies = async () => {
    try {
      const res = await getEmergenciesApi();
      if (res.success) setEmergencies(res.items || []);
    } catch {}
  };

  useEffect(() => {
    if (subView === 'emergency') {
      fetchEmergencies();
    }
  }, [subView]);

  const viewEmergency = async (emg) => {
    setSelectedEmergency(emg);
    try {
      const res = await getEmergencyByIdApi(emg.emergencyId || emg._id);
      if (res.success) setEmergencyDetails(res.item);
    } catch {
      setEmergencyDetails(emg);
    }
  };

  return (
    <Page title="Safety Hazards &amp; Emergency Incidents" subtitle="Investigate recorded hazards, dispatch emergency teams, acknowledge incidents, and document resolutions.">
      <div className="safety-controls safety-section">
        <button className={`db-tab${subView === 'incidents' ? ' db-tab--active' : ''}`} onClick={() => setParams({})}>
          Safety Hazards
        </button>
        <button className={`db-tab${subView === 'emergency' ? ' db-tab--active' : ''}`} onClick={() => setParams({ view: 'emergency' })}>
          SOS &amp; Emergencies
        </button>
        <button className={`db-tab${subView === 'history' ? ' db-tab--active' : ''}`} onClick={() => setParams({ view: 'history' })}>
          Incident &amp; Event History
        </button>
      </div>

      {subView === 'incidents' && (
        <>
          <div className="safety-controls safety-section">
            {[['status', ['active', 'acknowledged', 'resolved']], ['severity', ['info', 'warning', 'critical']], ['kind', ['safety', 'sos', 'fault']]].map(([key, values]) => (
              <label key={key}>{key[0].toUpperCase() + key.slice(1)}
                <select className={inputClass} value={filter[key]} onChange={e => setFilter({ ...filter, [key]: e.target.value })}>
                  <option value="">All</option>
                  {values.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
            <label>Incident type / sensor field
              <select className={inputClass} value={filter.field} onChange={e => setFilter({ ...filter, field: e.target.value })}>
                <option value="">All sensor fields</option>
                {[...new Set([...Object.values(s.meta?.display || {}), ...(s.data?.alerts.items || []).map(a => a.field)])].map(f => (
                  <option key={f} value={f}>{incidentType({ field: f }, s.meta)} | {f}</option>
                ))}
              </select>
            </label>
            <button className="db-tab" disabled={!incidents.result} onClick={() => downloadReport('resilliox-safety-incidents.json', { project: 'ResillioX', generatedAt: new Date().toISOString(), source: 'Stored backend incidents', coverage: 'Current filtered page', filters: filter, totalMatching: incidents.total, page: incidents.result.page, incidents: incidents.items })}>
              Export Safety Report
            </button>
          </div>

          <section className="db-chart-card">
            <Table headers={['Incident ID / type', 'Device / field', 'Severity', 'Detected', 'Status', 'Details']} rows={incidents.items.map(a => [
              <span className="safety-id" key={a._id}>{a._id}<small className="safety-small">{incidentType(a, s.meta)}</small></span>,
              `${a.deviceId} - ${a.field}`,
              <Badge critical={severity(a) === 'critical'}>{severity(a)}</Badge>,
              when(a.observedAt),
              incidentStatus(a),
              <button className="db-tab" onClick={() => { setSelected(a._id); setResolution(''); }}>Details</button>
            ])} />
            {incidents.footer}
          </section>

          {chosen && (
            <section className="db-chart-card safety-section">
              <h2 className="db-card-title">Incident details</h2>
              <p style={{ fontSize: '15px', fontWeight: 600 }}>{chosen.message}</p>
              <p className="db-subtitle">Sensor: {chosen.field} - Reading ID: {chosen.readingId} - Acknowledged: {when(chosen.acknowledgedAt)} - Resolved: {when(chosen.resolvedAt)}{chosen.source ? ` - ${sourceLabel(chosen.source)}` : ''}</p>
              {chosen.resolution && <p><strong>Resolution:</strong> {chosen.resolution}</p>}
              <IncidentMaintenance alert={chosen} ready={ready} />
              <IncidentSnapshots alertId={chosen._id} deviceId={chosen.deviceId} token={s.token} />
              <div className="safety-controls" style={{ marginTop: '1rem' }}>
                <button className="db-tab" disabled={!ready || action.busy || !!chosen.acknowledgedAt || !!chosen.resolvedAt} onClick={() => action.run(() => s.mutate(`/alerts/${chosen._id}/acknowledge`, 'PATCH', {}))}>
                  Acknowledge
                </button>
              </div>
              {!chosen.resolvedAt && (
                <form className="safety-form" onSubmit={async e => {
                  e.preventDefault();
                  await action.run(() => s.mutate(`/alerts/${chosen._id}/resolve`, 'PATCH', { resolution }));
                }}>
                  <label>Resolution notes
                    <textarea className={inputClass} required maxLength={1000} value={resolution} onChange={e => setResolution(e.target.value)} />
                  </label>
                  <button className="db-tab" disabled={!ready || action.busy}>Resolve incident</button>
                </form>
              )}
              {action.notice}
            </section>
          )}
        </>
      )}

      {subView === 'emergency' && (
        <>
          <section className="db-chart-card safety-section">
            <div className="db-card-header">
              <h2 className="db-card-title">Active &amp; Historical SOS Emergencies</h2>
              <button className="db-tab" onClick={fetchEmergencies}>Refresh Emergencies</button>
            </div>
            <Table 
              headers={['Emergency ID', 'Location', 'Message', 'Reporter', 'Status', 'Buzzer', 'Triggered', 'Actions']} 
              rows={emergencies.map(e => [
                <strong key={e.emergencyId}>{e.emergencyId}</strong>,
                `${e.buildingId} ${e.room ? `Rm ${e.room}` : ''}`,
                e.message,
                `${e.reportedBy?.name || 'Occupant'} (${e.reportedBy?.role || 'student'})`,
                <span className={`db-badge ${e.status === 'resolved' ? 'db-badge--review' : 'db-badge--fraud'}`}>{e.status.toUpperCase()}</span>,
                <span className={`db-badge ${e.buzzerState === 'active' ? 'db-badge--fraud' : ''}`}>{e.buzzerState}</span>,
                when(e.createdAt),
                <button className="db-tab" onClick={() => viewEmergency(e)}>Timeline</button>
              ])}
            />
          </section>

          {selectedEmergency && emergencyDetails && (
            <section className="db-chart-card safety-section">
              <h2 className="db-card-title">Emergency Timeline - {emergencyDetails.emergencyId}</h2>
              <p className="db-subtitle">Status: {emergencyDetails.status.toUpperCase()} | Reported: {when(emergencyDetails.createdAt)}</p>
              <div style={{ margin: '1rem 0' }}>
                <p><strong>Location:</strong> {emergencyDetails.buildingId} {emergencyDetails.floorId ? `Floor ${emergencyDetails.floorId}` : ''} {emergencyDetails.room ? `Room ${emergencyDetails.room}` : ''}</p>
                <p><strong>Hazard / Emergency:</strong> {emergencyDetails.message}</p>
                {emergencyDetails.resolutionNotes && <p><strong>Resolution:</strong> {emergencyDetails.resolutionNotes}</p>}
                {emergencyDetails.linkedTicketId && (
                  <p><strong>Linked Repair Ticket:</strong> <Link to="/maintenance">{emergencyDetails.linkedTicketId}</Link></p>
                )}
              </div>

              <h3 style={{ fontSize: '14px', fontWeight: 600, marginTop: '1rem', color: '#1e293b' }}>Audit &amp; Response Timeline:</h3>
              <div style={{ borderLeft: '2px solid #e2e8f0', paddingLeft: '1rem', margin: '1rem 0' }}>
                {(emergencyDetails.timeline || []).map((t, idx) => (
                  <div key={idx} style={{ marginBottom: '.75rem' }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: '13px', color: '#0f172a' }}>
                      {t.action.toUpperCase()} by {t.actor} ({t.role}) - <span style={{ color: '#64748b', fontWeight: 400 }}>{when(t.timestamp)}</span>
                    </p>
                    {t.notes && <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#475569' }}>{t.notes}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {subView === 'history' && (
        <>
          <section className="db-chart-card">
            <h2 className="db-card-title">Incident lifecycle</h2>
            <Table headers={['Device', 'Event', 'Detected', 'Acknowledged', 'Resolved']} rows={(s.data?.alerts.items || []).map(a => [
              a.deviceId, a.message, when(a.observedAt), when(a.acknowledgedAt), when(a.resolvedAt)
            ])} />
            <p className="db-subtitle">Most recent {s.data?.alerts.items.length || 0} of {s.data?.alerts.total ?? '-'} incidents. Use the Safety Hazards tab to filter and paginate.</p>
          </section>
          <section className="db-chart-card safety-section">
            <h2 className="db-card-title">Maintenance &amp; fault events</h2>
            <Table headers={['Device', 'Kind', 'Note', 'Occurred']} rows={events.items.map(e => [
              e.deviceId, e.kind, e.note, when(e.occurredAt)
            ])} />
            {events.footer}
          </section>
        </>
      )}
    </Page>
  );
}

function IncidentMaintenance({ alert, ready }) {
  const s = useSafety(), action = useAction();
  const [description, setDescription] = useState(''), [dueAt, setDueAt] = useState(''), [priority, setPriority] = useState('normal');
  const existing = (s.data?.tasks?.items || []).find(t => t.alertId === alert._id && t.status !== 'completed');

  return (
    <details>
      <summary>Create maintenance request from incident</summary>
      <p className="db-subtitle">Authorized operator approval is required. {sourceLabel(alert.source)} - Python risk {alert.riskClassification || 'not available'}{alert.riskScore !== undefined ? ` (${alert.riskScore}/100)` : ''}.</p>
      {existing ? (
        <p role="status">Active maintenance request already linked: <Link to="/maintenance">{existing.description}</Link></p>
      ) : (
        <form className="safety-form" onSubmit={e => {
          e.preventDefault();
          action.run(() => s.mutate(`/alerts/${alert._id}/maintenance`, 'POST', { description, priority, dueAt: new Date(dueAt).toISOString() }));
        }}>
          <label>Maintenance description<textarea className={inputClass} required maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} /></label>
          <label>Maintenance priority<select className={inputClass} value={priority} onChange={e => setPriority(e.target.value)}>{['low', 'normal', 'high', 'critical'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Maintenance due date<input className={inputClass} type="datetime-local" required value={dueAt} onChange={e => setDueAt(e.target.value)} /></label>
          <button className="db-tab" disabled={!ready || action.busy || Boolean(alert.resolvedAt)}>Approve maintenance request</button>
        </form>
      )}
      {action.notice}
    </details>
  );
}

function IncidentSnapshots({ alertId, deviceId, token }) {
  const [snapshots, setSnapshots] = useState(null), [error, setError] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const s = useSafety();

  useEffect(() => {
    let active = true;
    safetyRequest(token, `/cameras/snapshots?alertId=${alertId}`).then(d => { if (active) setSnapshots(d.items || []); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [token, alertId, s.updatedAt]);

  const open = async id => {
    try {
      const response = await fetch(`${BASE_URL}/iot/cameras/snapshots/${id}/image`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
      setSelectedImage(id);
    } catch (e) { setError(`Could not open snapshot: ${e.message}`); }
  };

  if (error) return <p className="db-subtitle">Snapshot lookup failed: {error}</p>;
  if (!snapshots) return null;

  return (
    <div>
      <CameraPanel deviceId={deviceId} alertId={alertId} />
      <p className="db-subtitle">Camera snapshots for this incident: {snapshots.length ? `${snapshots.length} stored` : 'none captured'}.</p>
      {snapshots.map(sn => (
        <p key={sn._id} className="db-subtitle">{sn.deviceId} - captured {when(sn.capturedAt)}{sn.source ? ` - ${sourceLabel(sn.source)}` : ''} - <button className="db-tab" onClick={() => open(sn._id)}>Open image</button></p>
      ))}
      {selectedImage && snapshots.find(sn => sn._id === selectedImage) && (
        <div className="safety-camera-card"><SnapshotImage snapshot={snapshots.find(sn => sn._id === selectedImage)} token={token} /></div>
      )}
    </div>
  );
}

// ── Module 4: Maintenance Management Page ──
export function MaintenancePage() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [totalTickets, setTotalTickets] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Selected ticket for details modal
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [noteInput, setNoteInput] = useState('');
  const [verifyRating, setVerifyRating] = useState(5);
  const [verifyNotes, setVerifyNotes] = useState('');
  const [technicians, setTechnicians] = useState([]);
  const [selectedTech, setSelectedTech] = useState('');

  // Report Form state
  const [formOpen, setFormOpen] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    category: 'general',
    priority: 'normal',
    buildingId: 'Building-1',
    floorId: 'Floor-1',
    room: '',
    description: '',
    dueAt: '',
    photoData: '',
    photoName: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const fetchTickets = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (categoryFilter) params.category = categoryFilter;
      if (priorityFilter) params.priority = priorityFilter;
      if (searchQuery) params.search = searchQuery;
      const res = await getMaintenanceTicketsApi(params);
      if (res.success) {
        setTickets(res.items || []);
        setTotalTickets(res.total || 0);
      }
    } catch (err) {
      setError(err.message || 'Error loading maintenance tickets');
    } finally {
      setLoading(false);
    }
  };

  const fetchTechs = async () => {
    try {
      const res = await getUsersApi({ role: 'maintenance_staff' });
      if (res.success) setTechnicians(res.items || []);
    } catch {}
  };

  useEffect(() => {
    fetchTickets();
    fetchTechs();
  }, [statusFilter, categoryFilter, priorityFilter, searchQuery]);

  const handlePhotoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Photo must be under 5MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFormData(prev => ({
        ...prev,
        photoData: reader.result,
        photoName: file.name,
      }));
    };
    reader.readAsDataURL(file);
  };

  const handleCreateTicket = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        title: formData.title,
        category: formData.category,
        priority: formData.priority,
        buildingId: formData.buildingId,
        floorId: formData.floorId,
        room: formData.room,
        location: `${formData.buildingId} ${formData.floorId ? `Fl ${formData.floorId}` : ''} ${formData.room ? `Rm ${formData.room}` : ''}`,
        description: formData.description,
        dueAt: formData.dueAt ? new Date(formData.dueAt).toISOString() : undefined,
        photos: formData.photoData ? [{
          filename: formData.photoName || 'attachment.jpg',
          contentType: 'image/jpeg',
          byteSize: Math.round(formData.photoData.length * 0.75),
          data: formData.photoData,
        }] : [],
      };
      const res = await createMaintenanceTicketApi(payload);
      if (res.success) {
        setNotice(`Maintenance ticket ${res.item.ticketId} created successfully!`);
        setFormOpen(false);
        setFormData({
          title: '', category: 'general', priority: 'normal',
          buildingId: 'Building-1', floorId: 'Floor-1', room: '', description: '', dueAt: '', photoData: '', photoName: ''
        });
        fetchTickets();
      }
    } catch (err) {
      setError(err.message || 'Failed to submit maintenance ticket');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (ticketId, nextStatus, notes = '') => {
    try {
      await updateTicketStatusApi(ticketId, nextStatus, notes);
      setNotice(`Ticket moved to ${nextStatus}`);
      fetchTickets();
      if (selectedTicket) {
        const updated = await getMaintenanceTicketByIdApi(ticketId);
        if (updated.success) setSelectedTicket(updated.item);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAssignTech = async (ticketId) => {
    if (!selectedTech) return;
    try {
      await assignTechnicianApi(ticketId, { technicianId: selectedTech });
      setNotice('Technician assigned successfully');
      fetchTickets();
      if (selectedTicket) {
        const updated = await getMaintenanceTicketByIdApi(ticketId);
        if (updated.success) setSelectedTicket(updated.item);
      }
    } catch (err) { alert(err.message); }
  };

  const handleAddNote = async (e) => {
    e.preventDefault();
    if (!noteInput.trim() || !selectedTicket) return;
    try {
      await addTicketNoteApi(selectedTicket.ticketId, noteInput);
      setNoteInput('');
      const updated = await getMaintenanceTicketByIdApi(selectedTicket.ticketId);
      if (updated.success) setSelectedTicket(updated.item);
    } catch (err) { alert(err.message); }
  };

  const handleVerifyTicket = async (ticketId) => {
    try {
      await verifyMaintenanceTicketApi(ticketId, { rating: verifyRating, notes: verifyNotes });
      setNotice('Ticket verified and closed successfully');
      fetchTickets();
      setSelectedTicket(null);
    } catch (err) { alert(err.message); }
  };

  const canManage = ['facility_manager', 'admin'].includes(user?.role);
  const canWork = ['maintenance_staff', 'facility_manager', 'admin'].includes(user?.role);

  return (
    <Page title="Building Maintenance Management" subtitle="Submit repair issues, assign certified technicians, upload photo evidence, and verify completed work.">
      <div className="safety-controls safety-section" style={{ justifyContent: 'space-between' }}>
        <button 
          className="db-tab db-tab--active" 
          onClick={() => setFormOpen(!formOpen)}
        >
          {formOpen ? 'Cancel' : '+ Report Maintenance Issue'}
        </button>
        <span className="db-subtitle">Total tickets: {totalTickets}</span>
      </div>

      {notice && <p role="status" style={{ color: '#16a34a', fontWeight: 600 }}>{notice}</p>}
      {error && <p role="alert" style={{ color: '#dc2626', fontWeight: 600 }}>{error}</p>}

      {/* Ticket Report Form */}
      {formOpen && (
        <section className="db-chart-card safety-section">
          <h2 className="db-card-title">Report Maintenance Issue</h2>
          <form className="safety-form" onSubmit={handleCreateTicket}>
            <label style={{ gridColumn: 'span 2' }}>Issue Title
              <input 
                className={inputClass} 
                required 
                maxLength={200}
                placeholder="e.g. Water leak detected in ceiling, HVAC malfunctioning"
                value={formData.title} 
                onChange={e => setFormData({ ...formData, title: e.target.value })} 
              />
            </label>

            <label>Category
              <select className={inputClass} value={formData.category} onChange={e => setFormData({ ...formData, category: e.target.value })}>
                <option value="electrical">Electrical</option>
                <option value="plumbing">Plumbing &amp; Water</option>
                <option value="hvac">HVAC &amp; Ventilation</option>
                <option value="structural">Structural</option>
                <option value="fire_safety">Fire Safety Equipment</option>
                <option value="sensor_iot">IoT Sensors &amp; Wiring</option>
                <option value="general">General Facilities</option>
              </select>
            </label>

            <label>Priority
              <select className={inputClass} value={formData.priority} onChange={e => setFormData({ ...formData, priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>

            <label>Building
              <input className={inputClass} required value={formData.buildingId} onChange={e => setFormData({ ...formData, buildingId: e.target.value })} />
            </label>

            <label>Floor
              <input className={inputClass} value={formData.floorId} onChange={e => setFormData({ ...formData, floorId: e.target.value })} />
            </label>

            <label>Room / Specific Spot
              <input className={inputClass} placeholder="e.g. Room 204, West Stairwell" value={formData.room} onChange={e => setFormData({ ...formData, room: e.target.value })} />
            </label>

            <label>Target Resolution Date
              <input type="datetime-local" className={inputClass} value={formData.dueAt} onChange={e => setFormData({ ...formData, dueAt: e.target.value })} />
            </label>

            <label style={{ gridColumn: 'span 2' }}>Detailed Description
              <textarea 
                className={inputClass} 
                required 
                maxLength={2000}
                placeholder="Provide details about the issue, observed hazards, or malfunctioning hardware..."
                value={formData.description} 
                onChange={e => setFormData({ ...formData, description: e.target.value })} 
              />
            </label>

            <label style={{ gridColumn: 'span 2' }}>Photo Attachment (Optional)
              <input type="file" accept="image/*" className={inputClass} onChange={handlePhotoUpload} />
              {formData.photoData && <p className="db-subtitle" style={{ color: '#16a34a' }}>Photo attached: {formData.photoName}</p>}
            </label>

            <div className="safety-controls" style={{ gridColumn: 'span 2' }}>
              <button className="db-tab db-tab--active" disabled={submitting}>
                {submitting ? 'Submitting Ticket...' : 'Submit Maintenance Ticket'}
              </button>
              <button type="button" className="db-tab" onClick={() => setFormOpen(false)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {/* Filter and Tickets Table */}
      <section className="db-chart-card safety-section">
        <div className="safety-controls safety-section">
          <label>Filter Status
            <select className={inputClass} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Statuses</option>
              <option value="reported">Reported</option>
              <option value="assigned">Assigned</option>
              <option value="in_progress">In Progress</option>
              <option value="repair_completed">Repair Completed</option>
              <option value="verified_closed">Verified &amp; Closed</option>
              <option value="reopened">Reopened</option>
            </select>
          </label>
          <label>Category
            <select className={inputClass} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
              <option value="">All Categories</option>
              <option value="electrical">Electrical</option>
              <option value="plumbing">Plumbing</option>
              <option value="hvac">HVAC</option>
              <option value="structural">Structural</option>
              <option value="fire_safety">Fire Safety</option>
              <option value="sensor_iot">IoT / Sensors</option>
              <option value="general">General</option>
            </select>
          </label>
          <label>Priority
            <select className={inputClass} value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
              <option value="">All Priorities</option>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label>Search
            <input className={inputClass} placeholder="Search title or ID..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </label>
          <button className="db-tab" onClick={fetchTickets} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
        </div>

        <Table 
          headers={['Ticket ID', 'Title', 'Location', 'Category', 'Priority', 'Status', 'Assignee', 'Due', 'Actions']}
          rows={tickets.map(t => [
            <strong key={t.ticketId}>{t.ticketId}</strong>,
            <span>{t.title}</span>,
            t.location || t.buildingId,
            t.category,
            <span className={`db-badge ${t.priority === 'critical' ? 'db-badge--fraud' : ''}`}>{t.priority}</span>,
            <span className={`db-badge ${t.status === 'verified_closed' ? 'db-badge--review' : t.status === 'repair_completed' ? 'db-badge--review' : ''}`}>{t.status.replace('_', ' ')}</span>,
            t.assignedTo?.name || 'Unassigned',
            when(t.dueAt),
            <button className="db-tab" onClick={() => setSelectedTicket(t)}>Inspect</button>
          ])}
        />
      </section>

      {/* Ticket Detail Modal */}
      {selectedTicket && (
        <div className="safety-modal-overlay" onClick={() => setSelectedTicket(null)}>
          <div className="safety-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '.75rem', marginBottom: '1rem' }}>
              <div>
                <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{selectedTicket.ticketId}: {selectedTicket.title}</h2>
                <p className="db-subtitle" style={{ margin: '4px 0 0' }}>Status: {selectedTicket.status.toUpperCase().replace('_', ' ')} | Category: {selectedTicket.category} | Priority: {selectedTicket.priority}</p>
              </div>
              <button className="db-tab" onClick={() => setSelectedTicket(null)}>Close</button>
            </div>

            <p><strong>Description:</strong> {selectedTicket.description}</p>
            <p><strong>Location:</strong> {selectedTicket.location || selectedTicket.buildingId}</p>
            <p><strong>Reporter:</strong> {selectedTicket.reporter?.name} ({selectedTicket.reporter?.role}) - Submitted {when(selectedTicket.createdAt)}</p>
            <p><strong>Assigned Technician:</strong> {selectedTicket.assignedTo?.name || 'None'}</p>

            {/* Photos gallery */}
            {(selectedTicket.photos || []).length > 0 && (
              <div style={{ margin: '1rem 0' }}>
                <h3 style={{ fontSize: '13px', fontWeight: 600 }}>Attached Photos:</h3>
                <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.5rem' }}>
                  {selectedTicket.photos.map((ph, idx) => (
                    <img key={idx} src={ph.data} alt={ph.filename} className="safety-photo-thumb" onClick={() => window.open(ph.data, '_blank')} />
                  ))}
                </div>
              </div>
            )}

            {/* Workflow Action Controls */}
            <div className="safety-controls" style={{ background: '#f8fafc', padding: '.75rem', borderRadius: '.5rem', margin: '1rem 0' }}>
              {canManage && (
                <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', width: '100%', marginBottom: '.5rem' }}>
                  <label style={{ flex: 1 }}>Assign Technician
                    <select className={inputClass} value={selectedTech} onChange={e => setSelectedTech(e.target.value)}>
                      <option value="">Select Technician</option>
                      {technicians.map(tc => <option key={tc.userId || tc.id} value={tc.userId || tc.id}>{tc.name} ({tc.department || 'Maintenance'})</option>)}
                    </select>
                  </label>
                  <button className="db-tab" disabled={!selectedTech} style={{ marginTop: 'auto' }} onClick={() => handleAssignTech(selectedTicket.ticketId)}>
                    Assign
                  </button>
                </div>
              )}

              {canWork && selectedTicket.status !== 'in_progress' && selectedTicket.status !== 'repair_completed' && selectedTicket.status !== 'verified_closed' && (
                <button className="db-tab" onClick={() => handleStatusChange(selectedTicket.ticketId, 'in_progress')}>
                  Start Work (In Progress)
                </button>
              )}

              {canWork && selectedTicket.status === 'in_progress' && (
                <button className="db-tab db-tab--active" onClick={() => {
                  const notes = prompt('Enter repair completion summary:');
                  if (notes) handleStatusChange(selectedTicket.ticketId, 'repair_completed', notes);
                }}>
                  Mark Repair Completed
                </button>
              )}

              {canManage && selectedTicket.status === 'repair_completed' && (
                <div style={{ width: '100%', marginTop: '.5rem' }}>
                  <label>Verification Notes
                    <input className={inputClass} placeholder="Inspection confirmed..." value={verifyNotes} onChange={e => setVerifyNotes(e.target.value)} />
                  </label>
                  <div className="safety-controls" style={{ marginTop: '.5rem' }}>
                    <button className="db-tab db-tab--active" onClick={() => handleVerifyTicket(selectedTicket.ticketId)}>
                      Verify &amp; Close Ticket
                    </button>
                    <button className="db-tab" onClick={() => handleStatusChange(selectedTicket.ticketId, 'reopened', 'Quality inspection failed')}>
                      Reopen Ticket
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Progress Notes */}
            <div style={{ marginTop: '1rem' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 600 }}>Technician Notes &amp; Updates</h3>
              <div style={{ maxHeight: '120px', overflowY: 'auto', margin: '.5rem 0' }}>
                {(selectedTicket.notes || []).map((n, i) => (
                  <p key={i} style={{ margin: '4px 0', fontSize: '13px' }}>
                    <strong>{n.author} ({n.role}):</strong> {n.text} <small style={{ color: '#64748b' }}>- {when(n.createdAt)}</small>
                  </p>
                ))}
              </div>
              <form onSubmit={handleAddNote} style={{ display: 'flex', gap: '.5rem' }}>
                <input className={inputClass} placeholder="Add technician note..." value={noteInput} onChange={e => setNoteInput(e.target.value)} />
                <button className="db-tab">Add</button>
              </form>
            </div>

            {/* Audit History Timeline */}
            <div style={{ marginTop: '1rem', borderTop: '1px solid #e2e8f0', paddingTop: '.75rem' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 600 }}>Ticket History:</h3>
              <div style={{ borderLeft: '2px solid #e2e8f0', paddingLeft: '1rem', marginTop: '.5rem' }}>
                {(selectedTicket.history || []).map((h, idx) => (
                  <p key={idx} style={{ margin: '4px 0', fontSize: '12px', color: '#475569' }}>
                    <strong>{h.action}</strong> by {h.actor} ({h.role}) - {when(h.timestamp)}: {h.notes}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

function useRangeAnalytics(device) { 
  const s = useSafety(), [analytics, setAnalytics] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    if (!s.token || !s.data) { setAnalytics(null); return; }
    let active = true;
    const controller = new AbortController();
    setError(''); setAnalytics(null);
    const from = new Date(Date.now() - Number(s.range) * 3600000).toISOString();
    safetyRequest(s.token, `/analytics?${new URLSearchParams({ from, ...(device ? { deviceId: device } : {}) })}`, { signal: controller.signal })
      .then(data => { if (active) setAnalytics(data); })
      .catch(e => { if (active && e.name !== 'AbortError') { setAnalytics(null); setError(e.message); } });
    return () => { active = false; controller.abort(); };
  }, [s.token, s.range, s.updatedAt, device]);
  return { analytics, error };
}

// ── Module 5: Historical Analytics & AI/ML Page ──
export function AnalyticsPage() {
  const s = useSafety(), [device, setDevice] = useState('');
  const { analytics, error } = useRangeAnalytics(device);

  const [historicalData, setHistoricalData] = useState([]);
  const [selectedSensor, setSelectedSensor] = useState('temperature');
  const [anomalies, setAnomalies] = useState([]);
  const [riskRankings, setRiskRankings] = useState({ devices: [], zones: [] });
  const [performance, setPerformance] = useState(null);
  const [modelStatus, setModelStatus] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);

  const handleRunScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await runHistoricalAnalysisApi({
        deviceId: device || undefined,
        field: selectedSensor,
        hoursBack: 24,
      });
      if (res.success) {
        setScanResult(res);
        getAnomaliesApi({ deviceId: device }).then(r => { if (r.success) setAnomalies(r.items || []); });
      }
    } catch (err) {
      alert(`Anomaly analysis failed: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    getHistoricalTrendsApi({ deviceId: device }).then(res => { if (res.success) setHistoricalData(res.trends || []); }).catch(() => {});
    getAnomaliesApi({ deviceId: device }).then(res => { if (res.success) setAnomalies(res.items || []); }).catch(() => {});
    getRiskRankingsApi().then(res => { if (res.success) setRiskRankings(res); }).catch(() => {});
    getPerformanceMetricsApi().then(res => { if (res.success) setPerformance(res); }).catch(() => {});
    getModelStatusApi().then(res => { if (res.success) setModelStatus(res); }).catch(() => {});
  }, [device, s.range]);

  const counts = ['info', 'warning', 'critical'].map(key => ({
    severity: key,
    count: (analytics?.incidents || []).filter(r => r._id.severity === key).reduce((a, b) => a + b.count, 0)
  }));
  const fieldCount = key => (analytics?.incidents || []).filter(r => r._id.field === s.meta?.display?.[key]).reduce((n, r) => n + r.count, 0);

  const sensorOptions = ['temperature', 'humidity', 'gas', 'smoke', 'vibration_rms'];
  const trendPoints = historicalData.filter(d => d.field === selectedSensor).map(d => ({
    time: d.time,
    value: d.avg,
    min: d.min,
    max: d.max,
  }));

  return (
    <Page title="Historical Analytics &amp; AI/ML" subtitle="Historical sensor trends, statistical anomaly detection, risk rankings, and emergency response performance.">
      <div className="safety-controls safety-section">
        <Range /><DeviceFilter value={device} onChange={setDevice} />
      </div>
      {error && <p role="alert">{error}</p>}

      {/* KPI Stats Grid */}
      <div className="db-stats-grid">
        <Stat label="Total Recorded Incidents" value={analytics ? counts.reduce((n, r) => n + r.count, 0) : null} />
        <Stat label="Emergency Ack Time (MTTA)" value={performance?.emergency?.mttaFormatted || 'N/A'} icon={Clock} />
        <Stat label="Repair Resolution (MTTR)" value={performance?.maintenance?.mttrFormatted || 'N/A'} icon={Wrench} />
        <Stat label="Ticket Completion Rate" value={performance ? `${performance.maintenance.completionRatePct}%` : 'N/A'} icon={CheckCircle} />
      </div>

      {/* Multi-Sensor Trend Chart */}
      <section className="db-chart-card safety-section">
        <div className="db-card-header safety-controls" style={{ flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
          <h2 className="db-card-title">Multi-Sensor Historical Trends</h2>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginLeft: 'auto' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.35rem', margin: 0 }}>Metric
              <select className={inputClass} value={selectedSensor} onChange={e => setSelectedSensor(e.target.value)}>
                {sensorOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
            <button className="db-tab db-tab--active" disabled={scanning} onClick={handleRunScan}>
              {scanning ? 'Scanning...' : `Scan ${selectedSensor} Anomalies`}
            </button>
          </div>
        </div>
        {scanResult && (
          <p className="db-subtitle" style={{ color: scanResult.count > 0 ? '#dc2626' : '#16a34a', margin: '.25rem 0' }}>
            {scanResult.count > 0 
              ? `Detected ${scanResult.count} anomalous outliers (Baseline Mean: ${scanResult.baseline?.mean}, Std: ${scanResult.baseline?.std})`
              : `Baseline verified: 0 statistical outliers in last 24h (Mean: ${scanResult.baseline?.mean}, Std: ${scanResult.baseline?.std})`}
          </p>
        )}
        <p className="db-subtitle">Hourly / daily rolling averages across stored telemetry.</p>
        <div className="db-chart-area" style={{ height: '260px' }}>
          {trendPoints.length >= 2 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendPoints} margin={{ top: 15, right: 15, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="time" tickFormatter={t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })} fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip labelFormatter={when} />
                <Line type="monotone" dataKey="value" name={`Avg ${selectedSensor}`} stroke="#6366f1" strokeWidth={2.5} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Awaiting sufficient historical telemetry points for {selectedSensor}.</Empty>
          )}
        </div>
      </section>

      {/* Incident Counts by Severity */}
      <div className="db-lower-grid">
        <section className="db-chart-card">
          <h2 className="db-card-title">Incident counts by severity</h2>
          {analytics?.incidents?.length ? (
            <div className="db-chart-area">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={counts}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="severity" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty>No incidents recorded for this time range.</Empty>}
        </section>

        {/* AI/ML Model Status */}
        <section className="db-chart-card">
          <h2 className="db-card-title">AI/ML Engine &amp; Model Architecture</h2>
          <div style={{ marginTop: '1rem', fontSize: '13px', lineHeight: '1.6' }}>
            <p><strong>Active Engine:</strong> {modelStatus?.activeEngine || 'Python Statistical Rules v1.0'}</p>
            <p><strong>Model Status:</strong> {modelStatus?.trainedModelLoaded ? 'Custom weights loaded (.onnx/.pt)' : 'Statistical rule-based engine active'}</p>
            <p><strong>Supported Formats:</strong> ONNX, PyTorch (.pt/.pth), Scikit-Learn (.pkl)</p>
            <p><strong>Dataset Directories:</strong> Prepared (ai_ml/datasets/raw/, ai_ml/datasets/processed/)</p>
            <p className="db-subtitle" style={{ marginTop: '.5rem' }}>{modelStatus?.note}</p>
          </div>
        </section>
      </div>

      {/* Zone & Device Risk Rankings */}
      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">Zone &amp; Device Hazard Risk Rankings</h2>
        <p className="db-subtitle">Composite hazard recurrence score based on incident frequency and critical alarms.</p>
        <Table 
          headers={['Zone / Device', 'Critical Alarms', 'Warning Alarms', 'Composite Score', 'Risk Classification']}
          rows={(riskRankings.zones || []).map(z => [
            <strong key={z.zoneId}>{z.zoneId}</strong>,
            z.criticalCount,
            z.warningCount,
            `${z.compositeScore} pts`,
            <span className={`db-badge ${z.level === 'CRITICAL' ? 'db-badge--fraud' : z.level === 'HIGH' ? 'db-badge--fraud' : 'db-badge--review'}`}>{z.level}</span>
          ])}
        />
      </section>

      {/* Detected Anomalies Table */}
      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">Detected Statistical Anomalies</h2>
        <p className="db-subtitle">Anomalies flagged by statistical deviation (Z-score &gt; 2.5) and machine learning risk factors.</p>
        <Table 
          headers={['Device', 'Detected At', 'Sensor Field', 'Severity', 'Confidence', 'Statistical Explanation']}
          rows={anomalies.map(an => [
            an.deviceId,
            when(an.timestamp),
            an.field,
            <Badge critical={an.severity === 'critical'}>{an.severity}</Badge>,
            `${Math.round(an.confidence * 100)}%`,
            an.explanation
          ])}
        />
      </section>

      {/* Door activity history */}
      <section className="db-chart-card safety-section">
        <h2 className="db-card-title">Door activity history</h2>
        <Table headers={['Device', 'Received', 'Door state']} rows={(analytics?.doorHistory || []).map(r => [
          r.deviceId, when(r.receivedAt), sensorValue('doorOpen', r.sensors[s.meta?.display?.doorOpen])
        ])} />
        <p className="db-subtitle">Most recent 50 stored door samples in the selected range.</p>
      </section>

      <section className="db-chart-card safety-section">
        <button 
          className="db-tab db-tab--active" 
          disabled={!analytics} 
          onClick={() => downloadReport('resilliox-building-safety-analytics.json', { 
            project: 'ResillioX', 
            generatedAt: new Date().toISOString(), 
            device: device || 'All', 
            analytics, 
            performance, 
            riskRankings, 
            anomalies 
          })}
        >
          Export Full Analytics Report (JSON)
        </button>
      </section>
    </Page>
  );
}

export function SafetySettingsPage() {
  const s = useSafety();
  return (
    <Page title="Monitoring Configuration" subtitle="Read-only backend configuration. Changes are managed through deployment environment variables.">
      <section className="db-chart-card">
        <h2 className="db-card-title">Sensor mappings and alert rules</h2>
        <Table headers={['Sensor', 'Payload field']} rows={Object.entries(sensorLabels).map(([k, v]) => [v, s.meta?.display?.[k] || 'Not configured'])} />
        <Table headers={['Field', 'Operator', 'Threshold / value', 'Severity', 'Message']} rows={(s.meta?.rules || []).map(r => [
          r.field, r.operator, String(r.value), r.severity || (r.kind === 'sos' ? 'critical' : 'warning'), r.message
        ])} />
        <p className="db-subtitle">Configure SENSOR_FIELDS_JSON, SENSOR_DISPLAY_JSON, ALERT_RULES_JSON and MQTT settings on the backend.</p>
      </section>
    </Page>
  );
}
