#ifndef RESILLIOX_SAFETY_SIGNALS_H
#define RESILLIOX_SAFETY_SIGNALS_H
#include <stdint.h>
#include <math.h>

// Pure sampling helpers, independent of Wi-Fi, MQTT and Arduino GPIO APIs.
struct DebouncedInput {
  bool initialized = false, candidate = false, value = false;
  uint32_t changedAt = 0;
  bool update(bool raw, uint32_t now, uint32_t settleMs) {
    if (!initialized) { initialized = true; candidate = raw; changedAt = now; }
    if (raw != candidate) { candidate = raw; changedAt = now; }
    bool rising = false;
    if (uint32_t(now - changedAt) >= settleMs && value != candidate) {
      value = candidate;
      rising = value;
    }
    return rising;
  }
};

struct MotionWindow {
  unsigned count = 0;
  double mean[3] = {}, m2[3] = {};
  void add(float x, float y, float z) {
    const double v[] = {x, y, z};
    ++count;
    for (int i = 0; i < 3; ++i) {
      const double delta = v[i] - mean[i];
      mean[i] += delta / count;
      m2[i] += delta * (v[i] - mean[i]);
    }
  }
  float rms() const {
    return count > 1 ? sqrt((m2[0] + m2[1] + m2[2]) / count) : NAN;
  }
};
#endif
