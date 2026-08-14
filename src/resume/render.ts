import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Experience } from '../db/repositories/facts.js';
import { sha256 } from '../util/hash.js';
import type { TailoredResume } from './tailor.js';

/**
 * Rendering a stored generation into documents.
 *
 * Rendering is local-only, which is why the name and contact line may be read
 * from `profile/master-resume.md` unredacted here. That file is never sent to a
 * provider — `loadCareerProfile` strips contact details for prompts, and this
 * function is not in that path.
 */

export interface ResumeHeader {
  name: string;
  contact: string | undefined;
}

export function loadResumeHeader(profileDir: string): ResumeHeader {
  const file = path.join(profileDir, 'master-resume.md');
  if (!existsSync(file)) return { name: 'Your Name', contact: undefined };

  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const heading = lines.find((line) => line.startsWith('#'));
  const name = heading?.replace(/^#+\s*/, '').trim();
  const contact = lines.find((line) => !line.startsWith('#') && /[@|·]/.test(line) && line.length < 200);

  return { name: name && name.length > 0 ? name : 'Your Name', contact };
}

export interface RenderInputs {
  header: ResumeHeader;
  archetypeLabel: string;
  document: TailoredResume;
  experiences: Map<string, Experience>;
  /** Only supported claims reach a document. */
  supported: (bullet: { text: string; fact_ids: string[] }, experienceId: string) => boolean;
}

function experienceHeading(experience: Experience): string {
  const dates = [experience.startedOn, experience.endedOn].filter(Boolean).join(' – ');
  return `${experience.role}, ${experience.company}${dates ? ` (${dates})` : ''}`;
}

export function renderMarkdown(inputs: RenderInputs): string {
  const lines: string[] = [`# ${inputs.header.name}`];

  if (inputs.header.contact) lines.push('', inputs.header.contact);
  lines.push('', `**${inputs.archetypeLabel}**`, '');

  if (inputs.document.summary.text.length > 0) {
    lines.push('## Summary', '', inputs.document.summary.text, '');
  }

  lines.push('## Experience', '');

  for (const section of inputs.document.sections) {
    const experience = inputs.experiences.get(section.experience_id);
    if (!experience) continue;

    const bullets = section.bullets.filter((bullet) => inputs.supported(bullet, section.experience_id));
    if (bullets.length === 0) continue;

    lines.push(`### ${experienceHeading(experience)}`, '');
    for (const bullet of bullets) lines.push(`- ${bullet.text}`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** The provenance copy: same content, every claim showing what it rests on. */
export function renderProvenance(
  inputs: RenderInputs,
  statementOf: (factId: string) => string | undefined,
): string {
  const lines: string[] = [`# ${inputs.header.name} — ${inputs.archetypeLabel}`, '', '## Summary', ''];

  const cite = (bullet: { text: string; fact_ids: string[] }): void => {
    lines.push(`- ${bullet.text}`);
    for (const id of bullet.fact_ids) {
      const statement = statementOf(id);
      lines.push(`  - from \`${id}\`: ${statement ?? '(fact not found)'}`);
    }
  };

  cite(inputs.document.summary);
  lines.push('', '## Experience', '');

  for (const section of inputs.document.sections) {
    const experience = inputs.experiences.get(section.experience_id);
    if (!experience) continue;

    lines.push(`### ${experienceHeading(experience)}`, '');
    for (const bullet of section.bullets) {
      if (!inputs.supported(bullet, section.experience_id)) continue;
      cite(bullet);
    }
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

/**
 * Writes a `.docx`.
 *
 * `docx` is imported dynamically even though it is a dependency, so that a
 * broken or missing install fails only for the person rendering a Word
 * document, rather than at startup for every command.
 */
export async function renderDocx(inputs: RenderInputs, file: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('docx');

  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ text: inputs.header.name, heading: HeadingLevel.TITLE }),
  ];

  if (inputs.header.contact) {
    children.push(new Paragraph({ text: inputs.header.contact, alignment: AlignmentType.LEFT }));
  }

  children.push(new Paragraph({ children: [new TextRun({ text: inputs.archetypeLabel, bold: true })] }));

  if (inputs.document.summary.text.length > 0) {
    children.push(new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: inputs.document.summary.text }));
  }

  children.push(new Paragraph({ text: 'Experience', heading: HeadingLevel.HEADING_1 }));

  for (const section of inputs.document.sections) {
    const experience = inputs.experiences.get(section.experience_id);
    if (!experience) continue;

    const bullets = section.bullets.filter((bullet) => inputs.supported(bullet, section.experience_id));
    if (bullets.length === 0) continue;

    children.push(new Paragraph({ text: experienceHeading(experience), heading: HeadingLevel.HEADING_2 }));
    for (const bullet of bullets) {
      children.push(new Paragraph({ text: bullet.text, bullet: { level: 0 } }));
    }
  }

  const document = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(document);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buffer);

  return Buffer.from(buffer);
}

export function writeText(file: string, contents: string): { path: string; checksum: string } {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  return { path: file, checksum: sha256(contents) };
}
