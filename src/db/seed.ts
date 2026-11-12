import { and, eq } from "drizzle-orm";
import { db } from "./index.js";
import { pool } from "./pool.js";
import { countries, formFields, visaProducts, visaRules } from "./schema.js";

// DUMMY test data, verify before launch
interface SeedDestination {
  iso2: string;
  countryName: string;
  slug: string;
  visaProductName: string;
  visaType: string;
  stayDays: number;
  processingDaysMin: number;
  processingDaysMax: number;
  governmentFeeCents: number;
  legworkFeeCents: number;
  passportIso2: string;
  requirement: "visa_free" | "visa_required";
  requiredDocuments: string[];
}

const seedDestinations: SeedDestination[] = [
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
    requiredDocuments: ["applicant_photo", "passport_scan", "return_ticket"],
  },
  {
    iso2: "US",
    countryName: "United States",
    slug: "united-states",
    visaProductName: "USA Visitor Visa (dummy)",
    visaType: "multiple_entry",
    stayDays: 30,
    processingDaysMin: 3,
    processingDaysMax: 5,
    governmentFeeCents: 2000,
    legworkFeeCents: 3500,
    passportIso2: "IN",
    requirement: "visa_required",
    requiredDocuments: ["applicant_photo", "passport_scan", "return_ticket"],
  },
  {
    iso2: "TH",
    countryName: "Thailand",
    slug: "thailand",
    visaProductName: "Thailand e-visa",
    visaType: "single_entry",
    stayDays: 30,
    processingDaysMin: 3,
    processingDaysMax: 5,
    governmentFeeCents: 2000,
    legworkFeeCents: 3500,
    passportIso2: "IN",
    requirement: "visa_required",
    requiredDocuments: ["applicant_photo", "passport_scan", "return_ticket"],
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
    requiredDocuments: ["applicant_photo", "passport_scan", "return_ticket"],
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
    requiredDocuments: ["applicant_photo", "passport_scan", "return_ticket"],
  },
];

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
      requiredDocuments: entry.requiredDocuments,
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

