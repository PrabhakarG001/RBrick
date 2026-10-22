#include "MqttTransport.h"
#include "Sensors.h"
#include <WiFi.h>
#include <mqtt_client.h>
#include <cJSON.h>
#include <esp_random.h>
#include <atomic>
#include <time.h>

static esp_mqtt_client_handle_t client = nullptr;
static std::atomic<bool> connected{false}, connectionChanged{false};
static bool configured = false, clockStarted = false, mqttStarted = false;
static char prefix[420], availability[440], bootId[24];
static uint32_t sequence = 0, wifiAt = 0, wifiBackoff = 0, telemetryAt = 0, statusAt = 0, diagnosticAt = 0;
static const char* fields[] = {"temperature","humidity","mq2_raw","vibration_rms","sw420","pir","flame","sos"};
static const char* healthNames[] = {"missing","error","degraded","ok"};

static bool validId(const char* id) {
  size_t length = strlen(id);
  if (!length || length > 128) return false;
  for (const char* p = id; *p; ++p) if (!isalnum(*p) && *p != '_' && *p != '-' && *p != ':' && *p != '.') return false;
  return true;
}
static bool clockReady() { return time(nullptr) > 1704067200; }
static cJSON* envelope(uint32_t ageMs = 0) {
  cJSON* root = cJSON_CreateObject();
  if (!root) return nullptr;
  char messageId[64], timestamp[32];
  snprintf(messageId,sizeof(messageId),"%s-%lu",bootId,(unsigned long)++sequence);
  time_t at = time(nullptr) - ageMs/1000;
  struct tm utc; gmtime_r(&at,&utc);
  strftime(timestamp,sizeof(timestamp),"%Y-%m-%dT%H:%M:%SZ",&utc);
  cJSON_AddStringToObject(root,"schema_version","1.0");
  cJSON_AddStringToObject(root,"message_id",messageId);
  cJSON_AddStringToObject(root,"device_id",cfg::deviceId);
  cJSON_AddStringToObject(root,"building_id",cfg::buildingId);
  cJSON_AddStringToObject(root,"zone_id",cfg::zoneId);
  cJSON_AddStringToObject(root,"timestamp",timestamp);
  cJSON_AddStringToObject(root,"source","hardware");
  return root;
}
static bool sendJson(const char* channel, cJSON* root, bool retained) {
  if (!root) return false;
  char topic[450]; snprintf(topic,sizeof(topic),"%s/%s",prefix,channel);
  char* json = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  if (!json) return false;
  // Native ESP-MQTT async outbox supports actual outbound QoS 1.
  int result = esp_mqtt_client_enqueue(client,topic,json,0,1,retained,true);
  cJSON_free(json);
  if (result < 0) Serial.println("MQTT enqueue failed/full: bounded queue, message not accepted");
  return result >= 0;
}
static void mqttEvent(void*, esp_event_base_t, int32_t eventId, void*) {
  if (eventId == MQTT_EVENT_CONNECTED) { connected.store(true); connectionChanged.store(true); }
  if (eventId == MQTT_EVENT_DISCONNECTED || eventId == MQTT_EVENT_ERROR) connected.store(false);
}

