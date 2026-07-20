import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

test("startup rejects every non-literal-loopback bind before creating state", async () => {
  await assert.rejects(
    startServer({ HOST: "localhost", PORT: "4141" }),
    /literal loopback/,
  );
  await assert.rejects(
    startServer({ HOST: "0.0.0.0", PORT: "4141" }),
    /literal loopback/,
  );
  await assert.rejects(
    startServer({ HOST: "::1", PORT: "4141" }),
    /literal loopback/,
  );
});
