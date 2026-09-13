/**
 * A curated catalog of in-demand technologies a project might use, offered as pill/badge
 * suggestions in the New Project form's "Technologies" field. Deliberately separate from
 * `bootstrapStackSchema`: `stack` drives which deterministic scaffold template actually gets
 * written (only three real templates exist), while these tags are free-form metadata recorded
 * into the generated CLAUDE.md for reference — picking "Next.js" and "PostgreSQL" here has no
 * effect on which files get generated. Not exhaustive; a typed value not in this list is still
 * accepted as a custom tag, the same way `stack: 'other'` accepts a typed stack name.
 */
export interface TechTagCategory {
  category: string;
  tags: string[];
}

export const TECH_TAG_CATEGORIES: TechTagCategory[] = [
  {
    category: 'Languages',
    tags: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Ruby', 'Java', 'C#', 'C++', 'PHP', 'Swift', 'Kotlin'],
  },
  {
    category: 'Frontend',
    tags: ['React', 'Vue', 'Svelte', 'Angular', 'Next.js', 'Nuxt', 'SvelteKit', 'Remix', 'Astro', 'Tailwind CSS'],
  },
  {
    category: 'Backend',
    tags: ['Node.js', 'Express', 'Fastify', 'NestJS', 'Django', 'Flask', 'FastAPI', 'Ruby on Rails', 'Spring Boot', 'Laravel', 'Gin', 'Echo'],
  },
  {
    category: 'Mobile',
    tags: ['React Native', 'Expo', 'Flutter', 'Dart'],
  },
  {
    category: 'Databases',
    tags: ['PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'DynamoDB', 'Supabase', 'Firebase', 'Elasticsearch'],
  },
  {
    category: 'Cloud & infra',
    tags: ['AWS', 'Google Cloud', 'Azure', 'Vercel', 'Netlify', 'Cloudflare', 'Docker', 'Kubernetes', 'Terraform'],
  },
  {
    category: 'Testing',
    tags: ['Vitest', 'Jest', 'Playwright', 'Cypress', 'pytest'],
  },
];

export const KNOWN_TECH_TAGS: string[] = TECH_TAG_CATEGORIES.flatMap((entry) => entry.tags);
