#include "Sensors.h"
#include "MqttTransport.h"

void setup() {
  Serial.begin(115200);
  Serial.println("RBrick ESP32 firmware 0.1.0; physical validation pending");
  if (!beginSensors()) {
    Serial.println("Sensor initialization failed: correct configuration before continuing");
    for (;;) delay(1000);
  }
  beginNetwork();
}

void loop() {
  sampleSensors();
  serviceNetwork();
  delay(1);
}
