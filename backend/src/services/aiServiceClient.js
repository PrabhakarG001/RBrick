// HTTP transport/contract adapter only. Risk calculations stay in Python.
import { z } from 'zod';
const level = z.enum(['NORMAL','LOW','MODERATE','HIGH','CRITICAL']);
const utc = z.iso.datetime({ offset: true });
const scalar = z.union([z.number().finite(), z.boolean()]);
const hazard = z.object({ type: z.string().max(100), factor: z.string().max(64), severity: level,
  contribution: z.number().int().min(0).max(100), message: z.string().max(1000),
  value: scalar.nullable(), threshold: z.number().finite().nullable(), informational: z.boolean() }).strict();
const incident = z.object({ incidentId: z.string().max(256),
  kind: z.enum(['sos','flame','gas','vibration','fault','other']), field: z.string().max(64),
  message: z.string().max(1000), classification: level, detectedAt: utc, recurrent: z.literal(false) }).strict();
const prediction = z.object({ device_id: z.string(), message_id: z.string(), zone_id: z.string(),
  source: z.enum(['hardware','simulation']), timestamp: utc,
  risk_score: z.number().int().min(0).max(100), risk_level: level,
  hazards: z.array(hazard).max(64), incidents: z.array(incident).max(64),
  data_quality: z.object({ invalid: z.array(z.object({ field: z.string(), reason: z.string() })).max(8),
    missing: z.array(z.string()).max(8), distrusted: z.array(z.object({ field: z.string(), health: z.string() })).max(8),
    stale: z.boolean() }).strict(),
  features: z.record(z.string(),scalar), stale: z.boolean(), analyzed_at: utc,
  model_version: z.literal('python-rules-v1'), engine_version: z.literal('1.0.0'),
  incident_cooldown_seconds: z.number().int().min(0).max(86400) }).strict();

export class AiServiceError extends Error {
  constructor(code) { super('Python risk analysis unavailable'); this.code = code; }
}
export function createAiServiceClient(config, status = {}, fetchImpl = fetch) {
  const url = (config.aiServiceUrl || 'http://127.0.0.1:8000').replace(/\/$/, '');
  const timeout = config.aiTimeoutMs ?? 3000;
  async function request(endpoint, body) {
    try {
      const response = await fetchImpl(url + endpoint, { method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(timeout), redirect: 'error',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(config.aiServiceToken ? { Authorization: `Bearer ${config.aiServiceToken}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new AiServiceError('unavailable'); }
      let length = 0; const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 65536) throw new AiServiceError('invalid_response');
        chunks.push(Buffer.from(chunk));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new AiServiceError('invalid_response'); }
    } catch (error) {
      throw error instanceof AiServiceError ? error
        : new AiServiceError(['TimeoutError','AbortError'].includes(error.name) ? 'timeout' : 'unavailable');
    }
  }
  function failed(error) {
    status.ai = false;
    status.aiLastError = error.code;
    status.aiFailures = (status.aiFailures ?? 0) + 1;
    if (error.code === 'timeout') status.aiTimeouts = (status.aiTimeouts ?? 0) + 1;
  }
  function succeeded() {
    status.ai = true; status.aiLastError = null; status.aiLastSuccessAt = new Date().toISOString();
  }
  return {
    async healthcheck() {
      try {
        const data = await request('/health');
        if (data.status !== 'ok' || data.model_version !== 'python-rules-v1' || data.trained_model !== false) {
          throw new AiServiceError('invalid_response');
        }
        succeeded(); return true;
      } catch (error) { failed(error); return false; }
    },
    async predict(message, options = {}) {
      try {
        const raw = await request('/predict', {
          schema_version: message.schema_version, message_id: message.message_id,
          device_id: message.device_id, building_id: message.building_id, zone_id: message.zone_id,
          timestamp: message.timestamp, source: message.source, firmware_version: message.firmware_version,
          sensors: message.sensors, health: message.health,
          stale_after_seconds: options.staleAfterSeconds ?? 120,
        });
        const parsed = prediction.safeParse(raw);
        if (!parsed.success) throw new AiServiceError('invalid_response');
        const data = parsed.data;
        if (data.device_id !== message.device_id || data.message_id !== message.message_id ||
            data.zone_id !== message.zone_id || data.source !== message.source ||
            Date.parse(data.timestamp) !== Date.parse(message.timestamp) ||
            data.stale !== data.data_quality.stale || (data.stale && data.incidents.length)) {
          throw new AiServiceError('invalid_response');
        }
        succeeded();
        return { deviceId: data.device_id, score: data.risk_score, classification: data.risk_level,
          factors: data.hazards.map(({ type, severity, ...factor }) => ({ ...factor, type, classification: severity })),
          incidents: data.incidents, dataQuality: data.data_quality, features: data.features,
          analyzedAt: new Date(data.analyzed_at), stale: data.stale, source: data.source,
          modelVersion: data.model_version, engineVersion: data.engine_version,
          incidentCooldownSeconds: data.incident_cooldown_seconds };
      } catch (error) {
        const safeError = error instanceof AiServiceError ? error : new AiServiceError('invalid_response');
        failed(safeError); throw safeError;
      }
    },
    async predictMultiLabel(payload, options = {}) {
      try {
        const raw = await request('/predict/multilabel', payload);
        if (!raw || typeof raw !== 'object' || !raw.predicted_labels) {
          throw new AiServiceError('invalid_response');
        }
        succeeded();
        return raw;
      } catch (error) {
        const safeError = error instanceof AiServiceError ? error : new AiServiceError('invalid_response');
        failed(safeError);
        throw safeError;
      }
    },
    async getMultiLabelInfo() {
      try {
        const raw = await request('/models/multilabel/info');
        succeeded();
        return raw;
      } catch (error) {
        const safeError = error instanceof AiServiceError ? error : new AiServiceError('invalid_response');
        failed(safeError);
        throw safeError;
      }
    },
  };
}
