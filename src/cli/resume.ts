import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { writeFileSync, existsSync } from 'node:fs';
import { ExitCode, NotFoundError, UsageError, type ExitCodeValue } from '../util/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import { createProvider } from '../reasoning/registry.js';
import { ROLE_FAMILIES } from '../portal/presets.js';
import { archetypesHash, findArchetype, seedArchetypes } from '../resume/archetypes.js';
import { assignArchetypes } from '../resume/assign.js';
import { buildDelta } from '../resume/delta.js';
import { diffGenerations, renderDiff } from '../resume/diff.js';
import { exportFacts, importDocument } from '../resume/import.js';
import { generationInputs, isStale, ResumeGenerator } from '../resume/generator.js';
import { truncate } from '../normalize/text.js';
import { flagBool, flagList, flagNumber, flagString } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * The resume command.
 *
 * Ordered as the work is actually done: import a document, approve what it
 * found, describe the kinds of role being pursued, then generate one resume for
 * each of them. The steps are separate commands rather than one because
 * approval is the point at which a human is required, and a step that runs
 * automatically is a step nobody performs.
 */

function resolveJob(repos: Repositories, reference: string): JobRecord {
  const exact = repos.jobs.findById(reference);
  if (exact) return exact;

  const matches = repos.jobs.findByIdPrefix(reference.startsWith('job_') ? reference : `job_${reference}`);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new UsageError(`job id "${reference}" is ambiguous`);

  throw new NotFoundError(`no job found for "${reference}"`);
}

const SUBCOMMANDS = [
  'import',
  'facts',
  'experiences',
  'approve',
  'add-fact',
  'retire',
  'export-facts',
  'archetypes',
  'classify',
  'assign',
  'generate',
  'show',
  'diff',
  'delta',
  'status',
] as const;

export const resumeCommand: Command = {
  name: 'resume',
  summary: 'Fact store, role archetypes, and tailored resumes',
  usage: `roleeye resume <${SUBCOMMANDS.join('|')}> [options]`,

  async run(context: CommandContext): Promise<ExitCodeValue> {
    const subcommand = context.args.positionals[0];

    if (!subcommand || !SUBCOMMANDS.includes(subcommand as (typeof SUBCOMMANDS)[number])) {
      throw new UsageError(`unknown subcommand "${subcommand ?? '(none)'}". Usage: ${resumeCommand.usage}`);
    }

    switch (subcommand) {
      case 'import':
        return runImport(context);
      case 'facts':
        return listFacts(context);
      case 'experiences':
        return listExperiences(context);
      case 'approve':
        return approve(context);
      case 'add-fact':
        return addFact(context);
      case 'retire':
        return retire(context);
      case 'export-facts':
        return runExport(context);
      case 'archetypes':
        return listArchetypes(context);
      case 'classify':
        return classifyJobs(context);
      case 'assign':
        return assignOne(context);
      case 'generate':
        return generate(context);
      case 'show':
        return show(context);
      case 'diff':
        return diff(context);
      case 'delta':
        return delta(context);
      default:
        return status(context);
    }
  },
};

async function runImport(context: CommandContext): Promise<ExitCodeValue> {
  const file = context.args.positionals[1];
  if (!file) throw new UsageError('usage: roleeye resume import <file.docx|file.pdf|file.md|accomplishments.yaml>');

  const { repos } = context.openDb();
  const summary = await importDocument({ repos, logger: context.logger, file });

  if (context.json) {
    printJson(context, summary);
    return ExitCode.Ok;
  }

  printLine(context, `Imported ${path.basename(summary.sourcePath)} (${summary.format})`);
  printLine(context);
  printLine(context, `  ${summary.created} new draft fact(s), ${summary.updated} updated, ${summary.unchanged} unchanged`);
  printLine(context, `  ${summary.experiences} experience block(s)`);

  for (const warning of summary.warnings) printLine(context, `  ! ${warning}`);

  printLine(context);
  printLine(context, '  Nothing imported can be used yet. Review with `roleeye resume facts`,');
  printLine(context, '  then approve with `roleeye resume approve --experience <slug>`.');

  return summary.created + summary.updated === 0 ? ExitCode.CompletedWithWarnings : ExitCode.Ok;
}

