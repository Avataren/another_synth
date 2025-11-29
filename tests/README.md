# Test Suite

This directory contains automated tests for the synthesizer codebase.

## Current Test Coverage

- **Test Files:** 4 passing
- **Total Tests:** 35 passing
- **Test Duration:** ~700ms

### Test Breakdown
- `patch-serializer.test.ts` - 8 tests
- `tracker-state.test.ts` - 12 tests
- `song-bank-normalization.test.ts` - 13 tests
- `src/tests/stores/connection.test.ts` - 2 tests

## Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode (for development)
npm run test

# Run tests once (for CI)
npm run test:run

# Run specific test file
npm run test:run patch-serializer

# Run tests with UI
npm run test:ui

# Generate coverage report
npm run coverage
```

## Test Infrastructure

### Configuration
- **vitest.config.ts**: Main test configuration
- **tests/setup.ts**: Global test setup (browser API mocks)
- **tests/__mocks__/**: Mock implementations for WASM and other modules

### Mocks
- **audio_processor.ts**: Mock WASM audio processor module for testing

## Test Files

### patch-serializer.test.ts (8 tests)
Tests for patch serialization/deserialization functionality.

**Coverage:**
- Audio asset ID creation and parsing
- Patch serialization round-trips (preserves data through save/load cycles)
- Voice count preservation across different polyphony settings (1, 2, 4, 8 voices)
- JSON export/import validation
- Convolver generator asset filtering:
  - Excludes binary data for procedurally-generated reverbs (hall/plate)
  - Includes binary data for custom uploaded impulse responses
  - Preserves generator parameters through serialization

**Why these tests matter:**
- Ensures patches maintain fidelity when saved and loaded
- Prevents voice count bugs that would make synths unexpectedly monophonic
- Validates the convolver optimization that reduces file sizes
- Catches serialization bugs before they corrupt user patches

### tracker-state.test.ts (12 tests)
Tests for tracker state management and synchronization.

**Coverage:**
- **Patch Assignment:**
  - Voice count preservation when assigning patches to slots
  - Deep copy isolation (modifications don't affect stored patches)
  - Slot metadata updates (patchId, patchName, bankName, source)
  - Orphaned patch cleanup when slots are reassigned
  - Shared patch retention when multiple slots reference same patch

- **Slot Management:**
  - Clearing slots and removing orphaned patches
  - Custom instrument naming
  - Patch updates through editing workflow

- **History and Undo:**
  - Undo patch assignments
  - Redo patch assignments
  - History stack integrity

- **Slot Initialization:**
  - Default slot creation (25 slots, numbered 1-25)
  - Slot number preservation through operations

**Why these tests matter:**
- Prevents voice count loss when loading patches in tracker
- Ensures patches don't corrupt when switched between slots
- Validates undo/redo works correctly for complex state
- Documents the 1-indexed slot numbering (prevents off-by-one bugs)
- Catches state synchronization issues between stores

### song-bank-normalization.test.ts (13 tests)
Tests for song bank patch normalization pipeline.

**Coverage:**
- **Voice Count Normalization:**
  - Preserves voice count through deserialize → normalize cycle
  - Handles empty voices array with voiceCount set
  - Generates voices from canonical when missing
  - Maintains voice count through multiple serialize/deserialize cycles

- **Canonical Voice Structure:**
  - Preserves canonical voice through normalization
  - Verifies all node arrays are present and correct
  - Tests voice generation from canonical template

- **Layout Transformations:**
  - SynthLayout → PatchLayout conversion (compact format)
  - PatchLayout → SynthLayout reconstruction (with voices)
  - Voice ID assignment correctness

- **Metadata Handling:**
  - Metadata pass-through behavior
  - Preservation of custom metadata fields

- **Convolver State:**
  - Generator parameter preservation
  - Handling convolvers without generators

- **Round-Trip Fidelity:**
  - Multiple cycle stability
  - Edge case voice counts (1, 2, 4, 8)

**Why these tests matter:**
- Catches voice count loss in the normalization pipeline (the bug we investigated!)
- Ensures SynthLayout ↔ PatchLayout conversion is lossless
- Documents the compact format (canonicalVoice + voiceCount, no redundant voices)
- Validates convolver generators survive normalization
- Prevents data corruption in the tracker's patch loading workflow

## Adding New Tests

1. Create a new test file in `tests/` directory with `.test.ts` extension
2. Import necessary functions from vitest:
   ```typescript
   import { describe, expect, it } from 'vitest';
   ```
3. Write your tests using the describe/it/expect pattern
4. Run tests to verify they work

### Best Practices

1. **Test real scenarios**: Focus on actual user workflows
2. **Use descriptive test names**: Make failures easy to understand
3. **Keep tests isolated**: Each test should be independent
4. **Mock external dependencies**: Use mocks for browser APIs, WASM, etc.
5. **Test edge cases**: Don't just test the happy path

### Example Test Structure

```typescript
describe('feature name', () => {
  it('does what it should do', () => {
    // Arrange: Set up test data
    const input = createTestData();

    // Act: Perform the operation
    const result = functionUnderTest(input);

    // Assert: Verify the result
    expect(result).toBe(expectedValue);
  });
});
```

## Future Test Coverage Needs

### High Priority
- [x] ~~Tracker state tests~~ (patch assignment, slot management, undo/redo) ✓
- [x] ~~Song bank normalization tests~~ (voice count, layout transformations, round-trips) ✓
- [ ] Macro routing tests (connection persistence, modulation amounts)
- [ ] Audio asset restoration tests (samples, wavetables, impulses)
- [ ] Layout-store synchronization (voice replication, node name preservation)

### Medium Priority
- [ ] WASM integration tests (message passing, state updates)
- [ ] Worklet message handling tests
- [ ] Envelope and LFO state tests
- [ ] Filter state preservation tests

### Low Priority (but still valuable)
- [ ] UI component tests (Vue Test Utils)
- [ ] Performance regression tests
- [ ] Memory leak detection tests

## Contributing

When fixing bugs:
1. Write a failing test that reproduces the bug
2. Fix the bug
3. Verify the test passes
4. Commit both the test and the fix

This ensures the bug doesn't reappear in the future.
