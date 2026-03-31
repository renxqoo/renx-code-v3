export interface Task {
    id: string;
    title: string;
    done: boolean;
}
export declare const createTask: (title: string) => Task;
export declare const completeTask: (task: Task) => Task;
//# sourceMappingURL=index.d.ts.map