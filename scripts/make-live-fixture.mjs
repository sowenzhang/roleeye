import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph } from 'docx';

// Builds a throwaway project root plus a real .docx resume, for a live CLI run.
const root = process.argv[2];
if (!root) throw new Error('usage: node make-live-fixture.mjs <root>');

for (const dir of ['config', 'profile', 'data', 'artifacts']) {
  mkdirSync(path.join(root, dir), { recursive: true });
}

copyFileSync('config/criteria.example.yaml', path.join(root, 'config', 'criteria.yaml'));
copyFileSync('config/sources.example.yaml', path.join(root, 'config', 'sources.yaml'));

writeFileSync(
  path.join(root, 'profile', 'master-resume.md'),
  '# Jane Doe\n\nSeattle, WA · jane@example.com\n',
  'utf8',
);
writeFileSync(
  path.join(root, 'profile', 'career-profile.md'),
  'Staff engineer moving toward AI platform work. Twelve years building payments and rewards systems.\n',
  'utf8',
);

const document = new Document({
  sections: [
    {
      children: [
        new Paragraph({ text: 'Jane Doe' }),
        new Paragraph({ text: 'jane@example.com | +1 555 987 6543' }),
        new Paragraph({ text: 'EXPERIENCE' }),
        new Paragraph({ text: 'Acme Corp — Staff Software Engineer (Jan 2019 – Present)' }),
        new Paragraph({ text: '• Rebuilt the rewards platform on event-driven services handling 2 million daily transactions.' }),
        new Paragraph({ text: '• Reduced p99 checkout latency by 43% by rewriting the pricing service in Go.' }),
        new Paragraph({ text: '• Ran model inference on a fleet of GPU nodes for the recommendations team.' }),
        new Paragraph({ text: 'Globex, Senior Engineer, 2015 - 2019' }),
        new Paragraph({ text: '• Led the migration of the settlement ledger to a new double-entry system.' }),
        new Paragraph({ text: '• Mentored four engineers through promotion to senior.' }),
        new Paragraph({ text: 'SKILLS' }),
        new Paragraph({ text: '• Go, TypeScript, PostgreSQL, Kafka, Kubernetes' }),
      ],
    },
  ],
});

writeFileSync(path.join(root, 'jane-doe-resume.docx'), await Packer.toBuffer(document));
console.log('fixture ready at', root);
