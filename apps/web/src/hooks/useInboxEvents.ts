import { useEffect, useRef } from 'react';
import { inboxEventSchema, type InboxEvent } from '@plaudern/contracts';

interface InboxEventHandlers {
  onEvent: (event: InboxEvent) => void;
  /** Fired when the stream (re)connects after being down — refetch to catch up. */
  onReconnect?: () => void;
}

/**
 * Subscribes to the server's SSE stream for live inbox updates. The browser's
 * EventSource reconnects automatically; missed events are recovered by the
 * caller refetching in onReconnect rather than by any replay mechanism.
 */
export function useInboxEvents(handlers: InboxEventHandlers): void {
  // Keep handlers in a ref so the EventSource is created exactly once.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/v1/events');
    let wasDown = false;

    source.onopen = () => {
      if (wasDown) {
        wasDown = false;
        handlersRef.current.onReconnect?.();
      }
    };
    source.onerror = () => {
      wasDown = true;
    };
    source.onmessage = (message) => {
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = inboxEventSchema.safeParse(data);
      if (!parsed.success || parsed.data.type === 'heartbeat') return;
      handlersRef.current.onEvent(parsed.data);
    };

    return () => source.close();
  }, []);
}
