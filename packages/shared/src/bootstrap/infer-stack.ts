import type { BootstrapStack } from './schemas.js';

/**
 * Maps a free-form set of selected "Stack" tags to the one real scaffold template (if any) that
 * applies. The tags are what the user actually picks — a single dropdown enum couldn't express
 * "React + PostgreSQL + AWS" — but exactly six deterministic scaffold templates exist
 * (`packages/daemon/src/adapters/bootstrap-scaffolds.ts`), so something still has to decide which
 * one (if any) to generate. Checked in this fixed order so a project tagged with both "Python"
 * and "TypeScript" gets a documented, deterministic answer rather than an arbitrary one — Node
 * checked first since a full-stack pick (framework + a database, say) is more likely to include a
 * JS/TS-side signal than not; Kotlin is checked before Java since a Kotlin project would rarely
 * also carry a plain "Java" tag, but the reverse (someone tagging a real Kotlin project just
 * "Java") is more plausible and shouldn't win.
 *
 * Returns `'other'` when tags were picked but none matched (a real stack exists, just no built-in
 * template for it — e.g. "Ruby" + "Ruby on Rails"), or `'none'` when no tags were picked at all.
 */
const STACK_TAG_TRIGGERS: [Exclude<BootstrapStack, 'other' | 'none'>, string[]][] = [
  [
    'node-typescript',
    [
      'TypeScript',
      'JavaScript',
      'Node.js',
      'React',
      'Vue',
      'Svelte',
      'Angular',
      'Next.js',
      'Nuxt',
      'SvelteKit',
      'Remix',
      'Astro',
      'Express',
      'Fastify',
      'NestJS',
      'Tailwind CSS',
    ],
  ],
  ['python', ['Python', 'Django', 'Flask', 'FastAPI']],
  ['go', ['Go', 'Gin', 'Echo']],
  ['kotlin', ['Kotlin']],
  ['java', ['Java', 'Spring Boot']],
  ['csharp', ['C#']],
];

export function inferStackFromTags(tags: string[]): BootstrapStack {
  const lower = new Set(tags.map((tag) => tag.toLowerCase()));
  for (const [stack, triggers] of STACK_TAG_TRIGGERS) {
    if (triggers.some((trigger) => lower.has(trigger.toLowerCase()))) return stack;
  }
  return tags.length > 0 ? 'other' : 'none';
}