void beginNetwork() {
  snprintf(bootId,sizeof(bootId),"%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
  if (cfg::includeBuildingInTopic) snprintf(prefix,sizeof(prefix),"building/%s/%s/%s",cfg::buildingId,cfg::zoneId,cfg::deviceId);
  else snprintf(prefix,sizeof(prefix),"building/%s/%s",cfg::zoneId,cfg::deviceId);
  snprintf(availability,sizeof(availability),"%s/availability",prefix);
  const bool tls = strncmp(cfg::mqttUri,"mqtts://",8) == 0;
  if (!strlen(cfg::wifiSsid) || !strlen(cfg::mqttUser) || !strlen(cfg::mqttPassword)
      || !validId(cfg::deviceId) || !validId(cfg::buildingId) || !validId(cfg::zoneId)
      || (!tls && strncmp(cfg::mqttUri,"mqtt://",7) != 0) || (tls && !strlen(cfg::mqttCaPem))) {
    Serial.println("Network disabled: configure private credentials, identities and broker URI/CA"); return;
  }
  esp_mqtt_client_config_t options = {};
  options.broker.address.uri = cfg::mqttUri;
  if (tls) options.broker.verification.certificate = cfg::mqttCaPem;
  options.credentials.client_id = cfg::deviceId;
  options.credentials.username = cfg::mqttUser;
  options.credentials.authentication.password = cfg::mqttPassword;
  options.session.protocol_ver = MQTT_PROTOCOL_V_3_1_1;
  options.session.keepalive = 30;
  options.session.last_will.topic = availability;
  options.session.last_will.msg = "offline";
  options.session.last_will.qos = 1;
  options.session.last_will.retain = true;
  options.network.reconnect_timeout_ms = 5000;
  options.network.timeout_ms = 5000;
  options.buffer.size = 2048;
  options.outbox.limit = 16384;
  client = esp_mqtt_client_init(&options);
  if (!client || esp_mqtt_client_register_event(client, MQTT_EVENT_ANY,mqttEvent,nullptr) != ESP_OK) {
    Serial.println("MQTT initialization failed; local alarm remains independent"); return;
  }
  WiFi.mode(WIFI_STA);
  configured = true;
}

void serviceNetwork() {
  if (!configured) return;
  const uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (uint32_t(now-wifiAt) >= wifiBackoff) {
      wifiAt = now;
      wifiBackoff = wifiBackoff ? min(wifiBackoff * 2, uint32_t(30000)) : 1000;
      WiFi.begin(cfg::wifiSsid,cfg::wifiPassword); // Async; no wait loop.
    }
    return;
  }
  wifiBackoff = 1000;
  if (!clockStarted) { configTime(0,0,cfg::ntpServer); clockStarted = true; }
  // Clock is also needed for TLS certificate verification. Local alarms never wait.
  if (!clockReady()) return;
  if (!mqttStarted) {
    if (esp_mqtt_client_start(client) == ESP_OK) mqttStarted = true;
    else return;
  }
  if (uint32_t(now-diagnosticAt) >= 10000) {
    diagnosticAt = now;
    Serial.printf("MQTT connected=%s; outbox=%d bytes\n",connected.load() ? "yes" : "no",esp_mqtt_client_get_outbox_size(client));
  }
  if (!connected.load()) return;
  if (connectionChanged.exchange(false)) {
    esp_mqtt_client_enqueue(client,availability,"online",0,1,true,true);
    statusAt = now - cfg::heartbeatMs;
  }
  // SOS FIFO is bounded to 8 events; never replay an expired emergency as new.
  SafetyEvent event;
  while (safetyEvents && xQueuePeek(safetyEvents,&event,0) == pdTRUE) {
    uint32_t age = now-event.atMs;
    if (age > cfg::eventTtlMs) {
      xQueueReceive(safetyEvents,&event,0); Serial.println("Expired offline SOS event dropped (local alarm already handled)"); continue;
    }
    cJSON* root = envelope(age);
    if (!root) break;
    cJSON* body = cJSON_AddObjectToObject(root,"event");
    if (!body) { cJSON_Delete(root); break; }
    cJSON_AddStringToObject(body,"kind","sos");
    cJSON_AddStringToObject(body,"detail","Debounced physical SOS button pressed; timestamp reconstructed from local event age");
    if (!sendJson("events",root,false)) break;
    xQueueReceive(safetyEvents,&event,0);
  }
  const Snapshot snapshot = sensorSnapshot();
  bool degraded = false;
  for (int i = 0; i < FieldCount; ++i) if (snapshot.health[i] != Ok) degraded = true;
  if (uint32_t(now-statusAt) >= cfg::heartbeatMs) {
    statusAt = now;
    cJSON* root = envelope();
    if (root) {
      cJSON_AddStringToObject(root,"firmware_version",cfg::firmwareVersion);
      cJSON_AddStringToObject(root,"state",degraded ? "degraded" : "online");
      sendJson("status",root,true);
    }
  }
  if (uint32_t(now-telemetryAt) < cfg::telemetryMs) return;
  telemetryAt = now;
  cJSON* root = envelope();
  if (!root) return;
  cJSON_AddStringToObject(root,"firmware_version",cfg::firmwareVersion);
  cJSON* sensors = cJSON_AddObjectToObject(root,"sensors");
  cJSON* health = cJSON_AddObjectToObject(root,"health");
  if (!sensors || !health) { cJSON_Delete(root); return; }
  for (int i = 0; i < FieldCount; ++i) {
    const bool valid = snapshot.health[i] == Ok && isfinite(snapshot.value[i]);
    if (!valid) cJSON_AddNullToObject(sensors,fields[i]);
    else if (i >= Sw420) cJSON_AddBoolToObject(sensors,fields[i],snapshot.value[i] != 0);
    else cJSON_AddNumberToObject(sensors,fields[i],snapshot.value[i]);
    cJSON_AddStringToObject(health,fields[i],healthNames[!valid && snapshot.health[i] == Ok ? Error : snapshot.health[i]]);
  }
  sendJson("telemetry",root,false);
}