function listFacts(context: CommandContext): ExitCodeValue {
  const { repos } = context.openDb();
  const status = flagString(context.args, 'status');

  if (status && status !== 'draft' && status !== 'approved') {
    throw new UsageError('--status must be "draft" or "approved"');
  }

  const experienceSlug = flagString(context.args, 'experience');
  const experience = experienceSlug ? repos.facts.findExperienceBySlug(experienceSlug) : undefined;

  if (experienceSlug && !experience) throw new NotFoundError(`no experience with slug "${experienceSlug}"`);

  const facts = repos.facts.list({
    ...(status ? { status: status as 'draft' | 'approved' } : {}),
    ...(experience ? { experienceId: experience.id } : {}),
  });

  if (context.json) {
    printJson(context, { count: facts.length, facts });
    return ExitCode.Ok;
  }

  const counts = repos.facts.counts();
  printLine(context, `Facts — ${counts.draft} draft, ${counts.approved} approved, ${counts.retired} retired`);
  printLine(context);

  if (facts.length === 0) {
    printLine(context, '  Nothing yet. Import a resume with `roleeye resume import <file>`.');
    return ExitCode.Ok;
  }

  const experiences = new Map(repos.facts.listExperiences().map((entry) => [entry.id, entry]));

  for (const fact of facts) {
    const where = fact.experienceId ? experiences.get(fact.experienceId)?.company ?? '' : '(unattached)';
    printLine(context, `  ${fact.status === 'approved' ? '✓' : ' '} ${fact.id}  ${truncate(where, 16).padEnd(16)} ${truncate(fact.statement, 88)}`);
  }

  return ExitCode.Ok;
}

function listExperiences(context: CommandContext): ExitCodeValue {
  const { repos } = context.openDb();
  const experiences = repos.facts.listExperiences();

  if (context.json) {
    printJson(context, experiences);
    return ExitCode.Ok;
  }

  if (experiences.length === 0) {
    printLine(context, 'No experience blocks yet. Import a resume with `roleeye resume import <file>`.');
    return ExitCode.Ok;
  }

  printLine(context, 'Experiences');
  printLine(context);

  for (const experience of experiences) {
    const facts = repos.facts.list({ experienceId: experience.id });
    const approved = facts.filter((fact) => fact.status === 'approved').length;
    const dates = [experience.startedOn, experience.endedOn].filter(Boolean).join(' – ');
    printLine(context, `  ${experience.slug}`);
    printLine(context, `    ${experience.role}, ${experience.company}${dates ? ` (${dates})` : ''}`);
    printLine(context, `    ${approved}/${facts.length} facts approved`);
  }

  return ExitCode.Ok;
}

function approve(context: CommandContext): ExitCodeValue {
  const { repos } = context.openDb();
  const ids = context.args.positionals.slice(1);
  const experienceSlug = flagString(context.args, 'experience');
  const all = flagBool(context.args, 'all');

  let approved = 0;

  if (experienceSlug) {
    const experience = repos.facts.findExperienceBySlug(experienceSlug);
    if (!experience) throw new NotFoundError(`no experience with slug "${experienceSlug}"`);
    approved = repos.facts.approveExperience(experience.id);
  } else if (all) {
    approved = repos.facts.approve(repos.facts.list({ status: 'draft' }).map((fact) => fact.id));
  } else if (ids.length > 0) {
    approved = repos.facts.approve(ids);
  } else {
    throw new UsageError('usage: roleeye resume approve <fact-id...> | --experience <slug> | --all');
  }

  if (context.json) {
    printJson(context, { justApproved: approved, counts: repos.facts.counts() });
    return ExitCode.Ok;
  }

  const counts = repos.facts.counts();
  printLine(context, `Approved ${approved} fact(s). ${counts.approved} approved, ${counts.draft} still draft.`);

  if (approved === 0) {
    printLine(context, 'Nothing changed: those facts were already approved, retired, or unknown.');
    return ExitCode.CompletedWithWarnings;
  }

  return ExitCode.Ok;
}

