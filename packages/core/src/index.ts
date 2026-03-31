export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export const createTask = (title: string): Task => {
  return {
    id: title.trim().toLowerCase().replace(/\s+/g, "-"),
    title: title.trim(),
    done: false,
  };
};

export const completeTask = (task: Task): Task => {
  return {
    ...task,
    done: true,
  };
};
