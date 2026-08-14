import type { ResumeClaim, ResumeGeneration } from '../db/repositories/resumes.js';

/**
 * Comparing two generations of the same archetype resume.
 *
 * The point is reviewability: the user approved the previous document, so what
 * they need to see is exactly what changed, not a new document to read from the
 * top. Comparison is on claim text within a section, because a bullet that
 * merely moved is not a change to what is being said.
 */

export interface ResumeDiff {
  from: ResumeGeneration;
  to: ResumeGeneration;
  added: ResumeClaim[];
  removed: ResumeClaim[];
  reordered: { section: string; text: string; fromPosition: number; toPosition: number }[];
  unchanged: number;
}

function key(claim: ResumeClaim): string {
  return `${claim.section}\u0000${claim.text.trim().toLowerCase()}`;
}

export function diffGenerations(
  from: { generation: ResumeGeneration; claims: ResumeClaim[] },
  to: { generation: ResumeGeneration; claims: ResumeClaim[] },
): ResumeDiff {
  const before = new Map(from.claims.map((claim) => [key(claim), claim]));
  const after = new Map(to.claims.map((claim) => [key(claim), claim]));

  const added = to.claims.filter((claim) => !before.has(key(claim)));
  const removed = from.claims.filter((claim) => !after.has(key(claim)));

  const reordered = to.claims
    .map((claim) => {
      const previous = before.get(key(claim));
      if (!previous || previous.position === claim.position) return undefined;
      return {
        section: claim.section,
        text: claim.text,
        fromPosition: previous.position,
        toPosition: claim.position,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return {
    from: from.generation,
    to: to.generation,
    added,
    removed,
    reordered,
    unchanged: to.claims.length - added.length - reordered.length,
  };
}

export function renderDiff(diff: ResumeDiff, statementOf: (factId: string) => string | undefined, sectionLabel: (section: string) => string = (section) => section): string {
  const lines: string[] = [
    `# Resume changes — ${diff.to.archetypeId}`,
    '',
    `From generation ${diff.from.id} (${diff.from.createdAt})`,
    `To generation ${diff.to.id} (${diff.to.createdAt})`,
    '',
  ];

  const reason: string[] = [];
  if (diff.from.factSetHash !== diff.to.factSetHash) reason.push('the approved fact set changed');
  if (diff.from.archetypeHash !== diff.to.archetypeHash) reason.push('the archetype definition changed');
  if (diff.from.profileHash !== diff.to.profileHash) reason.push('the career profile changed');
  if (diff.from.model !== diff.to.model) reason.push(`the model changed (${diff.from.model} → ${diff.to.model})`);

  lines.push(`Regenerated because ${reason.length > 0 ? reason.join(', ') : 'it was requested'}.`, '');

  if (diff.added.length > 0) {
    lines.push(`## Added (${diff.added.length})`, '');
    for (const claim of diff.added) {
      lines.push(`- **${sectionLabel(claim.section)}**: ${claim.text}`);
      for (const id of claim.factIds) lines.push(`  - from \`${id}\`: ${statementOf(id) ?? '(fact not found)'}`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push(`## Removed (${diff.removed.length})`, '');
    for (const claim of diff.removed) lines.push(`- **${sectionLabel(claim.section)}**: ${claim.text}`);
    lines.push('');
  }

  if (diff.reordered.length > 0) {
    lines.push(`## Reordered (${diff.reordered.length})`, '');
    for (const entry of diff.reordered) {
      lines.push(`- **${sectionLabel(entry.section)}**: ${entry.text} (${entry.fromPosition} → ${entry.toPosition})`);
    }
    lines.push('');
  }

  lines.push(`${diff.unchanged} claim(s) unchanged.`, '');

  return `${lines.join('\n').trim()}\n`;
}
