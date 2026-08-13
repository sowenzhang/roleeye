import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeCompanyName, companySlug } from '../../src/normalize/company.js';
import { extractLevel, isManagementTitle, normalizeTitle } from '../../src/normalize/title.js';
import { canonicalizeUrl, detectApplicationSystem, hostOf } from '../../src/normalize/url.js';
import { decodeHtmlEntities, htmlToText, normalizeWhitespace, tokenize } from '../../src/normalize/text.js';
import { detectCountry, detectWorkArrangement, normalizeLocation } from '../../src/normalize/location.js';
import { findSalaryInDescription, parseSalary, toAnnual } from '../../src/normalize/salary.js';
import { computeFingerprint, descriptionHash, resolveIdentity } from '../../src/normalize/identity.js';

describe('normalizeCompanyName', () => {
  it('strips legal suffixes and punctuation', () => {
    assert.equal(normalizeCompanyName('Zeta Global Corp.'), 'zeta global');
    assert.equal(normalizeCompanyName('Acme, Inc.'), 'acme');
    assert.equal(normalizeCompanyName('Foo Bar LLC'), 'foo bar');
    assert.equal(normalizeCompanyName('Widgets Co., Ltd.'), 'widgets');
  });

  it('is stable across casing and ampersands', () => {
    assert.equal(normalizeCompanyName('Johnson & Johnson'), normalizeCompanyName('johnson and johnson'));
  });

  it('never returns an empty key', () => {
    assert.equal(normalizeCompanyName('Inc'), 'inc');
  });

  it('produces a filesystem-safe slug', () => {
    assert.equal(companySlug('Zeta Global Corp.'), 'zeta-global');
  });
});

describe('normalizeTitle', () => {
  it('removes arrangement decorations that vary between postings', () => {
    assert.equal(
      normalizeTitle('Senior Software Engineer (Remote - US)'),
      normalizeTitle('Senior Software Engineer'),
    );
  });

  it('keeps meaningful words', () => {
    assert.equal(normalizeTitle('Staff Engineer, Payments'), 'staff engineer payments');
  });
});

describe('extractLevel', () => {
  it('prefers the most specific seniority signal', () => {
    assert.equal(extractLevel('Senior Staff Software Engineer'), 'senior-staff');
    assert.equal(extractLevel('Principal Engineer'), 'principal');
    assert.equal(extractLevel('Senior Engineering Manager, Loyalty'), 'senior-manager');
    assert.equal(extractLevel('Director of Engineering'), 'director');
  });

  it('returns undefined when no level is stated', () => {
    assert.equal(extractLevel('Software Engineer'), undefined);
  });

  it('identifies management titles', () => {
    assert.equal(isManagementTitle('Director of Engineering'), true);
    assert.equal(isManagementTitle('Principal Software Engineer'), false);
  });
});

describe('canonicalizeUrl', () => {
  it('drops tracking parameters and fragments', () => {
    assert.equal(
      canonicalizeUrl('https://boards.greenhouse.io/acme/jobs/123?gh_src=x&utm_source=li&foo=1#apply'),
      'https://boards.greenhouse.io/acme/jobs/123?foo=1',
    );
  });

  it('normalizes host, protocol, and trailing slash', () => {
    assert.equal(canonicalizeUrl('http://WWW.Example.com/careers/'), 'https://example.com/careers');
  });

  it('returns undefined for unusable input', () => {
    assert.equal(canonicalizeUrl('not a url'), undefined);
    assert.equal(canonicalizeUrl(undefined), undefined);
    assert.equal(canonicalizeUrl('mailto:jobs@example.com'), undefined);
  });

  it('resolves the host and application system', () => {
    assert.equal(hostOf('https://boards.greenhouse.io/acme/jobs/1'), 'boards.greenhouse.io');
    assert.equal(detectApplicationSystem('https://acme.wd1.myworkdayjobs.com/careers/job/1'), 'workday');
    assert.equal(detectApplicationSystem('https://jobs.lever.co/acme/1'), 'lever');
    assert.equal(detectApplicationSystem('https://example.com/jobs/1'), undefined);
  });
});

