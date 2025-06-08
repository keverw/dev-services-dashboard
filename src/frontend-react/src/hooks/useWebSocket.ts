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
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const sendAction = (serviceID: string, action: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action, serviceID }));
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
      setSocket(ws);
      onOpen();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
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
      setSocket(null);
      onClose();

      // Reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      onError();
    };
  };

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socket) {
        socket.close();
      }
    };
  }, []);

  return { socket, sendAction };
}
