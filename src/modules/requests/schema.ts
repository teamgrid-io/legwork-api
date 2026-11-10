import { z } from "zod";

const iso2Schema = z
  .string()
  .regex(/^[A-Za-z]{2}$/, { error: "Must be a 2-letter country code" })
  .transform((value) => value.toUpperCase());

const applicantSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, { error: "fullName must be at least 2 characters" })
      .max(120, { error: "fullName must be at most 120 characters" }),
    dateOfBirth: z.iso
      .date({ error: "dateOfBirth must be a valid YYYY-MM-DD date" })
      .optional(),
    nationalityIso2: iso2Schema.optional(),
    gender: z.enum(["male", "female", "other"], {
      error: "gender must be male, female, or other",
    }),
    maritalStatus: z.enum(["single", "married", "divorced", "widowed"], {
      error:
        "maritalStatus must be single, married, divorced, or widowed",
    }),
  })
  .strict();

export const createRequestSchema = z
  .object({
    destinationIso2: iso2Schema,
    passportIso2: iso2Schema,
    travelDate: z.iso.date({
      error: "travelDate must be a valid YYYY-MM-DD date",
    }),
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email({ error: "contactEmail must be a valid email" })),
    contactPhone: z
      .string()
      .trim()
      .max(30, { error: "contactPhone must be at most 30 characters" })
      .optional(),
    applicants: z
      .array(applicantSchema)
      .min(1, { error: "At least 1 applicant is required" })
      .max(2, { error: "At most 2 applicants are allowed" }),
  })
  .strict();

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
