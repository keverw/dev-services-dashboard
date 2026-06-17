import { useEffect, useRef, useState } from "react";
import { WebSocketMessage } from "../types";

interface UseWebSocketOptions {
  onMessage: (data: WebSocketMessage) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: () => void;
}

export function useWebSocket({
  onMessage,
  onOpen,
  onClose,
  onError,
}: UseWebSocketOptions) {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const isUnmountedRef = useRef(false);

  // The socket's event handlers are bound once (on mount), so without this they
  // would close over the callbacks from the first render forever — meaning
  // handlers like onClose/onMessage would see stale state (e.g. an empty
  // service list). Mirror the latest callbacks into a ref each render so the
  // handlers always invoke the current versions.
  const callbacksRef = useRef({ onMessage, onOpen, onClose, onError });
  useEffect(() => {
    callbacksRef.current = { onMessage, onOpen, onClose, onError };
  });

  const sendAction = (
    serviceID: string,
    action: string,
    payload?: Record<string, unknown>,
  ) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, serviceID, ...payload }));
    } else {
      console.error("WebSocket not connected.");
    }
  };

  const sendGlobalAction = (action: string) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action }));
    } else {
      console.error("WebSocket not connected.");
    }
  };

  const connectWebSocket = () => {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("WebSocket connected.");
      socketRef.current = ws;
      setSocket(ws);
      callbacksRef.current.onOpen();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        callbacksRef.current.onMessage(data);
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };

    ws.onclose = (event) => {
      console.log(
        "WebSocket disconnected. Code:",
        event.code,
        "Reason:",
        event.reason,
        "WasClean:",
        event.wasClean,
      );
      socketRef.current = null;
      setSocket(null);
      callbacksRef.current.onClose();

      // Reconnect after 3 seconds, unless the component has unmounted.
      if (!isUnmountedRef.current) {
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      callbacksRef.current.onError();
    };
  };

  useEffect(() => {
    isUnmountedRef.current = false;
    connectWebSocket();

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
    // Connect exactly once on mount; reconnection is handled internally by the
    // onclose handler, and the latest callbacks are read from callbacksRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { socket, sendAction, sendGlobalAction };
}
