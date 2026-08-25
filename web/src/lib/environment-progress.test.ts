import { describe, expect, it } from "vitest";
import { stageFromStackEvents } from "./environment-progress";

describe("environment progress", () => {
  it("starts with private access creation", () => {
    expect(stageFromStackEvents([])).toBe("creating_access");
  });

  it.each([
    ["RuntimeRole", "CREATE_IN_PROGRESS", "creating_access"],
    ["RuntimeInstanceProfile", "CREATE_IN_PROGRESS", "attaching_access"],
    ["RuntimeInstance", "CREATE_IN_PROGRESS", "starting_machine"],
    ["RuntimeInstance", "CREATE_COMPLETE", "finishing"],
  ])("maps %s %s to %s", (logicalResourceId, resourceStatus, stage) => {
    expect(stageFromStackEvents([{ logicalResourceId, resourceStatus }])).toBe(
      stage,
    );
  });

  it("ignores unrelated stack resources", () => {
    expect(
      stageFromStackEvents([
        {
          logicalResourceId: "UnrelatedResource",
          resourceStatus: "CREATE_COMPLETE",
        },
      ]),
    ).toBe("creating_access");
  });
});
