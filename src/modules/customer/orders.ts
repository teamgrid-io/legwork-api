import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  documents,
  formFields,
  orders,
  visaProducts,
} from "../../db/schema.js";
import { decryptField } from "../../lib/crypto.js";
import { HttpError } from "../../lib/errors.js";
import {
  computeVisibleFieldKeys,
  isAnswerMissing,
} from "../forms/service.js";

export interface OrderSummaryDto {
  orderNumber: string;
  status: string;
  travelDate: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
  applicantCount: number;
}

export interface ApplicantProgressDto {
  answers: { answered: number; total: number };
  documents: { uploaded: number; required: number };
}

export interface OrderApplicantDto {
  id: string;
  sortOrder: number;
  firstName: string;
  surname: string;
  status: string;
  submittedAt: Date | null;
  answers: Record<string, unknown>;
  progress: ApplicantProgressDto;
}

export interface OrderDetailDto {
  orderNumber: string;
  status: string;
  travelDate: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
  applicants: OrderApplicantDto[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A passport number must never leave the API in full. Stored values may be
 * encrypted, so decrypt defensively first, then reveal only the last 3
 * characters. Very short values are masked completely so the full value cannot
 * appear as a substring.
 */
function maskPassportNumber(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  let plain = value;

  if (value.startsWith("v1:")) {
    try {
      plain = decryptField(value);
    } catch {
      // Undecryptable ciphertext is still a secret; mask what is stored.
      plain = value;
    }
  }

  if (plain.length <= 3) {
    return "*".repeat(plain.length);
  }

  return `***${plain.slice(-3)}`;
}

function maskAnswers(
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...answers };

  if (Object.prototype.hasOwnProperty.call(masked, "passport_number")) {
    masked.passport_number = maskPassportNumber(masked.passport_number);
  }

  return masked;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The authenticated customer's orders, newest first. customer_id is part of the
 * WHERE clause, so one customer can never page into another's list.
 */
export async function listCustomerOrders(
  customerId: string,
  pagination: { limit: number; offset: number },
): Promise<OrderSummaryDto[]> {
  const applicantCount = sql<number>`(
    select count(*) from ${applicants}
    where ${applicants.orderId} = ${orders.id}
  )`.mapWith(Number);

  return db
    .select({
      orderNumber: orders.orderNumber,
      status: orders.status,
      travelDate: orders.travelDate,
      amountCents: orders.amountCents,
      currency: orders.currency,
      createdAt: orders.createdAt,
      applicantCount,
    })
    .from(orders)
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.createdAt), desc(orders.orderNumber))
    .limit(pagination.limit)
    .offset(pagination.offset);
}

/**
 * One order and its applicants. The customer id is part of the lookup, so an
 * order belonging to somebody else is indistinguishable from a missing one: a
 * 404, never a 403.
 */
export async function getCustomerOrder(
  customerId: string,
  orderNumber: string,
): Promise<OrderDetailDto> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      travelDate: orders.travelDate,
      amountCents: orders.amountCents,
      currency: orders.currency,
      createdAt: orders.createdAt,
      visaProductId: orders.visaProductId,
      formVersion: orders.formVersion,
    })
    .from(orders)
    .where(
      and(eq(orders.customerId, customerId), eq(orders.orderNumber, orderNumber)),
    )
    .limit(1);

  if (!order) {
    throw new HttpError(404, "Order not found");
  }

  const applicantRows = await db
    .select({
      id: applicants.id,
      sortOrder: applicants.sortOrder,
      firstName: applicants.firstName,
      surname: applicants.surname,
      status: applicants.status,
      submittedAt: applicants.submittedAt,
      answers: applicants.answers,
    })
    .from(applicants)
    .where(eq(applicants.orderId, order.id))
    .orderBy(asc(applicants.sortOrder));

  const [product] = await db
    .select({ requiredDocuments: visaProducts.requiredDocuments })
    .from(visaProducts)
    .where(eq(visaProducts.id, order.visaProductId))
    .limit(1);

  const requiredDocuments = stringArray(product?.requiredDocuments);

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
        eq(formFields.visaProductId, order.visaProductId),
        eq(formFields.formVersion, order.formVersion),
        eq(formFields.step, "full"),
      ),
    )
    .orderBy(asc(formFields.sortOrder));

  const applicantIds = applicantRows.map((row) => row.id);

  const documentRows =
    applicantIds.length > 0
      ? await db
          .select({
            applicantId: documents.applicantId,
            documentType: documents.documentType,
          })
          .from(documents)
          .where(inArray(documents.applicantId, applicantIds))
      : [];

  const documentTypesByApplicant = new Map<string, Set<string>>();

  for (const document of documentRows) {
    const types = documentTypesByApplicant.get(document.applicantId) ?? new Set();

    types.add(document.documentType);
    documentTypesByApplicant.set(document.applicantId, types);
  }

  const applicantsDto = applicantRows.map((row): OrderApplicantDto => {
    const storedAnswers = isRecord(row.answers) ? row.answers : {};
    const visibleKeys = computeVisibleFieldKeys(fields, storedAnswers);
    const requiredFields = fields.filter(
      (field) => field.required && visibleKeys.has(field.fieldKey),
    );
    const answered = requiredFields.filter(
      (field) => !isAnswerMissing(field.fieldType, storedAnswers[field.fieldKey]),
    ).length;
    const uploadedTypes = documentTypesByApplicant.get(row.id) ?? new Set();
    const uploaded = requiredDocuments.filter((type) =>
      uploadedTypes.has(type),
    ).length;

    return {
      id: row.id,
      sortOrder: row.sortOrder,
      firstName: row.firstName,
      surname: row.surname,
      status: row.status,
      submittedAt: row.submittedAt,
      answers: maskAnswers(storedAnswers),
      progress: {
        answers: { answered, total: requiredFields.length },
        documents: { uploaded, required: requiredDocuments.length },
      },
    };
  });

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    travelDate: order.travelDate,
    amountCents: order.amountCents,
    currency: order.currency,
    createdAt: order.createdAt,
    applicants: applicantsDto,
  };
}
