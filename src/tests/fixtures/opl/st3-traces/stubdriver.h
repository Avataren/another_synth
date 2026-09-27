#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
void lockMixer(void);
void unlockMixer(void);
bool openMixer(int32_t audioFrequency, int32_t audioBufferSize);
void closeMixer(void);
