#pragma once
#include <Arduino.h>
#if __has_include("config.local.h")
#include "config.local.h"
#else
#include "config.example.h"
#endif
#if !CONFIG_IDF_TARGET_ESP32
#error "Reference firmware targets classic ESP32 only. Confirm board before adapting to another chip."
#endif
