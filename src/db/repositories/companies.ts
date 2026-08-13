import type { Company } from '../../core/types.js';
import { deriveCompanyId } from '../../util/hash.js';
import { nowIso } from '../../util/time.js';
import { normalizeCompanyName } from '../../normalize/company.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

interface CompanyRow {
  id: string;
  name: string;
  normalized_name: string;
  domain: string | null;
  careers_url: string | null;
  notes: string | null;
  created_at: string;
}

function mapRow(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    domain: fromDb(row.domain),
    careersUrl: fromDb(row.careers_url),
    notes: fromDb(row.notes),
    createdAt: row.created_at,
  };
}

export class CompanyRepository {
  constructor(private readonly db: Database) {}

  findByNormalizedName(normalizedName: string): Company | undefined {
    const row = this.db
      .prepare('SELECT * FROM companies WHERE normalized_name = ?')
      .get(normalizedName) as CompanyRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findById(id: string): Company | undefined {
    const row = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Canonicalizes a display name to one company row. Never merges by fuzzy match. */
  upsertByName(name: string, extra?: { domain?: string | undefined; careersUrl?: string | undefined }): Company {
    const normalizedName = normalizeCompanyName(name);
    const existing = this.findByNormalizedName(normalizedName);

    if (existing) {
      if (extra?.domain && !existing.domain) {
        this.db.prepare('UPDATE companies SET domain = ? WHERE id = ?').run(extra.domain, existing.id);
      }
      if (extra?.careersUrl && !existing.careersUrl) {
        this.db.prepare('UPDATE companies SET careers_url = ? WHERE id = ?').run(extra.careersUrl, existing.id);
      }
      return this.findById(existing.id) ?? existing;
    }

    const company: Company = {
      id: deriveCompanyId(normalizedName),
      name: name.trim(),
      normalizedName,
      domain: extra?.domain,
      careersUrl: extra?.careersUrl,
      notes: undefined,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO companies (id, name, normalized_name, domain, careers_url, notes, created_at)
         VALUES (@id, @name, @normalized_name, @domain, @careers_url, @notes, @created_at)`,
      )
      .run({
        id: company.id,
        name: company.name,
        normalized_name: company.normalizedName,
        domain: toDb(company.domain),
        careers_url: toDb(company.careersUrl),
        notes: toDb(company.notes),
        created_at: company.createdAt,
      });

    return company;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number };
    return row.n;
  }
}
