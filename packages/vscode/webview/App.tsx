import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountStatusDto, ConversationMeta, HostToWebview } from '../src/panel/protocol.js';
import { vscode } from './vscodeApi.js';
import { Transcript, type TranscriptItem } from './components/Transcript.js';
import { Composer } from './components/Composer.js';
import { HistoryList } from './components/HistoryList.js';
import { AccountsView } from './components/AccountsView.js';
import { RulesView } from './components/RulesView.js';
import { IconPlus } from './components/icons.js';

declare global {
  interface Window {
    __USROUTER_MODE__?: 'sidebar' | 'tab' | 'accounts' | 'rules';
  }
}

const MODE: 'sidebar' | 'tab' | 'accounts' | 'rules' = window.__USROUTER_MODE__ ?? 'tab';

const HASHTAG_RE = /(^|\s)#([\w-]+)/g;

export function App() {
  if (MODE === 'sidebar') return <SidebarApp />;
  if (MODE === 'accounts') return <AccountsApp />;
  if (MODE === 'rules') return <RulesApp />;
  return <ChatApp />;
}

/** Center tab: routing rules. */
function RulesApp() {
  const [state, setState] = useState<Extract<HostToWebview, { kind: 'rules' }> | undefined>();

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      if (event.data.kind === 'rules') setState(event.data);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!state) return <div class="app" />;
  return (
    <div class="app">
      <RulesView rules={state.rules} path={state.path} exists={state.exists} error={state.error} />
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
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Follow the stream only while the user is already at the bottom —
  // scrolling up to read must never be fought.
  const pinnedRef = useRef(true);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      setItems((prev) => applyHostMessage(prev, msg));
      if (msg.kind === 'busy') setRunning(msg.running);
      if (msg.kind === 'accounts') setAccounts(msg.accounts);
      if (msg.kind === 'conversationReset') setItems([]);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ kind: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView();
  }, [items]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    const tags = [...trimmed.matchAll(HASHTAG_RE)].map((m) => m[2]!);
    pinnedRef.current = true;
    vscode.postMessage({ kind: 'send', text: trimmed, tags });
  };

  return (
    <div class="app chat-tab">
      <div
        class="scroll-area"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
        }}
      >
        <div class="chat-column">
          <Transcript
            items={items}
            noAccounts={accounts.length === 0}
            onAddAccount={() => vscode.postMessage({ kind: 'addAccount' })}
          />
          <div ref={bottomRef} />
        </div>
      </div>
      <div class="chat-column composer-holder">
        <Composer
          accounts={accounts}
          running={running}
          onSend={send}
          onCancel={() => vscode.postMessage({ kind: 'cancel' })}
        />
      </div>
    </div>
  );
}

function applyHostMessage(items: TranscriptItem[], msg: HostToWebview): TranscriptItem[] {
  const next = [...items];
  const lastAssistant = (id: string) => {
    for (let i = next.length - 1; i >= 0; i--) {
      const item = next[i];
      if (item?.kind === 'assistant' && item.messageId === id) return i;
    }
    return -1;
  };
  const ensureAssistant = (id: string) => {
    let i = lastAssistant(id);
    if (i === -1) {
      next.push({ kind: 'assistant', messageId: id, text: '', tools: [], done: false });
      i = next.length - 1;
    }
    return i;
  };

  switch (msg.kind) {
    case 'userEcho': {
      next.push({ kind: 'user', text: msg.text });
      break;
    }
    case 'routing': {
      const i = ensureAssistant(msg.messageId);
      next[i] = {
        ...(next[i] as Extract<TranscriptItem, { kind: 'assistant' }>),
        target: msg.target,
        ruleId: msg.ruleId,
        reason: msg.reason,
      };
      break;
    }
    case 'delta': {
      const i = ensureAssistant(msg.messageId);
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      next[i] = { ...item, text: item.text + msg.text };
      break;
    }
    case 'toolUse': {
      const i = ensureAssistant(msg.messageId);
      const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
      next[i] = { ...item, tools: [...item.tools, msg.detail ? `${msg.name}: ${msg.detail}` : msg.name] };
      break;
    }
    case 'downgraded': {
      next.push({ kind: 'notice', text: `model downgraded upstream: ${msg.from} → ${msg.to}` });
      break;
    }
    case 'failover': {
      const reset = msg.resetAt ? ` · resets ${new Date(msg.resetAt).toLocaleTimeString()}` : '';
      next.push({
        kind: 'failover',
        text: `${msg.reason}${reset} → ${msg.to.provider}:${msg.to.account}`,
      });
      next.push({
        kind: 'assistant',
        messageId: msg.messageId,
        text: '',
        tools: [],
        done: false,
        target: msg.to,
      });
      break;
    }
    case 'done': {
      const i = lastAssistant(msg.messageId);
      if (i !== -1) {
        const item = next[i] as Extract<TranscriptItem, { kind: 'assistant' }>;
        next[i] = { ...item, done: true, costUsd: msg.costUsd };
      }
      break;
    }
    case 'error': {
      next.push({ kind: 'error', text: msg.message });
      break;
    }
    default:
      break;
  }
  return next;
}
