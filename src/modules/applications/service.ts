import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  auditLogs,
  documents,
  formFields,
  orders,
  visaProducts,
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

interface SubmittedApplicationDto {
  applicantId: string;
  status: "complete";
  submittedAt: Date;
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

export async function submitApplication(
  applicantId: string,
): Promise<SubmittedApplicationDto> {
  const [applicant] = await db
    .select({
      status: applicants.status,
      answers: applicants.answers,
      orderStatus: orders.status,
      orderNumber: orders.orderNumber,
      visaProductId: orders.visaProductId,
      formVersion: orders.formVersion,
      requiredDocuments: visaProducts.requiredDocuments,
    })
    .from(applicants)
    .innerJoin(orders, eq(applicants.orderId, orders.id))
    .innerJoin(
      visaProducts,
      eq(orders.visaProductId, visaProducts.id),
    )
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

  const storedAnswers = isRecord(applicant.answers)
    ? applicant.answers
    : {};
  const visibleKeys = computeVisibleFieldKeys(fields, storedAnswers);

  const cleanedAnswers: Record<string, unknown> = {};

  for (const [fieldKey, value] of Object.entries(storedAnswers)) {
    if (visibleKeys.has(fieldKey)) {
      cleanedAnswers[fieldKey] = value;
    }
  }

  const hasHiddenAnswers = Object.keys(storedAnswers).some(
    (fieldKey) =>
      !Object.prototype.hasOwnProperty.call(cleanedAnswers, fieldKey),
  );

  if (hasHiddenAnswers) {
    await db
      .update(applicants)
      .set({ answers: cleanedAnswers })
      .where(eq(applicants.id, applicantId));
  }

  const missingAnswers: string[] = [];

  for (const field of fields) {
    if (!field.required || !visibleKeys.has(field.fieldKey)) {
      continue;
    }

    const value = cleanedAnswers[field.fieldKey];

    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      missingAnswers.push(field.fieldKey);
    }
  }

  if (missingAnswers.length > 0) {
    throw new HttpError(
      400,
      `Missing required answers: ${missingAnswers.join(", ")}`,
    );
  }

  const requiredDocuments = Array.isArray(applicant.requiredDocuments)
    ? applicant.requiredDocuments.filter(
        (value): value is string => typeof value === "string",
      )
    : [];

  let missingDocuments: string[] = [];

  if (requiredDocuments.length > 0) {
    const availableDocuments = await db
      .select({ documentType: documents.documentType })
      .from(documents)
      .where(
        and(
          eq(documents.applicantId, applicantId),
          eq(documents.status, "verified"),
        ),
      );

    const availableTypes = new Set(
      availableDocuments.map((document) => document.documentType),
    );

    missingDocuments = requiredDocuments.filter(
      (documentType) => !availableTypes.has(documentType),
    );
  }

  if (missingDocuments.length > 0) {
    throw new HttpError(
      400,
      `Missing required documents: ${missingDocuments.join(", ")}`,
    );
  }

  const submittedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(applicants)
      .set({
        answers: cleanedAnswers,
        status: "complete",
        submittedAt,
      })
      .where(eq(applicants.id, applicantId));

    await tx.insert(auditLogs).values({
      actorType: "customer",
      action: "applicant.submitted",
      entityType: "applicant",
      entityId: applicantId,
      metadata: { order_number: applicant.orderNumber },
    });
  });

  return { applicantId, status: "complete", submittedAt };
}
