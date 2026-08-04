import type { TaskRequest } from '../types.js';

/**
 * Understand the request before routing it: what kind of work is this, and
 * how heavy is it? Deliberately transparent heuristics — the user can read
 * every signal in the routing badge and override it with a rule or a mention.
 */

export type TaskKind =
  | 'question'
  | 'explain'
  | 'edit'
  | 'debug'
  | 'test'
  | 'review'
  | 'refactor'
  | 'docs'
  | 'agentic';

export type Complexity = 'trivial' | 'simple' | 'moderate' | 'hard';

export interface Classification {
  kind: TaskKind;
  complexity: Complexity;
  /** Human-readable reasons, shown in the UI so routing is never a black box. */
  signals: string[];
  /** True when the task edits/creates code rather than only answering. */
  writesCode: boolean;
}

/**
 * Turkish stems open with a lookbehind instead of `\b`, and close with nothing.
 *
 * Two reasons, both learned the hard way. `\b` is ASCII-only, so `\bölçeklen`
 * can never match — the boundary it wants does not exist next to "ö". And the
 * language is agglutinative, so a closing boundary would be just as wrong:
 * "dosya" has to match "dosyalarda".
 *
 * Stems are also cut short of a final k, which softens when a suffix lands on
 * it: "güvenlik" becomes "güvenliğini", "karmaşık" becomes "karmaşığı". A
 * pattern spelled with the hard consonant matches the bare noun and nothing a
 * sentence actually does with it.
 */
const TR = '(?<![\\p{L}\\p{N}])';

const KIND_PATTERNS: Array<{ kind: TaskKind; writes: boolean; re: RegExp }> = [
  { kind: 'test', writes: true, re: new RegExp(`\\b(test|tests|spec|unit test|coverage|vitest|jest|pytest)\\b|${TR}(test|birim test|kapsam)`, 'iu') },
  { kind: 'review', writes: false, re: new RegExp(`\\b(review|audit|security|vulnerab|code smell|critique)\\b|${TR}(incele|gözden geçir|denetle|güvenli|zafiyet)`, 'iu') },
  { kind: 'debug', writes: true, re: new RegExp(`\\b(debug|bug|error|crash|fails?|failing|broken|stack trace|exception|traceback)\\b|${TR}(hata|çöküyor|çalışmıyor|bozu(k|ğ)|patlıyor|kırıl|ayıkla)`, 'iu') },
  { kind: 'refactor', writes: true, re: new RegExp(`\\b(refactor|clean ?up|simplify|restructure|rename|extract|migrate|modernize)\\b|${TR}(sadeleştir|yeniden düzenle|yeniden yapılandır|temizle|taşı)`, 'iu') },
  { kind: 'docs', writes: true, re: new RegExp(`\\b(document|docs|readme|changelog|comment|jsdoc|docstring)\\b|${TR}(belge|doküman|açıklama satır|yorum satır)`, 'iu') },
  { kind: 'explain', writes: false, re: new RegExp(`\\b(explain|how does|what does|why does|walk me through|understand)\\b|${TR}(anlat|açıkla|nedir)`, 'iu') },
  { kind: 'edit', writes: true, re: new RegExp(`\\b(add|implement|create|write|build|fix|change|update|support|optimi[sz]e|improve|speed up|port|convert)\\b|${TR}(ekle|yaz|düzelt|uygula|iyile[şs]tir|oluştur|geliştir|güncelle|değiştir|kur)`, 'iu') },
];

const AGENTIC_RE = new RegExp(
  `\\b(and then|after that|step by step|for (each|every) file|across the (repo|codebase)|entire (repo|codebase|project)|all (the )?(files|tests|packages)|end.to.end|migrate .* to|set up|scaffold)\\b` +
    `|${TR}(ve sonra|sonra da|ardından|akabinde|adım adım|her (dosya|test|paket)|tüm (dosya|test|proje|paket|kod|sayfa)|bütün (dosya|test|proje)|kod taban|baştan sona|uçtan uca|toplu (halde|olarak)|hepsinde)`,
  'iu',
);