function addFact(context: CommandContext): ExitCodeValue {
  const statement = context.args.positionals.slice(1).join(' ');
  if (statement.trim().length < 10) {
    throw new UsageError('usage: roleeye resume add-fact "<statement>" [--tags a,b] [--experience <slug>] [--approve]');
  }

  const { repos } = context.openDb();
  const experienceSlug = flagString(context.args, 'experience');
  const experience = experienceSlug ? repos.facts.findExperienceBySlug(experienceSlug) : undefined;

  if (experienceSlug && !experience) throw new NotFoundError(`no experience with slug "${experienceSlug}"`);

  const { fact, outcome } = repos.facts.upsert({
    statement,
    tags: flagList(context.args, 'tags') ?? [],
    experienceId: experience?.id,
    origin: 'manual',
  });

  // A fact the user typed themselves is still a draft by default. The rule is
  // that a human approves what gets used, and "I typed it" is not that step —
  // but --approve makes it one action for someone doing both.
  if (flagBool(context.args, 'approve')) repos.facts.approve([fact.id]);

  if (context.json) {
    printJson(context, { outcome, fact: repos.facts.get(fact.id) });
    return ExitCode.Ok;
  }

  printLine(context, `${outcome === 'created' ? 'Added' : 'Reconciled'} ${fact.id}`);
  printLine(context, `  ${fact.statement}`);
  printLine(context, `  status: ${repos.facts.get(fact.id)?.status ?? 'draft'}`);

  return ExitCode.Ok;
}

function retire(context: CommandContext): ExitCodeValue {
  const id = context.args.positionals[1];
  if (!id) throw new UsageError('usage: roleeye resume retire <fact-id>');

  const { repos } = context.openDb();
  const fact = repos.facts.get(id);
  if (!fact) throw new NotFoundError(`no fact "${id}"`);

  repos.facts.retire(id);
  printLine(context, `Retired ${id}. Generated resumes that cite it are now stale.`);

  return ExitCode.Ok;
}

function runExport(context: CommandContext): ExitCodeValue {
  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();
  const file = context.args.positionals[1] ?? path.join(config.env.paths.profileDir, 'accomplishments.yaml');

  const result = exportFacts(repos, file);

  if (context.json) {
    printJson(context, { file, ...result });
    return ExitCode.Ok;
  }

  printLine(context, `Wrote ${result.facts} fact(s) across ${result.experiences} experience(s) to ${file}`);
  printLine(context, 'The database remains the store: re-importing this file creates drafts.');

  return ExitCode.Ok;
}

