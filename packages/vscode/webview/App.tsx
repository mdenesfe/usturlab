import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountStatusDto, ConversationMeta, HostToWebview } from '../src/panel/protocol.js';
import type { TaskMetric } from '../../core/src/quota/metricsSchema.js';
import { vscode } from './vscodeApi.js';
import { Transcript } from './components/Transcript.js';
import { applyHostMessage, type TranscriptItem } from '../src/panel/transcript.js';
import { Composer } from './components/Composer.js';
import { HistoryList } from './components/HistoryList.js';
import { AccountsView } from './components/AccountsView.js';
import { RulesView } from './components/RulesView.js';
import { AnalyticsView } from './components/AnalyticsView.js';
import { IconAccounts, IconPlus, IconRoute, IconAnalytics } from './components/icons.js';

declare global {
  interface Window {
    __USTURLAB_MODE__?: 'sidebar' | 'tab' | 'accounts' | 'rules' | 'analytics';
  }
}

const MODE: 'sidebar' | 'tab' | 'accounts' | 'rules' | 'analytics' = window.__USTURLAB_MODE__ ?? 'tab';

const HASHTAG_RE = /(^|\s)#([\w-]+)/g;

export function App() {
  if (MODE === 'sidebar') return <SidebarApp />;
  if (MODE === 'accounts') return <AccountsApp />;
  if (MODE === 'rules') return <RulesApp />;
  if (MODE === 'analytics') return <AnalyticsApp />;
  return <ChatApp />;
}

/** Center tab: routing rules — read and written in the same place. */
function RulesApp() {
  const [state, setState] = useState<Extract<HostToWebview, { kind: 'rules' }> | undefined>();
  const [accounts, setAccounts] = useState<AccountStatusDto[]>([]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      if (event.data.kind === 'rules') setState(event.data);
      if (event.data.kind === 'accounts') setAccounts(event.data.accounts);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!state) return <div class="app" />;
  return (
    <div class="app">
      <RulesView
        rules={state.rules}
        accounts={accounts}
        path={state.path}
        exists={state.exists}
        error={state.error}
      />
    </div>
  );
}

/** Center tab: analytics dashboard. */
function AnalyticsApp() {
  const [state, setState] = useState<Extract<HostToWebview, { kind: 'analytics' }> | undefined>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      if (event.data.kind === 'analytics') setState(event.data);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!state) return <div class="app" />;
  return (
    <div class="app">
      <AnalyticsView metrics={state.metrics} accounts={state.accounts} />
    </div>
  );
}

/** Left panel: session list only — chats open as editor tabs. */
function SidebarApp() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [accounts, setAccounts] = useState<AccountStatusDto[] | undefined>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.kind === 'conversations') setConversations(msg.list);
      if (msg.kind === 'accounts') setAccounts(msg.accounts);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div class="app">
      {accounts !== undefined && accounts.length === 0 && (
        <div class="setup-banner">
          <div class="setup-banner-text">Connect your AI subscriptions to start routing.</div>
          <button class="run-btn send" onClick={() => vscode.postMessage({ kind: 'addAccount' })}>
            <IconPlus size={12} /> Add account
          </button>
        </div>
      )}
      <HistoryList
        conversations={conversations}
        onOpen={(id) => vscode.postMessage({ kind: 'openConversation', id })}
        onDelete={(id) => vscode.postMessage({ kind: 'deleteConversation', id })}
        onNewChat={() => vscode.postMessage({ kind: 'newConversation' })}
      />
      <div class="sidebar-footer">
        <button class="footer-btn" onClick={() => vscode.postMessage({ kind: 'openAccounts' })}>
          <IconAccounts size={13} /> Accounts
        </button>
        <button class="footer-btn" onClick={() => vscode.postMessage({ kind: 'openRules' })}>
          <IconRoute size={13} /> Rules
        </button>
        <button class="footer-btn" onClick={() => vscode.postMessage({ kind: 'openAnalytics' })}>
          <IconAnalytics size={13} /> Analytics
        </button>
      </div>
    </div>
  );
}

/** Center tab: accounts management. */
function AccountsApp() {
  const [accounts, setAccounts] = useState<AccountStatusDto[]>([]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.kind === 'accounts') setAccounts(msg.accounts);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div class="app">
      <AccountsView accounts={accounts} />
    </div>
  );
}

