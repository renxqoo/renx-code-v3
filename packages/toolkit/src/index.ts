import { createTask } from "@renx/core";

export interface BannerOptions {
  label: string;
  width?: number;
}

export const renderBanner = ({ label, width = 24 }: BannerOptions): string => {
  const content = ` ${label.trim()} `;
  const padding = Math.max(width - content.length, 0);
  const left = "=".repeat(Math.floor(padding / 2));
  const right = "=".repeat(Math.ceil(padding / 2));

  return `${left}${content}${right}`;
};

export const renderTaskBanner = (label: string): string => {
  const task = createTask(label);

  return renderBanner({ label: `${task.id}: ${task.title}`, width: 30 });
};
