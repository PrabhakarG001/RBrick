// Historical JavaScript rules reference (not used by production v1 ingestion).
// Phase 6 inference is Python-only via aiServiceClient.js. No JS fallback.
//
// Deterministic, rule-based risk analysis over normalized sensor readings.
// This module is intentionally independent of MQTT, Express and Mongoose so
// it can be unit-tested in isolation and (later) swapped for a trained model
// behind the same analyzeReading() interface.
//
// No trained ML model exists in this repository. This is a transparent rules
// engine whose thresholds are configuration, not learned parameters.

export const RISK_CLASSES = ['NORMAL', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'];

// Documented DEMO defaults. Every threshold must be re-validated against the
// actual sensors of a real installation before production use; override via
// RISK_THRESHOLDS_JSON in .env. See mqtt/README.md and IoT/README.md.
export const DEFAULT_THRESHOLDS = Object.freeze({
  temperature: { warning: 40, high: 55, critical: 70 }, // deg C (DHT22)
  mq2_raw: { warning: 700, high: 1500, critical: 2500 }, // raw ADC counts
  vibration_rms: { warning: 0.5, high: 1.2, critical: 2.5 }, // g RMS (MPU6050)
  sw420: { cooldownSeconds: 30 }, // digital vibration switch re-trigger window
  pir: { noteOnly: true }, // motion alone is never an intrusion claim
  sos: { classIfTrue: 'CRITICAL' },
  flame: { classIfTrue: 'CRITICAL' },
  // Contribution of each factor to the 0-100 score (clamped).
  weights: { temperature: 25, mq2_raw: 30, vibration: 20, flame: 30, sos: 60, sw420: 10, pir: 5, fault: 10 },
  // Score bands -> classification.
  bands: { LOW: 20, MODERATE: 40, HIGH: 65, CRITICAL: 85 },
  // An open incident for the same (device, factor) does not raise a new
  // incident for this long; repeats are recorded as recurrent observations.
  incidentCooldownSeconds: 300,
});

const NUMERIC_LIMITS = {
  temperature: [-40, 85],    // DHT22 datasheet range
  humidity: [0, 100],
  mq2_raw: [0, 4095],        // 12-bit ADC
  vibration_rms: [0, 16],    // MPU6050 +/-16 g full scale
};
const BOOLEAN_FIELDS = ['sw420', 'pir', 'flame', 'sos'];

export function resolveThresholds(overrides = {}) {
  const merged = structuredClone(DEFAULT_THRESHOLDS);
  for (const group of ['temperature', 'mq2_raw', 'vibration_rms', 'weights', 'bands']) {
    if (overrides[group] && typeof overrides[group] === 'object') {
      for (const [key, value] of Object.entries(overrides[group])) {
        if (typeof value === 'number' && Number.isFinite(value)) merged[group][key] = value;
      }
    }
  }
  if (typeof overrides.incidentCooldownSeconds === 'number') {
    merged.incidentCooldownSeconds = overrides.incidentCooldownSeconds;
  }
  return merged;
}

// Normalize + validate one sensor map. Returns { values, invalid, missing }.
// Invalid values are excluded from scoring but reported in the explanation.
export function normalizeSensors(sensors = {}, health = {}) {
  const values = {};
  const invalid = [];
  const missing = [];
  const distrusted = [];
  for (const field of [...Object.keys(NUMERIC_LIMITS), ...BOOLEAN_FIELDS]) {
    if (!Object.hasOwn(sensors, field)) { missing.push(field); continue; }
    if (health[field] && health[field] !== 'ok') {
      distrusted.push({ field, health: String(health[field]) });
      continue;
    }
    const value = sensors[field];
    if (BOOLEAN_FIELDS.includes(field)) {
      if (typeof value === 'boolean') values[field] = value;
      else invalid.push({ field, reason: 'not_boolean' });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      invalid.push({ field, reason: 'not_finite_number' });
      continue;
    }
    const [min, max] = NUMERIC_LIMITS[field];
    if (value < min || value > max) { invalid.push({ field, reason: 'out_of_range' }); continue; }
    values[field] = value;
  }
  return { values, invalid, missing, distrusted };
}

function bandFor(score, bands) {
  if (score >= bands.CRITICAL) return 'CRITICAL';
  if (score >= bands.HIGH) return 'HIGH';
  if (score >= bands.MODERATE) return 'MODERATE';
  if (score >= bands.LOW) return 'LOW';
  return 'NORMAL';
}

// Severity ladder so classifications never decrease when factors escalate.
const CLASS_RANK = Object.fromEntries(RISK_CLASSES.map((name, index) => [name, index]));
function raise(current, candidate) {
  return CLASS_RANK[candidate] > CLASS_RANK[current] ? candidate : current;
}

/**
 * Analyze one normalized reading.
 *
 * @param {object} reading  { deviceId, observedAt, sensors, health?, source?, messageId? }
 * @param {object} options  { now?: Date, thresholds?: object, staleAfterSeconds?: number, openIncidents?: object }
 * @returns {{ deviceId: string, score: number, classification: string,
 *             factors: object[], incidents: object[], dataQuality: object,
 *             analyzedAt: Date, stale: boolean, source: string }}
 */
export function analyzeReading(reading, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  // Always merge through resolveThresholds so a partial/empty override
  // (e.g. config.riskThresholds = {}) never drops required groups.
  const thresholds = options.thresholds ? resolveThresholds(options.thresholds) : DEFAULT_THRESHOLDS;
  const staleAfterSeconds = options.staleAfterSeconds ?? 120;
  const openIncidents = options.openIncidents ?? new Map(); // key -> lastRaisedAt (Date)

  const deviceId = String(reading?.deviceId ?? '');
  if (!deviceId) throw new Error('deviceId is required');
  const observedAt = reading.observedAt instanceof Date ? reading.observedAt : new Date(reading.observedAt);
  const stale = !Number.isFinite(observedAt.getTime())
    || (now.getTime() - observedAt.getTime()) > staleAfterSeconds * 1000
    || observedAt.getTime() > now.getTime() + 300000; // future timestamps are not trusted

  const { values, invalid, missing, distrusted } = normalizeSensors(reading.sensors, reading.health);
  const factors = [];
  const incidents = [];
  let score = 0;
  let classification = 'NORMAL';

  const addFactor = (factor) => {
    factors.push(factor);
    score = Math.min(100, score + factor.contribution);
    classification = raise(classification, factor.classification);
  };

  const addIncident = (kind, field, message, severityClass) => {
    const key = `${deviceId}:${kind}:${field ?? 'state'}`;
    const lastRaisedAt = openIncidents.get(key);
    const cooldownMs = thresholds.incidentCooldownSeconds * 1000;
    const recurrent = lastRaisedAt instanceof Date && (now.getTime() - lastRaisedAt.getTime()) < cooldownMs;
    incidents.push({
      incidentId: key, kind, field, message,
      classification: severityClass, recurrent,
      detectedAt: now.toISOString(),
    });
    if (!recurrent) openIncidents.set(key, now); // caller persists the map state if it wants dedup across calls
  };

  // --- SOS: unconditional emergency, independent of any other sensor ------
  if (values.sos === true) {
    addFactor({ factor: 'sos', contribution: thresholds.weights.sos, classification: 'CRITICAL',
      value: true, message: 'SOS button active: emergency assistance requested at this device.' });
    addIncident('sos', 'sos', 'SOS activation', 'CRITICAL');
  }

  // --- Flame: fire indication --------------------------------------------
  if (values.flame === true) {
    addFactor({ factor: 'flame', contribution: thresholds.weights.flame, classification: 'CRITICAL',
      value: true, message: 'Flame sensor indicates fire; verify visually and evacuate if confirmed.' });
    addIncident('flame', 'flame', 'Flame indication', 'CRITICAL');
  }

  // --- Temperature (only if health is trusted) ----------------------------
  if (typeof values.temperature === 'number') {
    const t = values.temperature;
    const th = thresholds.temperature;
    if (t >= th.critical) addFactor({ factor: 'temperature', contribution: thresholds.weights.temperature, classification: 'CRITICAL', value: t, threshold: th.critical, message: `Temperature ${t} >= critical threshold ${th.critical}.` });
    else if (t >= th.high) addFactor({ factor: 'temperature', contribution: Math.round(thresholds.weights.temperature * 0.75), classification: 'HIGH', value: t, threshold: th.high, message: `Temperature ${t} >= high threshold ${th.high}.` });
    else if (t >= th.warning) addFactor({ factor: 'temperature', contribution: Math.round(thresholds.weights.temperature * 0.4), classification: 'MODERATE', value: t, threshold: th.warning, message: `Temperature ${t} >= warning threshold ${th.warning}.` });
  }

  // --- MQ-2 raw gas/smoke -------------------------------------------------
  if (typeof values.mq2_raw === 'number') {
    const g = values.mq2_raw;
    const th = thresholds.mq2_raw;
    if (g >= th.critical) addFactor({ factor: 'mq2_raw', contribution: thresholds.weights.mq2_raw, classification: 'CRITICAL', value: g, threshold: th.critical, message: `MQ-2 raw ${g} >= critical threshold ${th.critical}; possible gas or smoke.` });
    else if (g >= th.high) addFactor({ factor: 'mq2_raw', contribution: Math.round(thresholds.weights.mq2_raw * 0.75), classification: 'HIGH', value: g, threshold: th.high, message: `MQ-2 raw ${g} >= high threshold ${th.high}.` });
    else if (g >= th.warning) addFactor({ factor: 'mq2_raw', contribution: Math.round(thresholds.weights.mq2_raw * 0.4), classification: 'MODERATE', value: g, threshold: th.warning, message: `MQ-2 raw ${g} >= warning threshold ${th.warning}.` });
  }

  // --- Vibration (MPU6050 RMS + SW-420 digital switch) -------------------
  if (typeof values.vibration_rms === 'number') {
    const v = values.vibration_rms;
    const th = thresholds.vibration_rms;
    if (v >= th.critical) addFactor({ factor: 'vibration', contribution: thresholds.weights.vibration, classification: 'HIGH', value: v, threshold: th.critical, message: `Abnormal vibration ${v} g RMS >= critical threshold ${th.critical}.` });
    else if (v >= th.high) addFactor({ factor: 'vibration', contribution: Math.round(thresholds.weights.vibration * 0.7), classification: 'HIGH', value: v, threshold: th.high, message: `Elevated vibration ${v} g RMS >= high threshold ${th.high}.` });
    else if (v >= th.warning) addFactor({ factor: 'vibration', contribution: Math.round(thresholds.weights.vibration * 0.35), classification: 'LOW', value: v, threshold: th.warning, message: `Vibration ${v} g RMS >= warning threshold ${th.warning}.` });
  }
  if (values.sw420 === true) {
    addFactor({ factor: 'sw420', contribution: thresholds.weights.sw420, classification: 'LOW',
      value: true, message: 'SW-420 vibration switch triggered (digital detection).' });
    addIncident('vibration', 'sw420', 'SW-420 vibration trigger', 'LOW');
  }

  // --- PIR motion: informational only ------------------------------------
  if (values.pir === true) {
    addFactor({ factor: 'pir', contribution: thresholds.weights.pir, classification: 'LOW',
      value: true, informational: true,
      message: 'PIR motion detected. Motion alone is not treated as intrusion.' });
  }

  // --- Data-quality factors ----------------------------------------------
  const faulted = distrusted.length + invalid.length;
  if (faulted > 0) {
    addFactor({ factor: 'fault', contribution: thresholds.weights.fault, classification: 'LOW',
      value: faulted,
      message: `Sensor fault: ${distrusted.map(d => `${d.field}(${d.health})`).join(', ')}${invalid.length ? `${distrusted.length ? '; ' : ''}${invalid.map(i => `${i.field}(${i.reason})`).join(', ')}` : ''}` });
    addIncident('fault', distrusted[0]?.field ?? invalid[0]?.field ?? 'sensors', 'Sensor health fault or invalid value', 'LOW');
  }

  // --- Stale readings ------------------------------------------------------
  if (stale) {
    // Stale data must never look safe-but-current: keep the computed class
    // but flag it, and any emergency factors lose their "live" meaning.
    addFactor({ factor: 'stale', contribution: 0, classification,
      value: true, message: `Reading is stale or timestamp invalid (observedAt=${reading.observedAt}). Risk reflects the last known state, not current conditions.` });
  }

  classification = raise(classification, bandFor(score, thresholds.bands));

  return {
    deviceId,
    score,
    classification,
    factors,
    incidents,
    dataQuality: { invalid, missing, distrusted, stale },
    analyzedAt: now,
    stale,
    source: reading.source ?? 'unknown',
  };
}
