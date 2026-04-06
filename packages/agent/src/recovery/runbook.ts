export interface RunbookRule {
  id: string;
  match: {
    errorCodes?: string[];
  };
  actions: string[];
}

export class RunbookService {
  constructor(private readonly rules: RunbookRule[]) {}

  resolve(error: { code: string; message: string }): {
    ruleId?: string;
    actions: string[];
  } {
    const matched = this.rules.find(
      (rule) => !rule.match.errorCodes || rule.match.errorCodes.includes(error.code),
    );
    return {
      ...(matched ? { ruleId: matched.id } : {}),
      actions: matched?.actions ?? [],
    };
  }
}