function listArchetypes(context: CommandContext): ExitCodeValue {
  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();
  const seed = flagList(context.args, 'seed');

  if (seed) {
    const file = path.join(config.env.paths.configDir, 'archetypes.yaml');
    if (existsSync(file) && !flagBool(context.args, 'force')) {
      throw new UsageError(`${file} already exists. Pass --force to overwrite it.`);
    }

    const seeded = seedArchetypes(seed);
    if (seeded.length === 0) {
      throw new UsageError(
        `no role family matched ${seed.map((entry) => `"${entry}"`).join(', ')}. Available: ${ROLE_FAMILIES.map((family) => family.id).join(', ')}`,
      );
    }

    writeFileSync(
      file,
      `# Role archetypes: one tailored resume each.\n# Seeded from role families; edit freely.\n${stringifyYaml({ archetypes: seeded })}`,
      'utf8',
    );

    printLine(context, `Wrote ${seeded.length} archetype(s) to ${file}`);
    printLine(context, 'Add skills and a focus line to each, then run `roleeye resume generate <id>`.');
    return ExitCode.Ok;
  }

  const hash = archetypesHash(config.archetypes);
  const counts = new Map(repos.assignments.countsByArchetype(hash).map((entry) => [entry.archetypeId, entry.count]));

  if (context.json) {
    printJson(context, {
      hash,
      archetypes: config.archetypes.archetypes.map((archetype) => ({
        ...archetype,
        assigned: counts.get(archetype.id) ?? 0,
        generated: repos.resumes.current(archetype.id) !== undefined,
      })),
      unassigned: counts.get('(unassigned)') ?? 0,
    });
    return ExitCode.Ok;
  }

  if (config.archetypes.archetypes.length === 0) {
    printLine(context, 'No archetypes defined.');
    printLine(context);
    printLine(context, '  Create some with, for example:');
    printLine(context, '    roleeye resume archetypes --seed software,ai,infra');
    return ExitCode.Ok;
  }

  printLine(context, 'Archetypes');
  printLine(context);

  for (const archetype of config.archetypes.archetypes) {
    const generation = repos.resumes.current(archetype.id);
    const state = generation
      ? isStale(generation, generationInputs(config, repos, archetype.id))
        ? 'resume stale'
        : `resume current (${generation.createdAt.slice(0, 10)})`
      : 'no resume yet';

    printLine(context, `  ${archetype.id.padEnd(14)} ${truncate(archetype.label, 30).padEnd(30)} ${String(counts.get(archetype.id) ?? 0).padStart(4)} roles   ${state}`);
  }

  const unassigned = counts.get('(unassigned)') ?? 0;
  if (unassigned > 0) {
    printLine(context);
    printLine(context, `  ${unassigned} role(s) match no archetype. That usually means one is missing.`);
  }

  return ExitCode.Ok;
}

function classifyJobs(context: CommandContext): ExitCodeValue {
  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();

  if (config.archetypes.archetypes.length === 0) {
    throw new UsageError('no archetypes defined. Run `roleeye resume archetypes --seed <families>` first.');
  }

  const jobs = repos.jobs.list({ limit: flagNumber(context.args, 'limit') ?? 1000, inScope: true });
  const summary = assignArchetypes(repos, config.archetypes, jobs, {
    logger: context.logger,
    force: flagBool(context.args, 'force'),
  });

  if (context.json) {
    printJson(context, summary);
    return ExitCode.Ok;
  }

  printLine(context, `Classified ${summary.considered} role(s) with ${summary.modelCalls} model calls.`);
  printLine(context);
  printLine(context, `  ${summary.assigned} assigned, ${summary.unassigned} unassigned, ${summary.keptManual} manual kept`);

  for (const entry of summary.byArchetype) {
    printLine(context, `    ${entry.archetypeId.padEnd(16)} ${entry.count}`);
  }

  return ExitCode.Ok;
}

function assignOne(context: CommandContext): ExitCodeValue {
  const [, reference, archetypeId] = context.args.positionals;
  if (!reference || !archetypeId) throw new UsageError('usage: roleeye resume assign <job-id> <archetype-id>');

  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();

  if (!findArchetype(config.archetypes, archetypeId)) {
    throw new UsageError(`no archetype "${archetypeId}" in config/archetypes.yaml`);
  }

  const job = resolveJob(repos, reference);

  repos.assignments.save({
    jobId: job.id,
    archetypeId,
    archetypeHash: archetypesHash(config.archetypes),
    score: 1,
    runnerUpId: undefined,
    runnerUpScore: undefined,
    method: 'manual',
    evidence: ['assigned by hand'],
  });

  printLine(context, `${job.id} (${job.title}) assigned to "${archetypeId}".`);
  printLine(context, 'Manual assignments survive re-classification.');

  return ExitCode.Ok;
}

