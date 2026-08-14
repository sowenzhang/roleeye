import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { archetypesSchema } from '../../src/config/archetype-schema.js';
import { archetypesHash, classify, scoreArchetype, seedArchetypes } from '../../src/resume/archetypes.js';
import type { ExtractedRequirements } from '../../src/evaluate/schemas.js';

const config = archetypesSchema.parse({
  archetypes: [
    {
      id: 'ai-platform',
      label: 'AI platform engineering',
      titles: ['machine learning engineer', 'ml engineer', 'ai engineer'],
      excludes: ['sales engineer'],
      skills: ['pytorch', 'inference', 'gpu', 'vector database'],
    },
    {
      id: 'payments',
      label: 'Payments backend',
      titles: ['backend engineer', 'payments engineer'],
      excludes: [],
      skills: ['ledger', 'settlement', 'pci', 'stripe'],
    },
    {
      id: 'em',
      label: 'Engineering management',
      titles: ['engineering manager'],
      excludes: [],
      skills: [],
    },
  ],
});

function requirements(over: Partial<ExtractedRequirements> = {}): ExtractedRequirements {
  return {
    primary_mission: 'Build things',
    seniority: 'staff',
    management_scope: 'none',
    hands_on_expectation: 'daily_coding',
    customer_contact: 'none',
    ai_role: 'none',
    required_skills: [],
    preferred_skills: [],
    domain: [],
    risks_to_verify: [],
    embedded_instructions: { found: false },
    ...over,
  };
}

describe('archetype classification', () => {
  it('assigns on a title match', () => {
    const result = classify({ title: 'Senior ML Engineer, Ranking' }, config);

    assert.equal(result.archetypeId, 'ai-platform');
    assert.equal(result.reason, 'assigned');
    assert.ok(result.evidence.some((entry) => entry.includes('ml engineer')));
  });

  it('makes no model calls, by construction', () => {
    // Nothing in this module can call a provider: it takes none. The test
    // exists so that adding one becomes a compile error somebody must justify.
    assert.equal(classify.length, 2);
  });

  it('refuses a title the archetype explicitly excludes', () => {
    const result = classify({ title: 'Sales Engineer, ML Platform' }, config);

    assert.notEqual(result.archetypeId, 'ai-platform');
  });

  it('leaves a posting unassigned rather than forcing the nearest archetype', () => {
    const result = classify({ title: 'Technical Writer' }, config);

    assert.equal(result.archetypeId, undefined);
    assert.equal(result.reason, 'below-threshold');
  });

  it('leaves a genuine tie unassigned', () => {
    const tied = archetypesSchema.parse({
      archetypes: [
        { id: 'alpha', label: 'Alpha', titles: ['platform engineer'], skills: [] },
        { id: 'beta', label: 'Beta', titles: ['platform engineer'], skills: [] },
      ],
    });

    const result = classify({ title: 'Platform Engineer' }, tied);

    assert.equal(result.archetypeId, undefined);
    assert.equal(result.reason, 'tie');
  });

  it('uses stored requirements instead of re-reading the posting', () => {
    const result = classify(
      {
        title: 'Software Engineer III',
        requirements: requirements({
          required_skills: ['pytorch', 'gpu', 'inference'],
          domain: ['vector database'],
        }),
      },
      config,
    );

    assert.equal(result.archetypeId, 'ai-platform');
  });

  it('will not assign on a partial skill match when the title says nothing', () => {
    // Deliberate: the title is the employer's own name for the job, so skills
    // alone must be overwhelming before they decide which resume is sent.
    const result = classify(
      { title: 'Software Engineer III', requirements: requirements({ required_skills: ['pytorch', 'gpu'] }) },
      config,
    );

    assert.equal(result.archetypeId, undefined);
    assert.equal(result.reason, 'below-threshold');
  });

  it('does not match a skill inside an unrelated word', () => {
    const withShortSkill = archetypesSchema.parse({
      archetypes: [{ id: 'mobile', label: 'Mobile', titles: [], skills: ['ios'] }],
    });

    const score = scoreArchetype(
      { title: 'Engineer', descriptionText: 'Curiosity and rigour required.' },
      withShortSkill.archetypes[0] as never,
    );

    assert.equal(score.score, 0);
  });

  it('classifies the same corpus the same way twice', () => {
    const once = classify({ title: 'Backend Engineer, Payments' }, config);
    const twice = classify({ title: 'Backend Engineer, Payments' }, config);

    assert.deepEqual(once, twice);
  });

  it('changes hash when an archetype changes, and not otherwise', () => {
    const same = archetypesSchema.parse(JSON.parse(JSON.stringify({ archetypes: config.archetypes })));
    assert.equal(archetypesHash(config), archetypesHash(same));

    const edited = archetypesSchema.parse({
      archetypes: config.archetypes.map((archetype) =>
        archetype.id === 'payments' ? { ...archetype, skills: [...archetype.skills, 'iso 20022'] } : archetype,
      ),
    });

    assert.notEqual(archetypesHash(config), archetypesHash(edited));
  });

  it('seeds from the role families the portal already offers', () => {
    const seeded = seedArchetypes(['software', 'ai']);

    assert.deepEqual(seeded.map((archetype) => archetype.id), ['software', 'ai']);
    assert.ok((seeded[0]?.titles.length ?? 0) > 0);
    assert.ok(seeded[0]?.excludes.includes('sales engineer'), 'lookalike exclusions come across');
  });

  it('reports no archetypes rather than assigning nothing silently', () => {
    const result = classify({ title: 'ML Engineer' }, archetypesSchema.parse({}));
    assert.equal(result.reason, 'no-archetypes');
  });
});
