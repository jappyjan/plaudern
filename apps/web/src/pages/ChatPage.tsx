import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, Chip, Spinner, Textarea } from '@heroui/react';
import type {
  ChatCitation,
  ChatConversationDto,
  ChatMessageDto,
  ChatStatusDto,
} from '@plaudern/contracts';
import {
  askChat,
  deleteChatConversation,
  getChatConversation,
  getChatStatus,
  listChatConversations,
} from '../lib/api';
import { formatDate, formatDuration } from '../lib/format';
import { ChatIcon, PlayIcon, SendIcon } from '../components/icons';

/**
 * Memory chat (JJ-37): ask anything about the captured memory. Every answer
 * carries server-enforced citations — chips that open the source item and,
 * for transcript passages, seek the audio to the cited moment. Low-confidence
 * answers are visibly flagged ("I think — check the sources").
 */
export function ChatPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ChatStatusDto | null>(null);
  const [conversations, setConversations] = useState<ChatConversationDto[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getChatStatus().then(setStatus).catch(() => setStatus({ available: true, reason: null }));
    void refreshConversations();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, asking]);

  const refreshConversations = async () => {
    try {
      setConversations((await listChatConversations()).conversations);
    } catch {
      // The history list is a nicety; asking still works without it.
    }
  };

  const openConversation = async (id: string) => {
    setError(null);
    try {
      const detail = await getChatConversation(id);
      setConversationId(detail.conversation.id);
      setMessages(detail.messages);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startNew = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
  };

  const removeConversation = async (id: string) => {
    try {
      await deleteChatConversation(id);
      if (id === conversationId) startNew();
      await refreshConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const ask = async () => {
    const question = input.trim();
    if (!question || asking) return;
    setAsking(true);
    setError(null);
    setInput('');
    // Optimistic echo of the question while the answer is generated.
    const pending: ChatMessageDto = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content: question,
      citations: [],
      confidence: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, pending]);
    try {
      const res = await askChat(
        conversationId ? { conversationId, message: question } : { message: question },
      );
      setConversationId(res.conversationId);
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== pending.id),
        res.userMessage,
        res.assistantMessage,
      ]);
      void refreshConversations();
    } catch (cause) {
      setMessages((prev) => prev.filter((m) => m.id !== pending.id));
      setInput(question); // let the user retry without retyping
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  const openCitation = (citation: ChatCitation) => {
    const seek =
      citation.startSeconds !== null ? `?t=${Math.max(0, Math.floor(citation.startSeconds))}` : '';
    navigate(`/items/${citation.inboxItemId}${seek}`);
  };

  return (
    <div className="flex flex-col gap-4 pb-28">
      <div className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ChatIcon className="h-5 w-5" />
          Ask your memory
        </h1>
        <Button size="sm" variant="flat" onPress={startNew} isDisabled={asking}>
          New chat
        </Button>
      </div>

      {status && !status.available && (
        <div className="rounded-medium bg-warning-50 p-3 text-sm text-warning-700">
          {status.reason ?? 'Memory chat is not configured on this server.'}
        </div>
      )}

      {conversations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {conversations.slice(0, 8).map((c) => (
            <Chip
              key={c.id}
              size="sm"
              variant={c.id === conversationId ? 'solid' : 'flat'}
              color={c.id === conversationId ? 'primary' : 'default'}
              className="max-w-56 cursor-pointer"
              onClose={() => void removeConversation(c.id)}
              onClick={() => void openConversation(c.id)}
            >
              {c.title ?? formatDate(c.createdAt)}
            </Chip>
          ))}
        </div>
      )}

      {messages.length === 0 && !asking && (
        <p className="text-sm text-default-500">
          Ask anything you once captured — “What did the doctor say about the dosage?”, “When did
          I last talk to Karsten and what about?”. Every answer cites its sources; a citation
          jumps to the exact moment in the audio.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="self-end">
              <Card className="max-w-[85%] min-w-40 bg-primary-50">
                <CardBody className="px-3 py-2">
                  <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                </CardBody>
              </Card>
            </div>
          ) : (
            <AssistantMessage key={message.id} message={message} onOpenCitation={openCitation} />
          ),
        )}
        {asking && (
          <div className="flex items-center gap-2 text-sm text-default-500">
            <Spinner size="sm" /> Searching your memory…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="rounded-medium bg-danger-50 p-3 text-sm text-danger">{error}</div>}

      <div className="flex items-end gap-2">
        <Textarea
          minRows={1}
          maxRows={4}
          placeholder="Ask your memory…"
          value={input}
          onValueChange={setInput}
          isDisabled={asking || status?.available === false}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
          aria-label="Question"
        />
        <Button
          isIconOnly
          color="primary"
          aria-label="Send"
          isDisabled={!input.trim() || asking || status?.available === false}
          onPress={() => void ask()}
        >
          <SendIcon className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  onOpenCitation,
}: {
  message: ChatMessageDto;
  onOpenCitation: (citation: ChatCitation) => void;
}) {
  const byMarker = new Map(message.citations.map((c) => [c.marker, c]));
  return (
    <Card className="max-w-[95%] self-start">
      <CardBody className="gap-2 px-3 py-2">
        {message.confidence === 'low' && (
          <Chip size="sm" variant="flat" color="warning" className="self-start">
            I think — check the sources
          </Chip>
        )}
        <p className="whitespace-pre-wrap text-sm">
          <AnswerText content={message.content} byMarker={byMarker} onOpen={onOpenCitation} />
        </p>
        {message.citations.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t border-default-100 pt-2">
            {message.citations.map((citation) => (
              <Chip
                key={citation.marker}
                size="sm"
                variant="flat"
                color="primary"
                className="max-w-64 cursor-pointer"
                startContent={
                  citation.startSeconds !== null ? (
                    <PlayIcon className="h-3 w-3" />
                  ) : undefined
                }
                onClick={() => onOpenCitation(citation)}
              >
                [{citation.marker}] {citation.title ?? 'Untitled'}
                {citation.startSeconds !== null && ` · ${formatDuration(citation.startSeconds)}`}
                {` · ${formatDate(citation.occurredAt)}`}
              </Chip>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Renders inline `[n]` markers as tappable superscript citation links. */
function AnswerText({
  content,
  byMarker,
  onOpen,
}: {
  content: string;
  byMarker: Map<number, ChatCitation>;
  onOpen: (citation: ChatCitation) => void;
}) {
  const parts = content.split(/(\[\d{1,3}\])/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\[(\d{1,3})\]$/.exec(part);
        const citation = match ? byMarker.get(Number(match[1])) : undefined;
        if (!citation) return <Fragment key={index}>{part}</Fragment>;
        return (
          <sup key={index}>
            <button
              type="button"
              className="px-0.5 font-medium text-primary hover:underline"
              onClick={() => onOpen(citation)}
              aria-label={`Open source ${citation.marker}`}
            >
              [{citation.marker}]
            </button>
          </sup>
        );
      })}
    </>
  );
}
