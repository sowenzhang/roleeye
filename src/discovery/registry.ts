import type { SourceConfig } from '../config/schema.js';
import type { SourceType } from '../core/types.js';
import { GreenhouseAdapter } from './greenhouse.js';
import type { JobSourceAdapter } from './source-adapter.js';

/**
 * Adapter registry. Later phases register lever/ashby/career-page here without
 * touching the ingestion pipeline.
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
