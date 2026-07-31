import type * as vscode from 'vscode';
import type { QuotaPersistence, QuotaState } from '@usturlab/core';

const KEY = 'usturlab.quota';

export function globalStateQuotaPersistence(ctx: vscode.ExtensionContext): QuotaPersistence {
  return {
    load: () => ctx.globalState.get<QuotaState>(KEY),
    save: (state) => {
      void ctx.globalState.update(KEY, state);
    },
  };
}
