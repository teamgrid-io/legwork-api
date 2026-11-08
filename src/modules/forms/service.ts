import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { formFields, visaProducts } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";

export interface FormFieldDto {
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  options: unknown;
  sortOrder: number;
}

export interface FormGroupDto {
  groupKey: string;
  fields: FormFieldDto[];
}

export interface FormFieldRecord {
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  options: unknown;
  sortOrder: number;
  groupKey: string;
  visibleIf: unknown;
}

type VisibleIfRule =
  | { field: string; equals: unknown }
  | { field: string; in: unknown[] };

interface VisibleFieldInput {
  visaProductId: string;
  answers: Record<string, unknown>;
}

function parseVisibleIf(value: unknown): VisibleIfRule | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("visible_if must be an object");
  }

  const rule = value as Record<string, unknown>;
  const field = rule.field;

  if (typeof field !== "string" || field.length === 0) {
    throw new Error("visible_if.field must be a non-empty string");
  }

  const hasEquals = Object.prototype.hasOwnProperty.call(rule, "equals");
  const hasIn = Object.prototype.hasOwnProperty.call(rule, "in");

  if (hasEquals === hasIn) {
    throw new Error("visible_if must contain exactly one of equals or in");
  }

  if (hasEquals) {
    return { field, equals: rule.equals };
  }

  if (!Array.isArray(rule.in)) {
    throw new Error("visible_if.in must be an array");
  }

  return { field, in: rule.in };
}

export function computeVisibleFieldKeys(
  fields: readonly FormFieldRecord[],
  answers: Record<string, unknown>,
): Set<string> {
  const fieldsByKey = new Map(
    fields.map((field) => [field.fieldKey, field]),
  );
  const visibility = new Map<string, boolean>();
  const visiting = new Set<string>();

  function isVisible(fieldKey: string): boolean {
    const cached = visibility.get(fieldKey);

    if (cached !== undefined) {
      return cached;
    }

    const field = fieldsByKey.get(fieldKey);

    if (!field) {
      throw new Error(`visible_if references unknown field: ${fieldKey}`);
    }

    if (visiting.has(fieldKey)) {
      throw new Error(`Circular visible_if dependency at ${fieldKey}`);
    }

    visiting.add(fieldKey);

    const rule = parseVisibleIf(field.visibleIf);
    let visible = true;

    if (rule) {
      if (!fieldsByKey.has(rule.field)) {
        throw new Error(
          `visible_if references unknown field: ${rule.field}`,
        );
      }

      if (!isVisible(rule.field)) {
        // A hidden field has no answer, so dependants are hidden too.
        visible = false;
      } else {
        const answer = answers[rule.field];

        visible =
          "equals" in rule
            ? answer === rule.equals
            : rule.in.includes(answer);
      }
    }

    visiting.delete(fieldKey);
    visibility.set(fieldKey, visible);

    return visible;
  }

  const visibleKeys = new Set<string>();

  for (const field of fields) {
    if (isVisible(field.fieldKey)) {
      visibleKeys.add(field.fieldKey);
    }
  }

  return visibleKeys;
}

export async function getVisibleFields(
  input: VisibleFieldInput,
): Promise<FormGroupDto[]> {
  const [product] = await db
    .select({ currentFormVersion: visaProducts.currentFormVersion })
    .from(visaProducts)
    .where(eq(visaProducts.id, input.visaProductId))
    .limit(1);

  if (!product) {
    throw new HttpError(404, "Visa product not found");
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
        eq(formFields.visaProductId, input.visaProductId),
        eq(formFields.formVersion, product.currentFormVersion),
        eq(formFields.step, "full"),
      ),
    )
    .orderBy(asc(formFields.sortOrder));

  const visibleKeys = computeVisibleFieldKeys(fields, input.answers);
  const groups = new Map<string, FormFieldDto[]>();

  for (const field of fields) {
    if (!visibleKeys.has(field.fieldKey)) {
      continue;
    }

    const dto: FormFieldDto = {
      fieldKey: field.fieldKey,
      label: field.label,
      fieldType: field.fieldType,
      required: field.required,
      options: field.options,
      sortOrder: field.sortOrder,
    };

    const group = groups.get(field.groupKey);

    if (group) {
      group.push(dto);
    } else {
      groups.set(field.groupKey, [dto]);
    }
  }

  return Array.from(groups, ([groupKey, groupFields]) => ({
    groupKey,
    fields: groupFields,
  }));
}
