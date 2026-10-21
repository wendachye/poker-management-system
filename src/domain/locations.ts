import { z } from "zod";
export const locationCommandSchema = z
  .object({
    kind: z.literal("CREATE_LOCATION"),
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
    name: z.string().trim().min(1).max(200),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict();
export type LocationCommand = z.infer<typeof locationCommandSchema>;
