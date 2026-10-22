#include "Sensors.h"
#include <Wire.h>
#include <DHT.h>
#include <driver/gpio.h>

QueueHandle_t safetyEvents = nullptr;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static Snapshot data;
static DHT dht(cfg::dhtPin < 0 ? 0 : cfg::dhtPin, DHT22);
static bool enabled = false, mpuReady = false;
static MotionWindow motion;
static uint32_t lastMpu = 0, lastWindow = 0, lastSlow = 0;
static unsigned windowErrors = 0;

static void setValue(Field field, float value, Health health) {
  portENTER_CRITICAL(&lock);
  data.value[field] = value;
  data.health[field] = health;
  portEXIT_CRITICAL(&lock);
}
Snapshot sensorSnapshot() {
  portENTER_CRITICAL(&lock);
  Snapshot copy = data;
  portEXIT_CRITICAL(&lock);
  return copy;
}

static bool validatePins() {
  const int pins[] = {cfg::dhtPin,cfg::mq2Pin,cfg::sdaPin,cfg::sclPin,
    cfg::sw420Pin,cfg::pirPin,cfg::flamePin,cfg::sosPin,cfg::buzzerPin};
  for (unsigned i = 0; i < sizeof(pins)/sizeof(pins[0]); ++i) {
    const int p = pins[i];
    if (p == -1) continue;
    if (!GPIO_IS_VALID_GPIO(p) || (p >= 6 && p <= 11) || p == 0 || p == 2 || p == 5 || p == 12 || p == 15) return false;
    for (unsigned j = 0; j < i; ++j) if (pins[j] == p) return false;
  }
  for (int p : {cfg::dhtPin,cfg::sdaPin,cfg::sclPin,cfg::buzzerPin}) {
    if (p != -1 && !GPIO_IS_VALID_OUTPUT_GPIO(p)) return false;
  }
  // Classic ESP32 ADC1 only: ADC2 conflicts with Wi-Fi. Check board pinout too.
  if (cfg::mq2Pin != -1 && (cfg::mq2Pin < 32 || cfg::mq2Pin > 39)) return false;
  if ((cfg::sdaPin == -1) != (cfg::sclPin == -1)) return false;
  if (cfg::buzzerPin != -1 && cfg::buzzerType == cfg::Buzzer::Unspecified) return false;
  return true;
}

static bool writeMpu(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(cfg::mpuAddress); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}
static bool initializeMpu() {
  Wire.beginTransmission(cfg::mpuAddress); Wire.write(0x75);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(uint8_t(cfg::mpuAddress), uint8_t(1)) != 1) return false;
  if (Wire.read() != 0x68) return false; // MPU6050 WHO_AM_I
  return writeMpu(0x6B,0x01) && writeMpu(0x1C,0x00) && writeMpu(0x1A,0x03) && writeMpu(0x19,9);
}

