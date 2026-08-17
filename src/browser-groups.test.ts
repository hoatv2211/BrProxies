import { describe, expect, it } from "vitest";

import { deleteGroupFromRegistry, renameGroupInRegistry } from "./browser-groups";

describe("browser group registry", () => {
  it("renames a group without duplicating an existing registry entry", () => {
    expect(renameGroupInRegistry(["Account Keeper", "GPT"], "Account Keeper", "Managed GPT"))
      .toEqual(["Managed GPT", "GPT"]);
    expect(renameGroupInRegistry(["Account Keeper", "GPT"], "Account Keeper", "GPT"))
      .toEqual(["GPT"]);
  });

  it("deletes only the requested group from the registry", () => {
    expect(deleteGroupFromRegistry(["Account Keeper", "GPT"], "Account Keeper"))
      .toEqual(["GPT"]);
  });
});
