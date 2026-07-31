import * as vscode from 'vscode';
import {
  resolveTargetAccount,
  type AccountProfile,
  type ResolvedAccount,
  type Target,
} from '@usrouter/core';

const KEY = 'usrouter.accounts';
const secretKey = (id: string) => `usrouter.secret.${id}`;

export class AccountStore {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  all(): AccountProfile[] {
    return this.ctx.globalState.get<AccountProfile[]>(KEY, []);
  }

  async upsert(account: AccountProfile): Promise<void> {
    const accounts = this.all().filter((a) => a.id !== account.id);
    accounts.push(account);
    await this.ctx.globalState.update(KEY, accounts);
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(
      KEY,
      this.all().filter((a) => a.id !== id),
    );
    await this.ctx.secrets.delete(secretKey(id));
    this.emitter.fire();
  }

  async setSecret(id: string, value: string): Promise<void> {
    await this.ctx.secrets.store(secretKey(id), value);
  }

  async getSecret(id: string): Promise<string | undefined> {
    return this.ctx.secrets.get(secretKey(id));
  }

  async resolve(target: Target): Promise<ResolvedAccount | undefined> {
    const account = resolveTargetAccount(target, this.all());
    if (!account) return undefined;
    const secret = account.hasSecret ? await this.getSecret(account.id) : undefined;
    return { ...account, secret };
  }
}
