import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  auditLogs,
  formFields,
  orders,
} from "../../db/schema.js";
import { encryptField } from "../../lib/crypto.js";
import { HttpError } from "../../lib/errors.js";
import {
  computeVisibleFieldKeys,
  type FormFieldRecord,
} from "../forms/service.js";

interface SavedAnswersDto {
  applicantId: string;
  savedFields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function invalidValue(fieldKey: string): never {
  throw new HttpError(400, `Invalid value for field: ${fieldKey}`);
}

function validateValue(
  field: FormFieldRecord,
  fieldKey: string,
  value: unknown,
): void {
  switch (field.fieldType) {
    case "text":
    case "phone":
    case "email":
      if (typeof value !== "string") {
        invalidValue(fieldKey);
      }
      return;

    case "date":
      if (typeof value !== "string" || !isRealDate(value)) {
        invalidValue(fieldKey);
      }
      return;

    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        invalidValue(fieldKey);
      }
      return;

    case "radio":
    case "select": {
      const options = Array.isArray(field.options) ? field.options : [];

      if (!options.includes(value)) {
        invalidValue(fieldKey);
      }
      return;
    }

    case "checkbox":
      if (typeof value !== "boolean") {
        invalidValue(fieldKey);
      }
      return;

    case "country":
      if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) {
        invalidValue(fieldKey);
      }
      return;

    default:
      throw new Error(`Unsupported field_type: ${field.fieldType}`);
  }
}

export async function saveAnswers(
  applicantId: string,
  answers: Record<string, unknown>,
): Promise<SavedAnswersDto> {
  const [applicant] = await db
    .select({
      status: applicants.status,
      answers: applicants.answers,
      orderStatus: orders.status,
      visaProductId: orders.visaProductId,
      formVersion: orders.formVersion,
    })
    .from(applicants)
    .innerJoin(orders, eq(applicants.orderId, orders.id))
    .where(eq(applicants.id, applicantId))
    .limit(1);

  if (!applicant) {
    throw new HttpError(404, "Applicant not found");
  }

  if (
    applicant.status === "complete" ||
    applicant.orderStatus === "cancelled"
  ) {
    throw new HttpError(409, "Application is locked");
  }

  const fields = await db
    .select({
      fieldKey: formFields.fieldKey,
      label: formFields.label,
      fieldType: formFields.fieldType,
      required: formFields.required,
      options: formFields.options,
      sortOrder: formFields.sortOrder,
      groupKey: formFields.groupKey,
      visibleIf: formFields.visibleIf,
    })
    .from(formFields)
    .where(
      and(
        eq(formFields.visaProductId, applicant.visaProductId),
        eq(formFields.formVersion, applicant.formVersion),
        eq(formFields.step, "full"),
      ),
    )
    .orderBy(asc(formFields.sortOrder));

  const existingAnswers = isRecord(applicant.answers)
    ? applicant.answers
    : {};
  const mergedForVisibility = { ...existingAnswers, ...answers };
  const visibleKeys = computeVisibleFieldKeys(fields, mergedForVisibility);
  const fieldsByKey = new Map(
    fields.map((field) => [field.fieldKey, field]),
  );

  const savedFields: string[] = [];
  const storedAnswers: Record<string, unknown> = {};

  for (const [fieldKey, value] of Object.entries(answers)) {
    const field = fieldsByKey.get(fieldKey);

    if (!field) {
      throw new HttpError(400, `Unknown field: ${fieldKey}`);
    }

    if (!visibleKeys.has(fieldKey)) {
      throw new HttpError(400, `Field not visible: ${fieldKey}`);
    }

    validateValue(field, fieldKey, value);

    if (fieldKey === "passport_number") {
      if (typeof value !== "string") {
        invalidValue(fieldKey);
      }

      storedAnswers[fieldKey] = encryptField(value);
    } else {
      storedAnswers[fieldKey] = value;
    }

    savedFields.push(fieldKey);
  }

  const mergedAnswers = { ...existingAnswers, ...storedAnswers };

  await db.transaction(async (tx) => {
    await tx
      .update(applicants)
      .set({ answers: mergedAnswers })
      .where(eq(applicants.id, applicantId));

    await tx.insert(auditLogs).values({
      actorType: "customer",
      action: "applicant.answers_saved",
      entityType: "applicant",
      entityId: applicantId,
      metadata: { fields: savedFields },
    });
  });

  return { applicantId, savedFields };
}
