import { EmergencyIncident, Alert } from '../models/index.js';

export class EmergencyService {
  constructor(status = {}) {
    this.status = status;
    this.realtime = null;
    this.mqttPublisher = null;
  }

  setRealtime(realtime) {
    this.realtime = realtime;
  }

  setMqttPublisher(publisher) {
    this.mqttPublisher = publisher;
  }

  async triggerEmergency(data) {
    const emergencyId = `EMG-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
    const now = new Date();

    const deviceId = data.deviceId || 'manual-sos';
    const buildingId = data.buildingId || 'Building-1';
    const floorId = data.floorId || '';
    const zoneId = data.zoneId || '';
    const room = data.room || '';
    const message = data.message || 'SOS Emergency Button Activated';
    const triggerSource = data.triggerSource || 'web_ui';
    const severity = data.severity || 'critical';
    const reportedBy = data.reportedBy || {
      name: 'Occupant / SOS',
      role: 'student',
    };

    // Create linked Alert so it appears in unified safety feeds
    let alertId = null;
    try {
      const alert = await Alert.create({
        deviceId,
        kind: 'sos',
        field: 'sos',
        message: `[EMERGENCY] ${message} - ${buildingId}${room ? ` Room ${room}` : ''}`,
        observedAt: now,
        severity: 'critical',
        zoneId: zoneId || undefined,
        incidentId: emergencyId,
        source: triggerSource === 'hardware' ? 'hardware' : triggerSource === 'simulation' ? 'simulation' : 'operator',
      });
      alertId = alert._id;
    } catch (err) {
      console.warn('Could not create mirror alert for emergency incident:', err.message);
    }

    const incident = await EmergencyIncident.create({
      emergencyId,
      alertId,
      deviceId,
      buildingId,
      floorId,
      zoneId,
      room,
      status: 'active',
      triggerSource,
      severity,
      reportedBy,
      message,
      buzzerState: 'active',
      timeline: [{
        action: 'triggered',
        actor: reportedBy.name || 'Occupant',
        role: reportedBy.role || 'student',
        timestamp: now,
        notes: message,
      }],
    });

    // Publish MQTT buzzer actuation command if publisher configured
    if (this.mqttPublisher) {
      try {
        const topic = `resilliox/actuators/${deviceId}/buzzer`;
        this.mqttPublisher(topic, JSON.stringify({
          action: 'ALARM_ON',
          emergencyId,
          deviceId,
          buzzer: true,
          timestamp: now.toISOString(),
        }));
      } catch (err) {
        console.warn('MQTT buzzer publish failed:', err.message);
      }
    }

    // Broadcast realtime event to all connected dashboard clients
    if (this.realtime?.broadcast) {
      this.realtime.broadcast('emergency:active', {
        id: incident._id.toString(),
        emergencyId: incident.emergencyId,
        deviceId: incident.deviceId,
        buildingId: incident.buildingId,
        zoneId: incident.zoneId,
        room: incident.room,
        message: incident.message,
        severity: incident.severity,
        status: incident.status,
        buzzerState: incident.buzzerState,
        observedAt: now.toISOString(),
        reportedBy: incident.reportedBy,
      });
    }

    return incident;
  }

  async acknowledgeEmergency(id, actor) {
    const now = new Date();
    const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { emergencyId: id };

    const incident = await EmergencyIncident.findOne(query);
    if (!incident) throw new Error('Emergency incident not found');
    if (incident.status === 'resolved' || incident.status === 'cancelled') {
      throw new Error(`Cannot acknowledge an emergency that is already ${incident.status}`);
    }

    incident.status = 'acknowledged';
    incident.acknowledgedAt = now;
    incident.acknowledgedBy = {
      userId: actor.userId,
      name: actor.name,
      role: actor.role,
    };
    incident.timeline.push({
      action: 'acknowledged',
      actor: actor.name,
      role: actor.role,
      timestamp: now,
      notes: 'Emergency acknowledged by responder',
    });

    await incident.save();

    // Mirror to Alert if present
    if (incident.alertId) {
      await Alert.findByIdAndUpdate(incident.alertId, {
        acknowledgedAt: now,
        acknowledgedBy: actor.name,
      });
    }

    if (this.realtime?.broadcast) {
      this.realtime.broadcast('emergency:updated', incident.toObject());
    }

    return incident;
  }

  async dispatchResponse(id, responderUnit, notes, actor) {
    const now = new Date();
    const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { emergencyId: id };

    const incident = await EmergencyIncident.findOne(query);
    if (!incident) throw new Error('Emergency incident not found');
    if (incident.status === 'resolved' || incident.status === 'cancelled') {
      throw new Error(`Cannot dispatch response for an emergency that is already ${incident.status}`);
    }

    incident.status = 'responding';
    incident.responseDispatchedAt = now;
    incident.responderUnit = responderUnit;
    incident.timeline.push({
      action: 'dispatched',
      actor: actor.name,
      role: actor.role,
      timestamp: now,
      notes: `Dispatched: ${responderUnit}. ${notes || ''}`,
    });

    await incident.save();

    if (this.realtime?.broadcast) {
      this.realtime.broadcast('emergency:updated', incident.toObject());
    }

    return incident;
  }

  async setBuzzer(id, buzzerState, actor) {
    const now = new Date();
    const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { emergencyId: id };

    const incident = await EmergencyIncident.findOne(query);
    if (!incident) throw new Error('Emergency incident not found');

    incident.buzzerState = buzzerState;
    incident.timeline.push({
      action: buzzerState === 'silenced' ? 'buzzer_silenced' : 'buzzer_activated',
      actor: actor.name,
      role: actor.role,
      timestamp: now,
      notes: `Buzzer state set to ${buzzerState}`,
    });

    await incident.save();

    if (this.mqttPublisher) {
      try {
        const topic = `resilliox/actuators/${incident.deviceId}/buzzer`;
        this.mqttPublisher(topic, JSON.stringify({
          action: buzzerState === 'active' ? 'ALARM_ON' : 'ALARM_OFF',
          emergencyId: incident.emergencyId,
          buzzer: buzzerState === 'active',
          timestamp: now.toISOString(),
        }));
      } catch (err) {
        console.warn('MQTT buzzer publish failed:', err.message);
      }
    }

    if (this.realtime?.broadcast) {
      this.realtime.broadcast('emergency:updated', incident.toObject());
    }

    return incident;
  }

  async resolveEmergency(id, resolutionNotes, actor) {
    const now = new Date();
    const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { emergencyId: id };

    const incident = await EmergencyIncident.findOne(query);
    if (!incident) throw new Error('Emergency incident not found');
    if (incident.status === 'resolved') {
      throw new Error('Emergency incident has already been resolved');
    }

    incident.status = 'resolved';
    incident.buzzerState = 'off';
    incident.resolvedAt = now;
    incident.resolvedBy = {
      userId: actor.userId,
      name: actor.name,
      role: actor.role,
    };
    incident.resolutionNotes = resolutionNotes || 'Resolved by safety operator';
    incident.timeline.push({
      action: 'resolved',
      actor: actor.name,
      role: actor.role,
      timestamp: now,
      notes: resolutionNotes || 'Emergency declared all-clear and resolved',
    });

    await incident.save();

    // Turn off buzzer on hardware
    if (this.mqttPublisher) {
      try {
        const topic = `resilliox/actuators/${incident.deviceId}/buzzer`;
        this.mqttPublisher(topic, JSON.stringify({
          action: 'ALARM_OFF',
          emergencyId: incident.emergencyId,
          buzzer: false,
          timestamp: now.toISOString(),
        }));
      } catch (err) {
        console.warn('MQTT buzzer publish failed:', err.message);
      }
    }

    // Mirror to Alert if present
    if (incident.alertId) {
      await Alert.findByIdAndUpdate(incident.alertId, {
        resolvedAt: now,
        resolvedBy: actor.name,
        resolution: resolutionNotes || 'Resolved by safety operator',
      });
    }

    if (this.realtime?.broadcast) {
      this.realtime.broadcast('emergency:resolved', incident.toObject());
    }

    return incident;
  }
}
