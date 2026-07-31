import * as vscode from 'vscode';
import type { TaskMetric } from '@usturlab/core';

const KEY = 'usturlab.metrics';
const MAX_METRICS = 10000;

export class MetricsStore {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  all(): TaskMetric[] {
    return this.ctx.globalState.get<TaskMetric[]>(KEY, []);
  }

  async record(metric: TaskMetric): Promise<void> {
    const metrics = this.all();
    metrics.push(metric);
    const trimmed = metrics.slice(-MAX_METRICS);
    await this.ctx.globalState.update(KEY, trimmed);
    this.emitter.fire();
  }

  /** Friction discovered after the fact: the user re-asked the same thing. */
  async markRetried(id: string): Promise<void> {
    const metrics = this.all();
    const target = metrics.find((m) => m.id === id);
    if (!target || target.retried) return;
    target.retried = true;
    await this.ctx.globalState.update(KEY, metrics);
    this.emitter.fire();
  }

  async clear(): Promise<void> {
    await this.ctx.globalState.update(KEY, []);
    this.emitter.fire();
  }

  byDateRange(days: number): TaskMetric[] {
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return this.all().filter((m) => m.timestamp >= cutoff);
  }

  sinceYesterday(): TaskMetric[] {
    return this.byDateRange(1);
  }

  last7Days(): TaskMetric[] {
    return this.byDateRange(7);
  }

  last30Days(): TaskMetric[] {
    return this.byDateRange(30);
  }
}
