// src/index.ts
import { createTask } from "@renx/core";
var renderBanner = ({ label, width = 24 }) => {
  const content = ` ${label.trim()} `;
  const padding = Math.max(width - content.length, 0);
  const left = "=".repeat(Math.floor(padding / 2));
  const right = "=".repeat(Math.ceil(padding / 2));
  return `${left}${content}${right}`;
};
var renderTaskBanner = (label) => {
  const task = createTask(label);
  return renderBanner({ label: `${task.id}: ${task.title}`, width: 30 });
};
export {
  renderBanner,
  renderTaskBanner
};
//# sourceMappingURL=index.js.map