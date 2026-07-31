import type { Target } from '@usrouter/core';
import { IconRoute } from './icons.js';

export function RoutingBadge({
  target,
  ruleId,
  reason,
}: {
  target: Target;
  ruleId?: string;
  reason?: string;
}) {
  return (
    <div class="routing-badge" title={reason}>
      <IconRoute size={11} />
      <span class="routing-target">
        {target.provider}:{target.account}
      </span>
      {target.model && <span class="routing-model">{target.model}</span>}
      {ruleId && <span class="routing-rule">{ruleId}</span>}
    </div>
  );
}
