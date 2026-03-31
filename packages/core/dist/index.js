// src/index.ts
var createTask = (title) => {
  return {
    id: title.trim().toLowerCase().replace(/\s+/g, "-"),
    title: title.trim(),
    done: false
  };
};
var completeTask = (task) => {
  return {
    ...task,
    done: true
  };
};
export {
  completeTask,
  createTask
};
//# sourceMappingURL=index.js.map