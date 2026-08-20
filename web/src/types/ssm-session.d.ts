declare module "ssm-session" {
  interface TermOptions {
    rows: number;
    cols: number;
  }

  interface InitOptions {
    token: string;
    termOptions: TermOptions;
  }

  interface AgentMessage {
    headerLength: number;
    messageType: string;
    schemaVersion: number;
    createdDate: number;
    sequenceNumber: number;
    flags: number;
    messageId: string;
    payloadDigest: string;
    payloadType: number;
    payloadLength: number;
    payload: ArrayBuffer;
  }

  export const ssm: {
    init(socket: WebSocket, options: InitOptions): void;
    decode(data: ArrayBuffer): AgentMessage;
    sendACK(socket: WebSocket, message: AgentMessage): void;
    sendText(
      socket: WebSocket,
      data: Uint8Array,
      sequenceNumber?: number,
    ): void;
    sendInitMessage(socket: WebSocket, termOptions: TermOptions): void;
  };
}
