import { ssm } from "ssm-session";

type TerminalSocket = Pick<WebSocket, "send">;
type TerminalSize = { rows: number; cols: number };

function sendStreamMessage(
  socket: TerminalSocket,
  data: Uint8Array,
  sequenceNumber: number,
  payloadType: 1 | 3,
) {
  const message = ssm.buildInputMessage(data, sequenceNumber);
  const header = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  );
  // AWS numbers input and resize messages in the same per-session stream.
  header.setUint32(56, 0);
  header.setUint32(60, sequenceNumber === 0 ? 1 : 0);
  header.setUint32(112, payloadType);
  socket.send(message);
}

export function sendTerminalInput(
  socket: TerminalSocket,
  data: Uint8Array,
  sequenceNumber: number,
) {
  sendStreamMessage(socket, data, sequenceNumber, 1);
}

export function sendTerminalSize(
  socket: TerminalSocket,
  size: TerminalSize,
  sequenceNumber: number,
) {
  sendStreamMessage(
    socket,
    new TextEncoder().encode(JSON.stringify(size)),
    sequenceNumber,
    3,
  );
}