async function generate(context: CommandContext): Promise<ExitCodeValue> {
  const archetypeId = context.args.positionals[1];
  if (!archetypeId) throw new UsageError('usage: roleeye resume generate <archetype-id> [--force] [--dry-run]');

  const config = context.loadConfig();
  const { repos } = context.openDb();
  const dryRun = flagBool(context.args, 'dry-run');

  const generator = new ResumeGenerator({
    config,
    repos,
    provider: dryRun ? undefined : createProvider({ config: config.criteria.reasoning, logger: context.logger }),
    logger: context.logger,
  });

  if (dryRun) {
    const described = generator.describe(archetypeId);

    if (context.json) {
      printJson(context, described);
      return ExitCode.Ok;
    }

    printLine(context, `Dry run — ${archetypeId}`);
    printLine(context);
    printLine(context, `  ${described.facts} approved fact(s) would be sent, about ${described.estimatedTokens} tokens.`);
    printLine(context, '  Nothing was sent.');
    printLine(context);
    printLine(context, described.system);
    printLine(context);
    printLine(context, described.prompt);
    return ExitCode.Ok;
  }

  const result = await generator.generate(archetypeId, { force: flagBool(context.args, 'force') });

  if (context.json) {
    printJson(context, {
      outcome: result.outcome,
      generationId: result.generation.id,
      validated: result.generation.validated,
      dropped: result.dropped.map((claim) => ({ text: claim.text, problems: claim.problems })),
      artifacts: result.artifacts,
      costUsd: result.costUsd,
    });
    return ExitCode.Ok;
  }

  if (result.outcome === 'current') {
    printLine(context, `The resume for "${archetypeId}" is already current. Nothing was regenerated.`);
    printLine(context, 'Pass --force to regenerate anyway.');
    return ExitCode.Ok;
  }

  printLine(context, `Generated the resume for "${archetypeId}".`);
  printLine(context);
  for (const file of result.artifacts) printLine(context, `  ${file}`);

  if (result.dropped.length > 0) {
    printLine(context);
    printLine(context, `  ${result.dropped.length} claim(s) were dropped because the approved facts do not support them:`);
    for (const claim of result.dropped.slice(0, 5)) {
      printLine(context, `    "${truncate(claim.text, 70)}"`);
      for (const problem of claim.problems.slice(0, 2)) {
        printLine(context, `      ${problem.code}: ${problem.detail}`);
      }
    }
    return ExitCode.CompletedWithWarnings;
  }

  return ExitCode.Ok;
}

function show(context: CommandContext): ExitCodeValue {
  const archetypeId = context.args.positionals[1];
  if (!archetypeId) throw new UsageError('usage: roleeye resume show <archetype-id>');

  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();
  const generation = repos.resumes.current(archetypeId);

  if (!generation) throw new NotFoundError(`no resume generated for "${archetypeId}"`);

  const claims = repos.resumes.claims(generation.id);
  const stale = isStale(generation, generationInputs(config, repos, archetypeId));

  if (context.json) {
    printJson(context, { generation, claims, stale });
    return ExitCode.Ok;
  }

  printLine(context, `${generation.headline ?? archetypeId} — generation ${generation.id}`);
  printLine(context, `  ${generation.provider} · ${generation.model} · ${generation.createdAt}`);
  printLine(context, `  ${stale ? 'STALE: an input changed since this was generated' : 'current'}`);
  printLine(context);

  const experiences = new Map(repos.facts.listExperiences().map((entry) => [entry.id, entry]));
  const label = (section: string): string => {
    const experience = experiences.get(section);
    return experience ? `${experience.company} — ${experience.role}` : section;
  };

  for (const claim of claims) {
    const mark = claim.supported ? '-' : 'x';
    printLine(context, `  ${mark} [${truncate(label(claim.section), 34)}] ${truncate(claim.text, 80)}`);
    if (!claim.supported) for (const problem of claim.problems) printLine(context, `      ${problem}`);
  }

  return ExitCode.Ok;
}

