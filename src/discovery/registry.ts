import type { SourceConfig } from '../config/schema.js';
import type { SourceType } from '../core/types.js';
import { GreenhouseAdapter } from './greenhouse.js';
import { LeverAdapter } from './lever.js';
import { AshbyAdapter } from './ashby.js';
import { CareerPageAdapter } from './career-page.js';
import type { JobSourceAdapter } from './source-adapter.js';

/**
 * Adapter registry. New source types register here without touching the
 * ingestion pipeline.
 */
const adapters = new Map<SourceType, JobSourceAdapter<never>>();

export function registerAdapter<T extends SourceConfig>(adapter: JobSourceAdapter<T>): void {
  adapters.set(adapter.name, adapter as unknown as JobSourceAdapter<never>);
}

export function getAdapter(type: SourceType): JobSourceAdapter<never> | undefined {
  return adapters.get(type);
}

export function registeredAdapterNames(): SourceType[] {
  return [...adapters.keys()];
}

registerAdapter(new GreenhouseAdapter());
registerAdapter(new LeverAdapter());
registerAdapter(new AshbyAdapter());
registerAdapter(new CareerPageAdapter());
