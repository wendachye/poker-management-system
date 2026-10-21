export function fieldError(
  value: string,
  rules: {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    money?: boolean;
    phone?: boolean;
    date?: boolean;
    minDate?: string;
    maxDate?: string;
  },
) {
  const text = value.trim();
  if (rules.required && !text) return "This field is required.";
  if (!text) return "";
  if (rules.date) {
    const time = Date.parse(text + "T00:00:00Z");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== text
    )
      return "Choose a valid date.";
    if (rules.minDate && text < rules.minDate)
      return "Choose a date on or after the minimum allowed date.";
    if (rules.maxDate && text > rules.maxDate)
      return "Choose a date on or before the maximum allowed date.";
  }
  if (rules.money && !/^\d+(\.\d{1,2})?$/.test(text))
    return "Enter an amount with up to two decimal places.";
  if (rules.phone && !/^\+[1-9]\d{7,14}$/.test(text.replace(/[\s()-]/g, "")))
    return "Enter a country code and phone number, for example +60123456789.";
  if (rules.minLength && text.length < rules.minLength)
    return rules.minLength === 3
      ? "Please provide at least three characters."
      : `Use at least ${rules.minLength} characters.`;
  if (
    rules.maxLength !== undefined &&
    rules.maxLength >= 0 &&
    text.length > rules.maxLength
  )
    return "This value is too long.";
  return "";
}
