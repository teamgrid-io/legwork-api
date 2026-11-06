import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applicants,
  countries,
  requestEvents,
  requests,
  visaProducts,
  visaRules,
} from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import type { CreateRequestInput } from "./schema.js";

export interface CreatedRequestDto {
  id: string;
  reference: string;
  amountCents: number;
  currency: string;
}

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomReferenceSuffix(): string {
  let suffix = "";

  for (let index = 0; index < 5; index += 1) {
    suffix += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }

  return suffix;
}

async function generateUniqueReference(): Promise<string> {
  for (;;) {
    const reference = `LW-${randomReferenceSuffix()}`;

    const [existing] = await db
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.reference, reference))
      .limit(1);

    if (!existing) {
      return reference;
    }
  }
}

export async function createRequest(
  input: CreateRequestInput,
): Promise<CreatedRequestDto> {
  const destinationCode = input.destinationIso2.toUpperCase();
  const passportCode = input.passportIso2.toUpperCase();

  const countryRows = await db
    .select({ id: countries.id, iso2: countries.iso2 })
    .from(countries)
    .where(inArray(countries.iso2, [destinationCode, passportCode]));

  const destinationCountry = countryRows.find(
    (country) => country.iso2 === destinationCode,
  );
  const passportCountry = countryRows.find(
    (country) => country.iso2 === passportCode,
  );

  if (!destinationCountry || !passportCountry) {
    throw new HttpError(404, "Country not found");
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  if (input.travelDate <= todayUtc) {
    throw new HttpError(400, "travelDate must be in the future");
  }

  const [rule] = await db
    .select({ requirement: visaRules.requirement })
    .from(visaRules)
    .where(
      and(
        eq(visaRules.destinationCountryId, destinationCountry.id),
        eq(visaRules.passportCountryId, passportCountry.id),
      ),
    )
    .limit(1);

  if (!rule || rule.requirement !== "visa_required") {
    throw new HttpError(
      400,
      "This route cannot be requested online; contact us",
    );
  }

  const [product] = await db
    .select({
      id: visaProducts.id,
      governmentFeeCents: visaProducts.governmentFeeCents,
      legworkFeeCents: visaProducts.legworkFeeCents,
      currency: visaProducts.currency,
    })
    .from(visaProducts)
    .where(
      and(
        eq(visaProducts.destinationCountryId, destinationCountry.id),
        eq(visaProducts.route, "complete"),
        eq(visaProducts.active, true),
      ),
    )
    .limit(1);

  if (!product) {
    throw new HttpError(404, "No visa product for this destination");
  }

  const perPersonCents =
    product.governmentFeeCents + product.legworkFeeCents;
  const amountCents = perPersonCents * input.applicants.length;
  const reference = await generateUniqueReference();

  const contactPhone =
    input.contactPhone && input.contactPhone.trim() !== ""
      ? input.contactPhone.trim()
      : null;

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(requests)
      .values({
        reference,
        visaProductId: product.id,
        destinationCountryId: destinationCountry.id,
        passportCountryId: passportCountry.id,
        governmentFeeCents: product.governmentFeeCents,
        legworkFeeCents: product.legworkFeeCents,
        currency: product.currency,
        amountCents,
        travelDate: input.travelDate,
        contactEmail: input.contactEmail,
        contactPhone,
      })
      .returning({
        id: requests.id,
        reference: requests.reference,
        amountCents: requests.amountCents,
        currency: requests.currency,
      });

    if (!created) {
      throw new Error("Request insert returned no row");
    }

    for (const [index, applicant] of input.applicants.entries()) {
      let nationalityCountryId: string | null = null;

      if (applicant.nationalityIso2) {
        const [nationality] = await tx
          .select({ id: countries.id })
          .from(countries)
          .where(eq(countries.iso2, applicant.nationalityIso2))
          .limit(1);

        if (!nationality) {
          throw new HttpError(400, "Unknown nationality");
        }

        nationalityCountryId = nationality.id;
      }

      await tx.insert(applicants).values({
        requestId: created.id,
        fullName: applicant.fullName,
        dateOfBirth: applicant.dateOfBirth ?? null,
        nationalityCountryId,
        sortOrder: index + 1,
      });
    }

    await tx.insert(requestEvents).values({
      requestId: created.id,
      fromStatus: null,
      toStatus: "requested",
      actorType: "traveller",
    });

    return {
      id: created.id,
      reference: created.reference,
      amountCents: created.amountCents,
      currency: created.currency,
    };
  });
}