/** Center tab: one conversation. */
function ChatApp() {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [accounts, setAccounts] = useState<AccountStatusDto[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [customCommands, setCustomCommands] = useState<
    import('../../core/src/commands/slashCommands.js').SlashCommand[]
  >([]);
  const [permissionMode, setPermissionMode] = useState('safe');
  const [askPermission, setAskPermission] = useState(false);
  const [routingMode, setRoutingMode] = useState<'auto' | 'manual'>('auto');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Follow the stream only while the user is already at the bottom —
  // scrolling up to read must never be fought.
  const pinnedRef = useRef(true);
  // ...but not fighting them is not the same as stranding them: once they are
  // off the bottom there has to be a way back, and a sign that more arrived.
  const [pinned, setPinned] = useState(true);
  const [missed, setMissed] = useState(false);

  const toBottom = () => {
    pinnedRef.current = true;
    setPinned(true);
    setMissed(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      setItems((prev) => applyHostMessage(prev, msg));
      if (msg.kind === 'busy') {
        setRunning(msg.running);
        // A reopened tab that is still running has no start time to report, so
        // the clock starts now rather than inventing one.
        if (msg.running) setStartedAt((prev) => prev || Date.now());
        else setStartedAt(0);
      }
      if (msg.kind === 'accounts') setAccounts(msg.accounts);
      if (msg.kind === 'rules') {
        setTags([...new Set(msg.rules.rules.flatMap((r) => r.match.tags ?? []))]);
        setCustomCommands(msg.customCommands ?? []);
      }
      if (msg.kind === 'modes') {
        setPermissionMode(msg.permissionMode);
        setRoutingMode(msg.routingMode);
        setAskPermission(msg.askPermission === true);
      }
      if (msg.kind === 'attachments') {
        setAttachments((prev) => [...new Set([...prev, ...msg.paths])]);
      }
      if (msg.kind === 'conversationReset') setItems([]);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView();
    else if (items.length > 0) setMissed(true);
  }, [items]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tags = [...trimmed.matchAll(HASHTAG_RE)].map((m) => m[2]!);
    pinnedRef.current = true;
    vscode.postMessage({
      kind: 'send',
      text: trimmed,
      tags,
      permissionMode,
      routingMode,
      attachments,
    });
    setAttachments([]);
  };

  return (
    <div class="app chat-tab">
      <div
        class="scroll-area"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
          pinnedRef.current = atBottom;
          setPinned(atBottom);
          if (atBottom) setMissed(false);
        }}
      >
        <div class="chat-column">
          <Transcript
            items={items}
            noAccounts={accounts.length === 0}
            running={running}
            startedAt={startedAt}
            onAddAccount={() => vscode.postMessage({ kind: 'addAccount' })}
            onPermission={(id, decision) =>
              vscode.postMessage({ kind: 'permissionDecision', id, decision })
            }
            onRetry={() => {
              pinnedRef.current = true;
              setPinned(true);
              setMissed(false);
              vscode.postMessage({ kind: 'retryLast' });
            }}
          />
          <div ref={bottomRef} />
        </div>
      </div>
      <div class="chat-column composer-holder">
        {!pinned && items.length > 0 && (
          <button
            class={`jump-latest ${missed ? 'missed' : ''}`}
            onClick={toBottom}
            aria-label={missed ? 'Jump to latest — new activity below' : 'Jump to latest'}
          >
            ↓ {missed ? 'new activity' : 'latest'}
          </button>
        )}
        <Composer
          accounts={accounts}
          tags={tags}
          customCommands={customCommands}
          running={running}
          permissionMode={permissionMode}
          askPermission={askPermission}
          routingMode={routingMode}
          attachments={attachments}
          onPickAttachments={() => vscode.postMessage({ kind: 'pickAttachments' })}
          onRemoveAttachment={(path) => setAttachments((prev) => prev.filter((p) => p !== path))}
          onSend={send}
          onCancel={() => vscode.postMessage({ kind: 'cancel' })}
          onModeChange={({ ask, ...modes }) => {
            // Asking is its own switch: it rides on top of the level rather
            // than replacing it, so changing one must never clear the other.
            if (ask !== undefined) {
              setAskPermission(ask);
              vscode.postMessage({ kind: 'setAskPermission', ask });
            }
            if (modes.permissionMode) setPermissionMode(modes.permissionMode);
            if (modes.routingMode) setRoutingMode(modes.routingMode);
            if (modes.permissionMode || modes.routingMode) {
              vscode.postMessage({ kind: 'setModes', ...modes });
            }
          }}
        />
      </div>
    </div>
  );
}
