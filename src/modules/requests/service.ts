import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  countries,
  pendingCheckouts,
  visaProducts,
} from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";
import type { CreateRequestInput } from "./schema.js";

export interface CreatedPendingCheckoutDto {
  id: string;
  reference: string;
  amountCents: number;
  currency: string;
}

interface PendingTraveller {
  first_name: string;
  surname: string;
  gender: string;
  maritalStatus: string;
}

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CHECKOUT_TTL_MS = 30 * 60 * 1000;

function randomReferenceSuffix(): string {
  let suffix = "";

  for (let index = 0; index < 5; index += 1) {
    suffix += REFERENCE_ALPHABET.charAt(
      randomInt(REFERENCE_ALPHABET.length),
    );
  }

  return suffix;
}

async function generateUniqueReference(): Promise<string> {
  for (;;) {
    const reference = `PC-${randomReferenceSuffix()}`;

    const [existing] = await db
      .select({ id: pendingCheckouts.id })
      .from(pendingCheckouts)
      .where(eq(pendingCheckouts.reference, reference))
      .limit(1);

    if (!existing) {
      return reference;
    }
  }
}

function toTraveller(
  fullName: string,
  gender: string,
  maritalStatus: string,
): PendingTraveller {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] ?? fullName.trim();
  const surname = parts.length > 1 ? parts.slice(1).join(" ") : "";

  return { first_name: firstName, surname, gender, maritalStatus };
}

export async function createRequest(
  input: CreateRequestInput,
): Promise<CreatedPendingCheckoutDto> {
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

  const [product] = await db
    .select({
      id: visaProducts.id,
      governmentFeeCents: visaProducts.governmentFeeCents,
      legworkFeeCents: visaProducts.legworkFeeCents,
      currency: visaProducts.currency,
      currentFormVersion: visaProducts.currentFormVersion,
    })
    .from(visaProducts)
    .where(
      and(
        eq(visaProducts.destinationCountryId, destinationCountry.id),
        eq(visaProducts.active, true),
      ),
    )
    .limit(1);

  if (!product) {
    throw new HttpError(404, "No visa product for this destination");
  }

  const travellerCount = input.applicants.length;
  const perTravellerCents =
    product.governmentFeeCents + product.legworkFeeCents;
  const amountCents = perTravellerCents * travellerCount;

  if (amountCents <= 0) {
    throw new HttpError(400, "Visa product amount must be greater than zero");
  }

  const reference = await generateUniqueReference();
  const contactPhone =
    input.contactPhone && input.contactPhone.trim() !== ""
      ? input.contactPhone.trim()
      : null;
  const travellers = input.applicants.map((applicant) =>
    toTraveller(applicant.fullName, applicant.gender, applicant.maritalStatus),
  );

  const [created] = await db
    .insert(pendingCheckouts)
    .values({
      reference,
      visaProductId: product.id,
      passportCountryId: passportCountry.id,
      travelDate: input.travelDate,
      travellerCount,
      travellers,
      contactEmail: input.contactEmail,
      contactPhone,
      formVersion: product.currentFormVersion,
      governmentFeeCents: product.governmentFeeCents,
      legworkFeeCents: product.legworkFeeCents,
      amountCents,
      currency: product.currency,
      status: "open",
      expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
    })
    .returning({
      id: pendingCheckouts.id,
      reference: pendingCheckouts.reference,
      amountCents: pendingCheckouts.amountCents,
      currency: pendingCheckouts.currency,
    });

  if (!created) {
    throw new Error("Pending checkout insert returned no row");
  }

  return created;
}
