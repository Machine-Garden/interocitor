export {};

declare global {
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }

  const WebSocketPair: {
    new (): [WebSocket, WebSocket] & { 0: WebSocket; 1: WebSocket };
  };
}
