import { test } from "node:test";
import assert from "node:assert/strict";
import { LineBuffer } from "../src/main/engine/backends/types.js";

test("JSON lines preserve UTF-8 split across arbitrary stdout chunks", () => {
  const text = '{"text":"日本語 🌸 café"}\r\n';
  const bytes = Buffer.from(text);
  for (let split = 1; split < bytes.length; split++) {
    const lines: string[] = [];
    const buffer = new LineBuffer();
    buffer.push(bytes.subarray(0, split), (line) => lines.push(line));
    buffer.push(bytes.subarray(split), (line) => lines.push(line));
    buffer.flush((line) => lines.push(line));
    assert.deepEqual(lines, [text.trim()], `byte ${split}`);
  }
});
