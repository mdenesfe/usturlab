import * as vscode from 'vscode';
import { suggestRules, type Correction, type SuggestedRule } from '@usturlab/core';

const CORRECTIONS_KEY = 'usturlab.corrections';
const PREFERENCES_KEY = 'usturlab.preferences';
const DISMISSED_KEY = 'usturlab.dismissedRules';
const MAX_CORRECTIONS = 400;

/**
 * The user's own corrections, and the rules they became.
 *
 * Nothing here is promoted automatically. A correction repeated often enough
 * is *offered* as a standing rule; only an accepted rule reaches the brief.
 * That distinction matters — silently inferring rules from a frustrated user's
 * words and then applying them to every future run is how a tool becomes
 * unpredictable.
 */
export class PreferenceStore {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  corrections(): Correction[] {
    return this.ctx.globalState.get<Correction[]>(CORRECTIONS_KEY, []);
  }

  /** Records a message the user sent into a running task. */
  async recordCorrection(correction: Correction): Promise<void> {
    const all = [...this.corrections(), correction].slice(-MAX_CORRECTIONS);
    await this.ctx.globalState.update(CORRECTIONS_KEY, all);
    this.emitter.fire();
  }

  /** Rules the user accepted; these go into every provider's brief. */
  preferences(): string[] {
    return this.ctx.globalState.get<string[]>(PREFERENCES_KEY, []);
  }

  async accept(text: string): Promise<void> {
    const current = this.preferences();
    if (current.includes(text)) return;
    await this.ctx.globalState.update(PREFERENCES_KEY, [...current, text]);
    this.emitter.fire();
  }

  async remove(text: string): Promise<void> {
    await this.ctx.globalState.update(
      PREFERENCES_KEY,
      this.preferences().filter((p) => p !== text),
    );
    this.emitter.fire();
  }

  private dismissed(): string[] {
    return this.ctx.globalState.get<string[]>(DISMISSED_KEY, []);
  }

  async dismiss(text: string): Promise<void> {
    await this.ctx.globalState.update(DISMISSED_KEY, [...this.dismissed(), text]);
    this.emitter.fire();
  }

  /** Recurring corrections not already accepted or dismissed. */
  pendingSuggestions(): SuggestedRule[] {
    const accepted = new Set(this.preferences());
    const dismissed = new Set(this.dismissed());
    return suggestRules(this.corrections()).filter(
      (rule) => !accepted.has(rule.text) && !dismissed.has(rule.text),
    );
  }

  /**
   * Offers the strongest recurring correction as a standing rule.
   *
   * Asked at most once per window and only when the evidence is real, because
   * a prompt the user did not want is itself a correction they should not have
   * had to make.
   */
  async offerTopSuggestion(): Promise<void> {
    const [top] = this.pendingSuggestions();
    if (!top || top.support < 3) return;
    const preview = top.text.length > 90 ? top.text.slice(0, 90) + '…' : top.text;
    const choice = await vscode.window.showInformationMessage(
      `You have asked for this ${top.support} times: "${preview}" — make it a standing rule for every model?`,
      'Add rule',
      'Not a rule',
    );
    if (choice === 'Add rule') await this.accept(top.text);
    else if (choice === 'Not a rule') await this.dismiss(top.text);
  }

  async clear(): Promise<void> {
    await this.ctx.globalState.update(CORRECTIONS_KEY, []);
    await this.ctx.globalState.update(PREFERENCES_KEY, []);
    await this.ctx.globalState.update(DISMISSED_KEY, []);
    this.emitter.fire();
  }
}
