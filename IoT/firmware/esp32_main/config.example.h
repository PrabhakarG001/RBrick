#pragma once
// Copy to ignored config.local.h. Never commit real Wi-Fi/MQTT credentials.
namespace cfg {
constexpr char wifiSsid[] = "";
constexpr char wifiPassword[] = "";
constexpr char mqttUri[] = ""; // mqtt://<laptop-LAN-IPv4>:1883 on trusted LAN
constexpr char mqttUser[] = "esp32_main_01";
constexpr char mqttPassword[] = "";
constexpr char mqttCaPem[] = ""; // Required PEM CA for mqtts://; never skip validation.
constexpr char deviceId[] = "esp32_main_01";
constexpr char buildingId[] = "building01";
constexpr char zoneId[] = "zone01";
constexpr char firmwareVersion[] = "0.1.0";
constexpr char ntpServer[] = "pool.ntp.org";
// false = requested short topics; true = existing building-qualified topics.
constexpr bool includeBuildingInTopic = false;

// HARDWARE GATE: exact board, breakout voltages and wiring are unconfirmed.
// All inputs/outputs remain disabled until reviewed. No suggested GPIO mapping.
constexpr bool pinsReviewed = false;
constexpr int dhtPin = -1, mq2Pin = -1, sdaPin = -1, sclPin = -1;
constexpr int sw420Pin = -1, pirPin = -1, flamePin = -1, sosPin = -1, buzzerPin = -1;
constexpr unsigned mpuAddress = 0x68; // Verify AD0/address on the actual module.
constexpr int sw420Active = HIGH, pirActive = HIGH, flameActive = LOW, sosActive = LOW;
enum class Buzzer { Unspecified, Active, Passive };
constexpr Buzzer buzzerType = Buzzer::Unspecified;
constexpr int buzzerActive = HIGH;
constexpr unsigned passiveBuzzerHz = 2400;
constexpr uint32_t telemetryMs = 2000, heartbeatMs = 30000;
constexpr uint32_t mq2WarmupMs = 180000; // Minimum settling delay, NOT calibration.
constexpr uint32_t debounceMs = 30, eventTtlMs = 60000, buzzerHoldMs = 3000;
}