describe('html text handling', () => {
  it('decodes entities', () => {
    assert.equal(decodeHtmlEntities('&lt;p&gt;a &amp; b&#39;s&lt;/p&gt;'), "<p>a & b's</p>");
  });

  it('converts markup to readable text with list structure', () => {
    const text = htmlToText('<p>Intro</p><ul><li>One</li><li>Two</li></ul>');
    assert.match(text, /Intro/);
    assert.match(text, /• One/);
    assert.match(text, /• Two/);
    assert.ok(!text.includes('<'));
  });

  it('drops scripts and styles', () => {
    assert.equal(htmlToText('<script>evil()</script><p>Safe</p>'), 'Safe');
  });

  it('collapses whitespace without losing paragraphs', () => {
    assert.equal(normalizeWhitespace('a  b\n\n\n\nc  '), 'a b\n\nc');
  });

  it('tokenizes for fingerprinting', () => {
    assert.deepEqual(tokenize('C++ and Node.js!'), ['c++', 'and', 'node.js']);
  });

  it('trims trailing punctuation so small edits do not change fingerprints', () => {
    assert.deepEqual(tokenize('engineers.'), tokenize('engineers'));
    assert.deepEqual(tokenize('- item'), ['item']);
  });
});

describe('location normalization', () => {
  it('detects US locations from state abbreviations and names', () => {
    assert.equal(detectCountry('Seattle, WA'), 'US');
    assert.equal(detectCountry('Austin, Texas'), 'US');
    assert.equal(detectCountry('Berlin, Germany'), 'DE');
    assert.equal(detectCountry(''), undefined);
  });

  it('detects work arrangement from the location field first', () => {
    assert.equal(detectWorkArrangement('Seattle, WA (Hybrid)'), 'hybrid');
    assert.equal(detectWorkArrangement('Remote - United States'), 'remote');
    assert.equal(detectWorkArrangement('New York Office'), 'unknown');
  });

  it('falls back to the description', () => {
    assert.equal(detectWorkArrangement('New York', 'This is a fully remote position.'), 'remote');
  });

  it('returns a combined normalized location', () => {
    const result = normalizeLocation('  Seattle, WA (Hybrid)  ');
    assert.equal(result.text, 'Seattle, WA (Hybrid)');
    assert.equal(result.country, 'US');
    assert.equal(result.workArrangement, 'hybrid');
  });
});