static void localSafetyTask(void*) {
  DebouncedInput sos, sw;
  uint32_t alarmAt = 0;
  bool alarmStarted = false, buzzerOn = false, swLatched = false;
  uint32_t swAt = 0;
  for (;;) {
    const uint32_t now = millis();
    if (cfg::sosPin != -1) {
      if (sos.update(digitalRead(cfg::sosPin) == cfg::sosActive, now, cfg::debounceMs)) {
        alarmAt = now; alarmStarted = true;
        SafetyEvent event{now,true};
        if (xQueueSend(safetyEvents, &event, 0) != pdTRUE) Serial.println("SOS queue full: local alarm remains active; remote event dropped");
      }
      setValue(Sos, sos.value, Ok);
    }
    if (cfg::sw420Pin != -1) {
      if (sw.update(digitalRead(cfg::sw420Pin) == cfg::sw420Active, now, cfg::debounceMs)) { swLatched = true; swAt = now; }
      if (swLatched && uint32_t(now - swAt) > cfg::telemetryMs) swLatched = false;
      setValue(Sw420, sw.value || swLatched, Ok);
    }
    if (cfg::pirPin != -1) setValue(Pir, digitalRead(cfg::pirPin) == cfg::pirActive, Ok);
    const bool flame = cfg::flamePin != -1 && digitalRead(cfg::flamePin) == cfg::flameActive;
    if (cfg::flamePin != -1) setValue(Flame, flame, Ok);
    const bool alarm = sos.value || flame || (alarmStarted && uint32_t(now - alarmAt) < cfg::buzzerHoldMs);
    if (cfg::buzzerPin != -1 && alarm != buzzerOn) {
      buzzerOn = alarm;
      if (cfg::buzzerType == cfg::Buzzer::Passive) {
        if (alarm) tone(cfg::buzzerPin, cfg::passiveBuzzerHz); else noTone(cfg::buzzerPin);
      } else digitalWrite(cfg::buzzerPin, alarm ? cfg::buzzerActive : !cfg::buzzerActive);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

bool beginSensors() {
  for (int i = 0; i < FieldCount; ++i) { data.value[i] = NAN; data.health[i] = Missing; }
  safetyEvents = xQueueCreate(8, sizeof(SafetyEvent));
  if (!safetyEvents) return false;
  if (!cfg::pinsReviewed) { Serial.println("Hardware gate: GPIOs disabled until board and wiring reviewed"); return true; }
  if (!validatePins()) { Serial.println("Invalid/conflicting GPIO configuration: all GPIOs disabled"); return false; }
  if (cfg::buzzerPin != -1) {
    digitalWrite(cfg::buzzerPin, !cfg::buzzerActive); pinMode(cfg::buzzerPin, OUTPUT);
  }
  for (int p : {cfg::sw420Pin,cfg::pirPin,cfg::flamePin}) if (p != -1) pinMode(p, INPUT);
  if (cfg::sosPin != -1) pinMode(cfg::sosPin, cfg::sosPin < 34 ? INPUT_PULLUP : INPUT);
  if (cfg::mq2Pin != -1) { pinMode(cfg::mq2Pin, INPUT); analogReadResolution(12); }
  if (cfg::dhtPin != -1) dht.begin();
  if (cfg::sdaPin != -1) { Wire.begin(cfg::sdaPin,cfg::sclPin,400000); Wire.setTimeOut(10); }
  if (xTaskCreate(localSafetyTask,"local-safety",4096,nullptr,3,nullptr) != pdPASS) return false;
  enabled = true;
  return true;
}

void sampleSensors() {
  if (!enabled) return;
  const uint32_t now = millis();
  if (cfg::sdaPin != -1 && uint32_t(now-lastMpu) >= 10) {
    lastMpu = now;
    if (!mpuReady) mpuReady = initializeMpu();
    if (mpuReady) {
      Wire.beginTransmission(cfg::mpuAddress); Wire.write(0x3B);
      if (Wire.endTransmission(false) == 0 && Wire.requestFrom(uint8_t(cfg::mpuAddress), uint8_t(6)) == 6) {
        float a[3];
        for (int i = 0; i < 3; ++i) {
          const uint8_t high = Wire.read(), low = Wire.read();
          const int16_t v = (uint16_t(high) << 8) | low;
          a[i] = v / 16384.0f;
        }
        motion.add(a[0],a[1],a[2]);
      } else { ++windowErrors; mpuReady = false; }
    } else ++windowErrors;
    if (uint32_t(now-lastWindow) >= 1000) {
      setValue(Vibration, windowErrors == 0 && motion.count >= 50 ? motion.rms() : NAN,
        windowErrors == 0 && motion.count >= 50 ? Ok : Error);
      motion = MotionWindow{}; windowErrors = 0; lastWindow = now;
    }
  }
  if (uint32_t(now-lastSlow) < 2000) return;
  lastSlow = now;
  if (cfg::dhtPin != -1) {
    float t = dht.readTemperature(), h = dht.readHumidity();
    setValue(Temperature, t, isfinite(t) && t >= -40 && t <= 80 ? Ok : Error);
    setValue(Humidity, h, isfinite(h) && h >= 0 && h <= 100 ? Ok : Error);
  }
  if (cfg::mq2Pin != -1) {
    if (now < cfg::mq2WarmupMs) setValue(Mq2, NAN, Degraded);
    else setValue(Mq2, analogRead(cfg::mq2Pin), Ok);
  }
}
