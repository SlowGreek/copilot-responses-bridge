import { randomBytes, timingSafeEqual } from "node:crypto";
import { challengeProof } from "./security.js";

function equalText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left ?? "");
  const rightBuffer = Buffer.from(right ?? "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function verifyBridgeConnection({
  baseUrl,
  capability,
  instanceId,
  fetchImplementation = globalThis.fetch,
}) {
  if (typeof fetchImplementation !== "function") throw new Error("fetch implementation is required");
  const challenge = randomBytes(32).toString("base64url");
  const endpoint = new URL(baseUrl);
  endpoint.pathname = "/challenge";
  endpoint.search = "";
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge }),
    redirect: "error",
  });
  if (!response.ok) throw new Error("bridge challenge failed");
  const result = await response.json();
  if (!equalText(result.instance_id, instanceId)) throw new Error("bridge instance challenge mismatch");
  const expected = challengeProof(capability, challenge);
  if (!equalText(result.proof, expected)) throw new Error("bridge capability challenge mismatch");
  return {
    authorization: `Bearer ${capability}`,
    "x-copilot-bridge-instance": instanceId,
  };
}
