/** All stored monetary values are integer Malaysian sen. */
export const MAX_MONEY = 100_000_000_000;

export function parseMoney(text: string, allowZero = false): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(text.trim())) {
    throw new Error("Enter an amount with no more than two decimal places.");
  }
  const [whole, fraction = ""] = text.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (
    !Number.isSafeInteger(amount) ||
    amount > MAX_MONEY ||
    amount < (allowZero ? 0 : 1)
  ) {
    throw new Error(
      allowZero
        ? "Enter a valid non-negative amount."
        : "Amount must be greater than zero.",
    );
  }
  return amount;
}

export function formatMoney(sen: number) {
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
  }).format(sen / 100);
}

export function csv(rows: (string | number)[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          // User text must stay text in spreadsheet programs. Numeric amounts remain numeric.
          const text =
            typeof value === "string" && /^[\s]*[=+\-@＝＋－＠]/u.test(value)
              ? `\t${value}`
              : String(value);
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
