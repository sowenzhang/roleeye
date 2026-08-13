import type { DiscoveredJob, SourceType } from '../core/types.js';
import type { SourceConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';

export interface HttpClient {
  getText(url: string, init?: RequestInit): Promise<string>;
  getJson<T>(url: string, init?: RequestInit): Promise<T>;
}

export interface AdapterContext {
  http: HttpClient;
  logger: Logger;
  signal?: AbortSignal | undefined;
}

/**
 * Contract every job source implements.
 *
 * Adapters fetch and shape data only. They never score, never deduplicate, and
 * never write to the database — the ingestion pipeline owns all of that.
 */
export interface JobSourceAdapter<TConfig extends SourceConfig = SourceConfig> {
  readonly name: SourceType;

  scan(config: TConfig, context: AdapterContext): Promise<DiscoveredJob[]>;
}
