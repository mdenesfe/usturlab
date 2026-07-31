import { z } from 'zod';

const providerSchema = z.enum(['claude', 'codex', 'gemini', 'copilot']);

export const targetSchema = z.object({
  provider: providerSchema,
  account: z.string().min(1),
  model: z.string().optional(),
});

export const matchSchema = z
  .object({
    keywords: z.array(z.string().min(1)).optional(),
    globs: z.array(z.string().min(1)).optional(),
    languages: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    maxPromptChars: z.number().int().positive().optional(),
  })
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'match must contain at least one condition',
  });

export const ruleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  match: matchSchema,
  target: z.array(targetSchema).min(1),
});

export const rulesFileSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  rules: z.array(ruleSchema).default([]),
  defaultChain: z.array(targetSchema).default([]),
});

export type RuleTarget = z.infer<typeof targetSchema>;
export type RuleMatch = z.infer<typeof matchSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type RulesFile = z.infer<typeof rulesFileSchema>;

export const EMPTY_RULES: RulesFile = { version: 1, rules: [], defaultChain: [] };

export type ParseRulesResult =
  | { ok: true; rules: RulesFile }
  | { ok: false; error: string };

export function parseRulesFile(content: string): ParseRulesResult {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const parsed = rulesFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: issues };
  }
  return { ok: true, rules: parsed.data };
}

export const RULES_TEMPLATE = `{
  "$schema": "https://raw.githubusercontent.com/usrouter/usrouter/main/packages/vscode/schemas/rules.schema.json",
  "version": 1,
  "rules": [
    {
      "id": "tests-to-codex",
      "description": "Tests always go to Codex, fall back to Claude",
      "match": {
        "keywords": ["test", "spec", "coverage"],
        "globs": ["**/*.test.*", "**/*.spec.*"]
      },
      "target": [
        { "provider": "codex", "account": "work" },
        { "provider": "claude", "account": "personal", "model": "sonnet" }
      ]
    },
    {
      "id": "quick-questions",
      "description": "Short questions go to a cheap fast model",
      "match": {
        "keywords": ["what is", "explain", "how do"],
        "maxPromptChars": 400
      },
      "target": [
        { "provider": "claude", "account": "personal", "model": "haiku" }
      ]
    }
  ],
  "defaultChain": [
    { "provider": "claude", "account": "personal", "model": "sonnet" }
  ]
}
`;