const HARD_RE = new RegExp(
  `\\b(architect|design|redesign|optimi[sz]e|performance|concurren|race condition|memory leak|security|protocol|algorithm|complex|tricky|deadlock|scal(e|ing)|refactor .* (whole|entire)|root cause)\\b` +
    `|${TR}(mimari|tasarla|tasarım|optimiz|performans|eşzamanl|yarış durumu|bellek sızıntı|güvenli|zafiyet|protokol|algoritma|karmaşı|ölçeklen|kök neden|kilitlenme|yeniden yapılandır)`,
  'iu',
);

const TRIVIAL_RE = new RegExp(
  `\\b(typo|rename|format|prettier|lint|one.?liner|bump|version|import|semicolon|whitespace)\\b` +
    `|${TR}(yazım hatası|yeniden adlandır|biçimlendir|sürüm(ü)? (yükselt|artır)|noktalı virgül|boşluk|girinti|tek satır)`,
  'iu',
);

const QUESTION_RE = /^(what|who|when|where|which|why|how|is|are|can|does|do|should|could)\b|\?\s*$/i;

/** Words that mean "carry on" with nothing else attached. */
const CONFIRM =
  'y(es|ep|eah)?|ok(ay)?|sure|go( ahead)?|do it|continue|proceed|next|please( do)?|' +
  'evet|tamam|olur|peki|hadi|uygundur|devam( et(elim)?)?|yap(alım)?|başla(yalım)?|onayla';

/**
 * "yes", "go ahead", "evet yap" — a continuation, not a new small task.
 *
 * Several confirmations in a row still make one: Turkish stacks them where
 * English uses a single word ("tamam devam et", "evet yap"). Getting this wrong
 * is expensive — an unrecognized confirmation is classified on its own two
 * words, comes out trivial, and drops a hard thread onto a light model.
 */
const CONTINUATION_RE = new RegExp(`^(?:${CONFIRM})(?:[\\s,]+(?:${CONFIRM}))*[\\s.!]*$`, 'i');

export function isContinuation(prompt: string): boolean {
  return CONTINUATION_RE.test(prompt.trim());
}

export function classifyTask(task: TaskRequest): Classification {
  const prompt = task.prompt.trim();
  const lower = prompt.toLowerCase();
  const signals: string[] = [];

  // ── kind ──────────────────────────────────────────────
  let kind: TaskKind = 'question';
  let writesCode = false;
  for (const entry of KIND_PATTERNS) {
    if (entry.re.test(lower)) {
      kind = entry.kind;
      writesCode = entry.writes;
      signals.push(entry.kind);
      break;
    }
  }
  if (kind === 'question' && QUESTION_RE.test(prompt)) signals.push('question');

  const multiStep = AGENTIC_RE.test(lower);
  if (multiStep) {
    kind = 'agentic';
    writesCode = true;
    signals.push('multi-step');
  }

  // ── complexity ────────────────────────────────────────
  let score = 0;
  const words = prompt.split(/\s+/).length;
  if (words > 120) {
    score += 2;
    signals.push('long prompt');
  } else if (words > 40) {
    score += 1;
  } else if (words <= 8) {
    score -= 1;
    signals.push('short prompt');
  }

  if (HARD_RE.test(lower)) {
    score += 2;
    signals.push('hard topic');
  }
  if (TRIVIAL_RE.test(lower)) {
    score -= 2;
    signals.push('mechanical');
  }
  if (multiStep) score += 2;
  if (writesCode) score += 1;
  if (/```/.test(prompt)) {
    score += 1;
    signals.push('code block');
  }
  // Numbered or bulleted requirement lists mean several deliverables.
  const bulletCount = (prompt.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
  if (bulletCount >= 3) {
    score += 1;
    signals.push(`${bulletCount} requirements`);
  }
  if ((task.tags?.length ?? 0) > 0) signals.push(...task.tags!.map((t) => `#${t}`));
  if (kind === 'review' || kind === 'debug') score += 1;
  if (kind === 'explain' || kind === 'question') score -= 1;

  const complexity: Complexity =
    score <= -1 ? 'trivial' : score === 0 ? 'simple' : score <= 2 ? 'moderate' : 'hard';

  if (isContinuation(prompt)) signals.push('continuation');

  return { kind, complexity, signals: [...new Set(signals)].slice(0, 6), writesCode };
}
