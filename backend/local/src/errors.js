/**
 * Errors the local store throws for a request it refuses. `code` is stable and meant for the UI to branch on:
 *   invalid_input        a field is missing, has the wrong type or format, or is too long (`field` names it)
 *   empty_memo           a memo would have no title, body or handwriting
 *   not_found            no such memo, task, proposal or workspace in the current workspace
 *   revision_conflict    an update named an expectedRevision that is no longer current
 *   source_changed       the memo an AI proposal came from was edited or deleted after the analysis
 *   already_processed    the proposal was already approved, rejected or replaced by a newer analysis
 *   name_taken           another workspace already has this name
 *   personal_workspace   the personal workspace cannot be deleted
 * Any other error (a SQLite failure, a programming error) is not a LocalError and means the write did not happen.
 */
export class LocalError extends Error {
  constructor(code, field) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'LocalError';
    this.code = code;
    if (field) this.field = field;
  }
}

export function fail(code, field) {
  throw new LocalError(code, field);
}
