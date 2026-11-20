import { and, asc, eq, ne } from "drizzle-orm";
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

/**
 * Answers written into applicants.answers when the order is created from a paid
 * checkout (webhooks/service.ts). They are not form fields, so submit's
 * visibility cleanup must keep them instead of treating them as hidden answers.
 */
const ORDER_CREATED_ANSWER_KEYS: readonly string[] = [
  "gender",
  "marital_status",
];

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
  return db.transaction(async (tx): Promise<SavedAnswersDto> => {
    // Lock the applicant row first: the status check, the read of the existing
    // answers and the write must be serialized against submit and other saves.
    const [locked] = await tx
      .select({ id: applicants.id })
      .from(applicants)
      .where(eq(applicants.id, applicantId))
      .limit(1)
      .for("update");

    if (!locked) {
      throw new HttpError(404, "Applicant not found");
    }

    const [applicant] = await tx
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

    const fields = await tx
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

    return { applicantId, savedFields };
  });
}

export async function submitApplication(
  applicantId: string,
): Promise<SubmittedApplicationDto> {
  return db.transaction(async (tx): Promise<SubmittedApplicationDto> => {
    // Lock first. The status check, the answers/documents validation and the
    // final write are then serialized against saveAnswers and uploadDocument.
    const [locked] = await tx
      .select({ id: applicants.id })
      .from(applicants)
      .where(eq(applicants.id, applicantId))
      .limit(1)
      .for("update");

    if (!locked) {
      throw new HttpError(404, "Applicant not found");
    }

    const [applicant] = await tx
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

    const fields = await tx
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

    // Compute the cleaned answers in memory only. Nothing is written until all
    // answer and document checks have passed.
    const cleanedAnswers: Record<string, unknown> = {};

    for (const [fieldKey, value] of Object.entries(storedAnswers)) {
      if (
        visibleKeys.has(fieldKey) ||
        ORDER_CREATED_ANSWER_KEYS.includes(fieldKey)
      ) {
        cleanedAnswers[fieldKey] = value;
      }
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
        (Array.isArray(value) && value.length === 0) ||
        (field.fieldType === "checkbox" && value !== true)
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
      const availableDocuments = await tx
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

    const [updated] = await tx
      .update(applicants)
      .set({
        answers: cleanedAnswers,
        status: "complete",
        submittedAt,
      })
      .where(
        and(
          eq(applicants.id, applicantId),
          ne(applicants.status, "complete"),
        ),
      )
      .returning({ id: applicants.id });

    if (!updated) {
      throw new HttpError(409, "Application already submitted");
    }

    await tx.insert(auditLogs).values({
      actorType: "customer",
      action: "applicant.submitted",
      entityType: "applicant",
      entityId: applicantId,
      metadata: { order_number: applicant.orderNumber },
    });

    return { applicantId, status: "complete", submittedAt };
  });
}
