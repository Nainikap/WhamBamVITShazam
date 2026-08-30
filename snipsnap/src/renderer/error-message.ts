interface ValidationIssue {
  message?: unknown;
  path?: unknown;
}

const MAX_ERROR_LENGTH = 360;

function validationIssue(value: string): ValidationIssue | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const issue = parsed[0];
    return issue && typeof issue === 'object' ? issue as ValidationIssue : null;
  } catch {
    return null;
  }
}

/** Turn IPC and schema failures into a bounded message suitable for the UI. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/^Error invoking remote method '[^']+': Error: /u, '').trim();
  const issue = validationIssue(cleaned);
  if (issue) {
    const path = Array.isArray(issue.path)
      ? issue.path.map(String).join('.')
      : '';
    const detail = typeof issue.message === 'string' ? issue.message : 'Invalid value';
    return path
      ? `The selected timeline is invalid at ${path}: ${detail}`
      : `The selected timeline is invalid: ${detail}`;
  }
  if (cleaned.length <= MAX_ERROR_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}
