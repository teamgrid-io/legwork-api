import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  auditLogs,
  documents,
  orders,
  visaProducts,
} from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import { enqueueDocumentScan } from "../../lib/queue.js";
import { storage } from "../../lib/storage.js";
import { checkFile } from "./validate.js";

const DOCUMENT_TYPES = [
  "applicant_photo",
  "passport_scan",
  "return_ticket",
] as const;

type DocumentType = (typeof DOCUMENT_TYPES)[number];

interface UploadDocumentInput {
  applicantId: string;
  documentType: string;
  buffer: Buffer;
  declaredMime: string;
}

interface UploadedDocumentDto {
  documentId: string;
  documentType: string;
  status: "pending_scan";
}

function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export async function uploadDocument(
  input: UploadDocumentInput,
): Promise<UploadedDocumentDto> {
  const [applicant] = await db
    .select({
      status: applicants.status,
      orderStatus: orders.status,
      requiredDocuments: visaProducts.requiredDocuments,
    })
    .from(applicants)
    .innerJoin(orders, eq(applicants.orderId, orders.id))
    .innerJoin(visaProducts, eq(orders.visaProductId, visaProducts.id))
    .where(eq(applicants.id, input.applicantId))
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

  if (!isDocumentType(input.documentType)) {
    throw new HttpError(400, "Unknown document type");
  }

  const requiredDocuments = Array.isArray(applicant.requiredDocuments)
    ? applicant.requiredDocuments.filter(
        (value): value is string => typeof value === "string",
      )
    : [];

  if (!requiredDocuments.includes(input.documentType)) {
    throw new HttpError(400, "Document not required for this destination");
  }

  const existingDocuments = await db
    .select({
      id: documents.id,
      status: documents.status,
    })
    .from(documents)
    .where(
      and(
        eq(documents.applicantId, input.applicantId),
        eq(documents.documentType, input.documentType),
      ),
    );

  if (existingDocuments.some((document) => document.status === "verified")) {
    throw new HttpError(409, "A verified document of this type already exists");
  }

  const { mimeType, sha256 } = checkFile(
    input.buffer,
    input.declaredMime,
    input.buffer.length,
  );
  const storageKey = `${randomUUID()}.bin`;

  await storage.put(storageKey, input.buffer);

  let documentId: string;

  try {
    documentId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(documents)
        .values({
          applicantId: input.applicantId,
          documentType: input.documentType,
          storageKey,
          sha256,
          mimeType,
          sizeBytes: input.buffer.length,
          status: "pending_scan",
          uploadedAt: new Date(),
        })
        .returning({ id: documents.id });

      if (!created) {
        throw new Error("Failed to insert document");
      }

      await tx.insert(auditLogs).values({
        actorType: "customer",
        action: "document.uploaded",
        entityType: "document",
        entityId: created.id,
        metadata: {
          applicant_id: input.applicantId,
          document_type: input.documentType,
        },
      });

      return created.id;
    });
  } catch (error) {
    await storage.delete(storageKey).catch(() => {
      // The row was not committed, so the file is an orphan either way.
    });

    throw error;
  }

  try {
    await enqueueDocumentScan(documentId);
  } catch {
    // The row is already committed as "pending_scan"; nothing is deleted.
    throw new HttpError(503, "Scan service unavailable, try again");
  }

  return {
    documentId,
    documentType: input.documentType,
    status: "pending_scan",
  };
}
