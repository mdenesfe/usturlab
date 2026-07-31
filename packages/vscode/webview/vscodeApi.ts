import type { WebviewToHost } from '../src/panel/protocol.js';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
