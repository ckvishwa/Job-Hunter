export function extractRequiredYears(text: string): number | null {
  const match = text.match(/(\d{1,2})\+?\s*(?:years|yrs)\b/i);
  return match ? Number(match[1]) : null;
}
