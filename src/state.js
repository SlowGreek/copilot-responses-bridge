import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class BridgeState {
  constructor(destination) {
    this.destination = path.resolve(destination);
    this.data = { version: 1, references: {}, sessions: {} };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.destination, "utf8"));
      if (parsed?.version === 1 && parsed.references && parsed.sessions) this.data = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  sessionForReferences(references) {
    for (const reference of references) {
      const sessionId = this.data.references[reference];
      if (sessionId && this.data.sessions[sessionId]) return this.data.sessions[sessionId];
    }
    return undefined;
  }

  upsertSession(session) {
    this.data.sessions[session.sessionId] = {
      ...this.data.sessions[session.sessionId],
      ...session,
      pending: session.pending ?? this.data.sessions[session.sessionId]?.pending ?? {},
    };
    return this.flush();
  }

  remember(reference, sessionId) {
    if (!reference) return Promise.resolve();
    this.data.references[reference] = sessionId;
    return this.flush();
  }

  setPending(sessionId, callId, pending) {
    const session = this.data.sessions[sessionId];
    if (!session) return Promise.resolve();
    session.pending ??= {};
    session.pending[callId] = pending;
    return this.flush();
  }

  deletePending(sessionId, callId) {
    const session = this.data.sessions[sessionId];
    if (session?.pending) delete session.pending[callId];
    return this.flush();
  }

  flush() {
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.destination), { recursive: true });
        const temporary = `${this.destination}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.destination);
      });
    return this.writeQueue;
  }
}