function diff(context: CommandContext): ExitCodeValue {
  const archetypeId = context.args.positionals[1];
  if (!archetypeId) throw new UsageError('usage: roleeye resume diff <archetype-id>');

  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();
  const history = repos.resumes.history(archetypeId, 2);
  const [current, previous] = history;

  if (!current) throw new NotFoundError(`no resume generated for "${archetypeId}"`);
  if (!previous) {
    printLine(context, `Only one generation exists for "${archetypeId}"; there is nothing to compare it with.`);
    return ExitCode.Ok;
  }

  const result = diffGenerations(
    { generation: previous, claims: repos.resumes.claims(previous.id).filter((claim) => claim.supported) },
    { generation: current, claims: repos.resumes.claims(current.id).filter((claim) => claim.supported) },
  );

  const statements = new Map(repos.facts.list({}).map((fact) => [fact.id, fact.statement]));
  const experiences = new Map(repos.facts.listExperiences().map((entry) => [entry.id, entry]));
  const rendered = renderDiff(
    result,
    (id) => statements.get(id),
    (section) => {
      const experience = experiences.get(section);
      return experience ? `${experience.company} — ${experience.role}` : section;
    },
  );

  if (context.json) {
    printJson(context, {
      added: result.added.length,
      removed: result.removed.length,
      reordered: result.reordered.length,
      unchanged: result.unchanged,
    });
    return ExitCode.Ok;
  }

  const file = path.join(config.env.paths.artifactsDir, 'archetypes', archetypeId, 'resume-diff.md');
  writeFileSync(file, rendered, 'utf8');

  printLine(context, rendered);
  printLine(context, `Written to ${file}`);

  return ExitCode.Ok;
}

async function delta(context: CommandContext): Promise<ExitCodeValue> {
  const reference = context.args.positionals[1];
  if (!reference) throw new UsageError('usage: roleeye resume delta <job-id> [--force]');

  const config = context.loadConfig();
  const { repos } = context.openDb();
  const job = resolveJob(repos, reference);

  const result = await buildDelta({
    config,
    repos,
    provider: createProvider({ config: config.criteria.reasoning, logger: context.logger }),
    logger: context.logger,
    job,
    force: flagBool(context.args, 'force'),
  });

  if (context.json) {
    printJson(context, {
      jobId: result.jobId,
      archetypeId: result.archetypeId,
      headline: result.headline,
      claims: result.orderedClaims.length,
      noteSupported: result.coverNote?.supported ?? false,
      artifacts: result.artifacts,
      costUsd: result.costUsd,
    });
    return ExitCode.Ok;
  }

  printLine(context, `Delta for ${job.companyName} — ${job.title}`);
  printLine(context);
  printLine(context, `  archetype: ${result.archetypeId}`);
  printLine(context, `  headline:  ${result.headline}`);
  printLine(context, `  bullets:   ${result.orderedClaims.length} reordered for this role`);
  printLine(context, `  note:      ${result.coverNote?.supported ? 'written' : 'not written'}`);
  printLine(context);
  for (const file of result.artifacts) printLine(context, `  ${file}`);

  return result.coverNote?.supported === false ? ExitCode.CompletedWithWarnings : ExitCode.Ok;
}

function status(context: CommandContext): ExitCodeValue {
  const config = context.loadConfig({ allowDefaults: true });
  const { repos } = context.openDb();
  const counts = repos.facts.counts();
  const hash = archetypesHash(config.archetypes);
  const assignments = repos.assignments.countsByArchetype(hash);

  const archetypes = config.archetypes.archetypes.map((archetype) => {
    const generation = repos.resumes.current(archetype.id);
    return {
      id: archetype.id,
      generated: generation !== undefined,
      stale: generation ? isStale(generation, generationInputs(config, repos, archetype.id)) : false,
      assigned: assignments.find((entry) => entry.archetypeId === archetype.id)?.count ?? 0,
    };
  });

  if (context.json) {
    printJson(context, { facts: counts, archetypes, imports: repos.facts.listImports(5) });
    return ExitCode.Ok;
  }

  printLine(context, 'Resume pipeline');
  printLine(context);
  printLine(context, `  facts:      ${counts.approved} approved, ${counts.draft} draft`);
  printLine(context, `  archetypes: ${archetypes.length} defined, ${archetypes.filter((entry) => entry.generated).length} with a resume`);

  const stale = archetypes.filter((entry) => entry.stale);
  if (stale.length > 0) {
    printLine(context, `  stale:      ${stale.map((entry) => entry.id).join(', ')} — regenerate with \`roleeye resume generate <id>\``);
  }

  if (counts.approved === 0) {
    printLine(context);
    printLine(context, '  Start with `roleeye resume import <your-resume.docx>`.');
  }

  return ExitCode.Ok;
}
