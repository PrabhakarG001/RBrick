#include "../esp32_main/SafetySignals.h"
#include <assert.h>
#include <stdio.h>

int main() {
  DebouncedInput input;
  assert(!input.update(false,0,30));
  assert(!input.update(true,10,30));
  assert(!input.update(false,20,30));
  assert(!input.update(true,40,30));
  assert(!input.update(true,69,30));
  assert(input.update(true,70,30));
  assert(!input.update(true,90,30)); // Held SOS produces only one rising edge.
  assert(!input.update(false,100,30));
  assert(!input.update(false,130,30));
  assert(!input.value);
  assert(!input.update(true,140,30));
  assert(input.update(true,170,30));
  DebouncedInput wrap;
  assert(!wrap.update(true,UINT32_MAX-10,30));
  assert(wrap.update(true,20,30)); // millis rollover.
  MotionWindow still;
  assert(isnan(still.rms()));
  for (int i=0;i<100;++i) still.add(0,0,1);
  assert(fabs(still.rms()) < 0.00001); // Removes stationary gravity/DC offset.
  MotionWindow moving;
  for (int i=0;i<100;++i) moving.add(i%2 ? 1 : -1,0,1);
  assert(fabs(moving.rms()-1) < 0.00001);
  puts("PASS debouncing, held-input suppression, rollover and MPU dynamic RMS aggregation");
}
