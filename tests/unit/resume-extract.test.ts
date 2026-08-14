import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFacts } from '../../src/resume/extract.js';

/**
 * Extraction is where a resume becomes approvable statements. The tests are
 * written against the shapes real resumes use, including the ones that cannot
 * be parsed confidently — because the required behaviour there is to say so,
 * not to guess.
 */

const RESUME = `Jane Doe
jane@example.com | +1 555 123 4567

EXPERIENCE

Acme Corp — Staff Software Engineer (Jan 2019 – Present)
• Designed event-driven microservices supporting the rewards platform.
• Reduced p99 checkout latency by 43% across three regions.

Globex, Senior Engineer, 2015 - 2019
- Led the migration of the billing system to Kubernetes.
- Mentored four engineers through promotion.

SKILLS
• TypeScript, Go, PostgreSQL, Kafka, Terraform

EDUCATION
• BSc Computer Science, University of Somewhere, 2011
`;

describe('resume fact extraction', () => {
  it('reads bullets as statements and attaches them to the employer above', () => {
    const result = extractFacts(RESUME);

    assert.equal(result.experiences.length, 2);
    assert.deepEqual(
      result.experiences.map((entry) => [entry.company, entry.role]),
      [
        ['Acme Corp', 'Staff Software Engineer'],
        ['Globex', 'Senior Engineer'],
      ],
    );

    const acme = result.facts.filter((fact) => fact.experienceIndex === 0);
    assert.equal(acme.length, 2);
    assert.match(acme[0]?.statement ?? '', /^Designed event-driven microservices/);
  });

  it('keeps the employment dates it can read', () => {
    const [acme, globex] = extractFacts(RESUME).experiences;

    assert.equal(acme?.startedOn, 'Jan 2019');
    assert.equal(acme?.endedOn, 'Present');
    assert.equal(globex?.startedOn, '2015');
    assert.equal(globex?.endedOn, '2019');
  });

  it('tags statements from sections that are not employment', () => {
    const result = extractFacts(RESUME);
    const education = result.facts.find((fact) => fact.tags.includes('education'));

    assert.ok(education, 'a bullet under EDUCATION carries that tag');
    assert.equal(education.experienceIndex, undefined);
  });

  it('never turns contact details into a fact', () => {
    const result = extractFacts(RESUME);
    assert.ok(!result.facts.some((fact) => /example\.com|555/.test(fact.statement)));
  });

  it('joins a bullet that wrapped onto the next line', () => {
    const result = extractFacts(`Acme Corp — Staff Engineer (2019 – 2023)
• Designed an event-driven ingestion pipeline that replaced the nightly batch
  job and cut reporting delay from a day to five minutes.
`);

    assert.equal(result.facts.length, 1);
    assert.match(result.facts[0]?.statement ?? '', /five minutes\.$/);
  });

  it('reports rather than guesses when a heading cannot be split', () => {
    const result = extractFacts(`Northwind Trading Systems 2019 – 2023
• Rebuilt the settlement pipeline end to end.
`);

    assert.equal(result.experiences.length, 1);
    assert.equal(result.experiences[0]?.role, '(unstated)');
    assert.ok(
      result.warnings.some((warning) => /could not be split/.test(warning)),
      'the ambiguity is surfaced, not silently resolved',
    );
  });

  it('says so when a document has no bullets at all', () => {
    const result = extractFacts(`Jane Doe

A results-driven engineering leader with a passion for scalable systems and a
track record of delivering value across the organisation.
`);

    assert.equal(result.facts.length, 0);
    assert.ok(result.warnings.some((warning) => /no bulleted statements/.test(warning)));
  });

  it('does not invent statements from prose', () => {
    // The summary paragraph is exactly the kind of sentence that should never
    // become an approvable claim about the candidate.
    const result = extractFacts(`SUMMARY

Seasoned technologist with 15 years of experience driving transformative
outcomes for Fortune 500 clients.

EXPERIENCE

Acme Corp — Staff Engineer (2019 – 2023)
• Owned the payments ledger service.
`);

    assert.equal(result.facts.length, 1);
    assert.match(result.facts[0]?.statement ?? '', /payments ledger/);
  });

  it('ignores fragments too short to be a claim', () => {
    const result = extractFacts(`Acme Corp — Staff Engineer (2019 – 2023)
• Go, Rust
• Owned the payments ledger service end to end.
`);

    assert.equal(result.facts.length, 1);
  });
});
