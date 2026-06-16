import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonlRpcClient } from "../src/main/codex/jsonlRpc";

describe("JsonlRpcClient", () => {
  it("writes JSONL requests and resolves matching responses", async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const client = new JsonlRpcClient(serverToClient, clientToServer);

    const writes: string[] = [];
    clientToServer.on("data", (chunk) => writes.push(chunk.toString("utf8")));

    const promise = client.request<{ ok: true }>("thread/loaded/list");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = JSON.parse(writes.join("").trim());
    expect(sent).toEqual({ id: 1, method: "thread/loaded/list" });

    serverToClient.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("emits notifications without treating them as responses", async () => {
    const client = new JsonlRpcClient(new PassThrough(), new PassThrough());
    const listener = vi.fn();
    client.on("notification", listener);

    (client as unknown as { handleData(chunk: string): void }).handleData(
      `${JSON.stringify({ method: "thread/status/changed", params: { threadId: "thr_1" } })}\n`
    );

    expect(listener).toHaveBeenCalledWith({
      method: "thread/status/changed",
      params: { threadId: "thr_1" }
    });
  });
});
