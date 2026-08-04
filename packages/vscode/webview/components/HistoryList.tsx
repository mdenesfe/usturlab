import type { ConversationMeta } from '../../src/panel/protocol.js';
import { IconPlus, IconTrash } from './icons.js';

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString();
}

function groupLabel(ts: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - 86_400_000) return 'Yesterday';
  if (ts >= startOfToday - 6 * 86_400_000) return 'Last 7 days';
  return 'Older';
}

export function HistoryList({
  conversations,
  onOpen,
  onDelete,
  onNewChat,
}: {
  conversations: ConversationMeta[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}) {
  const groups: Array<{ label: string; items: ConversationMeta[] }> = [];
  for (const c of conversations) {
    const label = groupLabel(c.updatedAt);
    const group = groups[groups.length - 1];
    if (group && group.label === label) group.items.push(c);
    else groups.push({ label, items: [c] });
  }

  return (
    <div class="history">
      <button class="history-new" onClick={onNewChat}>
        <IconPlus size={12} /> New chat
      </button>
      {conversations.length === 0 && (
        <div class="history-empty">
          No chats yet.
          <br />
          Start one — it opens in the editor.
        </div>
      )}
      {groups.map((group) => (
        <div key={group.label} class="history-group">
          <div class="history-group-label">{group.label}</div>
          {group.items.map((c) => (
            <div
              key={c.id}
              class="history-row"
              // Not a <button>: it contains one. Role plus keys is what that
              // leaves, and a chat list you cannot reach by keyboard is broken.
              role="button"
              tabIndex={0}
              onClick={() => onOpen(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(c.id);
                }
              }}
            >
              {c.running && (
                <>
                  <span class="dot ok pulse" />
                  <span class="sr-only">running</span>
                </>
              )}
              <span class="history-title" title={c.title}>
                {c.title}
              </span>
              <span class="history-time">{relTime(c.updatedAt)}</span>
              <button
                class="icon-btn history-del"
                title="Delete chat"
                aria-label={`Delete chat: ${c.title || 'untitled'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
              >
                <IconTrash size={12} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
