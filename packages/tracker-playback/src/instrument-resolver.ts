import type { InstrumentResolver } from './types';

/**
 * Default no-op resolver. Consumers can supply their own resolver to
 * connect tracker instruments to their synth engine.
 */
export const noopInstrumentResolver: InstrumentResolver = () => {};
