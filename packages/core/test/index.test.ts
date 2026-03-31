import { describe, expect, it } from "vitest";

import { completeTask, createTask } from "../src/index";

describe("core task helpers", () => {
  it("creates a normalized task", () => {
    expect(createTask("Ship CI")).toEqual({
      id: "ship-ci",
      title: "Ship CI",
      done: false,
    });
  });

  it("marks a task as done", () => {
    expect(completeTask(createTask("Write tests")).done).toBe(true);
  });
});
