declare module "shell-quote" {
  export type ParseEntry = string | { op: string } | { comment: string } | Record<string, string>;

  export function parse(s: string, env?: Record<string, string | undefined>): ParseEntry[];

  export function quote(args: string[]): string;
}
