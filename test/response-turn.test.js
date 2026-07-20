import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ResponsesTurn } from "../src/response-turn.js";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.data = "";
    this.writableEnded = false;
  }
  writeHead() {}
  write(chunk) {
    this.data += chunk;
  }
  end(chunk = "") {
    this.data += chunk;
    this.writableEnded = true;
  }
}

function events(response) {
  return response.data.trim().split("\n\n").map((block) => {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "));
    return JSON.parse(line.slice(6));
  });
}

test("fails closed when provider output exceeds the configured bound", async () => {
  const response = new FakeResponse();
  const turn = new ResponsesTurn({
    response,
    request: {
      model: "fake-model",
      input: [],
      tools: [],
      stream: true,
      store: false,
    },
    maxOutputBytes: 8,
  });
  turn.delta("123456789");
  await turn.wait();
  const terminal = events(response).at(-1);
  assert.equal(terminal.type, "response.failed");
  assert.equal(terminal.response.error.code, "provider_output_too_large");
});

test("bounds citation metadata and ignores credentialed URLs", async () => {
  const response = new FakeResponse();
  const turn = new ResponsesTurn({
    response,
    request: {
      model: "fake-model",
      input: [],
      tools: [{ type: "web_search" }],
      stream: true,
      store: false,
    },
  });
  turn.webSearchProgress({ status: "searching", query: "facts" });
  turn.setCitations({
    sources: [
      { title: "safe", url: "https://example.com/source" },
      { title: "unsafe", url: "https://user:pass@example.com/private" },
    ],
  });
  turn.delta("answer");
  turn.finishText("answer");
  await turn.wait();
  const search = events(response).find((event) =>
    event.type === "response.output_item.done" && event.item.type === "web_search_call");
  assert.deepEqual(search.item.results, [{
    type: "url_citation",
    title: "safe",
    url: "https://example.com/source",
  }]);
});
