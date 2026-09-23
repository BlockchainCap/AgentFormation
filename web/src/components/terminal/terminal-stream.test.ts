import { describe, expect, it } from "vitest";
import { sendTerminalInput, sendTerminalSize } from "./terminal-stream";

function receiver() {
  let expectedSequence = 0;
  let size = { rows: 0, cols: 0 };
  let input = "";
  const flags: number[] = [];
  const socket = {
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (!ArrayBuffer.isView(data))
        throw new Error("Expected binary stream data");
      const header = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      const sequence = header.getUint32(48) * 2 ** 32 + header.getUint32(52);
      if (sequence !== expectedSequence) return;
      expectedSequence++;
      flags.push(header.getUint32(60));
      const payload = new TextDecoder().decode(
        new Uint8Array(
          data.buffer,
          data.byteOffset + 120,
          data.byteLength - 120,
        ),
      );
      if (header.getUint32(112) === 3) size = JSON.parse(payload);
      else input += payload;
    },
  };
  return { socket, state: () => ({ size, input, flags, expectedSequence }) };
}

describe("terminal stream", () => {
  it("applies resizing and the first keystroke in one ordered session stream", () => {
    const agent = receiver();
    sendTerminalSize(agent.socket, { rows: 31, cols: 132 }, 0);
    sendTerminalInput(agent.socket, new TextEncoder().encode("hello"), 1);
    sendTerminalSize(agent.socket, { rows: 28, cols: 132 }, 2);
    sendTerminalSize(agent.socket, { rows: 15, cols: 71 }, 3);
    sendTerminalInput(agent.socket, new TextEncoder().encode(" 世界"), 4);
    expect(agent.state()).toEqual({
      size: { rows: 15, cols: 71 },
      input: "hello 世界",
      flags: [1, 0, 0, 0, 0],
      expectedSequence: 5,
    });
  });

  it("keeps desktop and mobile session sequences independent", () => {
    const desktop = receiver();
    const mobile = receiver();
    sendTerminalSize(desktop.socket, { rows: 28, cols: 132 }, 0);
    sendTerminalSize(mobile.socket, { rows: 30, cols: 71 }, 0);
    sendTerminalInput(desktop.socket, new TextEncoder().encode("a"), 1);
    sendTerminalSize(mobile.socket, { rows: 16, cols: 71 }, 1);
    expect(desktop.state()).toEqual({
      size: { rows: 28, cols: 132 },
      input: "a",
      flags: [1, 0],
      expectedSequence: 2,
    });
    expect(mobile.state()).toEqual({
      size: { rows: 16, cols: 71 },
      input: "",
      flags: [1, 0],
      expectedSequence: 2,
    });
  });
});
