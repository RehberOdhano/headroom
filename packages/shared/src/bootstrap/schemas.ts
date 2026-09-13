import { z } from 'zod';

export const bootstrapModeSchema = z.enum(['create', 'existing']);
// 'other' has no deterministic scaffold template (unlike the six real stacks) — it exists so a
// stack we haven't built a template for still gets named in the generated CLAUDE.md instead of
// being forced into 'none', which means "no stack at all."
export const bootstrapStackSchema = z.enum(['node-typescript', 'python', 'go', 'java', 'kotlin', 'csharp', 'other', 'none']);

/** How an uploaded document's `content` string is encoded — `utf8` for real text (`.md`/`.txt`),
 *  `base64` for anything binary (`.pdf`/`.doc`/`.docx`), since those can't survive a plain UTF-8
 *  string round-trip through JSON without corruption. */
export const bootstrapDocumentEncodingSchema = z.enum(['utf8', 'base64']);

// `.default()` on every field for the same reason as every other daemon response schema (see
// gitActivityResponseSchema): a daemon that hasn't restarted since this route shipped must still
// produce a parseable response, not fail the whole request over an unrecognized shape.
export const bootstrapVerificationStepSchema = z.object({
  command: z.string().default(''),
  ok: z.boolean().default(false),
  output: z.string().default(''),
});

export const bootstrapResultSchema = z.object({
  createdFolder: z.boolean().default(false),
  createdFiles: z.array(z.string()).default([]),
  skippedFiles: z.array(z.string()).default([]),
  /** True when a real stack (not 'none'/'other') was inferred from the picked tags but no
   *  scaffold files were written because the target folder already had real content beyond
   *  dotfiles like `.git` — the daemon decides whether to scaffold from the folder's actual
   *  state, never from which mode button was clicked, so this is the UI's only signal that a
   *  requested scaffold didn't run. */
  scaffoldSkipped: z.boolean().default(false),
  /** True only when `git init` actually ran — false if it wasn't requested, the folder was
   *  already a git repo, or `git` itself isn't available. */
  gitInitialized: z.boolean().default(false),
  /** Null when verification wasn't requested or wasn't applicable (scaffold skipped, or a stack
   *  with no commands at all); otherwise one entry per command actually run, in order, each
   *  captured independently regardless of whether an earlier one failed. */
  verification: z.array(bootstrapVerificationStepSchema).nullable().default(null),
  /** Which scaffold template, if any, the daemon inferred from the request's `technologies` tags
   *  (`inferStackFromTags`) — there's no separate "Stack" input for the caller to send, so this
   *  is the only way the UI learns which of the three real templates (if any) actually applied. */
  inferredStack: bootstrapStackSchema.default('none'),
});

// Deterministic, no-LLM detection of an *existing* folder's already-there project info (a
// package.json/pyproject.toml/go.mod, or a CLAUDE.md this tool wrote on an earlier run) — same
// `.default()`-on-every-field rule as every other daemon response schema, for the same reason.
export const projectDetectionResponseSchema = z.object({
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  /** Includes both dependency/config-file matches against the curated catalog AND an implied
   *  runtime tag ("Node.js"/"Python"/"Go") when a package.json/pyproject.toml/go.mod was found —
   *  there's no separate detected "stack" field; the implied tag folds into this same list so it
   *  flows through the one "Stack" picker like everything else. Best-effort and non-exhaustive,
   *  never a claim of having read or understood the project. */
  technologies: z.array(z.string()).default([]),
});

export type BootstrapMode = z.infer<typeof bootstrapModeSchema>;
export type BootstrapStack = z.infer<typeof bootstrapStackSchema>;
export type BootstrapDocumentEncoding = z.infer<typeof bootstrapDocumentEncodingSchema>;
export type BootstrapVerificationStep = z.infer<typeof bootstrapVerificationStepSchema>;
export type BootstrapResult = z.infer<typeof bootstrapResultSchema>;
export type ProjectDetectionResult = z.infer<typeof projectDetectionResponseSchema>;
