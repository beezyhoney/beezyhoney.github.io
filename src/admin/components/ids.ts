// Small helpers shared by the field components.

let counter = 0;

/** A stable-enough id for a field: the given id, or one made from the name (unique within a render). */
export function fieldId(name: string, id?: string): string {
  if (id) return id;
  counter = (counter + 1) % 1_000_000;
  return `f-${name.replace(/[^A-Za-z0-9_-]/g, '-')}-${counter}`;
}

/** aria-describedby for a control with optional hint and error. */
export function describedBy(id: string, hint?: string | null, error?: string | null, extra?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-err` : '', extra ?? ''].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}
