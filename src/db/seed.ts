import { and, eq } from "drizzle-orm";
import { db } from "./index.js";
import { pool } from "./pool.js";
import { countries, visaProducts, visaRules } from "./schema.js";

// test data, verify before launch
const seedDestinations = [
  {
    iso2: "GE",
    countryName: "Georgia",
    slug: "georgia",
    visaProductName: "Georgia e-visa: Complete Application",
    visaType: "single_entry",
    stayDays: 90,
    processingDaysMin: 3,
    processingDaysMax: 5,
    governmentFeeCents: 2000,
    legworkFeeCents: 3500,
    passportIso2: "IN",
    requirement: "visa_required",
  },
  {
    iso2: "TZ",
    countryName: "Tanzania",
    slug: "tanzania",
    visaProductName: "Zanzibar Multiple Entry Visa",
    visaType: "multiple_entry",
    stayDays: 90,
    processingDaysMin: 3,
    processingDaysMax: 5,
    governmentFeeCents: 2000,
    legworkFeeCents: 3500,
    passportIso2: "IN",
    requirement: "visa_required",
  },
  {
    iso2: "AE",
    countryName: "United Arab Emirates",
    slug: "united-arab-emirates",
    visaProductName: "United Arab Emirates e-visa",
    visaType: "single_entry",
    stayDays: 30,
    processingDaysMin: 3,
    processingDaysMax: 5,
    governmentFeeCents: 2000,
    legworkFeeCents: 3500,
    passportIso2: "IN",
    requirement: "visa_required",
  },
  {
    iso2: "MY",
    countryName: "Malaysia",
    slug: "malaysia",
    visaProductName: "Malaysia e-visa",
    visaType: "single_entry",
    stayDays: 30,
    processingDaysMin: 3,
    processingDaysMax: 5,
    governmentFeeCents: 2000,
    legworkFeeCents: 3500,
    passportIso2: "IN",
    requirement: "visa_required",
  },
] as const;

const passportCountryDetails: Record<string, { name: string; slug: string }> = {
  IN: { name: "India", slug: "india" },
};

async function upsertCountry(
  iso2: string,
  name: string,
  slug: string,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await db
    .insert(countries)
    .values({ iso2, name, slug })
    .onConflictDoNothing()
    .returning({ id: countries.id });

  const [country] = await db
    .select({ id: countries.id })
    .from(countries)
    .where(eq(countries.iso2, iso2))
    .limit(1);

  if (!country) {
    throw new Error(`Country ${iso2} not found after insert`);
  }

  return { id: country.id, inserted: inserted.length > 0 };
}

async function seedVisaProduct(
  entry: (typeof seedDestinations)[number],
  destinationCountryId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: visaProducts.id })
    .from(visaProducts)
    .where(
      and(
        eq(visaProducts.destinationCountryId, destinationCountryId),
        eq(visaProducts.active, true),
      ),
    )
    .limit(1);

  if (existing) {
    return false;
  }

  const [inserted] = await db
    .insert(visaProducts)
    .values({
      destinationCountryId,
      name: entry.visaProductName,
      visaType: entry.visaType,
      stayDays: entry.stayDays,
      processingDaysMin: entry.processingDaysMin,
      processingDaysMax: entry.processingDaysMax,
      governmentFeeCents: entry.governmentFeeCents,
      legworkFeeCents: entry.legworkFeeCents,
      currency: "USD",
      currentFormVersion: 1,
      active: true,
    })
    .returning({ id: visaProducts.id });

  if (!inserted) {
    throw new Error(`Visa product insert returned no row for ${entry.iso2}`);
  }

  return true;
}

async function seedVisaRule(
  destinationCountryId: string,
  passportCountryId: string,
  requirement: (typeof seedDestinations)[number]["requirement"],
): Promise<boolean> {
  const inserted = await db
    .insert(visaRules)
    .values({
      destinationCountryId,
      passportCountryId,
      requirement,
    })
    .onConflictDoNothing()
    .returning({ id: visaRules.id });

  return inserted.length > 0;
}

async function seed(): Promise<void> {
  for (const entry of seedDestinations) {
    const insertedParts: string[] = [];
    const existingParts: string[] = [];

    const destination = await upsertCountry(
      entry.iso2,
      entry.countryName,
      entry.slug,
    );
    (destination.inserted ? insertedParts : existingParts).push("country");

    const passportDetails = passportCountryDetails[entry.passportIso2];

    if (!passportDetails) {
      throw new Error(
        `No details configured for passport country ${entry.passportIso2}`,
      );
    }

    const passport = await upsertCountry(
      entry.passportIso2,
      passportDetails.name,
      passportDetails.slug,
    );

    if (passport.inserted) {
      insertedParts.push("passport country");
    }

    const productInserted = await seedVisaProduct(entry, destination.id);
    (productInserted ? insertedParts : existingParts).push("visa product");

    const ruleInserted = await seedVisaRule(
      destination.id,
      passport.id,
      entry.requirement,
    );
    (ruleInserted ? insertedParts : existingParts).push("visa rule");

    if (insertedParts.length > 0) {
      const suffix =
        existingParts.length > 0
          ? `; already existed: ${existingParts.join(", ")}`
          : "";

      console.log(
        `Inserted ${entry.iso2} (${entry.countryName}): ${insertedParts.join(", ")}${suffix}`,
      );
    } else {
      console.log(`${entry.iso2} (${entry.countryName}) already existed`);
    }
  }
}

try {
  await seed();
} catch (error) {
  console.error(
    "Seed failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
