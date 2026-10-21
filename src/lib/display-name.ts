/** Format sample names for presentation without changing the stored record. */
export function displayName(name: string): string {
  return name.replace(/^Sample\s*·\s*/, "") || name;
}
