import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcFailure, JsonRpcIncoming } from "./types";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JsonlRpcClientEvents {
  notification: (message: { method: string; params?: unknown }) => void;
  serverRequest: (message: { id: number | string; method: string; params?: unknown }) => void;
  parseError: (error: Error, line: string) => void;
  close: (error: Error | null) => void;
}

export class JsonlRpcClient extends EventEmitter {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest<unknown>>();
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    super();
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => this.handleData(chunk));
    this.input.on("end", () => this.close(null));
    this.input.on("error", (error) => this.close(error));
    this.output.on("error", (error) => this.close(error));
  }

  request<T>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("JSONL RPC client is closed"));
    }

    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });

      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }

    this.write(params === undefined ? { method } : { method, params });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) {
      return;
    }

    this.write({ id, error: { code, message } });
  }

  destroy(error: Error | null = null): void {
    this.close(error);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (rawLine.length === 0) {
        continue;
      }

      try {
        this.handleMessage(JSON.parse(rawLine) as JsonRpcIncoming);
      } catch (error) {
        this.emit("parseError", error instanceof Error ? error : new Error(String(error)), rawLine);
      }
    }
  }

  private handleMessage(message: JsonRpcIncoming): void {
    if ("method" in message && "id" in message) {
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        params: message.params
      });
      return;
    }

    if ("method" in message) {
      this.emit("notification", {
        method: message.method,
        params: message.params
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if ("error" in message) {
      pending.reject(toRpcError(message));
      return;
    }

    pending.resolve(message.result);
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private close(error: Error | null): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("JSONL RPC stream closed"));
    }

    this.pending.clear();
    this.emit("close", error);
  }
}

function toRpcError(message: JsonRpcFailure): Error {
  const error = new Error(message.error.message);
  error.name = `JsonRpcError ${message.error.code}`;
  return error;
}
