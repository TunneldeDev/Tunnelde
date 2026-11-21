import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSettingsCommand, useSettingsOwner } from "@/features/settings/window/mainBinding";
import type { ProxyProfile } from "@/lib/api/network";
import type { SettingsWindowCommand } from "@/features/settings/window/protocol";
const edit = { profile: { id: "proxy" } as ProxyProfile, credential: { action: "save" as const } };
function owner() {
  const save = vi.fn(async () => ({ credentialError: null }));
  useSettingsOwner.setState({
    handlers: { network_saveProfile: save } as unknown as NonNullable<
      ReturnType<typeof useSettingsOwner.getState>["handlers"]
    >,
  });
  return save;
}
afterEach(() => useSettingsOwner.setState({ handlers: null, projection: null }));
describe("main Settings private credential execution", () => {
  it("obtains password only from the private owner reader, not the action job", async () => {
    const save = owner(),
      read = vi.fn(async () => "private-owner-secret");
    const command: SettingsWindowCommand = { operation: "network_saveProfile", args: [edit] };
    await executeSettingsCommand(command, read);
    expect(save).toHaveBeenCalledWith({
      ...edit,
      credential: { action: "save", password: "private-owner-secret" },
    });
    expect(JSON.stringify(command)).not.toContain("private-owner-secret");
    await executeSettingsCommand(
      { operation: "network_saveProfile", args: [{ ...edit, credential: { action: "keep" } }] },
      read,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("rejects injected plaintext fields rather than treating the action as credential authority", async () => {
    const save = owner(),
      read = vi.fn(async () => "private-owner-secret");
    await expect(
      executeSettingsCommand(
        {
          operation: "network_saveProfile",
          args: [{ ...edit, credential: { action: "save", password: "injected" } }],
        } as unknown as SettingsWindowCommand,
        read,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("rejects a closed or replaced owner after an in-flight private read", async () => {
    const save = owner(),
      controller = new AbortController();
    await expect(
      executeSettingsCommand(
        { operation: "network_saveProfile", args: [edit] },
        async () => {
          controller.abort();
          return "private";
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    await expect(
      executeSettingsCommand({ operation: "network_saveProfile", args: [edit] }, async () => {
        useSettingsOwner.setState({ handlers: null });
        return "private";
      }),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