describe('salary parsing', () => {
  it('parses explicit ranges', () => {
    const salary = parseSalary('The base salary range for this role is $220,000 - $265,000 per year.');
    assert.equal(salary?.min, 220_000);
    assert.equal(salary?.max, 265_000);
    assert.equal(salary?.currency, 'USD');
    assert.equal(salary?.period, 'year');
  });

  it('expands k suffixes', () => {
    const salary = parseSalary('$180k to $220k annually');
    assert.equal(salary?.min, 180_000);
    assert.equal(salary?.max, 220_000);
  });

  it('handles hourly rates', () => {
    const salary = parseSalary('$85 - $95 per hour');
    assert.equal(salary?.period, 'hour');
    assert.equal(toAnnual(85, 'hour'), 176_800);
  });

  it('ignores money that is not compensation', () => {
    // These are the exact patterns that corrupted real records.
    assert.equal(
      parseSalary('With a recent valuation of approximately $12.7B, Shield AI develops autonomous systems.'),
      undefined,
    );
    assert.equal(parseSalary('We raised $500M in our Series F round.'), undefined);
    assert.equal(parseSalary('Our customers manage $2.3 billion in annual revenue.'), undefined);
    assert.equal(parseSalary('You will own a $5M budget.'), undefined);
  });

  it('still reads a real pay statement in the same document', () => {
    const description = [
      'With a recent valuation of approximately $12.7B, we build autonomous systems.',
      'Founded in 2015, the team has grown to 800 people.',
      'The base salary range for this role is $190,000 - $240,000 per year.',
    ].join('\n');

    const salary = findSalaryInDescription(description);
    assert.equal(salary?.min, 190_000);
    assert.equal(salary?.max, 240_000);
    assert.equal(salary?.period, 'year');
  });

  it('returns undefined rather than guessing', () => {
    assert.equal(parseSalary('Competitive compensation and equity'), undefined);
    assert.equal(parseSalary(undefined), undefined);
  });

  it('ignores ordinary numbers in prose', () => {
    // Every one of these appeared in real postings and previously parsed as pay.
    assert.equal(parseSalary('Founded in 2015, we now serve 13 countries'), undefined);
    assert.equal(parseSalary('5 to 8 years of experience required'), undefined);
    assert.equal(parseSalary('You will lead a team of 10-15 engineers'), undefined);
    assert.equal(parseSalary('Our 2024 to 2026 roadmap'), undefined);
    assert.equal(parseSalary('Ranked 3 - 5 in the market'), undefined);
  });

  it('rejects implausible magnitudes', () => {
    assert.equal(parseSalary('salary of $3 - $9 per year'), undefined);
    assert.equal(parseSalary('$50,000,000 - $90,000,000 per year'), undefined);
  });

  it('still accepts real ranges without a currency symbol when pay is named', () => {
    const salary = parseSalary('The pay range for this role is 180,000 - 210,000 USD per year.');
    assert.equal(salary?.min, 180_000);
    assert.equal(salary?.max, 210_000);
  });

  it('accepts k-suffixed ranges without a symbol', () => {
    const salary = parseSalary('180k - 220k');
    assert.equal(salary?.min, 180_000);
  });

  it('does not read an unrelated line as compensation', () => {
    const description = [
      'Shield AI is a venture-backed defence technology company founded in 2015.',
      'Our international teammates receive a comprehensive total rewards package.',
      'You will work with 3 to 5 partner teams.',
    ].join('\n');

    assert.equal(findSalaryInDescription(description), undefined);
  });

  it('finds a range inside a long description', () => {
    const description = 'About us\n\nWe do things.\n\nCompensation\n\nBase pay: $200,000 — $240,000 per year.\n\nBenefits';
    const salary = findSalaryInDescription(description);
    assert.equal(salary?.min, 200_000);
    assert.equal(salary?.max, 240_000);
  });
});

describe('identity resolution', () => {
  const base = {
    sourceType: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    normalizedCompanyName: 'acme',
    normalizedTitle: 'staff engineer',
    locationText: 'Seattle, WA',
    descriptionText: 'Build things with a team of engineers.',
  };

  it('prefers the source job id', () => {
    const identity = resolveIdentity({ ...base, sourceJobId: '1', canonicalUrl: base.sourceUrl });
    assert.equal(identity.tier, 'source-id');
    assert.equal(identity.key, 'src:greenhouse:1');
  });

  it('falls back to the canonical url', () => {
    const identity = resolveIdentity({ ...base, canonicalUrl: base.sourceUrl });
    assert.equal(identity.tier, 'canonical-url');
    assert.equal(identity.key, `url:${base.sourceUrl}`);
  });

  it('falls back to a content fingerprint', () => {
    const identity = resolveIdentity({ ...base, sourceUrl: '' });
    assert.equal(identity.tier, 'fingerprint');
  });

  it('fingerprints ignore formatting but not content', () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, descriptionText: 'Build things,  with a team of engineers!' });
    const c = computeFingerprint({ ...base, descriptionText: 'Completely different responsibilities entirely.' });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('description hash changes with any content edit', () => {
    assert.notEqual(descriptionHash('a'), descriptionHash('a b'));
    assert.equal(descriptionHash(' a '), descriptionHash('a'));
  });
});
