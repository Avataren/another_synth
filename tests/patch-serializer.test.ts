import { describe, expect, it } from 'vitest';
import {
  createAudioAssetId,
  parseAudioAssetId,
} from '../src/audio/serialization/patch-serializer';

describe('patch-serializer audio asset helpers', () => {
  it('creates asset ids with string node ids', () => {
    const id = createAudioAssetId('sampler', '123e4567-e89b-12d3-a456-426614174000');
    expect(id).toBe('sampler_123e4567-e89b-12d3-a456-426614174000');
  });

  it('parses asset ids containing uuid strings', () => {
    const result = parseAudioAssetId('convolver_123e4567-e89b-12d3-a456-426614174000');
    expect(result).toEqual({
      nodeType: 'convolver',
      nodeId: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  it('returns null for malformed asset ids', () => {
    expect(parseAudioAssetId('invalid')).toBeNull();
    expect(parseAudioAssetId('type_')).toBeNull();
  });
});
