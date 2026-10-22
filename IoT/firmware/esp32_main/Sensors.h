#pragma once
#include "Settings.h"
#include "SafetySignals.h"
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

enum Field { Temperature, Humidity, Mq2, Vibration, Sw420, Pir, Flame, Sos, FieldCount };
enum Health { Missing, Error, Degraded, Ok };
struct Snapshot { float value[FieldCount]; Health health[FieldCount]; };
struct SafetyEvent { uint32_t atMs; bool sos; };
bool beginSensors();
void sampleSensors();
Snapshot sensorSnapshot();
extern QueueHandle_t safetyEvents;
