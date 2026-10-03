import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/rc2-client.ts", import.meta.url), "utf8");

describe("watch panel input and capture status", () => {
  it("has one scoped Sidebar view without a separate floating Browser entry", () => {
    expect(source).toContain("id: 'ego-browser:watch'");
    expect(source).toContain('key: props.scope.sessionId');
    expect(source).not.toMatch(/mountFloatingWatch|dsh-ego-fab/);
    expect(source).toContain('onOpenUrl:');
  });

  it("does not gate control input on stream state or default missing status to CDP", () => {
    expect(source).toContain("current.control.state !== 'human'");
    expect(source).toContain('leaseEpoch: current.control.leaseEpoch');
    expect(source).toContain('data.sessionId !== sessionId');
    expect(source).toContain('data.hostGeneration !== generation');
    expect(source).toContain('data.targetId !== targetId');
  });

  it("does not mount the unsupported global video stream or login import controls", () => {
    expect(source).not.toContain('/api/ego/video');
    expect(source).not.toContain('/api/ego/login-import');
    expect(source).not.toContain('/api/ego/raise');
  });
});
