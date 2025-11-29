# Test Suite

This directory contains automated tests for the synthesizer codebase.

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

### patch-serializer.test.ts
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
- [ ] State synchronization tests (layout-store, node-state-store interaction)
- [ ] Tracker song bank tests (instrument loading, patch assignment)
- [ ] Macro routing tests (connection persistence, modulation amounts)
- [ ] Audio asset restoration tests (samples, wavetables, impulses)

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
