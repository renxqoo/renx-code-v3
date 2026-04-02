/**
 * Quote-aware extraction of simple output redirection targets for path policy.
 * Fails closed: ambiguous targets (substitutions, heredocs) set hasAmbiguousRedirections.
 */

export interface RedirectExtractResult {
  targets: string[];
  hasAmbiguousRedirections: boolean;
}

/**
 * Scan for `>` / `>>` / `&>` at shell top level (not inside quotes).
 * Does not fully parse shell; treats `$(`, backticks, and `<<` as ambiguous.
 */
export function extractOutputRedirectTargets(command: string): RedirectExtractResult {
  const targets: string[] = [];
  let ambiguous = false;

  if (command.includes("<<")) {
    ambiguous = true;
  }
  if (/\$\([^)]*$/.test(command)) {
    ambiguous = true;
  }

  let i = 0;
  let single = false;
  let double = false;
  let escape = false;

  const skipWs = (j: number): number => {
    let k = j;
    while (k < command.length && /\s/.test(command[k]!)) {
      k++;
    }
    return k;
  };

  while (i < command.length) {
    const c = command[i]!;
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (!double && c === "\\") {
      escape = true;
      i++;
      continue;
    }
    if (!double && c === "'") {
      single = !single;
      i++;
      continue;
    }
    if (!single && c === '"') {
      double = !double;
      i++;
      continue;
    }

    if (!single && !double) {
      if (command.startsWith("$(", i) || c === "`") {
        ambiguous = true;
      }

      const two = command.slice(i, i + 2);
      const three = command.slice(i, i + 3);

      let redirLen = 0;
      if (three === ">>&" || three === "&>>") {
        ambiguous = true;
        i += 3;
        continue;
      }
      if (two === ">>") {
        redirLen = 2;
      } else if (two === "&>") {
        redirLen = 2;
      } else if (c === ">") {
        redirLen = 1;
      }

      if (redirLen > 0) {
        let j = i + redirLen;
        j = skipWs(j);
        if (j < command.length && command[j]! === "&") {
          ambiguous = true;
          i = j + 1;
          continue;
        }
        if (j < command.length && /^\d/.test(command[j]!)) {
          const fd = command.slice(j).match(/^(\d+)/);
          if (fd && command[j + fd[0].length] === ">") {
            j = skipWs(j + fd[0].length + (command[j + fd[0].length + 1] === ">" ? 2 : 1));
          }
        }

        let target = "";
        let sq = false;
        let dq = false;
        let esc2 = false;
        while (j < command.length) {
          const ch = command[j]!;
          if (esc2) {
            target += ch;
            esc2 = false;
            j++;
            continue;
          }
          if (!dq && ch === "\\") {
            esc2 = true;
            j++;
            continue;
          }
          if (!dq && ch === "'") {
            sq = !sq;
            j++;
            continue;
          }
          if (!sq && ch === '"') {
            dq = !dq;
            j++;
            continue;
          }
          if (!sq && !dq && /[\s;|&)]>]/.test(ch)) {
            break;
          }
          target += ch;
          j++;
        }

        const stripped = target.replace(/^['"]|['"]$/g, "").trim();
        if (stripped.length === 0) {
          ambiguous = true;
        } else if (/[\$\*`]/.test(stripped) || /[{[*?]/.test(stripped)) {
          ambiguous = true;
        } else {
          targets.push(stripped);
        }
        i = j;
        continue;
      }
    }
    i++;
  }

  return { targets, hasAmbiguousRedirections: ambiguous };
}