// DUMMY test data, verify before launch
const dummyFullFormFields = [
  {
    groupKey: "personal",
    sortOrder: 10,
    fieldKey: "middle_name",
    label: "Middle name",
    fieldType: "text",
    required: false,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "personal",
    sortOrder: 20,
    fieldKey: "birth_date",
    label: "Date of birth",
    fieldType: "date",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "personal",
    sortOrder: 30,
    fieldKey: "country_of_birth",
    label: "Country of birth",
    fieldType: "country",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "personal",
    sortOrder: 40,
    fieldKey: "place_of_birth",
    label: "Place of birth",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "personal",
    sortOrder: 50,
    fieldKey: "nationality_at_birth",
    label: "Nationality at birth",
    fieldType: "country",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "personal",
    sortOrder: 60,
    fieldKey: "present_nationality",
    label: "Present nationality",
    fieldType: "country",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "personal",
    sortOrder: 70,
    fieldKey: "residence_status",
    label: "Status in country of residence",
    fieldType: "select",
    required: true,
    options: [
      "Citizen",
      "Permanent resident",
      "Temporary resident",
      "Other",
    ],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 110,
    fieldKey: "mobile_phone",
    label: "Mobile number",
    fieldType: "phone",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 120,
    fieldKey: "present_address",
    label: "Present physical address",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 130,
    fieldKey: "present_city",
    label: "Present city",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 140,
    fieldKey: "present_country",
    label: "Present country",
    fieldType: "country",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 150,
    fieldKey: "permanent_address",
    label: "Permanent physical address",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 160,
    fieldKey: "permanent_city",
    label: "Permanent city",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 170,
    fieldKey: "permanent_country",
    label: "Permanent country",
    fieldType: "country",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 180,
    fieldKey: "employment_status",
    label: "Employment status",
    fieldType: "select",
    required: true,
    options: [
      "Employed",
      "Self-employed",
      "Retired",
      "Student",
      "Unemployed",
      "Other",
    ],
    visibleIf: null,
  },
  {
    groupKey: "contact",
    sortOrder: 190,
    fieldKey: "employer",
    label: "Employer",
    fieldType: "text",
    required: false,
    options: [],
    visibleIf: { field: "employment_status", equals: "Employed" },
  },
  {
    groupKey: "contact",
    sortOrder: 200,
    fieldKey: "occupation",
    label: "Occupation",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "passport",
    sortOrder: 210,
    fieldKey: "passport_type",
    label: "Passport type",
    fieldType: "select",
    required: true,
    options: ["Ordinary", "Diplomatic", "Official", "Other"],
    visibleIf: null,
  },
  {
    groupKey: "passport",
    sortOrder: 220,
    fieldKey: "passport_number",
    label: "Passport number",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "passport",
    sortOrder: 230,
    fieldKey: "passport_country_of_issue",
    label: "Country of issue",
    fieldType: "country",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "passport",
    sortOrder: 240,
    fieldKey: "passport_place_of_issue",
    label: "Place of issue",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "passport",
    sortOrder: 250,
    fieldKey: "passport_issue_date",
    label: "Issue date",
    fieldType: "date",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "passport",
    sortOrder: 260,
    fieldKey: "passport_expiry_date",
    label: "Expiry date",
    fieldType: "date",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "spouse",
    sortOrder: 270,
    fieldKey: "spouse_full_name",
    label: "Spouse full name",
    fieldType: "text",
    required: false,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "spouse",
    sortOrder: 280,
    fieldKey: "spouse_nationality",
    label: "Spouse nationality",
    fieldType: "country",
    required: false,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 290,
    fieldKey: "visa_type",
    label: "Type of visa requested",
    fieldType: "select",
    required: true,
    options: ["Single entry", "Multiple entry"],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 300,
    fieldKey: "purpose",
    label: "Purpose of visit",
    fieldType: "select",
    required: true,
    options: [
      "Leisure and holiday",
      "Business",
      "Visiting family or friends",
      "Other",
    ],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 310,
    fieldKey: "port_type",
    label: "Port type",
    fieldType: "select",
    required: true,
    options: ["Airports", "Seaports", "Land border"],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 320,
    fieldKey: "arrival_date",
    label: "Arrival date",
    fieldType: "date",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 330,
    fieldKey: "departure_date",
    label: "Departure date",
    fieldType: "date",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 340,
    fieldKey: "stay_days",
    label: "Stay duration (days)",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 350,
    fieldKey: "host",
    label: "Host",
    fieldType: "select",
    required: true,
    options: ["Self", "Host person", "Hotel booking"],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 360,
    fieldKey: "accommodation_type",
    label: "Accommodation type",
    fieldType: "select",
    required: true,
    options: ["Hotel", "Guest house", "Private residence"],
    visibleIf: null,
  },
  {
    groupKey: "travel",
    sortOrder: 370,
    fieldKey: "accommodation_address",
    label: "Accommodation address",
    fieldType: "text",
    required: true,
    options: [],
    visibleIf: null,
  },
  {
    groupKey: "declaration",
    sortOrder: 380,
    fieldKey: "declaration_accepted",
    label: "I confirm the information above is true",
    fieldType: "checkbox",
    required: true,
    options: [],
    visibleIf: null,
  },
] as const;

async function seedDummyFullForms(): Promise<void> {
  const iso2Codes = ["US", "TH", "MY", "AE"] as const;

  for (const iso2 of iso2Codes) {
    const [product] = await db
      .select({ id: visaProducts.id })
      .from(visaProducts)
      .innerJoin(
        countries,
        eq(visaProducts.destinationCountryId, countries.id),
      )
      .where(
        and(
          eq(countries.iso2, iso2),
          eq(visaProducts.active, true),
        ),
      )
      .limit(1);

    if (!product) {
      throw new Error(
        `Product not found for ${iso2}; run the destination seed first`,
      );
    }

    const inserted = await db
      .insert(formFields)
      .values(
        dummyFullFormFields.map((field) => ({
          visaProductId: product.id,
          formVersion: 1,
          step: "full",
          groupKey: field.groupKey,
          fieldKey: field.fieldKey,
          label: field.label,
          fieldType: field.fieldType,
          required: field.required,
          options: field.options,
          sortOrder: field.sortOrder,
          visibleIf: field.visibleIf,
        })),
      )
      .onConflictDoNothing({
        target: [
          formFields.visaProductId,
          formFields.formVersion,
          formFields.fieldKey,
        ],
      })
      .returning({ id: formFields.id });

    if (inserted.length > 0) {
      console.log(`Inserted ${inserted.length} form fields for ${iso2}`);
    } else {
      console.log(`Form fields already existed for ${iso2}`);
    }
  }
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

  await seedDummyFullForms();
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
